'use strict';
/* withlook memory store — Postgres (with JSON-file fallback) */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS withlook;
CREATE TABLE IF NOT EXISTS withlook.projects (
  id SERIAL PRIMARY KEY,
  folder TEXT UNIQUE NOT NULL,
  name TEXT,
  pm TEXT,
  last_port INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_opened_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS withlook.sessions (
  id TEXT PRIMARY KEY,
  project_id INT REFERENCES withlook.projects(id) ON DELETE SET NULL,
  title TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS withlook.messages (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES withlook.sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS withlook_messages_session_idx ON withlook.messages (session_id);
`;

class MemoryStore {
  constructor(userDataPath) {
    this.mode = 'file';
    this.pg = null;
    this.file = path.join(userDataPath, 'memory.json');
    this.data = { projects: [], sessions: [], messages: [] };
    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    this._saveFile = () => fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  async init(url) {
    if (!url) { this.mode = 'file'; return { mode: this.mode }; }
    try {
      if (this.pg) { try { await this.pg.end(); } catch {} this.pg = null; }
      const { Client } = require('pg');
      const c = new Client({ connectionString: url, connectionTimeoutMillis: 4000 });
      await c.connect();
      await c.query(SCHEMA_SQL);
      this.pg = c;
      this.mode = 'postgres';
      return { mode: this.mode };
    } catch (e) {
      this.mode = 'file';
      try { if (this.pg) await this.pg.end(); } catch {}
      this.pg = null;
      return { mode: this.mode, error: e.message };
    }
  }
  status() { return { mode: this.mode }; }

  // serialize queries on the single pg client (concurrent client.query calls are deprecated)
  q(sql, params) {
    this._chain = (this._chain || Promise.resolve())
      .catch(() => {})
      .then(() => this.pg.query(sql, params));
    return this._chain.then((r) => r.rows);
  }

  // ---- projects ----
  async upsertProject({ folder, name, pm, port }) {
    if (this.mode === 'postgres') {
      await this.q(
        `INSERT INTO withlook.projects (folder, name, pm, last_port, last_opened_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (folder) DO UPDATE SET last_opened_at = now(), pm = $3, last_port = $4, name = $2
         RETURNING id`, [folder, name, pm, port]);
      return this.projectByFolder(folder);
    }
    let p = this.data.projects.find((x) => x.folder === folder);
    if (!p) { p = { id: (this.data.projects.at(-1)?.id || 0) + 1, folder, created_at: Date.now() }; this.data.projects.push(p); }
    Object.assign(p, { name, pm, last_port: port, last_opened_at: Date.now() });
    this._saveFile();
    return p;
  }
  async projectByFolder(folder) {
    if (this.mode === 'postgres') return (await this.q('SELECT * FROM withlook.projects WHERE folder = $1', [folder]))[0] || null;
    return this.data.projects.find((x) => x.folder === folder) || null;
  }
  async listProjects() {
    if (this.mode === 'postgres') return this.q('SELECT * FROM withlook.projects ORDER BY last_opened_at DESC LIMIT 20');
    return [...this.data.projects].sort((a, b) => b.last_opened_at - a.last_opened_at).slice(0, 20);
  }
  async removeProject(folder) {
    if (this.mode === 'postgres') {
      const p = (await this.q('SELECT id FROM withlook.projects WHERE folder = $1', [folder]))[0];
      if (!p) return false;
      await this.q('DELETE FROM withlook.sessions WHERE project_id = $1', [p.id]); // messages cascade
      await this.q('DELETE FROM withlook.projects WHERE id = $1', [p.id]);
      return true;
    }
    const p = this.data.projects.find((x) => x.folder === folder);
    if (!p) return false;
    const sessionIds = new Set(this.data.sessions.filter((s) => s.project_id === p.id).map((s) => s.id));
    this.data.sessions = this.data.sessions.filter((s) => s.project_id !== p.id);
    this.data.messages = this.data.messages.filter((m) => !sessionIds.has(m.session_id));
    this.data.projects = this.data.projects.filter((x) => x.id !== p.id);
    this._saveFile();
    return true;
  }

  // ---- sessions ----
  async createSession(folder, title) {
    const id = crypto.randomUUID();
    const project = folder ? await this.projectByFolder(folder) : null;
    if (this.mode === 'postgres') {
      await this.q('INSERT INTO withlook.sessions (id, project_id, title) VALUES ($1,$2,$3)', [id, project ? project.id : null, title || null]);
    } else {
      this.data.sessions.push({ id, project_id: project ? project.id : null, title: title || null, created_at: Date.now(), updated_at: Date.now() });
      this._saveFile();
    }
    return { id };
  }
  async latestSession(folder) {
    const project = folder ? await this.projectByFolder(folder) : null;
    if (!project) return null;
    let session;
    if (this.mode === 'postgres') {
      session = (await this.q('SELECT * FROM withlook.sessions WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1', [project.id]))[0];
    } else {
      session = [...this.data.sessions].filter((s) => s.project_id === project.id).sort((a, b) => b.updated_at - a.updated_at)[0];
    }
    if (!session) return null;
    return { session, messages: await this.sessionMessages(session.id) };
  }
  async listSessions(folder) {
    if (this.mode === 'postgres') {
      return this.q(`SELECT s.id, s.title, s.updated_at, p.name AS project, p.folder,
                     (SELECT count(*) FROM withlook.messages m WHERE m.session_id = s.id) AS messages
                     FROM withlook.sessions s LEFT JOIN withlook.projects p ON p.id = s.project_id
                     WHERE ($1::text IS NULL OR p.folder = $1)
                     ORDER BY s.updated_at DESC LIMIT 25`, [folder || null]);
    }
    return [...this.data.sessions]
      .map((s) => {
        const proj = this.data.projects.find((p) => p.id === s.project_id) || {};
        return {
          id: s.id, title: s.title, updated_at: s.updated_at,
          project: proj.name || null, folder: proj.folder || null,
          messages: this.data.messages.filter((m) => m.session_id === s.id).length,
        };
      })
      .filter((s) => !folder || s.folder === folder)
      .sort((a, b) => b.updated_at - a.updated_at).slice(0, 25);
  }
  async sessionMessages(id) {
    if (this.mode === 'postgres') return this.q('SELECT role, content, created_at FROM withlook.messages WHERE session_id = $1 ORDER BY id', [id]);
    return this.data.messages.filter((m) => m.session_id === id).map((m) => ({ role: m.role, content: m.content, created_at: m.created_at }));
  }
  async loadSession(id) {
    let session;
    if (this.mode === 'postgres') session = (await this.q('SELECT * FROM withlook.sessions WHERE id = $1', [id]))[0];
    else session = this.data.sessions.find((s) => s.id === id) || null;
    if (!session) return null;
    return { session, messages: await this.sessionMessages(id) };
  }
  async appendMessage({ sessionId, role, content, title }) {
    if (this.mode === 'postgres') {
      await this.q('INSERT INTO withlook.messages (session_id, role, content) VALUES ($1,$2,$3)', [sessionId, role, content]);
      await this.q('UPDATE withlook.sessions SET updated_at = now(), title = COALESCE(title, $2) WHERE id = $1', [sessionId, title || null]);
    } else {
      this.data.messages.push({ session_id: sessionId, role, content, created_at: Date.now() });
      const s = this.data.sessions.find((x) => x.id === sessionId);
      if (s) { s.updated_at = Date.now(); s.title = s.title || title || null; }
      this._saveFile();
    }
    return true;
  }
}

module.exports = { MemoryStore };

'use strict';
/* MCP tools → model tools, plus streaming tool-call accumulation */
const { resultText, resultImage } = require('./mcp');

const MAX_TOOLS = 40;

function safeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// servers: [{ id, name, tools: [{ name, description, inputSchema }] }]
function exposeTools(servers) {
  const tools = [];
  const map = new Map();
  for (const s of (Array.isArray(servers) ? servers : [])) {
    for (const t of (s && Array.isArray(s.tools) ? s.tools : [])) {
      if (!t || !t.name) continue;
      const exposed = safeName(`${s.id}__${t.name}`);
      if (!exposed || map.has(exposed)) continue;
      map.set(exposed, { serverId: s.id, tool: t.name });
      tools.push({
        type: 'function',
        function: {
          name: exposed,
          description: `[${s.name || s.id}] ${String(t.description || '').slice(0, 500)}`,
          parameters: (t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type)
            ? t.inputSchema
            : { type: 'object', properties: {} },
        },
      });
      if (tools.length >= MAX_TOOLS) return { tools, map };
    }
  }
  return { tools, map };
}

// OpenAI-style deltas (and Cloudflare's flat {name, arguments}) → Map(index → {id,name,args})
function accumulateToolCalls(calls, deltas) {
  for (const d of (Array.isArray(deltas) ? deltas : [])) {
    if (!d) continue;
    const i = Number.isInteger(d.index) ? d.index : calls.size;
    const cur = calls.get(i) || { id: '', name: '', args: '' };
    if (d.id) cur.id = d.id;
    const fn = d.function || {};
    const name = fn.name || d.name;
    if (name) cur.name = String(name);
    const args = (fn.arguments !== undefined) ? fn.arguments : d.arguments;
    if (args !== undefined && args !== null) {
      cur.args += (typeof args === 'string' ? args : JSON.stringify(args));
    }
    calls.set(i, cur);
  }
  return calls;
}

function finalizeToolCalls(calls) {
  return [...calls.values()]
    .filter((c) => c && c.name)
    .map((c) => ({
      id: c.id || ('call_' + Math.random().toString(36).slice(2, 10)),
      name: c.name,
      args: c.args || '{}',
    }));
}

module.exports = {
  exposeTools, accumulateToolCalls, finalizeToolCalls,
  resultText, resultImage, safeName, MAX_TOOLS,
};

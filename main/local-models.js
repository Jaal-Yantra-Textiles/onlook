'use strict';
/* local OpenAI-compatible servers — model discovery (Ollama, LM Studio, llama.cpp, vLLM) */
async function listModels(baseUrl, opts = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(base)) {
    return { ok: false, error: 'Enter an http(s) base URL, e.g. http://localhost:11434/v1' };
  }
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(opts.timeout || 5000) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} from ${base}/models` };
    const j = await r.json().catch(() => null);
    // OpenAI/Ollama: {data:[{id}]} · some servers: {models:[{name}]} · a bare array
    const list = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    const models = list
      .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name || m.model)))
      .filter(Boolean);
    return { ok: true, base, models };
  } catch (e) {
    return { ok: false, error: (e.cause && e.cause.code) || e.message || 'request failed' };
  }
}

module.exports = { listModels };

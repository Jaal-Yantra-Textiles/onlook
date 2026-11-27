'use strict';
/* withlook Figma import — Figma Dev Mode MCP tools over the MCP client */
const { resultText, resultImage } = require('./mcp');

const MAX_CODE = 20000;
const MAX_VARS = 6000;

function parseFigmaUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'Paste a Figma frame URL.' };
  if (/^\d+[:-]\d+$/.test(raw)) return { ok: true, nodeId: raw.replace('-', ':') };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'That is not a URL.' }; }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) return { ok: false, error: 'That is not a figma.com URL.' };
  const node = u.searchParams.get('node-id');
  if (!node) return { ok: false, error: 'The URL has no node-id — select a frame in Figma and copy its link.' };
  if (!/^\d+[:-]\d+$/.test(node)) return { ok: false, error: 'That node-id does not look right.' };
  const fileKey = (u.pathname.match(/\/(?:design|file|proto)\/([^/]+)/) || [])[1] || '';
  return { ok: true, nodeId: node.replace('-', ':'), fileKey, url: raw };
}

async function importFigma(client, input) {
  const parsed = parseFigmaUrl(input);
  if (!parsed.ok) return parsed;
  const tools = (client.tools && client.tools.length) ? client.tools : await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  if (!names.size) return { ok: false, error: 'The MCP server exposes no tools.' };

  const nodeId = parsed.nodeId;
  const used = [];
  let code = '';
  let variables = '';
  let image = null;

  const codeTool = names.has('get_code') ? 'get_code'
    : names.has('get_design_context') ? 'get_design_context' : null;
  if (codeTool) {
    try {
      const args = { nodeId, clientFrameworks: 'react', clientLanguages: 'typescript' };
      if (parsed.fileKey) args.fileKey = parsed.fileKey;
      const r = await client.callTool(codeTool, args);
      code = resultText(r).slice(0, MAX_CODE);
      used.push(codeTool);
    } catch (e) { used.push(codeTool + ' (failed: ' + e.message + ')'); }
  }
  if (names.has('get_variable_defs')) {
    try {
      const r = await client.callTool('get_variable_defs', { nodeId });
      variables = resultText(r).slice(0, MAX_VARS);
      used.push('get_variable_defs');
    } catch (e) { used.push('get_variable_defs (failed: ' + e.message + ')'); }
  }
  if (names.has('get_screenshot')) {
    try {
      const r = await client.callTool('get_screenshot', { nodeId, enableBase64Response: true });
      image = resultImage(r);
      used.push('get_screenshot');
    } catch (e) { used.push('get_screenshot (failed: ' + e.message + ')'); }
  }

  if (!code && !variables && !image) {
    return { ok: false, error: 'Figma returned nothing — is the frame selected in the desktop app?', tools: used };
  }
  return { ok: true, ...parsed, code, variables, image, tools: used };
}

module.exports = { parseFigmaUrl, importFigma };

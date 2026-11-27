'use strict';
/* Generic tool-calling loop — provider-agnostic and testable */
/**
 * request(messages, tools) → { text, calls: [{ id, name, args }] }
 * callTool(exposedName, argsJson) → { text, image? }
 * send(kind, delta) → void
 */
async function runToolLoop({ messages, tools = [], request, callTool, send = () => {}, onImage, maxSteps = 6 }) {
  const conversation = messages;
  const enabled = tools.length > 0;
  let rounds = 0;

  while (rounds < maxSteps) {
    const out = await request(conversation, enabled ? tools : []);
    if (!out) return conversation;
    const calls = Array.isArray(out.calls) ? out.calls : [];
    if (!enabled || !calls.length) return conversation;

    rounds++;
    conversation.push({
      role: 'assistant',
      content: out.text || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    });

    for (const c of calls) {
      send('tool', `${c.name} ${String(c.args || '').slice(0, 160)}`);
      let result;
      try {
        result = await callTool(c.name, c.args);
      } catch (e) {
        result = { text: 'Tool error: ' + (e && e.message ? e.message : String(e)) };
      }
      if (result && result.image && onImage) {
        try { onImage(result.image, c); } catch {}
      }
      conversation.push({
        role: 'tool',
        tool_call_id: c.id,
        content: String((result && result.text) || '[no result]').slice(0, 12000),
      });
    }

    if (rounds >= maxSteps) {
      send('tool', `stopped after ${maxSteps} tool rounds`);
      break;
    }
  }
  return conversation;
}

module.exports = { runToolLoop };

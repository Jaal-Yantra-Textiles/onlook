'use strict';
/* withlook system prompt — shared by the direct LLM and the opencode agent */
const fs = require('node:fs');

const BASE_SYSTEM_PROMPT = [
  'You are withlook, an AI assistant embedded in a live preview of the user\'s local Next.js app.',
  'The user is looking at the rendered page. Elements they pick arrive with their selector, HTML, computed styles, and — when available — a source excerpt.',
  '',
  'Guidelines:',
  '- Answer the question directly in the first sentence. Do not restate it or announce what you are about to do.',
  '- Never narrate a process the user cannot see the result of: no "Let me look…", "Let me check…", "I\'ll inspect…", "Now the styles for…", or step-by-step plans. Do the work silently and report the outcome.',
  '- Treat the attached selection as ground truth. If a source excerpt is attached, cite that file and line. If it is not, reason from the HTML and computed styles, and say which element or file would confirm it.',
  '- When something looks off, name the concrete cause (specific style, class, or markup) and give the exact CSS/JSX change. Prefer a minimal fix over a rewrite.',
  '- If the context is genuinely insufficient, ask one short, specific question (for example, "pick the footer element") instead of guessing.',
  '- Be concise: short paragraphs or a few bullets; include code only where it helps.',
].join('\n');

const NO_TOOLS_NOTE = '\n- You have no tools in this mode: you cannot browse the repo, run commands, or open a browser. Everything you can know is in the context below and the user\'s message — do not promise to go look something up.';
const HAS_TOOLS_NOTE = '\n- You can read and edit files in the project with your tools. Use them when needed, but keep progress notes to a minimum; the final answer should state what you found and what changed.';

function buildSystemPrompt(settings, ctx, agentMode) {
  let s = BASE_SYSTEM_PROMPT + (agentMode === 'opencode' ? HAS_TOOLS_NOTE : NO_TOOLS_NOTE);
  const extra = (settings.systemPrompt || '').trim();
  if (extra) s += '\n\nAdditional instructions from the user:\n' + extra;
  if (ctx && ctx.url) s += `\n\nCurrent page URL: ${ctx.url}`;
  if (ctx && Array.isArray(ctx.selections) && ctx.selections.length) {
    s += '\n\nThe user selected these elements on the page with the element picker:';
    ctx.selections.forEach((sel, i) => {
      s += `\n\n--- Selected element ${i + 1} ---` +
        `\nCSS selector: ${sel.selector}` +
        `\nTag: <${sel.tag}>${sel.id ? ' id="' + sel.id + '"' : ''}${sel.classes ? ' class="' + sel.classes + '"' : ''}` +
        `\nVisible text: ${JSON.stringify(String(sel.text || '').slice(0, 600))}` +
        `\nHTML: ${String(sel.html || '').slice(0, 4000)}` +
        `\nComputed styles: ${sel.styles || ''}`;
      if (Array.isArray(sel.sources) && sel.sources.length) {
        s += `\nLikely source file(s): ${sel.sources.slice(0, 3).map((x) => `${x.file}:${x.line}`).join(', ')}`;
        const top = sel.sources[0];
        try {
          const content = fs.readFileSync(top.file, 'utf8');
          const lines = content.split('\n');
          const from = Math.max(0, top.line - 22);
          const to = Math.min(lines.length, top.line + 42);
          const excerpt = lines.slice(from, to).join('\n').slice(0, 3200);
          s += `\nExcerpt of ${top.file} (lines ${from + 1}-${to}):\n\`\`\`\n${excerpt}\n\`\`\``;
        } catch {}
      }
    });
  }
  if (ctx && ctx.referenceCount) {
    s += `\n\nThe user attached ${ctx.referenceCount} reference image${ctx.referenceCount === 1 ? '' : 's'}. ` +
      `Use ${ctx.referenceCount === 1 ? 'it' : 'them'} as visual guidance for layout, spacing, color, and type — do not copy unrelated content.`;
  }
  if (ctx && ctx.figma) {
    const f = ctx.figma;
    s += '\n\n## Figma frame imported by the user';
    if (f.url) s += `\nURL: ${f.url}`;
    if (f.nodeId) s += `\nNode: ${f.nodeId}`;
    s += '\nTreat this frame as the design source of truth for layout, spacing, type, and color.';
    if (f.variables) s += `\n\nFigma variables:\n${String(f.variables).slice(0, 4000)}`;
    if (f.code) s += `\n\nCode exported from Figma:\n\`\`\`\n${String(f.code).slice(0, 16000)}\n\`\`\``;
  }
  if (ctx && ctx.writeMode) {
    s += '\n\nWRITE MODE IS ON. When you change code, output each complete modified file as a fenced code block whose info line is the language followed by ` path=<relative-path>`, e.g. ```tsx path=src/app/page.tsx — include the FULL file content so it can be saved directly. The user applies your files with one click.';
  }
  return s;
}

module.exports = { buildSystemPrompt, BASE_SYSTEM_PROMPT, NO_TOOLS_NOTE, HAS_TOOLS_NOTE };

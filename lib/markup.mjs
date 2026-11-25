// Notes and Plan sections are plain text, with one exception: a fenced ```mermaid block is
// a diagram. That is the whole of "images on cards" that is worth having — an agent can
// draw the thing it is describing, in text it can also edit later, with no file store, no
// bucket lifecycle and no second access model. A screenshot would need all three.
//
// Pure, and line-based rather than one clever regex, so tests/auth-test.mjs can pin the
// awkward cases: an unclosed fence, a fence with nothing in it, text either side.

export function splitBlocks(text) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  let prose = [];
  let diagram = null;

  const flushProse = () => {
    const v = prose.join('\n');
    prose = [];
    if (v.trim()) out.push({ kind: 'text', value: v });
  };
  const flushDiagram = () => {
    const v = diagram.join('\n');
    diagram = null;
    if (v.trim()) out.push({ kind: 'diagram', value: v });
  };

  for (const line of lines) {
    if (diagram === null) {
      if (/^\s*```\s*mermaid\s*$/i.test(line)) { flushProse(); diagram = []; continue; }
      prose.push(line);
      continue;
    }
    if (/^\s*```\s*$/.test(line)) { flushDiagram(); continue; }
    diagram.push(line);
  }
  // An unclosed fence is still a diagram. Refusing to draw it because somebody forgot the
  // closing ticks would be the least useful available answer.
  if (diagram !== null) flushDiagram();
  flushProse();
  return out;
}

export const hasDiagram = (text) => splitBlocks(text).some((b) => b.kind === 'diagram');

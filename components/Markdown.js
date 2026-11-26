'use client';
import { useEffect, useState } from 'react';
import { splitBlocks } from '../lib/markup.mjs';
import Diagram from './Diagram';

// Document bodies are Markdown. They are also written by agents, and by people quoting
// things agents found, so the text is untrusted and rendering it is the whole risk.
//
// Two libraries rather than one hand-rolled pass: marked turns Markdown into HTML, and
// DOMPurify removes anything in that HTML which could run. Writing the second one myself
// would be inventing a sanitiser, which is the classic way to ship an XSS hole that looks
// fine in every test anybody thinks to write. Both load on first use, so a board nobody
// opens a document on never downloads them.
let pending = null;
function tools() {
  if (!pending) {
    pending = Promise.all([import('marked'), import('dompurify')]).then(([m, d]) => {
      const marked = m.marked || m.default;
      const purify = d.default || d;
      marked.setOptions({ gfm: true, breaks: true });
      return { marked, purify };
    });
  }
  return pending;
}

export default function Markdown({ text }) {
  const [html, setHtml] = useState(null);
  const blocks = splitBlocks(text);

  useEffect(() => {
    let alive = true;
    const prose = blocks.filter((b) => b.kind === 'text').map((b) => b.value);
    if (!prose.length) { setHtml([]); return; }
    tools()
      .then(({ marked, purify }) => {
        if (!alive) return;
        setHtml(prose.map((p) => purify.sanitize(marked.parse(p), {
          // Links leave the artifact, so they must not be able to run anything; dropping
          // every scheme but these is cheaper than reasoning about the rest.
          ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
          FORBID_TAGS: ['style', 'form', 'input', 'button'],
        })));
      })
      // Falling back to the raw text is the safe failure: it shows the document rather than
      // an empty box, and nothing has been through a half-finished sanitiser.
      .catch(() => { if (alive) setHtml(null); });
    return () => { alive = false; };
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  let i = 0;
  return (
    <div className="md">
      {blocks.map((b, j) => {
        if (b.kind === 'diagram') return <Diagram key={j} source={b.value} />;
        const rendered = html && html[i++];
        return rendered
          ? <div key={j} dangerouslySetInnerHTML={{ __html: rendered }} />
          : <pre key={j} className="code wrap">{b.value}</pre>;
      })}
    </div>
  );
}

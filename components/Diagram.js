'use client';
import { useEffect, useRef, useState } from 'react';

// Mermaid is ~3 MB, so it is imported on first use rather than bundled into the page: a
// board with no diagram on it never downloads it. The promise is cached at module scope so
// several diagrams on one page share a single load and a single initialize().
let pending = null;
function mermaid() {
  if (!pending) {
    pending = import('mermaid').then(({ default: m }) => {
      m.initialize({
        startOnLoad: false,
        // Diagram source is board content: written by people, by agents, and sometimes
        // pasted from somewhere else. `strict` is what makes rendering it safe — it runs
        // the output through DOMPurify and drops click handlers and raw HTML labels. It is
        // not a default to relax for nicer labels.
        securityLevel: 'strict',
        theme: 'neutral',
        fontFamily: 'inherit',
        flowchart: { useMaxWidth: true, htmlLabels: false },
      });
      return m;
    });
  }
  return pending;
}

let seq = 0;

// A diagram that will not parse shows its error and its source, never an empty box: the
// person looking at it is usually the one who can fix the arrow that is wrong.
export default function Diagram({ source, className = '' }) {
  const [svg, setSvg] = useState('');
  const [err, setErr] = useState('');
  const id = useRef('mmd-' + (++seq));

  useEffect(() => {
    const src = String(source || '').trim();
    if (!src) { setSvg(''); setErr(''); return; }
    let alive = true;
    mermaid()
      .then((m) => m.render(id.current, src))
      .then((r) => { if (alive) { setSvg(r.svg); setErr(''); } })
      .catch((e) => { if (alive) { setSvg(''); setErr(String(e?.message || e)); } });
    return () => { alive = false; };
  }, [source]);

  if (err) {
    return (
      <div className={'diagram bad ' + className}>
        <p className="hint">This diagram did not parse: {err}</p>
        <pre className="code">{source}</pre>
      </div>
    );
  }
  if (!svg) return <div className={'diagram ' + className}><p className="hint">Drawing…</p></div>;
  return <div className={'diagram ' + className} dangerouslySetInnerHTML={{ __html: svg }} />;
}

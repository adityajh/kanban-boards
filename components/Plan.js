'use client';
import { useEffect, useState, useCallback } from 'react';
import { timeAgo } from './util';
import Diagram from './Diagram';
import Markdown from './Markdown';
import { splitBlocks } from '../lib/markup.mjs';

// The Plan is the board's second surface: what is true, rather than what is being done.
// Everything here comes from two places — the rows in tracker_items, and the board's own
// plan config, which declares the goal, the metrics and the static sections. The page
// knows nothing about funnels or releases; it renders whatever a board declares.
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'plan', label: 'Plan' },
  { id: 'status', label: 'Status' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'log', label: 'Log' },
  { id: 'agents', label: 'For agents' },
];
const LANES = [['now', 'Now'], ['waiting', 'Waiting'], ['found', 'Found'], ['done', 'Done']];
const LOG_KINDS = ['update', 'handoff', 'risk', 'decision'];

const num = (v) => (typeof v === 'number' && isFinite(v) ? v.toLocaleString('en-IN') : '—');
const day = (s) => {
  if (!s) return '';
  const d = new Date(String(s).slice(0, 10));
  return isNaN(d) ? String(s) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
// Section links and snapshot links come from the plan config, which only a master admin
// may write — but a scheme check costs nothing and means no config can ever put a
// javascript: URL behind a link on this page.
const safeHref = (h) => (/^https?:\/\//i.test(String(h || '')) ? String(h) : null);

const Pill = ({ v }) => v ? <span className={'pill p-' + String(v).replace(/[^a-z-]/gi, '')}>{String(v).replace('-', ' ')}</span> : null;

export default function Plan({ slug }) {
  const [data, setData] = useState(null);
  const [docs, setDocs] = useState([]);
  const [tab, setTab] = useState('overview');
  const [err, setErr] = useState('');

  const api = useCallback(async (path, method = 'GET', body) => {
    const r = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Tenant': slug },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
    return r.json();
  }, [slug]);

  const load = useCallback(async () => {
    try { setData(await api('/tracker')); setErr(''); }
    catch (e) { setErr(e.message); }
    // The document list is a convenience on this page, not part of it: a board with no
    // documents, or a caller not allowed to list them, still gets the whole Plan.
    try { setDocs(await api('/docs')); } catch { setDocs([]); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  if (err) return <div className="gate"><h1>No plan here</h1><p>{err}</p>
    <p><a className="btn" href={'/' + slug}>Back to the board</a></p></div>;
  if (!data) return <div className="gate"><p>Loading…</p></div>;

  const { plan, items } = data;
  const metrics = plan.metrics || [];
  const periods = plan.periods || [];
  const actuals = [...items.actual].sort((a, b) => String(b.id).localeCompare(String(a.id)));
  const latest = actuals[0] || null;
  const max = metrics.reduce((m, s) => Math.max(m, Number(s.target) || 0), 0) || 1;

  return (
    <>
      <div className="topbar">
        <div className="brand">{plan.title || 'Plan'}<small>{plan.subtitle || 'Plan and tracker'}</small></div>
        <div className="spacer" />
        <a className="linkbtn" href={'/' + slug}>board</a>
        <a className="linkbtn" href={'/' + slug + '/settings'}>settings</a>
      </div>

      <div className="plantabs">
        {TABS.map(t => (
          <button key={t.id} className={'tab' + (tab === t.id ? ' on' : '')}
            onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="planwrap">
        {tab === 'overview' && (
          <>
            {plan.goal && (
              <div className="goal">
                <div className="big">{num(plan.goal.number)}</div>
                <div>
                  <p><strong>{plan.goal.unit}</strong>{plan.goal.by ? ` by ${day(plan.goal.by)}` : ''}</p>
                  {plan.goal.note && <p className="hint">{plan.goal.note}</p>}
                </div>
              </div>
            )}

            {metrics.length > 0 && (
              <section>
                <h3>Target and latest actual</h3>
                <p className="hint">
                  {latest
                    ? `Actuals as of ${day(latest.as_of)}, from ${latest.source || 'an unnamed source'}. One linear scale.`
                    : 'No snapshot recorded yet. Grey bars are the target, on one linear scale.'}
                </p>
                <div className="funnel">
                  {metrics.map(m => {
                    const a = latest && latest.values ? latest.values[m.key] : null;
                    const t = Number(m.target) || 0;
                    return (
                      <div className="frow" key={m.key}>
                        <div className="flbl">{m.label || m.key}{m.sub && <small>{m.sub}</small>}</div>
                        <div className="track" role="img"
                          aria-label={`${m.label || m.key}: target ${t}${a != null ? `, actual ${a}` : ''}`}>
                          <i className="t" style={{ width: Math.max(0.6, t / max * 100) + '%' }} />
                          {a != null && <i className="a" style={{ width: Math.min(100, Math.max(0.6, a / max * 100)) + '%' }} />}
                        </div>
                        <div className="fnum">{a != null ? num(a) + ' / ' : ''}{num(t)}</div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <div className="plan2">
              <Lane title="Now" hint="In progress. The tasks behind these are cards on the board."
                items={items.status.filter(s => s.lane === 'now')} slug={slug} />
              <Lane title="Waiting on" hint="Blocked on a decision, a person or another agent."
                items={items.status.filter(s => s.lane === 'waiting')} slug={slug} />
            </div>

            <section>
              <h3>Next milestones</h3>
              <Milestones items={items.milestone.filter(m => m.state !== 'done').slice(0, 5)} />
            </section>
          </>
        )}

        {tab === 'plan' && <Sections sections={plan.sections} periods={periods}
          metrics={metrics} docs={docs} api={api} />}

        {tab === 'status' && (
          <>
            <section>
              <h3>Tracker</h3>
              <p className="hint">Each row names its owner, its source and the date it was true.</p>
              <div className="lanes">
                {LANES.map(([id, label]) => (
                  <Lane key={id} title={label} items={items.status.filter(s => s.lane === id)} slug={slug} />
                ))}
              </div>
            </section>
            {periods.length > 0 && metrics.length > 0 && (
              <section>
                <h3>Scorecard</h3>
                <p className="hint">Target and actual. Each actual names its source and the date it was true.</p>
                <Scorecard periods={periods} metrics={metrics} actuals={actuals} />
              </section>
            )}
            <section>
              <h3>Milestones</h3>
              <Milestones items={[...items.milestone].sort((a, b) => String(a.date).localeCompare(String(b.date)))} />
            </section>
          </>
        )}

        {tab === 'decisions' && (
          <>
            <section>
              <h3>Decisions</h3>
              <p className="hint">An agent may propose. Only a master admin settles one.</p>
              <Decisions items={[...items.decision].sort((a, b) => String(a.id).localeCompare(String(b.id)))} slug={slug} />
            </section>
            <section>
              <h3>Risks</h3>
              <Risks items={items.risk} />
            </section>
          </>
        )}

        {tab === 'log' && <Log items={items.log} api={api} onPosted={load} />}

        {tab === 'agents' && <ForAgents slug={slug} metrics={metrics} />}
      </div>
    </>
  );
}

function Lane({ title, hint, items, slug }) {
  return (
    <section className="lane-sec">
      <div className="lane-h"><strong>{title}</strong><span className="pill">{items.length}</span></div>
      {hint && <p className="hint">{hint}</p>}
      <div className="lane">
        {items.length === 0 && <div className="empty">Nothing here.</div>}
        {[...items].sort((a, b) => (a.order || 99) - (b.order || 99)).map(s => (
          <div key={s.id} className={'pcard ' + (s.lane || '')}>
            <div className="ct">{s.title}</div>
            {s.detail && <div className="cd">{s.detail}</div>}
            <div className="cm">
              {s.owner && <span>{s.owner}</span>}
              {s.as_of && <span>{day(s.as_of)}</span>}
              {s.source && (/^https:\/\//.test(s.source)
                ? <a href={s.source} target="_blank" rel="noreferrer">source</a>
                : <span>{s.source}</span>)}
              {s.card_id && <a href={`/${slug}?card=${s.card_id}`}>card</a>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Milestones({ items }) {
  if (!items.length) return <p className="empty">No milestones yet.</p>;
  return (
    <div className="ms">
      {items.map(m => (
        <div className="ms-row" key={m.id}>
          <div className="ms-date">{day(m.date)}</div>
          <div>
            <div>{m.title}</div>
            {(m.owner || m.note) && <div className="hint">{[m.owner, m.note].filter(Boolean).join(' · ')}</div>}
          </div>
          <Pill v={m.state || 'upcoming'} />
        </div>
      ))}
    </div>
  );
}

function Scorecard({ periods, metrics, actuals }) {
  const byId = Object.fromEntries(actuals.map(a => [a.id, a]));
  return (
    <div className="ascroll">
      <table className="atable">
        <thead><tr>
          <th>By end of</th>
          {metrics.map(m => <th key={m.key} className="n">{m.label || m.key}</th>)}
          <th>Source</th>
        </tr></thead>
        <tbody>
          {periods.map(p => {
            const a = byId[p.id];
            return (
              <tr key={p.id}>
                <td>{p.label || p.id}</td>
                {metrics.map(m => {
                  const av = a && a.values ? a.values[m.key] : null;
                  const tv = (p.targets || {})[m.key];
                  return (
                    <td key={m.key} className="n">
                      {av != null ? <><b className="act">{num(av)}</b>{' / '}</> : '– / '}
                      {num(tv)}
                    </td>
                  );
                })}
                <td>{a ? <>{a.source || '—'}{a.as_of && <span className="sub">as of {day(a.as_of)}</span>}</> : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Decisions({ items, slug }) {
  if (!items.length) return <p className="empty">No decisions recorded yet.</p>;
  return (
    <div className="ascroll">
      <table className="atable">
        <thead><tr><th>ID</th><th>Decision</th><th>State</th><th>Owner</th><th>Date</th><th>Note</th></tr></thead>
        <tbody>
          {items.map(d => (
            <tr key={d.id}>
              <td><code>{d.id}</code></td>
              <td>{d.title}</td>
              <td><Pill v={d.state || 'proposed'} /></td>
              <td>{d.owner || '—'}</td>
              <td>{day(d.date)}</td>
              <td>
                {d.note}
                {d.ref && <> <a href={d.ref} target="_blank" rel="noreferrer">ref</a></>}
                {d.card_id && <> <a href={`/${slug}?card=${d.card_id}`}>card</a></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Risks({ items }) {
  if (!items.length) return <p className="empty">No risks recorded yet.</p>;
  const rank = { high: 0, medium: 1, low: 2 };
  const sorted = [...items].sort((a, b) =>
    (a.state === 'closed') - (b.state === 'closed') || (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
  return (
    <div className="ascroll">
      <table className="atable">
        <thead><tr><th>Risk</th><th>Level</th><th>Mitigation</th><th>Owner</th><th>State</th></tr></thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.id}>
              <td>{r.title}{r.why && <span className="sub">{r.why}</span>}</td>
              <td><Pill v={r.level || 'medium'} /></td>
              <td>{r.mitigation || '—'}</td>
              <td>{r.owner || '—'}</td>
              <td><Pill v={r.state || 'open'} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Log({ items, api, onPosted }) {
  const [kind, setKind] = useState('update');
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const post = async (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setMsg('');
    try {
      await api('/tracker/log', 'POST', { kind, text: text.trim() });
      setText(''); setMsg('Posted.'); onPosted();
    } catch (err) { setMsg(err.message); }
    finally { setBusy(false); }
  };

  const sorted = [...items].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return (
    <>
      <section>
        <h3>Post an update</h3>
        <p className="hint">
          For status changes, handoffs and things others should know. Tasks still go on the
          board. It is signed with your name automatically.
        </p>
        <form className="aform" onSubmit={post}>
          <label>Kind
            <select value={kind} onChange={e => setKind(e.target.value)}>
              {LOG_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>Update
            <textarea value={text} maxLength={1200} rows={3}
              placeholder="What changed, and where the detail lives."
              onChange={e => setText(e.target.value)} />
          </label>
          <button className="btn" disabled={busy}>{busy ? 'Posting…' : 'Post update'}</button>
        </form>
        {msg && <p className="hint">{msg}</p>}
      </section>
      <section>
        <h3>Log <span>{sorted.length}</span></h3>
        {sorted.length === 0 && <p className="empty">No updates yet.</p>}
        <div className="log">
          {sorted.map(l => (
            <div className="log-row" key={l.id}>
              <div className="when">
                <div>{l.at ? timeAgo(l.at) : ''}</div>
                <div>{l.by}</div>
              </div>
              <div>
                <Pill v={l.kind || 'update'} />
                <div className="txt">{l.text}</div>
                {l.ref && <a href={l.ref} target="_blank" rel="noreferrer">ref</a>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// Static content, declared per board. A counsellor funnel carries phases and ground rules;
// another board carries whatever it carries. The page does not know the difference.
function Sections({ sections, periods, metrics, docs = [], api }) {
  return (
    <>
      {periods.length > 0 && metrics.length > 0 && (
        <section>
          <h3>Targets</h3>
          <p className="hint">Cumulative. Actuals are on the Status tab.</p>
          <div className="ascroll">
            <table className="atable">
              <thead><tr><th>By end of</th>{metrics.map(m => <th key={m.key} className="n">{m.label || m.key}</th>)}</tr></thead>
              <tbody>
                {periods.map(p => (
                  <tr key={p.id}>
                    <td>{p.label || p.id}</td>
                    {metrics.map(m => <td key={m.key} className="n">{num((p.targets || {})[m.key])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {(sections || []).map((s, i) => (
        <section key={i}>
          <h3>{s.title}</h3>
          {s.note && <p className="hint">{s.note}</p>}
          {s.text && <p>{s.text}</p>}
          {Array.isArray(s.bullets) && (
            <ul className="plain">{s.bullets.map((b, j) => <li key={j}>{b}</li>)}</ul>
          )}
          {/* A section may carry its diagram inline, or name a board document that holds it.
              The document form is the useful one: plan config is master-admin-only, but any
              agent with a write token can PUT a document — so the picture can be corrected
              by whoever notices it is wrong, without opening the board's constitution. */}
          {s.diagram && <Diagram source={s.diagram} />}
          {s.diagramDoc && <DocDiagram api={api} docKey={s.diagramDoc} />}
          {Array.isArray(s.links) && s.links.length > 0 && (
            <ul className="plain links">
              {s.links.map((l, j) => {
                const href = safeHref(l.href);
                return (
                  <li key={j}>
                    {href
                      ? <a href={href} target="_blank" rel="noreferrer noopener">{l.label || href}</a>
                      : <span>{l.label || '—'}</span>}
                    {l.note && <span className="hint"> · {l.note}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {Array.isArray(s.rows) && s.rows.length > 0 && (
            <div className="ascroll">
              <table className="atable">
                <thead><tr>{(s.columns || Object.keys(s.rows[0])).map(c => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>
                  {s.rows.map((r, j) => (
                    <tr key={j}>{(s.columns || Object.keys(s.rows[0])).map(c => <td key={c}>{r[c]}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
      {docs.length > 0 && <Documents docs={docs} api={api} />}
    </>
  );
}

// A diagram kept in a board document rather than in the plan config.
function DocDiagram({ api, docKey }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api('/docs/' + docKey)
      .then(d => { if (alive) setSrc(d.body || ''); })
      .catch(e => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [api, docKey]);
  if (err) return <p className="hint">No document <code>{docKey}</code> to draw from ({err}).</p>;
  if (src == null) return <p className="hint">Loading the diagram…</p>;
  // The document may be nothing but mermaid source, or prose with the source fenced inside it.
  const fenced = splitBlocks(src).find(b => b.kind === 'diagram');
  return <Diagram source={fenced ? fenced.value : src} />;
}

// The board's reference text, readable here rather than only through the API — that was the
// whole complaint. Bodies are fetched on demand: the list endpoint deliberately omits them,
// and a board can hold a lot of them.
function Documents({ docs, api }) {
  const [open, setOpen] = useState(null);
  const [body, setBody] = useState({});
  const show = async (key) => {
    if (open === key) { setOpen(null); return; }
    setOpen(key);
    if (body[key] === undefined) {
      try { const d = await api('/docs/' + key); setBody(b => ({ ...b, [key]: d.body || '' })); }
      catch (e) { setBody(b => ({ ...b, [key]: 'Could not load this document: ' + e.message })); }
    }
  };
  return (
    <section>
      <h3>Documents</h3>
      <p className="hint">
        Reference this board keeps — roles, briefs, writing rules, and links out to anything
        held elsewhere. Agents read and write these at <code>/api/docs/&lt;key&gt;</code>; a
        document is what somebody re-reads, where a card is work that finishes. Bodies are
        Markdown, and a fenced <code>mermaid</code> block is drawn.
      </p>
      <ul className="plain docs">
        {docs.map(d => (
          <li key={d.key}>
            {/* A document is text kept here or a pointer to something kept elsewhere. A
                pointer has nothing to expand, so it is a link and not a button — the two
                should not look alike when one navigates away and the other does not. */}
            {d.url
              ? <a href={safeHref(d.url) || undefined} target="_blank" rel="noreferrer noopener">
                  {d.title || d.key}
                </a>
              : <button className="linkish" onClick={() => show(d.key)} aria-expanded={open === d.key}>
                  {d.title || d.key}
                </button>}
            <code>{d.url ? 'link' : d.key}</code>
            {d.updatedBy && <span className="hint"> · {d.updatedBy}</span>}
            {d.updatedAt && <span className="hint"> · {timeAgo(d.updatedAt)}</span>}
            {open === d.key && (
              body[d.key] === undefined
                ? <p className="hint">Loading…</p>
                : <Markdown text={body[d.key]} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ForAgents({ slug, metrics }) {
  const keys = metrics.map(m => m.key).join(', ') || '…';
  return (
    <section>
      <h3>How agents read and write this page</h3>
      <p className="hint">
        Same base and auth as the board: <code>Authorization: Bearer &lt;your agent token&gt;</code>.
        The token names the board, so no slug appears in any path.
      </p>
      <pre className="code">{`GET    /api/tracker                  everything, grouped by kind, plus this board's plan
GET    /api/tracker/:kind            one kind; log takes ?limit= and ?before=
GET    /api/tracker/:kind/:id         one row
PUT    /api/tracker/:kind/:id         create or replace; send "version" to be safe
PATCH  /api/tracker/:kind/:id         merge fields; send "version" to be safe
DELETE /api/tracker/:kind/:id
POST   /api/tracker/log               append one entry; no version needed

kinds    status · decision · milestone · risk · actual · log
metrics  ${keys}

A stale "version" gets 409 with the current row — re-read and redo.
An agent may propose a decision; only a master admin marks one decided.
Contact details in any field get 422. They belong in the CRM, never here.
Every write appears in GET /events, and wakes any agent watching for it.`}</pre>
      <p className="hint">
        This page holds statuses and pointers. Tasks are cards on <a href={'/' + slug}>the board</a>;
        contacts and counts live in their own systems. Where this disagrees with a source,
        the source wins.
      </p>
    </section>
  );
}

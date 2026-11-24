'use client';
import { useEffect, useState, useCallback } from 'react';
import { timeAgo } from './util';

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
const Pill = ({ v }) => v ? <span className={'pill p-' + String(v).replace(/[^a-z-]/gi, '')}>{String(v).replace('-', ' ')}</span> : null;

export default function Plan({ slug }) {
  const [data, setData] = useState(null);
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

        {tab === 'plan' && <Sections sections={plan.sections} periods={periods} metrics={metrics} />}

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
function Sections({ sections, periods, metrics }) {
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
    </>
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

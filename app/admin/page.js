'use client';
import { useEffect, useState, useCallback } from 'react';
import { timeAgo, store } from '../../components/util';

const EMPTY_FORM = { slug: '', name: '', names: 'Adi', tags: '', accent: '#D67D2E', noPassphrase: false };

export default function Admin() {
  const [key, setKey] = useState(null);
  const [pass, setPass] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [created, setCreated] = useState(null);
  const [tab, setTab] = useState('people');
  const [people, setPeople] = useState(null);
  const [agents, setAgents] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => { setKey(store.get('admin_key')); document.title = 'Boards · Admin'; }, []);

  const api = useCallback(async (path, method = 'GET', body) => {
    const r = await fetch('/api/admin' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { store.del('admin_key'); setKey(null); throw new Error('Wrong admin key'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Error');
    return j;
  }, [key]);

  // The three reads are independent, so they go together; the panel is only as useful as its
  // slowest one, and a failure in any of them should say so rather than draw a half screen.
  const load = useCallback(() => Promise.all([api('/overview'), api('/people'), api('/agents')])
    .then(([d, p, a]) => { store.set('admin_key', key); setData(d); setPeople(p); setAgents(a); setErr(''); })
    .catch(e => setErr(e.message)), [api, key]);
  useEffect(() => { if (key) load(); }, [key, load]);

  // Sets one person's role on one board: '' removes, 'member' and 'admin' add or update. The
  // grid is redrawn from the server's answer rather than patched locally, so a refusal (the
  // last admin of a board, say) leaves the screen showing what is actually true.
  const setRole = async (person, board, role) => {
    setBusy(person.id + ':' + board.slug);
    try {
      await api('/memberships', role === '' ? 'DELETE' : 'POST',
        { slug: board.slug, personId: person.id, ...(role === '' ? {} : { isAdmin: role === 'admin' }) });
      setErr('');
    } catch (e) { setErr(e.message); }
    await load();
    setBusy('');
  };

  const create = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/tenants', 'POST', {
        slug: form.slug, name: form.name,
        config: { names: form.names, tags: form.tags, accent: form.accent },
        // Only send the key when the box is ticked: an absent passphrase still mints one, so
        // an untouched form behaves exactly as it always did.
        ...(form.noPassphrase ? { passphrase: null } : {}),
      });
      setCreated(r); setForm(EMPTY_FORM); setErr(''); load();
    } catch (e) { setErr(e.message); }
  };
  const field = (k) => ({ value: form[k], onChange: e => setForm(f => ({ ...f, [k]: e.target.value })) });

  if (!key) {
    return (
      <div className="gate">
        <h1>Boards</h1>
        <div className="sub">Admin</div>
        {err && <div className="err">{err}</div>}
        <input type="password" value={pass} placeholder="Admin key" onChange={e => setPass(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && pass) setKey(pass); }} />
        <button className="btn" style={{ width: '100%' }} onClick={() => pass && setKey(pass)}>Enter</button>
      </div>
    );
  }

  const cardList = (rows, empty) => rows.length === 0 ? <div className="empty">{empty}</div> : (
    <ul className="alist">
      {rows.map(c => (
        <li key={c.id}>
          <a href={`/${c.slug}?card=${c.id}`}>{c.title}</a>
          <span>{c.board} · {c.assignee} · updated {timeAgo(c.updated_at)}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <div className="topbar">
        <div className="brand">Boards<small>Admin overview</small></div>
        <div className="spacer" />
        <button className="linkbtn" onClick={() => { store.del('admin_key'); setKey(null); setData(null); }}>sign out</button>
      </div>
      <div className="admin">
        {err && <div className="err">{err}</div>}
        {!data || !people || !agents ? <p className="empty">Loading…</p> : <>
          <div className="tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={'tab' + (tab === id ? ' on' : '')}
                onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          {tab === 'people' && <PeopleGrid people={people} busy={busy} setRole={setRole} />}
          {tab === 'agents' && <AgentGrid agents={agents} people={people} />}
          {tab === 'boards' && <BoardsTab data={data} people={people} agents={agents} />}
          {tab === 'attention' && <Attention people={people} agents={agents} goto={setTab} />}

          {tab === 'boards' && <>
          <section>
            <h3>Waiting for your review <span>{data.review.length}</span></h3>
            {cardList(data.review, 'Nothing in Review.')}
          </section>

          <section>
            <h3>Stuck <span>{(data.stuck || []).length}</span></h3>
            <p className="hint">Someone has said this cannot move. Longest stuck first.</p>
            {cardList(data.stuck || [], 'Nothing stuck.')}
          </section>

          <section>
            <h3>Stalled <span>{data.stalled.length}</span></h3>
            <p className="hint">In progress and untouched for {data.staleDays}+ days.</p>
            {cardList(data.stalled, 'Nothing stalled.')}
          </section>

          <section>
            <h3>Recent notes</h3>
            {data.notes.length === 0 ? <div className="empty">No notes yet.</div> : (
              <ul className="alist">
                {data.notes.map(n => (
                  <li key={n.id}>
                    <b>{n.author}</b>
                    <a href={`/${n.slug}?card=${n.card_id}`}>{n.card}</a>
                    <span>{n.board} · {timeAgo(n.created_at)}</span>
                    <div className="body">{n.body}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>New board</h3>
            <form className="aform" onSubmit={create}>
              <label>Client name<input required placeholder="JBJ Jeweller" {...field('name')} /></label>
              <label>URL slug<input required placeholder="jbj" pattern="[a-z0-9][a-z0-9\-]{1,39}" {...field('slug')} /></label>
              <label>People (comma-separated)<input required {...field('names')} /></label>
              <label>Tags (optional)<input placeholder="A, B" {...field('tags')} /></label>
              <label>Accent<input type="color" {...field('accent')} /></label>
              <label className="check">
                <input type="checkbox" checked={form.noPassphrase}
                  onChange={e => setForm(f => ({ ...f, noPassphrase: e.target.checked }))} />
                No passphrase
                <span className="sub">A passphrase is one shared secret that names nobody. Without one, people sign in and agents use their own tokens.</span>
              </label>
              <button className="btn" type="submit">Create board</button>
            </form>
            {created && (
              <div className="created">
                Created <a href={'/' + created.tenant.slug}>/{created.tenant.slug}</a>.
                {created.passphrase ? 'Both secrets below are shown once — copy them now.'
                  : 'Anything shown below is shown once — copy it now.'}
                {created.passphrase ? (
                  <div>Passphrase (for agents): <code>{created.passphrase}</code></div>
                ) : (
                  <div>No passphrase: this board is reached by signing in, or with an agent token.</div>
                )}
                {created.admin && (created.admin.password ? (
                  <div>
                    Admin sign-in for <b>{created.admin.displayName}</b>:{' '}
                    <code>{created.admin.username}</code> / <code>{created.admin.password}</code>
                    {' '}— they will be asked to change it on first sign-in.
                  </div>
                ) : (
                  <div>
                    Admin is <b>{created.admin.displayName}</b> (<code>{created.admin.username}</code>),
                    who already had an account — they sign in with the password they already use.
                  </div>
                ))}
              </div>
            )}
          </section>
          </>}
        </>}
      </div>
    </>
  );
}

const TABS = [['people', 'People × boards'], ['agents', 'Agents × boards'], ['boards', 'Boards'], ['attention', 'Attention']];
// A wake is healthy only on a 2xx. 'timeout' and 'error' are what the sender records when no
// response came at all, and they are exactly as broken as a 500, so anything that is not a
// 2xx counts. null means no wake has been delivered yet, which is not a failure.
const wakeBad = (a) => !!a.webhookUrl && !!a.lastDeliveryStatus && !/^2\d\d$/.test(a.lastDeliveryStatus);

function PeopleGrid({ people, busy, setRole }) {
  const { people: list, boards, counts } = people;
  return (
    <section>
      <h3>People <span>{counts.total}</span></h3>
      <p className="hint">Pick a role to change a membership. Removing someone from a board never deletes their account, and a board's last admin cannot be removed or demoted.</p>
      {list.length === 0 ? <div className="empty">No people yet.</div> : (
        <div className="ascroll">
          <table className="atable grid">
            <thead><tr><th>Person</th>{boards.map(b => <th key={b.slug}><a href={'/' + b.slug + '/settings'}>{b.name}</a></th>)}</tr></thead>
            <tbody>
              {list.map(p => (
                <tr key={p.id}>
                  <td>
                    <b>{p.displayName}</b>
                    {p.isMaster && <span className="badge">master</span>}
                    {p.neverSignedIn && <span className="badge warn">never signed in</span>}
                    <span className="sub">{p.username}{p.boards.length === 0 ? ' · on no board' : ''}</span>
                  </td>
                  {boards.map(b => {
                    const m = p.boards.find(x => x.slug === b.slug);
                    const role = m ? (m.isAdmin ? 'admin' : 'member') : '';
                    return (
                      <td key={b.slug} className={'cell ' + (role || 'none')}>
                        <select value={role} disabled={busy === p.id + ':' + b.slug}
                          aria-label={p.displayName + ' on ' + b.name}
                          onChange={e => setRole(p, b, e.target.value)}>
                          <option value="">—</option>
                          <option value="member">member</option>
                          <option value="admin">admin</option>
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AgentGrid({ agents, people }) {
  const boards = people.boards;
  // Agents belong to exactly one board, so a row is a name and the grid shows where that name
  // is in use. Grouping by name makes an agent that serves several boards read as one line.
  const rows = new Map();
  for (const a of agents.agents) {
    const k = a.name.toLowerCase();
    if (!rows.has(k)) rows.set(k, { name: a.name, at: {} });
    rows.get(k).at[a.board.slug] = a;
  }
  return (
    <section>
      <h3>Agents <span>{agents.counts.total}</span></h3>
      <p className="hint">Read-only. Tokens, scope and wakes are changed in each board's Settings. Stale means not seen for {agents.staleDays}+ days.</p>
      {rows.size === 0 ? <div className="empty">No agents yet.</div> : (
        <div className="ascroll">
          <table className="atable grid">
            <thead><tr><th>Agent</th>{boards.map(b => <th key={b.slug}>{b.name}</th>)}</tr></thead>
            <tbody>
              {[...rows.values()].map(r => (
                <tr key={r.name}>
                  <td><b>{r.name}</b></td>
                  {boards.map(b => {
                    const a = r.at[b.slug];
                    if (!a) return <td key={b.slug} className="cell none">—</td>;
                    return (
                      <td key={b.slug} className="cell agent">
                        <a href={'/' + b.slug + '/settings'}>{a.scope}</a>
                        {a.disabled && <span className="badge warn">disabled</span>}
                        <span className="sub">{a.mayFinish ? 'may finish' : 'cannot finish'}</span>
                        <span className={'sub' + (wakeBad(a) ? ' hot' : '')}>
                          {a.webhookUrl ? 'wake ' + (a.lastDeliveryStatus || 'not yet sent') : 'no wake'}
                        </span>
                        <span className={'sub' + (a.stale ? ' hot' : '')}>
                          {a.lastSeenAt ? 'seen ' + timeAgo(a.lastSeenAt) : 'never seen'}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BoardsTab({ data, people, agents }) {
  const flags = Object.fromEntries(people.boards.map(b => [b.slug, b]));
  const count = (rows, slug, pick) => rows.filter(r => pick(r) === slug).length;
  return (
    <section>
      <h3>Boards <span>{data.boards.length}</span></h3>
      <p className="hint">Your admin key also opens any board.</p>
      <div className="ascroll">
        <table className="atable">
          <thead><tr><th>Board</th><th>People</th><th>Agents</th><th>Cards</th><th>Passphrase</th><th>Approval gate</th><th>Last activity</th></tr></thead>
          <tbody>
            {data.boards.map(b => {
              const f = flags[b.slug] || {};
              const cards = b.todo + b.in_progress + b.stuck + b.review + b.done;
              return (
                <tr key={b.slug}>
                  <td><a href={'/' + b.slug}>{b.name}</a><span className="slug">/{b.slug}</span></td>
                  <td>{count(people.people.flatMap(p => p.boards.map(x => x.slug)), b.slug, x => x)}</td>
                  <td>{count(agents.agents, b.slug, a => a.board.slug)}</td>
                  <td>{cards}</td>
                  <td className={f.hasPassphrase ? 'hot' : ''}>{f.hasPassphrase ? 'still set' : 'none'}</td>
                  <td>{f.reviewGate ? 'on' : 'off'}</td>
                  <td>{b.last_activity ? timeAgo(b.last_activity) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Things that are true and that nobody is looking at: none of these raises an error anywhere
// an admin would see it, which is why they are collected here. Each row says where it is
// fixed, because a list of problems with no way to act on them gets read once and ignored.
function Attention({ people, agents, goto }) {
  const rows = [];
  for (const a of agents.agents) {
    if (a.stale && !a.disabled) rows.push({ k: 'stale-' + a.id, kind: 'Agent quiet',
      what: `${a.name} on ${a.board.name}`, detail: a.lastSeenAt ? 'last seen ' + timeAgo(a.lastSeenAt) : 'never seen',
      href: '/' + a.board.slug + '/settings' });
    if (wakeBad(a)) rows.push({ k: 'wake-' + a.id, kind: 'Wake failing',
      what: `${a.name} on ${a.board.name}`, detail: 'last delivery ' + a.lastDeliveryStatus,
      href: '/' + a.board.slug + '/settings' });
  }
  for (const p of people.people) {
    if (p.neverSignedIn) rows.push({ k: 'never-' + p.id, kind: 'Never signed in',
      what: p.displayName, detail: p.username, tab: 'people' });
    if (p.boards.length === 0) rows.push({ k: 'none-' + p.id, kind: 'On no board',
      what: p.displayName, detail: 'can sign in and reach nothing', tab: 'people' });
  }
  for (const b of people.boards) {
    if (b.hasPassphrase) rows.push({ k: 'pass-' + b.slug, kind: 'Passphrase still set',
      what: b.name, detail: 'a shared secret that names nobody', href: '/' + b.slug + '/settings' });
  }
  return (
    <section>
      <h3>Attention <span>{rows.length}</span></h3>
      <p className="hint">Quiet agents are those not seen for {agents.staleDays}+ days; disabled agents are left out.</p>
      {rows.length === 0 ? <div className="empty">Nothing needs attention.</div> : (
        <ul className="alist">
          {rows.map(r => (
            <li key={r.k}>
              <b>{r.kind}</b>
              {r.href ? <a href={r.href}>{r.what}</a>
                : <button className="linkish" onClick={() => goto(r.tab)}>{r.what}</button>}
              <span>{r.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

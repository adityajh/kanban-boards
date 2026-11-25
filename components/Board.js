'use client';
import { useEffect, useState, useCallback } from 'react';
import { timeAgo, store } from './util';
import Diagram from './Diagram';
import { splitBlocks } from '../lib/markup.mjs';
import { claimState, sameName } from '../lib/cards.mjs';

// Stuck sits after In Progress: it is where started work goes when it cannot proceed, not a
// step on the way to Review. One list drives the columns, the drop targets and the status
// select on a card, so a stage exists in all three places or none.
const COLS = [
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'stuck', label: 'Stuck' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];
const DEFAULT_ACCENT = '#D67D2E';
// The single-tenant board saved these un-namespaced. They're adopted on the board they
// belong to (the server decides which), so existing Inditress users aren't asked again.
const LEGACY_KEY = 'board_key', LEGACY_USER = 'board_user';

const overdue = (c) => c.due_at && c.status !== 'done' && new Date(c.due_at) < new Date();
const dueLabel = (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// Options for a select: the configured list, plus the current value if it's no longer in it.
const withCurrent = (list, cur) => (cur && !list.includes(cur) ? [...list, cur] : list);

// A lease end shown as a clock time, with the date only when it is not today: "until 14:30"
// is what somebody deciding whether to wait needs, and a date there would only be noise.
const untilLabel = (iso) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : dueLabel(iso) + ' ' + t;
};

export default function Board({ slug }) {
  const [me, setMe] = useState(undefined); // undefined = still checking, null = signed out
  const [boards, setBoards] = useState([]);
  const [tenant, setTenant] = useState(null);
  const [cards, setCards] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [err, setErr] = useState('');
  const [dragCol, setDragCol] = useState(null);
  const [resources, setResources] = useState([]);
  const [resLabel, setResLabel] = useState('');
  const [resUrl, setResUrl] = useState('');
  // Which column is taking a new project, and what has been typed into it. This used to be
  // window.prompt(), which is a modal outside the page: it cannot be styled or cancelled
  // gracefully, some browsers suppress it, and an automated browser cannot type into it at
  // all — so an agent driving the board either hung on the dialog or saw the click do
  // nothing. An input in the page works the same for a person and for anything else.
  const [adding, setAdding] = useState(null);
  const [newTitle, setNewTitle] = useState('');
  const [delRes, setDelRes] = useState(null);
  // Agent cards are hidden from the columns by default and switched back on here. This is a
  // view filter and nothing more: the API returns them to people either way, because agent
  // work no human could see would defeat the log it is written beside.
  const [showAgent, setShowAgent] = useState(false);
  // "Waiting on me": columns narrow to cards assigned to the signed-in person. Like the toggle
  // above it is a view filter only; nothing about the cards or what the API returns changes.
  const [showMine, setShowMine] = useState(false);
  const [roster, setRoster] = useState(null);
  // claimState() reads the clock, but nothing re-renders when a lease runs out, so a pill
  // would keep saying "claimed" after the claim had lapsed. A slow tick is enough: a lease is
  // minutes long, and the point is only that an expired claim stops showing as live.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    // These used to hold the shared passphrase. Per-person logins replaced it, so clear
    // the leftovers rather than leave an old secret sitting in localStorage.
    for (const k of [LEGACY_KEY, LEGACY_USER, 'board_key:' + slug, 'board_user:' + slug]) store.del(k);
    const card = Number(new URLSearchParams(window.location.search).get('card'));
    if (card) setOpenId(card);
  }, [slug]);

  // The session cookie is same-origin and HttpOnly, so there is no token to attach. It
  // names a person, not a board, so every call says which board it means — and the server
  // checks membership of it rather than taking the header's word for anything.
  const api = useCallback(async (path, method = 'GET', body) => {
    const r = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Tenant': slug },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { setMe(null); setTenant(null); throw new Error('Your session expired'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
    return r.json();
  }, [slug]);

  // One sign-in covers every board you belong to; `boards` is both the switcher's contents
  // and the check that this URL is one you may open.
  useEffect(() => {
    let live = true;
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!live) return;
        setMe(d ? d.user : null);
        setBoards(d ? d.boards : []);
      })
      .catch(() => { if (live) setMe(null); });
    return () => { live = false; };
  }, [slug]);

  useEffect(() => {
    if (!me || me.mustChange || !boards.some(b => b.slug === slug)) return;
    let live = true;
    api('/tenant')
      .then(tn => { if (live) { setTenant(tn); setErr(''); } })
      .catch(e => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [me, api, boards, slug]);

  const cfg = tenant?.config || {};
  const names = cfg.names || [];
  const tags = cfg.tags || [];
  const user = me?.displayName;
  // People first, then agents, deduplicated case-insensitively so a name in both the board
  // config and the membership list is suggested once.
  const addressees = (() => {
    const all = [...(roster?.people || []), ...(roster?.agents || []), ...names];
    const seen = new Set();
    return all.filter(n => {
      const k = String(n).trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    });
  })();

  // Who a note can be addressed to. The board's configured `names` list holds people and is
  // often out of date, and it has never held agents at all — but addressing an agent is most
  // of the point of `to`. The inbox endpoint already assembles the names this board really
  // knows, from its memberships and its live agents, so the suggestions come from there and
  // the config list is only a fallback. Fetched once per board rather than on every reload:
  // it costs several queries and a roster does not change between two card drags.
  useEffect(() => {
    if (!tenant) return;
    let live = true;
    api('/inbox')
      .then(d => { if (live && d?.roster) setRoster(d.roster); })
      .catch(() => { /* an older deployment has no /inbox; the config names still work */ });
    return () => { live = false; };
  }, [tenant, api]);

  useEffect(() => {
    if (!tenant) return;
    document.documentElement.style.setProperty('--accent', cfg.accent || DEFAULT_ACCENT);
    document.title = (cfg.brand || tenant.name) + ' · Board';
  }, [tenant]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    try {
      const [cs, rs] = await Promise.all([api('/cards'), api('/resources')]);
      setCards(cs); setResources(rs); setErr('');
    } catch (e) { setErr(e.message); }
  }, [api]);

  const addResource = async () => {
    if (!resUrl.trim() || !resLabel.trim()) return;
    let u = resUrl.trim(); if (!/^https?:\/\//.test(u) && !u.startsWith('/')) u = 'https://' + u;
    const r = await api('/resources', 'POST', { label: resLabel.trim(), url: u });
    setResources(rs => [...rs, r]); setResLabel(''); setResUrl('');
  };
  const delResource = async (id) => {
    await api('/resources/' + id, 'DELETE');
    setResources(rs => rs.filter(r => r.id !== id));
    setDelRes(null);
  };

  useEffect(() => { if (tenant) load(); }, [tenant, load]);

  const dots = cfg.dots > 0 ? Array.from({ length: cfg.dots }, (_, i) => <i key={i} />) : null;
  const onThisBoard = boards.some(b => b.slug === slug);
  const isAdminHere = boards.some(b => b.slug === slug && b.is_admin);
  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setMe(null); setBoards([]); setTenant(null); setCards([]); setResources([]);
  };

  // ---- gates ----
  // Nothing about the board — not even its name or accent — is shown before sign-in.
  if (me === undefined) return <div className="gate"><p>Loading…</p></div>;
  if (!me) return <Login slug={slug} onIn={(user, bs) => { setMe(user); setBoards(bs); }} />;
  if (me.mustChange) return <FirstPassword onDone={setMe} />;
  if (!onThisBoard) return <NotYourBoard boards={boards} onSignOut={signOut} />;
  if (!tenant) return <div className="gate"><p>{err || 'Loading…'}</p></div>;

  // ---- card ops ----
  const open = openId != null ? cards.find(c => c.id === openId) : null;
  const closeCard = () => {
    setOpenId(null);
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  };
  const patchCard = async (id, fields) => { const u = await api('/cards/' + id, 'PATCH', fields); setCards(cs => cs.map(c => c.id === id ? { ...c, ...u } : c)); };
  // The field stays open after a card is added, so a column can be filled in one go.
  const addCard = async (status) => {
    const title = newTitle.trim();
    if (!title) { setAdding(null); return; }
    try {
      const c = await api('/cards', 'POST', { title, status });
      setCards(cs => [...cs, c]);
      setNewTitle('');
    } catch (e) { setErr(e.message); }
  };
  // Confirmation lives in the modal now, for the same reason as above.
  const delCard = async (id) => { await api('/cards/' + id, 'DELETE'); setCards(cs => cs.filter(c => c.id !== id)); closeCard(); };

  // Move a card to a column, optionally before another card. Uses fractional
  // positions so only the moved card needs persisting.
  const moveCard = async (status, beforeId = null) => {
    setDragCol(null);
    const id = window.__dragCard; window.__dragCard = null;
    if (!id) return;
    const moving = cards.find(c => c.id === id);
    if (!moving) return;
    if (moving.status === status && id === beforeId) return;
    const colCards = cards
      .filter(c => c.status === status && c.id !== id)
      .sort((a, b) => a.position - b.position);
    let newPos;
    if (beforeId == null) {
      newPos = colCards.length ? colCards[colCards.length - 1].position + 1 : 1;
    } else {
      const idx = colCards.findIndex(c => c.id === beforeId);
      const prev = colCards[idx - 1];
      const target = colCards[idx];
      if (!target) newPos = colCards.length ? colCards[colCards.length - 1].position + 1 : 1;
      else if (!prev) newPos = target.position - 1;
      else newPos = (prev.position + target.position) / 2;
    }
    setCards(cs => cs.map(c => c.id === id ? { ...c, status, position: newPos } : c));
    await patchCard(id, { status, position: newPos });
  };

  const reload = load;

  // Both filters are applied here, once, so the columns and the empty-board message agree
  // about what "visible" means. `mine` is counted before the agent filter on purpose: it lets
  // the message tell "nothing is yours" apart from "yours is hidden behind agent work".
  const mineAll = cards.filter(c => sameName(c.assignee, user));
  const visible = cards
    // A card waiting on a person stays visible whatever its audience says: an
    // approval nobody can see is a card stuck forever.
    .filter(c => showAgent || c.audience !== 'agent_only' || c.status === 'review')
    .filter(c => !showMine || sameName(c.assignee, user));
  const mineEmpty = showMine && visible.length === 0
    ? (mineAll.length > 0
        ? 'Everything assigned to you is agent work, which is hidden. Use "show agent work" to see it.'
        : 'Nothing is assigned to ' + user + '. Cards are matched on the assignee name, so a card assigned under a different spelling will not appear here.')
    : '';

  return (
    <>
      <div className="topbar">
        <div className="brand">{cfg.brand || tenant.name}{cfg.tagline && <small>{cfg.tagline}</small>}</div>
        <div className="spacer" />
        {dots && <div className="dots" title={cfg.dotsTitle || ''}>{dots}</div>}
        {boards.length > 1 && <BoardSwitcher boards={boards} slug={slug} />}
        <div className="whoami">You are <b>{user}</b>{isAdminHere && <span className="badge">admin</span>}</div>
        <button className={'linkbtn' + (showAgent ? ' on' : '')}
          title="Show cards agents created for themselves"
          onClick={() => setShowAgent(v => !v)}>{showAgent ? 'hide agent work' : 'show agent work'}</button>
        <button className={'linkbtn' + (showMine ? ' on' : '')}
          title="Only cards assigned to you"
          onClick={() => setShowMine(v => !v)}>mine</button>
        {cfg.plan && <a className="linkbtn" href={'/' + slug + '/plan'}>plan</a>}
        <a className="linkbtn" href={'/' + slug + '/settings'}>settings</a>
        <button className="linkbtn" onClick={signOut}>sign out</button>
      </div>
      {err && <div className="err" style={{ padding: '8px 22px' }}>{err}</div>}
      {mineEmpty && <div className="empty boardnote">{mineEmpty}</div>}
      <div className="board">
        {COLS.map(col => {
          const list = visible
            .filter(c => c.status === col.id)
            .sort((a, b) => a.position - b.position);
          return (
            <div key={col.id} className={'col' + (dragCol === col.id ? ' drag' : '')}
              onDragOver={e => { e.preventDefault(); setDragCol(col.id); }}
              onDragLeave={() => setDragCol(d => d === col.id ? null : d)}
              onDrop={e => { e.preventDefault(); moveCard(col.id, null); }}>
              <h2>{col.label}<span>{list.length}</span></h2>
              <div className="cards">
                {list.map(c => {
                  const done = c.subtasks.filter(s => s.done).length, tot = c.subtasks.length;
                  const held = claimState(c);
                  return (
                    <div key={c.id} className="card" draggable
                      onDragStart={e => { e.stopPropagation(); window.__dragCard = c.id; }}
                      onDragOver={e => { e.preventDefault(); }}
                      onDrop={e => { e.preventDefault(); e.stopPropagation(); moveCard(col.id, c.id); }}
                      onClick={() => setOpenId(c.id)}>
                      <div className="title">{c.title}</div>
                      <div className="meta">
                        {c.tag && <span className="tag">{c.tag}</span>}
                        <span className="assignee">{c.assignee}</span>
                        {tot > 0 && <span className="pill">{done}/{tot}</span>}
                        {c.links.length > 0 && <span className="pill">🔗 {c.links.length}</span>}
                        {c.notes.length > 0 && <span className="pill">💬 {c.notes.length}</span>}
                      </div>
                      {tot > 0 && <div className="bar"><i style={{ width: (done / tot * 100) + '%' }} /></div>}
                      <div className="assignee" style={{ marginTop: 6, fontSize: 10 }}>
                        {c.audience === 'agent_only' && <span className="pill agentpill">agent</span>}
                        {held && <span className="pill claimpill" title={'Until ' + untilLabel(held.until)}>claimed · {held.by}</span>}
                        {c.answered && <span className="pill answeredpill" title="A person has dealt with this">✓ answered</span>}
                        {c.due_at && <span className={'pill' + (overdue(c) ? ' late' : '')}>due {dueLabel(c.due_at)}</span>}
                        updated {timeAgo(c.updated_at)}
                      </div>
                    </div>
                  );
                })}
                {adding === col.id ? (
                  <div className="addinline">
                    <input autoFocus value={newTitle} placeholder="Project title…"
                      aria-label={'New project in ' + col.label}
                      onChange={e => setNewTitle(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') addCard(col.id);
                        if (e.key === 'Escape') { setAdding(null); setNewTitle(''); }
                      }} />
                    <button className="btn" onClick={() => addCard(col.id)}>Add</button>
                    <button className="x" title="Cancel"
                      onClick={() => { setAdding(null); setNewTitle(''); }}>×</button>
                  </div>
                ) : (
                  <button className="addcard"
                    onClick={() => { setAdding(col.id); setNewTitle(''); }}>+ Add project</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="library">
        <div className="lib-head"><h3>Library</h3><span>Shared docs &amp; links</span></div>
        <div className="shelf">
          {resources.length === 0 && <div className="empty">No shared docs yet. Add one below.</div>}
          {resources.map(r => (
            <div key={r.id} className="res">
              <a href={r.url} target="_blank" rel="noreferrer">{r.label}</a>
              {delRes === r.id ? (
                <span className="foot-left">
                  <button className="btn danger" autoFocus onClick={() => delResource(r.id)}>Remove</button>
                  <button className="btn" onClick={() => setDelRes(null)}>Keep</button>
                </span>
              ) : (
                <button className="x" title="Remove from Library"
                  onClick={() => setDelRes(r.id)}>×</button>
              )}
            </div>
          ))}
          <div className="addinline">
            <input value={resLabel} placeholder="Title" onChange={e => setResLabel(e.target.value)} />
            <input value={resUrl} placeholder="URL" onChange={e => setResUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && addResource()} />
            <button className="btn" onClick={addResource}>Add</button>
          </div>
        </div>
      </div>

      {open && <Detail card={open} user={user} names={names} addressees={addressees} tags={tags} api={api} reload={reload} patchCard={patchCard} delCard={delCard} close={closeCard} />}
    </>
  );
}

// One account, several boards: a person who lands on a board they are not on gets told
// plainly rather than shown a sign-in form they would only fail.
function NotYourBoard({ boards, onSignOut }) {
  return (
    <div className="gate">
      <h1>Not your board</h1>
      <p>You are signed in, but this board is not one of yours.</p>
      {boards.length > 0 && (
        <>
          <p style={{ margin: '0 0 12px' }}>Your boards:</p>
          <div className="names">
            {boards.map(b => <a key={b.slug} href={'/' + b.slug}>{b.name}</a>)}
          </div>
        </>
      )}
      <button className="linkbtn" style={{ marginTop: 18 }} onClick={onSignOut}>sign out</button>
    </div>
  );
}

function BoardSwitcher({ boards, slug }) {
  return (
    <select className="switcher" value={slug}
      onChange={e => { window.location.href = '/' + e.target.value; }}>
      {boards.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
    </select>
  );
}

function Login({ slug, onIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error || 'Sign in failed'); setPassword(''); return; }
      onIn(d.user, d.boards || []);
    } catch {
      setErr('Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="gate" onSubmit={submit}>
      <h1>{slug}</h1>
      <div className="sub">Project Board</div>
      <p>Sign in with your username and password.</p>
      {err && <div className="err">{err}</div>}
      <input autoFocus value={username} placeholder="Username" autoComplete="username"
        onChange={e => setUsername(e.target.value)} />
      <input type="password" value={password} placeholder="Password" autoComplete="current-password"
        onChange={e => setPassword(e.target.value)} />
      <button className="btn" style={{ width: '100%' }} disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="fineprint">Lost your password? Ask your board admin to reset it.</p>
    </form>
  );
}

// Shown once, after a password that somebody else generated. The board stays out of reach
// until it is replaced.
function FirstPassword({ onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (next !== again) { setErr('The two new passwords do not match'); return; }
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error || 'Could not change the password'); return; }
      onDone(d.user);
    } catch {
      setErr('Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="gate" onSubmit={submit}>
      <h1>Set your password</h1>
      <p>You are signed in with a password someone else generated. Choose your own to continue.</p>
      {err && <div className="err">{err}</div>}
      <input type="password" value={current} placeholder="Password you were given"
        autoComplete="current-password" onChange={e => setCurrent(e.target.value)} />
      <input type="password" value={next} placeholder="New password" autoComplete="new-password"
        onChange={e => setNext(e.target.value)} />
      <input type="password" value={again} placeholder="New password again" autoComplete="new-password"
        onChange={e => setAgain(e.target.value)} />
      <button className="btn" style={{ width: '100%' }} disabled={busy}>
        {busy ? 'Saving…' : 'Save and continue'}
      </button>
    </form>
  );
}

function Detail({ card, user, names, addressees, tags, api, reload, patchCard, delCard, close }) {
  const [c, setC] = useState(card);
  useEffect(() => { setC(card); }, [card]);
  const [newSt, setNewSt] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [note, setNote] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [noteTo, setNoteTo] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { setConfirmDel(false); setMsg(''); }, [card.id]);

  const refreshLocal = async () => { const all = await api('/cards/' + card.id); setC(all); reload(); };

  const saveField = (f, v) => { setC(p => ({ ...p, [f]: v })); patchCard(card.id, { [f]: v }); };

  const addSt = async () => { if (!newSt.trim()) return; await api('/cards/' + card.id + '/subtasks', 'POST', { title: newSt.trim() }); setNewSt(''); refreshLocal(); };
  const toggleSt = async (s) => { await api('/subtasks/' + s.id, 'PATCH', { done: !s.done }); refreshLocal(); };
  const editSt = async (s, title) => { if (title !== s.title) { await api('/subtasks/' + s.id, 'PATCH', { title }); refreshLocal(); } };
  const delSt = async (s) => { await api('/subtasks/' + s.id, 'DELETE'); refreshLocal(); };
  const dropSt = async (target) => {
    const from = window.__dragSt; if (from == null || from === target.id) return;
    const arr = [...c.subtasks]; const fi = arr.findIndex(x => x.id === from); const ti = arr.findIndex(x => x.id === target.id);
    const [m] = arr.splice(fi, 1); arr.splice(ti, 0, m);
    setC(p => ({ ...p, subtasks: arr }));
    await Promise.all(arr.map((s, i) => api('/subtasks/' + s.id, 'PATCH', { position: i + 1 })));
    refreshLocal();
  };

  const addLink = async () => { if (!linkUrl.trim()) return; let u = linkUrl.trim(); if (!/^https?:\/\//.test(u)) u = 'https://' + u; await api('/cards/' + card.id + '/links', 'POST', { label: linkLabel.trim(), url: u }); setLinkLabel(''); setLinkUrl(''); refreshLocal(); };
  const delLink = async (l) => { await api('/links/' + l.id, 'DELETE'); refreshLocal(); };
  // `to` is left out entirely when empty rather than sent blank: the API refuses a blank
  // addressee, and most notes are addressed to nobody.
  const addNote = async () => {
    if (!note.trim()) return;
    const body = { author: user, body: note.trim() };
    if (noteTo.trim()) body.to = noteTo.trim();
    await api('/cards/' + card.id + '/notes', 'POST', body);
    setNote(''); setNoteTo(''); refreshLocal();
  };
  const delNote = async (n) => { await api('/notes/' + n.id, 'DELETE'); refreshLocal(); };

  // Deliberately not something agents maintain: `answered` means a person has dealt with the
  // card, the API refuses an agent that tries to set it, and it is cleared whenever an agent
  // adds a note. The checkbox therefore reads straight from the card, never from state of its
  // own, so a tick the server has cleared disappears on the next refresh instead of lingering.
  const setAnswered = async (v) => {
    setMsg('');
    try { await patchCard(card.id, { answered: v }); } catch (e) { setMsg(e.message); }
  };

  // api() throws only the message, not the status, so a 409 cannot be told from other
  // failures here. Rather than show the server's sentence (which carries a raw ISO time),
  // re-read the card: if somebody else now holds it, say so in the board's own terms.
  const claim = async () => {
    setMsg('');
    try {
      await api('/cards/' + card.id + '/claim', 'POST', {});
      await refreshLocal();
    } catch (e) {
      try {
        const fresh = await api('/cards/' + card.id);
        const h = claimState(fresh);
        if (h && !sameName(h.by, user)) setMsg(h.by + ' is working on this until ' + untilLabel(h.until) + '.');
        else setMsg(e.message);
        setC(fresh); reload();
      } catch { setMsg(e.message); }
    }
  };
  const release = async () => {
    setMsg('');
    try { await api('/cards/' + card.id + '/claim', 'DELETE'); await refreshLocal(); }
    catch (e) { setMsg(e.message); }
  };

  // An expired lease reads as no claim at all, so it offers "claim" rather than "release".
  const held = claimState(c);
  const tagOpts = withCurrent(tags, c.tag);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal">
        <input className="titleinput" defaultValue={c.title} onBlur={e => saveField('title', e.target.value)} />
        <div className="row">
          <select value={c.assignee} onChange={e => saveField('assignee', e.target.value)}>
            {withCurrent(['Unassigned', ...names], c.assignee).map(n => <option key={n}>{n}</option>)}
          </select>
          {tagOpts.length > 0 && (
            <select value={c.tag} onChange={e => saveField('tag', e.target.value)}>
              {['', ...tagOpts].map(t => <option key={t} value={t}>{t ? 'Tag ' + t : 'No tag'}</option>)}
            </select>
          )}
          <select value={c.status} onChange={e => saveField('status', e.target.value)}>
            {COLS.map(col => <option key={col.id} value={col.id}>{col.label}</option>)}
          </select>
          <input type="date" value={c.due_at ? String(c.due_at).slice(0, 10) : ''}
            title="Due date"
            onChange={e => saveField('due_at', e.target.value || null)} />
        </div>
        <div className="holdrow">
          <label title="A person has dealt with this. Set by people only; agents do not maintain it.">
            <input type="checkbox" checked={!!c.answered} onChange={e => setAnswered(e.target.checked)} /> answered
          </label>
          {held ? (
            <>
              <span className="claimtext">
                {sameName(held.by, user) ? <b>You</b> : <b>{held.by}</b>} {sameName(held.by, user) ? 'are' : 'is'} working on this until {untilLabel(held.until)}
              </span>
              <button className="linkbtn" onClick={release}>release</button>
            </>
          ) : (
            <button className="linkbtn" onClick={claim}>claim</button>
          )}
        </div>
        {msg && <div className="err">{msg}</div>}
        <textarea className="desc" defaultValue={c.description} placeholder="Project description…" onBlur={e => saveField('description', e.target.value)} />

        <div className="section">
          <h4>Subtasks ({c.subtasks.filter(s => s.done).length}/{c.subtasks.length}) · drag to reorder</h4>
          {c.subtasks.map(s => (
            <div key={s.id} className={'st' + (s.done ? ' done' : '')} draggable
              onDragStart={() => { window.__dragSt = s.id; }}
              onDragOver={e => e.preventDefault()} onDrop={() => dropSt(s)}>
              <span className="grip">⠿</span>
              <input type="checkbox" checked={s.done} onChange={() => toggleSt(s)} />
              <input className="sttext" defaultValue={s.title} onBlur={e => editSt(s, e.target.value)} />
              <button className="x" onClick={() => delSt(s)}>×</button>
            </div>
          ))}
          <div className="addinline">
            <input value={newSt} placeholder="Add a subtask…" onChange={e => setNewSt(e.target.value)} onKeyDown={e => e.key === 'Enter' && addSt()} />
            <button className="btn" onClick={addSt}>Add</button>
          </div>
        </div>

        <div className="section">
          <h4>Links</h4>
          {c.links.map(l => (
            <div key={l.id} className="linkitem">
              <a href={l.url} target="_blank" rel="noreferrer">{l.label || l.url}</a>
              <button className="x" onClick={() => delLink(l)}>×</button>
            </div>
          ))}
          <div className="addinline">
            <input value={linkLabel} placeholder="Label (optional)" onChange={e => setLinkLabel(e.target.value)} />
            <input value={linkUrl} placeholder="URL" onChange={e => setLinkUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && addLink()} />
            <button className="btn" onClick={addLink}>Add</button>
          </div>
        </div>

        <div className="section">
          <h4>Notes</h4>
          {c.notes.map(n => (
            <div key={n.id} className="note">
              <span className="who">{n.author}</span>{n.addressed_to && <span className="to">→ {n.addressed_to}</span>}<span className="when">{timeAgo(n.created_at)} <button className="x" onClick={() => delNote(n)}>×</button></span>
              {/* Same approach as Plan: a fenced mermaid block draws, everything else is the
                  text it always was. */}
              {splitBlocks(n.body).map((b, i) => (
                b.kind === 'diagram'
                  ? <Diagram key={i} source={b.value} />
                  : <div key={i} className="body">{b.value}</div>
              ))}
            </div>
          ))}
          <div className="addinline">
            <input value={note} placeholder={'Add a note as ' + user + '…'} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNote()} />
            <input className="toinput" value={noteTo} placeholder="to (optional)" aria-label="Address this note to"
              list="note-to-names" onChange={e => setNoteTo(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNote()} />
            <datalist id="note-to-names">{(addressees || names).map(n => <option key={n} value={n} />)}</datalist>
            <button className="btn" onClick={addNote}>Post</button>
          </div>
        </div>

        <div className="modal-foot">
          <div className="foot-left">
            {confirmDel ? (
              <>
                <span className="confirmtext">Delete this project and all its subtasks, links and notes?</span>
                <button className="btn danger" autoFocus onClick={() => delCard(card.id)}>Delete</button>
                <button className="btn" onClick={() => setConfirmDel(false)}>Keep</button>
              </>
            ) : (
              <button className="btn danger" onClick={() => setConfirmDel(true)}>Delete project</button>
            )}
          </div>
          <button className="btn ghost" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}

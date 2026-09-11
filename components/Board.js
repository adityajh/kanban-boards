'use client';
import { useEffect, useState, useCallback } from 'react';
import { timeAgo, store } from './util';

const COLS = [
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];
const DEFAULT_ACCENT = '#D67D2E';
// The single-tenant board saved these un-namespaced. They're adopted on the board they
// belong to (the server decides which), so existing Inditress users aren't asked again.
const LEGACY_KEY = 'board_key', LEGACY_USER = 'board_user';

// Options for a select: the configured list, plus the current value if it's no longer in it.
const withCurrent = (list, cur) => (cur && !list.includes(cur) ? [...list, cur] : list);

export default function Board({ slug }) {
  const KEY = 'board_key:' + slug, USER = 'board_user:' + slug;
  const [key, setKey] = useState(null);
  const [user, setUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [cards, setCards] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [err, setErr] = useState('');
  const [pass, setPass] = useState('');
  const [dragCol, setDragCol] = useState(null);
  const [resources, setResources] = useState([]);
  const [resLabel, setResLabel] = useState('');
  const [resUrl, setResUrl] = useState('');

  useEffect(() => {
    setKey(store.get(KEY) || store.get(LEGACY_KEY));
    setUser(store.get(USER) || store.get(LEGACY_USER));
    const card = Number(new URLSearchParams(window.location.search).get('card'));
    if (card) setOpenId(card);
  }, [KEY, USER]);

  const forgetKey = useCallback((k) => {
    store.del(KEY);
    if (store.get(LEGACY_KEY) === k) store.del(LEGACY_KEY);
    setKey(null); setTenant(null);
  }, [KEY]);

  const api = useCallback(async (path, method = 'GET', body) => {
    const r = await fetch('/api' + path, {
      method,
      // X-Tenant only matters for the admin key; a board passphrase already names its board.
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Tenant': slug },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { forgetKey(key); setErr('Wrong passphrase'); throw new Error('Wrong passphrase'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
    return r.json();
  }, [key, slug, forgetKey]);

  // Confirm the passphrase opens *this* board before saving it or showing anything.
  useEffect(() => {
    if (!key) return;
    let live = true;
    api('/tenant').then(tn => {
      if (!live) return;
      if (tn.slug !== slug) {
        const legacy = store.get(LEGACY_KEY) === key;
        store.del(KEY); setKey(null);
        if (!legacy) setErr('That passphrase is for a different board.');
        return;
      }
      store.set(KEY, key);
      if (store.get(LEGACY_KEY) === key) store.del(LEGACY_KEY);
      setTenant(tn); setErr('');
    }).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [key, slug, api, KEY]);

  const cfg = tenant?.config || {};
  const names = cfg.names || [];
  const tags = cfg.tags || [];

  useEffect(() => {
    if (!tenant) return;
    if (user && !names.includes(user)) { setUser(null); return; }
    if (user) store.set(USER, user);
  }, [tenant, user]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!confirm('Remove this from the Library?')) return;
    await api('/resources/' + id, 'DELETE'); setResources(rs => rs.filter(r => r.id !== id));
  };

  useEffect(() => { if (tenant && user) load(); }, [tenant, user, load]);

  const dots = cfg.dots > 0 ? Array.from({ length: cfg.dots }, (_, i) => <i key={i} />) : null;
  const enter = () => { if (pass) { setKey(pass); setPass(''); setErr(''); } };

  // ---- gates ----
  if (!key) {
    return (
      <div className="gate">
        <h1>{slug}</h1>
        <div className="sub">Project Board</div>
        <p>Enter the shared passphrase to continue.</p>
        {err && <div className="err">{err}</div>}
        <input type="password" value={pass} placeholder="Passphrase"
          onChange={e => setPass(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') enter(); }} />
        <button className="btn" style={{ width: '100%' }} onClick={enter}>Enter</button>
      </div>
    );
  }
  if (!tenant) {
    return <div className="gate"><p>{err || 'Loading…'}</p></div>;
  }
  if (!user) {
    return (
      <div className="gate">
        {dots && <div className="gatedots">{dots}</div>}
        <h1>Who are you?</h1>
        <p>So your notes and edits are attributed. No login needed.</p>
        <div className="names">
          {names.map(n => <button key={n} onClick={() => setUser(n)}>{n}</button>)}
        </div>
      </div>
    );
  }

  // ---- card ops ----
  const open = openId != null ? cards.find(c => c.id === openId) : null;
  const closeCard = () => {
    setOpenId(null);
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  };
  const patchCard = async (id, fields) => { const u = await api('/cards/' + id, 'PATCH', fields); setCards(cs => cs.map(c => c.id === id ? { ...c, ...u } : c)); };
  const addCard = async (status) => {
    const title = prompt('New project title:'); if (!title) return;
    const c = await api('/cards', 'POST', { title, status }); setCards(cs => [...cs, c]);
  };
  const delCard = async (id) => { if (!confirm('Delete this project and all its subtasks, links and notes?')) return; await api('/cards/' + id, 'DELETE'); setCards(cs => cs.filter(c => c.id !== id)); closeCard(); };

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

  return (
    <>
      <div className="topbar">
        <div className="brand">{cfg.brand || tenant.name}{cfg.tagline && <small>{cfg.tagline}</small>}</div>
        <div className="spacer" />
        {dots && <div className="dots" title={cfg.dotsTitle || ''}>{dots}</div>}
        <div className="whoami">You are <b>{user}</b></div>
        <button className="linkbtn" onClick={() => { store.del(USER); store.del(LEGACY_USER); setUser(null); }}>switch</button>
      </div>
      {err && <div className="err" style={{ padding: '8px 22px' }}>{err}</div>}
      <div className="board">
        {COLS.map(col => {
          const list = cards.filter(c => c.status === col.id).sort((a, b) => a.position - b.position);
          return (
            <div key={col.id} className={'col' + (dragCol === col.id ? ' drag' : '')}
              onDragOver={e => { e.preventDefault(); setDragCol(col.id); }}
              onDragLeave={() => setDragCol(d => d === col.id ? null : d)}
              onDrop={e => { e.preventDefault(); moveCard(col.id, null); }}>
              <h2>{col.label}<span>{list.length}</span></h2>
              <div className="cards">
                {list.map(c => {
                  const done = c.subtasks.filter(s => s.done).length, tot = c.subtasks.length;
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
                      <div className="assignee" style={{ marginTop: 6, fontSize: 10 }}>updated {timeAgo(c.updated_at)}</div>
                    </div>
                  );
                })}
                <button className="addcard" onClick={() => addCard(col.id)}>+ Add project</button>
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
              <button className="x" onClick={() => delResource(r.id)}>×</button>
            </div>
          ))}
          <div className="addinline">
            <input value={resLabel} placeholder="Title" onChange={e => setResLabel(e.target.value)} />
            <input value={resUrl} placeholder="URL" onChange={e => setResUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && addResource()} />
            <button className="btn" onClick={addResource}>Add</button>
          </div>
        </div>
      </div>

      {open && <Detail card={open} user={user} names={names} tags={tags} api={api} reload={reload} patchCard={patchCard} delCard={delCard} close={closeCard} />}
    </>
  );
}

function Detail({ card, user, names, tags, api, reload, patchCard, delCard, close }) {
  const [c, setC] = useState(card);
  useEffect(() => { setC(card); }, [card]);
  const [newSt, setNewSt] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [note, setNote] = useState('');

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
  const addNote = async () => { if (!note.trim()) return; await api('/cards/' + card.id + '/notes', 'POST', { author: user, body: note.trim() }); setNote(''); refreshLocal(); };
  const delNote = async (n) => { await api('/notes/' + n.id, 'DELETE'); refreshLocal(); };

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
        </div>
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
              <span className="who">{n.author}</span><span className="when">{timeAgo(n.created_at)} <button className="x" onClick={() => delNote(n)}>×</button></span>
              <div className="body">{n.body}</div>
            </div>
          ))}
          <div className="addinline">
            <input value={note} placeholder={'Add a note as ' + user + '…'} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNote()} />
            <button className="btn" onClick={addNote}>Post</button>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn danger" onClick={() => delCard(card.id)}>Delete project</button>
          <button className="btn ghost" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}

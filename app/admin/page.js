'use client';
import { useEffect, useState, useCallback } from 'react';
import { timeAgo, store } from '../../components/util';

const EMPTY_FORM = { slug: '', name: '', names: 'Adi', tags: '', accent: '#D67D2E' };

export default function Admin() {
  const [key, setKey] = useState(null);
  const [pass, setPass] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [created, setCreated] = useState(null);

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

  const load = useCallback(() => api('/overview')
    .then(d => { store.set('admin_key', key); setData(d); setErr(''); })
    .catch(e => setErr(e.message)), [api, key]);
  useEffect(() => { if (key) load(); }, [key, load]);

  const create = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/tenants', 'POST', {
        slug: form.slug, name: form.name,
        config: { names: form.names, tags: form.tags, accent: form.accent },
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
        {!data ? <p className="empty">Loading…</p> : <>
          <section>
            <h3>Boards <span>{data.boards.length}</span></h3>
            <p className="hint">Your admin key also opens any board.</p>
            <div className="ascroll">
              <table className="atable">
                <thead><tr><th>Board</th><th>To Do</th><th>In Progress</th><th>Stuck</th><th>Review</th><th>Done</th><th>Last activity</th></tr></thead>
                <tbody>
                  {data.boards.map(b => (
                    <tr key={b.slug}>
                      <td><a href={'/' + b.slug}>{b.name}</a><span className="slug">/{b.slug}</span></td>
                      <td>{b.todo}</td><td>{b.in_progress}</td>
                      <td className={b.stuck ? 'hot' : ''}>{b.stuck}</td>
                      <td className={b.review ? 'hot' : ''}>{b.review}</td><td>{b.done}</td>
                      <td>{b.last_activity ? timeAgo(b.last_activity) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

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
              <button className="btn" type="submit">Create board</button>
            </form>
            {created && (
              <div className="created">
                Created <a href={'/' + created.tenant.slug}>/{created.tenant.slug}</a>.
                Both secrets below are shown once — copy them now.
                <div>Passphrase (for agents): <code>{created.passphrase}</code></div>
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
      </div>
    </>
  );
}

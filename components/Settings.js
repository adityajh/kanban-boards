'use client';
import { useEffect, useState, useCallback } from 'react';

const DEFAULT_ACCENT = '#D67D2E';
const TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'board', label: 'Board' },
  { id: 'people', label: 'People' },
];

const asList = (s) => s.split(',').map(x => x.trim()).filter(Boolean);

export default function Settings({ slug }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('profile');
  const [err, setErr] = useState('');

  // A session names a person, not a board, so every call says which board it means.
  const api = useCallback(async (path, method = 'GET', body) => {
    const r = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Tenant': slug },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Error');
    return d;
  }, [slug]);

  const load = useCallback(() => {
    api('/settings')
      .then(d => { setData(d); setErr(''); })
      .catch(e => setErr(e.message));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!data) return;
    const cfg = data.tenant.config || {};
    document.documentElement.style.setProperty('--accent', cfg.accent || DEFAULT_ACCENT);
    document.title = (cfg.brand || data.tenant.name) + ' · Settings';
  }, [data]);

  if (err && !data) {
    return (
      <div className="gate">
        <h1>Settings</h1>
        <div className="err">{err}</div>
        <p><a className="linkbtn" href={'/' + slug}>Back to the board</a></p>
      </div>
    );
  }
  if (!data) return <div className="gate"><p>Loading…</p></div>;

  const cfg = data.tenant.config || {};
  const tabs = data.isAdmin ? TABS : TABS.filter(t => t.id === 'profile');

  return (
    <>
      <div className="topbar">
        <div className="brand">{cfg.brand || data.tenant.name}<small>Settings</small></div>
        <div className="spacer" />
        <a className="linkbtn" href={'/' + slug}>← back to board</a>
      </div>

      <div className="admin">
        <div className="tabs">
          {tabs.map(t => (
            <button key={t.id} className={'tab' + (tab === t.id ? ' on' : '')}
              onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        {err && <div className="err">{err}</div>}

        {tab === 'profile' && <Profile me={data.me} api={api} />}
        {tab === 'board' && data.isAdmin && <BoardSettings tenant={data.tenant} api={api} onSaved={load} />}
        {tab === 'people' && data.isAdmin && <People users={data.users} me={data.me} api={api} onChanged={load} />}
      </div>
    </>
  );
}

function Profile({ me, api }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // ADMIN_KEY can reach settings without being a person; there is no password to change then.
  if (!me) {
    return (
      <section>
        <h3>Profile</h3>
        <p className="hint">You are acting with the master admin key, not as a board user.</p>
      </section>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setMsg(''); setErr('');
    if (next !== again) { setErr('The two new passwords do not match'); return; }
    setBusy(true);
    try {
      await api('/auth/password', 'POST', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setAgain('');
      setMsg('Password changed. Your other sessions have been signed out.');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section>
        <h3>You</h3>
        <ul className="alist">
          <li><b>{me.displayName}</b> <span>@{me.username}</span>
            {me.isAdmin && <span className="badge">admin</span>}</li>
        </ul>
      </section>
      <section>
        <h3>Change password</h3>
        <p className="hint">One password covers every board you are on. Changing it signs you out of every other browser.</p>
        {msg && <div className="ok">{msg}</div>}
        {err && <div className="err">{err}</div>}
        <form className="aform" onSubmit={submit}>
          <label>Current password
            <input type="password" value={current} autoComplete="current-password"
              onChange={e => setCurrent(e.target.value)} />
          </label>
          <label>New password
            <input type="password" value={next} autoComplete="new-password"
              onChange={e => setNext(e.target.value)} />
          </label>
          <label>New password again
            <input type="password" value={again} autoComplete="new-password"
              onChange={e => setAgain(e.target.value)} />
          </label>
          <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        </form>
      </section>
    </>
  );
}

function BoardSettings({ tenant, api, onSaved }) {
  const cfg = tenant.config || {};
  const [f, setF] = useState({
    name: tenant.name,
    brand: cfg.brand || '',
    tagline: cfg.tagline || '',
    accent: cfg.accent || DEFAULT_ACCENT,
    names: (cfg.names || []).join(', '),
    tags: (cfg.tags || []).join(', '),
    dots: cfg.dots || 0,
    dotsTitle: cfg.dotsTitle || '',
  });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setMsg(''); setErr('');
    try {
      await api('/settings', 'PATCH', {
        name: f.name,
        config: {
          brand: f.brand, tagline: f.tagline, accent: f.accent,
          names: asList(f.names), tags: asList(f.tags),
          dots: Number(f.dots) || 0, dotsTitle: f.dotsTitle,
        },
      });
      setMsg('Saved.');
      onSaved();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>Board</h3>
      <p className="hint">
        How this board looks and who can be assigned work. Everyone on the board sees these.
      </p>
      {msg && <div className="ok">{msg}</div>}
      {err && <div className="err">{err}</div>}
      <form className="aform" onSubmit={submit}>
        <label>Board name<input value={f.name} onChange={set('name')} /></label>
        <label>Brand line<input value={f.brand} onChange={set('brand')} /></label>
        <label>Tagline<input value={f.tagline} onChange={set('tagline')} /></label>
        <label>Accent<input type="color" value={f.accent} onChange={set('accent')} /></label>
        <label>People (comma separated)<input value={f.names} onChange={set('names')} /></label>
        <label>Tags (comma separated)<input value={f.tags} onChange={set('tags')} /></label>
        <label>Dots (0–8)
          <input type="number" min="0" max="8" value={f.dots} onChange={set('dots')} /></label>
        <label>Dots caption<input value={f.dotsTitle} onChange={set('dotsTitle')} /></label>
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save board settings'}</button>
      </form>
    </section>
  );
}

function People({ users, me, api, onChanged }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [issued, setIssued] = useState(null); // { displayName, username, password }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setErr(''); setBusy(true);
    try { await fn(); onChanged(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const add = (e) => {
    e.preventDefault();
    if (!username.trim() || busy) return;
    run(async () => {
      const d = await api('/settings/users', 'POST', {
        username: username.trim(), displayName: displayName.trim() || username.trim(), isAdmin,
      });
      setIssued({ ...d.user, password: d.password, existing: d.existing });
      setUsername(''); setDisplayName(''); setIsAdmin(false);
    });
  };

  const reset = (u) => {
    if (!confirm(`Reset ${u.displayName}'s password? They have one password across every board they are on, so this replaces it everywhere and signs them out.`)) return;
    run(async () => {
      const d = await api('/settings/users/' + u.id, 'PATCH', { resetPassword: true });
      setIssued({ ...d.user, password: d.password });
    });
  };

  const toggleAdmin = (u) =>
    run(() => api('/settings/users/' + u.id, 'PATCH', { isAdmin: !u.isAdmin }));

  const remove = (u) => {
    if (!confirm(`Remove ${u.displayName} from this board? Their account and other boards are unaffected.`)) return;
    run(() => api('/settings/users/' + u.id, 'DELETE'));
  };

  return (
    <>
      <section>
        <h3>People <span>{users.length}</span></h3>
        <p className="hint">
          Everyone who can sign in to this board. Removing takes them off this board only —
          their account and any other board they are on are untouched, and their name stays
          on work already assigned to them.
        </p>
        {err && <div className="err">{err}</div>}
        <div className="ascroll">
          <table className="atable">
            <thead>
              <tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td>{u.displayName}{me && u.id === me.id && <span className="slug">you</span>}</td>
                  <td>@{u.username}</td>
                  <td>{u.isAdmin ? <span className="hot">admin</span> : 'member'}</td>
                  <td>{u.mustChange ? <span className="slug">password not set yet</span> : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="linkbtn" disabled={busy} onClick={() => reset(u)}>reset password</button>
                    <button className="linkbtn" disabled={busy} onClick={() => toggleAdmin(u)}>
                      {u.isAdmin ? 'make member' : 'make admin'}
                    </button>
                    {(!me || u.id !== me.id) &&
                      <button className="linkbtn" disabled={busy} onClick={() => remove(u)}>remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {issued && (
          <div className="created">
            {issued.password ? (
              <>
                Password for <b>{issued.displayName}</b> (<code>{issued.username}</code>):{' '}
                <code>{issued.password}</code>
                <div className="hint" style={{ margin: '6px 0 0' }}>
                  Shown once — copy it now. They will be asked to change it when they sign in.
                </div>
              </>
            ) : (
              <>
                <b>{issued.displayName}</b> (<code>{issued.username}</code>) already had an
                account and has been added to this board.
                <div className="hint" style={{ margin: '6px 0 0' }}>
                  They sign in with the password they already use — there is nothing to send them.
                </div>
              </>
            )}
            <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
        )}
      </section>

      <section>
        <h3>Add someone</h3>
        <p className="hint">
          If this username already has an account on another board, they join with the
          password they already use and no new one is issued.
        </p>
        <form className="aform" onSubmit={add}>
          <label>Username<input value={username} placeholder="rahul"
            onChange={e => setUsername(e.target.value)} /></label>
          <label>Display name<input value={displayName} placeholder="Rahul"
            onChange={e => setDisplayName(e.target.value)} /></label>
          <label className="check">
            <span><input type="checkbox" checked={isAdmin}
              onChange={e => setIsAdmin(e.target.checked)} /> Board admin</span>
          </label>
          <button className="btn" disabled={busy}>{busy ? 'Adding…' : 'Add person'}</button>
        </form>
      </section>
    </>
  );
}

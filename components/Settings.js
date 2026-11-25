'use client';
import { useEffect, useState, useCallback } from 'react';
import { timeAgo } from './util';

const DEFAULT_ACCENT = '#D67D2E';
const TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'board', label: 'Board' },
  { id: 'people', label: 'People' },
  { id: 'agents', label: 'Agents' },
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

  // Board management spans every board, so these calls deliberately send no X-Tenant:
  // with one, access would be gated on membership of the board you happen to be viewing.
  const adminApi = useCallback(async (path, method = 'GET', body) => {
    const r = await fetch('/api/admin' + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Error');
    return d;
  }, []);

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
  const isMaster = data.me?.isMaster === true;
  let tabs = data.isAdmin ? TABS : TABS.filter(t => t.id === 'profile');
  if (isMaster) tabs = [...tabs, { id: 'boards', label: 'Boards' }];

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
        {tab === 'agents' && data.isAdmin && <Agents api={api} />}
        {tab === 'boards' && isMaster && <Boards adminApi={adminApi} here={slug} />}
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
    // Two settings that describe how this board WORKS rather than how it looks. Both are
    // off by default, so a board nobody configures behaves exactly as it always has.
    reviewGate: !!cfg.reviewGate,
    agentCardsDefault: cfg.agentCardsDefault || 'agent_only',
  });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }));
  const setBool = (k) => (e) => setF(p => ({ ...p, [k]: e.target.checked }));

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
          reviewGate: f.reviewGate, agentCardsDefault: f.agentCardsDefault,
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
        <label className="wide">An agent's new cards are
          <select value={f.agentCardsDefault} onChange={set('agentCardsDefault')}>
            <option value="agent_only">for agents, until one shares it</option>
            <option value="both">visible to everyone</option>
          </select>
          <span className="sub">
            Keep the first on a board run by people, so agent working notes stay out of the
            way. Choose the second on a board where almost everything is done by agents,
            where the first leaves the board looking empty to whoever is watching it.
          </span>
        </label>
        <label className="wide check">
          <input type="checkbox" checked={f.reviewGate} onChange={setBool('reviewGate')} />
          A board admin must approve work as done
          <span className="sub">
            With this on, only a board admin can move a card to Done — from any column, not
            just Review, because a gate that only guarded Review could be walked around by
            skipping it. Agents can still do the work and put it up for approval.
          </span>
        </label>
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
  // Accounts that exist but are not on this board. Empty for a board admin who is not a
  // master admin: who exists is not board-scoped information, so the API withholds it and
  // they add people by username exactly as before.
  const [available, setAvailable] = useState([]);
  const [picked, setPicked] = useState([]);

  const loadAvailable = useCallback(() => {
    api('/settings/users/available')
      .then(d => setAvailable(d.people || []))
      .catch(() => setAvailable([]));   // an older deployment has no such route
  }, [api]);
  useEffect(() => { loadAvailable(); }, [loadAvailable, users.length]);

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

      {available.length > 0 && (
        <section>
          <h3>Add from existing accounts <span>{available.length}</span></h3>
          <p className="hint">
            People who already have an account elsewhere. They join with the password they
            already use, no new one is issued, and they become assignable here straight away.
            They are added as members, never as admins — on a board with the approval gate on,
            admin is the right to mark work done, so that stays a deliberate, separate act.
          </p>
          <div className="picklist">
            {available.map(p2 => (
              <label key={p2.id} className="pick">
                <input type="checkbox" disabled={busy}
                  checked={picked.includes(p2.id)}
                  onChange={e => setPicked(v => e.target.checked
                    ? [...v, p2.id] : v.filter(x => x !== p2.id))} />
                <span className="pn">{p2.displayName}</span>
                <code>@{p2.username}</code>
                <span className="sub">
                  {p2.boards === 0 ? 'on no board yet' : 'on ' + p2.boards + (p2.boards === 1 ? ' board' : ' boards')}
                  {p2.neverSignedIn ? ' · never signed in' : ''}
                </span>
              </label>
            ))}
          </div>
          <button className="btn" disabled={busy || picked.length === 0}
            onClick={() => run(async () => {
              // One request each, in order, so a failure part-way leaves the people before it
              // added rather than rolling back work that succeeded.
              for (const id of picked) {
                const p3 = available.find(x => x.id === id);
                if (p3) await api('/settings/users', 'POST',
                  { username: p3.username, displayName: p3.displayName, isAdmin: false });
              }
              setPicked([]); setIssued(null); loadAvailable();
            })}>
            {busy ? 'Adding…' : picked.length
              ? 'Add ' + picked.length + ' to this board'
              : 'Select someone above'}
          </button>
        </section>
      )}

      <section>
        <h3>Add someone new</h3>
        <p className="hint">
          For somebody with no account yet — this issues a one-time password, shown once.
          If the username already exists they join with the password they already use, and
          no new one is issued.
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

// One identity per agent, so a write can be attributed to one of them rather than to
// whoever happened to be holding the board passphrase. The token is shown once, here.
function Agents({ api }) {
  const [list, setList] = useState(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('write');
  const [issued, setIssued] = useState(null);
  const [confirmGone, setConfirmGone] = useState(null);
  const [hookFor, setHookFor] = useState(null);   // agent id whose webhook is being edited
  const [hookUrl, setHookUrl] = useState('');
  const [hookVerbs, setHookVerbs] = useState('');
  const [hookSecret, setHookSecret] = useState('');
  const [hookAuth, setHookAuth] = useState('signature');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setList(await api('/settings/agents')); }
    catch (e) { setErr(e.message); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setErr(''); setBusy(true);
    try { await fn(); await load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const add = (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    run(async () => {
      const d = await api('/settings/agents', 'POST', { name: name.trim(), scope });
      setIssued({ name: d.agent.name, token: d.token });
      setName(''); setScope('write');
    });
  };

  const rotate = (a) => run(async () => {
    const d = await api('/settings/agents/' + a.id, 'PATCH', { rotate: true });
    setIssued({ name: d.agent.name, token: d.token, rotated: true });
  });

  const toggle = (a) => run(() => api('/settings/agents/' + a.id, 'PATCH', { disabled: !a.disabled }));

  const openHook = (a) => {
    setHookFor(a.id);
    setHookUrl(a.webhookUrl || '');
    setHookVerbs((a.webhookVerbs || []).join(', '));
    // Never prefilled: the board does not hand a signing secret back after the one response
    // that issued it, and a blank box here means "leave whatever key is already set alone".
    setHookSecret('');
    setHookAuth(a.webhookAuth || 'signature');
  };
  const saveHook = (a) => run(async () => {
    const verbs = hookVerbs.split(',').map(v => v.trim()).filter(Boolean);
    const d = await api('/settings/agents/' + a.id, 'PATCH', {
      webhookUrl: hookUrl.trim() || null,
      webhookVerbs: verbs,
      ...(hookSecret.trim() ? { webhookSecret: hookSecret.trim() } : {}),
      webhookAuth: hookAuth,
    });
    if (d.webhookSecret) setIssued({ name: d.agent.name, secret: d.webhookSecret });
    setHookFor(null);
  });
  const setScopeOf = (a, v) => run(() => api('/settings/agents/' + a.id, 'PATCH', { scope: v }));
  // Changing the ceiling also clears the agent's current window server-side, so raising it
  // for an agent that is being throttled right now takes effect immediately rather than at
  // the top of the next minute.
  const setRateOf = (a, v) => run(() => api('/settings/agents/' + a.id, 'PATCH', { rateLimit: v }));
  const remove = (a) => run(async () => {
    await api('/settings/agents/' + a.id, 'DELETE');
    setConfirmGone(null);
  });

  if (!list) return <section><h3>Agents</h3><p className="empty">{err || 'Loading…'}</p></section>;

  return (
    <>
      <section>
        <h3>Agents <span>{list.length}</span></h3>
        <p className="hint">
          Each agent gets its own token. Notes and cards it writes are attributed to its
          name automatically — it cannot sign as anything else. A read-only agent is refused
          every call that changes something, and none of them can see a card marked
          human&nbsp;only.
        </p>
        {err && <div className="err">{err}</div>}

        {list.length === 0 && <p className="empty">No agents yet.</p>}
        {list.length > 0 && (
          <div className="ascroll">
            <table className="atable">
              <thead><tr><th>Name</th><th>Scope</th><th>Writes/min</th><th>Last seen</th><th>Wake</th><th>State</th><th></th></tr></thead>
              <tbody>
                {list.map(a => (
                  <tr key={a.id}>
                    <td><code>{a.name}</code></td>
                    <td>
                      <select value={a.scope} disabled={busy}
                        onChange={e => setScopeOf(a, e.target.value)}>
                        <option value="write">read + write</option>
                        <option value="read">read only</option>
                      </select>
                    </td>
                    <td>
                      {/* A ceiling on writes, not on reads: the events feed exists so an
                          agent need not poll, and throttling that would push it back to
                          re-fetching the whole board. 120 a minute is far above real work
                          and far below a runaway retry loop. */}
                      {/* Keyed on the server's value so the input remounts when that changes:
                          uncontrolled, it would otherwise keep showing a number the PATCH
                          rejected, quietly disagreeing with the board. */}
                      <input type="number" min="1" max="10000" className="num" disabled={busy}
                        key={a.rateLimit ?? 120}
                        defaultValue={a.rateLimit ?? 120} aria-label={'Writes per minute for ' + a.name}
                        onBlur={e => {
                          const v = Number(e.target.value);
                          if (!Number.isInteger(v) || v < 1 || v > 10000 || v === (a.rateLimit ?? 120)) {
                            e.target.value = a.rateLimit ?? 120;
                            return;
                          }
                          setRateOf(a, v);
                        }} />
                    </td>
                    <td>{a.lastSeenAt ? timeAgo(a.lastSeenAt) : 'never'}</td>
                    <td>
                      {a.webhookUrl ? (
                        <>
                          <span className="pill">webhook</span>
                          {a.lastDeliveryStatus && (
                            <span className={'sub' + (/^2/.test(a.lastDeliveryStatus) ? '' : ' hot')}>
                              last {a.lastDeliveryStatus}
                              {a.lastDeliveryAt ? ' · ' + timeAgo(a.lastDeliveryAt) : ''}
                            </span>
                          )}
                        </>
                      ) : <span className="sub">reads the feed</span>}
                    </td>
                    <td className={a.disabled ? '' : 'hot'}>{a.disabled ? 'disabled' : 'active'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="linkbtn" disabled={busy} onClick={() => openHook(a)}>wake</button>{' '}
                      <button className="linkbtn" disabled={busy} onClick={() => rotate(a)}>rotate</button>{' '}
                      <button className="linkbtn" disabled={busy} onClick={() => toggle(a)}>
                        {a.disabled ? 'enable' : 'disable'}
                      </button>{' '}
                      {confirmGone === a.id ? (
                        <>
                          <button className="linkbtn danger" disabled={busy}
                            onClick={() => remove(a)}>delete</button>{' '}
                          <button className="linkbtn" onClick={() => setConfirmGone(null)}>keep</button>
                        </>
                      ) : (
                        <button className="linkbtn" onClick={() => setConfirmGone(a.id)}>remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hookFor != null && (() => {
          const a = list.find(x => x.id === hookFor);
          if (!a) return null;
          return (
            <div className="created">
              <h4 style={{ margin: '0 0 6px' }}>Wake <code>{a.name}</code></h4>
              <p className="hint" style={{ margin: '0 0 10px' }}>
                An https address we POST each matching event to, signed with a secret shown
                once here. Leave the verbs empty to be woken by everything. Delivery is one
                attempt with no retry — the event feed is what catches anything missed.
              </p>
              <div className="aform">
                <label>Webhook URL<input value={hookUrl} placeholder="https://…"
                  onChange={e => setHookUrl(e.target.value)} /></label>
                <label>How the board proves it is the board
                  <select value={hookAuth} onChange={e => setHookAuth(e.target.value)}>
                    <option value="signature">Signature (recommended)</option>
                    <option value="bearer">Authorization: Bearer</option>
                  </select>
                  <span className="sub">
                    Signature sends an HMAC of the body and never puts the key on the wire, so
                    a leaked request reveals nothing reusable. Bearer sends the key itself on
                    every delivery — weaker, and only for a receiver that cannot check
                    signatures. In Bearer mode no signature headers are sent, and the key below
                    must be the receiver&apos;s own: one the board generated would be refused.
                  </span>
                </label>
                <label>{hookAuth === 'bearer' ? 'API key (required)' : 'Signing secret (blank = the board makes one)'}
                  <input value={hookSecret} onChange={e => setHookSecret(e.target.value)}
                    placeholder="paste the receiver's own secret, if it has one"
                    autoComplete="off" spellCheck="false" />
                  <span className="sub">
                    Most receivers accept a secret the board generates. Some — an agent living
                    on someone else&apos;s automation platform, say — have their own and cannot be
                    told to change it. Paste it here and the board signs with that instead.
                    Blank leaves the existing key alone.
                  </span>
                </label>
                <label>Verbs (comma separated, blank = all)<input value={hookVerbs}
                  placeholder="card.moved, note.added"
                  onChange={e => setHookVerbs(e.target.value)} /></label>
                <button className="btn" disabled={busy} onClick={() => saveHook(a)}>Save</button>
                <button className="btn ghost" onClick={() => setHookFor(null)}>Cancel</button>
              </div>
            </div>
          );
        })()}

        {issued && issued.secret && (
          <div className="created">
            Signing secret for <b>{issued.name}</b>: <code>{issued.secret}</code>
            <div className="hint" style={{ margin: '6px 0 0' }}>
              Shown once. Each delivery carries <code>X-Board-Signature: sha256=…</code>, an
              HMAC of the body with this secret — the receiver checks it to know the call
              came from the board.
            </div>
            <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
        )}

        {issued && issued.token && (
          <div className="created">
            Token for <b>{issued.name}</b>{issued.rotated ? ' (rotated — the old one stopped working)' : ''}:{' '}
            <code>{issued.token}</code>
            <div className="hint" style={{ margin: '6px 0 0' }}>
              Shown once. Only its hash is stored, so this cannot be looked up again — if it
              is lost, rotate. Send it through your vault, never pasted into a chat.
            </div>
            <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
        )}
      </section>

      <section>
        <h3>Add an agent</h3>
        <p className="hint">
          The name is used as the note author and is assignable like a person, so keep it
          short and without spaces. Start read-only unless the agent needs to write.
        </p>
        <form className="aform" onSubmit={add}>
          <label>Name<input value={name} placeholder="prospecting"
            onChange={e => setName(e.target.value)} /></label>
          <label>Scope
            <select value={scope} onChange={e => setScope(e.target.value)}>
              <option value="write">read + write</option>
              <option value="read">read only</option>
            </select>
          </label>
          <button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create agent'}</button>
        </form>
      </section>
    </>
  );
}

// Master-admin only. Being one means managing boards, not being on them — so a board you
// have not joined shows a Join button rather than opening.
function Boards({ adminApi, here }) {
  const [boards, setBoards] = useState(null);
  const [mine, setMine] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);   // a one-time secret to show once
  const [form, setForm] = useState({ name: '', slug: '', names: '', tags: '', accent: '#D67D2E' });

  const load = useCallback(() => {
    Promise.all([adminApi('/tenants'), fetch('/api/auth/me').then(r => r.json())])
      .then(([bs, me]) => { setBoards(bs); setMine((me.boards || []).map(b => b.slug)); setErr(''); })
      .catch(e => setErr(e.message));
  }, [adminApi]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setErr(''); setBusy(true);
    try { await fn(); load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const create = (e) => {
    e.preventDefault();
    if (busy) return;
    run(async () => {
      const d = await adminApi('/tenants', 'POST', {
        slug: form.slug.trim(), name: form.name.trim(),
        config: { names: form.names, tags: form.tags, accent: form.accent },
      });
      setIssued({
        kind: 'created', slug: d.tenant.slug, passphrase: d.passphrase, admin: d.admin,
      });
      setForm({ name: '', slug: '', names: '', tags: '', accent: '#D67D2E' });
    });
  };

  const join = (b) => run(() => adminApi('/tenants/' + b.slug + '/join', 'POST'));

  const rotate = (b) => {
    if (!confirm(`Rotate ${b.name}'s passphrase? Any agent using the old one stops working until you update it.`)) return;
    run(async () => {
      const d = await adminApi('/tenants/' + b.slug, 'PATCH', { rotate: true });
      setIssued({ kind: 'rotated', slug: b.slug, passphrase: d.passphrase });
    });
  };

  // Deleting cascades everything on the board. The slug must be typed, and the server
  // requires it back as well — this confirmation is not the only thing standing in the way.
  const remove = (b) => {
    const typed = prompt(
      `This permanently deletes ${b.name} and every card, subtask, link, note and resource on it.\n\n` +
      `This cannot be undone.\n\nType ${b.slug} to confirm:`);
    if (typed !== b.slug) { if (typed !== null) setErr('That did not match — nothing was deleted.'); return; }
    run(async () => {
      const d = await adminApi('/tenants/' + b.slug, 'DELETE', { confirm: b.slug });
      setIssued({ kind: 'deleted', ...d });
    });
  };

  if (err && !boards) return <section><h3>Boards</h3><div className="err">{err}</div></section>;
  if (!boards) return <section><h3>Boards</h3><p className="empty">Loading…</p></section>;

  return (
    <>
      <section>
        <h3>All boards <span>{boards.length}</span></h3>
        <p className="hint">
          You can see and manage every board. Opening one still needs you to be on it, the
          same as anyone else — join a board and you become an admin of it.
        </p>
        {err && <div className="err">{err}</div>}
        <div className="ascroll">
          <table className="atable">
            <thead><tr><th>Board</th><th>People</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {boards.map(b => {
                const joined = mine.includes(b.slug);
                return (
                  <tr key={b.slug}>
                    <td>
                      {joined ? <a href={'/' + b.slug}>{b.name}</a> : b.name}
                      <span className="slug">/{b.slug}</span>
                      {b.slug === here && <span className="slug">you are here</span>}
                    </td>
                    <td>{(b.config?.names || []).length}</td>
                    <td>{new Date(b.created_at).toLocaleDateString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!joined && <button className="linkbtn" disabled={busy} onClick={() => join(b)}>join</button>}
                      <button className="linkbtn" disabled={busy} onClick={() => rotate(b)}>rotate passphrase</button>
                      <button className="linkbtn danger" disabled={busy} onClick={() => remove(b)}>delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {issued && (
          <div className="created">
            {issued.kind === 'created' && (
              <>
                Created <a href={'/' + issued.slug}>/{issued.slug}</a>. Both secrets are shown once.
                <div>Passphrase (for agents): <code>{issued.passphrase}</code></div>
                {issued.admin && (issued.admin.password
                  ? <div>Admin: <code>{issued.admin.username}</code> / <code>{issued.admin.password}</code></div>
                  : <div>Admin is <b>{issued.admin.displayName}</b>, who already had an account.</div>)}
              </>
            )}
            {issued.kind === 'rotated' && (
              <>New passphrase for <b>{issued.slug}</b>, shown once: <code>{issued.passphrase}</code>
                <div className="hint" style={{ margin: '6px 0 0' }}>
                  Update any agent using the old one.
                </div></>
            )}
            {issued.kind === 'deleted' && (
              <>Deleted <b>{issued.deleted.name}</b> — {issued.deleted.cards} cards,{' '}
                {issued.deleted.subtasks} subtasks, {issued.deleted.links} links,{' '}
                {issued.deleted.notes} notes, {issued.deleted.resources} resources,{' '}
                {issued.deleted.people} memberships.
                {issued.accountsRemoved.length > 0 &&
                  <div>Accounts removed with it: {issued.accountsRemoved.join(', ')}</div>}
              </>
            )}
            <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setIssued(null)}>Done</button>
          </div>
        )}
      </section>

      <section>
        <h3>New board</h3>
        <p className="hint">
          The passphrase and the first admin&apos;s password are both shown once, here, and
          never again.
        </p>
        <form className="aform" onSubmit={create}>
          <label>Client name<input required placeholder="JBJ Jeweller"
            value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></label>
          <label>URL slug<input required placeholder="jbj" pattern="[a-z0-9][a-z0-9\-]{1,39}"
            value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} /></label>
          <label>People (comma separated)<input required placeholder="Adi, Rahul"
            value={form.names} onChange={e => setForm(f => ({ ...f, names: e.target.value }))} /></label>
          <label>Tags (optional)<input placeholder="A, B"
            value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} /></label>
          <label>Accent<input type="color"
            value={form.accent} onChange={e => setForm(f => ({ ...f, accent: e.target.value }))} /></label>
          <button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create board'}</button>
        </form>
      </section>
    </>
  );
}

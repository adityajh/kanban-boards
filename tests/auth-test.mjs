// Unit tests for the credential helpers. No database, no server: run with
//   node tests/auth-test.mjs

import assert from 'assert';
import {
  hashPassword, verifyPassword, burnVerify, newPassword, validUsername,
  readCookie, clearSessionCookie, MIN_PASSWORD, publicPerson, SESSION_COOKIE,
} from '../lib/password.mjs';
import { newAgentToken, validAgentName, SCOPES } from '../lib/agent-token.mjs';
import { newWebhookSecret, validWebhookUrl, sign, verifySignature, secretRefusal } from '../lib/webhook-sign.mjs';
import { validateItem, decisionRefusal, findContactDetail, newLogId } from '../lib/tracker.mjs';
import {
  STATUSES, statusRefusal, sameName, identityName, leaseRefusal, claimState, claimRefusal,
  addresseeRefusal, answeredRefusal, defaultAudienceFor, approvalRefusal,
} from '../lib/cards.mjs';
import { rateLimitRefusal, retryAfterSeconds } from '../lib/ratelimit.mjs';
import { splitBlocks, hasDiagram } from '../lib/markup.mjs';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + e.message); }
};

console.log('== password hashing');
const stored = await hashPassword('correct horse battery staple');

await t('stored format is scrypt$N$r$p$salt$hash', () => {
  const p = stored.split('$');
  assert.strictEqual(p.length, 6);
  assert.strictEqual(p[0], 'scrypt');
  assert.strictEqual(p[1], '16384');
  assert.strictEqual(Buffer.from(p[4], 'base64').length, 16, 'salt is 16 bytes');
  assert.strictEqual(Buffer.from(p[5], 'base64').length, 32, 'hash is 32 bytes');
});
await t('correct password verifies', async () =>
  assert.strictEqual(await verifyPassword('correct horse battery staple', stored), true));
await t('wrong password rejected', async () =>
  assert.strictEqual(await verifyPassword('Correct horse battery staple', stored), false));
await t('empty password rejected', async () =>
  assert.strictEqual(await verifyPassword('', stored), false));
await t('salt differs per hash', async () => {
  const a = await hashPassword('same'), b = await hashPassword('same');
  assert.notStrictEqual(a, b, 'two hashes of the same password must differ');
  assert.strictEqual(await verifyPassword('same', a), true);
  assert.strictEqual(await verifyPassword('same', b), true);
});
await t('unicode and long passwords round-trip', async () => {
  const pw = '🔐 pässwörd ' + 'x'.repeat(200);
  assert.strictEqual(await verifyPassword(pw, await hashPassword(pw)), true);
});

console.log('== malformed stored hashes are rejected, never thrown');
for (const [label, bad] of [
  ['empty', ''], ['null', null], ['undefined', undefined],
  ['not scrypt', 'bcrypt$16384$8$1$AAAA$BBBB'],
  ['too few fields', 'scrypt$16384$8$1$AAAA'],
  ['garbage base64', 'scrypt$16384$8$1$!!!!$????'],
  ['absurd cost', 'scrypt$999999999$8$1$AAAA$BBBB'],
  ['zero cost', 'scrypt$0$8$1$AAAA$BBBB'],
]) {
  await t(label + ' -> false', async () =>
    assert.strictEqual(await verifyPassword('x', bad), false));
}

console.log('== timing decoy');
await t('burnVerify resolves false', async () => assert.strictEqual(await burnVerify(), false));
await t('burnVerify costs real work', async () => {
  const t0 = process.hrtime.bigint();
  await burnVerify();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms > 5, `expected a real scrypt round, took ${ms.toFixed(1)}ms`);
});

console.log('== generated passwords');
await t('12 chars, url-safe', () => {
  for (let i = 0; i < 50; i++) {
    const p = newPassword();
    assert.strictEqual(p.length, 12);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(p), 'unexpected char in ' + p);
  }
});
await t('not repeated across 500 draws', () =>
  assert.strictEqual(new Set(Array.from({ length: 500 }, newPassword)).size, 500));
await t('generated password clears MIN_PASSWORD', () =>
  assert.ok(newPassword().length >= MIN_PASSWORD));

console.log('== usernames');
for (const ok of ['adi', 'Adi', 'a1', 'rahul.k', 'a_b-c', 'x'.repeat(32)]) {
  await t(`"${ok}" accepted`, () => assert.strictEqual(validUsername(ok), true));
}
for (const bad of ['a', '', '.adi', '-adi', '_adi', 'adi rahul', 'adi@x.com', 'x'.repeat(33), 'adi/../root']) {
  await t(`"${bad}" rejected`, () => assert.strictEqual(validUsername(bad), false));
}

console.log('== cookie parsing');
const req = (cookie) => ({ headers: { get: (h) => (h === 'cookie' ? cookie : null) } });
await t('reads its own cookie', () =>
  assert.strictEqual(readCookie(req('board_session=abc123'), SESSION_COOKIE), 'abc123'));
await t('reads among others', () =>
  assert.strictEqual(readCookie(req('a=1; board_session=abc123; z=9'), SESSION_COOKIE), 'abc123'));
await t('no cookie header -> null', () =>
  assert.strictEqual(readCookie(req(null), SESSION_COOKIE), null));
await t('absent name -> null', () =>
  assert.strictEqual(readCookie(req('a=1; b=2'), SESSION_COOKIE), null));
await t('does not match a name that merely ends with it', () =>
  assert.strictEqual(readCookie(req('xboard_session=nope'), SESSION_COOKIE), null));
await t('does not match a prefix', () =>
  assert.strictEqual(readCookie(req('board_session_x=nope'), SESSION_COOKIE), null));
await t('url-decodes the value', () =>
  assert.strictEqual(readCookie(req('board_session=a%3Db'), SESSION_COOKIE), 'a=b'));
await t('tolerates a valueless entry', () =>
  assert.strictEqual(readCookie(req('flag; board_session=v'), SESSION_COOKIE), 'v'));

console.log('== cookie attributes');
await t('clear cookie expires immediately', () => {
  const v = clearSessionCookie()['Set-Cookie'];
  assert.ok(v.includes('Max-Age=0'), v);
  assert.ok(v.includes('HttpOnly'), 'must stay HttpOnly');
  assert.ok(v.includes('SameSite=Lax'), 'must stay SameSite=Lax');
});

console.log('== publicPerson never leaks the hash, and carries no admin flag');
await t('no password_hash in output', () => {
  const out = publicPerson({
    id: 1, username: 'adi', display_name: 'Adi',
    must_change: false, password_hash: 'scrypt$...secret',
  });
  assert.deepStrictEqual(Object.keys(out).sort(),
    ['displayName', 'id', 'isMaster', 'mustChange', 'username']);
  assert.ok(!JSON.stringify(out).includes('secret'));
});
await t('isMaster is false unless explicitly true', () => {
  // Master admin can create and delete boards, so it must never be true by accident —
  // a missing column, a row from an older query, or any non-boolean must read as false.
  for (const v of [undefined, null, false, 0, '', 'false', 'true', 1, {}]) {
    assert.strictEqual(
      publicPerson({ id: 1, username: 'a', display_name: 'A', must_change: false, is_master: v }).isMaster,
      false, `is_master=${JSON.stringify(v)} must not grant master`);
  }
  assert.strictEqual(
    publicPerson({ id: 1, username: 'a', display_name: 'A', must_change: false, is_master: true }).isMaster,
    true);
});
await t('admin is never part of a person', () => {
  // Running one board says nothing about any other, so is_admin must come from the
  // membership of the board being acted on, never ride along with the identity.
  const out = publicPerson({
    id: 1, username: 'adi', display_name: 'Adi', must_change: false,
    password_hash: 'x', is_admin: true,
  });
  assert.ok(!('isAdmin' in out), 'publicPerson must not carry is_admin');
});

await t('agent token carries its board and 192 bits of randomness', () => {
  const tok = newAgentToken('zealxle');
  assert.ok(tok.startsWith('agt-zealxle-'), 'token should name its board');
  const rand = tok.slice('agt-zealxle-'.length);
  assert.ok(rand.length >= 32, `random part too short: ${rand.length}`);
  assert.notStrictEqual(newAgentToken('zealxle'), tok, 'tokens must not repeat');
});

await t('agent names stay token-like', () => {
  for (const ok of ['prospecting', 'claude-brain', 'icp.research', 'a1']) {
    assert.ok(validAgentName(ok), `${ok} should be valid`);
  }
  // Spaces and punctuation are refused because the name is also a note author and an
  // assignee: "Research Agent, Claude" in an assignee field is three names or one.
  for (const bad of ['', 'a', 'has space', '-leading', 'what?', 'x'.repeat(41)]) {
    assert.ok(!validAgentName(bad), `${JSON.stringify(bad)} should be rejected`);
  }
});

await t('scopes are exactly read and write', () => {
  assert.deepStrictEqual([...SCOPES].sort(), ['read', 'write']);
});

await t('a webhook signature verifies, and a tampered body does not', () => {
  const secret = newWebhookSecret();
  const body = JSON.stringify({ id: 7, verb: 'card.moved' });
  const h = sign(secret, body);
  assert.ok(h.startsWith('sha256='), 'signature should name its algorithm');
  assert.ok(verifySignature(secret, body, h), 'the real body must verify');
  assert.ok(!verifySignature(secret, body + ' ', h), 'a changed body must not verify');
  assert.ok(!verifySignature(newWebhookSecret(), body, h), 'another secret must not verify');
  assert.ok(!verifySignature(secret, body, ''), 'an absent signature must not verify');
});

await t('a secret the admin supplies signs exactly as a generated one does', () => {
  // The whole point of accepting a receiver's own secret is that nothing else changes: same
  // bytes, same algorithm, same hex digest. If these ever diverged, a receiver told to expect
  // GitHub-style verification would reject every delivery.
  const body = JSON.stringify({ id: 1, verb: 'card.assigned' });
  const theirs = 'whsec_their_own_platform_key_000';
  assert.equal(sign(theirs, body), sign(theirs, body), 'signing must be deterministic');
  assert.ok(sign(theirs, body).startsWith('sha256='), 'signature should name its algorithm');
  assert.ok(verifySignature(theirs, body, sign(theirs, body)), 'a supplied secret must verify');
  assert.ok(!verifySignature(theirs, body, sign(newWebhookSecret(), body)),
    'a different secret must not verify');
});

await t('a supplied webhook secret is refused only when it is unusable', () => {
  // Absent means "leave the existing key alone", which is how the settings form sends a blank
  // box; it must not be read as a request to set an empty secret.
  assert.equal(secretRefusal(undefined), null);
  assert.equal(secretRefusal(null), null);
  assert.equal(secretRefusal(''), null);
  assert.equal(secretRefusal('whsec_a_perfectly_fine_secret'), null);
  assert.equal(secretRefusal('x'.repeat(16)), null, '16 characters is the floor, not below it');
  assert.equal(secretRefusal('x'.repeat(15))?.field, 'webhookSecret');
  assert.equal(secretRefusal('x'.repeat(201))?.field, 'webhookSecret');
  // A secret pasted with a space or newline in it signs fine here and fails at the receiver,
  // which is the hardest kind of mismatch to debug.
  assert.equal(secretRefusal('has a space in it 1234')?.field, 'webhookSecret');
  assert.equal(secretRefusal('trailing_newline_secret\n')?.field, 'webhookSecret');
  assert.equal(secretRefusal('\ttabbed_secret_value_12345')?.field, 'webhookSecret');
});

await t('webhook URLs cannot point inward', () => {
  for (const ok of ['https://example.com/hook', 'https://a.b.co.uk/x?y=1', 'https://1.2.3.4/h']) {
    assert.ok(validWebhookUrl(ok), `${ok} should be allowed`);
  }
  // The board makes this request itself, so an address that resolves to the machine or to
  // a private network turns an agent's config into server-side request forgery.
  for (const bad of [
    'http://example.com/hook', 'https://localhost/h', 'https://127.0.0.1/h',
    'https://10.0.0.5/h', 'https://192.168.1.1/h', 'https://169.254.169.254/latest/meta-data',
    'https://172.16.0.1/h', 'ftp://example.com', 'not a url', '',
  ]) {
    assert.ok(!validWebhookUrl(bad), `${JSON.stringify(bad)} should be refused`);
  }
});

await t('the plan refuses what it cannot interpret', () => {
  assert.strictEqual(validateItem('status', { title: 'x', lane: 'now' }), null);
  assert.strictEqual(validateItem('status', { title: 'x', lane: 'nowish' }).field, 'lane');
  assert.strictEqual(validateItem('status', { lane: 'now' }).field, 'title');
  assert.strictEqual(validateItem('status', { title: 'x', lane: 'now', nope: 1 }).field, 'nope');
  assert.strictEqual(validateItem('milestone', { title: 'x', date: 'soon' }).field, 'date');
  assert.strictEqual(validateItem('decision', { title: 'x', state: 'decided', ref: 'http://x.com' }).field, 'ref');
  assert.strictEqual(validateItem('log', { text: 'y'.repeat(1201) }).field, 'text');
  assert.strictEqual(validateItem('actual', { as_of: '2026-11-30' }).field, 'source');
});

await t('an actual is keyed by the metrics its board declares', () => {
  const keys = ['contacted', 'enrolled'];
  const ok = { as_of: '2026-11-30', source: 'CRM', values: { contacted: 400, enrolled: null } };
  assert.strictEqual(validateItem('actual', ok, { metricKeys: keys }), null);
  // This is what stops the app being tied to one funnel: a board that does not track a
  // metric cannot have numbers filed under it.
  const wrong = { as_of: '2026-11-30', source: 'CRM', values: { installs: 10 } };
  assert.strictEqual(validateItem('actual', wrong, { metricKeys: keys }).field, 'values.installs');
  const nan = { as_of: '2026-11-30', source: 'CRM', values: { contacted: 'lots' } };
  assert.strictEqual(validateItem('actual', nan, { metricKeys: keys }).field, 'values.contacted');
});

await t('contact details are refused wherever they appear', () => {
  assert.ok(findContactDetail('write to me at adi@example.com'));
  assert.ok(findContactDetail('call 9876543210 tomorrow'));
  assert.ok(!findContactDetail('about 1,100 contacted by May'));
  assert.ok(!findContactDetail('ref D-07, decided 22 Oct'));
  const bad = validateItem('status', { title: 'x', lane: 'now', detail: 'ping adi@example.com' });
  assert.strictEqual(bad.field, 'detail');
});

await t('an agent may propose a decision and never settle one', () => {
  const agent = { agent: { id: 1, name: 'grok' } };
  const member = { person: { id: 2, display_name: 'Akshay', is_master: false } };
  const master = { person: { id: 3, display_name: 'Adi', is_master: true } };
  const key = { admin: true };
  assert.strictEqual(decisionRefusal('decision', { state: 'proposed' }, agent), null);
  assert.ok(decisionRefusal('decision', { state: 'decided' }, agent));
  assert.ok(decisionRefusal('decision', { state: 'superseded' }, agent));
  assert.ok(decisionRefusal('decision', { state: 'decided' }, member));
  assert.strictEqual(decisionRefusal('decision', { state: 'decided' }, master), null);
  assert.strictEqual(decisionRefusal('decision', { state: 'decided' }, key), null);
  // Only decisions are policed; a status moving to done is nobody's permission question.
  assert.strictEqual(decisionRefusal('status', { lane: 'done' }, agent), null);
});

await t('log ids sort by when they were made', () => {
  const a = newLogId(1000000, () => 0.1);
  const b = newLogId(2000000, () => 0.1);
  assert.ok(a < b, `${a} should sort before ${b}`);
  assert.notStrictEqual(newLogId(1000000, () => 0.1), newLogId(1000000, () => 0.9));
});

console.log('== card statuses');
await t('the five statuses are in board order', () => {
  // The order is the column order on the board, so reordering this array silently
  // rearranges every board; it has to be pinned, not just the membership.
  assert.deepStrictEqual(STATUSES, ['todo', 'in_progress', 'stuck', 'review', 'done']);
});
await t('every valid status is accepted, and absent means leave it alone', () => {
  for (const s of STATUSES) assert.strictEqual(statusRefusal(s), null, s);
  for (const v of [null, undefined, '']) {
    assert.strictEqual(statusRefusal(v), null, `${JSON.stringify(v)} must not be refused`);
  }
});
await t('an invented status is refused and the refusal names the five', () => {
  // Case matters: 'Done' renders in no column, so it is a lost card rather than a misfiled one.
  for (const bad of ['Done', 'in progress', 'archived', 'TODO']) {
    const r = statusRefusal(bad);
    assert.ok(r, `${bad} should be refused`);
    assert.strictEqual(r.field, 'status');
    for (const s of STATUSES) assert.ok(r.error.includes(s), `refusal for ${bad} should name ${s}`);
  }
});

console.log('== names and identity');
await t('names compare case-insensitively and ignore surrounding space', () => {
  assert.strictEqual(sameName('Adi', 'adi'), true);
  assert.strictEqual(sameName(' adi ', 'Adi'), true);
  assert.strictEqual(sameName('Adi', 'Aditya'), false);
});
await t('a missing name is never the same as anything', () => {
  // Two absent names must not match each other, or an unnamed caller would "hold" every
  // card whose holder was never recorded.
  for (const v of [null, '', undefined]) {
    assert.strictEqual(sameName('Adi', v), false);
    assert.strictEqual(sameName(v, 'Adi'), false);
    assert.strictEqual(sameName(v, v), false);
  }
});
await t('only a person or an agent has a name to hold work under', () => {
  // This decides who may hold a claim, so the nulls are the cases that matter: a shared
  // board passphrase and ADMIN_KEY are nobody, and must not be handed a name.
  assert.strictEqual(identityName({ person: { id: 2, display_name: 'Akshay' } }), 'Akshay');
  assert.strictEqual(identityName({ agent: { id: 1, name: 'grok' } }), 'grok');
  assert.strictEqual(identityName({ admin: true }), null);
  assert.strictEqual(identityName({}), null);
});

console.log('== claims are leases');
await t('lease length must be a whole number of minutes from 1 to 480', () => {
  for (const ok of [undefined, null, '', 1, 30, 480]) {
    assert.strictEqual(leaseRefusal(ok), null, `${JSON.stringify(ok)} should be allowed`);
  }
  for (const bad of [0, -5, 481, 1.5, 'thirty', NaN, Infinity]) {
    const r = leaseRefusal(bad);
    assert.ok(r, `${String(bad)} should be refused`);
    assert.strictEqual(r.field, 'minutes');
  }
});
const NOW = Date.parse('2026-11-25T12:00:00Z');
const FUTURE = '2026-11-25T12:30:00Z';
const PAST = '2026-11-25T11:30:00Z';
await t('an unclaimed card has no claim', () => {
  assert.strictEqual(claimState({}, NOW), null);
  assert.strictEqual(claimState({ claimed_by: null, claim_expires_at: FUTURE }, NOW), null);
  assert.strictEqual(claimState(null, NOW), null);
});
await t('an expired lease is not a claim', () => {
  // This is the whole design: a crashed agent's claim must stop mattering on its own, with
  // no timer to clean it up, so the expiry has to be tested explicitly.
  assert.strictEqual(claimState({ claimed_by: 'grok', claim_expires_at: PAST }, NOW), null);
});
await t('a claim with no usable expiry is not a claim', () => {
  // A holder with no readable end time would otherwise be a lock nobody can ever release.
  assert.strictEqual(claimState({ claimed_by: 'grok' }, NOW), null);
  assert.strictEqual(claimState({ claimed_by: 'grok', claim_expires_at: 'soonish' }, NOW), null);
});
await t('a live lease reports its holder and expiry', () => {
  assert.deepStrictEqual(
    claimState({ claimed_by: 'grok', claim_expires_at: FUTURE }, NOW),
    { by: 'grok', until: FUTURE });
});
await t('a card is free to claim unless somebody else holds a live lease', () => {
  const live = { claimed_by: 'Grok', claim_expires_at: FUTURE };
  assert.strictEqual(claimRefusal({}, 'adi', NOW), null);
  // Extending your own lease must work, and a name typed in another case is still you.
  assert.strictEqual(claimRefusal(live, 'grok', NOW), null);
  const r = claimRefusal(live, 'adi', NOW);
  assert.strictEqual(typeof r, 'string');
  assert.ok(r.includes('Grok'), 'the refusal should name the holder: ' + r);
  assert.strictEqual(claimRefusal({ claimed_by: 'Grok', claim_expires_at: PAST }, 'adi', NOW), null);
});

console.log('== addressing and the answered flag');
await t('an addressee is one short name or nothing', () => {
  for (const ok of [null, undefined, '', 'Akshay', 'claude-brain']) {
    assert.strictEqual(addresseeRefusal(ok), null, `${JSON.stringify(ok)} should be allowed`);
  }
  for (const bad of ['   ', 'x'.repeat(121), 'Adi\nRahul', 'Adi\rRahul']) {
    const r = addresseeRefusal(bad);
    assert.ok(r, `${JSON.stringify(bad)} should be refused`);
    assert.strictEqual(r.field, 'to');
  }
  assert.strictEqual(addresseeRefusal('x'.repeat(120)), null);
});
await t('contact details cannot reach the board through an addressee', () => {
  // The check itself lives in findContactDetail; this pins that addressing actually uses it.
  assert.strictEqual(addresseeRefusal('adi@example.com').field, 'to');
  assert.strictEqual(addresseeRefusal('9876543210').field, 'to');
});
await t('answered is a person\'s boolean and nobody else\'s', () => {
  const person = { person: { id: 2, display_name: 'Akshay' } };
  const agent = { agent: { name: 'X' } };
  assert.strictEqual(answeredRefusal(null, person), null);
  assert.strictEqual(answeredRefusal(undefined, agent), null);
  assert.strictEqual(answeredRefusal(true, person), null);
  assert.strictEqual(answeredRefusal(false, person), null);
  // An agent maintaining the flag would drift on it, so even a legal value is refused.
  assert.strictEqual(answeredRefusal(true, agent).field, 'answered');
  for (const bad of ['yes', 1, {}]) {
    assert.strictEqual(answeredRefusal(bad, person).field, 'answered', JSON.stringify(bad));
  }
});

console.log('== audience default for new cards');
await t('a person\'s cards are visible to both, whatever the board says', () => {
  const person = { person: { id: 2, display_name: 'Akshay' } };
  assert.strictEqual(defaultAudienceFor(person, null), 'both');
  assert.strictEqual(defaultAudienceFor(person, { config: { agentCardsDefault: 'agent_only' } }), 'both');
});
await t('an agent\'s cards stay agent_only unless the board opts in to both', () => {
  const agent = { agent: { name: 'grok' } };
  assert.strictEqual(defaultAudienceFor(agent, null), 'agent_only');
  assert.strictEqual(defaultAudienceFor(agent, {}), 'agent_only');
  assert.strictEqual(defaultAudienceFor(agent, { config: {} }), 'agent_only');
  // An unknown value falls back to the private default rather than being stored as-is.
  assert.strictEqual(defaultAudienceFor(agent, { config: { agentCardsDefault: 'everyone' } }), 'agent_only');
  assert.strictEqual(defaultAudienceFor(agent, { config: { agentCardsDefault: 'both' } }), 'both');
  assert.strictEqual(defaultAudienceFor(agent, { config: { agentCardsDefault: 'agent_only' } }), 'agent_only');
});

console.log('== markup blocks');
await t('no text means no blocks', () => {
  assert.deepStrictEqual(splitBlocks(''), []);
  assert.deepStrictEqual(splitBlocks(null), []);
  assert.deepStrictEqual(splitBlocks(undefined), []);
});
await t('plain prose is one text block, intact', () => {
  assert.deepStrictEqual(splitBlocks('first line\nsecond line'),
    [{ kind: 'text', value: 'first line\nsecond line' }]);
});
await t('prose, a diagram and prose come back as three blocks in order', () => {
  const src = 'flowchart TD\n  A --> B\n    B --> C';
  const blocks = splitBlocks('before\n```mermaid\n' + src + '\n```\nafter');
  assert.deepStrictEqual(blocks, [
    { kind: 'text', value: 'before' },
    { kind: 'diagram', value: src },
    { kind: 'text', value: 'after' },
  ]);
});
await t('an unclosed fence still yields its diagram', () => {
  // Forgetting the closing ticks must not cost somebody the diagram they drew.
  assert.deepStrictEqual(splitBlocks('intro\n```mermaid\nA --> B'), [
    { kind: 'text', value: 'intro' },
    { kind: 'diagram', value: 'A --> B' },
  ]);
});
await t('an empty fence yields no diagram', () => {
  assert.deepStrictEqual(splitBlocks('```mermaid\n```'), []);
  assert.strictEqual(hasDiagram('```mermaid\n```'), false);
});
await t('the fence opener ignores case and surrounding whitespace', () => {
  // The opener regex also allows space between the ticks and the word, so '``` mermaid'
  // is a diagram too; that is the real behaviour, pinned here.
  for (const opener of ['```Mermaid', '  ``` mermaid  ', '```MERMAID', '```mermaid']) {
    assert.deepStrictEqual(splitBlocks(opener + '\nA --> B\n```'),
      [{ kind: 'diagram', value: 'A --> B' }], JSON.stringify(opener));
  }
});
await t('a fence of another language stays text', () => {
  const src = '```js\nconst a = 1;\n```';
  assert.deepStrictEqual(splitBlocks(src), [{ kind: 'text', value: src }]);
  assert.strictEqual(hasDiagram(src), false);
});
await t('hasDiagram is true only when a diagram is present', () => {
  assert.strictEqual(hasDiagram('just words'), false);
  assert.strictEqual(hasDiagram('words\n```mermaid\nA --> B\n```'), true);
});

console.log('== per-agent write limit');
await t('an absent limit means "leave it alone", not an error', () => {
  assert.strictEqual(rateLimitRefusal(undefined), null);
  assert.strictEqual(rateLimitRefusal(null), null);
  assert.strictEqual(rateLimitRefusal(''), null);
});
await t('a whole number from 1 to 10000 is accepted', () => {
  for (const n of [1, 120, 10000]) assert.strictEqual(rateLimitRefusal(n), null, String(n));
});
await t('anything else is refused, and the refusal names the field', () => {
  for (const bad of [0, -1, 10001, 1.5, 'five', NaN, Infinity, true, {}]) {
    const r = rateLimitRefusal(bad);
    assert.ok(r, `${String(bad)} should be refused`);
    assert.strictEqual(r.field, 'rateLimit');
    assert.strictEqual(typeof r.error, 'string');
  }
});
await t('a numeric string is refused rather than coerced', () => {
  assert.ok(rateLimitRefusal('5'));
});
await t('retryAfterSeconds counts down the rest of the minute window', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.strictEqual(retryAfterSeconds(new Date(now - 10000), now), 50);
  assert.strictEqual(retryAfterSeconds(new Date(now), now), 60);
});
await t('retryAfterSeconds rounds up, and never returns 0', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.strictEqual(retryAfterSeconds(new Date(now - 59500), now), 1);
  assert.strictEqual(retryAfterSeconds(new Date(now - 59000), now), 1);
  assert.strictEqual(retryAfterSeconds(new Date(now - 60000), now), 1);
  assert.strictEqual(retryAfterSeconds(new Date(now - 10500), now), 50);
});
await t('a window that is already over still answers 1', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.strictEqual(retryAfterSeconds(new Date(now - 120000), now), 1);
});
await t('retryAfterSeconds accepts a Date or an ISO string', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const start = new Date(now - 10000);
  assert.strictEqual(retryAfterSeconds(start.toISOString(), now), 50);
  assert.strictEqual(retryAfterSeconds(start, now), retryAfterSeconds(start.toISOString(), now));
});
await t('an unreadable window start answers 1 rather than NaN', () => {
  assert.strictEqual(retryAfterSeconds('not a date', Date.parse('2026-01-01T12:00:00Z')), 1);
});

console.log('== approval gate on marking work done');
const callers = {
  agent: { agent: { id: 1, name: 'grok' } },
  masterKey: { admin: true },
  boardAdmin: { memberAdmin: true },
  person: { person: { id: 2, display_name: 'X' } },
  passphrase: {},
};
await t('a board that has not opted in never refuses, for any caller', () => {
  const ungated = [null, undefined, {}, { config: {} }, { config: { reviewGate: false } }];
  for (const tenant of ungated) {
    for (const [who, c] of Object.entries(callers)) {
      for (const status of ['done', 'review', 'todo']) {
        assert.strictEqual(approvalRefusal(status, tenant, c), null,
          `${JSON.stringify(tenant)} / ${who} / ${status}`);
      }
    }
  }
});
await t('only the boolean true opts in', () => {
  assert.strictEqual(approvalRefusal('done', { config: { reviewGate: 'true' } }, callers.agent), null);
  assert.strictEqual(approvalRefusal('done', { config: { reviewGate: 1 } }, callers.agent), null);
});
const gated = { config: { reviewGate: true } };
await t('on a gated board, every status but done is open to everyone', () => {
  for (const status of ['review', 'todo', 'in_progress', 'stuck']) {
    for (const [who, c] of Object.entries(callers)) {
      assert.strictEqual(approvalRefusal(status, gated, c), null, `${who} / ${status}`);
    }
  }
});
await t('on a gated board, an agent is refused done with a sentence', () => {
  const r = approvalRefusal('done', gated, callers.agent);
  assert.strictEqual(typeof r, 'string');
  assert.ok(r.length > 0);
});
await t('on a gated board, the master key and a board admin may mark done', () => {
  assert.strictEqual(approvalRefusal('done', gated, callers.masterKey), null);
  assert.strictEqual(approvalRefusal('done', gated, callers.boardAdmin), null);
});
await t('on a gated board, a plain person and a passphrase are refused done', () => {
  assert.strictEqual(typeof approvalRefusal('done', gated, callers.person), 'string');
  assert.strictEqual(typeof approvalRefusal('done', gated, callers.passphrase), 'string');
});
await t('an agent is refused even if it carries an admin flag', () => {
  assert.strictEqual(typeof approvalRefusal('done', gated, { agent: { name: 'g' }, admin: true }), 'string');
});
await t('a missing caller does not throw', () => {
  assert.doesNotThrow(() => approvalRefusal('done', gated, undefined));
  assert.strictEqual(typeof approvalRefusal('done', gated, undefined), 'string');
  assert.strictEqual(approvalRefusal('done', {}, undefined), null);
});

console.log(`\npassed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);

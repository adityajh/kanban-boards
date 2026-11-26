// Unit tests for the credential helpers. No database, no server: run with
//   node tests/auth-test.mjs

import assert from 'assert';
import {
  hashPassword, verifyPassword, burnVerify, newPassword, validUsername,
  readCookie, clearSessionCookie, MIN_PASSWORD, publicPerson, SESSION_COOKIE,
} from '../lib/password.mjs';
import { newAgentToken, validAgentName, SCOPES } from '../lib/agent-token.mjs';
import { newWebhookSecret, validWebhookUrl, sign, verifySignature, secretRefusal, webhookAuthRefusal, WEBHOOK_AUTH } from '../lib/webhook-sign.mjs';
import { validateItem, decisionRefusal, findContactDetail, newLogId } from '../lib/tracker.mjs';
import {
  STATUSES, statusRefusal, sameName, identityName, leaseRefusal, claimState, claimRefusal,
  addresseeRefusal, answeredRefusal, isAgentWork, approvalRefusal,
} from '../lib/cards.mjs';
import { rateLimitRefusal, retryAfterSeconds } from '../lib/ratelimit.mjs';
import { splitBlocks, hasDiagram } from '../lib/markup.mjs';
import {
  slugifySection, withSectionIds, findSection, sectionRefusal, applySectionPatch,
  moveSection, metricKeyRefusal, validSectionId, SECTION_FIELDS,
  periodRefusal, applyPeriodPatch, findPeriod, planPeriods, PERIOD_FIELDS,
} from '../lib/plan-sections.mjs';

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

await t('webhook auth mode is refused unless it is exactly one of the two', () => {
  // Absent or blank means "leave it alone", as for the secret above.
  assert.equal(webhookAuthRefusal(undefined), null);
  assert.equal(webhookAuthRefusal(null), null);
  assert.equal(webhookAuthRefusal(''), null);
  assert.deepEqual(WEBHOOK_AUTH, ['signature', 'bearer']);
  assert.equal(webhookAuthRefusal('signature'), null);
  assert.equal(webhookAuthRefusal('bearer'), null);
  // No case folding and no aliases: a mode that is guessed at is a delivery that is
  // authenticated differently from what the admin thought they chose.
  for (const bad of ['Bearer', 'none', 'hmac', 123, {}]) {
    assert.equal(webhookAuthRefusal(bad)?.field, 'webhookAuth', `${JSON.stringify(bad)} should be refused`);
  }
  assert.equal(webhookAuthRefusal('none').error, 'webhookAuth must be signature or bearer');
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

// Changed on 26 Nov. This used to assert that an agent may propose a decision and never
// settle one, and that only a master admin could. Adi settled it the other way: agents may
// decide, and one that would rather somebody else took the call assigns a card instead.
// Lifting it for agents took the rationale out from under the master-admin gate too, so
// one rule now covers every caller — be somebody who can be asked about it later.
await t('anyone who can be named may settle a decision', () => {
  const agent = { agent: { id: 1, name: 'grok' } };
  const member = { person: { id: 2, display_name: 'Akshay', is_master: false } };
  const master = { person: { id: 3, display_name: 'Adi', is_master: true } };
  const key = { admin: true };
  for (const who of [agent, member, master, key]) {
    assert.strictEqual(decisionRefusal('decision', { state: 'proposed' }, who), null);
    assert.strictEqual(decisionRefusal('decision', { state: 'decided' }, who), null);
    assert.strictEqual(decisionRefusal('decision', { state: 'superseded' }, who), null);
  }
  // Only decisions are policed; a status moving to done is nobody's permission question.
  assert.strictEqual(decisionRefusal('status', { lane: 'done' }, agent), null);
});

await t('a board passphrase cannot settle a decision, because it names nobody', () => {
  const passphrase = { admin: false, person: null, agent: null };
  assert.strictEqual(decisionRefusal('decision', { state: 'proposed' }, passphrase), null);
  assert.ok(decisionRefusal('decision', { state: 'decided' }, passphrase));
  assert.ok(decisionRefusal('decision', { state: 'superseded' }, passphrase));
  assert.match(decisionRefusal('decision', { state: 'decided' }, passphrase), /names nobody/);
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
await t('agent work is decided by the assignee, not by who made the card', () => {
  // The whole point of 015: a card an agent created and handed to a person is that person's
  // work. Under the old stored flag it stayed branded as agent work for ever.
  const agents = ['AdiGrok', 'AdiClaude'];
  assert.equal(isAgentWork({ assignee: 'AdiGrok' }, agents), true);
  assert.equal(isAgentWork({ assignee: 'Gargi' }, agents), false);
  // Case and stray spacing are how a name typed by a person and a name sent by an agent
  // usually differ, and neither should change the answer.
  assert.equal(isAgentWork({ assignee: '  adiclaude ' }, agents), true);
  assert.equal(isAgentWork({ assignee: 'ADIGROK' }, agents), true);
});

await t('nothing is agent work when there is nobody to attribute it to', () => {
  const agents = ['AdiGrok'];
  // Unassigned work belongs to everybody, so it must never be filtered out of the board.
  assert.equal(isAgentWork({ assignee: 'Unassigned' }, agents), false);
  assert.equal(isAgentWork({ assignee: '' }, agents), false);
  assert.equal(isAgentWork({ assignee: null }, agents), false);
  assert.equal(isAgentWork({}, agents), false);
  // A board with no agents has no agent work, whatever its cards say.
  assert.equal(isAgentWork({ assignee: 'AdiGrok' }, []), false);
  assert.equal(isAgentWork({ assignee: 'AdiGrok' }), false);
  // And a missing card does not throw: the board calls this while it is still loading.
  assert.equal(isAgentWork(null, agents), false);
});

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
  boardAdmin: { person: { id: 3, display_name: 'Y' }, memberAdmin: true },
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
await t('on a gated board, a plain person may mark done (011 refused them; 014 does not)', () => {
  assert.strictEqual(approvalRefusal('done', gated, callers.person), null);
});
await t('on a gated board, a passphrase is refused done', () => {
  assert.strictEqual(typeof approvalRefusal('done', gated, callers.passphrase), 'string');
});
await t('an agent is refused even if it carries an admin flag', () => {
  assert.strictEqual(typeof approvalRefusal('done', gated, { agent: { name: 'g' }, admin: true }), 'string');
});
await t('an agent is refused even if it carries a person', () => {
  assert.strictEqual(typeof approvalRefusal('done', gated, { agent: { name: 'g' }, person: { display_name: 'Gargi' } }), 'string');
});

console.log('== approval gate: who may finish (migration 014)');
await t('an ordinary member is allowed done, where 011 refused them', () => {
  assert.strictEqual(approvalRefusal('done', gated, { person: { display_name: 'Gargi' } }), null);
  assert.strictEqual(approvalRefusal('done', gated, { person: { display_name: 'Gargi' }, memberAdmin: false }), null);
});
await t('a board admin who is a person is allowed done', () => {
  assert.strictEqual(approvalRefusal('done', gated, { person: { display_name: 'Gargi' }, memberAdmin: true }), null);
});
await t('an agent with mayFinish true is allowed done', () => {
  assert.strictEqual(approvalRefusal('done', gated, { agent: { id: 1, name: 'grok', mayFinish: true } }), null);
});
await t('the same agent without mayFinish is refused, with a sentence that says what to do', () => {
  const r = approvalRefusal('done', gated, { agent: { id: 1, name: 'grok', mayFinish: false } });
  assert.strictEqual(typeof r, 'string');
  assert.ok(r.includes('review'), r);
  assert.strictEqual(typeof approvalRefusal('done', gated, { agent: { id: 1, name: 'grok' } }), 'string');
});
await t('mayFinish must be strictly true: a string, a number or null grants nothing', () => {
  for (const v of ['true', 1, 'yes', {}, [], null, undefined]) {
    assert.strictEqual(typeof approvalRefusal('done', gated, { agent: { name: 'grok', mayFinish: v } }), 'string', JSON.stringify(v));
  }
});
await t('mayFinish does not change any status an agent was already free to use', () => {
  for (const status of ['review', 'todo', 'in_progress', 'stuck']) {
    assert.strictEqual(approvalRefusal(status, gated, { agent: { name: 'grok', mayFinish: false } }), null, status);
  }
});
await t('a board passphrase ({}) is refused even though it is not an agent', () => {
  const r = approvalRefusal('done', gated, {});
  assert.strictEqual(typeof r, 'string');
  assert.ok(r.includes('passphrase'), r);
});
await t('ADMIN_KEY is allowed done', () => {
  assert.strictEqual(approvalRefusal('done', gated, { admin: true }), null);
});
await t('gate absent, false or the string "true" is null for every caller type', () => {
  const every = [
    { agent: { name: 'a', mayFinish: false } }, { agent: { name: 'a', mayFinish: true } },
    { person: { display_name: 'Gargi' } }, { person: { display_name: 'Gargi' }, memberAdmin: true },
    { admin: true }, {}, undefined,
  ];
  for (const tenant of [{}, { config: {} }, { config: { reviewGate: false } }, { config: { reviewGate: 'true' } }]) {
    for (const c of every) {
      assert.strictEqual(approvalRefusal('done', tenant, c), null, `${JSON.stringify(tenant)} / ${JSON.stringify(c)}`);
    }
  }
});
await t('c undefined does not throw, for a gated board and a status that is not done', () => {
  assert.doesNotThrow(() => approvalRefusal('done', gated, undefined));
  assert.doesNotThrow(() => approvalRefusal('done', gated, null));
  assert.strictEqual(approvalRefusal('review', gated, undefined), null);
});
await t('a missing caller does not throw', () => {
  assert.doesNotThrow(() => approvalRefusal('done', gated, undefined));
  assert.strictEqual(typeof approvalRefusal('done', gated, undefined), 'string');
  assert.strictEqual(approvalRefusal('done', {}, undefined), null);
});

console.log('== plan sections have ids (migration 017)');

// The seven live counsellor sections and the four on /platform, as they stood before 017.
const LIVE = ['Two ways in, one way through', 'Phases', 'The math', 'Ground rules',
  'Where each thing lives', 'People and agents', 'Snapshots'];

await t('ids come from titles, and match what the migration computed', () => {
  const ids = withSectionIds({ sections: LIVE.map((title) => ({ title })) })
    .sections.map((s) => s.id);
  assert.deepStrictEqual(ids, ['two-ways-in-one-way-through', 'phases', 'the-math',
    'ground-rules', 'where-each-thing-lives', 'people-and-agents', 'snapshots']);
  for (const id of ids) assert.ok(validSectionId(id), `${id} is a usable id`);
});

await t('assigning ids is idempotent', () => {
  const once = withSectionIds({ sections: LIVE.map((title) => ({ title })) });
  assert.deepStrictEqual(withSectionIds(once), once);
});

await t('an id never follows its title', () => {
  // The whole point of an id: cards, history and an agent's last read point at it, so
  // renaming the section must not move the target.
  const renamed = withSectionIds({ sections: [{ id: 'the-math', title: 'The arithmetic' }] });
  assert.strictEqual(renamed.sections[0].id, 'the-math');
});

await t('duplicate titles get readable suffixes, not random ones', () => {
  const ids = withSectionIds({ sections: [{ title: 'Ground rules' }, { title: 'Ground rules' },
    { title: 'Ground rules' }] }).sections.map((s) => s.id);
  assert.deepStrictEqual(ids, ['ground-rules', 'ground-rules-2', 'ground-rules-3']);
});

await t('a title with nothing sluggable still gets an id', () => {
  const ids = withSectionIds({ sections: [{}, { title: '!!!' }, { title: '   ' },
    { title: '—' }] }).sections.map((s) => s.id);
  assert.deepStrictEqual(ids, ['section', 'section-2', 'section-3', 'section-4']);
});

await t('a duplicate id in stored config is reassigned rather than left ambiguous', () => {
  const ids = withSectionIds({ sections: [{ id: 'dup', title: 'One' }, { id: 'dup', title: 'Two' }] })
    .sections.map((s) => s.id);
  assert.strictEqual(ids[0], 'dup');
  assert.notStrictEqual(ids[1], 'dup');
});

await t('ids are capped so they stay usable in a URL', () => {
  const id = slugifySection('A very long section title that simply keeps going and going and going');
  assert.ok(id.length <= 40, `${id} is ${id.length} chars`);
  assert.ok(!id.endsWith('-'), 'no trailing dash after the cut');
});

await t('a section is found case-insensitively, like every other id', () => {
  const plan = withSectionIds({ sections: LIVE.map((title) => ({ title })) });
  assert.strictEqual(findSection(plan, 'GROUND-RULES').index, 3);
  assert.strictEqual(findSection(plan, 'ground-rules').index, 3);
  assert.strictEqual(findSection(plan, 'no-such-section'), null);
  assert.strictEqual(findSection({}, 'ground-rules'), null);
});

console.log('== what a section edit may carry');

await t('an unknown field is refused rather than silently stored', () => {
  // A field outside the list would be written and never rendered, which is worse than a 422.
  assert.strictEqual(sectionRefusal({ title: 'X' }), null);
  assert.strictEqual(sectionRefusal({ nope: 1 }).field, 'nope');
  assert.strictEqual(sectionRefusal({ diagramDocs: 'typo' }).field, 'diagramDocs');
  // Every declared field is accepted when given a value of the right shape, so the list in
  // the module and the validation below it cannot drift apart.
  const sample = { bullets: ['a'], links: [{ label: 'x' }], columns: ['a'], rows: [{ a: 1 }] };
  for (const f of SECTION_FIELDS) {
    assert.strictEqual(sectionRefusal({ [f]: f in sample ? sample[f] : 'x' }), null,
      `${f} should be accepted`);
  }
});

await t('an id cannot be changed through an edit', () => {
  assert.strictEqual(sectionRefusal({ id: 'something-else' }).field, 'id');
});

await t('a title cannot be emptied, but may be changed', () => {
  assert.strictEqual(sectionRefusal({ title: '   ' }).field, 'title');
  assert.strictEqual(sectionRefusal({ title: 'The arithmetic' }), null);
  // Adding a section is not a partial patch, so a missing title is refused there.
  assert.strictEqual(sectionRefusal({ note: 'x' }, { partial: false }).field, 'title');
  assert.strictEqual(sectionRefusal({ note: 'x' }), null);
});

await t('lists must be lists, and rows must be objects', () => {
  assert.strictEqual(sectionRefusal({ bullets: 'not a list' }).field, 'bullets');
  assert.strictEqual(sectionRefusal({ rows: ['a string'] }).field, 'rows');
  assert.strictEqual(sectionRefusal({ rows: [{ who: 'Gargi' }] }), null);
  assert.strictEqual(sectionRefusal({ rows: Array(201).fill({ a: 1 }) }).field, 'rows');
  assert.strictEqual(sectionRefusal({ note: 42 }).field, 'note');
});

await t('contact details are caught wherever they are nested', () => {
  const find = findContactDetail;
  // The likely hiding place is a table cell, not the title.
  assert.ok(sectionRefusal({ rows: [{ who: 'Gargi', reach: 'gargi@example.com' }] }, { findContact: find }));
  assert.ok(sectionRefusal({ bullets: ['call 9876543210'] }, { findContact: find }));
  assert.ok(sectionRefusal({ title: 'Ring 9876543210' }, { findContact: find }));
  assert.strictEqual(sectionRefusal({ rows: [{ target: '1,100 by May' }] }, { findContact: find }), null);
});

await t('a patch merges, a null clears, and arrays replace', () => {
  const was = { id: 'the-math', title: 'The math', note: 'n', rows: [{ a: 1 }, { a: 2 }] };
  assert.deepStrictEqual(applySectionPatch(was, { title: 'The arithmetic' }),
    { id: 'the-math', title: 'The arithmetic', note: 'n', rows: [{ a: 1 }, { a: 2 }] });
  assert.ok(!('note' in applySectionPatch(was, { note: null })));
  // Three rows means three rows, not three appended to the two already there.
  assert.deepStrictEqual(applySectionPatch(was, { rows: [{ b: 1 }] }).rows, [{ b: 1 }]);
  assert.strictEqual(applySectionPatch(was, { id: 'hijacked' }).id, 'the-math');
});

await t('moving a section clamps rather than refusing', () => {
  const s = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepStrictEqual(moveSection(s, 2, 0).map((x) => x.id), ['c', 'a', 'b']);
  assert.deepStrictEqual(moveSection(s, 0, 99).map((x) => x.id), ['b', 'c', 'a']);
  assert.deepStrictEqual(moveSection(s, 0, -5).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(moveSection(s, 9, 0).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(s.map((x) => x.id), ['a', 'b', 'c'], 'the input is not mutated');
});

console.log('== the metric guard is about the data, not the caller');

// The one refusal in this slice that applies to a master admin exactly as it does to an
// agent. A key with numbers filed against it cannot be renamed or dropped, because those
// numbers do not move with it — they stay in the table pointing at a definition that is
// gone, which is the one change the config history cannot undo cleanly.
const FUNNEL = { metrics: [{ key: 'contacted' }, { key: 'engaged' }, { key: 'attended' }] };

await t('a board with no actuals recorded can change anything', () => {
  assert.strictEqual(metricKeyRefusal(FUNNEL, []), null);
  assert.strictEqual(metricKeyRefusal({ metrics: [] }, []), null);
});

await t('a key with no actuals may be renamed or dropped freely', () => {
  // This is the live case: counsellor's three webinar metrics have no numbers yet, so they
  // are still being designed and the guard must stay out of the way.
  assert.strictEqual(metricKeyRefusal({ metrics: [{ key: 'contacted' }, { key: 'engaged' }] },
    ['contacted', 'engaged']), null);
});

await t('a key with actuals cannot be dropped', () => {
  const r = metricKeyRefusal({ metrics: [{ key: 'engaged' }] }, ['contacted', 'engaged']);
  assert.ok(r, 'refused');
  assert.match(r, /^contacted:/, 'names the key that would be orphaned');
});

await t('a key with actuals cannot be renamed, which is a drop plus an add', () => {
  assert.ok(metricKeyRefusal({ metrics: [{ key: 'contacted_v2' }, { key: 'engaged' }] },
    ['contacted', 'engaged']));
});

await t('a label may change; only the key is load-bearing', () => {
  assert.strictEqual(metricKeyRefusal(
    { metrics: [{ key: 'contacted', label: 'Reached out to' }] }, ['contacted'],
  ), null);
});

await t('every orphaned key is named, not just the first', () => {
  const r = metricKeyRefusal({ metrics: [] }, ['contacted', 'engaged']);
  assert.match(r, /contacted/);
  assert.match(r, /engaged/);
  assert.match(r, /these metrics have/, 'reads correctly in the plural');
  assert.match(metricKeyRefusal({ metrics: [] }, ['contacted']), /this metric has/);
});

await t('a plan with no metrics at all orphans everything recorded', () => {
  // The revert case: going back to a version that predates a metric.
  assert.ok(metricKeyRefusal({}, ['contacted']));
  assert.ok(metricKeyRefusal(null, ['contacted']));
});

console.log('== periods: the month is open, the numbers are not');

// Adding a period was master-admin-only along with the rest of the plan config, which
// blocked an agent every month on a calendar fact. A period with no targets asserts
// nothing; a target is what an actual is judged against. So the split runs between them,
// and `targets` being refused to the wrong caller is a 403 decided in the route — these
// checks cover what is VALID, which is a different question.
const METRICS = ['contacted', 'engaged', 'enrolled'];

await t('a period needs an id when it is being created', () => {
  assert.strictEqual(periodRefusal({ id: '2026-12' }, { partial: false }), null);
  assert.strictEqual(periodRefusal({}, { partial: false }).field, 'id');
  assert.strictEqual(periodRefusal({ label: 'Dec 2026' }, { partial: false }).field, 'id');
});

await t('an id must be usable, and ids like 2026-11 are the point', () => {
  for (const id of ['2026-11', '6-dec', 'q1', 'fy2027.h1']) {
    assert.strictEqual(periodRefusal({ id }, { partial: false }), null, id);
  }
  for (const id of ['', '  ', 'has space', '-leading', 'a'.repeat(65)]) {
    assert.strictEqual(periodRefusal({ id }, { partial: false }).field, 'id', id);
  }
});

await t('a period id is never reused, and never changed afterwards', () => {
  const taken = ['2026-11', '2026-12'];
  assert.ok(periodRefusal({ id: '2026-11' }, { partial: false, taken }));
  assert.match(periodRefusal({ id: '2026-11' }, { partial: false, taken }).error, /already has a period/);
  assert.strictEqual(periodRefusal({ id: '2026-11' }, { partial: false, taken: [] }), null);
  // Case-insensitively, like every other id on the board.
  assert.ok(periodRefusal({ id: 'Q1' }, { partial: false, taken: ['q1'] }));
  // And an edit cannot move it, because the actuals filed against it point at the id.
  assert.strictEqual(periodRefusal({ id: '2027-01' }).field, 'id');
});

await t('an unknown field is refused rather than stored', () => {
  assert.strictEqual(periodRefusal({ target: 500 }).field, 'target');
  assert.strictEqual(periodRefusal({ note: 'x' }).field, 'note');
  for (const f of PERIOD_FIELDS) {
    assert.strictEqual(periodRefusal({ [f]: f === 'targets' ? {} : 'x' }), null, f);
  }
});

await t('a label is text, or null to clear it', () => {
  assert.strictEqual(periodRefusal({ label: 'End of May' }), null);
  assert.strictEqual(periodRefusal({ label: null }), null);
  assert.strictEqual(periodRefusal({ label: 42 }).field, 'label');
});

await t('a target must name a metric this board tracks', () => {
  const o = { metricKeys: METRICS };
  assert.strictEqual(periodRefusal({ targets: { contacted: 400, enrolled: 2 } }, o), null);
  assert.strictEqual(periodRefusal({ targets: { installs: 400 } }, o).field, 'targets.installs');
  assert.match(periodRefusal({ targets: { installs: 1 } }, o).error, /does not track/);
  // A board that declares no metrics is not yet checkable, so nothing is refused on that
  // ground — the same latitude metricKeys(null) gives an actual.
  assert.strictEqual(periodRefusal({ targets: { anything: 1 } }, {}), null);
});

await t('a target is a number, or null for "not set yet"', () => {
  const o = { metricKeys: METRICS };
  assert.strictEqual(periodRefusal({ targets: { contacted: 0 } }, o), null);
  assert.strictEqual(periodRefusal({ targets: { contacted: null } }, o), null);
  assert.strictEqual(periodRefusal({ targets: { contacted: '400' } }, o).field, 'targets.contacted');
  assert.strictEqual(periodRefusal({ targets: { contacted: NaN } }, o).field, 'targets.contacted');
  assert.strictEqual(periodRefusal({ targets: [400] }, o).field, 'targets');
  assert.strictEqual(periodRefusal({ targets: 'lots' }, o).field, 'targets');
  assert.strictEqual(periodRefusal({ targets: null }, o), null, 'null clears them all');
});

await t('contact details cannot reach the board through a period', () => {
  assert.ok(periodRefusal({ label: 'ask adi@example.com' }, { findContact: findContactDetail }));
  assert.strictEqual(periodRefusal({ label: 'End of May 2027' }, { findContact: findContactDetail }), null);
});

await t('targets MERGE, where a section\'s arrays replace', () => {
  // Setting one target must not silently drop the others: an agent told to update the
  // webinar number has no business clearing the funnel.
  const was = { id: '2026-12', label: 'Dec', targets: { contacted: 400, enrolled: 2 } };
  assert.deepStrictEqual(applyPeriodPatch(was, { targets: { enrolled: 5 } }).targets,
    { contacted: 400, enrolled: 5 });
  assert.deepStrictEqual(applyPeriodPatch(was, { label: 'December' }).targets,
    { contacted: 400, enrolled: 2 });
  assert.ok(!('label' in applyPeriodPatch(was, { label: null })));
  assert.ok(!('targets' in applyPeriodPatch(was, { targets: null })), 'null drops them wholesale');
  assert.strictEqual(applyPeriodPatch(was, { id: 'hijacked' }).id, '2026-12');
});

await t('periods are found by id, case-insensitively, and absent is null', () => {
  const plan = { periods: [{ id: '2026-11' }, { id: 'Q1' }] };
  assert.strictEqual(findPeriod(plan, '2026-11').index, 0);
  assert.strictEqual(findPeriod(plan, 'q1').index, 1);
  assert.strictEqual(findPeriod(plan, '2027-01'), null);
  assert.strictEqual(findPeriod({}, 'q1'), null);
  assert.deepStrictEqual(planPeriods({}), []);
  assert.deepStrictEqual(planPeriods(null), []);
});

console.log(`\npassed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);

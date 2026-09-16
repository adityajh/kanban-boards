// Unit tests for the credential helpers. No database, no server: run with
//   node tests/auth-test.mjs

import assert from 'assert';
import {
  hashPassword, verifyPassword, burnVerify, newPassword, validUsername,
  readCookie, clearSessionCookie, MIN_PASSWORD, publicUser, SESSION_COOKIE,
} from '../lib/password.mjs';

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

console.log('== publicUser never leaks the hash');
await t('no password_hash in output', () => {
  const out = publicUser({
    id: 1, tenant_id: 1, username: 'adi', display_name: 'Adi',
    is_admin: true, must_change: false, password_hash: 'scrypt$...secret',
  });
  assert.deepStrictEqual(Object.keys(out).sort(), ['displayName', 'id', 'isAdmin', 'mustChange', 'username']);
  assert.ok(!JSON.stringify(out).includes('secret'));
});

console.log(`\npassed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);

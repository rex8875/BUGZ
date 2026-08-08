const test = require('node:test');
const assert = require('node:assert/strict');
const { installDiscordRoleMock, withDiscordRoles } = require('./discordRoleMock');

// These guard against a real bug found via stress-testing: the original
// implementation saved/restored a single shared `global.fetch` slot,
// which only worked under strict LIFO nesting. Under genuine concurrency
// (e.g. Promise.all of several withDiscordRoles calls that don't finish
// in reverse-install order), one instance's restore() could silently
// clobber another still-active instance's mock mid-flight, or leave
// global.fetch permanently pointed at a dead mock instead of the true
// original. Fixed via AsyncLocalStorage so each call chain stays
// correctly isolated regardless of install/restore order. Nothing in
// production ever monkey-patches a shared global like this — this only
// protects test infrastructure — but it's cheap to guarantee.

test('two withDiscordRoles calls running concurrently stay isolated even when the "later" one finishes first', async () => {
  const results = {};
  const pSlow = withDiscordRoles({ u1: ['roleA'] }, async () => {
    await new Promise((r) => setTimeout(r, 15)); // deliberately outlives the other
    const res = await global.fetch('https://discord.com/api/v10/guilds/g/members/u1');
    results.slow = await res.json();
  });
  const pFast = withDiscordRoles({ u2: ['roleB'] }, async () => {
    const res = await global.fetch('https://discord.com/api/v10/guilds/g/members/u2');
    results.fast = await res.json();
  });
  await Promise.all([pFast, pSlow]);
  assert.deepEqual(results.slow.roles, ['roleA'], 'the slower call must still see its own mock, not get clobbered by the faster one finishing first');
  assert.deepEqual(results.fast.roles, ['roleB']);
});

test('many concurrent withDiscordRoles calls (20+) never cross-contaminate, regardless of finish order', async () => {
  const N = 25;
  const runs = Array.from({ length: N }, (_, i) =>
    withDiscordRoles({ [`user${i}`]: [`role${i}`] }, async () => {
      // Stagger completion order deliberately (reverse of install order).
      await new Promise((r) => setTimeout(r, (N - i) % 7));
      const res = await global.fetch(`https://discord.com/api/v10/guilds/g/members/user${i}`);
      const body = await res.json();
      return { i, roles: body.roles };
    }),
  );
  const results = await Promise.all(runs);
  for (const { i, roles } of results) {
    assert.deepEqual(roles, [`role${i}`], `call ${i} must see exactly its own mocked role, never another instance's`);
  }
});

test('global.fetch is correctly restored to the true original after all concurrent mocks complete, even with out-of-order finishes', async () => {
  const trueOriginal = global.fetch;
  await Promise.all([
    withDiscordRoles({ a: ['x'] }, () => new Promise((r) => setTimeout(r, 10))),
    withDiscordRoles({ b: ['y'] }, () => new Promise((r) => setTimeout(r, 1))),
    withDiscordRoles({ c: ['z'] }, () => new Promise((r) => setTimeout(r, 5))),
  ]);
  assert.equal(global.fetch, trueOriginal, 'after every concurrent mock has completed, the real fetch must be back in place');
});

test('installDiscordRoleMock manual API still works for the sequential nested pattern used throughout the rest of the suite', async () => {
  const mockA = installDiscordRoleMock();
  mockA.setMemberRoles('u1', ['roleA']);
  const mockB = installDiscordRoleMock();
  mockB.setMemberRoles('u2', ['roleB']);

  const resB = await global.fetch('https://discord.com/api/v10/guilds/g/members/u2');
  assert.deepEqual((await resB.json()).roles, ['roleB']);
  mockB.restore();

  const resA = await global.fetch('https://discord.com/api/v10/guilds/g/members/u1');
  assert.deepEqual((await resA.json()).roles, ['roleA'], 'restoring the inner mock should hand control back to the still-active outer mock');
  mockA.restore();
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

test('getUserTheme defaults to "ink" for a verified user who has never set one', async () => {
  const { db } = loadDbWithFakePrisma();
  await db.verifyUser({ discordId: 'u1', discordUsername: 'Rex' });

  assert.equal(await db.getUserTheme('u1'), 'ink');
});

test('getUserTheme defaults to "ink" for someone with no User row at all, rather than throwing', async () => {
  const { db } = loadDbWithFakePrisma();
  assert.equal(await db.getUserTheme('never-verified'), 'ink');
});

test('setUserTheme saves the choice, and getUserTheme reflects it afterward', async () => {
  const { db } = loadDbWithFakePrisma();
  await db.verifyUser({ discordId: 'u1', discordUsername: 'Rex' });

  await db.setUserTheme('u1', 'aurora');
  assert.equal(await db.getUserTheme('u1'), 'aurora');

  await db.setUserTheme('u1', 'glass');
  assert.equal(await db.getUserTheme('u1'), 'glass', 'switching again should overwrite, not add to, the saved choice');
});

test('setUserTheme rejects a value that is not one of the real themes', async () => {
  const { db } = loadDbWithFakePrisma();
  await db.verifyUser({ discordId: 'u1', discordUsername: 'Rex' });

  await assert.rejects(() => db.setUserTheme('u1', 'not-a-real-theme'), /recognized theme/);
  assert.equal(await db.getUserTheme('u1'), 'ink', 'a rejected value must not partially apply');
});

test('theme is per-user — setting one person\'s theme never touches another\'s', async () => {
  const { db } = loadDbWithFakePrisma();
  await db.verifyUser({ discordId: 'u1', discordUsername: 'Rex' });
  await db.verifyUser({ discordId: 'u2', discordUsername: 'Someone Else' });

  await db.setUserTheme('u1', 'cyber');

  assert.equal(await db.getUserTheme('u1'), 'cyber');
  assert.equal(await db.getUserTheme('u2'), 'ink', "u2's theme must be untouched by u1's choice");
});

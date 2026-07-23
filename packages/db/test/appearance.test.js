const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

async function setupServer(db) {
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });
  const testerRole = (await db.listRoles(server.id)).find((r) => r.name === 'Tester');
  await db.grantRole({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', roleId: testerRole.id });
  return { server };
}

test('createServerOnJoin stores the Discord guild icon URL', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({
    discordServerId: 'g-icon',
    name: 'Iconic',
    ownerDiscordId: 'owner1',
    iconUrl: 'https://cdn.discordapp.com/icons/g-icon/abc123.png',
  });
  assert.equal(server.iconUrl, 'https://cdn.discordapp.com/icons/g-icon/abc123.png');
});

test('re-registering a guild (reconciliation) refreshes the icon URL if it changed', async () => {
  const { db } = loadDbWithFakePrisma();
  await db.createServerOnJoin({ discordServerId: 'g2', name: 'Test', ownerDiscordId: 'owner1', iconUrl: 'https://old.png' });
  const updated = await db.createServerOnJoin({ discordServerId: 'g2', name: 'Test', ownerDiscordId: 'owner1', iconUrl: 'https://new.png' });
  assert.equal(updated.iconUrl, 'https://new.png');
});

test('an owner (canManageSettings) can set a valid hex background', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const updated = await db.updateServerAppearance({ serverId: server.id, actingDiscordId: 'owner1', backgroundStyle: '#1a1f2b' });
  assert.equal(updated.backgroundStyle, '#1a1f2b');
});

test('an owner can set a valid 2-color gradient background', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const updated = await db.updateServerAppearance({
    serverId: server.id,
    actingDiscordId: 'owner1',
    backgroundStyle: 'linear-gradient(135deg, #1a1f2b, #2d3a66)',
  });
  assert.equal(updated.backgroundStyle, 'linear-gradient(135deg, #1a1f2b, #2d3a66)');
});

test('a Tester (no canManageSettings) cannot set the background', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await assert.rejects(
    () => db.updateServerAppearance({ serverId: server.id, actingDiscordId: 'tester1', backgroundStyle: '#123456' }),
    /not permitted/i,
  );
});

test('setting the background to null clears it back to default', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  await db.updateServerAppearance({ serverId: server.id, actingDiscordId: 'owner1', backgroundStyle: '#123456' });
  const cleared = await db.updateServerAppearance({ serverId: server.id, actingDiscordId: 'owner1', backgroundStyle: null });
  assert.equal(cleared.backgroundStyle, null);
});

test('rejects an arbitrary CSS/JS injection attempt disguised as a background value', async () => {
  const { db } = loadDbWithFakePrisma();
  const { server } = await setupServer(db);
  const malicious = [
    'red; } body { display: none',
    'url(javascript:alert(1))',
    '#123456"><script>alert(1)</script>',
    'linear-gradient(45deg, red, blue, green)', // 3 stops, not the supported 2-stop shape
    'radial-gradient(#123456, #654321)',
    'not-a-color',
  ];
  for (const value of malicious) {
    await assert.rejects(
      () => db.updateServerAppearance({ serverId: server.id, actingDiscordId: 'owner1', backgroundStyle: value }),
      new RegExp('.*'),
      `should have rejected: ${value}`,
    );
  }
});

test('isValidBackgroundStyle accepts 3-digit and 6-digit hex, and rejects out-of-range gradient angles', () => {
  const { db } = loadDbWithFakePrisma();
  assert.equal(db.isValidBackgroundStyle('#abc'), true);
  assert.equal(db.isValidBackgroundStyle('#aabbcc'), true);
  assert.equal(db.isValidBackgroundStyle('linear-gradient(0deg, #fff, #000)'), true);
  assert.equal(db.isValidBackgroundStyle('linear-gradient(360deg, #fff, #000)'), true);
  assert.equal(db.isValidBackgroundStyle('linear-gradient(361deg, #fff, #000)'), false);
});

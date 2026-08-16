const test = require('node:test');
const assert = require('node:assert/strict');

function loadCommandWithFakeDb(commandFile) {
  const { createFakePrismaClient } = require('../../../packages/db/test/helpers/fakePrismaClient');
  const fakeClient = createFakePrismaClient();
  const prismaClientPath = require.resolve('@prisma/client');
  const originalPrismaCache = require.cache[prismaClientPath];
  require.cache[prismaClientPath] = { id: prismaClientPath, filename: prismaClientPath, loaded: true, exports: { PrismaClient: function () { return fakeClient; } } };
  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  delete require.cache[dbModulePath];
  const cmdPath = require.resolve(`../src/commands/${commandFile}`);
  delete require.cache[cmdPath];
  const cmd = require(cmdPath);
  const dbModule = require(dbModulePath);
  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];
  return { cmd, dbModule, dbModulePath, originalDbCache };
}

async function withCommand(commandFile, fn) {
  const { cmd, dbModule, dbModulePath, originalDbCache } = loadCommandWithFakeDb(commandFile);
  try {
    await fn(cmd, dbModule);
  } finally {
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
}

function fakeInteraction(overrides) {
  const interaction = {
    guildId: 'guild-1',
    reply: async (payload) => { interaction._reply = payload; },
    ...overrides,
  };
  return interaction;
}

test('/verify replies with a Discord-auth link button and never touches the database', async () => {
  await withCommand('verify.js', async (cmd) => {
    process.env.WEB_BASE_URL = 'https://example.test';
    const interaction = fakeInteraction({ user: { id: 'u1' } });
    await cmd.execute(interaction);

    assert.match(interaction._reply.content, /confirm your Discord identity/i);
    assert.ok(interaction._reply.components?.[0], 'should include the verify button row');
    assert.equal(interaction._reply.ephemeral, true);
  });
});

test('/dashboard: unset-up server gets a clear message instead of a broken link', async () => {
  await withCommand('dashboard.js', async (cmd) => {
    const interaction = fakeInteraction({ user: { id: 'u1' } });
    await cmd.execute(interaction);
    assert.match(interaction._reply.content, /not set up yet/i);
  });
});

test('/dashboard: set-up server gets a working link scoped to that server\'s id', async () => {
  await withCommand('dashboard.js', async (cmd, dbModule) => {
    process.env.WEB_BASE_URL = 'https://example.test';
    const server = await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    const interaction = fakeInteraction({ user: { id: 'owner1' } });
    await cmd.execute(interaction);
    assert.match(interaction._reply.content, new RegExp(`/dashboard/${server.id}`));
    assert.equal(interaction._reply.ephemeral, true);
  });
});

test('/transfer-ownership: succeeds for the current owner and hands off correctly', async () => {
  await withCommand('transfer-ownership.js', async (cmd, dbModule) => {
    await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'newowner', discordUsername: 'NewOwner' });

    const interaction = fakeInteraction({
      user: { id: 'owner1' },
      options: { getUser: () => ({ id: 'newowner', username: 'NewOwner' }) },
    });
    await cmd.execute(interaction);

    assert.match(interaction._reply.content, /ownership transferred to NewOwner/i);
    const server = await dbModule.getServerByDiscordId('guild-1');
    assert.equal(server.ownerDiscordId, 'newowner');
  });
});

test('/transfer-ownership: rejected for a non-owner, with the DB error surfaced as the reply', async () => {
  await withCommand('transfer-ownership.js', async (cmd, dbModule) => {
    await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'rando', discordUsername: 'Rando' });
    await dbModule.verifyUser({ discordId: 'target', discordUsername: 'Target' });

    const interaction = fakeInteraction({
      user: { id: 'rando' },
      options: { getUser: () => ({ id: 'target', username: 'Target' }) },
    });
    await cmd.execute(interaction);

    assert.match(interaction._reply.content, /only the current owner/i);
    const server = await dbModule.getServerByDiscordId('guild-1');
    assert.equal(server.ownerDiscordId, 'owner1', 'ownership must not have changed');
  });
});

test('/reset-score: resets to zero and is logged to the audit trail', async () => {
  await withCommand('reset-score.js', async (cmd, dbModule) => {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });
    await dbModule.adjustPointsManually({ serverId: server.id, actingDiscordId: 'owner1', targetDiscordId: 'tester1', delta: 5 });

    const interaction = fakeInteraction({
      user: { id: 'owner1' },
      options: { getUser: () => ({ id: 'tester1', username: 'Tester' }) },
    });
    await cmd.execute(interaction);

    assert.match(interaction._reply.content, /Reset Tester's leaderboard score to 0/);
    const log = await dbModule.listAuditLog(server.id);
    assert.ok(log.some((e) => e.action === 'SCORE_RESET'), 'reset-score should be audit logged');
  });
});

test('/set-tester-role, /set-retest-channel, /set-announce-channel each save the right field and confirm it back', async () => {
  await withCommand('set-tester-role.js', async (cmd, dbModule) => {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    const interaction = fakeInteraction({
      user: { id: 'owner1' },
      options: { getRole: () => ({ id: 'role-x', toString: () => '<@&role-x>' }) },
    });
    await cmd.execute(interaction);
    assert.match(interaction._reply.content, /Ping testers.*will now ping/i);
    assert.equal((await dbModule.getServerByDiscordId('guild-1')).testerPingRoleId, 'role-x');
  });

  await withCommand('set-retest-channel.js', async (cmd, dbModule) => {
    await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    const interaction = fakeInteraction({
      user: { id: 'owner1' },
      options: { getChannel: () => ({ id: 'chan-x', toString: () => '<#chan-x>' }) },
    });
    await cmd.execute(interaction);
    assert.match(interaction._reply.content, /Retest channel set/i);
    assert.equal((await dbModule.getServerByDiscordId('guild-1')).retestChannelId, 'chan-x');
  });

  await withCommand('set-announce-channel.js', async (cmd, dbModule) => {
    await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    const interaction = fakeInteraction({
      user: { id: 'owner1' },
      options: { getChannel: () => ({ id: 'chan-y', toString: () => '<#chan-y>' }) },
    });
    await cmd.execute(interaction);
    assert.match(interaction._reply.content, /announcements will now post/i);
    assert.equal((await dbModule.getServerByDiscordId('guild-1')).announceChannelId, 'chan-y');
  });
});

test('/create-prompt: without canManageSettings, refuses and never posts to the channel', async () => {
  await withCommand('create-prompt.js', async (cmd, dbModule) => {
    await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'rando', discordUsername: 'Rando' });

    let sent = false;
    const interaction = fakeInteraction({
      user: { id: 'rando' },
      channel: { send: async () => { sent = true; } },
    });
    await cmd.execute(interaction);

    assert.match(interaction._reply.content, /don't have permission/i);
    assert.equal(sent, false, 'the button embed must never post without permission');
  });
});

test('/create-prompt: with permission, posts the report-bug button to the channel and confirms with a separate ephemeral reply', async () => {
  await withCommand('create-prompt.js', async (cmd, dbModule) => {
    await dbModule.createServerOnJoin({ discordServerId: 'guild-1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });

    let channelPayload = null;
    const interaction = fakeInteraction({
      user: { id: 'owner1' },
      channel: { send: async (payload) => { channelPayload = payload; } },
    });
    await cmd.execute(interaction);

    assert.ok(channelPayload, 'should post to the channel, not just reply');
    assert.equal(channelPayload.embeds[0].data.title, 'Report a bug');
    assert.ok(channelPayload.components[0], 'should include the report-bug button');
    assert.equal(interaction._reply.content, 'Posted.');
    assert.equal(interaction._reply.ephemeral, true, 'the confirmation should be ephemeral — only the poster sees it, not a second public message');
  });
});

test('the settings commands all give the same clear "not set up yet" message on a guild with no server row', async () => {
  for (const file of ['transfer-ownership.js', 'reset-score.js', 'set-tester-role.js', 'set-retest-channel.js', 'set-announce-channel.js']) {
    await withCommand(file, async (cmd) => {
      const interaction = fakeInteraction({
        user: { id: 'u1' },
        options: { getUser: () => ({ id: 'x', username: 'x' }), getRole: () => ({ id: 'x' }), getChannel: () => ({ id: 'x' }) },
      });
      await cmd.execute(interaction);
      assert.match(interaction._reply.content, /not set up yet/i, `${file} should reply with the standard message`);
    });
  }
});

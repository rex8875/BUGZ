const test = require('node:test');
const assert = require('node:assert/strict');

function withMockedFetch(responses, fn) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    const response = responses[calls.length - 1] || { id: 'msg-or-thread-id' };
    return { ok: true, status: 200, json: async () => response };
  };
  return fn(calls).finally(() => {
    global.fetch = realFetch;
  });
}

test('postRetestMessage pings the configured tester role, with allowed_mentions explicitly permitting it', async () => {
  delete require.cache[require.resolve('../src/lib/discordRest')];
  const { postRetestMessage } = require('../src/lib/discordRest');

  await withMockedFetch(
    [{ id: 'message-1' }, { id: 'thread-1' }],
    async (calls) => {
      await postRetestMessage({
        channelId: 'chan-1',
        report: { title: 't', description: 'd', status: 'FIXED', priority: 'HIGH', device: 'PC', reporter: { discordId: 'reporter-1' } },
        ping: true,
        testerPingRoleId: 'role-1',
      });

      const messageCall = calls[0];
      assert.equal(messageCall.body.content, '<@&role-1>', 'should mention the role, not the individual reporter, when a role is configured');
      assert.deepEqual(
        messageCall.body.allowed_mentions.roles,
        ['role-1'],
        'must explicitly allow the role mention — Discord does not ping roles by default just because they appear in content',
      );
    },
  );
});

test('postRetestMessage falls back to mentioning the individual reporter when no tester role is configured', async () => {
  delete require.cache[require.resolve('../src/lib/discordRest')];
  const { postRetestMessage } = require('../src/lib/discordRest');

  await withMockedFetch([{ id: 'message-1' }, { id: 'thread-1' }], async (calls) => {
    await postRetestMessage({
      channelId: 'chan-1',
      report: { title: 't', description: 'd', status: 'FIXED', priority: 'HIGH', device: 'PC', reporter: { discordId: 'reporter-1' } },
      ping: true,
      testerPingRoleId: null,
    });

    assert.equal(calls[0].body.content, '<@reporter-1>');
    assert.deepEqual(calls[0].body.allowed_mentions.roles, [], 'no role to allow when falling back to a user mention');
  });
});

test('postRetestMessage sends no mention at all when ping is false ("Post in retested")', async () => {
  delete require.cache[require.resolve('../src/lib/discordRest')];
  const { postRetestMessage } = require('../src/lib/discordRest');

  await withMockedFetch([{ id: 'message-1' }, { id: 'thread-1' }], async (calls) => {
    await postRetestMessage({
      channelId: 'chan-1',
      report: { id: 'r0', serverId: 's0', title: 't', description: 'd', status: 'FIXED', priority: 'HIGH', device: 'PC', reporter: { discordId: 'reporter-1' } },
      ping: false,
      testerPingRoleId: 'role-1',
    });

    assert.equal(calls[0].body.content, undefined);
    assert.equal(calls[0].body.allowed_mentions, undefined);
  });
});

test('postRetestMessage embeds a clickable link to a readable view of the report, and shows who triggered it', async () => {
  delete require.cache[require.resolve('../src/lib/discordRest')];
  const { postRetestMessage } = require('../src/lib/discordRest');

  const realBaseUrl = process.env.WEB_BASE_URL;
  process.env.WEB_BASE_URL = 'https://bugz.example.com';
  try {
    await withMockedFetch([{ id: 'message-1' }, { id: 'thread-1' }], async (calls) => {
      await postRetestMessage({
        channelId: 'chan-1',
        report: {
          id: 'report-42',
          serverId: 'server-9',
          title: 'Floor breaks',
          description: 'd',
          status: 'FIXED',
          priority: 'HIGH',
          device: 'PC',
          reporter: { discordId: 'reporter-1' },
        },
        ping: true,
        testerPingRoleId: 'role-1',
        triggeredByDiscordId: 'dev-1',
      });

      const embed = calls[0].body.embeds[0];
      assert.equal(embed.url, 'https://bugz.example.com/r/report-42', 'embed title should link to the public readable view of this exact report');

      const triggeredByField = embed.fields.find((f) => f.name === 'Triggered by');
      assert.ok(triggeredByField, 'must include a Triggered by field');
      assert.equal(triggeredByField.value, '<@dev-1>');
    });
  } finally {
    process.env.WEB_BASE_URL = realBaseUrl;
  }
});

test('postRetestMessage shows "Unknown" for Triggered by if somehow not provided, rather than crashing', async () => {
  delete require.cache[require.resolve('../src/lib/discordRest')];
  const { postRetestMessage } = require('../src/lib/discordRest');

  await withMockedFetch([{ id: 'message-1' }, { id: 'thread-1' }], async (calls) => {
    await postRetestMessage({
      channelId: 'chan-1',
      report: { id: 'r1', serverId: 's1', title: 't', description: 'd', status: 'FIXED', priority: 'HIGH', device: 'PC', reporter: { discordId: 'reporter-1' } },
      ping: false,
      testerPingRoleId: null,
    });

    const triggeredByField = calls[0].body.embeds[0].fields.find((f) => f.name === 'Triggered by');
    assert.equal(triggeredByField.value, 'Unknown');
  });
});

test('listGuildRoles fetches from the correct Discord endpoint for the given guild', async () => {
  delete require.cache[require.resolve('../src/lib/discordRest')];
  const { listGuildRoles } = require('../src/lib/discordRest');

  await withMockedFetch(
    [[{ id: 'role-1', name: 'QA Lead', color: 0xff0000, position: 3 }, { id: 'role-2', name: '@everyone', color: 0, position: 0 }]],
    async (calls) => {
      const roles = await listGuildRoles('guild-123');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://discord.com/api/v10/guilds/guild-123/roles');
      assert.equal(roles.length, 2);
      assert.equal(roles[0].name, 'QA Lead');
    },
  );
});

test('listApplicationCommands fetches from the correct Discord endpoint using DISCORD_CLIENT_ID', async () => {
  delete require.cache[require.resolve('../src/lib/discordRest')];
  const { listApplicationCommands } = require('../src/lib/discordRest');

  const realClientId = process.env.DISCORD_CLIENT_ID;
  process.env.DISCORD_CLIENT_ID = 'app-999';
  try {
    await withMockedFetch([[{ name: 'reset-score', description: "Reset someone's score" }]], async (calls) => {
      const commands = await listApplicationCommands();
      assert.equal(calls[0].url, 'https://discord.com/api/v10/applications/app-999/commands');
      assert.equal(commands[0].name, 'reset-score');
    });
  } finally {
    process.env.DISCORD_CLIENT_ID = realClientId;
  }
});

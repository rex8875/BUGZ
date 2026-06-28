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
      report: { title: 't', description: 'd', status: 'FIXED', priority: 'HIGH', device: 'PC', reporter: { discordId: 'reporter-1' } },
      ping: false,
      testerPingRoleId: 'role-1',
    });

    assert.equal(calls[0].body.content, undefined);
    assert.equal(calls[0].body.allowed_mentions, undefined);
  });
});

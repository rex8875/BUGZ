const test = require('node:test');
const assert = require('node:assert/strict');
const { ordinal, postNewReportAnnouncement } = require('../src/lib/announcements');

test('ordinal formats numbers correctly, including the 11/12/13 exception', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(22), '22nd');
  assert.equal(ordinal(23), '23rd');
  assert.equal(ordinal(111), '111th');
  assert.equal(ordinal(101), '101st');
});

test('postNewReportAnnouncement does nothing (no channel fetch) when no channel is configured', async () => {
  let fetchCalled = false;
  const fakeClient = { channels: { fetch: async () => { fetchCalled = true; } } };
  const result = await postNewReportAnnouncement({
    client: fakeClient,
    channelId: null,
    report: { id: 'r1' },
    reporterDiscordId: 'user1',
    reportCountForUser: 1,
  });
  assert.equal(result, null);
  assert.equal(fetchCalled, false);
});

test('postNewReportAnnouncement posts a plain-content message with a bare link and only pings the reporter', async () => {
  const realBaseUrl = process.env.WEB_BASE_URL;
  process.env.WEB_BASE_URL = 'https://bugz.example.com';
  try {
    const sendCalls = [];
    const fakeChannel = { send: async (payload) => { sendCalls.push(payload); return { id: 'msg-1' }; } };
    const fakeClient = { channels: { fetch: async (id) => { assert.equal(id, 'chan-1'); return fakeChannel; } } };

    await postNewReportAnnouncement({
      client: fakeClient,
      channelId: 'chan-1',
      report: { id: 'report-7' },
      reporterDiscordId: 'user-42',
      reportCountForUser: 3,
    });

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].content, '<@user-42> reported their 3rd bug - https://bugz.example.com/r/report-7');
    assert.deepEqual(sendCalls[0].allowedMentions, { users: ['user-42'] }, 'must never ping a role or @everyone');
  } finally {
    process.env.WEB_BASE_URL = realBaseUrl;
  }
});

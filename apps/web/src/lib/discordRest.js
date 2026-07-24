const DISCORD_API = 'https://discord.com/api/v10';

async function discordRequest(path, options = {}) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord API error ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

// Posts the bug into the configured retest channel and opens a thread on
// it for discussion. `ping` controls whether anyone is mentioned —
// "Ping testers" vs "Post in retested" are the same call with this flag
// flipped. Pings the configured tester role if one's set, otherwise
// falls back to mentioning the individual reporter.
async function postRetestMessage({ channelId, report, ping, testerPingRoleId, triggeredByDiscordId }) {
  // Public, unauthenticated readable view (see apps/web/src/routes/publicReport.js) —
  // Discord can generate its own rich preview for this without anyone
  // having to log in or leave the app, unlike the dashboard link.
  const reportUrl = `${process.env.WEB_BASE_URL}/r/${report.id}`;

  const embed = {
    title: report.title,
    // Makes the embed title a clickable link straight to a readable view
    // of this exact report on the dashboard (auto-expands there).
    url: reportUrl,
    description: report.description,
    color: 0x3ba55d,
    fields: [
      { name: 'Status', value: report.status, inline: true },
      { name: 'Priority', value: report.priority, inline: true },
      { name: 'Device', value: report.device || 'Not specified', inline: true },
      // Embed fields never trigger a Discord notification/highlight on
      // their own (only mentions in the top-level `content` do), so this
      // is safe to include without touching allowed_mentions.
      { name: 'Triggered by', value: triggeredByDiscordId ? `<@${triggeredByDiscordId}>` : 'Unknown', inline: true },
    ],
  };

  const mention = testerPingRoleId ? `<@&${testerPingRoleId}>` : `<@${report.reporter.discordId}>`;

  const message = await discordRequest(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: ping ? mention : undefined,
      embeds: [embed],
      // Discord does NOT actually notify a role by default just because
      // it's mentioned in the text — that's a deliberate anti-spam
      // measure, unlike user mentions which ping by default. Without
      // this, the role tag would render but silently ping no one.
      allowed_mentions: ping ? { parse: ['users'], roles: testerPingRoleId ? [testerPingRoleId] : [] } : undefined,
    }),
  });

  const thread = await discordRequest(`/channels/${channelId}/messages/${message.id}/threads`, {
    method: 'POST',
    body: JSON.stringify({ name: report.title.slice(0, 90), auto_archive_duration: 1440 }),
  });

  return { messageId: message.id, threadId: thread.id };
}

module.exports = { postRetestMessage };

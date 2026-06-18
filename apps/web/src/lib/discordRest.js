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
// it for discussion. `ping` controls whether the reporter is mentioned —
// "Ping testers" vs "Post in retested" are the same call with this flag flipped.
async function postRetestMessage({ channelId, report, ping }) {
  const embed = {
    title: report.title,
    description: report.description,
    color: 0x3ba55d,
    fields: [
      { name: 'Status', value: report.status, inline: true },
      { name: 'Priority', value: report.priority, inline: true },
      { name: 'Device', value: report.device || 'Not specified', inline: true },
    ],
  };

  const message = await discordRequest(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: ping ? `<@${report.reporter.discordId}>` : undefined,
      embeds: [embed],
    }),
  });

  const thread = await discordRequest(`/channels/${channelId}/messages/${message.id}/threads`, {
    method: 'POST',
    body: JSON.stringify({ name: report.title.slice(0, 90), auto_archive_duration: 1440 }),
  });

  return { messageId: message.id, threadId: thread.id };
}

module.exports = { postRetestMessage };

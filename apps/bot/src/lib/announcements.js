function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// "@user reported their Xth bug <link>" - styled after the Arcane
// level-up announcement: a single plain-content line, no manual embed.
// The link is bare in the message on purpose, so Discord's own crawler
// unfurls the public /r/:id page (which has real Open Graph tags - see
// apps/web/src/routes/publicReport.js) into a rich preview card
// automatically, right under the message.
async function postNewReportAnnouncement({ client, channelId, report, reporterDiscordId, reportCountForUser }) {
  if (!channelId) return null; // announcements are opt-in via /set-announce-channel

  const reportUrl = `${process.env.WEB_BASE_URL}/r/${report.id}`;
  const content = `<@${reporterDiscordId}> reported their ${ordinal(reportCountForUser)} bug - ${reportUrl}`;

  const channel = await client.channels.fetch(channelId);
  return channel.send({
    content,
    // Only ever pings the reporter being congratulated, never a role or
    // @everyone - matches the low-key "achievement" tone of the Arcane
    // example rather than an urgent alert.
    allowedMentions: { users: [reporterDiscordId] },
  });
}

module.exports = { postNewReportAnnouncement, ordinal };

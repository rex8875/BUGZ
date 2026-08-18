const express = require('express');
const {
  getServerById,
  getEffectivePermissions,
  queryBugReports,
  listCommandPermissions,
  setCommandPermissions,
  getBugReport,
  updateBugReport,
  deleteBugReport,
  getReportSummary,
  updateServerSettings,
  updateServerAppearance,
  createShareLink,
  revokeShareLink,
  listShareLinks,
  listAccessibleServers,
  listRolePermissions,
  setRolePermissions,
  deleteRolePermissions,
  listBannedMembers,
  banMember,
  unbanMember,
  listAuditLog,
  getLeaderboard,
  getWeeklyLeaderboard,
  adjustPointsManually,
  getUserTheme,
  setUserTheme,
} = require('@bugtracker/db');
const { postRetestMessage, listGuildRoles, listApplicationCommands } = require('../lib/discordRest');
const requireAuthApi = require('../middleware/requireAuthApi');

const router = express.Router();
router.use('/api', requireAuthApi);

// Loads the server + this user's permissions for every /api/servers/:serverId/* route,
// so each handler below can just check req.perms instead of re-deriving it.
// Note: getEffectivePermissions itself returns null for an inactive server
// (bot removed/kicked) regardless of role or guest status, so that case is
// already covered by the canViewDashboard check below — no separate
// isActive check needed here.
router.use('/api/servers/:serverId', async (req, res, next) => {
  const server = await getServerById(req.params.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found.' });

  const perms = await getEffectivePermissions(server.id, req.session.discordId);
  if (!perms?.canViewDashboard) return res.status(403).json({ error: 'No dashboard access for this server.' });

  req.server = server;
  req.perms = perms;
  next();
});

router.get('/api/servers', async (req, res) => {
  const accessible = await listAccessibleServers(req.session.discordId);
  // listAccessibleServers is deliberately general (anywhere they have any
  // standing at all). The dashboard picker specifically should only ever
  // link to servers they can actually view — otherwise this links straight
  // into a 403 on the board page for e.g. a Discord-only Tester.
  const viewable = accessible.filter((a) => a.permissions.canViewDashboard);
  res.json(
    viewable.map((a) => ({
      id: a.server.id,
      name: a.server.name,
      iconUrl: a.server.iconUrl,
      backgroundStyle: a.server.backgroundStyle,
      permissions: a.permissions,
    })),
  );
});

// Personal, cross-device background theme — not scoped to any one
// server, so this sits outside /api/servers/:serverId (that middleware
// requires per-server dashboard access, which has nothing to do with
// a preference that follows the person everywhere).
router.get('/api/me/theme', async (req, res) => {
  res.json({ theme: await getUserTheme(req.session.discordId) });
});

router.put('/api/me/theme', async (req, res) => {
  try {
    res.json({ theme: await setUserTheme(req.session.discordId, req.body.theme) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/servers/:serverId/me', (req, res) => {
  res.json({
    discordId: req.session.discordId,
    permissions: req.perms,
    retestChannelId: req.server.retestChannelId,
    testerPingRoleId: req.server.testerPingRoleId,
    serverName: req.server.name,
    iconUrl: req.server.iconUrl,
    backgroundStyle: req.server.backgroundStyle,
  });
});

router.patch('/api/servers/:serverId/appearance', async (req, res) => {
  try {
    res.json(
      await updateServerAppearance({
        serverId: req.server.id,
        actingDiscordId: req.session.discordId,
        backgroundStyle: req.body.backgroundStyle ?? null,
      }),
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/servers/:serverId/reports', async (req, res) => {
  const { priority, status, archived, search, before, on, after, by, device, page } = req.query;
  const result = await queryBugReports(req.server.id, {
    priority: priority || undefined,
    status: status || undefined,
    archived: archived === 'true',
    search: search || undefined,
    before: before || undefined,
    on: on || undefined,
    after: after || undefined,
    byUsername: by || undefined,
    device: device || undefined,
    page: Math.max(1, Number(page) || 1),
    pageSize: 15,
  });
  res.json(result);
});

router.get('/api/servers/:serverId/summary', async (req, res) => {
  res.json(await getReportSummary(req.server.id));
});

router.get('/api/servers/:serverId/reports/:reportId', async (req, res) => {
  const report = await getBugReport(req.server.id, req.params.reportId);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  res.json(report);
});

router.patch('/api/servers/:serverId/reports/:reportId', async (req, res) => {
  try {
    res.json(
      await updateBugReport({
        serverId: req.server.id,
        actingDiscordId: req.session.discordId,
        bugReportId: req.params.reportId,
        requestedChanges: req.body,
      }),
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/api/servers/:serverId/reports/:reportId', async (req, res) => {
  try {
    await deleteBugReport({ serverId: req.server.id, actingDiscordId: req.session.discordId, bugReportId: req.params.reportId });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function handleRetestPost(req, res, { ping }) {
  if (!req.perms.canPingTesters) return res.status(403).json({ error: 'Not permitted to do this here.' });
  if (!req.server.retestChannelId) {
    return res.status(400).json({ error: 'Set a retest channel in settings first.' });
  }

  const report = await getBugReport(req.server.id, req.params.reportId);
  if (!report) return res.status(404).json({ error: 'Report not found.' });

  try {
    const { messageId, threadId } = await postRetestMessage({
      channelId: req.server.retestChannelId,
      report,
      ping,
      testerPingRoleId: req.server.testerPingRoleId,
      triggeredByDiscordId: req.session.discordId,
    });
    res.json(
      await updateBugReport({
        serverId: req.server.id,
        actingDiscordId: req.session.discordId,
        bugReportId: report.id,
        requestedChanges: { retestMessageId: messageId, retestThreadId: threadId },
      }),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not post to the retest channel.' });
  }
}

router.post('/api/servers/:serverId/reports/:reportId/ping', (req, res) => handleRetestPost(req, res, { ping: true }));
router.post('/api/servers/:serverId/reports/:reportId/retest', (req, res) => handleRetestPost(req, res, { ping: false }));

router.post('/api/servers/:serverId/reports/:reportId/archive', async (req, res) => {
  try {
    res.json(
      await updateBugReport({
        serverId: req.server.id,
        actingDiscordId: req.session.discordId,
        bugReportId: req.params.reportId,
        requestedChanges: { archivedAt: new Date() },
      }),
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/servers/:serverId/reports/:reportId/unarchive', async (req, res) => {
  try {
    res.json(
      await updateBugReport({
        serverId: req.server.id,
        actingDiscordId: req.session.discordId,
        bugReportId: req.params.reportId,
        requestedChanges: { archivedAt: null },
      }),
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/servers/:serverId/share-links', async (req, res) => {
  if (!req.perms.canShareDashboard) return res.status(403).json({ error: 'Not permitted to share the dashboard here.' });
  res.json(await listShareLinks(req.server.id));
});

router.post('/api/servers/:serverId/share-links', async (req, res) => {
  try {
    const link = await createShareLink({
      serverId: req.server.id,
      actingDiscordId: req.session.discordId,
      accessLevel: req.body.accessLevel,
      label: req.body.label,
    });
    res.json({ ...link, url: `${process.env.WEB_BASE_URL}/share/${link.id}` });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.post('/api/servers/:serverId/share-links/:shareLinkId/revoke', async (req, res) => {
  try {
    await revokeShareLink({
      serverId: req.server.id,
      actingDiscordId: req.session.discordId,
      shareLinkId: req.params.shareLinkId,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.patch('/api/servers/:serverId/settings', async (req, res) => {
  try {
    res.json(
      await updateServerSettings({
        serverId: req.server.id,
        actingDiscordId: req.session.discordId,
        retestChannelId: req.body.retestChannelId,
        testerPingRoleId: req.body.testerPingRoleId,
      }),
    );
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// ---- Command permissions (Discord-role-based, per-command) ----

router.get('/api/servers/:serverId/command-permissions', async (req, res) => {
  if (!req.perms.canManageSettings) return res.status(403).json({ error: 'Not permitted to manage command permissions here.' });
  try {
    const [discordRoles, discordCommands, overrides] = await Promise.all([
      listGuildRoles(req.server.discordServerId),
      listApplicationCommands(),
      listCommandPermissions(req.server.id),
    ]);
    res.json({
      // @everyone (id === guildId) isn't a useful restriction target —
      // "everyone" is just the unrestricted default — so it's left out
      // of the picker entirely rather than shown as a confusing no-op
      // option.
      roles: discordRoles
        .filter((r) => r.id !== req.server.discordServerId)
        .map((r) => ({ id: r.id, name: r.name, color: r.color })),
      commands: discordCommands.map((c) => ({ name: c.name, description: c.description })),
      overrides,
    });
  } catch (err) {
    res.status(502).json({ error: `Could not reach Discord: ${err.message}` });
  }
});

router.patch('/api/servers/:serverId/command-permissions/:commandName', async (req, res) => {
  try {
    const discordRoleIds = await setCommandPermissions({
      serverId: req.server.id,
      actingDiscordId: req.session.discordId,
      commandName: req.params.commandName,
      discordRoleIds: req.body.discordRoleIds || [],
    });
    res.json({ commandName: req.params.commandName, discordRoleIds });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// ---- Role permissions (linked to real Discord roles, not a separate bot role) ----

router.get('/api/servers/:serverId/role-permissions', async (req, res) => {
  if (!req.perms.canManageRoles) return res.status(403).json({ error: 'Not permitted to manage roles here.' });
  try {
    const [discordRoles, configured] = await Promise.all([
      listGuildRoles(req.server.discordServerId),
      listRolePermissions(req.server.id),
    ]);
    res.json({
      // @everyone (id === guildId) is never a meaningful role to
      // configure bot permissions for — left out of the picker entirely.
      roles: discordRoles
        .filter((r) => r.id !== req.server.discordServerId)
        .map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position })),
      configured,
    });
  } catch (err) {
    res.status(502).json({ error: `Could not reach Discord: ${err.message}` });
  }
});

router.patch('/api/servers/:serverId/role-permissions/:discordRoleId', async (req, res) => {
  try {
    res.json(
      await setRolePermissions({
        serverId: req.server.id,
        actingDiscordId: req.session.discordId,
        discordRoleId: req.params.discordRoleId,
        permissions: req.body,
      }),
    );
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.delete('/api/servers/:serverId/role-permissions/:discordRoleId', async (req, res) => {
  try {
    await deleteRolePermissions({ serverId: req.server.id, actingDiscordId: req.session.discordId, discordRoleId: req.params.discordRoleId });
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// ---- Members ----
//
// There's no member roster or grant/revoke/kick here anymore — real
// Discord roles ARE the membership, viewable in Discord's own member
// list, and this bot only reads them rather than assigning them. Ban is
// the one moderation action left: an app-level access block independent
// of whatever Discord roles someone holds.

router.post('/api/servers/:serverId/members/:discordId/ban', async (req, res) => {
  try {
    await banMember({
      serverId: req.server.id,
      actingDiscordId: req.session.discordId,
      targetDiscordId: req.params.discordId,
      reason: req.body.reason,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.post('/api/servers/:serverId/members/:discordId/unban', async (req, res) => {
  try {
    await unbanMember({ serverId: req.server.id, actingDiscordId: req.session.discordId, targetDiscordId: req.params.discordId });
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.get('/api/servers/:serverId/banned', async (req, res) => {
  if (!req.perms.canBanMembers) return res.status(403).json({ error: 'Not permitted to view bans here.' });
  res.json(await listBannedMembers(req.server.id));
});

// ---- Audit log ----

router.get('/api/servers/:serverId/audit-log', async (req, res) => {
  if (!req.perms.canManageRoles) return res.status(403).json({ error: 'Not permitted to view the audit log here.' });
  res.json(await listAuditLog(req.server.id));
});

// ---- Leaderboard ----

router.get('/api/servers/:serverId/leaderboard', async (req, res) => {
  res.json(await getLeaderboard(req.server.id));
});

router.get('/api/servers/:serverId/leaderboard/weekly', async (req, res) => {
  const weekStart = req.query.weekStart ? new Date(req.query.weekStart) : undefined;
  res.json(await getWeeklyLeaderboard(req.server.id, { weekStart }));
});

router.post('/api/servers/:serverId/leaderboard/:discordId/adjust', async (req, res) => {
  if (!req.perms.canManageBugs) return res.status(403).json({ error: 'Not permitted to adjust points here.' });

  const delta = Number(req.body.delta);
  if (!Number.isInteger(delta)) return res.status(400).json({ error: 'delta must be a whole number.' });

  try {
    res.json(
      await adjustPointsManually({
        serverId: req.server.id,
        actingDiscordId: req.session.discordId,
        targetDiscordId: req.params.discordId,
        delta,
      }),
    );
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

module.exports = router;

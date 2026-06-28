const express = require('express');
const {
  getServerById,
  getEffectivePermissions,
  listBugReports,
  getBugReport,
  updateBugReport,
  deleteBugReport,
  getReportSummary,
  updateServerSettings,
  createShareLink,
  revokeShareLink,
  listShareLinks,
  listAccessibleServers,
  listRoles,
  createRole,
  updateRolePermissions,
  deleteRole,
  listMembers,
  listBannedMembers,
  grantRole,
  revokeRole,
  kickMember,
  banMember,
  unbanMember,
  listAuditLog,
  getLeaderboard,
  getWeeklyLeaderboard,
  adjustPointsManually,
} = require('@bugtracker/db');
const { postRetestMessage } = require('../lib/discordRest');
const requireAuthApi = require('../middleware/requireAuthApi');

const router = express.Router();
router.use('/api', requireAuthApi);

// Loads the server + this user's permissions for every /api/servers/:serverId/* route,
// so each handler below can just check req.perms instead of re-deriving it.
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
  res.json(viewable.map((a) => ({ id: a.server.id, name: a.server.name, permissions: a.permissions })));
});

router.get('/api/servers/:serverId/me', (req, res) => {
  res.json({
    permissions: req.perms,
    retestChannelId: req.server.retestChannelId,
    testerPingRoleId: req.server.testerPingRoleId,
  });
});

router.get('/api/servers/:serverId/reports', async (req, res) => {
  const { priority, status, archived } = req.query;
  const reports = await listBugReports(req.server.id, {
    priority: priority || undefined,
    status: status || undefined,
    archivedOnly: archived === 'true',
  });
  res.json(reports);
});

router.get('/api/servers/:serverId/summary', async (req, res) => {
  res.json(await getReportSummary(req.server.id));
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

// ---- Roles ----

router.get('/api/servers/:serverId/roles', async (req, res) => {
  if (!req.perms.canManageRoles) return res.status(403).json({ error: 'Not permitted to manage roles here.' });
  res.json(await listRoles(req.server.id));
});

router.post('/api/servers/:serverId/roles', async (req, res) => {
  try {
    const { name, rank, ...permissions } = req.body;
    res.json(await createRole({ serverId: req.server.id, actingDiscordId: req.session.discordId, name, rank, permissions }));
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.patch('/api/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    res.json(
      await updateRolePermissions({
        serverId: req.server.id,
        actingDiscordId: req.session.discordId,
        roleId: req.params.roleId,
        permissions: req.body,
      }),
    );
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.delete('/api/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    await deleteRole({ serverId: req.server.id, actingDiscordId: req.session.discordId, roleId: req.params.roleId });
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// ---- Members ----

router.get('/api/servers/:serverId/members', async (req, res) => {
  if (!req.perms.canManageRoles) return res.status(403).json({ error: 'Not permitted to manage members here.' });
  res.json(await listMembers(req.server.id));
});

router.post('/api/servers/:serverId/members/:discordId/roles/:roleId/grant', async (req, res) => {
  try {
    res.json(
      await grantRole({
        serverId: req.server.id,
        actingDiscordId: req.session.discordId,
        targetDiscordId: req.params.discordId,
        roleId: req.params.roleId,
      }),
    );
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.post('/api/servers/:serverId/members/:discordId/roles/:roleId/revoke', async (req, res) => {
  try {
    await revokeRole({
      serverId: req.server.id,
      actingDiscordId: req.session.discordId,
      targetDiscordId: req.params.discordId,
      roleId: req.params.roleId,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.post('/api/servers/:serverId/members/:discordId/kick', async (req, res) => {
  try {
    await kickMember({ serverId: req.server.id, actingDiscordId: req.session.discordId, targetDiscordId: req.params.discordId });
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

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

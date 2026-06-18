const express = require('express');
const {
  getServerById,
  getEffectivePermissions,
  listBugReports,
  getBugReport,
  updateBugReport,
  updateServerSettings,
  createShareLink,
  revokeShareLink,
  listShareLinks,
  listAccessibleServers,
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
  res.json(accessible.map((a) => ({ id: a.server.id, name: a.server.name, permissions: a.permissions })));
});

router.get('/api/servers/:serverId/me', (req, res) => {
  res.json({ permissions: req.perms, retestChannelId: req.server.retestChannelId });
});

router.get('/api/servers/:serverId/reports', async (req, res) => {
  const { priority, status, includeArchived } = req.query;
  const reports = await listBugReports(req.server.id, {
    priority: priority || undefined,
    status: status || undefined,
    includeArchived: includeArchived === 'true',
  });
  res.json(reports);
});

router.patch('/api/servers/:serverId/reports/:reportId', async (req, res) => {
  if (!req.perms.canManageBugs) return res.status(403).json({ error: 'Not permitted to manage bug reports here.' });

  const allowed = {};
  if (req.body.priority) allowed.priority = req.body.priority;
  if (req.body.status) allowed.status = req.body.status;

  try {
    res.json(await updateBugReport(req.server.id, req.params.reportId, allowed));
  } catch (err) {
    res.status(404).json({ error: err.message });
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
    const { messageId, threadId } = await postRetestMessage({ channelId: req.server.retestChannelId, report, ping });
    res.json(await updateBugReport(req.server.id, report.id, { retestMessageId: messageId, retestThreadId: threadId }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not post to the retest channel.' });
  }
}

router.post('/api/servers/:serverId/reports/:reportId/ping', (req, res) => handleRetestPost(req, res, { ping: true }));
router.post('/api/servers/:serverId/reports/:reportId/retest', (req, res) => handleRetestPost(req, res, { ping: false }));

router.post('/api/servers/:serverId/reports/:reportId/archive', async (req, res) => {
  if (!req.perms.canArchive) return res.status(403).json({ error: 'Not permitted to archive here.' });

  const terminalStatuses = ['FIXED', 'NOT_A_BUG', 'DUPLICATE', 'WONT_FIX'];
  const report = await getBugReport(req.server.id, req.params.reportId);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  if (!terminalStatuses.includes(report.status)) {
    return res.status(400).json({ error: "Status must be Fixed, Not a bug, Duplicate, or Won't fix before archiving." });
  }

  res.json(await updateBugReport(req.server.id, report.id, { archivedAt: new Date() }));
});

router.get('/api/servers/:serverId/share-links', async (req, res) => {
  if (!req.perms.canManageSettings) return res.status(403).json({ error: 'Not permitted to manage settings here.' });
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
      }),
    );
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

module.exports = router;

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Records a governance-sensitive action. Deliberately not used for
// routine bug-report edits (status/priority changes) — see the
// AuditLogEntry model comment for why.
async function logAction(serverId, actorDiscordId, action, details) {
  await prisma.auditLogEntry.create({
    data: { serverId, actorDiscordId, action, details: details ? JSON.stringify(details) : null },
  });
}

async function listAuditLog(serverId, limit = 100) {
  return prisma.auditLogEntry.findMany({
    where: { serverId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

async function isBanned(serverId, discordId) {
  const ban = await prisma.bannedMember.findUnique({ where: { serverId_discordId: { serverId, discordId } } });
  return Boolean(ban);
}

// ---- Servers -------------------------------------------------------

// Called from the bot's guildCreate handler. Creates the server row
// plus a default Owner role (full perms) and Tester role (baseline)
// if this is the first time the bot has seen this guild. ownerDiscordId
// is whoever the bot could identify as the inviter, falling back to
// the guild's Discord-owner if the audit log wasn't readable.
async function createServerOnJoin({ discordServerId, name, ownerDiscordId }) {
  return prisma.server.upsert({
    where: { discordServerId },
    update: { name },
    create: {
      discordServerId,
      name,
      ownerDiscordId,
      roles: {
        create: [
          {
            name: 'Owner',
            rank: 100,
            canSubmitBugs: true,
            canViewDashboard: true,
            canManageBugs: true,
            canPingTesters: true,
            canArchive: true,
            canEditReports: true,
            canDeleteReports: true,
            canShareDashboard: true,
            canKickMembers: true,
            canBanMembers: true,
            canManageRoles: true,
            canManageSettings: true,
          },
          { name: 'Tester', rank: 10, canSubmitBugs: true },
        ],
      },
    },
    include: { roles: true },
  });
}

async function getServerByDiscordId(discordServerId) {
  return prisma.server.findUnique({ where: { discordServerId } });
}

async function updateServerSettings({ serverId, actingDiscordId, retestChannelId }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canManageSettings) throw new Error('Not permitted to manage settings in this server.');
  return prisma.server.update({ where: { id: serverId }, data: { retestChannelId } });
}

async function getServerById(serverId) {
  return prisma.server.findUnique({ where: { id: serverId } });
}

async function getUserByDiscordId(discordId) {
  return prisma.user.findUnique({ where: { discordId } });
}

// ---- Users & verification -------------------------------------------

// Runs once, the first time someone verifies via the bot or the site's
// Discord OAuth. If they're the recorded owner of a server that has no
// Owner membership yet, they're auto-granted that role here.
async function verifyUser({ discordId, discordUsername }) {
  const user = await prisma.user.upsert({
    where: { discordId },
    update: { discordUsername, verifiedAt: new Date() },
    create: { discordId, discordUsername, verifiedAt: new Date() },
  });

  const unclaimedOwnedServers = await prisma.server.findMany({
    where: {
      ownerDiscordId: discordId,
      memberships: { none: { userId: user.id } },
    },
  });

  for (const server of unclaimedOwnedServers) {
    await assignOwnerRole(server.id, user.id);
  }

  return user;
}

// Finds this server's Owner role and grants it to a user, creating or
// updating their membership. Used both when an owner first verifies
// and when ownership is transferred.
async function assignOwnerRole(serverId, userId) {
  const ownerRole = await prisma.role.findFirst({ where: { serverId, name: 'Owner' } });
  if (!ownerRole) throw new Error('Server has no Owner role configured.');
  return prisma.membership.upsert({
    where: { userId_serverId: { userId, serverId } },
    update: { roleId: ownerRole.id },
    create: { userId, serverId, roleId: ownerRole.id },
  });
}

// Only the current owner can do this — checked against Server.ownerDiscordId
// itself, not just "has the Owner role", since that single field is the
// real source of truth even if other members also hold the Owner role.
async function transferOwnership({ serverId, actingDiscordId, newOwnerDiscordId }) {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) throw new Error('Server not found.');
  if (server.ownerDiscordId !== actingDiscordId) {
    throw new Error('Only the current owner can transfer ownership.');
  }

  const newOwner = await prisma.user.findUnique({ where: { discordId: newOwnerDiscordId } });
  if (!newOwner) {
    throw new Error('That person has not verified yet — they need to verify before they can be made owner.');
  }

  await prisma.server.update({ where: { id: serverId }, data: { ownerDiscordId: newOwnerDiscordId } });
  await assignOwnerRole(serverId, newOwner.id);
  await logAction(serverId, actingDiscordId, 'OWNERSHIP_TRANSFERRED', { to: newOwnerDiscordId });

  return prisma.server.findUnique({ where: { id: serverId } });
}

// ---- Memberships & permissions --------------------------------------

async function getMembership(serverId, discordId) {
  return prisma.membership.findFirst({
    where: { serverId, user: { discordId } },
    include: { role: true },
  });
}

function permissionsFromRole(role) {
  return {
    source: 'member',
    canSubmitBugs: role.canSubmitBugs,
    canViewDashboard: role.canViewDashboard,
    canManageBugs: role.canManageBugs,
    canPingTesters: role.canPingTesters,
    canArchive: role.canArchive,
    canEditReports: role.canEditReports,
    canDeleteReports: role.canDeleteReports,
    canShareDashboard: role.canShareDashboard,
    canKickMembers: role.canKickMembers,
    canBanMembers: role.canBanMembers,
    canManageRoles: role.canManageRoles,
    canManageSettings: role.canManageSettings,
  };
}

// Dev-access guests get the bug-content powers (edit/delete sit
// alongside manage/archive), but never the member-governance ones —
// a contractor's link shouldn't be able to kick, ban, or mint more access.
function permissionsFromShareLink(shareLink) {
  const isDev = shareLink.accessLevel === 'DEV';
  return {
    source: 'guest',
    canSubmitBugs: false,
    canViewDashboard: true,
    canManageBugs: isDev,
    canPingTesters: isDev,
    canArchive: isDev,
    canEditReports: isDev,
    canDeleteReports: isDev,
    canShareDashboard: false,
    canKickMembers: false,
    canBanMembers: false,
    canManageRoles: false,
    canManageSettings: false,
  };
}

// The one function the dashboard should call to check what someone can
// do in a given server. Resolves real Memberships first; if there isn't
// one, falls back to checking for an unrevoked share-link grant. Either
// way the caller gets the same shape back, so it doesn't need to care
// which path the access came from.
async function getEffectivePermissions(serverId, discordId) {
  const membership = await getMembership(serverId, discordId);
  if (membership) return permissionsFromRole(membership.role);

  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) return null;

  const guestAccess = await prisma.guestAccess.findFirst({
    where: { serverId, userId: user.id, shareLink: { revokedAt: null } },
    include: { shareLink: true },
  });
  if (!guestAccess) return null;

  return permissionsFromShareLink(guestAccess.shareLink);
}

// For the "which server's dashboard am I in" picker page after login —
// every server this person can reach, whether as a member or a guest.
async function listAccessibleServers(discordId) {
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) return [];

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: { server: true, role: true },
  });

  const guestAccesses = await prisma.guestAccess.findMany({
    where: { userId: user.id, shareLink: { revokedAt: null } },
    include: { server: true, shareLink: true },
  });

  return [
    ...memberships.map((m) => ({ server: m.server, permissions: permissionsFromRole(m.role) })),
    ...guestAccesses.map((g) => ({ server: g.server, permissions: permissionsFromShareLink(g.shareLink) })),
  ];
}

// actingDiscordId must have canManageRoles, and can only act on someone
// strictly below their own rank — both checked: the target's CURRENT
// rank (can't touch a peer or superior's role at all) and the new
// role's rank (can't hand out your own rank or above).
async function promoteMember({ serverId, actingDiscordId, targetDiscordId, newRoleId }) {
  const acting = await getMembership(serverId, actingDiscordId);
  if (!acting || !acting.role.canManageRoles) {
    throw new Error('Not permitted to manage roles in this server.');
  }

  if (await isBanned(serverId, targetDiscordId)) {
    throw new Error('That person is banned from this server — unban them first.');
  }

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (server.ownerDiscordId === targetDiscordId) {
    throw new Error("Cannot change the server owner's role — transfer ownership first.");
  }

  const currentMembership = await getMembership(serverId, targetDiscordId);
  if (currentMembership && currentMembership.role.rank >= acting.role.rank) {
    throw new Error('Cannot change the role of someone at or above your own rank.');
  }

  const newRole = await prisma.role.findFirst({ where: { id: newRoleId, serverId } });
  if (!newRole) throw new Error('That role does not belong to this server.');
  if (newRole.rank >= acting.role.rank) {
    throw new Error('Cannot promote someone to your own rank or above.');
  }

  const targetUser = await prisma.user.findUnique({ where: { discordId: targetDiscordId } });
  if (!targetUser) throw new Error('That person has not verified yet.');

  const membership = await prisma.membership.upsert({
    where: { userId_serverId: { userId: targetUser.id, serverId } },
    update: { roleId: newRole.id },
    create: { userId: targetUser.id, serverId, roleId: newRole.id },
  });

  await logAction(serverId, actingDiscordId, 'MEMBER_PROMOTED', { target: targetDiscordId, role: newRole.name });
  return membership;
}

// Every member currently in this server, for the roles/members page.
async function listMembers(serverId) {
  return prisma.membership.findMany({
    where: { serverId },
    include: { user: true, role: true },
    orderBy: { role: { rank: 'desc' } },
  });
}

async function listBannedMembers(serverId) {
  return prisma.bannedMember.findMany({ where: { serverId }, orderBy: { bannedAt: 'desc' } });
}

// Removes someone's membership without a permanent ban — they could be
// re-promoted later without anyone needing to unban them first.
async function kickMember({ serverId, actingDiscordId, targetDiscordId }) {
  const acting = await getMembership(serverId, actingDiscordId);
  if (!acting?.role.canKickMembers) throw new Error('Not permitted to kick members in this server.');

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (server.ownerDiscordId === targetDiscordId) {
    throw new Error('Cannot kick the server owner — transfer ownership first.');
  }

  const target = await getMembership(serverId, targetDiscordId);
  if (target && target.role.rank >= acting.role.rank) {
    throw new Error('Cannot kick someone at or above your own rank.');
  }

  await prisma.membership.deleteMany({ where: { serverId, user: { discordId: targetDiscordId } } });
  await logAction(serverId, actingDiscordId, 'MEMBER_KICKED', { target: targetDiscordId });
}

// Removes membership (if any) and blocks the person from being added
// back until unbanned.
async function banMember({ serverId, actingDiscordId, targetDiscordId, reason }) {
  const acting = await getMembership(serverId, actingDiscordId);
  if (!acting?.role.canBanMembers) throw new Error('Not permitted to ban members in this server.');

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (server.ownerDiscordId === targetDiscordId) {
    throw new Error('Cannot ban the server owner — transfer ownership first.');
  }

  const target = await getMembership(serverId, targetDiscordId);
  if (target && target.role.rank >= acting.role.rank) {
    throw new Error('Cannot ban someone at or above your own rank.');
  }

  await prisma.membership.deleteMany({ where: { serverId, user: { discordId: targetDiscordId } } });
  await prisma.bannedMember.upsert({
    where: { serverId_discordId: { serverId, discordId: targetDiscordId } },
    update: { reason, bannedByDiscordId: actingDiscordId, bannedAt: new Date() },
    create: { serverId, discordId: targetDiscordId, bannedByDiscordId: actingDiscordId, reason },
  });
  await logAction(serverId, actingDiscordId, 'MEMBER_BANNED', { target: targetDiscordId, reason });
}

async function unbanMember({ serverId, actingDiscordId, targetDiscordId }) {
  const acting = await getMembership(serverId, actingDiscordId);
  if (!acting?.role.canBanMembers) throw new Error('Not permitted to unban members in this server.');

  await prisma.bannedMember.deleteMany({ where: { serverId, discordId: targetDiscordId } });
  await logAction(serverId, actingDiscordId, 'MEMBER_UNBANNED', { target: targetDiscordId });
}

// ---- Roles -------------------------------------------------------------

async function listRoles(serverId) {
  return prisma.role.findMany({ where: { serverId }, orderBy: { rank: 'desc' } });
}

// Can only create a role at a rank strictly below your own — same
// ceiling logic as promoting, applied to minting the role itself.
async function createRole({ serverId, actingDiscordId, name, rank, permissions = {} }) {
  const acting = await getMembership(serverId, actingDiscordId);
  if (!acting?.role.canManageRoles) throw new Error('Not permitted to manage roles in this server.');
  if (rank >= acting.role.rank) throw new Error('Cannot create a role at or above your own rank.');

  const role = await prisma.role.create({ data: { serverId, name, rank, ...permissions } });
  await logAction(serverId, actingDiscordId, 'ROLE_CREATED', { role: name, rank });
  return role;
}

async function updateRolePermissions({ serverId, actingDiscordId, roleId, permissions }) {
  const acting = await getMembership(serverId, actingDiscordId);
  if (!acting?.role.canManageRoles) throw new Error('Not permitted to manage roles in this server.');

  const target = await prisma.role.findFirst({ where: { id: roleId, serverId } });
  if (!target) throw new Error('That role does not belong to this server.');
  if (target.rank >= acting.role.rank) throw new Error('Cannot edit a role at or above your own rank.');
  if (permissions.rank !== undefined && permissions.rank >= acting.role.rank) {
    throw new Error('Cannot raise a role to your own rank or above.');
  }

  const updated = await prisma.role.update({ where: { id: roleId }, data: permissions });
  await logAction(serverId, actingDiscordId, 'ROLE_UPDATED', { role: target.name });
  return updated;
}

async function deleteRole({ serverId, actingDiscordId, roleId }) {
  const acting = await getMembership(serverId, actingDiscordId);
  if (!acting?.role.canManageRoles) throw new Error('Not permitted to manage roles in this server.');

  const target = await prisma.role.findFirst({ where: { id: roleId, serverId } });
  if (!target) throw new Error('That role does not belong to this server.');
  if (target.rank >= acting.role.rank) throw new Error('Cannot delete a role at or above your own rank.');

  const inUse = await prisma.membership.count({ where: { roleId } });
  if (inUse > 0) throw new Error(`${inUse} member(s) still hold this role — reassign them first.`);

  await prisma.role.delete({ where: { id: roleId } });
  await logAction(serverId, actingDiscordId, 'ROLE_DELETED', { role: target.name });
}

// ---- Dashboard share links -------------------------------------------

// Requires canShareDashboard specifically — not canManageSettings, since
// being able to touch server settings and being able to hand out
// dashboard access are different things an owner may want to separate.
async function createShareLink({ serverId, actingDiscordId, accessLevel, label }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canShareDashboard) throw new Error('Not permitted to share the dashboard in this server.');

  const link = await prisma.shareLink.create({
    data: { serverId, accessLevel, label, createdByDiscordId: actingDiscordId },
  });
  await logAction(serverId, actingDiscordId, 'SHARE_LINK_CREATED', { accessLevel, label });
  return link;
}

async function revokeShareLink({ serverId, actingDiscordId, shareLinkId }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canShareDashboard) throw new Error('Not permitted to share the dashboard in this server.');

  const { count } = await prisma.shareLink.updateMany({
    where: { id: shareLinkId, serverId },
    data: { revokedAt: new Date() },
  });
  if (count === 0) throw new Error('Link not found in this server.');
  await logAction(serverId, actingDiscordId, 'SHARE_LINK_REVOKED', { shareLinkId });
}

// For the owner/settings page: every link for this server, plus who has
// actually redeemed each one.
async function listShareLinks(serverId) {
  return prisma.shareLink.findMany({
    where: { serverId },
    include: { guestAccess: { include: { user: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

// Called the first time someone with a share link reaches the
// dashboard. They must already be verified — the link grants a
// permission level, not an identity.
async function redeemShareLink({ shareLinkId, discordId }) {
  const link = await prisma.shareLink.findUnique({ where: { id: shareLinkId } });
  if (!link || link.revokedAt) throw new Error('This link is invalid or has been revoked.');

  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) throw new Error('You need to verify your Discord identity first.');

  return prisma.guestAccess.upsert({
    where: { shareLinkId_userId: { shareLinkId: link.id, userId: user.id } },
    update: {},
    create: { shareLinkId: link.id, serverId: link.serverId, userId: user.id },
  });
}

// ---- Leaderboard ---------------------------------------------------

// Normalizes any date to the Monday 00:00 UTC of its week, so a report
// created any time during a week buckets to the same weekStart value.
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function adjustLeaderboardPoints(serverId, userId, delta) {
  await prisma.leaderboardScore.upsert({
    where: { serverId_userId: { serverId, userId } },
    update: { points: { increment: delta } },
    create: { serverId, userId, points: Math.max(delta, 0) },
  });
}

async function adjustWeeklyPoints(serverId, userId, weekStart, delta) {
  await prisma.weeklyScore.upsert({
    where: { serverId_userId_weekStart: { serverId, userId, weekStart } },
    update: { points: { increment: delta } },
    create: { serverId, userId, weekStart, points: Math.max(delta, 0) },
  });
}

async function getLeaderboard(serverId) {
  return prisma.leaderboardScore.findMany({
    where: { serverId },
    include: { user: true },
    orderBy: { points: 'desc' },
  });
}

// Defaults to the current week. Pass a date that falls in a past week
// to look up that week's standings instead (e.g. for "last week's
// winner" — still works after old reports themselves are long deleted,
// since this is read from the persisted WeeklyScore table, not from
// counting reports).
async function getWeeklyLeaderboard(serverId, { weekStart } = {}) {
  const week = weekStart ? getWeekStart(weekStart) : getWeekStart(new Date());
  const scores = await prisma.weeklyScore.findMany({
    where: { serverId, weekStart: week },
    include: { user: true },
    orderBy: { points: 'desc' },
  });
  return { weekStart: week, scores };
}

// Manual override for a dev correcting a score for reasons other than
// the automatic duplicate adjustment below — e.g. a penalty, or fixing
// a mistake. Gated on canManageBugs at the API layer.
async function adjustPointsManually({ serverId, actingDiscordId, targetDiscordId, delta }) {
  const targetUser = await prisma.user.findUnique({ where: { discordId: targetDiscordId } });
  if (!targetUser) throw new Error('That person has not verified yet.');
  await adjustLeaderboardPoints(serverId, targetUser.id, delta);
  await adjustWeeklyPoints(serverId, targetUser.id, getWeekStart(new Date()), delta);
  await logAction(serverId, actingDiscordId, 'POINTS_ADJUSTED', { target: targetDiscordId, delta });
  return getLeaderboard(serverId);
}

// ---- Bug reports -------------------------------------------------------

async function createBugReport(serverId, reporterDiscordId, data) {
  if (await isBanned(serverId, reporterDiscordId)) {
    throw new Error('You are banned from this server.');
  }

  const membership = await getMembership(serverId, reporterDiscordId);
  if (!membership?.role.canSubmitBugs) {
    throw new Error('You do not have permission to report bugs in this server.');
  }

  const report = await prisma.bugReport.create({
    data: { serverId, reporterId: membership.userId, ...data },
  });

  // Each submitted bug is worth a point immediately, both all-time and
  // for the week it was reported in — see the DUPLICATE handling in
  // updateBugReport for how that gets corrected if it turns out not to
  // be a unique find.
  await adjustLeaderboardPoints(serverId, membership.userId, 1);
  await adjustWeeklyPoints(serverId, membership.userId, getWeekStart(report.createdAt), 1);

  return report;
}

// For a tester self-checking before they report something — the
// process here is manual (people look themselves), not automatic
// duplicate detection, so this just needs to be searchable by keyword.
async function searchBugReports(serverId, search) {
  return prisma.bugReport.findMany({
    where: {
      serverId,
      archivedAt: null,
      ...(search ? { title: { contains: search } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
}

// For a tester checking their own submissions without dashboard access —
// e.g. a /my-bugs command in Discord.
async function listMyBugReports(serverId, reporterDiscordId) {
  const user = await prisma.user.findUnique({ where: { discordId: reporterDiscordId } });
  if (!user) return [];
  return prisma.bugReport.findMany({
    where: { serverId, reporterId: user.id },
    orderBy: { createdAt: 'desc' },
  });
}

async function listBugReports(serverId, { priority, status, includeArchived = false } = {}) {
  return prisma.bugReport.findMany({
    where: {
      serverId,
      ...(priority ? { priority } : {}),
      ...(status ? { status } : {}),
      ...(includeArchived ? {} : { archivedAt: null }),
    },
    include: { reporter: true },
    orderBy: { createdAt: 'desc' },
  });
}

async function getBugReport(serverId, bugReportId) {
  return prisma.bugReport.findFirst({
    where: { id: bugReportId, serverId },
    include: { reporter: true },
  });
}

// Every mutation re-checks serverId on the where clause, not just the id —
// so even a guessed/leaked report id can't be edited from the wrong server.
// Also handles the leaderboard side-effect of a status moving into or
// out of DUPLICATE — exactly one point deducted/refunded per report,
// ever, tracked via pointDeducted so flapping the status back and forth
// can't double-charge or double-refund.
async function updateBugReport(serverId, bugReportId, data) {
  const existing = await prisma.bugReport.findFirst({ where: { id: bugReportId, serverId } });
  if (!existing) throw new Error('Bug report not found in this server.');

  if (data.status && data.status !== existing.status) {
    const reportWeek = getWeekStart(existing.createdAt);
    if (data.status === 'DUPLICATE' && !existing.pointDeducted) {
      await adjustLeaderboardPoints(serverId, existing.reporterId, -1);
      await adjustWeeklyPoints(serverId, existing.reporterId, reportWeek, -1);
      data = { ...data, pointDeducted: true };
    } else if (existing.status === 'DUPLICATE' && data.status !== 'DUPLICATE' && existing.pointDeducted) {
      await adjustLeaderboardPoints(serverId, existing.reporterId, 1);
      await adjustWeeklyPoints(serverId, existing.reporterId, reportWeek, 1);
      data = { ...data, pointDeducted: false };
    }
  }

  await prisma.bugReport.updateMany({ where: { id: bugReportId, serverId }, data });
  return prisma.bugReport.findUnique({ where: { id: bugReportId } });
}

// Permanent — for obvious spam/troll reports that shouldn't even sit in
// the 15-day archive window. Distinct from archiving, which is meant to
// be a soft, temporary state.
async function deleteBugReport(serverId, bugReportId) {
  const { count } = await prisma.bugReport.deleteMany({ where: { id: bugReportId, serverId } });
  if (count === 0) throw new Error('Bug report not found in this server.');
}

// Quick counts for a dashboard summary strip — one query instead of
// pulling every report just to count them client-side.
async function getReportSummary(serverId) {
  const grouped = await prisma.bugReport.groupBy({
    by: ['status'],
    where: { serverId, archivedAt: null },
    _count: true,
  });
  const summary = { total: 0 };
  for (const g of grouped) {
    summary[g.status] = g._count;
    summary.total += g._count;
  }
  return summary;
}

// Permanently removes archived reports past the 15-day retention
// window. Meant to be called on an interval (e.g. once an hour) by
// whichever process stays running — see apps/bot/src/index.js.
async function deleteExpiredArchivedReports() {
  const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const { count } = await prisma.bugReport.deleteMany({
    where: { archivedAt: { not: null, lt: cutoff } },
  });
  return count;
}

module.exports = {
  prisma,
  createServerOnJoin,
  getServerByDiscordId,
  getServerById,
  updateServerSettings,
  getUserByDiscordId,
  verifyUser,
  assignOwnerRole,
  transferOwnership,
  getMembership,
  getEffectivePermissions,
  listAccessibleServers,
  promoteMember,
  listMembers,
  listBannedMembers,
  kickMember,
  banMember,
  unbanMember,
  isBanned,
  listRoles,
  createRole,
  updateRolePermissions,
  deleteRole,
  listAuditLog,
  createShareLink,
  revokeShareLink,
  listShareLinks,
  redeemShareLink,
  createBugReport,
  searchBugReports,
  listMyBugReports,
  getBugReport,
  listBugReports,
  updateBugReport,
  deleteBugReport,
  getReportSummary,
  deleteExpiredArchivedReports,
  getLeaderboard,
  getWeeklyLeaderboard,
  adjustPointsManually,
};

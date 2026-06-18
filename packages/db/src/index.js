const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

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
            canShareDashboard: true,
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
    canShareDashboard: role.canShareDashboard,
    canManageRoles: role.canManageRoles,
    canManageSettings: role.canManageSettings,
  };
}

// Guests never get role management, settings, or the ability to share
// the dashboard further, even at Dev level — a contractor's link
// shouldn't be able to mint more access.
function permissionsFromShareLink(shareLink) {
  const isDev = shareLink.accessLevel === 'DEV';
  return {
    source: 'guest',
    canSubmitBugs: false,
    canViewDashboard: true,
    canManageBugs: isDev,
    canPingTesters: isDev,
    canArchive: isDev,
    canShareDashboard: false,
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

// actingDiscordId must have canManageRoles, and can only promote to a
// rank strictly below their own — stops a Dev handing out Owner, and
// stops anyone promoting a peer to their own level.
async function promoteMember({ serverId, actingDiscordId, targetDiscordId, newRoleId }) {
  const acting = await getMembership(serverId, actingDiscordId);
  if (!acting || !acting.role.canManageRoles) {
    throw new Error('Not permitted to manage roles in this server.');
  }

  const newRole = await prisma.role.findFirst({ where: { id: newRoleId, serverId } });
  if (!newRole) throw new Error('That role does not belong to this server.');
  if (newRole.rank >= acting.role.rank) {
    throw new Error('Cannot promote someone to your own rank or above.');
  }

  const targetUser = await prisma.user.findUnique({ where: { discordId: targetDiscordId } });
  if (!targetUser) throw new Error('That person has not verified yet.');

  return prisma.membership.upsert({
    where: { userId_serverId: { userId: targetUser.id, serverId } },
    update: { roleId: newRole.id },
    create: { userId: targetUser.id, serverId, roleId: newRole.id },
  });
}

// ---- Dashboard share links -------------------------------------------

// Requires canShareDashboard specifically — not canManageSettings, since
// being able to touch server settings and being able to hand out
// dashboard access are different things an owner may want to separate.
async function createShareLink({ serverId, actingDiscordId, accessLevel, label }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canShareDashboard) throw new Error('Not permitted to share the dashboard in this server.');

  return prisma.shareLink.create({
    data: { serverId, accessLevel, label, createdByDiscordId: actingDiscordId },
  });
}

async function revokeShareLink({ serverId, actingDiscordId, shareLinkId }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canShareDashboard) throw new Error('Not permitted to share the dashboard in this server.');

  const { count } = await prisma.shareLink.updateMany({
    where: { id: shareLinkId, serverId },
    data: { revokedAt: new Date() },
  });
  if (count === 0) throw new Error('Link not found in this server.');
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

// ---- Bug reports -------------------------------------------------------

async function createBugReport(serverId, reporterDiscordId, data) {
  const reporter = await prisma.user.findUnique({ where: { discordId: reporterDiscordId } });
  if (!reporter) throw new Error('Reporter has not verified yet.');

  return prisma.bugReport.create({
    data: { serverId, reporterId: reporter.id, ...data },
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
async function updateBugReport(serverId, bugReportId, data) {
  const { count } = await prisma.bugReport.updateMany({
    where: { id: bugReportId, serverId },
    data,
  });
  if (count === 0) throw new Error('Bug report not found in this server.');
  return prisma.bugReport.findUnique({ where: { id: bugReportId } });
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
  createShareLink,
  revokeShareLink,
  listShareLinks,
  redeemShareLink,
  createBugReport,
  getBugReport,
  listBugReports,
  updateBugReport,
};

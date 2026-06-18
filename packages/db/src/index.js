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
  getUserByDiscordId,
  verifyUser,
  assignOwnerRole,
  transferOwnership,
  getMembership,
  promoteMember,
  createBugReport,
  listBugReports,
  updateBugReport,
};

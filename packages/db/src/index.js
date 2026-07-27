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
async function createServerOnJoin({ discordServerId, name, ownerDiscordId, iconUrl }) {
  return prisma.server.upsert({
    where: { discordServerId },
    update: { name, isActive: true, ...(iconUrl !== undefined ? { iconUrl } : {}) },
    create: {
      discordServerId,
      name,
      ownerDiscordId,
      iconUrl: iconUrl || null,
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

// Called when the bot is kicked/leaves a Discord server. Doesn't touch
// any data — just flips the visibility flag, since the bot getting
// re-invited later (createServerOnJoin) flips it back automatically.
async function deactivateServer(discordServerId) {
  await prisma.server.updateMany({ where: { discordServerId }, data: { isActive: false } });
}

// Called when an individual PERSON leaves the Discord server (not the
// bot) — removes only their own roles/membership, never touching
// anyone else's access or the server itself. No permission checks here:
// this isn't a person-initiated action, it's an automatic reaction to
// Discord telling us they're gone.
async function removeMembershipOnLeave(serverId, discordId) {
  const membership = await getMembership(serverId, discordId);
  if (!membership) return;

  await prisma.memberRole.deleteMany({ where: { membershipId: membership.id } });
  await prisma.membership.deleteMany({ where: { id: membership.id } });
  await logAction(serverId, discordId, 'MEMBER_LEFT_DISCORD', {});

  // Hide (don't delete) their leaderboard standing — score is preserved,
  // just not shown, until they rejoin (automatic) or someone with
  // permission resets it (manual).
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (user) {
    const hiddenAt = new Date();
    await prisma.leaderboardScore.updateMany({ where: { serverId, userId: user.id }, data: { hiddenAt } });
    await prisma.weeklyScore.updateMany({ where: { serverId, userId: user.id }, data: { hiddenAt } });
  }
}

// Called on guildMemberAdd — automatically restores leaderboard
// visibility if this person had a hidden score from a previous leave.
// Does NOT restore their Membership/roles — that still requires an
// admin to re-grant, same as any new member — this is specifically
// about the leaderboard-hide behavior from removeMembershipOnLeave.
async function restoreLeaderboardVisibilityOnRejoin(serverId, discordId) {
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) return;
  await prisma.leaderboardScore.updateMany({ where: { serverId, userId: user.id }, data: { hiddenAt: null } });
  await prisma.weeklyScore.updateMany({ where: { serverId, userId: user.id }, data: { hiddenAt: null } });
}

// The manual override mentioned alongside auto-restore-on-rejoin: an
// owner/permitted person can reset someone's score outright (points to
// 0, un-hidden) at any time, independent of whether that person has
// left or rejoined.
async function resetLeaderboardScore({ serverId, actingDiscordId, targetDiscordId }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canManageSettings) throw new Error('Not permitted to reset scores in this server.');

  const user = await prisma.user.findUnique({ where: { discordId: targetDiscordId } });
  if (!user) throw new Error('That person has not verified yet.');

  await prisma.leaderboardScore.updateMany({ where: { serverId, userId: user.id }, data: { points: 0, hiddenAt: null } });
  await prisma.weeklyScore.updateMany({ where: { serverId, userId: user.id }, data: { points: 0, hiddenAt: null } });
}

async function updateServerSettings({ serverId, actingDiscordId, retestChannelId, testerPingRoleId, announceChannelId }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canManageSettings) throw new Error('Not permitted to manage settings in this server.');

  const data = {};
  if (retestChannelId !== undefined) data.retestChannelId = retestChannelId;
  if (testerPingRoleId !== undefined) data.testerPingRoleId = testerPingRoleId;
  if (announceChannelId !== undefined) data.announceChannelId = announceChannelId;

  return prisma.server.update({ where: { id: serverId }, data });
}

// A single hex color: #abc or #aabbcc.
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// A 2-stop linear gradient of exactly two hex colors at a whole-number
// angle 0-360, e.g. "linear-gradient(135deg, #1a1f2b, #2d3a66)". This is
// interpolated directly into a style attribute in the dashboard, so it's
// validated strictly (whole match, not just a prefix) rather than trusted.
const GRADIENT = /^linear-gradient\((\d{1,3})deg,\s*(#[0-9a-fA-F]{3,6}),\s*(#[0-9a-fA-F]{3,6})\)$/;

function isValidBackgroundStyle(value) {
  if (typeof value !== 'string') return false;
  if (HEX_COLOR.test(value)) return true;
  const gradientMatch = value.match(GRADIENT);
  if (!gradientMatch) return false;
  const angle = Number(gradientMatch[1]);
  return angle >= 0 && angle <= 360;
}

async function updateServerAppearance({ serverId, actingDiscordId, backgroundStyle }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canManageSettings) throw new Error('Not permitted to manage settings in this server.');

  if (backgroundStyle !== null && !isValidBackgroundStyle(backgroundStyle)) {
    throw new Error('Background must be a hex color (#rrggbb) or a two-color gradient.');
  }

  return prisma.server.update({ where: { id: serverId }, data: { backgroundStyle } });
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

// Finds this server's Owner role and adds it to a user's held roles,
// creating their membership if they don't have one yet. ADDS — it
// never removes whatever else they already hold, same as Discord's own
// role model. Used both when an owner first verifies and when
// ownership is transferred.
async function assignOwnerRole(serverId, userId) {
  const ownerRole = await prisma.role.findFirst({ where: { serverId, name: 'Owner' } });
  if (!ownerRole) throw new Error('Server has no Owner role configured.');

  const membership = await prisma.membership.upsert({
    where: { userId_serverId: { userId, serverId } },
    update: {},
    create: { userId, serverId },
  });

  return prisma.memberRole.upsert({
    where: { membershipId_roleId: { membershipId: membership.id, roleId: ownerRole.id } },
    update: {},
    create: { membershipId: membership.id, roleId: ownerRole.id },
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

// Includes every role currently held, not just one — membership.roles
// is an array of MemberRole join rows, each with its .role attached.
async function getMembership(serverId, discordId) {
  return prisma.membership.findFirst({
    where: { serverId, user: { discordId } },
    include: { roles: { include: { role: true } } },
  });
}

function rolesOf(membership) {
  return membership.roles.map((mr) => mr.role);
}

// The highest rank among every role someone holds — this is what
// "your rank" means for deciding what you're allowed to grant/revoke,
// and what's too senior for someone else to touch. Matches Discord:
// your authority comes from your highest role, not your lowest.
function effectiveRank(roles) {
  return roles.length === 0 ? 0 : Math.max(...roles.map((r) => r.rank));
}

// Permissions are the OR across every role held — if any one role you
// have grants canManageBugs, you have canManageBugs, full stop.
function permissionsFromRoles(roles) {
  const any = (key) => roles.some((r) => r[key]);

  // canViewDashboard is the gate every other dashboard permission sits
  // behind. Granting e.g. canManageBugs without it would silently do
  // nothing — easy to do by accident when setting up a custom role — so
  // any other dashboard power implies view access too.
  const impliesView =
    any('canManageBugs') || any('canPingTesters') || any('canArchive') || any('canEditReports') ||
    any('canDeleteReports') || any('canShareDashboard') || any('canKickMembers') || any('canBanMembers') ||
    any('canManageRoles') || any('canManageSettings');

  return {
    source: 'member',
    canSubmitBugs: any('canSubmitBugs'),
    canViewDashboard: any('canViewDashboard') || impliesView,
    canManageBugs: any('canManageBugs'),
    canPingTesters: any('canPingTesters'),
    canArchive: any('canArchive'),
    canEditReports: any('canEditReports'),
    canDeleteReports: any('canDeleteReports'),
    canShareDashboard: any('canShareDashboard'),
    canKickMembers: any('canKickMembers'),
    canBanMembers: any('canBanMembers'),
    canManageRoles: any('canManageRoles'),
    canManageSettings: any('canManageSettings'),
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
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server || !server.isActive) return null;

  const membership = await getMembership(serverId, discordId);
  if (membership) return permissionsFromRoles(rolesOf(membership));

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
    where: { userId: user.id, server: { isActive: true } },
    include: { server: true, roles: { include: { role: true } } },
  });

  const guestAccesses = await prisma.guestAccess.findMany({
    where: { userId: user.id, shareLink: { revokedAt: null }, server: { isActive: true } },
    include: { server: true, shareLink: true },
  });

  return [
    ...memberships.map((m) => ({ server: m.server, permissions: permissionsFromRoles(rolesOf(m)) })),
    ...guestAccesses.map((g) => ({ server: g.server, permissions: permissionsFromShareLink(g.shareLink) })),
  ];
}

// Adds a role to whatever someone already holds — does not replace or
// touch their other roles, exactly like Discord: a Dev can hand the
// Tester tag to someone who also holds Owner, without that grant
// affecting their Owner role at all. The check is purely about the role
// being granted, not about what else the target holds.
async function grantRole({ serverId, actingDiscordId, targetDiscordId, roleId }) {
  const acting = await getMembership(serverId, actingDiscordId);
  const actingPerms = acting ? permissionsFromRoles(rolesOf(acting)) : null;
  if (!actingPerms?.canManageRoles) throw new Error('Not permitted to manage roles in this server.');

  if (await isBanned(serverId, targetDiscordId)) {
    throw new Error('That person is banned from this server — unban them first.');
  }

  // No separate "can't touch the owner" rule needed here — the rank
  // check below already makes the Owner role itself untouchable by
  // anyone who doesn't already hold rank 100, which is the actual
  // protection. A lower role (e.g. Tester) can still be freely granted
  // to the owner without affecting their Owner role at all.
  const role = await prisma.role.findFirst({ where: { id: roleId, serverId } });
  if (!role) throw new Error('That role does not belong to this server.');
  if (role.rank >= effectiveRank(rolesOf(acting))) {
    throw new Error('Cannot grant a role at or above your own rank.');
  }

  const targetUser = await prisma.user.findUnique({ where: { discordId: targetDiscordId } });
  if (!targetUser) throw new Error('That person has not verified yet.');

  const membership = await prisma.membership.upsert({
    where: { userId_serverId: { userId: targetUser.id, serverId } },
    update: {},
    create: { userId: targetUser.id, serverId },
  });

  await prisma.memberRole.upsert({
    where: { membershipId_roleId: { membershipId: membership.id, roleId: role.id } },
    update: {},
    create: { membershipId: membership.id, roleId: role.id },
  });

  await logAction(serverId, actingDiscordId, 'ROLE_GRANTED', { target: targetDiscordId, role: role.name });
  return getMembership(serverId, targetDiscordId);
}

// Removes one specific role, leaving everything else the target holds
// untouched. If that was their last role, the membership itself is
// cleaned up too — holding zero roles isn't meaningfully "being a
// member" of anything.
async function revokeRole({ serverId, actingDiscordId, targetDiscordId, roleId }) {
  const acting = await getMembership(serverId, actingDiscordId);
  const actingPerms = acting ? permissionsFromRoles(rolesOf(acting)) : null;
  if (!actingPerms?.canManageRoles) throw new Error('Not permitted to manage roles in this server.');

  // Same reasoning as grantRole: the rank check below already makes the
  // Owner role itself untouchable by anyone who doesn't hold rank 100
  // (including the owner trying to self-revoke it, since the check uses
  // >=) — that's the real protection. A lower role can still be freely
  // revoked from the owner without affecting their Owner role.
  const role = await prisma.role.findFirst({ where: { id: roleId, serverId } });
  if (!role) throw new Error('That role does not belong to this server.');
  if (role.rank >= effectiveRank(rolesOf(acting))) {
    throw new Error('Cannot revoke a role at or above your own rank.');
  }

  const target = await getMembership(serverId, targetDiscordId);
  if (!target || !target.roles.some((mr) => mr.roleId === roleId)) {
    throw new Error('That person does not hold this role.');
  }

  await prisma.memberRole.deleteMany({ where: { membershipId: target.id, roleId } });
  await logAction(serverId, actingDiscordId, 'ROLE_REVOKED', { target: targetDiscordId, role: role.name });

  const remaining = await prisma.memberRole.count({ where: { membershipId: target.id } });
  if (remaining === 0) {
    await prisma.membership.deleteMany({ where: { id: target.id } });
  }
}

// Every member currently in this server, with all their held roles, for
// the roles/members page. Sorted by effective (highest) rank — can't
// express "max across a relation" as a database orderBy, so sorted here.
async function listMembers(serverId) {
  const memberships = await prisma.membership.findMany({
    where: { serverId },
    include: { user: true, roles: { include: { role: true } } },
  });
  return memberships.sort((a, b) => effectiveRank(rolesOf(b)) - effectiveRank(rolesOf(a)));
}

async function listBannedMembers(serverId) {
  return prisma.bannedMember.findMany({ where: { serverId }, orderBy: { bannedAt: 'desc' } });
}

// Removes ALL of someone's roles without a permanent ban — they could
// be re-added later without anyone needing to unban them first.
async function kickMember({ serverId, actingDiscordId, targetDiscordId }) {
  const acting = await getMembership(serverId, actingDiscordId);
  const actingPerms = acting ? permissionsFromRoles(rolesOf(acting)) : null;
  if (!actingPerms?.canKickMembers) throw new Error('Not permitted to kick members in this server.');

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (server.ownerDiscordId === targetDiscordId) {
    throw new Error('Cannot kick the server owner — transfer ownership first.');
  }

  const target = await getMembership(serverId, targetDiscordId);
  if (target && effectiveRank(rolesOf(target)) >= effectiveRank(rolesOf(acting))) {
    throw new Error('Cannot kick someone at or above your own rank.');
  }

  if (target) {
    await prisma.memberRole.deleteMany({ where: { membershipId: target.id } });
    await prisma.membership.deleteMany({ where: { id: target.id } });
  }
  await logAction(serverId, actingDiscordId, 'MEMBER_KICKED', { target: targetDiscordId });
}

// Removes membership (if any) and blocks the person from being added
// back until unbanned.
async function banMember({ serverId, actingDiscordId, targetDiscordId, reason }) {
  const acting = await getMembership(serverId, actingDiscordId);
  const actingPerms = acting ? permissionsFromRoles(rolesOf(acting)) : null;
  if (!actingPerms?.canBanMembers) throw new Error('Not permitted to ban members in this server.');

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (server.ownerDiscordId === targetDiscordId) {
    throw new Error('Cannot ban the server owner — transfer ownership first.');
  }

  const target = await getMembership(serverId, targetDiscordId);
  if (target && effectiveRank(rolesOf(target)) >= effectiveRank(rolesOf(acting))) {
    throw new Error('Cannot ban someone at or above your own rank.');
  }

  if (target) {
    await prisma.memberRole.deleteMany({ where: { membershipId: target.id } });
    await prisma.membership.deleteMany({ where: { id: target.id } });
  }
  await prisma.bannedMember.upsert({
    where: { serverId_discordId: { serverId, discordId: targetDiscordId } },
    update: { reason, bannedByDiscordId: actingDiscordId, bannedAt: new Date() },
    create: { serverId, discordId: targetDiscordId, bannedByDiscordId: actingDiscordId, reason },
  });
  await logAction(serverId, actingDiscordId, 'MEMBER_BANNED', { target: targetDiscordId, reason });
}

async function unbanMember({ serverId, actingDiscordId, targetDiscordId }) {
  const acting = await getMembership(serverId, actingDiscordId);
  const actingPerms = acting ? permissionsFromRoles(rolesOf(acting)) : null;
  if (!actingPerms?.canBanMembers) throw new Error('Not permitted to unban members in this server.');

  await prisma.bannedMember.deleteMany({ where: { serverId, discordId: targetDiscordId } });
  await logAction(serverId, actingDiscordId, 'MEMBER_UNBANNED', { target: targetDiscordId });
}

// ---- Roles -------------------------------------------------------------

async function listRoles(serverId) {
  return prisma.role.findMany({ where: { serverId }, orderBy: { rank: 'desc' } });
}

// Can only create a role at a rank strictly below your own — same
// ceiling logic as granting, applied to minting the role itself.
async function createRole({ serverId, actingDiscordId, name, rank, permissions = {} }) {
  const acting = await getMembership(serverId, actingDiscordId);
  const actingPerms = acting ? permissionsFromRoles(rolesOf(acting)) : null;
  if (!actingPerms?.canManageRoles) throw new Error('Not permitted to manage roles in this server.');
  if (rank >= effectiveRank(rolesOf(acting))) throw new Error('Cannot create a role at or above your own rank.');

  const existing = await prisma.role.findFirst({ where: { serverId, name } });
  if (existing) throw new Error(`A role named "${name}" already exists in this server.`);

  const role = await prisma.role.create({ data: { serverId, name, rank, ...permissions } });
  await logAction(serverId, actingDiscordId, 'ROLE_CREATED', { role: name, rank });
  return role;
}

async function updateRolePermissions({ serverId, actingDiscordId, roleId, permissions }) {
  const acting = await getMembership(serverId, actingDiscordId);
  const actingPerms = acting ? permissionsFromRoles(rolesOf(acting)) : null;
  if (!actingPerms?.canManageRoles) throw new Error('Not permitted to manage roles in this server.');
  const actingRank = effectiveRank(rolesOf(acting));

  const target = await prisma.role.findFirst({ where: { id: roleId, serverId } });
  if (!target) throw new Error('That role does not belong to this server.');
  if (target.rank >= actingRank) throw new Error('Cannot edit a role at or above your own rank.');
  if (permissions.rank !== undefined && permissions.rank >= actingRank) {
    throw new Error('Cannot raise a role to your own rank or above.');
  }
  if (permissions.name !== undefined && permissions.name !== target.name) {
    const collision = await prisma.role.findFirst({ where: { serverId, name: permissions.name } });
    if (collision) throw new Error(`A role named "${permissions.name}" already exists in this server.`);
  }

  const updated = await prisma.role.update({ where: { id: roleId }, data: permissions });
  await logAction(serverId, actingDiscordId, 'ROLE_UPDATED', { role: target.name });
  return updated;
}

async function deleteRole({ serverId, actingDiscordId, roleId }) {
  const acting = await getMembership(serverId, actingDiscordId);
  const actingPerms = acting ? permissionsFromRoles(rolesOf(acting)) : null;
  if (!actingPerms?.canManageRoles) throw new Error('Not permitted to manage roles in this server.');

  const target = await prisma.role.findFirst({ where: { id: roleId, serverId } });
  if (!target) throw new Error('That role does not belong to this server.');
  if (target.rank >= effectiveRank(rolesOf(acting))) throw new Error('Cannot delete a role at or above your own rank.');

  const inUse = await prisma.memberRole.count({ where: { roleId } });
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
    where: { serverId, hiddenAt: null },
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
    where: { serverId, weekStart: week, hiddenAt: null },
    include: { user: true },
    orderBy: { points: 'desc' },
  });
  return { weekStart: week, scores };
}

// Manual override for a dev correcting a score for reasons other than
// the automatic duplicate adjustment below — e.g. a penalty, or fixing
// a mistake. Gated on canManageBugs at the API layer.
async function adjustPointsManually({ serverId, actingDiscordId, targetDiscordId, delta }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canManageBugs) throw new Error('Not permitted to adjust points in this server.');

  const targetUser = await prisma.user.findUnique({ where: { discordId: targetDiscordId } });
  if (!targetUser) throw new Error('That person has not verified yet.');
  await adjustLeaderboardPoints(serverId, targetUser.id, delta);
  await adjustWeeklyPoints(serverId, targetUser.id, getWeekStart(new Date()), delta);
  await logAction(serverId, actingDiscordId, 'POINTS_ADJUSTED', { target: targetDiscordId, delta });
  return getLeaderboard(serverId);
}

// ---- Bug reports -------------------------------------------------------

// Rejects dangerous URI schemes (javascript:, data:, vbscript:, etc.) in
// user-submitted links. This matters specifically because these values
// get rendered as a real, clickable <a href> on the dashboard
// (evidenceLinkHtml in board.js) — HTML-escaping alone does NOT stop a
// "javascript:" URL from executing when clicked, since escaping only
// protects against markup injection, not dangerous URI schemes. Found
// during an extensive security re-audit; evidence/F9 links previously
// had zero format validation anywhere.
function isSafeLinkUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function createBugReport(serverId, reporterDiscordId, data) {
  if (await isBanned(serverId, reporterDiscordId)) {
    throw new Error('You are banned from this server.');
  }

  const membership = await getMembership(serverId, reporterDiscordId);
  const perms = membership ? permissionsFromRoles(rolesOf(membership)) : null;
  if (!perms?.canSubmitBugs) {
    throw new Error('You do not have permission to report bugs in this server.');
  }

  // Allowlisted rather than spreading `data` directly — a caller passing
  // an extra internal field (this exact bug already happened once, via a
  // draft-store bookkeeping field leaking in) should be silently dropped
  // here, not threaded through to the database.
  const allowedFields = [
    'title', 'description', 'stepsToReproduce', 'device',
    'evidenceFileUrl', 'evidenceLink', 'f9FileUrl', 'f9Link',
    'additionalInfo', 'priority', 'status', 'createdAt',
  ];
  const reportData = {};
  for (const field of allowedFields) {
    if (data[field] !== undefined) reportData[field] = data[field];
  }

  // Only the *Link fields (typed by hand in the Discord modal) need this
  // check — the *FileUrl fields, if ever used again, would come from a
  // trusted upload pipeline rather than raw user text.
  if (reportData.evidenceLink !== undefined && !isSafeLinkUrl(reportData.evidenceLink)) {
    throw new Error('Evidence link must be a valid http:// or https:// URL.');
  }
  if (reportData.f9Link !== undefined && !isSafeLinkUrl(reportData.f9Link)) {
    throw new Error('F9 link must be a valid http:// or https:// URL.');
  }

  // Atomic increment on a single row — Prisma translates { increment: 1 }
  // to a single UPDATE ... SET x = x + 1 statement, so two reports
  // submitted at the same instant still get distinct numbers even
  // without wrapping this in a $transaction (kept plain here so the
  // fake-Prisma test client, which doesn't implement $transaction,
  // still works against this function).
  const updatedServer = await prisma.server.update({
    where: { id: serverId },
    data: { nextBugNumber: { increment: 1 } },
  });
  const bugNumber = updatedServer.nextBugNumber - 1;

  const report = await prisma.bugReport.create({
    data: { serverId, reporterId: membership.userId, bugNumber, ...reportData },
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
// duplicate detection, so this just needs to be searchable by keyword
// and filterable by priority (the "tag" filtering testers were always
// meant to have, just via the bot rather than the web dashboard).
async function searchBugReports(serverId, { search, priority } = {}) {
  return prisma.bugReport.findMany({
    where: {
      serverId,
      archivedAt: null,
      ...(search ? { title: { contains: search } } : {}),
      ...(priority ? { priority } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
}

function startOfDayUTC(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// The one function behind /list-bugs, /my-bugs, /bugs-by, and the
// dashboard search bar — so "only non-archived/non-deleted", pagination,
// and date/text/author filtering all live in exactly one place instead
// of drifting across four separate implementations.
//
// Reports from people who've left the server still show up here (they're
// still real BugReport + User rows — only Membership is affected by
// leaving, and this never joins through Membership), which is the
// explicit requirement: data preserved in lists, only the leaderboard
// hides them.
async function queryBugReports(serverId, options = {}) {
  const {
    reporterDiscordId,   // exact-match: for /my-bugs and /bugs-by
    byUsername,          // partial-match on reporter's username: for the search bar's by: token
    priority,
    status,
    archived = false,    // "non-archived, non-deleted" is the default everywhere
    search,              // free text, matches title OR description
    before, on, after,   // 'YYYY-MM-DD' strings
    device,
    page = 1,
    pageSize = 10,
  } = options;

  const where = {
    serverId,
    archivedAt: archived ? { not: null } : null,
    ...(priority ? { priority } : {}),
    ...(status ? { status } : {}),
    ...(device ? { device } : {}),
  };

  if (reporterDiscordId) {
    const user = await prisma.user.findUnique({ where: { discordId: reporterDiscordId } });
    if (!user) return { reports: [], page, pageSize, totalCount: 0, totalPages: 0 };
    where.reporterId = user.id;
  }
  if (byUsername) {
    where.reporter = { discordUsername: { contains: byUsername } };
  }
  if (search) {
    where.OR = [{ title: { contains: search } }, { description: { contains: search } }];
  }

  const createdAt = {};
  if (on) {
    const start = startOfDayUTC(on);
    if (start) {
      createdAt.gte = start;
      createdAt.lt = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    }
  }
  if (before) {
    const start = startOfDayUTC(before);
    if (start) createdAt.lt = createdAt.lt ? new Date(Math.min(createdAt.lt.getTime(), start.getTime())) : start;
  }
  if (after) {
    const start = startOfDayUTC(after);
    if (start) {
      const boundary = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      createdAt.gte = createdAt.gte ? new Date(Math.max(createdAt.gte.getTime(), boundary.getTime())) : boundary;
    }
  }
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

  const totalCount = await prisma.bugReport.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const reports = await prisma.bugReport.findMany({
    where,
    include: { reporter: true },
    orderBy: { createdAt: 'desc' },
    skip: (safePage - 1) * pageSize,
    take: pageSize,
  });

  return { reports, page: safePage, pageSize, totalCount, totalPages };
}

// How many bugs this person has ever reported in this server — used for
// the "@user reported their Xth bug" announcement. Counts archived
// reports too (archiving isn't un-reporting it); deleted reports are
// physically gone from the table already, so they're excluded for free.
async function countBugReportsByReporter(serverId, reporterDiscordId) {
  const user = await prisma.user.findUnique({ where: { discordId: reporterDiscordId } });
  if (!user) return 0;
  return prisma.bugReport.count({ where: { serverId, reporterId: user.id } });
}

// Returns the configured Discord role ids for a command in this server —
// an empty array means "not overridden", i.e. fall back to the bot's
// existing internal permission checks exactly as before this feature
// existed.
async function getCommandRoleOverride(serverId, commandName) {
  const rows = await prisma.commandPermission.findMany({ where: { serverId, commandName } });
  return rows.map((r) => r.discordRoleId);
}

// All configured overrides for a server, for the dashboard's permission
// page — grouped by command so the UI doesn't have to.
async function listCommandPermissions(serverId) {
  const rows = await prisma.commandPermission.findMany({ where: { serverId } });
  const byCommand = {};
  for (const row of rows) {
    if (!byCommand[row.commandName]) byCommand[row.commandName] = [];
    byCommand[row.commandName].push(row.discordRoleId);
  }
  return byCommand;
}

// Replace-all semantics for one command: pass the full desired list of
// allowed Discord role ids (an empty array clears the override,
// returning that command to the default internal-permission behavior).
// This is deliberately simpler than incremental add/remove — the UI
// always shows and submits the complete current state for a command,
// so there's no drift between what's displayed and what's stored.
async function setCommandPermissions({ serverId, actingDiscordId, commandName, discordRoleIds }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canManageSettings) throw new Error('Not permitted to manage command permissions in this server.');

  // Dedupe (and drop empty/falsy entries) before writing — without this,
  // a request containing the same role id twice (e.g. a malformed
  // client request, or a direct API call bypassing the dashboard's own
  // checkbox-driven Set) would crash on the second insert, since
  // (serverId, commandName, discordRoleId) is a unique constraint. A
  // duplicate role id is meaningless anyway — "allowed" isn't a count.
  const uniqueRoleIds = [...new Set(discordRoleIds.filter(Boolean))];

  await prisma.commandPermission.deleteMany({ where: { serverId, commandName } });
  for (const discordRoleId of uniqueRoleIds) {
    await prisma.commandPermission.create({ data: { serverId, commandName, discordRoleId } });
  }
  return getCommandRoleOverride(serverId, commandName);
}

async function getBugReportByNumber(serverId, bugNumber) {
  return prisma.bugReport.findFirst({ where: { serverId, bugNumber: Number(bugNumber) }, include: { reporter: true } });
}

// Powers the public, unauthenticated /r/:reportId readable-view page —
// deliberately returns only what's safe to show to anyone who has the
// (unguessable cuid) link, same trust model as the existing ShareLink
// feature. Evidence/F9 links and internal IDs are NOT included here;
// those still require real dashboard access.
async function getBugReportPublic(reportId) {
  const report = await prisma.bugReport.findFirst({ where: { id: reportId }, include: { reporter: true } });
  if (!report) return null;
  const server = await prisma.server.findFirst({ where: { id: report.serverId } });
  return {
    id: report.id,
    serverId: report.serverId,
    serverName: server?.name || 'Unknown server',
    bugNumber: report.bugNumber,
    title: report.title,
    description: report.description,
    stepsToReproduce: report.stepsToReproduce,
    device: report.device,
    priority: report.priority,
    status: report.status,
    createdAt: report.createdAt,
    reporterUsername: report.reporter?.discordUsername || 'unknown',
  };
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

async function listBugReports(serverId, { priority, status, archivedOnly = false } = {}) {
  return prisma.bugReport.findMany({
    where: {
      serverId,
      ...(priority ? { priority } : {}),
      ...(status ? { status } : {}),
      archivedAt: archivedOnly ? { not: null } : null,
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
// Also re-derives permissions itself rather than trusting the caller to
// have pre-filtered requestedChanges — status/priority needs canManageBugs,
// content fields need canEditReports, checked here regardless of what the
// route layer already did.
// Also handles the leaderboard side-effect of a status moving into or
// out of DUPLICATE — exactly one point deducted/refunded per report,
// ever, tracked via pointDeducted so flapping the status back and forth
// can't double-charge or double-refund.
async function updateBugReport({ serverId, actingDiscordId, bugReportId, requestedChanges }) {
  const existing = await prisma.bugReport.findFirst({ where: { id: bugReportId, serverId } });
  if (!existing) throw new Error('Bug report not found in this server.');

  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  const data = {};

  if (perms?.canManageBugs) {
    if (requestedChanges.priority !== undefined) data.priority = requestedChanges.priority;
    if (requestedChanges.status !== undefined) data.status = requestedChanges.status;
  }
  if (perms?.canEditReports) {
    for (const field of ['title', 'description', 'stepsToReproduce', 'device', 'additionalInfo']) {
      if (requestedChanges[field] !== undefined) data[field] = requestedChanges[field];
    }
  }
  if (perms?.canPingTesters) {
    if (requestedChanges.retestMessageId !== undefined) data.retestMessageId = requestedChanges.retestMessageId;
    if (requestedChanges.retestThreadId !== undefined) data.retestThreadId = requestedChanges.retestThreadId;
  }
  if (perms?.canArchive && requestedChanges.archivedAt !== undefined) {
    const terminal = ['FIXED', 'NOT_A_BUG', 'DUPLICATE', 'WONT_FIX'];
    if (!terminal.includes(data.status || existing.status)) {
      throw new Error("Status must be Fixed, Not a bug, Duplicate, or Won't fix before archiving.");
    }
    data.archivedAt = requestedChanges.archivedAt;
  }

  if (Object.keys(data).length === 0) {
    throw new Error('Not permitted to make this change here.');
  }

  if (data.status && data.status !== existing.status) {
    const reportWeek = getWeekStart(existing.createdAt);
    if (data.status === 'DUPLICATE' && !existing.pointDeducted) {
      await adjustLeaderboardPoints(serverId, existing.reporterId, -1);
      await adjustWeeklyPoints(serverId, existing.reporterId, reportWeek, -1);
      data.pointDeducted = true;
    } else if (existing.status === 'DUPLICATE' && data.status !== 'DUPLICATE' && existing.pointDeducted) {
      await adjustLeaderboardPoints(serverId, existing.reporterId, 1);
      await adjustWeeklyPoints(serverId, existing.reporterId, reportWeek, 1);
      data.pointDeducted = false;
    }
  }

  await prisma.bugReport.updateMany({ where: { id: bugReportId, serverId }, data });
  return prisma.bugReport.findUnique({ where: { id: bugReportId } });
}

// Permanent — for obvious spam/troll reports that shouldn't even sit in
// the 15-day archive window. Distinct from archiving, which is meant to
// be a soft, temporary state. Self-checks canDeleteReports rather than
// trusting the route to have already gated this.
async function deleteBugReport({ serverId, actingDiscordId, bugReportId }) {
  const perms = await getEffectivePermissions(serverId, actingDiscordId);
  if (!perms?.canDeleteReports) throw new Error('Not permitted to delete reports in this server.');

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
  deactivateServer,
  removeMembershipOnLeave,
  restoreLeaderboardVisibilityOnRejoin,
  resetLeaderboardScore,
  getServerById,
  updateServerSettings,
  updateServerAppearance,
  isValidBackgroundStyle,
  getUserByDiscordId,
  verifyUser,
  assignOwnerRole,
  transferOwnership,
  getMembership,
  rolesOf,
  effectiveRank,
  permissionsFromRoles,
  getEffectivePermissions,
  listAccessibleServers,
  grantRole,
  revokeRole,
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
  isSafeLinkUrl,
  searchBugReports,
  queryBugReports,
  getBugReportByNumber,
  countBugReportsByReporter,
  getCommandRoleOverride,
  listCommandPermissions,
  setCommandPermissions,
  getBugReportPublic,
  listMyBugReports,
  getBugReport,
  listBugReports,
  updateBugReport,
  deleteBugReport,
  getReportSummary,
  deleteExpiredArchivedReports,
  getLeaderboard,
  getWeeklyLeaderboard,
  getWeekStart,
  adjustPointsManually,
};

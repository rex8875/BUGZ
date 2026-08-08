const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');
const { withDiscordRoles } = require('./helpers/discordRoleMock');

const TESTER_ROLE = 'tester-discord-role';

// The whole point of the Discord-role-linked model (vs. the old stored
// Membership/bot-role system) is that access is derived LIVE from
// current Discord roles on every check -- there's no separate "grant"
// step to undo, so taking the role away in Discord should be
// sufficient on its own, with no lag and no separate bot-side cleanup
// action required.

test('removing a person\'s Discord role immediately revokes every permission that role granted (canViewDashboard, canSubmitBugs, canManageBugs)', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
  await db.setRolePermissions({
    serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE,
    permissions: { canSubmitBugs: true, canViewDashboard: true, canManageBugs: true },
  });

  // While holding the role: full access, as configured.
  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'tester1');
    assert.equal(perms.canViewDashboard, true, 'sanity check: role grants dashboard access while held');
    assert.equal(perms.canSubmitBugs, true);
    assert.equal(perms.canManageBugs, true);
  });

  // Same person, same server, role now removed (they still hold NO
  // Discord role at all here) -- every flag that role granted must now
  // be gone. Nothing on our side needs to be told about this
  // separately; the very next live check reflects it automatically.
  await withDiscordRoles({ tester1: [] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'tester1');
    assert.equal(perms, null, 'holding zero roles and no other standing means no access at all');
  });
});

test('removing the role blocks the action it used to allow, not just the permission flag', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'tester1', discordUsername: 'Tester1' });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });

  await withDiscordRoles({ tester1: [TESTER_ROLE] }, async () => {
    await assert.doesNotReject(() => db.createBugReport(server.id, 'tester1', {
      title: 'Before revoke', description: 'd', priority: 'LOW', device: 'PC', evidenceLink: 'https://x.com', f9Link: 'https://x.com',
    }));
  });

  await withDiscordRoles({ tester1: [] }, async () => {
    await assert.rejects(
      () => db.createBugReport(server.id, 'tester1', {
        title: 'After revoke', description: 'd', priority: 'LOW', device: 'PC', evidenceLink: 'https://x.com', f9Link: 'https://x.com',
      }),
      /permission/i,
    );
  });

  const reports = await db.queryBugReports(server.id, { pageSize: 100 });
  assert.equal(reports.totalCount, 1, 'only the pre-revoke report should exist');
  assert.equal(reports.reports[0].title, 'Before revoke');
});

test('swapping roles mid-session (losing one, gaining a different one) reflects the NEW role\'s permissions immediately, not the old one\'s', async () => {
  const { db } = loadDbWithFakePrisma();
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.verifyUser({ discordId: 'user1', discordUsername: 'User1' });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: 'full-access-role', permissions: { canManageSettings: true, canBanMembers: true } });
  await db.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: 'read-only-role', permissions: { canViewDashboard: true } });

  await withDiscordRoles({ user1: ['full-access-role'] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'user1');
    assert.equal(perms.canManageSettings, true);
    assert.equal(perms.canBanMembers, true);
  });

  // The full-access role was taken away and a different, much weaker
  // role given instead -- e.g. a demotion in Discord.
  await withDiscordRoles({ user1: ['read-only-role'] }, async () => {
    const perms = await db.getEffectivePermissions(server.id, 'user1');
    assert.equal(perms.canManageSettings, false, 'old role\'s elevated permissions must not linger');
    assert.equal(perms.canBanMembers, false);
    assert.equal(perms.canViewDashboard, true, 'new role\'s permissions should apply immediately');
  });
});

test('removing a role that was configured with a per-command override also revokes that specific command\'s access', async () => {
  const { db } = loadDbWithFakePrisma();
  const { checkCommandAccess } = require('../../../apps/bot/src/lib/commandAccess.js');
  const server = await db.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
  await db.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
  await db.setCommandPermissions({ serverId: server.id, actingDiscordId: 'owner1', commandName: 'reset-score', discordRoleIds: ['qa-role'] });

  const withRole = { guildId: 'g1', user: { id: 'qa-person' }, member: { permissions: { has: () => false }, roles: { cache: new Map([['qa-role', {}]]) } } };
  const withoutRole = { guildId: 'g1', user: { id: 'qa-person' }, member: { permissions: { has: () => false }, roles: { cache: new Map() } } };

  const before = await checkCommandAccess(withRole, 'reset-score');
  assert.equal(before.allowed, true, 'sanity check: holding the configured role allows the restricted command');

  const after = await checkCommandAccess(withoutRole, 'reset-score');
  assert.equal(after.allowed, false, 'losing the configured role blocks the restricted command on the very next attempt');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakePrismaClient } = require('./fakePrismaClient');

test('create + findUnique by id and by a unique field', () => {
  const db = createFakePrismaClient();
  const user = db.user.create({ data: { discordId: 'd1', discordUsername: 'Alice' } });
  assert.equal(db.user.findUnique({ where: { id: user.id } }).discordUsername, 'Alice');
  assert.equal(db.user.findUnique({ where: { discordId: 'd1' } }).discordUsername, 'Alice');
  assert.equal(db.user.findUnique({ where: { discordId: 'nope' } }), null);
});

test('compound unique key matching for findUnique and upsert', () => {
  const db = createFakePrismaClient();
  db.rolePermission.create({ data: { serverId: 's1', discordRoleId: 'r1', canViewDashboard: true } });

  const found = db.rolePermission.findUnique({ where: { serverId_discordRoleId: { serverId: 's1', discordRoleId: 'r1' } } });
  assert.ok(found, 'should find by compound key');

  db.rolePermission.upsert({
    where: { serverId_discordRoleId: { serverId: 's1', discordRoleId: 'r1' } },
    update: { canManageBugs: true },
    create: { serverId: 's1', discordRoleId: 'r1', canManageBugs: false },
  });
  assert.equal(
    db.rolePermission.findUnique({ where: { serverId_discordRoleId: { serverId: 's1', discordRoleId: 'r1' } } }).canManageBugs,
    true,
    'upsert should update the existing row, not create a second one',
  );

  db.rolePermission.upsert({
    where: { serverId_discordRoleId: { serverId: 's1', discordRoleId: 'r2' } },
    update: { canManageBugs: 'should-not-apply' },
    create: { serverId: 's1', discordRoleId: 'r2', canManageBugs: true },
  });
  assert.equal(
    db.rolePermission.findUnique({ where: { serverId_discordRoleId: { serverId: 's1', discordRoleId: 'r2' } } }).canManageBugs,
    true,
    'upsert should create when no existing row matches',
  );
});

test('upsert increment syntax accumulates correctly', () => {
  const db = createFakePrismaClient();
  db.leaderboardScore.upsert({
    where: { serverId_userId: { serverId: 's1', userId: 'u1' } },
    update: { points: { increment: 1 } },
    create: { serverId: 's1', userId: 'u1', points: 1 },
  });
  db.leaderboardScore.upsert({
    where: { serverId_userId: { serverId: 's1', userId: 'u1' } },
    update: { points: { increment: 1 } },
    create: { serverId: 's1', userId: 'u1', points: 1 },
  });
  db.leaderboardScore.upsert({
    where: { serverId_userId: { serverId: 's1', userId: 'u1' } },
    update: { points: { increment: -1 } },
    create: { serverId: 's1', userId: 'u1', points: 1 },
  });
  const score = db.leaderboardScore.findUnique({ where: { serverId_userId: { serverId: 's1', userId: 'u1' } } });
  assert.equal(score.points, 1);
});

test('relation filtering in where (belongsTo nested condition)', () => {
  const db = createFakePrismaClient();
  const user = db.user.create({ data: { discordId: 'd1' } });
  db.bugReport.create({ data: { bugNumber: 1, serverId: 's1', title: 't', reporterId: user.id } });

  const found = db.bugReport.findFirst({ where: { serverId: 's1', reporter: { discordId: 'd1' } } });
  assert.ok(found, 'should resolve the belongsTo relation and match on its field');

  const notFound = db.bugReport.findFirst({ where: { serverId: 's1', reporter: { discordId: 'wrong' } } });
  assert.equal(notFound, null);
});

test('operators: not, lt, contains', () => {
  const db = createFakePrismaClient();
  db.bugReport.create({ data: { bugNumber: 1, serverId: 's1', title: 'Floor breaks', archivedAt: null, createdAt: new Date('2026-01-01') } });
  db.bugReport.create({ data: { bugNumber: 2, serverId: 's1', title: 'Wall clips', archivedAt: new Date('2026-01-05'), createdAt: new Date('2026-01-05') } });

  assert.equal(db.bugReport.findMany({ where: { archivedAt: null } }).length, 1);
  assert.equal(db.bugReport.findMany({ where: { archivedAt: { not: null } } }).length, 1);
  assert.equal(db.bugReport.findMany({ where: { title: { contains: 'floor' } } }).length, 1, 'contains should be case-insensitive');
  assert.equal(
    db.bugReport.findMany({ where: { archivedAt: { not: null, lt: new Date('2026-01-10') } } }).length,
    1,
  );
  assert.equal(
    db.bugReport.findMany({ where: { archivedAt: { not: null, lt: new Date('2026-01-02') } } }).length,
    0,
    'lt should exclude rows past the cutoff',
  );
});

test('include resolves belongsTo and hasMany, including nested includes', () => {
  const db = createFakePrismaClient();
  const server = db.server.create({ data: { discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' } });
  db.rolePermission.create({ data: { serverId: server.id, discordRoleId: 'r1', canManageSettings: true } });
  const link = db.shareLink.create({ data: { serverId: server.id, accessLevel: 'VIEW', createdByDiscordId: 'owner1' } });
  const user = db.user.create({ data: { discordId: 'guest1' } });
  db.guestAccess.create({ data: { shareLinkId: link.id, serverId: server.id, userId: user.id } });

  const withRolePerms = db.server.findFirst({ where: { id: server.id }, include: { rolePermissions: true } });
  assert.equal(withRolePerms.rolePermissions.length, 1, 'hasMany include should attach the joined RolePermission rows');
  assert.equal(withRolePerms.rolePermissions[0].discordRoleId, 'r1', 'nested belongsTo include should resolve');

  const linkWithGuests = db.shareLink.findFirst({ where: { id: link.id }, include: { guestAccess: { include: { user: true } } } });
  assert.equal(linkWithGuests.guestAccess.length, 1);
  assert.equal(linkWithGuests.guestAccess[0].user.discordId, 'guest1', 'nested include should resolve two levels deep');
});

test('nested create on hasMany relation (server.create with rolePermissions: { create: [...] })', () => {
  const db = createFakePrismaClient();
  const server = db.server.create({
    data: {
      discordServerId: 'g1',
      name: 'Test',
      ownerDiscordId: 'owner1',
      rolePermissions: { create: [{ discordRoleId: 'r1' }, { discordRoleId: 'r2' }] },
    },
  });
  const rolePermissions = db.rolePermission.findMany({ where: { serverId: server.id } });
  assert.equal(rolePermissions.length, 2);
  assert.ok(rolePermissions.every((r) => r.serverId === server.id), 'nested-created rows should carry the foreign key');
});

test('orderBy: simple field and nested relation field', () => {
  const db = createFakePrismaClient();
  db.bugReport.create({ data: { bugNumber: 3, serverId: 's1', title: 'a', createdAt: new Date('2026-01-01') } });
  db.bugReport.create({ data: { bugNumber: 4, serverId: 's1', title: 'b', createdAt: new Date('2026-01-03') } });
  db.bugReport.create({ data: { bugNumber: 5, serverId: 's1', title: 'c', createdAt: new Date('2026-01-02') } });

  const desc = db.bugReport.findMany({ where: { serverId: 's1' }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual(desc.map((r) => r.title), ['b', 'c', 'a']);

  // guestAccess -> server is a belongsTo relation, so it's a natural
  // pairing to test nested orderBy against a numeric related field.
  const serverLow = db.server.create({ data: { discordServerId: 'gLow', name: 'Low', ownerDiscordId: 'o1', nextBugNumber: 1 } });
  const serverHigh = db.server.create({ data: { discordServerId: 'gHigh', name: 'High', ownerDiscordId: 'o2', nextBugNumber: 99 } });
  const link = db.shareLink.create({ data: { serverId: serverLow.id, accessLevel: 'VIEW', createdByDiscordId: 'o1' } });
  db.guestAccess.create({ data: { shareLinkId: link.id, serverId: serverLow.id, userId: 'u1' } });
  db.guestAccess.create({ data: { shareLinkId: link.id, serverId: serverHigh.id, userId: 'u2' } });

  const byNextBugNumber = db.guestAccess.findMany({ where: {}, orderBy: { server: { nextBugNumber: 'desc' } } });
  assert.equal(byNextBugNumber[0].serverId, serverHigh.id, 'nested relation orderBy should sort by the related record field');
});

test('updateMany, deleteMany, and count respect where filters (not just affect everything)', () => {
  const db = createFakePrismaClient();
  db.bugReport.create({ data: { bugNumber: 6, serverId: 's1', title: 'a', status: 'NEW' } });
  db.bugReport.create({ data: { bugNumber: 7, serverId: 's1', title: 'b', status: 'NEW' } });
  db.bugReport.create({ data: { bugNumber: 8, serverId: 's2', title: 'c', status: 'NEW' } });

  const { count: updateCount } = db.bugReport.updateMany({ where: { serverId: 's1' }, data: { status: 'FIXED' } });
  assert.equal(updateCount, 2);
  assert.equal(db.bugReport.findFirst({ where: { serverId: 's2' } }).status, 'NEW', 'server s2 must be untouched');

  const { count: deleteCount } = db.bugReport.deleteMany({ where: { serverId: 's1' } });
  assert.equal(deleteCount, 2);
  assert.equal(db.bugReport.count({ where: {} }), 1, 'only the s2 report should remain');
});

test('groupBy counts per distinct value of the grouping field', () => {
  const db = createFakePrismaClient();
  db.bugReport.create({ data: { bugNumber: 9, serverId: 's1', status: 'NEW', archivedAt: null } });
  db.bugReport.create({ data: { bugNumber: 10, serverId: 's1', status: 'NEW', archivedAt: null } });
  db.bugReport.create({ data: { bugNumber: 11, serverId: 's1', status: 'FIXED', archivedAt: null } });
  db.bugReport.create({ data: { bugNumber: 12, serverId: 's1', status: 'FIXED', archivedAt: new Date() } }); // archived, should be excluded by where

  const grouped = db.bugReport.groupBy({ by: ['status'], where: { serverId: 's1', archivedAt: null }, _count: true });
  const asMap = Object.fromEntries(grouped.map((g) => [g.status, g._count]));
  assert.deepEqual(asMap, { NEW: 2, FIXED: 1 });
});

test('create applies schema defaults for omitted fields', () => {
  const db = createFakePrismaClient();
  const rolePermission = db.rolePermission.create({ data: { serverId: 's1', discordRoleId: 'r1' } });
  assert.equal(rolePermission.canSubmitBugs, true, 'matches @default(true) in schema.prisma');
  assert.equal(rolePermission.canManageBugs, false, 'matches @default(false)');
  assert.equal(rolePermission.canManageSettings, false, 'matches @default(false)');
});

test('explicit values in create() override schema defaults', () => {
  const db = createFakePrismaClient();
  const rolePermission = db.rolePermission.create({ data: { serverId: 's1', discordRoleId: 'r1', canManageSettings: true } });
  assert.equal(rolePermission.canManageSettings, true);
  assert.equal(rolePermission.canSubmitBugs, true, 'default still applies to fields not explicitly given');
});

test('hasMany relation filter: none — matches records with zero related rows satisfying the nested condition', () => {
  const db = createFakePrismaClient();
  const serverA = db.server.create({ data: { discordServerId: 'gA', name: 'A', ownerDiscordId: 'ownerA' } });
  const serverB = db.server.create({ data: { discordServerId: 'gB', name: 'B', ownerDiscordId: 'ownerB' } });
  db.rolePermission.create({ data: { serverId: serverA.id, discordRoleId: 'r1' } });

  // serverA has a rolePermission for r1 -> should NOT match "none such row"
  // serverB has no rolePermissions at all -> SHOULD match "none such row"
  const matches = db.server.findMany({ where: { rolePermissions: { none: { discordRoleId: 'r1' } } } });
  const ids = matches.map((s) => s.id);
  assert.ok(!ids.includes(serverA.id), 'server with a matching rolePermission should be excluded');
  assert.ok(ids.includes(serverB.id), 'server with no matching rolePermission should be included');
});


test('querying for null matches a field that was never set, not just one explicitly set to null', () => {
  const db = createFakePrismaClient();
  db.shareLink.create({ data: { serverId: 's1', accessLevel: 'VIEW', createdByDiscordId: 'owner1' } }); // revokedAt omitted entirely
  const found = db.shareLink.findFirst({ where: { revokedAt: null } });
  assert.ok(found, 'an omitted nullable field should be queryable as null, matching real database behavior');
});

test('compound unique matching compares Date fields by value, not by object reference', () => {
  const db = createFakePrismaClient();
  db.weeklyScore.create({ data: { serverId: 's1', userId: 'u1', weekStart: new Date('2026-06-08T00:00:00Z'), points: 1 } });

  // A freshly-constructed Date representing the exact same instant —
  // deliberately a different object reference than the one stored above.
  const sameInstantDifferentObject = new Date('2026-06-08T00:00:00Z');
  const found = db.weeklyScore.findUnique({
    where: { serverId_userId_weekStart: { serverId: 's1', userId: 'u1', weekStart: sameInstantDifferentObject } },
  });
  assert.ok(found, 'two distinct Date objects representing the same instant must match, like a real database compares timestamps');
});

test('{ not: null } correctly excludes fields that were never set (undefined), not just ones explicitly set to null', () => {
  const db = createFakePrismaClient();
  db.bugReport.create({ data: { bugNumber: 13, serverId: 's1', title: 'never archived' } }); // archivedAt omitted entirely -> undefined
  db.bugReport.create({ data: { bugNumber: 14, serverId: 's1', title: 'archived', archivedAt: new Date('2026-01-01') } });

  const archivedOnly = db.bugReport.findMany({ where: { archivedAt: { not: null } } });
  assert.equal(archivedOnly.length, 1, 'an omitted field must be treated as null, so it should NOT satisfy "not null"');
  assert.equal(archivedOnly[0].title, 'archived');
});


test('create() throws on a compound-unique constraint violation, matching real database behavior', () => {
  const db = createFakePrismaClient();
  db.rolePermission.create({ data: { serverId: 's1', discordRoleId: 'r1' } });
  assert.throws(() => db.rolePermission.create({ data: { serverId: 's1', discordRoleId: 'r1' } }), /Unique constraint failed/);
  // Same discordRoleId, different server — must NOT collide, since the constraint is compound (serverId, discordRoleId)
  assert.doesNotThrow(() => db.rolePermission.create({ data: { serverId: 's2', discordRoleId: 'r1' } }));
});

test('create() throws on a single-field unique constraint violation', () => {
  const db = createFakePrismaClient();
  db.user.create({ data: { discordId: 'd1', discordUsername: 'Alice' } });
  assert.throws(() => db.user.create({ data: { discordId: 'd1', discordUsername: 'Someone else' } }), /Unique constraint failed/);
});

test('update() throws if changing a field would collide with a different existing row, but not when updating other fields on the same row', () => {
  const db = createFakePrismaClient();
  const permA = db.rolePermission.create({ data: { serverId: 's1', discordRoleId: 'r1' } });
  db.rolePermission.create({ data: { serverId: 's1', discordRoleId: 'r2' } });

  assert.doesNotThrow(() => db.rolePermission.update({ where: { id: permA.id }, data: { canManageBugs: true } }), 'updating an unrelated field on the same row must not trip the uniqueness check against itself');
  assert.throws(() => db.rolePermission.update({ where: { id: permA.id }, data: { discordRoleId: 'r2' } }), /Unique constraint failed/);
});


test('create() auto-populates createdAt-style fields when omitted, matching @default(now())', () => {
  const db = createFakePrismaClient();
  const report = db.bugReport.create({ data: { bugNumber: 15, serverId: 's1', title: 't' } });
  assert.ok(report.createdAt instanceof Date, 'createdAt should be auto-populated, not undefined');
});

test('records created in quick succession get strictly increasing timestamps, not identical ones', () => {
  const db = createFakePrismaClient();
  const a = db.bugReport.create({ data: { bugNumber: 16, serverId: 's1', title: 'a' } });
  const b = db.bugReport.create({ data: { bugNumber: 17, serverId: 's1', title: 'b' } });
  const c = db.bugReport.create({ data: { bugNumber: 18, serverId: 's1', title: 'c' } });
  assert.ok(a.createdAt.getTime() < b.createdAt.getTime());
  assert.ok(b.createdAt.getTime() < c.createdAt.getTime());
});

test('an explicitly provided timestamp is respected, not overwritten by the auto-now default', () => {
  const db = createFakePrismaClient();
  const explicit = new Date('2020-01-01T00:00:00Z');
  const report = db.bugReport.create({ data: { bugNumber: 19, serverId: 's1', title: 't', createdAt: explicit } });
  assert.equal(report.createdAt.getTime(), explicit.getTime());
});

test('update() and updateMany() bump @updatedAt-style fields automatically, regardless of what data was passed', () => {
  const db = createFakePrismaClient();
  const report = db.bugReport.create({ data: { bugNumber: 20, serverId: 's1', title: 't' } });
  const originalUpdatedAt = report.updatedAt;

  const updated = db.bugReport.update({ where: { id: report.id }, data: { title: 'changed' } });
  assert.ok(updated.updatedAt.getTime() > (originalUpdatedAt ? originalUpdatedAt.getTime() : 0));

  db.bugReport.updateMany({ where: { id: report.id }, data: { title: 'changed again' } });
  const afterMany = db.bugReport.findUnique({ where: { id: report.id } });
  assert.ok(afterMany.updatedAt.getTime() > updated.updatedAt.getTime());
});


test('server defaults isActive to true, matching @default(true)', () => {
  const db = createFakePrismaClient();
  const server = db.server.create({ data: { discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' } });
  assert.equal(server.isActive, true);
});

test('belongsTo relation filtering works through a relation name pointing at Server (guestAccess.server)', () => {
  const db = createFakePrismaClient();
  const activeServer = db.server.create({ data: { discordServerId: 'gActive', name: 'Active', ownerDiscordId: 'o1' } });
  const inactiveServer = db.server.create({ data: { discordServerId: 'gInactive', name: 'Inactive', ownerDiscordId: 'o2', isActive: false } });
  const linkActive = db.shareLink.create({ data: { serverId: activeServer.id, accessLevel: 'VIEW', createdByDiscordId: 'o1' } });
  const linkInactive = db.shareLink.create({ data: { serverId: inactiveServer.id, accessLevel: 'VIEW', createdByDiscordId: 'o2' } });

  db.guestAccess.create({ data: { shareLinkId: linkActive.id, serverId: activeServer.id, userId: 'u1' } });
  db.guestAccess.create({ data: { shareLinkId: linkInactive.id, serverId: inactiveServer.id, userId: 'u1' } });

  const onlyActive = db.guestAccess.findMany({ where: { userId: 'u1', server: { isActive: true } } });
  assert.equal(onlyActive.length, 1);
  assert.equal(onlyActive[0].serverId, activeServer.id);
});


test('each createFakePrismaClient() call is fully isolated from previous ones', () => {
  const dbA = createFakePrismaClient();
  dbA.user.create({ data: { discordId: 'only-in-a' } });
  const dbB = createFakePrismaClient();
  assert.equal(dbB.user.findMany({ where: {} }).length, 0, 'a fresh client must start empty regardless of other instances');
});

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
  db.membership.create({ data: { userId: 'u1', serverId: 's1', roleId: 'r1' } });

  const found = db.membership.findUnique({ where: { userId_serverId: { userId: 'u1', serverId: 's1' } } });
  assert.ok(found, 'should find by compound key');

  db.membership.upsert({
    where: { userId_serverId: { userId: 'u1', serverId: 's1' } },
    update: { roleId: 'r2' },
    create: { userId: 'u1', serverId: 's1', roleId: 'r9' },
  });
  assert.equal(
    db.membership.findUnique({ where: { userId_serverId: { userId: 'u1', serverId: 's1' } } }).roleId,
    'r2',
    'upsert should update the existing row, not create a second one',
  );

  db.membership.upsert({
    where: { userId_serverId: { userId: 'u2', serverId: 's1' } },
    update: { roleId: 'should-not-apply' },
    create: { userId: 'u2', serverId: 's1', roleId: 'r-new' },
  });
  assert.equal(
    db.membership.findUnique({ where: { userId_serverId: { userId: 'u2', serverId: 's1' } } }).roleId,
    'r-new',
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
  db.membership.create({ data: { userId: user.id, serverId: 's1', roleId: 'r1' } });

  const found = db.membership.findFirst({ where: { serverId: 's1', user: { discordId: 'd1' } } });
  assert.ok(found, 'should resolve the belongsTo relation and match on its field');

  const notFound = db.membership.findFirst({ where: { serverId: 's1', user: { discordId: 'wrong' } } });
  assert.equal(notFound, null);
});

test('operators: not, lt, contains', () => {
  const db = createFakePrismaClient();
  db.bugReport.create({ data: { serverId: 's1', title: 'Floor breaks', archivedAt: null, createdAt: new Date('2026-01-01') } });
  db.bugReport.create({ data: { serverId: 's1', title: 'Wall clips', archivedAt: new Date('2026-01-05'), createdAt: new Date('2026-01-05') } });

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
  const role = db.role.create({ data: { serverId: server.id, name: 'Owner', rank: 100 } });
  const link = db.shareLink.create({ data: { serverId: server.id, accessLevel: 'VIEW', createdByDiscordId: 'owner1' } });
  const user = db.user.create({ data: { discordId: 'guest1' } });
  db.guestAccess.create({ data: { shareLinkId: link.id, serverId: server.id, userId: user.id } });

  const membership = db.membership.create({ data: { userId: user.id, serverId: server.id, roleId: role.id } });
  const withRole = db.membership.findFirst({ where: { id: membership.id }, include: { role: true } });
  assert.equal(withRole.role.name, 'Owner', 'belongsTo include should attach the related record');

  const linkWithGuests = db.shareLink.findFirst({ where: { id: link.id }, include: { guestAccess: { include: { user: true } } } });
  assert.equal(linkWithGuests.guestAccess.length, 1);
  assert.equal(linkWithGuests.guestAccess[0].user.discordId, 'guest1', 'nested include should resolve two levels deep');
});

test('nested create on hasMany relation (server.create with roles: { create: [...] })', () => {
  const db = createFakePrismaClient();
  const server = db.server.create({
    data: {
      discordServerId: 'g1',
      name: 'Test',
      ownerDiscordId: 'owner1',
      roles: { create: [{ name: 'Owner', rank: 100 }, { name: 'Tester', rank: 10 }] },
    },
  });
  const roles = db.role.findMany({ where: { serverId: server.id } });
  assert.equal(roles.length, 2);
  assert.ok(roles.every((r) => r.serverId === server.id), 'nested-created roles should carry the foreign key');
});

test('orderBy: simple field and nested relation field', () => {
  const db = createFakePrismaClient();
  db.bugReport.create({ data: { serverId: 's1', title: 'a', createdAt: new Date('2026-01-01') } });
  db.bugReport.create({ data: { serverId: 's1', title: 'b', createdAt: new Date('2026-01-03') } });
  db.bugReport.create({ data: { serverId: 's1', title: 'c', createdAt: new Date('2026-01-02') } });

  const desc = db.bugReport.findMany({ where: { serverId: 's1' }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual(desc.map((r) => r.title), ['b', 'c', 'a']);

  const roleLow = db.role.create({ data: { serverId: 's1', name: 'Tester', rank: 10 } });
  const roleHigh = db.role.create({ data: { serverId: 's1', name: 'Owner', rank: 100 } });
  db.membership.create({ data: { userId: 'u1', serverId: 's1', roleId: roleLow.id } });
  db.membership.create({ data: { userId: 'u2', serverId: 's1', roleId: roleHigh.id } });

  const byRank = db.membership.findMany({ where: { serverId: 's1' }, orderBy: { role: { rank: 'desc' } } });
  assert.equal(byRank[0].roleId, roleHigh.id, 'nested relation orderBy should sort by the related record field');
});

test('updateMany, deleteMany, and count respect where filters (not just affect everything)', () => {
  const db = createFakePrismaClient();
  db.bugReport.create({ data: { serverId: 's1', title: 'a', status: 'NEW' } });
  db.bugReport.create({ data: { serverId: 's1', title: 'b', status: 'NEW' } });
  db.bugReport.create({ data: { serverId: 's2', title: 'c', status: 'NEW' } });

  const { count: updateCount } = db.bugReport.updateMany({ where: { serverId: 's1' }, data: { status: 'FIXED' } });
  assert.equal(updateCount, 2);
  assert.equal(db.bugReport.findFirst({ where: { serverId: 's2' } }).status, 'NEW', 'server s2 must be untouched');

  const { count: deleteCount } = db.bugReport.deleteMany({ where: { serverId: 's1' } });
  assert.equal(deleteCount, 2);
  assert.equal(db.bugReport.count({ where: {} }), 1, 'only the s2 report should remain');
});

test('groupBy counts per distinct value of the grouping field', () => {
  const db = createFakePrismaClient();
  db.bugReport.create({ data: { serverId: 's1', status: 'NEW', archivedAt: null } });
  db.bugReport.create({ data: { serverId: 's1', status: 'NEW', archivedAt: null } });
  db.bugReport.create({ data: { serverId: 's1', status: 'FIXED', archivedAt: null } });
  db.bugReport.create({ data: { serverId: 's1', status: 'FIXED', archivedAt: new Date() } }); // archived, should be excluded by where

  const grouped = db.bugReport.groupBy({ by: ['status'], where: { serverId: 's1', archivedAt: null }, _count: true });
  const asMap = Object.fromEntries(grouped.map((g) => [g.status, g._count]));
  assert.deepEqual(asMap, { NEW: 2, FIXED: 1 });
});

test('create applies schema defaults for omitted fields', () => {
  const db = createFakePrismaClient();
  const role = db.role.create({ data: { serverId: 's1', name: 'Tester', rank: 10 } });
  assert.equal(role.canSubmitBugs, true, 'matches @default(true) in schema.prisma');
  assert.equal(role.canManageBugs, false, 'matches @default(false)');
  assert.equal(role.canManageSettings, false, 'matches @default(false)');
});

test('explicit values in create() override schema defaults', () => {
  const db = createFakePrismaClient();
  const role = db.role.create({ data: { serverId: 's1', name: 'Owner', rank: 100, canManageSettings: true } });
  assert.equal(role.canManageSettings, true);
  assert.equal(role.canSubmitBugs, true, 'default still applies to fields not explicitly given');
});

test('hasMany relation filter: none — matches records with zero related rows satisfying the nested condition', () => {
  const db = createFakePrismaClient();
  const serverA = db.server.create({ data: { discordServerId: 'gA', name: 'A', ownerDiscordId: 'ownerA' } });
  const serverB = db.server.create({ data: { discordServerId: 'gB', name: 'B', ownerDiscordId: 'ownerB' } });
  db.membership.create({ data: { userId: 'u1', serverId: serverA.id, roleId: 'r1' } });

  // serverA has a membership for u1 -> should NOT match "none such membership"
  // serverB has no memberships at all -> SHOULD match "none such membership"
  const matches = db.server.findMany({ where: { memberships: { none: { userId: 'u1' } } } });
  const ids = matches.map((s) => s.id);
  assert.ok(!ids.includes(serverA.id), 'server with a matching membership should be excluded');
  assert.ok(ids.includes(serverB.id), 'server with no matching membership should be included');
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
  db.bugReport.create({ data: { serverId: 's1', title: 'never archived' } }); // archivedAt omitted entirely -> undefined
  db.bugReport.create({ data: { serverId: 's1', title: 'archived', archivedAt: new Date('2026-01-01') } });

  const archivedOnly = db.bugReport.findMany({ where: { archivedAt: { not: null } } });
  assert.equal(archivedOnly.length, 1, 'an omitted field must be treated as null, so it should NOT satisfy "not null"');
  assert.equal(archivedOnly[0].title, 'archived');
});


test('each createFakePrismaClient() call is fully isolated from previous ones', () => {
  const dbA = createFakePrismaClient();
  dbA.user.create({ data: { discordId: 'only-in-a' } });
  const dbB = createFakePrismaClient();
  assert.equal(dbB.user.findMany({ where: {} }).length, 0, 'a fresh client must start empty regardless of other instances');
});

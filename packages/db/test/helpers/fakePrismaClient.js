// A small, faithful in-memory stand-in for @prisma/client, scoped to
// exactly the operations packages/db/src/index.js uses (verified by
// grepping the real file — see the audit that produced this list).
// It is schema-driven so relation/where/include/orderBy handling is
// written once and shared across all 11 models, rather than hand-coded
// per model, which is where copy-paste mistakes hide.

let nextId = 1;
function cuid() {
  return `id${nextId++}`;
}

// A strictly-increasing clock for auto-timestamps. Real wall-clock time
// has millisecond resolution, so several records created in the same
// test (the normal case — tests run fast) could otherwise get identical
// timestamps, silently making any orderBy-by-time test pass for the
// wrong reason (insertion-order coincidence, not real sorting).
let fakeClockTick = 0;
function fakeNow() {
  fakeClockTick += 1;
  return new Date(Date.now() + fakeClockTick);
}

// Fields that mirror @default(now()) in schema.prisma — only set if the
// caller didn't already provide a value.
const AUTO_NOW_ON_CREATE = {
  user: ['createdAt'],
  server: ['createdAt'],
  membership: ['joinedAt'],
  memberRole: ['grantedAt'],
  bannedMember: ['bannedAt'],
  bugReport: ['createdAt'],
  auditLogEntry: ['createdAt'],
  shareLink: ['createdAt'],
  guestAccess: ['grantedAt'],
};

// Fields that mirror @updatedAt — bumped to "now" on every update, the
// caller's data notwithstanding.
const AUTO_NOW_ON_UPDATE = {
  bugReport: ['updatedAt'],
  leaderboardScore: ['updatedAt'],
};

const SCHEMA = {
  server: {
    uniques: ['id', 'discordServerId'],
    relations: {
      roles: { type: 'hasMany', model: 'role', fk: 'serverId' },
      memberships: { type: 'hasMany', model: 'membership', fk: 'serverId' },
    },
    defaults: { isActive: true, nextBugNumber: 1 },
  },
  role: {
    uniques: ['id'],
    compoundUniques: { serverId_name: ['serverId', 'name'] },
    relations: {},
    // Mirrors the @default(...) values in schema.prisma exactly — Role is
    // the one model created with partial data often enough (custom roles
    // via createRole) that silently-missing fields would be misleading.
    defaults: {
      canSubmitBugs: true,
      canViewDashboard: false,
      canManageBugs: false,
      canPingTesters: false,
      canArchive: false,
      canEditReports: false,
      canDeleteReports: false,
      canShareDashboard: false,
      canKickMembers: false,
      canBanMembers: false,
      canManageRoles: false,
      canManageSettings: false,
    },
  },
  membership: {
    uniques: ['id'],
    compoundUniques: { userId_serverId: ['userId', 'serverId'] },
    relations: {
      user: { type: 'belongsTo', model: 'user', fk: 'userId' },
      server: { type: 'belongsTo', model: 'server', fk: 'serverId' },
      roles: { type: 'hasMany', model: 'memberRole', fk: 'membershipId' },
    },
  },
  memberRole: {
    uniques: ['id'],
    compoundUniques: { membershipId_roleId: ['membershipId', 'roleId'] },
    relations: {
      membership: { type: 'belongsTo', model: 'membership', fk: 'membershipId' },
      role: { type: 'belongsTo', model: 'role', fk: 'roleId' },
    },
  },
  bannedMember: {
    uniques: ['id'],
    compoundUniques: { serverId_discordId: ['serverId', 'discordId'] },
    relations: {},
  },
  bugReport: {
    uniques: ['id'],
    compoundUniques: { serverId_bugNumber: ['serverId', 'bugNumber'] },
    relations: { reporter: { type: 'belongsTo', model: 'user', fk: 'reporterId' } },
    // Mirrors @default("MEDIUM") / @default("NEW") / @default(false) in
    // schema.prisma — previously missing here entirely, which meant any
    // test relying on the schema default (rather than always passing
    // priority/status explicitly) silently got `undefined` instead.
    defaults: { priority: 'MEDIUM', status: 'NEW', pointDeducted: false },
  },
  leaderboardScore: {
    uniques: ['id'],
    compoundUniques: { serverId_userId: ['serverId', 'userId'] },
    relations: { user: { type: 'belongsTo', model: 'user', fk: 'userId' } },
  },
  weeklyScore: {
    uniques: ['id'],
    compoundUniques: { serverId_userId_weekStart: ['serverId', 'userId', 'weekStart'] },
    relations: { user: { type: 'belongsTo', model: 'user', fk: 'userId' } },
  },
  auditLogEntry: { uniques: ['id'], relations: {} },
  shareLink: {
    uniques: ['id'],
    relations: { guestAccess: { type: 'hasMany', model: 'guestAccess', fk: 'shareLinkId' } },
  },
  guestAccess: {
    uniques: ['id'],
    compoundUniques: { shareLinkId_userId: ['shareLinkId', 'userId'] },
    relations: {
      user: { type: 'belongsTo', model: 'user', fk: 'userId' },
      shareLink: { type: 'belongsTo', model: 'shareLink', fk: 'shareLinkId' },
      server: { type: 'belongsTo', model: 'server', fk: 'serverId' },
    },
  },
  user: { uniques: ['id', 'discordId'], relations: {} },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
}

// Plain === fails for two different Date objects representing the same
// instant — real databases compare by value, not by JS reference, so
// every equality check in this file goes through here instead of raw ===.
function valuesEqual(a, b) {
  if (a instanceof Date || b instanceof Date) {
    if (a == null || b == null) return a == null && b == null;
    return new Date(a).getTime() === new Date(b).getTime();
  }
  return a === b;
}

class Table {
  constructor(name, db) {
    this.name = name;
    this.db = db;
    this.rows = new Map(); // id -> record
    this.schema = SCHEMA[name];
  }

  all() {
    return [...this.rows.values()];
  }

  // Resolves a single where-clause key/value against one record. Handles
  // compound unique objects, relation filters (nested where on a related
  // record), and the small set of operators actually used (not, lt, contains).
  matchesCondition(record, key, value) {
    if (key === 'OR') {
      return value.some((subWhere) => this.matches(record, subWhere));
    }

    if (this.schema.compoundUniques?.[key]) {
      return this.schema.compoundUniques[key].every((field) => valuesEqual(record[field], value[field]));
    }

    const relation = this.schema.relations[key];
    if (relation) {
      if (relation.type === 'hasMany') {
        const relatedRows = this.db.table(relation.model).all().filter((r) => r[relation.fk] === record.id);
        if (isPlainObject(value) && 'none' in value) {
          return !relatedRows.some((r) => this.db.matchesWhere(relation.model, r, value.none));
        }
        if (isPlainObject(value) && 'some' in value) {
          return relatedRows.some((r) => this.db.matchesWhere(relation.model, r, value.some));
        }
        throw new Error(`Unsupported hasMany filter on ${key}: ${JSON.stringify(value)}`);
      }
      const related = this.db.resolveRelation(this.name, record, key);
      if (!related) return false;
      return this.db.matchesWhere(relation.model, related, value);
    }

    if (isPlainObject(value)) {
      const isNullish = (v) => v === null || v === undefined;

      if ('not' in value && Object.keys(value).length === 1) {
        return value.not === null ? !isNullish(record[key]) : !valuesEqual(record[key], value.not);
      }
      if ('lt' in value || 'gte' in value || 'not' in value) {
        if (value.not !== undefined) {
          const excluded = value.not === null ? isNullish(record[key]) : valuesEqual(record[key], value.not);
          if (excluded) return false;
        }
        if (value.lt !== undefined && !(new Date(record[key]) < new Date(value.lt))) return false;
        if (value.gte !== undefined && !(new Date(record[key]) >= new Date(value.gte))) return false;
        return true;
      }
      if ('contains' in value) {
        return String(record[key] ?? '').toLowerCase().includes(String(value.contains).toLowerCase());
      }
      throw new Error(`Unsupported where operator on ${key}: ${JSON.stringify(value)}`);
    }

    if (value === null) {
      return record[key] === null || record[key] === undefined;
    }

    return valuesEqual(record[key], value);
  }

  matches(record, where) {
    return Object.entries(where).every(([key, value]) => this.matchesCondition(record, key, value));
  }

  applyInclude(record, include) {
    const result = { ...record };
    for (const [key, value] of Object.entries(include)) {
      const relation = this.schema.relations[key];
      if (!relation) throw new Error(`Unknown relation ${key} on ${this.name}`);

      if (relation.type === 'belongsTo') {
        const related = this.db.resolveRelation(this.name, record, key);
        const nestedInclude = value && value.include;
        result[key] = related && nestedInclude ? this.db.table(relation.model).applyInclude(related, nestedInclude) : related;
      } else if (relation.type === 'hasMany') {
        const relatedRows = this.db.table(relation.model).all().filter((r) => r[relation.fk] === record.id);
        const nestedInclude = value && value.include;
        result[key] = nestedInclude
          ? relatedRows.map((r) => this.db.table(relation.model).applyInclude(r, nestedInclude))
          : relatedRows;
      }
    }
    return result;
  }

  sortRows(rows, orderBy) {
    if (!orderBy) return rows;
    const [key, valueOrNested] = Object.entries(orderBy)[0];

    if (isPlainObject(valueOrNested)) {
      // Nested relation orderBy, e.g. { role: { rank: 'desc' } }
      const [nestedKey, direction] = Object.entries(valueOrNested)[0];
      return [...rows].sort((a, b) => {
        const ra = this.db.resolveRelation(this.name, a, key);
        const rb = this.db.resolveRelation(this.name, b, key);
        const av = ra?.[nestedKey];
        const bv = rb?.[nestedKey];
        return direction === 'desc' ? bv - av : av - bv;
      });
    }

    const direction = valueOrNested;
    return [...rows].sort((a, b) => {
      const av = a[key] instanceof Date ? a[key].getTime() : a[key];
      const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
      if (av < bv) return direction === 'desc' ? 1 : -1;
      if (av > bv) return direction === 'desc' ? -1 : 1;
      return 0;
    });
  }

  findUnique({ where, include }) {
    const [key, value] = Object.entries(where)[0];
    let record;
    if (this.schema.compoundUniques?.[key]) {
      record = this.all().find((r) => this.schema.compoundUniques[key].every((f) => valuesEqual(r[f], value[f])));
    } else {
      record = this.all().find((r) => valuesEqual(r[key], value));
    }
    if (!record) return null;
    return include ? this.applyInclude(record, include) : record;
  }

  findFirst({ where, include }) {
    const record = this.all().find((r) => this.matches(r, where || {}));
    if (!record) return null;
    return include ? this.applyInclude(record, include) : record;
  }

  findMany({ where, include, orderBy, skip, take } = {}) {
    let rows = where ? this.all().filter((r) => this.matches(r, where)) : this.all();
    rows = this.sortRows(rows, orderBy);
    if (skip) rows = rows.slice(skip);
    if (take !== undefined) rows = rows.slice(0, take);
    return include ? rows.map((r) => this.applyInclude(r, include)) : rows;
  }

  checkUniqueConstraints(record, excludeId) {
    for (const [name, fields] of Object.entries(this.schema.compoundUniques || {})) {
      const clash = this.all().find((r) => r.id !== excludeId && fields.every((f) => valuesEqual(r[f], record[f])));
      if (clash) throw new Error(`Unique constraint failed on ${this.name}.${name} (${fields.join(', ')})`);
    }
    for (const field of this.schema.uniques.filter((f) => f !== 'id')) {
      const clash = this.all().find((r) => r.id !== excludeId && valuesEqual(r[field], record[field]));
      if (clash) throw new Error(`Unique constraint failed on ${this.name}.${field}`);
    }
  }

  create({ data }) {
    const id = data.id || cuid();
    const record = { id, ...this.schema.defaults, ...data };
    for (const field of AUTO_NOW_ON_CREATE[this.name] || []) {
      if (record[field] === undefined) record[field] = fakeNow();
    }
    this.checkUniqueConstraints(record, null);

    // Nested create for relations, e.g. server.create({ data: { roles: { create: [...] } } })
    for (const [key, relation] of Object.entries(this.schema.relations)) {
      if (relation.type === 'hasMany' && data[key]?.create) {
        delete record[key];
        for (const nested of data[key].create) {
          this.db.table(relation.model).create({ data: { ...nested, [relation.fk]: id } });
        }
      }
    }

    this.rows.set(id, record);
    return record;
  }

  update({ where, data }) {
    const existing = this.findFirst({ where });
    if (!existing) throw new Error(`Record not found in ${this.name}`);
    const resolved = {};
    for (const [k, v] of Object.entries(data)) {
      resolved[k] = isPlainObject(v) && 'increment' in v ? existing[k] + v.increment : v;
    }
    const updated = { ...this.rows.get(existing.id), ...resolved };
    for (const field of AUTO_NOW_ON_UPDATE[this.name] || []) updated[field] = fakeNow();
    this.checkUniqueConstraints(updated, existing.id);
    this.rows.set(existing.id, updated);
    return updated;
  }

  updateMany({ where, data }) {
    const matches = this.all().filter((r) => this.matches(r, where));
    for (const r of matches) {
      const updated = { ...r, ...data };
      for (const field of AUTO_NOW_ON_UPDATE[this.name] || []) updated[field] = fakeNow();
      this.rows.set(r.id, updated);
    }
    return { count: matches.length };
  }

  delete({ where }) {
    const existing = this.findFirst({ where });
    if (!existing) throw new Error(`Record not found in ${this.name}`);
    this.rows.delete(existing.id);
    return existing;
  }

  deleteMany({ where }) {
    const matches = this.all().filter((r) => this.matches(r, where));
    for (const r of matches) this.rows.delete(r.id);
    return { count: matches.length };
  }

  upsert({ where, update, create }) {
    const existing = this.findFirst({ where });
    if (existing) {
      // Support Prisma's { increment: n } update syntax on numeric fields.
      const resolved = {};
      for (const [k, v] of Object.entries(update)) {
        resolved[k] = isPlainObject(v) && 'increment' in v ? existing[k] + v.increment : v;
      }
      return this.update({ where: { id: existing.id }, data: resolved });
    }
    return this.create({ data: create });
  }

  count({ where }) {
    return (where ? this.all().filter((r) => this.matches(r, where)) : this.all()).length;
  }

  groupBy({ by, where, _count }) {
    const rows = where ? this.all().filter((r) => this.matches(r, where)) : this.all();
    const groups = new Map();
    for (const row of rows) {
      const key = by.map((f) => row[f]).join('|');
      if (!groups.has(key)) {
        const entry = {};
        for (const f of by) entry[f] = row[f];
        entry._count = 0;
        groups.set(key, entry);
      }
      groups.get(key)._count += 1;
    }
    return [...groups.values()];
  }
}

class FakeDb {
  constructor() {
    this.tables = {};
    for (const name of Object.keys(SCHEMA)) this.tables[name] = new Table(name, this);
  }

  table(name) {
    return this.tables[name];
  }

  resolveRelation(modelName, record, relationKey) {
    const relation = SCHEMA[modelName].relations[relationKey];
    if (relation.type === 'belongsTo') {
      return this.table(relation.model).all().find((r) => r.id === record[relation.fk]) || null;
    }
    return this.table(relation.model).all().filter((r) => r[relation.fk] === record.id);
  }

  matchesWhere(modelName, record, where) {
    return this.table(modelName).matches(record, where);
  }
}

// Builds a fresh PrismaClient-shaped object with empty tables — call once
// per test (or per test file) so state never leaks between tests.
function createFakePrismaClient() {
  const db = new FakeDb();
  const client = {};
  for (const name of Object.keys(SCHEMA)) client[name] = db.tables[name];
  client.$db = db; // escape hatch for tests that want to seed data directly
  return client;
}

module.exports = { createFakePrismaClient, SCHEMA };

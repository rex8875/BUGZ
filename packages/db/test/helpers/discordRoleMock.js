// Installs a fetch mock that answers Discord's "get guild member" and
// "get guild roles" endpoints from simple in-memory lookup tables,
// since getEffectivePermissions (and the rank-safety checks) now ask
// Discord live instead of reading a stored Membership. Used by every
// test file that needs to simulate "this person holds these Discord
// roles" without a real Discord connection.
//
// Implementation note: this used to save/restore a single shared
// `global.fetch` slot directly. That's only correct under strict LIFO
// nesting (install B while A is alive, then restore B before A) --
// under real concurrency (e.g. Promise.all of several withDiscordRoles
// calls that don't necessarily finish in reverse-install order), a
// single mutable slot lets one instance's restore() silently clobber
// another still-active instance's mock mid-flight, or leave
// global.fetch permanently pointed at a dead mock. Production code
// never hits this, since it never monkey-patches a shared global --
// only this test double does. Fixed by dispatching through
// AsyncLocalStorage instead of a single global slot, so concurrently
// active mocks stay correctly isolated per async call chain regardless
// of install/restore order.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();
let realFetch = null;
let patchInstalled = false;

function ensureFetchPatched() {
  if (patchInstalled) return;
  realFetch = global.fetch;
  global.fetch = (...args) => {
    const store = als.getStore();
    if (store) return store.fetchImpl(...args);
    return realFetch(...args);
  };
  patchInstalled = true;
}

function buildMockStore() {
  const memberRoles = new Map(); // discordId -> array of role ids (unset = 404 / not a member)
  const rolePositions = new Map(); // roleId -> position

  const fetchImpl = async (url) => {
    const memberMatch = String(url).match(/\/guilds\/([^/]+)\/members\/([^/]+)$/);
    if (memberMatch) {
      const discordId = memberMatch[2];
      if (!memberRoles.has(discordId)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ roles: memberRoles.get(discordId) }) };
    }
    const rolesMatch = String(url).match(/\/guilds\/([^/]+)\/roles$/);
    if (rolesMatch) {
      return {
        ok: true,
        status: 200,
        json: async () => [...rolePositions.entries()].map(([id, position]) => ({ id, position })),
      };
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };

  return { memberRoles, rolePositions, fetchImpl };
}

// Manual install/restore API. Safe for the common sequential pattern
// (install, use, restore, possibly nested with other instances as long
// as they're properly nested too) within a single call chain. NOT safe
// to have two instances alive concurrently across independent Promise.all
// branches and restored out of order -- use withDiscordRoles for that,
// since it scopes correctly via AsyncLocalStorage.run() regardless of
// finish order.
function installDiscordRoleMock() {
  ensureFetchPatched();
  const store = buildMockStore();
  const parentStore = als.getStore();
  als.enterWith(store);

  return {
    setMemberRoles(discordId, roleIds) {
      store.memberRoles.set(discordId, roleIds);
    },
    setRolePosition(roleId, position) {
      store.rolePositions.set(roleId, position);
    },
    restore() {
      als.enterWith(parentStore);
    },
  };
}

// Convenience for the common case: run a test body with a fixed set of
// "this discordId currently holds these Discord role ids" facts in
// place, cleaning up afterward even if the body throws. Correctly
// isolated even when multiple calls to this run concurrently (e.g.
// inside Promise.all), since AsyncLocalStorage.run() scopes the store
// to exactly this call's async continuation chain and automatically
// restores the outer context on completion, regardless of what other
// concurrent instances are doing or what order they finish in.
async function withDiscordRoles(rolesByDiscordId, fn) {
  ensureFetchPatched();
  const store = buildMockStore();
  for (const [discordId, roleIds] of Object.entries(rolesByDiscordId)) store.memberRoles.set(discordId, roleIds);
  const mock = {
    setMemberRoles: (discordId, roleIds) => store.memberRoles.set(discordId, roleIds),
    setRolePosition: (roleId, position) => store.rolePositions.set(roleId, position),
  };
  return als.run(store, () => fn(mock));
}

module.exports = { installDiscordRoleMock, withDiscordRoles };

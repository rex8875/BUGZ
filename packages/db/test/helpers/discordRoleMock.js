// Installs a fetch mock that answers Discord's "get guild member" and
// "get guild roles" endpoints from simple in-memory lookup tables,
// since getEffectivePermissions (and the rank-safety checks) now ask
// Discord live instead of reading a stored Membership. Used by every
// test file that needs to simulate "this person holds these Discord
// roles" without a real Discord connection.
function installDiscordRoleMock() {
  const memberRoles = new Map(); // discordId -> array of role ids (undefined = 404 / not a member)
  const rolePositions = new Map(); // roleId -> position

  const realFetch = global.fetch;
  global.fetch = async (url) => {
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

  return {
    setMemberRoles(discordId, roleIds) {
      memberRoles.set(discordId, roleIds);
    },
    setRolePosition(roleId, position) {
      rolePositions.set(roleId, position);
    },
    restore() {
      global.fetch = realFetch;
    },
  };
}

// Convenience for the common case: run a test body with a fixed set of
// "this discordId currently holds these Discord role ids" facts in
// place, cleaning up afterward even if the body throws.
async function withDiscordRoles(rolesByDiscordId, fn) {
  const mock = installDiscordRoleMock();
  for (const [discordId, roleIds] of Object.entries(rolesByDiscordId)) mock.setMemberRoles(discordId, roleIds);
  try {
    return await fn(mock);
  } finally {
    mock.restore();
  }
}

module.exports = { installDiscordRoleMock, withDiscordRoles };

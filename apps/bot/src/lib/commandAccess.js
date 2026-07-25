const { getServerByDiscordId, getCommandRoleOverride, getEffectivePermissions } = require('@bugtracker/db');

// Called once, centrally, for every slash command before it runs (see
// interactionCreate.js) — NOT duplicated into every individual command
// file. This is deliberately additive to the bot's existing internal
// Role/rank permission system, not a replacement for it:
//
//   - No override configured for this command (the common case, and
//     true for every command until an owner explicitly restricts one)
//     -> always allowed here; the command's own existing internal
//        permission checks (already inside each db function) still
//        apply exactly as before this feature existed.
//   - An override IS configured -> the user must hold at least one of
//     the specific real Discord roles chosen for it, UNLESS they have
//     real Discord Administrator permission or our own canManageSettings
//     permission — both are treated as an unconditional safety bypass
//     so nobody capable of fixing a misconfiguration can lock
//     themselves out of doing so.
async function checkCommandAccess(interaction, commandName) {
  if (!interaction.guildId) return { allowed: true }; // DMs etc. — let the command's own guild-only handling apply
  const server = await getServerByDiscordId(interaction.guildId);
  if (!server) return { allowed: true }; // not set up yet — let the command's own "not set up" reply handle it

  const overrideRoleIds = await getCommandRoleOverride(server.id, commandName);
  if (overrideRoleIds.length === 0) return { allowed: true };

  if (interaction.member?.permissions?.has?.('Administrator')) return { allowed: true };

  const perms = await getEffectivePermissions(server.id, interaction.user.id);
  if (perms?.canManageSettings) return { allowed: true };

  const memberRoleIds = interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [];
  const allowed = memberRoleIds.some((id) => overrideRoleIds.includes(id));
  return { allowed };
}

module.exports = { checkCommandAccess };

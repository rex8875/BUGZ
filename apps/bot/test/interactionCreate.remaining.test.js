const test = require('node:test');
const assert = require('node:assert/strict');
const { installDiscordRoleMock } = require('../../../packages/db/test/helpers/discordRoleMock');

const TESTER_ROLE = 'tester-discord-role';

function loadInteractionCreateWithFakeDb() {
  const { createFakePrismaClient } = require('../../../packages/db/test/helpers/fakePrismaClient');
  const fakeClient = createFakePrismaClient();
  const prismaClientPath = require.resolve('@prisma/client');
  const originalPrismaCache = require.cache[prismaClientPath];
  require.cache[prismaClientPath] = { id: prismaClientPath, filename: prismaClientPath, loaded: true, exports: { PrismaClient: function () { return fakeClient; } } };
  const dbModulePath = require.resolve('@bugtracker/db');
  const originalDbCache = require.cache[dbModulePath];
  delete require.cache[dbModulePath];
  const handlerPath = require.resolve('../src/events/interactionCreate.js');
  delete require.cache[handlerPath];
  const draftsPath = require.resolve('../src/lib/bugReportDrafts.js');
  delete require.cache[draftsPath];
  const handler = require(handlerPath);
  const drafts = require(draftsPath);
  const dbModule = require(dbModulePath);
  if (originalPrismaCache) require.cache[prismaClientPath] = originalPrismaCache;
  else delete require.cache[prismaClientPath];
  return { handler, drafts, dbModule, dbModulePath, originalDbCache };
}

async function withInteractionCreate(fn) {
  const { handler, drafts, dbModule, dbModulePath, originalDbCache } = loadInteractionCreateWithFakeDb();
  const roleMock = installDiscordRoleMock();
  try {
    await fn(handler, drafts, dbModule, roleMock);
  } finally {
    roleMock.restore();
    if (originalDbCache) require.cache[dbModulePath] = originalDbCache;
    else delete require.cache[dbModulePath];
  }
}

// ---- autocomplete dispatch ----

test('autocomplete: calls the matching command\'s autocomplete() handler when one exists', async () => {
  await withInteractionCreate(async (handler) => {
    let called = false;
    const interaction = {
      isAutocomplete: () => true,
      commandName: 'set-tester-role',
      client: { commands: new Map([['set-tester-role', { autocomplete: async () => { called = true; } }]]) },
    };
    await handler.execute(interaction);
    assert.equal(called, true);
  });
});

test('autocomplete: does nothing (no crash) when the matched command has no autocomplete handler', async () => {
  await withInteractionCreate(async (handler) => {
    const interaction = {
      isAutocomplete: () => true,
      commandName: 'help',
      client: { commands: new Map([['help', {}]]) },
    };
    await assert.doesNotReject(() => handler.execute(interaction));
  });
});

test('autocomplete: an error thrown inside the handler is caught, not left to crash the process', async () => {
  await withInteractionCreate(async (handler) => {
    const interaction = {
      isAutocomplete: () => true,
      commandName: 'x',
      client: { commands: new Map([['x', { autocomplete: async () => { throw new Error('boom'); } }]]) },
    };
    await assert.doesNotReject(() => handler.execute(interaction));
  });
});

// ---- the "Report a bug" button (open_bug_report_modal1) ----

function makeButtonInteraction({ customId, userId, guildId }) {
  const interaction = {
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    customId,
    user: { id: userId },
    guildId,
    reply: async (payload) => { interaction._reply = payload; },
    update: async (payload) => { interaction._update = payload; },
    showModal: async (modal) => { interaction._shownModal = modal; },
  };
  return interaction;
}

test('Report-a-bug button: an unverified user is told to run /verify, and no modal is shown', async () => {
  await withInteractionCreate(async (handler, drafts, dbModule) => {
    await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    // deliberately never verifyUser'd

    const interaction = makeButtonInteraction({ customId: 'open_bug_report_modal1', userId: 'stranger', guildId: 'g1' });
    await handler.execute(interaction);

    assert.match(interaction._reply.content, /run `\/verify`/);
    assert.equal(interaction._shownModal, undefined, 'must not open the form for someone who has not verified');
  });
});

test('Report-a-bug button: a verified user without canSubmitBugs is refused, and no modal is shown', async () => {
  await withInteractionCreate(async (handler, drafts, dbModule) => {
    await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'plain-member', discordUsername: 'Plain' });
    // verified, but never granted any Tester-style role/permission

    const interaction = makeButtonInteraction({ customId: 'open_bug_report_modal1', userId: 'plain-member', guildId: 'g1' });
    await handler.execute(interaction);

    assert.match(interaction._reply.content, /don't have permission to report bugs/);
    assert.equal(interaction._shownModal, undefined);
  });
});

test('Report-a-bug button: a verified user WITH canSubmitBugs gets the modal shown, not a text reply', async () => {
  await withInteractionCreate(async (handler, drafts, dbModule, roleMock) => {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'tester1', discordUsername: 'Tester' });
    await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true } });
    roleMock.setMemberRoles('tester1', [TESTER_ROLE]);

    const interaction = makeButtonInteraction({ customId: 'open_bug_report_modal1', userId: 'tester1', guildId: 'g1' });
    await handler.execute(interaction);

    assert.ok(interaction._shownModal, 'the form modal should have been shown');
    assert.equal(interaction._reply, undefined, 'must not also send a text reply alongside the modal');
  });
});

// ---- bugReportModal1 submission (the first form step) ----

function makeModal1Interaction({ userId, fields }) {
  const interaction = {
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    customId: 'bugReportModal1',
    user: { id: userId },
    fields: {
      getTextInputValue: (key) => fields.text?.[key] ?? '',
      getStringSelectValues: (key) => [fields.select?.[key]],
    },
    reply: async (payload) => { interaction._reply = payload; },
  };
  return interaction;
}

test('bugReportModal1: saves the draft and replies asking for evidence next, with a Continue button', async () => {
  await withInteractionCreate(async (handler, drafts) => {
    const interaction = makeModal1Interaction({
      userId: 'u1',
      fields: {
        text: { title: 'Wall clips through floor', description: 'Falls through geometry', steps: '1. Walk here' },
        select: { device: 'PC', priority: 'HIGH' },
      },
    });

    await handler.execute(interaction);

    assert.match(interaction._reply.content, /Got the basics/);
    assert.ok(interaction._reply.components?.[0], 'should include the Continue button');
    assert.equal(interaction._reply.ephemeral, true);

    const saved = drafts.getDraft('u1');
    assert.equal(saved.title, 'Wall clips through floor');
    assert.equal(saved.device, 'PC');
    assert.equal(saved.priority, 'HIGH');
  });
});

test('bugReportModal1: an empty optional "steps" field is stored as null, not an empty string', async () => {
  await withInteractionCreate(async (handler, drafts) => {
    const interaction = makeModal1Interaction({
      userId: 'u1',
      fields: { text: { title: 't', description: 'd', steps: '' }, select: { device: 'PC', priority: 'LOW' } },
    });
    await handler.execute(interaction);
    assert.equal(drafts.getDraft('u1').stepsToReproduce, null);
  });
});

// ---- the buglist button's remaining modes and its own permission check ----

function makeBuglistInteraction({ customId, userId, guildId }) {
  const interaction = {
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    customId,
    user: { id: userId },
    guildId,
    update: async (payload) => { interaction._update = payload; },
  };
  return interaction;
}

test('buglist button: someone who has since lost dashboard-view access is blocked on re-click, not shown stale data', async () => {
  await withInteractionCreate(async (handler, drafts, dbModule) => {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'nobody', discordUsername: 'Nobody' });
    // nobody has no role/permission granted at all

    const interaction = makeBuglistInteraction({ customId: 'buglist:mine:0::', userId: 'nobody', guildId: 'g1' });
    await handler.execute(interaction);

    assert.match(interaction._update.content, /don't have permission to view bug reports/);
  });
});

test('buglist button: "by" mode shows the target user\'s reports specifically, titled with their id', async () => {
  await withInteractionCreate(async (handler, drafts, dbModule, roleMock) => {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.verifyUser({ discordId: 'reporter1', discordUsername: 'Reporter' });
    await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canSubmitBugs: true, canViewDashboard: true } });
    roleMock.setMemberRoles('reporter1', [TESTER_ROLE]);
    roleMock.setMemberRoles('owner1', [TESTER_ROLE]);
    await dbModule.createBugReport(server.id, 'reporter1', { title: 'Only reporter1\'s bug', description: 'd', priority: 'LOW', device: 'PC' });

    const interaction = makeBuglistInteraction({ customId: 'buglist:by:0:-:-:reporter1', userId: 'owner1', guildId: 'g1' });
    await handler.execute(interaction);

    assert.match(interaction._update.embeds[0].data.title, /reporter1/);
  });
});

test('buglist button: general/search mode with no matches shows the "no reports match those filters" message, not the wrong empty state', async () => {
  await withInteractionCreate(async (handler, drafts, dbModule, roleMock) => {
    const server = await dbModule.createServerOnJoin({ discordServerId: 'g1', name: 'Test', ownerDiscordId: 'owner1' });
    await dbModule.verifyUser({ discordId: 'owner1', discordUsername: 'Owner' });
    await dbModule.setRolePermissions({ serverId: server.id, actingDiscordId: 'owner1', discordRoleId: TESTER_ROLE, permissions: { canViewDashboard: true } });
    roleMock.setMemberRoles('owner1', [TESTER_ROLE]);

    const interaction = makeBuglistInteraction({ customId: 'buglist:list:0:HIGH:-:-', userId: 'owner1', guildId: 'g1' });
    await handler.execute(interaction);

    assert.match(interaction._update.content, /No reports match those filters/);
  });
});

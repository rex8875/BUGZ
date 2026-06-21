const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCoreModal, buildEvidenceModal } = require('../src/lib/bugReportModals');

const DISCORD_MODAL_COMPONENT_LIMIT = 5;

test('the core bug report modal has exactly 5 top-level components, at Discord\'s limit', () => {
  const modal = buildCoreModal().toJSON();
  assert.equal(modal.components.length, DISCORD_MODAL_COMPONENT_LIMIT);
});

test('the evidence modal also has exactly 5 top-level components', () => {
  const modal = buildEvidenceModal().toJSON();
  assert.equal(modal.components.length, DISCORD_MODAL_COMPONENT_LIMIT);
});

test('core modal carries title, description, steps, device, and priority fields', () => {
  const modal = buildCoreModal().toJSON();
  const customIds = modal.components.map((c) => c.component.custom_id);
  assert.deepEqual(new Set(customIds), new Set(['title', 'description', 'steps', 'device', 'priority']));
});

test('evidence modal carries both upload and link options for evidence and F9, plus additional info', () => {
  const modal = buildEvidenceModal().toJSON();
  const customIds = modal.components.map((c) => c.component.custom_id);
  assert.deepEqual(
    new Set(customIds),
    new Set(['evidenceFile', 'evidenceLink', 'f9File', 'f9Link', 'additionalInfo']),
  );
});

test('evidence upload and link fields are both optional at the Discord level (validated as "at least one" in the bot logic instead)', () => {
  const modal = buildEvidenceModal().toJSON();
  const evidenceFile = modal.components.find((c) => c.component.custom_id === 'evidenceFile');
  const evidenceLink = modal.components.find((c) => c.component.custom_id === 'evidenceLink');
  assert.equal(evidenceFile.component.required, false);
  assert.equal(evidenceLink.component.required, false);
});

test('title, description, device, and priority are required in the core modal', () => {
  const modal = buildCoreModal().toJSON();
  for (const id of ['title', 'description', 'device', 'priority']) {
    const field = modal.components.find((c) => c.component.custom_id === id);
    assert.equal(field.component.required, true, `${id} should be required`);
  }
  const steps = modal.components.find((c) => c.component.custom_id === 'steps');
  assert.equal(steps.component.required, false, 'steps to reproduce is optional');
});

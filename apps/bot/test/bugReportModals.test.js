const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCoreModal, buildEvidenceModal } = require('../src/lib/bugReportModals');

test('the core bug report modal has exactly 5 top-level components, at Discord\'s limit', () => {
  const modal = buildCoreModal().toJSON();
  assert.equal(modal.components.length, 5);
});

test('the evidence modal has 3 components, well under Discord\'s 5-component limit', () => {
  const modal = buildEvidenceModal().toJSON();
  assert.equal(modal.components.length, 3);
});

test('core modal carries title, description, steps, device, and priority fields', () => {
  const modal = buildCoreModal().toJSON();
  const customIds = modal.components.map((c) => c.component.custom_id);
  assert.deepEqual(new Set(customIds), new Set(['title', 'description', 'steps', 'device', 'priority']));
});

test('evidence modal is link-only — file upload was dropped as an unreliable, very new Discord feature', () => {
  const modal = buildEvidenceModal().toJSON();
  const customIds = modal.components.map((c) => c.component.custom_id);
  assert.deepEqual(new Set(customIds), new Set(['evidenceLink', 'f9Link', 'additionalInfo']));
});

test('evidence and F9 links are required, since there is no upload fallback anymore', () => {
  const modal = buildEvidenceModal().toJSON();
  const evidenceLink = modal.components.find((c) => c.component.custom_id === 'evidenceLink');
  const f9Link = modal.components.find((c) => c.component.custom_id === 'f9Link');
  assert.equal(evidenceLink.component.required, true);
  assert.equal(f9Link.component.required, true);
});

test('additional info stays optional', () => {
  const modal = buildEvidenceModal().toJSON();
  const additionalInfo = modal.components.find((c) => c.component.custom_id === 'additionalInfo');
  assert.equal(additionalInfo.component.required, false);
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

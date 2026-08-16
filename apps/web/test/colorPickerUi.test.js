const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// jsdom returns null from canvas.getContext('2d') unless the native
// `canvas` package is installed — drawWheel() would crash immediately
// on construction otherwise. This fake provides just enough of the 2D
// context API for drawWheel's pixel loop to run harmlessly; it doesn't
// verify what gets drawn (that would need real rendering), only that
// the surrounding picker logic — initial-value parsing, gradient
// toggle, hex validation, output format — behaves correctly.
function installFakeCanvasContext(win) {
  win.HTMLCanvasElement.prototype.getContext = function () {
    return {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
    };
  };
}

function loadPicker() {
  const dom = new JSDOM('<!doctype html><html><body><div id="container"></div></body></html>', { runScripts: 'outside-only', url: 'https://example.test/board' });
  installFakeCanvasContext(dom.window);
  const code = fs.readFileSync(path.join(process.cwd(), 'apps/web/public/colorPicker.js'), 'utf8');
  dom.window.eval(code);
  return dom;
}

test('createAppearancePicker: with no initial value, defaults to solid mode with the built-in default color', () => {
  const dom = loadPicker();
  const container = dom.window.document.getElementById('container');
  const picker = dom.window.FieldLogColorPicker.createAppearancePicker({ container, initialValue: null });

  assert.equal(picker.getValue(), '#1a202c');
  assert.equal(container.querySelector('#gradient-toggle').checked, false);
  assert.equal(container.querySelector('.angle-row').style.display, 'none', 'angle control should be hidden in solid mode');
});

test('createAppearancePicker: parses an existing solid hex value and starts in solid mode with it', () => {
  const dom = loadPicker();
  const container = dom.window.document.getElementById('container');
  const picker = dom.window.FieldLogColorPicker.createAppearancePicker({ container, initialValue: '#1a2b3c' });

  assert.equal(picker.getValue(), '#1a2b3c');
  assert.equal(container.querySelector('#gradient-toggle').checked, false);
});

test('createAppearancePicker: parses an existing gradient value and starts in gradient mode with the right angle/colors', () => {
  const dom = loadPicker();
  const container = dom.window.document.getElementById('container');
  const picker = dom.window.FieldLogColorPicker.createAppearancePicker({
    container,
    initialValue: 'linear-gradient(90deg, #ff0000, #00ff00)',
  });

  assert.equal(container.querySelector('#gradient-toggle').checked, true);
  assert.equal(container.querySelector('.angle-row').style.display, 'flex');
  assert.equal(picker.getValue(), 'linear-gradient(90deg, #ff0000, #00ff00)');
});

test('createAppearancePicker: an invalid/unparseable initial value falls back to the default rather than crashing', () => {
  const dom = loadPicker();
  const container = dom.window.document.getElementById('container');
  const picker = dom.window.FieldLogColorPicker.createAppearancePicker({ container, initialValue: 'not a css value at all' });

  assert.equal(picker.getValue(), '#1a202c');
});

test('createAppearancePicker: toggling the gradient checkbox switches getValue() between solid and gradient output', () => {
  const dom = loadPicker();
  const container = dom.window.document.getElementById('container');
  const picker = dom.window.FieldLogColorPicker.createAppearancePicker({ container, initialValue: '#123456' });

  assert.equal(picker.getValue(), '#123456');

  const checkbox = container.querySelector('#gradient-toggle');
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event('change'));

  assert.match(picker.getValue(), /^linear-gradient\(135deg, #123456, #[0-9a-f]{6}\)$/, 'switching to gradient should combine picker A\'s color with picker B\'s default');
  assert.equal(container.querySelector('.angle-row').style.display, 'flex', 'the angle control should appear once gradient mode is on');
});

test('createAppearancePicker: changing the angle slider is reflected in getValue()', () => {
  const dom = loadPicker();
  const container = dom.window.document.getElementById('container');
  const picker = dom.window.FieldLogColorPicker.createAppearancePicker({
    container,
    initialValue: 'linear-gradient(135deg, #111111, #222222)',
  });

  const angleInput = container.querySelector('input[type="range"][max="360"]');
  angleInput.value = '45';
  angleInput.dispatchEvent(new dom.window.Event('input'));

  assert.equal(picker.getValue(), 'linear-gradient(45deg, #111111, #222222)');
});

test('createSingleColorPicker (via the appearance picker\'s hex input): rejects an invalid typed hex and reverts to the last valid color', () => {
  const dom = loadPicker();
  const container = dom.window.document.getElementById('container');
  dom.window.FieldLogColorPicker.createAppearancePicker({ container, initialValue: '#ff0000' });

  const hexInput = container.querySelectorAll('.hex-input-row input[type="text"]')[0];
  assert.equal(hexInput.value, '#ff0000');

  hexInput.value = 'not-a-hex';
  hexInput.dispatchEvent(new dom.window.Event('change'));

  assert.equal(hexInput.value, '#ff0000', 'an invalid hex should be rejected and the field reverted, not silently accepted');
});

test('createSingleColorPicker (via the appearance picker\'s hex input): accepts a valid typed hex and updates the swatch/output', () => {
  const dom = loadPicker();
  const container = dom.window.document.getElementById('container');
  const picker = dom.window.FieldLogColorPicker.createAppearancePicker({ container, initialValue: '#ff0000' });

  const hexInput = container.querySelectorAll('.hex-input-row input[type="text"]')[0];
  hexInput.value = '#00ff00';
  hexInput.dispatchEvent(new dom.window.Event('change'));

  assert.equal(hexInput.value, '#00ff00');
  assert.equal(picker.getValue(), '#00ff00');
});

test('createAppearancePicker: calling it twice on the same container replaces the old picker instead of stacking two', () => {
  const dom = loadPicker();
  const container = dom.window.document.getElementById('container');
  dom.window.FieldLogColorPicker.createAppearancePicker({ container, initialValue: '#111111' });
  dom.window.FieldLogColorPicker.createAppearancePicker({ container, initialValue: '#222222' });

  assert.equal(container.querySelectorAll('#gradient-toggle').length, 1, 're-rendering into the same container should not leave stale duplicate controls behind');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { hsvToRgb, rgbToHsv, hexToRgb, rgbToHex, isValidHex } = require('../public/colorPicker.js');

test('hexToRgb / rgbToHex round-trip for 6-digit hex', () => {
  assert.deepEqual(hexToRgb('#e8a33d'), [232, 163, 61]);
  assert.equal(rgbToHex(232, 163, 61), '#e8a33d');
});

test('hexToRgb expands 3-digit shorthand hex correctly', () => {
  assert.deepEqual(hexToRgb('#abc'), hexToRgb('#aabbcc'));
});

test('rgbToHsv / hsvToRgb round-trip stays close for a range of colors', () => {
  const samples = [
    [232, 163, 61],
    [0, 0, 0],
    [255, 255, 255],
    [26, 32, 44],
    [45, 58, 102],
  ];
  for (const [r, g, b] of samples) {
    const [h, s, v] = rgbToHsv(r, g, b);
    const [r2, g2, b2] = hsvToRgb(h, s, v);
    assert.ok(Math.abs(r - r2) <= 1, `r mismatch for ${r},${g},${b}`);
    assert.ok(Math.abs(g - g2) <= 1, `g mismatch for ${r},${g},${b}`);
    assert.ok(Math.abs(b - b2) <= 1, `b mismatch for ${r},${g},${b}`);
  }
});

test('isValidHex accepts 3 and 6 digit hex, rejects garbage', () => {
  assert.equal(isValidHex('#fff'), true);
  assert.equal(isValidHex('#ffffff'), true);
  assert.equal(isValidHex('red'), false);
  assert.equal(isValidHex('#ff'), false);
  assert.equal(isValidHex('#gggggg'), false);
  assert.equal(isValidHex('javascript:alert(1)'), false);
});

test('the picker only ever produces values the server-side validator accepts', () => {
  // Mirrors packages/db's isValidBackgroundStyle regexes so the client
  // and server never disagree about what's a legal background.
  const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  const GRADIENT = /^linear-gradient\((\d{1,3})deg,\s*(#[0-9a-fA-F]{3,6}),\s*(#[0-9a-fA-F]{3,6})\)$/;

  const hex = rgbToHex(...hsvToRgb(210, 0.6, 0.7));
  assert.match(hex, HEX_COLOR);

  const gradientValue = `linear-gradient(135deg, ${hex}, ${rgbToHex(...hsvToRgb(30, 0.8, 0.9))})`;
  assert.match(gradientValue, GRADIENT);
});

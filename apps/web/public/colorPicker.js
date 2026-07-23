// A small, dependency-free HSV color wheel: hue by angle, saturation by
// radius from center, plus a separate lightness/value slider. Used for
// the per-server background picker. No frameworks — just canvas + a
// couple of DOM listeners, matching the rest of this app's vanilla style.

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
}

function isValidHex(str) {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(str);
}

// Renders one hue/saturation wheel onto a canvas at the given size.
function drawWheel(canvas, value) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const radius = size / 2;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - radius;
      const dy = y - radius;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      if (dist > radius) {
        img.data[idx + 3] = 0;
        continue;
      }
      let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (angle < 0) angle += 360;
      const sat = Math.min(1, dist / radius);
      const [r, g, b] = hsvToRgb(angle, sat, value);
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Creates one wheel + lightness slider + hex input + swatch, wired
// together. Returns { getHex, setHex, el }.
function createSingleColorPicker({ initialHex = '#e8a33d' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'appearance-wheel-col';

  const wheelWrap = document.createElement('div');
  wheelWrap.className = 'color-wheel-wrap';
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 160;
  const cursor = document.createElement('div');
  cursor.className = 'color-wheel-cursor';
  wheelWrap.appendChild(canvas);
  wheelWrap.appendChild(cursor);

  const lightness = document.createElement('input');
  lightness.type = 'range';
  lightness.min = '0';
  lightness.max = '100';
  lightness.className = 'lightness-slider';

  const hexRow = document.createElement('div');
  hexRow.className = 'hex-input-row';
  const swatch = document.createElement('div');
  swatch.className = 'swatch';
  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.maxLength = 7;
  hexInput.placeholder = '#e8a33d';
  hexRow.appendChild(swatch);
  hexRow.appendChild(hexInput);

  wrap.appendChild(wheelWrap);
  wrap.appendChild(lightness);
  wrap.appendChild(hexRow);

  let [h, s, v] = rgbToHsv(...hexToRgb(isValidHex(initialHex) ? initialHex : '#e8a33d'));
  if (v === 0) v = 1; // pure black has undefined hue/sat; default to full value so the wheel isn't blank

  function positionCursor() {
    const radius = 80;
    const angleRad = (h * Math.PI) / 180;
    const dist = s * radius;
    cursor.style.left = `${radius + Math.cos(angleRad) * dist}px`;
    cursor.style.top = `${radius + Math.sin(angleRad) * dist}px`;
  }

  function syncFromHsv() {
    const [r, g, b] = hsvToRgb(h, s, v);
    const hex = rgbToHex(r, g, b);
    swatch.style.background = hex;
    hexInput.value = hex;
    drawWheel(canvas, v);
    positionCursor();
  }

  lightness.value = String(Math.round(v * 100));
  syncFromHsv();

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left - 80;
      const y = ev.clientY - rect.top - 80;
      const dist = Math.sqrt(x * x + y * y);
      let angle = (Math.atan2(y, x) * 180) / Math.PI;
      if (angle < 0) angle += 360;
      h = angle;
      s = Math.min(1, dist / 80);
      syncFromHsv();
    };
    move(e);
    const up = () => {
      canvas.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  lightness.addEventListener('input', () => {
    v = Number(lightness.value) / 100;
    syncFromHsv();
  });

  hexInput.addEventListener('change', () => {
    if (!isValidHex(hexInput.value)) {
      hexInput.value = swatch.style.background ? rgbToHex(...hexToRgb(swatch.style.background)) : '#e8a33d';
      return;
    }
    [h, s, v] = rgbToHsv(...hexToRgb(hexInput.value));
    lightness.value = String(Math.round(v * 100));
    syncFromHsv();
  });

  return {
    el: wrap,
    getHex: () => hexInput.value,
    setHex: (hex) => {
      if (!isValidHex(hex)) return;
      [h, s, v] = rgbToHsv(...hexToRgb(hex));
      lightness.value = String(Math.round(v * 100));
      syncFromHsv();
    },
  };
}

// Full appearance picker: single-color mode or gradient mode (2 pickers +
// angle slider), a live preview strip, and a function to get the current
// CSS background value in the exact shape the server validates
// (isValidBackgroundStyle in packages/db).
function createAppearancePicker({ container, initialValue }) {
  container.innerHTML = '';

  const layout = document.createElement('div');
  layout.className = 'appearance-layout';
  container.appendChild(layout);

  const pickerRow = document.createElement('div');
  pickerRow.style.display = 'flex';
  pickerRow.style.gap = '16px';
  layout.appendChild(pickerRow);

  const controls = document.createElement('div');
  controls.className = 'appearance-controls';
  layout.appendChild(controls);

  const gradientRow = document.createElement('div');
  gradientRow.className = 'gradient-toggle-row';
  const gradientCheckbox = document.createElement('input');
  gradientCheckbox.type = 'checkbox';
  gradientCheckbox.id = 'gradient-toggle';
  const gradientLabel = document.createElement('label');
  gradientLabel.htmlFor = 'gradient-toggle';
  gradientLabel.textContent = 'Gradient (2 colors)';
  gradientRow.appendChild(gradientCheckbox);
  gradientRow.appendChild(gradientLabel);
  controls.appendChild(gradientRow);

  const angleRow = document.createElement('div');
  angleRow.className = 'angle-row';
  angleRow.style.display = 'none';
  const angleInput = document.createElement('input');
  angleInput.type = 'range';
  angleInput.min = '0';
  angleInput.max = '360';
  angleInput.value = '135';
  const angleLabel = document.createElement('span');
  angleLabel.textContent = '135°';
  angleRow.appendChild(document.createTextNode('Angle'));
  angleRow.appendChild(angleInput);
  angleRow.appendChild(angleLabel);
  controls.appendChild(angleRow);

  const preview = document.createElement('div');
  preview.className = 'appearance-preview';
  controls.appendChild(preview);

  // Parse initial value
  let initialA = '#1a202c';
  let initialB = '#2a3f6b';
  let initialAngle = 135;
  let startGradient = false;
  if (initialValue) {
    const gradMatch = initialValue.match(/^linear-gradient\((\d+)deg,\s*(#[0-9a-fA-F]{3,6}),\s*(#[0-9a-fA-F]{3,6})\)$/);
    if (gradMatch) {
      startGradient = true;
      initialAngle = Number(gradMatch[1]);
      initialA = gradMatch[2];
      initialB = gradMatch[3];
    } else if (isValidHex(initialValue)) {
      initialA = initialValue;
    }
  }

  const pickerA = createSingleColorPicker({ initialHex: initialA });
  const pickerB = createSingleColorPicker({ initialHex: initialB });
  pickerRow.appendChild(pickerA.el);
  pickerRow.appendChild(pickerB.el);
  pickerB.el.style.display = startGradient ? 'flex' : 'none';
  gradientCheckbox.checked = startGradient;
  angleRow.style.display = startGradient ? 'flex' : 'none';
  angleInput.value = String(initialAngle);
  angleLabel.textContent = `${initialAngle}°`;

  function currentValue() {
    if (gradientCheckbox.checked) {
      return `linear-gradient(${angleInput.value}deg, ${pickerA.getHex()}, ${pickerB.getHex()})`;
    }
    return pickerA.getHex();
  }

  function updatePreview() {
    preview.style.background = currentValue();
  }

  gradientCheckbox.addEventListener('change', () => {
    pickerB.el.style.display = gradientCheckbox.checked ? 'flex' : 'none';
    angleRow.style.display = gradientCheckbox.checked ? 'flex' : 'none';
    updatePreview();
  });
  angleInput.addEventListener('input', () => {
    angleLabel.textContent = `${angleInput.value}°`;
    updatePreview();
  });

  // Re-render preview on any wheel/hex/lightness interaction too.
  ['pointermove', 'pointerup', 'input', 'change'].forEach((evt) => {
    pickerA.el.addEventListener(evt, updatePreview);
    pickerB.el.addEventListener(evt, updatePreview);
  });

  updatePreview();

  return { getValue: currentValue };
}

if (typeof window !== 'undefined') {
  window.FieldLogColorPicker = { createAppearancePicker, isValidHex, hsvToRgb, rgbToHsv, hexToRgb, rgbToHex };
}

// Also export for Node-based unit tests (no window there).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hsvToRgb, rgbToHsv, hexToRgb, rgbToHex, isValidHex };
}

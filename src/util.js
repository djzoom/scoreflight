import * as THREE from "three";

// One colour per staff/part. Warm, distinct, and bright enough to bloom.
export const STAFF_COLORS = [
  "#ffb347", // amber
  "#5ad1ff", // sky
  "#ff6b9d", // rose
  "#8cff7a", // lime
  "#c792ff", // violet
  "#ffe66d", // yellow
  "#7affd6", // mint
  "#ff8c5a", // coral
];

export function staffColor(i) {
  return new THREE.Color(STAFF_COLORS[i % STAFF_COLORS.length]);
}

/** Radial glow sprite texture. */
export function glowTexture(size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.22)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Rasterise an SVG string into canvas tiles so it can be used as textures on
 * a large plane without hitting the per-texture size limit.
 * Returns { tiles: [{canvas, x, y, w, h}], width, height } in pixels.
 */
export async function rasterizeSvg(svgText, pxWidth, pxHeight, { tile = 4096, paper = "#8e8f93", ink = "#101012" } = {}) {
  let svg = svgText.replace(/<svg viewBox="0 0 ([\d.]+) ([\d.]+)"/, (m, w, h) =>
    `<svg viewBox="0 0 ${w} ${h}" width="${pxWidth}" height="${pxHeight}"`);
  // Verovio draws with currentColor / black; recolour the ink
  svg = svg.replace(/<svg class="definition-scale" color="black"/, `<svg class="definition-scale" color="${ink}"`);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = "async";
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const tiles = [];
  for (let y = 0; y < pxHeight; y += tile) {
    for (let x = 0; x < pxWidth; x += tile) {
      const w = Math.min(tile, pxWidth - x);
      const h = Math.min(tile, pxHeight - y);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = paper;
      g.fillRect(0, 0, w, h);
      g.drawImage(img, x, y, w, h, 0, 0, w, h);
      tiles.push({ canvas: c, x, y, w, h });
      await new Promise(r => setTimeout(r, 0)); // let the loader UI breathe
    }
  }
  URL.revokeObjectURL(url);
  return { tiles, width: pxWidth, height: pxHeight, image: img };
}

/** A small procedural wood texture for the music box. */
export function woodTexture(w = 512, h = 512, base = [116, 72, 40]) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const grain = Math.sin((x * 0.045) + Math.sin(y * 0.012) * 3 + Math.sin(x * 0.3 + y * 0.02) * 0.4);
      const fine = (Math.random() - 0.5) * 10;
      const k = 0.78 + 0.22 * (grain * 0.5 + 0.5);
      const i = (y * w + x) * 4;
      d[i] = base[0] * k + fine;
      d[i + 1] = base[1] * k + fine;
      d[i + 2] = base[2] * k + fine;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

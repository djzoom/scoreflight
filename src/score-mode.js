import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { staffColor, glowTexture, rasterizeSvg, clamp, damp } from "./util.js";

const WORLD_PER_PX = 0.02; // 1 Verovio px (outer viewBox) = 0.02 world units
const PIXEL_BUDGET = 42e6;  // keep the rasterised score under ~170 MB of RGBA

/**
 * Fly-over mode: the engraved score lies on a dark stone floor; the camera
 * glides along each system while every note that sounds lights up in the
 * colour of its staff.
 */
export class ScoreScene {
  constructor(renderer, onProgress) {
    this.renderer = renderer;
    this.onProgress = onProgress || (() => {});
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#121214");
    this.scene.fog = new THREE.FogExp2("#121214", 0.035);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.follow = true;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.glow = glowTexture();
    this.sprites = [];
    this.activeFrom = 0;
    this.tmp = new THREE.Vector3();
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.lastT = -1;

    const hemi = new THREE.HemisphereLight("#9aa4b8", "#141210", 0.4);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight("#fff2dc", 1.1);
    key.position.set(-6, 10, 4);
    this.scene.add(key);
    this.lamp = new THREE.PointLight("#ffe9c4", 13, 26, 1.7);
    this.scene.add(this.lamp);
  }

  async build(piece, svgText) {
    this.clear();
    this.piece = piece;
    const outer = piece.outer, inner = piece.inner;
    const scale = Math.min(2.2, Math.sqrt(PIXEL_BUDGET / (outer.w * outer.h)));
    const pxW = Math.round(outer.w * scale), pxH = Math.round(outer.h * scale);
    this.onProgress(`正在刻谱 ${pxW}×${pxH}…`);
    const raster = await rasterizeSvg(svgText, pxW, pxH, { paper: "#55565a", ink: "#09090a" });

    // world size of the whole page
    const W = outer.w * WORLD_PER_PX, H = outer.h * WORLD_PER_PX;
    this.W = W; this.H = H;
    const toWorld = (px, py) => new THREE.Vector3(px * WORLD_PER_PX - W / 2, 0, py * WORLD_PER_PX - H / 2);
    this.toWorld = toWorld;

    // floor beneath (so the page reads as a slab on stone)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 3, H * 3 + 60),
      new THREE.MeshStandardMaterial({ color: "#1b1b1e", roughness: 1, metalness: 0 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.03;
    this.group.add(floor);

    // page tiles
    for (const t of raster.tiles) {
      const tex = new THREE.CanvasTexture(t.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      const w = t.w / scale * WORLD_PER_PX, h = t.h / scale * WORLD_PER_PX;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.05 }));
      mesh.rotation.x = -Math.PI / 2;
      const p = toWorld(t.x / scale + t.w / scale / 2, t.y / scale + t.h / scale / 2);
      mesh.position.copy(p);
      this.group.add(mesh);
    }

    // note sprites (inner units -> outer px -> world)
    const k = outer.w / inner.w;
    const mat = {};
    const spriteSize = 0.55;
    this.notes = piece.notes;
    this.sprites = new Array(this.notes.length);
    this.notePos = new Array(this.notes.length);
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      const staff = n[3];
      if (!mat[staff]) {
        mat[staff] = new THREE.SpriteMaterial({
          map: this.glow, color: staffColor(staff), blending: THREE.AdditiveBlending,
          depthWrite: false, transparent: true, opacity: 0,
        });
      }
      const s = new THREE.Sprite(mat[staff].clone());
      const p = toWorld(n[4] * k, n[5] * k);
      p.y = 0.03;
      s.position.copy(p);
      s.scale.setScalar(spriteSize);
      s.visible = false;
      this.notePos[i] = p;
      this.sprites[i] = s;
      this.group.add(s);
    }

    // camera path: one keyframe per onset, (time -> position on the page)
    const keys = [];
    let i = 0;
    while (i < this.notes.length) {
      const t = this.notes[i][0];
      let sx = 0, sz = 0, c = 0;
      while (i < this.notes.length && this.notes[i][0] === t) { sx += this.notePos[i].x; sz += this.notePos[i].z; i++; c++; }
      keys.push({ t, x: sx / c, z: sz / c, sys: this.notes[i - 1][6] });
    }
    // snap z to the system's centre line so the camera doesn't bob between staves
    const sysCenter = piece.systems.map(s => ((s.y0 + s.y1) / 2) * k * WORLD_PER_PX - H / 2);
    const sysHeight = piece.systems.map(s => (s.y1 - s.y0) * k * WORLD_PER_PX);
    for (const key of keys) key.z = sysCenter[key.sys] ?? key.z;
    this.keys = keys;
    this.sysHeight = sysHeight;
    this.endKey = { t: piece.duration + 1, x: keys[keys.length - 1].x + 2, z: keys[keys.length - 1].z, sys: keys[keys.length - 1].sys };

    this.resetCamera();
    this.activeFrom = 0;
    this.lastT = -1;
  }

  /** Where the music currently "is" on the page. */
  playhead(t) {
    const keys = this.keys;
    if (!keys || !keys.length) return { x: 0, z: 0, sys: 0 };
    if (t <= keys[0].t) return keys[0];
    let lo = 0, hi = keys.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (keys[m].t <= t) lo = m; else hi = m - 1; }
    const a = keys[lo], b = keys[lo + 1] || this.endKey;
    if (b.sys !== a.sys) return a;
    const u = clamp((t - a.t) / Math.max(1e-3, b.t - a.t), 0, 1);
    return { x: a.x + (b.x - a.x) * u, z: a.z, sys: a.sys };
  }

  resetCamera() {
    const p = this.playhead(0);
    const h = this.sysHeight?.[0] ?? 3;
    this.camPos.set(p.x - 7, 5 + h * 0.6, p.z + 5 + h * 0.9);
    this.camLook.set(p.x + 3, 0, p.z);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.controls.target.copy(this.camLook);
  }

  setFollow(on) {
    this.follow = on;
    this.controls.enabled = !on;
    if (!on) this.controls.target.copy(this.camLook);
  }

  update(t, dt, playing) {
    if (!this.keys) return;
    const p = this.playhead(t);
    const h = this.sysHeight[p.sys] ?? 3;

    if (this.follow) {
      // chase a point behind-and-above the playhead, looking a little ahead
      const sway = Math.sin(t * 0.21) * 0.6;
      const targetPos = this.tmp.set(p.x - 6.5 + sway * 0.4, 4.6 + h * 0.6, p.z + 4.8 + h * 0.9 + sway * 0.5);
      const lambda = playing ? 2.4 : 6;
      this.camPos.x = damp(this.camPos.x, targetPos.x, lambda, dt);
      this.camPos.y = damp(this.camPos.y, targetPos.y, lambda * 0.6, dt);
      this.camPos.z = damp(this.camPos.z, targetPos.z, lambda * 0.6, dt);
      this.camLook.x = damp(this.camLook.x, p.x + 3.5, lambda, dt);
      this.camLook.z = damp(this.camLook.z, p.z, lambda * 0.6, dt);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
    } else {
      this.controls.update();
    }
    this.lamp.position.set(p.x + 1, 3.2, p.z + 0.5);

    // notes: fade in fast on attack, hold while sounding, decay after
    const fade = 1.2;
    const notes = this.notes;
    if (t < this.lastT) { // seeked backwards
      for (let i = this.activeFrom; i < notes.length; i++) { this.sprites[i].visible = false; }
      this.activeFrom = 0;
    }
    this.lastT = t;
    while (this.activeFrom < notes.length && notes[this.activeFrom][0] + notes[this.activeFrom][1] + fade < t) {
      this.sprites[this.activeFrom].visible = false;
      this.activeFrom++;
    }
    for (let i = this.activeFrom; i < notes.length; i++) {
      const n = notes[i];
      if (n[0] > t) break;
      const s = this.sprites[i];
      const since = t - n[0];
      const end = n[1];
      let a;
      if (since < 0.05) a = since / 0.05;
      else if (since < end) a = 1 - 0.35 * clamp((since - 0.05) / Math.max(0.3, end), 0, 1);
      else a = 0.65 * Math.max(0, 1 - (since - end) / fade);
      s.visible = a > 0.01;
      s.material.opacity = a;
      const size = 0.42 + 0.5 * a + (since < 0.12 ? 0.35 * (1 - since / 0.12) : 0);
      s.scale.setScalar(size);
    }
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    for (const obj of [...this.group.children]) {
      this.group.remove(obj);
      obj.geometry?.dispose();
      if (obj.isMesh) obj.material.map?.dispose?.();
      obj.material?.dispose();
    }
    this.sprites = [];
    this.keys = null;
  }
}

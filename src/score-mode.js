import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { staffColor, glowTexture, rasterizeSvg, clamp, damp } from "./util.js";

const WORLD_PER_PX = 0.02; // 1 Verovio px (outer viewBox) = 0.02 world units
const PIXEL_BUDGET = 42e6;  // keep the rasterised score under ~170 MB of RGBA
const WHITE = new THREE.Color(1, 1, 1);

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

    // notes (inner units -> outer px -> world). Each note gets a small emissive
    // disc lying flat on the page (the notehead itself turning into a lamp) and a
    // soft flat halo; the brightest ones also drive real point lights so the
    // engraving around them is lit.
    const k = outer.w / inner.w;
    this.notes = piece.notes;
    const N = this.notes.length;
    this.notePos = new Array(N);
    this.noteColor = new Array(N);
    const headR = 0.085;
    const coreGeo = new THREE.CircleGeometry(headR, 20);
    coreGeo.rotateX(-Math.PI / 2);
    const haloGeo = new THREE.PlaneGeometry(1, 1);
    haloGeo.rotateX(-Math.PI / 2);
    this.core = new THREE.InstancedMesh(coreGeo,
      new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false, depthWrite: false }), N);
    this.halo = new THREE.InstancedMesh(haloGeo,
      new THREE.MeshBasicMaterial({ map: this.glow, color: "#ffffff", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), N);
    this.core.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.halo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.core.frustumCulled = this.halo.frustumCulled = false;
    this.core.renderOrder = 2; this.halo.renderOrder = 1;
    const m = new THREE.Matrix4();
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const black = new THREE.Color(0, 0, 0);
    for (let i = 0; i < N; i++) {
      const n = this.notes[i];
      const p = toWorld(n[4] * k + 4, n[5] * k); // +4px: the glyph's x is its left edge
      p.y = 0.012;
      this.notePos[i] = p;
      this.noteColor[i] = staffColor(n[3]);
      this.core.setMatrixAt(i, zero);
      this.halo.setMatrixAt(i, zero);
      this.core.setColorAt(i, black);
      this.halo.setColorAt(i, black);
    }
    this.group.add(this.halo, this.core);
    this.tmpM = m;
    this.tmpC = new THREE.Color();

    // a pool of real lights, handed to the most recently struck notes
    this.lights = [];
    for (let i = 0; i < 10; i++) {
      const l = new THREE.PointLight("#ffffff", 0, 7, 2);
      l.visible = false;
      this.group.add(l);
      this.lights.push(l);
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

    // notes: flash on attack, glow while sounding, ember afterwards
    const fade = 1.6;
    const notes = this.notes;
    const M = this.tmpM, C = this.tmpC;
    const zero = this.zeroM || (this.zeroM = new THREE.Matrix4().makeScale(0, 0, 0));
    if (t < this.lastT) { // seeked backwards
      for (let i = this.activeFrom; i < notes.length; i++) { this.core.setMatrixAt(i, zero); this.halo.setMatrixAt(i, zero); }
      this.activeFrom = 0;
    }
    this.lastT = t;
    while (this.activeFrom < notes.length && notes[this.activeFrom][0] + notes[this.activeFrom][1] + fade < t) {
      this.core.setMatrixAt(this.activeFrom, zero);
      this.halo.setMatrixAt(this.activeFrom, zero);
      this.activeFrom++;
    }
    const lit = []; // candidates for real lights: [brightness, index]
    for (let i = this.activeFrom; i < notes.length; i++) {
      const n = notes[i];
      if (n[0] > t) break;
      const since = t - n[0];
      const end = Math.max(0.12, n[1]);
      let a;
      if (since < 0.04) a = since / 0.04;
      else if (since < end) a = 1 - 0.3 * clamp((since - 0.04) / Math.max(0.4, end), 0, 1);
      else a = 0.7 * Math.pow(Math.max(0, 1 - (since - end) / fade), 1.6);
      const p = this.notePos[i], col = this.noteColor[i];
      // core: the notehead burns white-hot at the attack, settles to its colour
      const hot = since < 0.15 ? 1 - since / 0.15 : 0;
      C.copy(col).lerp(WHITE, 0.55 * hot + 0.15).multiplyScalar(0.4 + 2.6 * a);
      this.core.setColorAt(i, C);
      M.makeScale(1 + 0.6 * hot, 1, 1 + 0.6 * hot).setPosition(p);
      this.core.setMatrixAt(i, M);
      // halo: a soft pool of colour on the paper
      const r = 0.55 + 0.45 * a + 0.3 * hot;
      C.copy(col).multiplyScalar(0.55 * a);
      this.halo.setColorAt(i, C);
      M.makeScale(r, 1, r).setPosition(p);
      this.halo.setMatrixAt(i, M);
      if (a > 0.05) lit.push([a * (1 + hot), i]);
    }
    this.core.instanceMatrix.needsUpdate = this.halo.instanceMatrix.needsUpdate = true;
    this.core.instanceColor.needsUpdate = this.halo.instanceColor.needsUpdate = true;

    // real lights for the brightest handful, so the engraving around them is lit
    lit.sort((x, y) => y[0] - x[0]);
    for (let j = 0; j < this.lights.length; j++) {
      const l = this.lights[j];
      if (j < lit.length) {
        const [a, i] = lit[j];
        l.position.copy(this.notePos[i]).setY(0.28);
        l.color.copy(this.noteColor[i]);
        l.intensity = 1.6 * a;
        l.visible = true;
      } else {
        l.visible = false;
        l.intensity = 0;
      }
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
    this.keys = null;
    this.lights = [];
  }
}

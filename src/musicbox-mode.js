import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { staffColor, glowTexture, woodTexture, clamp } from "./util.js";

const TOOTH_SPACING = 0.1;
const SECONDS_PER_TURN = 45;   // roughly one minute of music per revolution, like the real thing
const MAX_TURNS = 10;          // rows of pins that fit between two teeth
const SHIFT_FRAC = 0.05;       // the last 5% of each turn is where the cylinder slides over

/**
 * Music-box mode: the score is "written" onto a brass cylinder as pins, one
 * pin per note (angle = time, row = pitch). A steel comb with one tooth per
 * distinct pitch sits beside the drum; as it turns, pins pluck the teeth.
 */
export class MusicBoxScene {
  constructor(renderer, onProgress) {
    this.renderer = renderer;
    this.onProgress = onProgress || (() => {});
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#0f0e10");
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.maxPolarAngle = Math.PI * 0.52;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.glow = glowTexture();
    this.follow = true;

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.28;
    pmrem.dispose();

    const key = new THREE.SpotLight("#ffe7c7", 28, 60, Math.PI / 4.5, 0.7, 1.5);
    key.position.set(-5, 10, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight("#8fb7ff", 0.8);
    rim.position.set(6, 4, -6);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight("#4a4040", 0.5));

    this.wood = woodTexture();
    this.brass = new THREE.MeshStandardMaterial({ color: "#c9a25a", metalness: 0.9, roughness: 0.32 });
    this.steel = new THREE.MeshStandardMaterial({ color: "#d8dde3", metalness: 0.95, roughness: 0.22 });
    this.darkSteel = new THREE.MeshStandardMaterial({ color: "#6a6f78", metalness: 0.9, roughness: 0.4 });
  }

  async build(piece, scoreImage) {
    this.clear();
    this.piece = piece;
    this.onProgress("正在把乐谱写进滚筒…");
    const notes = piece.notes;

    // --- teeth: one per distinct pitch
    const pitches = [...new Set(notes.map(n => n[2]))].sort((a, b) => a - b);
    const N = pitches.length;
    const toothIndex = new Map(pitches.map((p, i) => [p, i]));
    const combLen = N * TOOTH_SPACING;

    // --- how the tune is laid out on the cylinder
    // Like a real multi-air box: the piece is split over K revolutions. Pins of
    // revolution r sit r*(pitch/K) to the side of the tooth; at the end of each
    // turn a snail cam shifts the cylinder by one such step, so the next row
    // of pins lines up with the teeth while the others pass between them.
    // The shift is done "semi-helicoidally" — pins in the last few degrees of
    // a turn are laid on a diagonal — so the music never has to pause.
    const K = clamp(Math.ceil(piece.duration / SECONDS_PER_TURN), 1, MAX_TURNS);
    const Tturn = (piece.duration + 1.0) / K;      // seconds per revolution
    const step = TOOTH_SPACING / K;                // axial shift per revolution
    this.K = K; this.Tturn = Tturn; this.step = step;
    const R = clamp(combLen * 0.26, 0.7, 1.2);
    const L = combLen + 0.8;
    this.R = R; this.L = L;

    const zOf = (j) => (j - (N - 1) / 2) * TOOTH_SPACING;
    const tipX = -R - 0.035;
    const maxLen = 1.25, minLen = 0.55;

    // --- drum
    const drum = new THREE.Group();
    this.drum = drum;
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L, 128, 1), this.brass);
    cyl.rotation.x = Math.PI / 2;
    drum.add(cyl);
    for (const s of [-1, 1]) { // end caps
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.35, R * 0.35, 0.12, 48), this.darkSteel);
      cap.rotation.x = Math.PI / 2; cap.position.z = s * (L / 2 + 0.06);
      drum.add(cap);
    }
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, L + 2.4, 24), this.steel);
    axle.rotation.x = Math.PI / 2;
    axle.position.z = 0.6;
    drum.add(axle);

    // pins: angle = time within the turn, z = tooth + row offset
    const pinR = clamp(step * 0.32, 0.004, 0.014);
    const pinGeo = new THREE.CylinderGeometry(pinR, pinR * 1.25, 0.11, 6);
    pinGeo.translate(0, 0.055, 0);
    const pins = new THREE.InstancedMesh(pinGeo, this.steel, notes.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const phase = (n[0] % Tturn) / Tturn;
      const theta = Math.PI - phase * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0);
      pos.copy(dir).multiplyScalar(R - 0.01);
      pos.z = zOf(toothIndex.get(n[2])) + (this.rowAt(n[0]) - (K - 1) / 2) * step;
      q.setFromUnitVectors(up, dir);
      m.compose(pos, q, scl);
      pins.setMatrixAt(i, m);
    }
    pins.instanceMatrix.needsUpdate = true;
    drum.add(pins);
    // faint helper lines: one ring per revolution boundary is where the shift happens
    this.group.add(drum);

    // --- snail cam + follower on the far end: steps the cylinder sideways
    this.cam = this.makeSnailCam(K, 0.34, 0.08);
    this.cam.position.set(0, 0, L / 2 + 1.05);
    this.group.add(this.cam);
    const follower = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.3), this.darkSteel);
    follower.position.set(0, 0, L / 2 + 0.78);
    this.follower = follower;
    this.group.add(follower);
    const spring = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 12, 1, true),
      new THREE.MeshStandardMaterial({ color: "#8d9096", metalness: 0.8, roughness: 0.5, wireframe: true }));
    spring.rotation.x = Math.PI / 2;
    spring.position.set(0, 0, -L / 2 - 0.42);
    this.group.add(spring);

    // --- comb
    this.teeth = [];
    this.hitTime = new Float32Array(N).fill(-1e9);
    this.hitColor = new Array(N).fill(null);
    const comb = new THREE.Group();
    const plateX0 = tipX - maxLen - 0.32, plateX1 = tipX - maxLen;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(plateX1 - plateX0, 0.16, combLen + 0.3), this.darkSteel);
    plate.position.set((plateX0 + plateX1) / 2, -0.02, 0);
    comb.add(plate);
    for (let s of [-1, 1]) { // screws
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 16), this.brass);
      screw.position.set((plateX0 + plateX1) / 2, 0.07, s * (combLen / 2 + 0.08));
      comb.add(screw);
    }
    const toothMat = () => new THREE.MeshStandardMaterial({ color: "#d8dde3", metalness: 0.95, roughness: 0.2, emissive: "#000000" });
    const flashMat = (c) => new THREE.SpriteMaterial({ map: this.glow, color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
    for (let j = 0; j < N; j++) {
      const len = maxLen - (maxLen - minLen) * (j / Math.max(1, N - 1));
      const z = zOf(j);
      // fixed root
      const root = new THREE.Mesh(new THREE.BoxGeometry(maxLen - len + 0.001, 0.07, TOOTH_SPACING * 0.5), this.darkSteel);
      root.position.set(plateX1 + (maxLen - len) / 2, 0, z);
      comb.add(root);
      // free tooth, pivot at its root
      const pivot = new THREE.Group();
      pivot.position.set(tipX - len, 0, z);
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(len, 0.045, TOOTH_SPACING * 0.5), toothMat());
      tooth.position.x = len / 2;
      pivot.add(tooth);
      if (j < N * 0.45) { // lead weights under the bass teeth
        const w = 0.16 * (1 - j / (N * 0.45)) + 0.05;
        const weight = new THREE.Mesh(new THREE.BoxGeometry(w, 0.09, TOOTH_SPACING * 0.5), this.darkSteel);
        weight.position.set(len - w / 2 - 0.02, -0.065, 0);
        pivot.add(weight);
      }
      const flash = new THREE.Sprite(flashMat("#ffffff"));
      flash.position.set(len + 0.02, 0.05, 0);
      flash.scale.setScalar(0.5);
      flash.visible = false;
      pivot.add(flash);
      comb.add(pivot);
      this.teeth.push({ pivot, tooth, flash, len });
    }
    this.group.add(comb);

    // --- bearings, governor
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, R + 0.35, 0.16), this.brass);
      post.position.set(0, -(R + 0.35) / 2 + 0.05, s * (L / 2 + 0.45));
      this.group.add(post);
    }
    this.gear = this.makeGear(0.42, 18);
    this.gear.rotation.x = Math.PI / 2;
    this.gear.position.set(0, 0, -L / 2 - 0.75);
    this.group.add(this.gear);
    this.fan = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.55, 0.18), this.steel);
      blade.rotation.z = i * Math.PI / 2;
      this.fan.add(blade);
    }
    this.fan.position.set(R * 0.9, -0.2, -L / 2 - 0.95);
    this.group.add(this.fan);

    // --- wooden box
    const boxW = 2 * R + 3.0, boxD = L + 3.2, wall = 0.14;
    const floorY = -R - 0.55;
    const wallTop = -R * 0.25;
    const woodMat = new THREE.MeshStandardMaterial({ map: this.wood, roughness: 0.55, metalness: 0.02 });
    const velvet = new THREE.MeshStandardMaterial({ color: "#5a1b2a", roughness: 1 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(boxW, 0.3, boxD), woodMat);
    base.position.y = floorY - 0.15;
    this.group.add(base);
    const lining = new THREE.Mesh(new THREE.BoxGeometry(boxW - wall * 2, 0.02, boxD - wall * 2), velvet);
    lining.position.y = floorY + 0.01;
    this.group.add(lining);
    const wallH = wallTop - floorY;
    const mkWall = (w, d, x, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), woodMat);
      mesh.position.set(x, floorY + wallH / 2, z);
      this.group.add(mesh);
    };
    mkWall(boxW, wall, 0, -boxD / 2 + wall / 2);
    mkWall(boxW, wall, 0, boxD / 2 - wall / 2);
    mkWall(wall, boxD, -boxW / 2 + wall / 2, 0);
    mkWall(wall, boxD, boxW / 2 - wall / 2, 0);
    // feet
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), this.brass);
      foot.position.set(sx * (boxW / 2 - 0.3), floorY - 0.4, sz * (boxD / 2 - 0.3));
      this.group.add(foot);
    }

    // --- lid, hinged at the back (-z), open; the score is printed inside
    const lid = new THREE.Group();
    lid.position.set(0, wallTop, -boxD / 2);
    lid.rotation.x = -Math.PI * 0.6;
    const lidMesh = new THREE.Mesh(new THREE.BoxGeometry(boxW, 0.1, boxD), woodMat);
    lidMesh.position.set(0, 0.05, boxD / 2);
    lid.add(lidMesh);
    if (scoreImage) {
      const label = this.scoreLabel(scoreImage, boxW - 0.5, boxD - 0.5);
      label.rotation.x = Math.PI / 2;
      label.position.set(0, -0.001, boxD / 2);
      lid.add(label);
    }
    this.group.add(lid);

    this.cursor = 0;
    this.lastT = -1;
    this.resetCamera();
  }

  scoreLabel(img, w, d) {
    const c = document.createElement("canvas");
    const px = 2048;
    c.width = px; c.height = Math.round(px * d / w);
    const g = c.getContext("2d");
    g.fillStyle = "#d9d0b8";
    g.fillRect(0, 0, c.width, c.height);
    // frame
    g.strokeStyle = "#a08a5a"; g.lineWidth = 10; g.strokeRect(24, 24, c.width - 48, c.height - 48);
    // title
    g.fillStyle = "#3a2f1e";
    g.font = `${Math.round(c.height * 0.07)}px Georgia, 'Times New Roman', serif`;
    g.textAlign = "center";
    g.fillText(this.piece.title, c.width / 2, c.height * 0.14);
    g.font = `${Math.round(c.height * 0.045)}px Georgia, 'Times New Roman', serif`;
    g.fillText(this.piece.composer, c.width / 2, c.height * 0.21);
    // score, scaled to fit under the title
    const areaY = c.height * 0.26, areaH = c.height * 0.68, areaW = c.width - 120;
    const s = Math.min(areaW / img.width, areaH / img.height);
    const dw = img.width * s, dh = img.height * s;
    g.drawImage(img, (c.width - dw) / 2, areaY + (areaH - dh) / 2, dw, dh);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: tex, roughness: 1, envMapIntensity: 0.15 }));
  }

  /** Which pin row (0..K-1) is under the teeth at music time t — continuous,
   *  with the shift eased over the last SHIFT_FRAC of every revolution. */
  rowAt(t) {
    const Tturn = this.Tturn;
    const r = Math.floor(t / Tturn);
    const phase = t / Tturn - r;
    const u = clamp((phase - (1 - SHIFT_FRAC)) / SHIFT_FRAC, 0, 1);
    const ease = u * u * (3 - 2 * u);
    return Math.min(r + ease, this.K - 1);
  }

  /** Stepped snail cam with K steps (last step drops back to the start). */
  makeSnailCam(K, r0, dr) {
    const shape = new THREE.Shape();
    const segs = 24;
    for (let k = 0; k < K; k++) {
      const rad = r0 + k * dr;
      for (let i = 0; i <= segs; i++) {
        const a = ((k + i / segs) / K) * Math.PI * 2;
        const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
        if (k === 0 && i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
      }
    }
    shape.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, 0.07, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false });
    geo.translate(0, 0, -0.05);
    return new THREE.Mesh(geo, this.brass);
  }

  makeGear(r, teeth) {
    const shape = new THREE.Shape();
    const steps = teeth * 4;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const k = (i % 4 === 1 || i % 4 === 2) ? 1 : 0.84;
      const x = Math.cos(a) * r * k, y = Math.sin(a) * r * k;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    const hole = new THREE.Path();
    hole.absarc(0, 0, r * 0.25, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
    geo.center();
    return new THREE.Mesh(geo, this.darkSteel);
  }

  resetCamera() {
    const R = this.R, L = this.L;
    const dist = Math.max(L, R * 2) * 1.25 + 3;
    this.camera.position.set(-dist * 0.7, dist * 0.6, dist * 1.0);
    this.controls.target.set(-R * 0.2, 0, 0);
    this.controls.update();
  }

  setFollow(on) {
    this.follow = on;
    this.controls.autoRotate = on;
  }

  update(t, dt, playing) {
    if (!this.drum) return;
    this.drum.rotation.z = (t / this.Tturn) * Math.PI * 2;
    const row = this.rowAt(t);
    this.drum.position.z = -(row - (this.K - 1) / 2) * this.step;
    this.cam.rotation.z = -(row / this.K) * Math.PI * 2;
    this.follower.position.z = this.L / 2 + 0.78 - (row - (this.K - 1) / 2) * this.step;
    this.gear.rotation.z += dt * (playing ? 1.2 : 0);
    this.fan.rotation.x += dt * (playing ? 18 : 0);
    this.controls.update();

    const notes = this.piece.notes;
    const idx = this.toothIndexCache || (this.toothIndexCache = (() => {
      const pitches = [...new Set(notes.map(n => n[2]))].sort((a, b) => a - b);
      return new Map(pitches.map((p, i) => [p, i]));
    })());
    if (t < this.lastT) { this.cursor = 0; this.hitTime.fill(-1e9); }
    this.lastT = t;
    while (this.cursor < notes.length && notes[this.cursor][0] <= t) {
      const n = notes[this.cursor++];
      const j = idx.get(n[2]);
      this.hitTime[j] = n[0];
      this.hitColor[j] = staffColor(n[3]);
    }
    for (let j = 0; j < this.teeth.length; j++) {
      const tooth = this.teeth[j];
      const tau = t - this.hitTime[j];
      if (tau < 0 || tau > 2.5) {
        tooth.pivot.rotation.z = 0;
        tooth.flash.visible = false;
        tooth.tooth.material.emissiveIntensity = 0;
        continue;
      }
      const env = Math.exp(-tau * 3.2);
      // vibrate: higher teeth are stiffer, so they flutter faster
      const f = 6 + 10 * (j / this.teeth.length);
      tooth.pivot.rotation.z = -0.1 * env * Math.sin(tau * f * Math.PI * 2 + Math.PI / 2) * Math.min(1, tau / 0.03);
      const c = this.hitColor[j];
      tooth.tooth.material.emissive.copy(c);
      tooth.tooth.material.emissiveIntensity = 1.6 * env;
      tooth.flash.material.color.copy(c);
      tooth.flash.material.opacity = Math.min(1, env * 1.4);
      tooth.flash.scale.setScalar(0.35 + 0.5 * env);
      tooth.flash.visible = true;
    }
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    this.group.traverse(o => { o.geometry?.dispose?.(); });
    for (const obj of [...this.group.children]) this.group.remove(obj);
    this.teeth = [];
    this.drum = null;
    this.toothIndexCache = null;
  }
}

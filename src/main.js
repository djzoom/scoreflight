import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { AudioEngine, Transport } from "./audio.js";
import { ScoreScene } from "./score-mode.js";
import { MusicBoxScene } from "./musicbox-mode.js";
import { STAFF_COLORS, rasterizeSvg } from "./util.js";

const $ = (s) => document.querySelector(s);
const ui = {
  piece: $("#piece"), play: $("#play"), time: $("#time"), rate: $("#rate"), rateVal: $("#rateVal"),
  volume: $("#volume"), follow: $("#follow"), progress: $("#progress"), fill: $("#fill"),
  legend: $("#legend"), turn: $("#turn"), info: $("#info"), loader: $("#loader"), loaderText: $("#loaderText"),
  modeButtons: [...document.querySelectorAll("[data-mode]")], canvas: $("#view"),
};

const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const audio = new AudioEngine();
const transport = new Transport(audio);
const scenes = {
  score: new ScoreScene(renderer, setLoader),
  musicbox: new MusicBoxScene(renderer, setLoader),
};
let mode = "score";
let piece = null;
let svgText = null;
let built = { score: null, musicbox: null }; // piece id each scene was built for

const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scenes.score.scene, scenes.score.camera);
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.6, 0.72);
composer.addPass(renderPass);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function setLoader(text) {
  ui.loader.classList.toggle("hidden", !text);
  ui.loaderText.textContent = text || "";
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
  for (const s of Object.values(scenes)) s.resize(w, h);
}
window.addEventListener("resize", resize);
resize();

// ------------------------------------------------------------------ pieces
async function loadIndex() {
  const list = await (await fetch("data/index.json")).json();
  ui.piece.innerHTML = list.map(p =>
    `<option value="${p.id}">${p.composer} — ${p.title}</option>`).join("");
  const wanted = new URLSearchParams(location.search).get("piece");
  if (wanted && list.some(p => p.id === wanted)) ui.piece.value = wanted;
  return list;
}

async function loadPiece(id) {
  transport.stop();
  updatePlayButton();
  setLoader("正在读取乐谱…");
  const [meta, svg] = await Promise.all([
    fetch(`data/${id}/notes.json`).then(r => r.json()),
    fetch(`data/${id}/score.svg`).then(r => r.text()),
  ]);
  piece = meta;
  svgText = svg;
  built = { score: null, musicbox: null };
  transport.load(piece.notes, piece.duration);
  transport.voice = voiceFor;
  ui.info.innerHTML = `<b>${piece.title}</b> · ${piece.composer}${piece.year ? ` (${piece.year})` : ""} · ${piece.notes.length} 个音符 · ${fmt(piece.duration)}`;
  ui.legend.innerHTML = Array.from({ length: piece.staves }, (_, i) =>
    `<span><i style="background:${STAFF_COLORS[i % STAFF_COLORS.length]}"></i>${staffName(i)}</span>`).join("");
  history.replaceState(null, "", `?piece=${id}&mode=${mode}`);
  await ensureBuilt(mode);
  setLoader("");
}

function staffName(i) {
  const f = piece.family, n = piece.staves;
  if (f === "strings" && n === 4) return ["第一小提琴", "第二小提琴", "中提琴", "大提琴"][i];
  if (f === "vocal") return i === 0 ? "人声" : (i === 1 ? "钢琴（右手）" : "钢琴（左手）");
  if (n === 2) return i === 0 ? "右手" : "左手";
  return `声部 ${i + 1}`;
}

function voiceFor(note) {
  if (mode === "musicbox") return audio.musicBox.bind(audio);
  const f = piece.family;
  if (f === "strings") return audio.bowed.bind(audio);
  if (f === "vocal" && note[3] === 0) return audio.bowed.bind(audio);
  return audio.pluck.bind(audio);
}

async function ensureBuilt(which) {
  if (built[which] === piece.id) return;
  const s = scenes[which];
  if (which === "score") {
    await s.build(piece, svgText);
  } else {
    const r = await rasterizeSvg(svgText, 2400, Math.round(2400 * piece.outer.h / piece.outer.w), { paper: "#e9e2cf", ink: "#2a2218" });
    await s.build(piece, r.image);
  }
  built[which] = piece.id;
}

async function setMode(m) {
  mode = m;
  ui.modeButtons.forEach(b => b.classList.toggle("active", b.dataset.mode === m));
  document.body.dataset.mode = m;
  if (piece) {
    setLoader(m === "score" ? "正在铺开乐谱…" : "正在打开八音盒…");
    await ensureBuilt(m);
    setLoader("");
    history.replaceState(null, "", `?piece=${piece.id}&mode=${m}`);
  }
  const s = scenes[m];
  renderPass.scene = s.scene;
  renderPass.camera = s.camera;
  bloom.strength = m === "score" ? 0.9 : 0.55;
  bloom.threshold = m === "score" ? 0.72 : 0.92;
  s.setFollow(ui.follow.checked);
}

// ------------------------------------------------------------------ transport UI
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function updatePlayButton() {
  ui.play.textContent = transport.playing ? "❚❚" : "▶";
  ui.play.title = transport.playing ? "暂停" : "播放";
}

ui.play.addEventListener("click", async () => {
  if (transport.playing) transport.pause(); else await transport.play();
  updatePlayButton();
});
transport.onEnd = updatePlayButton;

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  if (e.code === "Space") { e.preventDefault(); ui.play.click(); }
  if (e.code === "ArrowRight") transport.seek(transport.time + 5);
  if (e.code === "ArrowLeft") transport.seek(transport.time - 5);
  if (e.key === "1") setMode("score");
  if (e.key === "2") setMode("musicbox");
  if (e.key === "c") { ui.follow.checked = !ui.follow.checked; ui.follow.dispatchEvent(new Event("change")); }
});

ui.rate.addEventListener("input", () => {
  const r = Number(ui.rate.value);
  ui.rateVal.textContent = `${r.toFixed(2)}×`;
  transport.setRate(r);
});
ui.volume.addEventListener("input", () => audio.setVolume(Number(ui.volume.value)));
ui.follow.addEventListener("change", () => scenes[mode].setFollow(ui.follow.checked));
ui.progress.addEventListener("pointerdown", (e) => {
  const seekTo = (ev) => {
    const r = ui.progress.getBoundingClientRect();
    transport.seek(((ev.clientX - r.left) / r.width) * transport.duration);
  };
  seekTo(e);
  const move = (ev) => seekTo(ev);
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});
ui.piece.addEventListener("change", () => loadPiece(ui.piece.value));
ui.modeButtons.forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  const t = transport.time;
  const s = scenes[mode];
  if (built[mode] === piece?.id) s.update(t, dt, transport.playing);
  composer.render();
  if (piece) {
    ui.time.textContent = `${fmt(t)} / ${fmt(piece.duration)}`;
    ui.fill.style.width = `${(100 * t / piece.duration).toFixed(2)}%`;
    const mb = scenes.musicbox;
    if (mode === "musicbox" && mb.K) {
      ui.turn.hidden = false;
      ui.turn.textContent = `滚筒第 ${Math.min(mb.K, Math.floor(t / mb.Tturn) + 1)} / ${mb.K} 圈 · 每圈 ${Math.round(mb.Tturn)} 秒`;
    } else ui.turn.hidden = true;
  }
}

(async () => {
  const params = new URLSearchParams(location.search);
  await loadIndex();
  await setMode(params.get("mode") === "musicbox" ? "musicbox" : "score");
  await loadPiece(ui.piece.value);
  frame();
})();

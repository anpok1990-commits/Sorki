// Клиент «Сотки». Рисует стол, принимает ввод и проигрывает броски.
// Клиент НЕ решает исход: он шлёт серверу только ввод, а после ответа сам повторяет
// симуляцию по раскрытому сиду и сверяет хэш с серверным (проверка честности).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-deterministic-compat@0.19.3/rapier.mjs';
import { simulateThrow, CHIP, TILT_OK, TILT_FOUL, AIM_MAX, bitLift } from '../shared/sim.js';
import { randomHex, sha256Hex, deriveFairSeed } from '../shared/fair.js';
import { SKIN_BY_ID, BITS, RARITY } from '../shared/content.js';
import { GameCore } from '../server/core.js';

const $ = (id) => document.getElementById(id);
const H = (CHIP.halfHeight + CHIP.border) * 2;
const params = new URLSearchParams(location.search);
// Онлайн: внутри Telegram (есть подписанные initData) или по явному ?online / ?server=
const TG = window.Telegram?.WebApp;
const ONLINE = params.has('online') || params.has('server') || !!TG?.initData;

const S = {
  state: null, you: null,
  input: { mode: 'slam', tilt: 0, dir: 0, aim: 0, power: 0 },
  commits: {}, mySeeds: {}, last: null, chipInfo: {},
  animating: false, charging: false, slow: false, sheet: null,
  me: null, lobby: null, opponent: null, ratings: null, offline: false,   // онлайн
};

// ================= Three.js сцена =================
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#120f0c');
scene.fog = new THREE.Fog('#120f0c', 80, 160);

const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.maxPolarAngle = 1.45;
controls.minDistance = 10;
controls.maxDistance = 90;

const CAMS = [
  { pos: [0, 24, 27], target: [0, 3.5, 0] },  // цель чуть выше стола: поднятая бита остаётся в кадре
  { pos: [0, 40, 0.01], target: [0, 0, 0] },
  { pos: [22, 7, 16], target: [0, 1.5, 0] },
];
let camIdx = 0, camTween = null;
function camFactor() { return camera.aspect < 0.8 ? 1.25 : camera.aspect < 1.2 ? 1.1 : 1; }
function setCam(i, animate) {
  camIdx = i;
  const c = CAMS[i], f = camFactor();
  const to = new THREE.Vector3(...c.pos).multiplyScalar(f), tg = new THREE.Vector3(...c.target);
  if (!animate) { camera.position.copy(to); controls.target.copy(tg); return; }
  camTween = { from: camera.position.clone(), ft: controls.target.clone(), to, tg, t: 0 };
}

scene.add(new THREE.HemisphereLight('#fff3df', '#2b1d12', 0.75));
const sun = new THREE.DirectionalLight('#fff0d8', 2.4);
sun.position.set(14, 34, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 90 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
const lamp = new THREE.PointLight('#ffb070', 60, 70, 1.6);
lamp.position.set(-18, 16, -10);
scene.add(lamp);

// ---------- Процедурные текстуры ----------
function woodTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d');
  const planks = 5, w = 1024 / planks;
  for (let p = 0; p < planks; p++) {
    const x0 = p * w;
    g.fillStyle = `hsl(${20 + Math.random() * 7}, ${48 + Math.random() * 10}%, ${31 + Math.random() * 7}%)`;
    g.fillRect(x0, 0, w, 1024);
    for (let k = 0; k < 70; k++) {
      g.strokeStyle = `rgba(${Math.random() < .5 ? '45,22,10' : '120,70,35'},${0.08 + Math.random() * 0.18})`;
      g.lineWidth = 0.6 + Math.random() * 2.2;
      const x = x0 + Math.random() * w;
      g.beginPath(); g.moveTo(x, 0);
      g.bezierCurveTo(x + (Math.random() - .5) * 30, 340, x + (Math.random() - .5) * 30, 680, x + (Math.random() - .5) * 14, 1024);
      g.stroke();
    }
    if (Math.random() < 0.6) { // сучок
      const kx = x0 + w * (.25 + Math.random() * .5), ky = Math.random() * 1024;
      for (let r = 16; r > 2; r -= 3) { g.strokeStyle = 'rgba(50,25,10,.35)'; g.lineWidth = 1.2; g.beginPath(); g.ellipse(kx, ky, r * .6, r * 1.6, 0, 0, Math.PI * 2); g.stroke(); }
    }
    g.fillStyle = 'rgba(20,10,4,.75)'; g.fillRect(x0, 0, 3, 1024);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

function hashStr(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }
function lcg(seed) { let s = seed || 1; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }

function drawSkin(g, size, skin) {
  const r = size / 2, TAU = Math.PI * 2, rnd = lcg(hashStr(skin.id));
  g.save();
  g.beginPath(); g.arc(r, r, r, 0, TAU); g.clip();
  g.fillStyle = skin.bg; g.fillRect(0, 0, size, size);
  g.fillStyle = skin.fg; g.strokeStyle = skin.fg;
  g.globalAlpha = 0.55;
  switch (skin.pattern) {
    case 'rays': for (let i = 0; i < 16; i += 2) { g.beginPath(); g.moveTo(r, r); g.arc(r, r, r, i * TAU / 16, (i + 1) * TAU / 16); g.fill(); } break;
    case 'waves': g.lineWidth = size * .03; for (let y = size * .08; y < size; y += size * .1) { g.beginPath(); for (let x = 0; x <= size; x += 4) g.lineTo(x, y + Math.sin(x / size * TAU * 2) * size * .025); g.stroke(); } break;
    case 'checker': { const s = size / 8; for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if ((i + j) % 2) g.fillRect(i * s, j * s, s, s); } break;
    case 'rings': g.lineWidth = size * .04; for (let rr = r; rr > 0; rr -= size * .09) { g.beginPath(); g.arc(r, r, rr, 0, TAU); g.stroke(); } break;
    case 'dots': for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) { g.beginPath(); g.arc((i + .5 + (j % 2) * .5) * size / 9, (j + .5) * size / 9, size * .028, 0, TAU); g.fill(); } break;
    case 'bolt': case 'stripes': g.lineWidth = size * .05; g.save(); g.translate(r, r); g.rotate(skin.pattern === 'bolt' ? .6 : 0); for (let x = -size; x < size; x += size * .12) { g.beginPath(); g.moveTo(x, -size); g.lineTo(x, size); g.stroke(); } g.restore(); break;
    case 'spiral': g.lineWidth = size * .03; g.beginPath(); for (let a = 0; a < TAU * 5; a += .05) g.lineTo(r + Math.cos(a) * a / (TAU * 5) * r, r + Math.sin(a) * a / (TAU * 5) * r); g.stroke(); break;
    case 'stars': g.globalAlpha = .9; for (let i = 0; i < 60; i++) { g.beginPath(); g.arc(rnd() * size, rnd() * size, size * (.004 + rnd() * .012), 0, TAU); g.fill(); } break;
    case 'grid': g.lineWidth = size * .012; for (let x = 0; x < size; x += size / 10) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, size); g.moveTo(0, x); g.lineTo(size, x); g.stroke(); } break;
    case 'yinyang': g.globalAlpha = 1; g.beginPath(); g.arc(r, r, r * .8, -Math.PI / 2, Math.PI / 2); g.arc(r, r + r * .4, r * .4, Math.PI / 2, -Math.PI / 2, true); g.arc(r, r - r * .4, r * .4, Math.PI / 2, -Math.PI / 2); g.fill(); break;
    case 'holo': { const gr = g.createConicGradient ? g.createConicGradient(0, r, r) : null; if (gr) { ['#ff6ec7', '#7af', '#6fffd2', '#fff36e', '#ff6ec7'].forEach((c, i) => gr.addColorStop(i / 4, c)); g.fillStyle = gr; g.globalAlpha = .45; g.fillRect(0, 0, size, size); } } break;
  }
  g.globalAlpha = 1;
  // центральный медальон
  g.beginPath(); g.arc(r, r, r * .42, 0, TAU); g.fillStyle = skin.bg; g.fill();
  g.lineWidth = size * .03; g.strokeStyle = skin.fg; g.stroke();
  g.fillStyle = skin.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  const gl = [...(skin.glyph || '')].length;
  g.font = `700 ${size * (gl >= 3 ? .17 : gl === 2 ? .22 : .3)}px Rubik, system-ui, sans-serif`;
  if (skin.glyph) g.fillText(skin.glyph, r, r + size * .012);
  // лента с именем
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, size * .79, size, size * .11);
  g.fillStyle = '#fff'; g.font = `500 ${size * .065}px Rubik, system-ui, sans-serif`;
  g.fillText(skin.name.toUpperCase(), r, size * .847);
  // кольцо редкости
  g.lineWidth = size * .05; g.strokeStyle = RARITY[skin.rarity].color;
  g.beginPath(); g.arc(r, r, r - size * .025, 0, TAU); g.stroke();
  g.restore();
}

const skinTex = new Map(), skinURL = new Map();
function getSkinTexture(skinId) {
  if (!skinTex.has(skinId)) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    drawSkin(c.getContext('2d'), 256, SKIN_BY_ID[skinId]);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    skinTex.set(skinId, t);
    skinURL.set(skinId, c.toDataURL());
  }
  return skinTex.get(skinId);
}
function getSkinURL(skinId) { getSkinTexture(skinId); return skinURL.get(skinId); }

function backTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), r = 128;
  g.fillStyle = '#d9d1c1'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(80,60,40,.35)'; g.lineWidth = 3;
  for (let rr = 118; rr > 20; rr -= 14) { g.beginPath(); g.arc(r, r, rr, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = '#5b4a3a'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '400 30px "Rubik Mono One", "Arial Black", sans-serif'; g.fillText('СОТКИ', r, r - 6);
  g.font = '500 16px Rubik, sans-serif'; g.fillText('· 2000 ·', r, r + 24);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function drawBit(g, size, bit) {
  const r = size / 2, TAU = Math.PI * 2;
  const base = { std: '#1f1e22', heavy: '#55595f', wide: '#d8352a' }[bit.id] || '#222';
  const hi = { std: '#3a393f', heavy: '#8a9098', wide: '#ff6a5c' }[bit.id] || '#444';
  g.save(); g.beginPath(); g.arc(r, r, r, 0, TAU); g.clip();
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  g.strokeStyle = hi; g.lineWidth = size * .025;
  for (const rr of [r * .95, r * .78]) { g.beginPath(); g.arc(r, r, rr, 0, TAU); g.stroke(); }
  g.beginPath(); // звезда
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .22 : r * .55; g.lineTo(r + Math.cos(a) * rr, r + Math.sin(a) * rr); }
  g.closePath(); g.fillStyle = hi; g.fill();
  g.fillStyle = hi; g.textAlign = 'center'; g.font = `700 ${size * .08}px Rubik, sans-serif`;
  g.fillText('БИТА · ' + bit.name.toUpperCase(), r, size * .16);
  g.restore();
}
const bitTex = new Map();
function getBitTexture(id) {
  if (!bitTex.has(id)) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    drawBit(c.getContext('2d'), 256, BITS[id]);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; bitTex.set(id, t);
  }
  return bitTex.get(id);
}

// ---------- Стол ----------
{
  const wood = woodTexture();
  const top = new THREE.MeshStandardMaterial({ map: wood, roughness: .72, metalness: 0 });
  const side = new THREE.MeshStandardMaterial({ color: '#3a2415', roughness: .8 });
  const table = new THREE.Mesh(new THREE.BoxGeometry(90, 3, 90), [side, side, top, side, side, side]);
  table.position.y = -1.5;
  table.receiveShadow = true;
  scene.add(table);
}

// ---------- Фишки и биты ----------
const chipSideGeo = new THREE.CylinderGeometry(CHIP.radius, CHIP.radius, H, 48, 1, true);
const chipCapGeo = new THREE.CircleGeometry(CHIP.radius, 48);
const backMat = new THREE.MeshStandardMaterial({ map: backTexture(), roughness: .85 });
const chipObjs = new Map();
const FACE_DOWN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
const FACE_UP = new THREE.Quaternion();

function makeDisc(radius, thick, topMat, botMat, sideMat) {
  const grp = new THREE.Group();
  const side = new THREE.Mesh(radius === CHIP.radius ? chipSideGeo : new THREE.CylinderGeometry(radius, radius, thick, 48, 1, true), sideMat);
  const capGeo = radius === CHIP.radius ? chipCapGeo : new THREE.CircleGeometry(radius, 48);
  const top = new THREE.Mesh(capGeo, topMat); top.rotation.x = -Math.PI / 2; top.position.y = thick / 2;
  const bot = new THREE.Mesh(capGeo, botMat); bot.rotation.x = Math.PI / 2; bot.position.y = -thick / 2;
  for (const m of [side, top, bot]) { m.castShadow = true; m.receiveShadow = true; grp.add(m); }
  return grp;
}

function getChipObj(uid) {
  let o = chipObjs.get(uid);
  if (o) return o;
  const chip = S.chipInfo[uid];
  const skin = SKIN_BY_ID[chip?.skin] || SKIN_BY_ID.s01;
  const sideColor = skin.rarity === 'epic' || skin.rarity === 'legendary' ? RARITY[skin.rarity].color : '#e6ddcb';
  o = makeDisc(CHIP.radius, H,
    new THREE.MeshStandardMaterial({ map: getSkinTexture(skin.id), roughness: skin.pattern === 'holo' ? .3 : .6, metalness: skin.pattern === 'holo' ? .35 : 0 }),
    backMat, new THREE.MeshStandardMaterial({ color: sideColor, roughness: .7 }));
  o.userData.uid = uid;
  scene.add(o);
  chipObjs.set(uid, o);
  return o;
}
function dropChipObj(uid) {
  const o = chipObjs.get(uid); if (!o) return;
  scene.remove(o); chipObjs.delete(uid);
}

const bitObjs = {};
function getBitObj(id) {
  if (!bitObjs[id]) {
    const b = BITS[id];
    const mat = new THREE.MeshStandardMaterial({ map: getBitTexture(id), roughness: id === 'heavy' ? .35 : .55, metalness: id === 'heavy' ? .6 : 0 });
    const side = new THREE.MeshStandardMaterial({ color: { std: '#1f1e22', heavy: '#55595f', wide: '#d8352a' }[id], roughness: .5, metalness: id === 'heavy' ? .6 : 0 });
    bitObjs[id] = makeDisc(b.radius, b.halfHeight * 2, mat, mat, side);
    bitObjs[id].visible = false;
    scene.add(bitObjs[id]);
  }
  return bitObjs[id];
}

// маркеры исхода
const markerGeo = new THREE.TorusGeometry(CHIP.radius + .35, .12, 8, 48);
function addMarker(obj, color) {
  const m = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .95 }));
  m.position.copy(obj.position); m.position.y += .4; m.rotation.x = Math.PI / 2;
  scene.add(m);
  return m;
}

// ---------- Твины ----------
const tweens = [];
const ease = (t) => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
function tweenTo(obj, pos, quat, dur = 450) {
  return new Promise((res) => {
    for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].obj === obj) tweens.splice(i, 1);
    tweens.push({ obj, p0: obj.position.clone(), q0: obj.quaternion.clone(), p1: pos.clone(), q1: quat.clone(), t: 0, dur: dur / 1000, res });
  });
}
const isTweening = (obj) => tweens.some(t => t.obj === obj);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Позы: стопка и превью ----------
const stackPos = (i) => new THREE.Vector3(0, H / 2 + i * (H + 0.002), 0);

function tiltAxis(dirDeg) {
  const d = dirDeg * Math.PI / 180;
  return new THREE.Vector3(Math.sin(d), 0, -Math.cos(d)).normalize();
}

function previewBitPose(inp, bitId, n) {
  const b = BITS[bitId];
  const tiltRad = inp.tilt / 10 * Math.PI / 180;
  const q = new THREE.Quaternion().setFromAxisAngle(tiltAxis(inp.dir), tiltRad);
  const a = inp.aim / 1000 * AIM_MAX, d = inp.dir * Math.PI / 180;
  const stackTop = n * (H + 0.002);
  // та же высота, что и в симуляции: бита поднимается вместе с пальцем
  return { pos: new THREE.Vector3(a * Math.cos(d), stackTop + bitLift(inp.power) + b.radius * tiltRad, a * Math.sin(d)), quat: q };
}

function previewDropPoses(inp, n) {
  const tiltQ = new THREE.Quaternion().setFromAxisAngle(tiltAxis(inp.dir), -(inp.tilt / 10) * Math.PI / 180);
  const h0 = 3 + (inp.power / 1000) * 27;             // как в симуляции
  const cy = h0 + n * H / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = new THREE.Vector3(0, (i + .5) * H - n * H / 2, 0).applyQuaternion(tiltQ);
    p.y += cy;
    out.push({ pos: p, quat: tiltQ.clone().multiply(FACE_DOWN) });
  }
  return out;
}

function currentBitId() {
  const st = S.state; if (!st) return 'std';
  return st.players[st.current]?.bit || 'std';
}

function updatePreview() {
  const st = S.state;
  const aiming = st && st.phase === 'aim' && !S.animating;
  for (const id of Object.keys(BITS)) if (bitObjs[id] && !isTweening(bitObjs[id]) && !S.animating) bitObjs[id].visible = false;
  if (!aiming) return;
  const n = st.table.length;
  if (S.input.mode === 'slam') {
    const bit = getBitObj(currentBitId());
    if (!isTweening(bit)) {
      const p = previewBitPose(S.input, currentBitId(), n);
      bit.visible = true; bit.position.copy(p.pos); bit.quaternion.copy(p.quat);
    }
    st.table.forEach((c, i) => { const o = getChipObj(c.uid); if (!isTweening(o)) { o.position.copy(stackPos(i)); o.quaternion.copy(FACE_DOWN); } });
  } else if (!S.charging) {
    st.table.forEach((c, i) => { const o = getChipObj(c.uid); if (!isTweening(o)) { o.position.copy(stackPos(i)); o.quaternion.copy(FACE_DOWN); } });
  } else {
    const poses = previewDropPoses(S.input, n);
    st.table.forEach((c, i) => { const o = getChipObj(c.uid); if (!isTweening(o)) { o.position.copy(poses[i].pos); o.quaternion.copy(poses[i].quat); } });
  }
}

// ---------- Звук, вибрация, встряска ----------
// Звук синтезируется на лету (WebAudio, без файлов): короткий щелчок шума через полосовой
// фильтр — «пластик о пластик». Бита ниже и громче, плюс глухой удар.
const FX = { ctx: null, noise: null, on: true, lastHaptic: 0 };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
try { FX.on = localStorage.getItem('caps-sound') !== 'off'; } catch {}
function audioInit() {
  if (FX.ctx) { if (FX.ctx.state === 'suspended') FX.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
  FX.ctx = new AC();
  const len = Math.floor(FX.ctx.sampleRate * 0.25);
  FX.noise = FX.ctx.createBuffer(1, len, FX.ctx.sampleRate);
  const d = FX.noise.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
}
addEventListener('pointerdown', audioInit, { capture: true });   // звук разрешён только после касания

function clack(kind, power) {
  if (!FX.on || !FX.ctx || FX.ctx.state !== 'running') return;
  const c = FX.ctx, t = c.currentTime, bit = kind === 'bit';
  const src = c.createBufferSource(); src.buffer = FX.noise;
  const bp = c.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = bit ? 1300 + Math.random() * 300 : 2400 + Math.random() * 1200;
  bp.Q.value = bit ? 2.5 : 5;
  const g = c.createGain();
  g.gain.setValueAtTime(0.04 + power * (bit ? 0.55 : 0.3), t);
  g.gain.exponentialRampToValueAtTime(0.0008, t + (bit ? 0.1 : 0.05));
  src.connect(bp).connect(g).connect(c.destination);
  src.start(t, Math.random() * 0.1, 0.12);
  if (bit && power > 0.35) {                       // глухой «бум» массы биты
    const o = c.createOscillator(), g2 = c.createGain();
    o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(65, t + 0.09);
    g2.gain.setValueAtTime(0.35 * power, t); g2.gain.exponentialRampToValueAtTime(0.0008, t + 0.12);
    o.connect(g2).connect(c.destination); o.start(t); o.stop(t + 0.14);
  }
}
function chime(good) {
  if (!FX.on || !FX.ctx || FX.ctx.state !== 'running') return;
  const c = FX.ctx, t = c.currentTime;
  (good ? [660, 990] : [330, 247]).forEach((f, i) => {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + i * 0.09);
    g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, t + i * 0.09 + 0.25);
    o.connect(g).connect(c.destination); o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.3);
  });
}
function tickSound() {
  if (!FX.on || !FX.ctx || FX.ctx.state !== 'running') return;
  const c = FX.ctx, t = c.currentTime, o = c.createOscillator(), g = c.createGain();
  o.frequency.value = 1800; g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.03);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.04);
}
// Вибрация: в Telegram — HapticFeedback, в остальных браузерах — navigator.vibrate (iPhone в Safari не умеет)
function haptic(kind) {
  const now = performance.now();
  if (kind !== 'success' && kind !== 'warning' && now - FX.lastHaptic < 70) return;
  FX.lastHaptic = now;
  try {
    const h = window.Telegram?.WebApp?.HapticFeedback;
    if (h) {
      if (kind === 'select') h.selectionChanged();
      else if (kind === 'success' || kind === 'warning') h.notificationOccurred(kind);
      else h.impactOccurred(kind);
    } else if (navigator.vibrate) {
      navigator.vibrate({ heavy: 40, medium: 22, light: 10, select: 6, success: [20, 50, 30], warning: [40, 40, 40] }[kind] || 10);
    }
  } catch {}
}
let shakeAmp = 0;
function addShake(a) { if (!reduceMotion) shakeAmp = Math.min(1.1, Math.max(shakeAmp, a)); }

// Удары находим по самим кадрам реплея: резкая смена скорости тела = столкновение.
function findImpacts(local) {
  const F = local.frames, T = local.times, nb = local.nBodies, bitIdx = local.hasBit ? nb - 1 : -1;
  const ev = [], lastAt = new Array(nb).fill(-1);
  const vel = (k, b) => {
    const dt = T[k] - T[k - 1] || 1 / 120, o = b * 7;
    return [(F[k][o] - F[k - 1][o]) / dt, (F[k][o + 1] - F[k - 1][o + 1]) / dt, (F[k][o + 2] - F[k - 1][o + 2]) / dt];
  };
  for (let k = 2; k < F.length; k++) {
    for (let b = 0; b < nb; b++) {
      const v0 = vel(k - 1, b), v1 = vel(k, b);
      const dv = Math.hypot(v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]);
      if (dv > 90 && T[k] - lastAt[b] > 0.04) {
        lastAt[b] = T[k];
        ev.push({ t: T[k - 1], kind: b === bitIdx ? 'bit' : 'chip', power: Math.min(1, dv / 700) });
      }
    }
  }
  ev.sort((a, b) => a.t - b.t);
  const out = []; let winStart = -1, inWin = 0;      // не больше 3 щелчков за 25 мс
  for (const e of ev) {
    if (e.t - winStart > 0.025) { winStart = e.t; inWin = 0; }
    if (inWin++ < 3) out.push(e);
  }
  return out;
}
function fireImpact(e) {
  clack(e.kind, e.power);
  if (e.power > 0.3) {
    addShake((e.kind === 'bit' ? 0.9 : 0.45) * e.power);
    haptic(e.power > 0.65 ? 'heavy' : 'medium');
  }
}

// ---------- Реплей ----------
let playback = null;
function playFrames(local, request) {
  return new Promise((res) => {
    const objs = request.chips.map(getChipObj);
    if (local.hasBit) { const b = getBitObj(request.bitId); b.visible = true; objs.push(b); }
    const F = local.frames, T = local.times;
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    const apply = (i0, a) => {
      const f0 = F[i0], f1 = F[Math.min(i0 + 1, F.length - 1)];
      for (let k = 0; k < objs.length; k++) {
        const o = k * 7;
        objs[k].position.set(f0[o] + (f1[o] - f0[o]) * a, f0[o + 1] + (f1[o + 1] - f0[o + 1]) * a, f0[o + 2] + (f1[o + 2] - f0[o + 2]) * a);
        qa.set(f0[o + 3], f0[o + 4], f0[o + 5], f0[o + 6]); qb.set(f1[o + 3], f1[o + 4], f1[o + 5], f1[o + 6]);
        objs[k].quaternion.slerpQuaternions(qa, qb, a);
      }
    };
    let t = 0, seg = 0, ei = 0;
    const impacts = findImpacts(local);
    const skip = document.createElement('button');
    skip.className = 'chipbtn skip'; skip.textContent = 'Пропустить';
    skip.onclick = () => { t = Infinity; };
    $('app').appendChild(skip);
    playback = {
      update(dt) {
        t += dt * (S.slow ? 0.25 : 1);
        while (ei < impacts.length && impacts[ei].t <= t) { if (t !== Infinity) fireImpact(impacts[ei]); ei++; }
        if (t >= T[T.length - 1]) { apply(F.length - 1, 0); playback = null; skip.remove(); res(); return; }
        while (seg < T.length - 2 && T[seg + 1] <= t) seg++;
        apply(seg, (t - T[seg]) / (T[seg + 1] - T[seg]));
      },
    };
  });
}

// ================= Сеть / транспорт =================
class LocalTransport {
  // «Сервер» в этой же вкладке: тот же GameCore, что и в Node. Сообщения ходят
  // только через JSON — как по настоящей сети, клиент не видит внутренностей сервера.
  constructor(onMsg) { this.onMsg = onMsg; }
  start() {
    this.onMsg({ t: 'you', idx: 'both' });
    this.core = new GameCore(RAPIER, (to, m) => {
      const copy = JSON.parse(JSON.stringify(m));
      setTimeout(() => this.onMsg(copy), 0);
    }, { names: ['Игрок 1', 'Игрок 2'] });
  }
  send(m, as) { const copy = JSON.parse(JSON.stringify(m)); setTimeout(() => this.core.handle(as, copy), 0); }
}

class WsTransport {
  // Сервер авторитетен: сюда приходят только состояние и результаты бросков.
  // При обрыве связи переподключаемся сами — сервер держит место за столом минуту.
  constructor(onMsg) { this.onMsg = onMsg; this.retry = 0; this.room = params.get('room') || TG?.initDataUnsafe?.start_param || null; }
  start() {
    const base = params.get('server') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    this.ws = new WebSocket(base.replace(/\/$/, '') + '/ws');
    this.ws.onopen = () => {
      this.retry = 0;
      const hello = { t: 'hello', room: this.room };
      if (TG?.initData) hello.initData = TG.initData;
      else hello.dev = { id: devId(), name: params.get('name') || 'Гость' };   // только при DEV_AUTH на сервере
      this.room = null;                                    // ссылку используем один раз
      this.ws.send(JSON.stringify(hello));
      if (S.offline) { S.offline = false; setStatus('Связь восстановлена'); }
    };
    this.ws.onmessage = (e) => this.onMsg(JSON.parse(e.data));
    this.ws.onclose = (e) => {
      if (e.code === 4000) { setStatus('Игра открыта в другом окне'); return; }
      S.offline = true;
      const wait = Math.min(10, 2 ** this.retry++);
      setStatus(`Нет связи с сервером, переподключаемся через ${wait} с…`);
      setTimeout(() => this.start(), wait * 1000);
    };
  }
  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
}

function devId() {
  try {
    let id = localStorage.getItem('caps-dev-id');
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('caps-dev-id', id); }
    return id;
  } catch { return Math.random().toString(36).slice(2, 10); }
}

let transport;
let queue = Promise.resolve();
function onMsg(m) { queue = queue.then(() => handleMsg(m)).catch((e) => { console.error(e); S.animating = false; render(); }); }

async function handleMsg(m) {
  switch (m.t) {
    case 'welcome': S.me = m.me; break;
    case 'lobby': showLobby(m); break;
    case 'you':
      S.you = m.idx; S.lobby = null;
      if (m.opponent) S.opponent = { name: m.opponent, online: m.opponentOnline !== false };
      if (S.you !== 'both') hideOverlay();
      break;
    case 'peer':
      if (S.opponent) S.opponent.online = m.status === 'back';
      if (m.status === 'away') toast('Соперник отключился', `Ждём его ${m.graceSec || 60} с — потом партия отменится, ставки вернутся`);
      if (m.status === 'back') toast('Соперник вернулся', 'Продолжаем');
      break;
    case 'notice': toast('', m.msg); break;
    case 'ratings': S.ratings = m; if (S.state?.phase === 'over') renderOverlay(); break;
    case 'state': applyState(m.state); break;
    case 'result': await playResult(m); break;
    case 'error':
      toast('Ошибка', m.msg); S.animating = false;
      if (m.code === 'auth') showOverlay(`<h2>Не удалось войти</h2><p>${esc(m.msg)}</p>`);
      else render();
      break;
  }
}

// ---------- Лобби: создать стол, позвать друга, случайный соперник ----------
function clearTable() {
  S.state = null; S.you = null; S.opponent = null; S.ratings = null;
  for (const uid of [...chipObjs.keys()]) dropChipObj(uid);
  updateTimer();
}

function showLobby(m) {
  if (m.me) S.me = m.me;
  S.lobby = m;
  clearTable();
  if (!m.room) {
    const me = S.me;
    const el = showOverlay(`<h2>Сотки</h2>
      <p>${me ? `${esc(me.name)}, у вас ${plural(me.chips, 'фишка', 'фишки', 'фишек')}.<br>Рейтинг: на битах <b>${me.ratings.slam}</b> · стопкой <b>${me.ratings.drop}</b>` : ''}</p>
      <button class="big" id="lb-create">Создать стол и позвать друга</button>
      <button class="big ghost" id="lb-quick">Случайный соперник</button>`);
    el.querySelector('#lb-create').onclick = () => transport.send({ t: 'create' });
    el.querySelector('#lb-quick').onclick = () => transport.send({ t: 'quick' });
    setStatus('Выберите, с кем играть');
    return;
  }
  if (m.random) {
    const el = showOverlay(`<h2>Ищем соперника…</h2><p>Как только кто-то нажмёт «Случайный соперник», партия начнётся.</p>
      <button class="big ghost" id="lb-cancel">Отменить</button>`);
    el.querySelector('#lb-cancel').onclick = () => transport.send({ t: 'leave' });
    setStatus('Ищем соперника');
    return;
  }
  const el = showOverlay(`<h2>Стол ${esc(m.room)}</h2>
    <p>Отправьте приглашение другу. Как только он откроет ссылку, вы окажетесь за одним столом.</p>
    ${m.invite ? `<button class="big" id="lb-share">Пригласить в Telegram</button>
    <button class="big ghost" id="lb-copy">Скопировать ссылку</button>` : `<p>Код стола: <b>${esc(m.room)}</b></p>`}
    <button class="big ghost" id="lb-cancel">Отменить</button>`);
  el.querySelector('#lb-cancel').onclick = () => transport.send({ t: 'leave' });
  if (m.invite) {
    el.querySelector('#lb-share').onclick = () => {
      const url = `https://t.me/share/url?url=${encodeURIComponent(m.invite)}&text=${encodeURIComponent('Сыграем в Сотки? Ставлю 5 фишек.')}`;
      if (TG?.openTelegramLink) TG.openTelegramLink(url); else window.open(url, '_blank');
    };
    el.querySelector('#lb-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(m.invite); toast('Готово', 'Ссылка скопирована'); }
      catch { toast('Ссылка', m.invite); }
    };
  }
  setStatus('Ждём друга за столом');
}

// ---------- Таймер хода (только онлайн) ----------
let timerEl = null, clockSkew = 0;
function updateTimer() {
  const st = S.state;
  const left = st?.deadline ? Math.ceil((st.deadline - clockSkew - Date.now()) / 1000) : null;
  const show = left !== null && left >= 0 && !S.animating && ['mode', 'rps', 'aim'].includes(st.phase);
  if (!show) { timerEl?.remove(); timerEl = null; return; }
  if (!timerEl) { timerEl = document.createElement('div'); timerEl.className = 'turn-timer'; $('app').appendChild(timerEl); }
  timerEl.textContent = `${left} с`;
  timerEl.classList.toggle('hot', left <= 10);
}
setInterval(updateTimer, 500);

function indexChips(st) {
  for (const c of st.table) S.chipInfo[c.uid] = c;
  for (const p of st.players) for (const c of p.chips) S.chipInfo[c.uid] = c;
}

function applyState(st) {
  const prev = S.state;
  S.animating = false;
  if (S.lobby) { S.lobby = null; hideOverlay(); }
  S.state = st;
  if (st.now) clockSkew = st.now - Date.now();
  if (st.mode) S.input.mode = st.mode;                 // способ задан на всю партию
  indexChips(st);
  if (st.commit) S.commits[st.turn] = st.commit;
  // убрать со сцены фишки, которых больше нет на столе
  const onTable = new Set(st.table.map(c => c.uid));
  for (const uid of [...chipObjs.keys()]) if (!onTable.has(uid)) dropChipObj(uid);
  // собрать оставшиеся в стопку (анимированно, если это продолжение партии)
  const animate = prev && prev.phase !== 'rps' && st.phase === 'aim';
  st.table.forEach((c, i) => {
    const o = getChipObj(c.uid);
    if (animate) tweenTo(o, stackPos(i), FACE_DOWN, 500);
    else { o.position.copy(stackPos(i)); o.quaternion.copy(FACE_DOWN); }
  });
  if (animate && S.input.mode === 'slam') {
    for (const id of Object.keys(bitObjs)) if (bitObjs[id].visible) {
      const p = previewBitPose(S.input, currentBitId(), st.table.length);
      if (id === currentBitId()) tweenTo(bitObjs[id], p.pos, p.quat, 500); else bitObjs[id].visible = false;
    }
  }
  render();
}

async function playResult(m) {
  S.animating = true;
  render();
  const { reveal, request, result } = m;
  const rec = { turn: m.turn, player: m.player, reveal, request, server: result, status: 'wait' };
  S.last = rec;
  renderFairDot();
  if (S.sheet === 'fair') openSheet('fair');

  // 1) сервер не подменил сид: sha256(serverSeed) === коммит, который мы видели ДО броска
  const seenCommit = S.commits[m.turn];
  rec.commitOk = !!seenCommit && (await sha256Hex(reveal.serverSeed)) === seenCommit;
  // 2) сервер использовал наш clientSeed (если бросали мы)
  const mine = S.mySeeds[m.turn];
  rec.clientSeedOk = mine ? mine === reveal.clientSeed : null;
  // 3) повторяем физику у себя и сравниваем хэш итогового состояния
  const t0 = performance.now();
  const fairSeed = await deriveFairSeed(reveal.serverSeed, reveal.clientSeed, m.turn);
  const local = await simulateThrow(RAPIER, { chips: request.chips, bitId: request.bitId, input: request.input, fairSeed, record: true });
  rec.simMs = Math.round(performance.now() - t0);
  rec.localHash = local.hash;
  rec.simOk = local.hash === result.hash;
  rec.status = rec.commitOk && rec.simOk && rec.clientSeedOk !== false ? 'ok' : 'bad';
  renderFairDot();
  if (S.sheet === 'fair') openSheet('fair');

  setStatus(`${S.state.players[m.player].name}: бросок…`);
  await playFrames(local, request);
  await showOutcome(m);
  // до прихода нового состояния показываем стол без выигранных фишек;
  // S.animating снимет applyState, чтобы нельзя было бросить по устаревшему ходу
  const wonSet = new Set(result.won);
  S.state.table = S.state.table.filter(c => !wonSet.has(c.uid));
}

async function showOutcome(m) {
  const { result, player } = m;
  const name = S.state.players[player].name;
  const markers = [];
  for (const o of result.outcome) {
    const obj = chipObjs.get(o.uid); if (!obj) continue;
    if (!result.foul && o.state === 'up') markers.push(addMarker(obj, '#3fd6a4'));
    else if (o.state === 'edge') markers.push(addMarker(obj, '#ffb52e'));
  }
  const edge = result.outcome.filter(o => o.state === 'edge').length;
  if (result.foul) { chime(false); haptic('warning'); }
  else if (result.won.length) { chime(true); haptic('success'); }
  if (result.foul) toast('Фол', `Наклон ${(result.jittered.tilt / 10).toFixed(1)}° больше 30°: бросок не засчитан`);
  else if (result.won.length) toast(`+${result.won.length}`, `${name} переворачивает ${plural(result.won.length, 'фишку', 'фишки', 'фишек')}${edge ? ` · на ребре: ${edge}` : ''}`);
  else toast('Мимо', edge ? `Ни одной, ${edge} на ребре не считаются` : 'Ни одна фишка не перевернулась');
  await sleep(S.slow ? 1600 : 1000);
  markers.forEach(mk => scene.remove(mk));
  if (!result.foul && result.won.length) {
    const side = player === 0 ? -1 : 1;
    await Promise.all(result.won.map((uid, i) => {
      const o = chipObjs.get(uid); if (!o) return null;
      return tweenTo(o, new THREE.Vector3(side * (26 + i * .6), 6 + i * .3, 12), FACE_UP, 650);
    }));
    result.won.forEach(dropChipObj);
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many}`;
}

// ================= UI =================
function setStatus(t) { $('status').textContent = t; }

function myTurn() {
  const st = S.state;
  return st && (S.you === 'both' || S.you === st.current);
}
function canThrow() { return S.state?.phase === 'aim' && myTurn() && !S.animating; }

function render() {
  const st = S.state; if (!st) return;
  st.players.forEach((p, i) => {
    const el = $('p' + i);
    const active = (st.phase === 'aim' || st.phase === 'sim') && st.current === i;
    el.classList.toggle('active', active);
    const you = S.you === i ? ' (вы)' : '';
    el.innerHTML = `<span class="name">${esc(p.name)}${you}</span>
      <span class="nums">выиграно <b>${p.wonThisGame.length}</b> · ценность <b>${p.value}</b></span>
      <span class="nums">бита: ${esc(BITS[p.bit].name)}</span>`;
  });
  $('turnno').textContent = st.turn ? `${st.turn}` : '—';

  const locked = !canThrow();
  $('deck').classList.toggle('locked', locked);

  if (S.animating) {/* статус ставит реплей */}
  else if (st.phase === 'mode') setStatus('Выбираем способ игры на эту партию');
  else if (st.phase === 'rps') setStatus('Камень, ножницы, бумага: кто бросает первым');
  else if (st.phase === 'aim') setStatus(myTurn()
    ? `Бросает ${st.players[st.current].name}. ${S.input.mode === 'slam' ? 'Зажмите биту' : 'Зажмите стопку'} и тяните вверх`
    : `Ход соперника: ${st.players[st.current].name}`);
  else if (st.phase === 'sim') setStatus('Сервер считает бросок…');
  else if (st.phase === 'over') setStatus('Партия окончена');

  renderOverlay();
  renderFairDot();
  renderModeUI();
  if (S.sheet && S.sheet !== 'fair') openSheet(S.sheet);
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- Оверлеи ----------
let overlayEl = null;
function showOverlay(html) {
  hideOverlay();
  overlayEl = document.createElement('div');
  overlayEl.className = 'overlay';
  overlayEl.innerHTML = `<div class="card">${html}</div>`;
  $('app').appendChild(overlayEl);
  return overlayEl;
}
function hideOverlay() { overlayEl?.remove(); overlayEl = null; }

const RPS = [['rock', '✊', 'Камень'], ['scissors', '✌️', 'Ножницы'], ['paper', '✋', 'Бумага']];
const RPS_NAME = Object.fromEntries(RPS.map(r => [r[0], r[2]]));

function renderOverlay() {
  const st = S.state;
  if (S.animating || S.lobby || !st) return;
  if (st.phase === 'mode') {
    if (S.you !== 'both' && S.you !== 0) { showOverlay(`<h2>Хозяин стола выбирает правила</h2><p>На битах или стопкой — решает ${esc(st.players[0].name)}.</p>`); return; }
    const el = showOverlay(`<h2>Как играем?</h2><p>Как во дворе: договариваемся один раз на всю партию.</p>
      <div class="modes">
        <button data-m="slam"><b>На битах</b><span>Бьёте битой по стопке. Решает удар ребром по краю. Можно выбрать биту.</span></button>
        <button data-m="drop"><b>Стопкой</b><span>Бросаете всю стопку из руки. Фишки переворачиваются чаще.</span></button>
      </div>`);
    el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { hideOverlay(); transport.send({ t: 'mode', mode: b.dataset.m }, 0); });
    return;
  }
  if (st.phase === 'rps') {
    const chooser = S.you === 'both' ? st.rpsReady.findIndex(x => !x) : (st.rpsReady[S.you] ? -1 : S.you);
    let log = '';
    if (st.rpsLog?.tie) log = `<p>Ничья: ${RPS_NAME[st.rpsLog.a]} и ${RPS_NAME[st.rpsLog.b]}. Ещё раз.</p>`;
    if (chooser === -1) { showOverlay(`<h2>Ждём выбор соперника</h2>${log}`); return; }
    const hint = S.you === 'both' ? '<p>Второй игрок, не подсматривайте.</p>' : '';
    const el = showOverlay(`<h2>${esc(st.players[chooser].name)} выбирает</h2>${log}${hint}
      <div class="rps">${RPS.map(([id, ic, nm]) => `<button data-c="${id}"><span>${ic}</span>${nm}</button>`).join('')}</div>`);
    el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { hideOverlay(); transport.send({ t: 'rps', choice: b.dataset.c }, chooser); });
    return;
  }
  if (st.phase === 'over') {
    const v = st.players.map(p => p.wonThisGame.reduce((s, c) => s + RARITY[SKIN_BY_ID[c.skin].rarity].value, 0));
    const n = st.players.map(p => p.wonThisGame.length);
    const w = st.winner !== undefined ? (st.winner ?? -1) : (v[0] === v[1] ? -1 : v[0] > v[1] ? 0 : 1);
    const head = w === -1 ? 'Ничья' : S.you === 'both' ? `Победа: ${esc(st.players[w].name)}` : w === S.you ? 'Вы победили!' : `Победил ${esc(st.players[w].name)}`;
    const rt = S.ratings && S.you !== 'both' && S.you !== null
      ? `<p>Рейтинг ${S.ratings.mode === 'drop' ? 'стопкой' : 'на битах'}: <b>${S.ratings.ratings[S.you]}</b></p>` : '';
    const online = S.you !== 'both';
    const el = showOverlay(`<h2>${head}</h2>
      <p>${st.players.map((p, i) => `${esc(p.name)}: ${plural(n[i], 'фишка', 'фишки', 'фишек')}, ценность ${v[i]}`).join('<br>')}</p>${rt}
      <button class="big" id="again">${online ? 'Реванш' : 'Новая партия'}</button>
      ${online ? '<button class="big ghost" id="leave">Выйти из-за стола</button>' : ''}`);
    el.querySelector('#again').onclick = () => { hideOverlay(); transport.send({ t: 'new' }, 0); };
    el.querySelector('#leave')?.addEventListener('click', () => transport.send({ t: 'leave' }));
    return;
  }
  hideOverlay();
}

function toast(t1, t2) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="t1">${esc(t1)}</span><span class="t2">${esc(t2)}</span>`;
  $('app').appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ---------- Листы ----------
function closeSheet() { document.querySelector('.sheet-bg')?.remove(); S.sheet = null; }
function openSheet(kind) {
  const existing = document.querySelector('.sheet-bg');
  const scroll = existing?.querySelector('.sheet')?.scrollTop || 0;
  existing?.remove();
  S.sheet = kind;
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.onclick = (e) => { if (e.target === bg) closeSheet(); };
  const titles = { fair: 'Честность броска', bits: 'Биты', coll: 'Коллекции' };
  bg.innerHTML = `<div class="sheet" role="dialog" aria-label="${titles[kind]}">
    <div class="sheet-top"><h2>${titles[kind]}</h2><button class="x" aria-label="Закрыть">✕</button></div>
    ${kind === 'fair' ? fairHTML() : kind === 'bits' ? bitsHTML() : collHTML()}</div>`;
  bg.querySelector('.x').onclick = closeSheet;
  $('app').appendChild(bg);
  bg.querySelector('.sheet').scrollTop = scroll;
  if (kind === 'bits') wireBits(bg);
}

function checkRow(state, text) {
  const ic = state === true ? '✓' : state === false ? '✕' : '…';
  const cls = state === true ? 'ok' : state === false ? 'bad' : 'wait';
  return `<div class="check ${cls}"><span class="ic">${ic}</span><span>${text}</span></div>`;
}

function fairHTML() {
  const L = S.last;
  const how = `<h3>Как это устроено</h3>
    <ol class="steps">
      <li>Перед каждым ходом сервер загадывает секретный <i>server seed</i> и публикует только его SHA-256 (коммит).</li>
      <li>Вы отправляете лишь ввод: силу, наклон, направление, прицел и свой случайный <i>client seed</i>. Результат клиент не присылает.</li>
      <li>Сервер смешивает оба сида, добавляет «дрожь руки» и считает физику на детерминированном движке Rapier.</li>
      <li>После броска сервер раскрывает seed. Ваш клиент прогоняет ту же физику сам и сверяет хэш итогового положения всех фишек.</li>
    </ol>`;
  const cur = S.state?.commit ? `<h3>Следующий ход · коммит сервера</h3><dl class="kv"><dt>SHA-256</dt><dd>${S.state.commit}</dd></dl>` : '';
  if (!L) return `<p>Здесь появится проверка после первого броска.</p>${cur}${how}`;
  const i = L.request.input, j = L.server.jittered;
  const fmtIn = (x) => `сила ${x.power} · наклон ${(x.tilt / 10).toFixed(1)}° · направление ${x.dir}° · к краю ${Math.round(x.aim / 10)}%`;
  return `
    <div class="checks">
      ${checkRow(L.commitOk ?? null, 'SHA-256 раскрытого server seed совпадает с коммитом, опубликованным до броска')}
      ${L.clientSeedOk === null ? '' : checkRow(L.clientSeedOk, 'Сервер использовал именно ваш client seed')}
      ${checkRow(L.simOk ?? null, L.simOk === undefined ? 'Физика пересчитывается на вашем устройстве…' : `Физика повторена на вашем устройстве${L.simMs != null ? ` за ${L.simMs} мс` : ''}: хэш совпал с серверным`)}
    </div>
    <h3>Бросок №${L.turn} · ${esc(S.state.players[L.player].name)} · ${L.request.input.mode === 'slam' ? 'удар битой «' + esc(BITS[L.request.bitId].name) + '»' : 'стопкой из руки'}</h3>
    <dl class="kv">
      <dt>Ввод</dt><dd>${fmtIn(i)}</dd>
      <dt>С дрожью руки</dt><dd>${fmtIn(j)}</dd>
      <dt>Коммит</dt><dd>${L.reveal.commit}</dd>
      <dt>Server seed</dt><dd>${L.reveal.serverSeed}</dd>
      <dt>Client seed</dt><dd>${L.reveal.clientSeed}</dd>
      <dt>Хэш сервера</dt><dd>${L.server.hash}</dd>
      <dt>Хэш у вас</dt><dd>${L.localHash || '…'}</dd>
      <dt>Физика</dt><dd>${L.server.simTime ?? '—'} с · ${L.server.steps} шагов, из них ${L.server.fineSteps ?? 0} мелких (1/960 с) в момент удара</dd>
    </dl>
    ${cur}${how}`;
}

function renderFairDot() {
  const d = $('fairdot');
  d.className = 'dot' + (S.last ? ' ' + S.last.status : '');
}

function bitStats(b) {
  const mom = (x) => x.density * x.radius * x.radius * x.halfHeight * (x.speedMul || 1); // импульс удара
  const force = mom(b);
  const maxF = Math.max(...Object.values(BITS).map(mom));
  const acc = 1 - b.powerJitter / 0.11;
  return { force: force / maxF, acc };
}

function bitsHTML() {
  const st = S.state;
  const who = S.you === 'both' ? st.current : S.you;
  const cur = st.players[who].bit;
  return `<p>Биты не сильнее друг друга, а другие. Больше массы даёт больше разброса. Так магазин не превращается в pay-to-win. Выбор для: <b>${esc(st.players[who].name)}</b>.</p>
    <div class="bits">${Object.values(BITS).map(b => {
      const s = bitStats(b);
      return `<button class="bit" data-bit="${b.id}" aria-pressed="${b.id === cur}">
        <canvas width="112" height="112" data-draw="${b.id}"></canvas>
        <span><span class="nm">${esc(b.name)}</span><br><span class="ds">${esc(b.desc)}</span>
          <span class="bars"><span>Удар</span><span class="bar"><i style="width:${Math.round(s.force * 100)}%"></i></span>
          <span>Точность</span><span class="bar"><i style="width:${Math.round(s.acc * 100)}%"></i></span></span></span>
        <span class="price">${b.price ? b.price + ' ⭐<br>демо: даром' : 'база'}</span>
      </button>`;
    }).join('')}</div>
    <p>В релизе покупка за Telegram Stars; бита может быть NFT с косметическими вариантами.</p>`;
}
function wireBits(bg) {
  bg.querySelectorAll('canvas[data-draw]').forEach(c => drawBit(c.getContext('2d'), 112, BITS[c.dataset.draw]));
  bg.querySelectorAll('[data-bit]').forEach(b => b.onclick = () => {
    const st = S.state; const who = S.you === 'both' ? st.current : S.you;
    transport.send({ t: 'bit', bitId: b.dataset.bit }, who);
  });
}

function collHTML() {
  const st = S.state;
  return st.players.map((p) => {
    const won = new Set(p.wonThisGame.map(c => c.uid));
    return `<div class="coll-head"><h3>${esc(p.name)}</h3><span>${p.chips.length} шт. · ценность <b>${p.value}</b></span></div>
      <div class="grid">${p.chips.map(c => {
        const sk = SKIN_BY_ID[c.skin];
        return `<div class="cell"><img src="${getSkinURL(c.skin)}" alt="${esc(sk.name)}"><span>${esc(sk.name)}</span>
          <span style="color:${RARITY[sk.rarity].color}">${RARITY[sk.rarity].label} · ${RARITY[sk.rarity].value}</span>${won.has(c.uid) ? '<span class="new">выиграна</span>' : ''}</div>`;
      }).join('')}</div>`;
  }).join('') + `<p>Фишки в ставке сейчас лежат на столе и сюда не входят. В релизе каждая фишка станет NFT на TON с серийным номером.</p>`;
}

// ---------- Управление жестом ----------
// Зажмите биту (или стопку) пальцем/мышью и тяните ВВЕРХ: чем выше, тем сильнее бросок,
// объект на столе поднимается вместе с пальцем. Сдвиг В СТОРОНУ — наклон и смещение удара к краю
// стопки (ребром). Отпустили — бросок. Опустили палец почти до исходной точки — отмена.
const grab = { active: false, id: null, x0: 0, y0: 0 };
const MIN_POWER = 60;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function grabTargetScreen() {
  const st = S.state; if (!st) return null;
  const n = st.table.length;
  const p = S.input.mode === 'slam'
    ? previewBitPose({ ...S.input, power: 0, tilt: 0, aim: 0 }, currentBitId(), n).pos
    : new THREE.Vector3(0, n * H / 2, 0);
  p.project(camera);
  const r = canvas.getBoundingClientRect();
  return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
}
const grabRadius = () => Math.max(56, Math.min(canvas.clientWidth, canvas.clientHeight) * 0.13);

function zoneOf(tilt) {
  return tilt <= TILT_OK ? ['ok', 'засчитывается'] : tilt <= TILT_FOUL ? ['warn', 'предупреждение'] : ['bad', 'фол'];
}

function updateGrab(e) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const up = grab.y0 - e.clientY;
  S.input.power = clamp(Math.round(up / (h * 0.4) * 1000), 0, 1000);
  const side = e.clientX - grab.x0;
  const frac = clamp(Math.abs(side) / (w * 0.32), 0, 1);
  const prevZone = zoneOf(S.input.tilt)[0];
  S.input.tilt = Math.round(frac * 80) * 5;              // 0..40° шагом 0.5°
  if (zoneOf(S.input.tilt)[0] !== prevZone) { tickSound(); haptic('select'); }
  S.input.aim = Math.round(frac * 1000);
  // «вправо по экрану» = правый вектор камеры на плоскости стола: работает при любом повороте камеры
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  let deg = Math.atan2(right.z, right.x) * 180 / Math.PI + (side < 0 ? 180 : 0);
  S.input.dir = ((Math.round(deg) % 360) + 360) % 360;
  renderReadout(e.clientX, e.clientY);
}

function renderReadout(x, y) {
  const el = $('readout');
  const [z, zt] = zoneOf(S.input.tilt);
  const weak = S.input.power < MIN_POWER;
  el.hidden = false;
  el.style.left = clamp(x, 90, innerWidth - 90) + 'px';
  el.style.top = Math.max(70, y - 86) + 'px';
  $('ro-bar').style.width = (S.input.power / 10) + '%';
  $('ro-p').textContent = weak ? 'Тяните вверх' : `Сила ${S.input.power}`;
  const t = $('ro-t');
  t.textContent = `Наклон ${(S.input.tilt / 10).toFixed(1)}° · ${zt}`;
  t.className = 'z ' + z;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!canThrow() || grab.active) return;
  const c = grabTargetScreen();
  if (!c || Math.hypot(e.clientX - c.x, e.clientY - c.y) > grabRadius()) return; // мимо — крутим камеру
  e.preventDefault();
  e.stopImmediatePropagation();                         // OrbitControls этот жест не получит
  controls.enabled = false;
  Object.assign(grab, { active: true, id: e.pointerId, x0: e.clientX, y0: e.clientY });
  Object.assign(S.input, { power: 0, tilt: 0, aim: 0 });
  S.charging = true;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  renderReadout(e.clientX, e.clientY);
}, { capture: true });

addEventListener('pointermove', (e) => { if (grab.active && e.pointerId === grab.id) updateGrab(e); });
function endGrab(e, cancelled) {
  if (!grab.active || (e && e.pointerId !== grab.id)) return;
  grab.active = false;
  S.charging = false;
  controls.enabled = true;
  $('readout').hidden = true;
  if (cancelled || S.input.power < MIN_POWER) { setStatus('Отменено. Тяните вверх сильнее, чтобы бросить'); return; }
  doThrow();
}
addEventListener('pointerup', (e) => endGrab(e, false));
addEventListener('pointercancel', (e) => endGrab(e, true));

// Кольцо-подсказка «хватай здесь» над битой/стопкой
function updateGrabRing() {
  const ring = $('grabring');
  const show = canThrow() && !grab.active && !S.sheet;
  ring.hidden = !show;
  if (!show) return;
  const c = grabTargetScreen(), r = canvas.getBoundingClientRect(), rad = grabRadius();
  ring.style.left = (c.x - r.left) + 'px';
  ring.style.top = (c.y - r.top) + 'px';
  ring.style.width = ring.style.height = rad * 2 + 'px';
}

function renderModeUI() {
  const slam = S.input.mode === 'slam';
  $('mode-badge').textContent = S.state?.mode ? (slam ? 'Партия на битах' : 'Партия стопкой') : 'Способ ещё не выбран';
  $('hint').innerHTML = slam
    ? '<b>Зажмите биту</b> и тяните вверх: выше — сильнее. В сторону — наклон и удар ребром по краю стопки. Отпустите, чтобы ударить.'
    : '<b>Зажмите стопку</b> и тяните вверх: выше — сильнее бросок. В сторону — наклон и подкрутка. Отпустите, чтобы бросить.';
}

function doThrow() {
  const st = S.state; if (!canThrow()) return;
  const clientSeed = randomHex(16);
  S.mySeeds[st.turn] = clientSeed;
  const { mode, power, tilt, dir, aim } = S.input;
  S.animating = true; render();
  Object.assign(S.input, { power: 0, tilt: 0, aim: 0 });
  setStatus('Сервер считает бросок…');
  transport.send({ t: 'throw', turn: st.turn, input: { mode, power, tilt, dir, aim }, clientSeed }, st.current);
}

$('btn-fair').onclick = () => openSheet('fair');
$('btn-bits').onclick = () => S.state && openSheet('bits');
$('btn-coll').onclick = () => S.state && openSheet('coll');
$('btn-cam').onclick = () => setCam((camIdx + 1) % CAMS.length, true);
const soundBtn = $('btn-sound');
const renderSoundBtn = () => { soundBtn.textContent = FX.on ? 'Звук: вкл' : 'Звук: выкл'; soundBtn.setAttribute('aria-pressed', FX.on); };
soundBtn.onclick = () => { FX.on = !FX.on; try { localStorage.setItem('caps-sound', FX.on ? 'on' : 'off'); } catch {} audioInit(); renderSoundBtn(); };
renderSoundBtn();
$('btn-slow').onclick = (e) => { S.slow = !S.slow; e.currentTarget.setAttribute('aria-pressed', S.slow); e.currentTarget.textContent = S.slow ? 'Slow ×0.25 ✓' : 'Slow ×0.25'; };

// ================= Цикл отрисовки =================
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = camera.aspect < 0.8 ? 52 : 40;
  camera.updateProjectionMatrix();
}
addEventListener('resize', () => { resize(); setCam(camIdx, false); });

const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  if (playback) playback.update(dt);
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.t += dt / tw.dur;
    const k = ease(Math.min(1, tw.t));
    tw.obj.position.lerpVectors(tw.p0, tw.p1, k);
    tw.obj.quaternion.slerpQuaternions(tw.q0, tw.q1, k);
    if (tw.t >= 1) { tweens.splice(i, 1); tw.res(); }
  }
  if (camTween) {
    camTween.t += dt / 0.6;
    const k = ease(Math.min(1, camTween.t));
    camera.position.lerpVectors(camTween.from, camTween.to, k);
    controls.target.lerpVectors(camTween.ft, camTween.tg, k);
    if (camTween.t >= 1) camTween = null;
  }
  updatePreview();
  updateGrabRing();
  controls.update();
  if (shakeAmp > 0.01) {
    const off = new THREE.Vector3(Math.random() - .5, Math.random() - .5, Math.random() - .5).multiplyScalar(shakeAmp);
    camera.position.add(off); renderer.render(scene, camera); camera.position.sub(off);
    shakeAmp *= Math.pow(0.002, dt);                  // затухает примерно за 0.3 с
  } else renderer.render(scene, camera);
}

// ================= Старт =================
async function boot() {
  resize(); setCam(0, false);
  renderModeUI();
  frame();
  try {
    await RAPIER.init();
  } catch (e) {
    $('boot').innerHTML = '<div>Не удалось загрузить физический движок. Проверьте соединение и обновите страницу.</div>';
    throw e;
  }
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  $('boot').remove();
  transport = ONLINE ? new WsTransport(onMsg) : new LocalTransport(onMsg);
  transport.start();
}
if (ONLINE && !window.Telegram) {
  const s = document.createElement('script');
  s.src = 'https://telegram.org/js/telegram-web-app.js';
  s.onload = s.onerror = boot;
  document.head.appendChild(s);
} else boot();

// Provably-fair примитивы + детерминированная математика.
// Работает одинаково в браузере и в Node 18+ (globalThis.crypto).
//
// ВАЖНО для детерминизма: Math.sin / Math.cos / Math.exp и т.п. НЕ обязаны давать
// бит-в-бит одинаковый результат в разных JS-движках. Поэтому всё, что влияет на
// симуляцию, считается только через + - * / и Math.round/Math.sqrt (они точны по IEEE-754).

const enc = new TextEncoder();

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return toHex(new Uint8Array(buf));
}

export function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

function toHex(a) {
  let s = '';
  for (const b of a) s += b.toString(16).padStart(2, '0');
  return s;
}

// Итоговый сид броска: знает только сервер до броска (serverSeed скрыт за коммитом),
// а клиент добавляет свой clientSeed уже ПОСЛЕ коммита — значит, сервер не может
// подобрать выгодный ему сид, а клиент не может предсказать разброс.
export function deriveFairSeed(serverSeed, clientSeed, turn) {
  return sha256Hex(`caps:v1:${serverSeed}:${clientSeed}:${turn}`);
}

// sfc32 — быстрый PRNG только на целочисленных операциях (детерминирован везде)
export function prngFromHex(hex) {
  let a = parseInt(hex.slice(0, 8), 16) | 0;
  let b = parseInt(hex.slice(8, 16), 16) | 0;
  let c = parseInt(hex.slice(16, 24), 16) | 0;
  let d = parseInt(hex.slice(24, 32), 16) | 0;
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next(); // прогрев
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    sym: (amp) => (next() * 2 - 1) * amp, // равномерно в [-amp, amp]
    int: (n) => Math.floor(next() * n),
  };
}

// ---------- Детерминированная тригонометрия ----------
const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;
const TWO_PI = 6.283185307179586;
export const DEG = PI / 180;

export function dsin(x) {
  x = x - TWO_PI * Math.round(x / TWO_PI);          // [-π, π]
  if (x > HALF_PI) x = PI - x;                       // [-π/2, π/2]
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;                                  // ряд Тейлора до x^15, ошибка < 1e-11
  return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 *
    (1 - x2 / 110 * (1 - x2 / 156 * (1 - x2 / 210)))))));
}
export function dcos(x) { return dsin(x + HALF_PI); }

// Кватернионы {x,y,z,w}
export function quatAxisAngle(ax, ay, az, angle) {
  const len = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  const s = dsin(angle / 2) / len;
  return { x: ax * s, y: ay * s, z: az * s, w: dcos(angle / 2) };
}
export function quatMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
export function quatRotate(q, v) {
  // v' = q * v * q^-1
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

export const round = (v, p) => Math.round(v * p) / p;

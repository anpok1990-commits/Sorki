// Детерминированная симуляция одного броска.
// Один и тот же файл + один и тот же WASM-бинарник Rapier (deterministic build)
// крутятся и на сервере (авторитетно), и на клиенте (для анимации и проверки).
//
// Единицы: сантиметры, секунды, граммы. g = 981 см/с².
// Вход броска — только целые числа (никаких float по сети):
//   mode  : 'slam' (удар битой по стопке) | 'drop' (бросок стопки из руки)
//   power : 0..1000
//   tilt  : 0..450  — наклон в десятых долях градуса
//   dir   : 0..359  — направление (куда смотрит нижний край / куда целимся), градусы
//   aim   : 0..1000 — slam: смещение точки удара от центра; drop: подкрутка

import {
  prngFromHex, sha256Hex, dsin, dcos, DEG, quatAxisAngle, quatMul, quatRotate, round,
} from './fair.js';
import { BITS, HAND } from './content.js';

export const SIM_VERSION = 'caps-sim-4';
// Переменный шаг: 1/960 с, пока что-то летит быстрее ~80 см/с (удар), иначе 1/240 с.
// Тонкие фишки (2.6 мм) при ударе 5–7 м/с на крупном шаге «продавливаются» друг сквозь друга —
// бита проваливалась в стопку. Мелкий шаг только в момент удара решает это почти бесплатно.
// Решение о шаге зависит только от состояния симуляции, поэтому детерминизм сохраняется.
export const TICK = 1 / 960;                 // единица времени симуляции
const FINE_TICKS = 1, COARSE_TICKS = 4;      // 1/960 и 1/240 с
const FAST2 = 80 * 80;                       // (см/с)²
export const MAX_TICKS = 960 * 7;
export const REC_TICKS = 8;                  // кадр реплея каждые 1/120 с

export const CHIP = { radius: 2.0, halfHeight: 0.1, border: 0.03, density: 1.2 };
export const TILT_OK = 200;    // ≤20° — чисто
export const TILT_FOUL = 300;  // >30° — бросок не засчитывается
// Смещение точки удара биты от центра стопки, см. 3 см = ребро биты попадает по краю стопки —
// именно такие удары переворачивают фишки (ровный удар по центру почти ничего не даёт).
export const AIM_MAX = 3.0;

// Высота биты над стопкой в момент броска (см) — общая формула для симуляции и превью
export const bitLift = (power) => 3 + power * 0.009;   // 3..12 см — бита остаётся в кадре

export function validateInput(inp) {
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!inp || (inp.mode !== 'slam' && inp.mode !== 'drop')) return 'mode';
  if (!isInt(inp.power, 0, 1000)) return 'power';
  if (!isInt(inp.tilt, 0, 450)) return 'tilt';
  if (!isInt(inp.dir, 0, 359)) return 'dir';
  if (!isInt(inp.aim, 0, 1000)) return 'aim';
  return null;
}

// Человеческий разброс: применяется ПОСЛЕ получения ввода, по честному сиду.
// Даже идеальный бот получает распределение исходов, а не гарантированный результат.
export function applyJitter(inp, bitId, rng) {
  const bit = BITS[bitId] || BITS.std;
  const pj = inp.mode === 'slam' ? bit.powerJitter : HAND.powerJitter;
  const tj = inp.mode === 'slam' ? bit.tiltJitter : HAND.tiltJitter;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const power = clamp(Math.round(inp.power * (1 + rng.sym(pj))), 0, 1000);
  const tilt = clamp(Math.round(inp.tilt + rng.sym(tj * 10)), 0, 450);
  let dir = Math.round(inp.dir + rng.sym(HAND.dirJitterDeg));
  dir = ((dir % 360) + 360) % 360;
  const aimAbs = inp.mode === 'slam' ? (inp.aim / 1000) * AIM_MAX : 0;
  const aimJ = inp.mode === 'slam' ? bit.aimJitter : 0;
  const aimX = round(aimAbs * dcos(inp.dir * DEG) + rng.sym(aimJ), 1000);
  const aimZ = round(aimAbs * dsin(inp.dir * DEG) + rng.sym(aimJ), 1000);
  return { mode: inp.mode, power, tilt, dir, aim: inp.aim, aimX, aimZ };
}

/**
 * @param RAPIER  инициализированный модуль Rapier (deterministic-compat)
 * @param opts {chips: string[] (uid снизу вверх), bitId, input, fairSeed (hex), record}
 */
export async function simulateThrow(RAPIER, { chips, bitId, input, fairSeed, record = false }) {
  const rng = prngFromHex(fairSeed);
  const j = applyJitter(input, bitId, rng);
  const bit = BITS[bitId] || BITS.std;
  const foul = j.tilt > TILT_FOUL;

  const world = new RAPIER.World({ x: 0, y: -981, z: 0 });
  world.timestep = TICK * COARSE_TICKS;
  const ip = world.integrationParameters;
  ip.numSolverIterations = 10;
  if ('maxCcdSubsteps' in ip) ip.maxCcdSubsteps = 4;
  // Жёсткость контактов. По умолчанию Rapier настроен на тела размером в метры (30 Гц);
  // для фишек 2.6 мм это «вата»: стопка сплющивалась вдвое, фишки входили друг в друга
  // и бита «застревала» в стопке. 120 Гц — стопка держит форму, проникновений нет.
  ip.contact_natural_frequency = 120;

  // Стол: дерево
  const table = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(45, 1, 45).setFriction(0.55).setRestitution(0.55), table);

  const H = (CHIP.halfHeight + CHIP.border) * 2; // полная толщина фишки
  const faceDown = quatAxisAngle(1, 0, 0, Math.PI); // скин смотрит вниз
  const bodies = [];

  // Небольшое несовершенство стопки: люди не кладут фишки идеально ровно
  const imperfect = () => {
    const a = rng.range(0, 360) * DEG;
    return quatAxisAngle(dcos(a), 0, dsin(a), rng.sym(0.8) * DEG);
  };

  const dirRad = j.dir * DEG;
  const dx = dcos(dirRad), dz = dsin(dirRad);
  // ось наклона перпендикулярна направлению; нижний край смотрит в сторону dir
  const tiltQ = quatAxisAngle(dz, 0, -dx, -(j.tilt / 10) * DEG);

  const chipDesc = (x, y, z, q) => RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z).setRotation(q).setCcdEnabled(true)
    .setAngularDamping(1.5).setLinearDamping(0.6); // сопротивление воздуха и качению (Rapier не моделирует rolling friction)
  const chipCollider = () => RAPIER.ColliderDesc
    .roundCylinder(CHIP.halfHeight, CHIP.radius - CHIP.border, CHIP.border)
    .setDensity(CHIP.density).setFriction(0.45).setRestitution(0.75); // упругий пластик

  if (input.mode === 'slam') {
    for (let i = 0; i < chips.length; i++) {
      const q = quatMul(imperfect(), faceDown);
      const b = world.createRigidBody(chipDesc(rng.sym(0.06), H / 2 + i * (H + 0.002), rng.sym(0.06), q));
      world.createCollider(chipCollider(), b);
      bodies.push(b);
    }
    const stackTop = chips.length * (H + 0.002);
    const bh = bit.halfHeight;
    // бита тоже наклонена, но нижний край смотрит К центру стопки
    const bitTilt = quatAxisAngle(dz, 0, -dx, (j.tilt / 10) * DEG);
    // Рука поднимает биту на 3..20 см над стопкой (как в превью) и бросает вниз.
    // Скорость броска ≈ 2.5..11.5 м/с × множитель биты (с жёсткими контактами это безопасно).
    const v = (250 + j.power * 0.9) * (bit.speedMul || 1);
    const bb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(j.aimX, stackTop + bitLift(j.power) + bit.radius * (j.tilt / 10) * DEG, j.aimZ)
      .setRotation(bitTilt).setLinvel(0, -v, 0).setCcdEnabled(true).setAngularDamping(1.5).setLinearDamping(0.6));
    world.createCollider(RAPIER.ColliderDesc.roundCylinder(bh - 0.04, bit.radius - 0.04, 0.04)
      .setDensity(bit.density).setFriction(0.5).setRestitution(0.4), bb);
    bodies.push(bb);
  } else {
    // Бросок стопкой из руки: стопка как единое целое в воздухе, наклонена
    const h0 = 3 + (j.power / 1000) * 27;           // 3..30 см над столом
    const v = 60 + j.power * 0.2;                    // толчок вниз
    const spin = (j.aim / 1000) * 14;                // подкрутка, рад/с
    // Стопка в руке — не монолит: при броске пальцы отпускают фишки чуть по-разному,
    // каждая получает свой небольшой разброс скорости и вращения. Чем сильнее бросок, тем больше.
    const loose = 1 + (j.power / 1000) * 3;          // 1..4
    const n = chips.length;
    const cy = h0 + (n * H) / 2;
    for (let i = 0; i < n; i++) {
      const local = { x: rng.sym(0.05), y: (i + 0.5) * H - (n * H) / 2, z: rng.sym(0.05) };
      const p = quatRotate(tiltQ, local);
      const q = quatMul(tiltQ, quatMul(imperfect(), faceDown));
      const b = world.createRigidBody(chipDesc(p.x, cy + p.y, p.z, q)
        .setLinvel(rng.sym(4 * loose), -v * (1 + rng.sym(0.08)), rng.sym(4 * loose))
        .setAngvel({ x: dz * spin + rng.sym(1.5 * loose), y: rng.sym(loose), z: -dx * spin + rng.sym(1.5 * loose) }));
      world.createCollider(chipCollider(), b);
      bodies.push(b);
    }
  }

  // ---- интегрирование ----
  const nb = bodies.length;
  const frames = record ? [] : null;
  const times = record ? [] : null;
  const snap = (t) => {
    times.push(t);
    const f = new Float32Array(nb * 7);
    for (let i = 0; i < nb; i++) {
      const t = bodies[i].translation(), r = bodies[i].rotation();
      f.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w], i * 7);
    }
    frames.push(f);
  };
  if (record) snap(0);

  let ticks = 0, still = 0, steps = 0, fineSteps = 0, nextRec = REC_TICKS;
  // Второй критерий покоя — по перемещению. Скруглённые рёбра фишки и биты в «клине» могут
  // бесконечно дрожать на месте (скорость есть, движения нет). Если за 2 окна по 0.25 с ни одно
  // тело не сдвинулось больше чем на 3 мм и не повернулось — бросок закончен.
  const WIN = 240;
  let nextWin = 960, lastPose = null, calmWins = 0;
  while (ticks < MAX_TICKS) {
    let fast = false, moving = false;
    for (const b of bodies) {
      if (b.isSleeping()) continue;
      if (b.translation().y < -5) continue;      // упало со стола — больше не влияет на игру
      const lv = b.linvel(), av = b.angvel();
      const l2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z, a2 = av.x * av.x + av.y * av.y + av.z * av.z;
      if (l2 + 4 * a2 > FAST2) fast = true;
      if (l2 > 0.25 || a2 > 0.09) moving = true;
    }
    const k = fast ? FINE_TICKS : COARSE_TICKS;
    world.timestep = TICK * k;
    world.step();
    steps++; if (fast) fineSteps++;
    ticks += k;
    if (record && ticks >= nextRec) { snap(ticks * TICK); nextRec = ticks - (ticks % REC_TICKS) + REC_TICKS; }
    if (ticks > 480) {                         // первые 0.5 с не проверяем покой
      still = moving ? 0 : still + k;
      if (still >= 144) break;                  // 0.15 с полного покоя
    }
    if (ticks >= nextWin) {
      nextWin = ticks - (ticks % WIN) + WIN;
      const pose = bodies.map((b) => {
        const t = b.translation(), r = b.rotation();
        return [t.x, t.y, t.z, 1 - 2 * (r.x * r.x + r.z * r.z)];
      });
      if (lastPose) {
        let calm = true;
        for (let i = 0; i < pose.length && calm; i++) {
          const a = pose[i], o = lastPose[i];
          if (a[1] < -5) continue;
          const dx = a[0] - o[0], dy = a[1] - o[1], dz = a[2] - o[2];
          if (dx * dx + dy * dy + dz * dz > 0.09 || Math.abs(a[3] - o[3]) > 0.05) calm = false;
        }
        calmWins = calm ? calmWins + 1 : 0;
        if (calmWins >= 2) break;
      }
      lastPose = pose;
    }
  }

  // ---- итог ----
  const final = [];
  const outcome = [];
  for (let i = 0; i < chips.length; i++) {
    const t = bodies[i].translation(), r = bodies[i].rotation();
    const upY = 1 - 2 * (r.x * r.x + r.z * r.z); // локальная ось Y (сторона скина) в мире
    let state;
    if (t.y < -3) state = 'off';
    else if (upY > 0.5) state = 'up';          // перевернулась скином вверх
    else if (upY < -0.5) state = 'down';
    else state = 'edge';                        // стоит на ребре / опёрта — не считается
    outcome.push({ uid: chips[i], state, tiltDeg: Math.round(Math.acos(Math.max(-1, Math.min(1, Math.abs(upY)))) * 180 / Math.PI) });
    final.push(round(t.x, 1000), round(t.y, 1000), round(t.z, 1000),
      round(r.x, 10000), round(r.y, 10000), round(r.z, 10000), round(r.w, 10000));
  }
  const won = foul ? [] : outcome.filter(o => o.state === 'up').map(o => o.uid);
  world.free();

  // Хэш итогового состояния — сервер и клиент обязаны получить одно и то же
  const hash = await sha256Hex(JSON.stringify([SIM_VERSION, chips, bitId, j, ticks, final]));
  return {
    jittered: j, foul, won, outcome, steps, fineSteps, simTime: round(ticks * TICK, 1000), hash,
    frames, times, nBodies: nb, hasBit: input.mode === 'slam', bitId,
  };
}

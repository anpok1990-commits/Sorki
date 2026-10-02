// Проверки: (1) один и тот же бросок даёт один и тот же хэш;
// (2) баланс бит — доля перевёрнутых фишек на 200 бросков для каждой биты.
//   npm test
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { simulateThrow } from '../shared/sim.js';
import { sha256Hex } from '../shared/fair.js';
import { BITS } from '../shared/content.js';

await RAPIER.init();
const chips = Array.from({ length: 10 }, (_, i) => `c${i}`);
const input = { mode: 'slam', power: 700, tilt: 120, dir: 45, aim: 400 };

const a = await simulateThrow(RAPIER, { chips, bitId: 'std', input, fairSeed: await sha256Hex('seed-A') });
const b = await simulateThrow(RAPIER, { chips, bitId: 'std', input, fairSeed: await sha256Hex('seed-A') });
const c = await simulateThrow(RAPIER, { chips, bitId: 'std', input, fairSeed: await sha256Hex('seed-B') });
console.log('Тот же сид   :', a.hash === b.hash ? 'OK, хэши совпали' : 'FAIL');
console.log('Другой сид   :', a.hash !== c.hash ? 'OK, исход другой' : 'совпало (возможно)');
console.log('Хэш эталона  :', a.hash, '— сравните с тем же броском в браузере');

const N = Number(process.env.N || 200);
for (const mode of ['slam', 'drop']) {
  for (const bitId of mode === 'slam' ? Object.keys(BITS) : ['std']) {
    let flipped = 0, fouls = 0;
    for (let i = 0; i < N; i++) {
      const s = await sha256Hex(`bal-${i}`);
      const inp = { mode, power: 300 + (i * 37) % 700, tilt: (i * 13) % 280, dir: (i * 53) % 360, aim: (i * 97) % 1000 };
      const r = await simulateThrow(RAPIER, { chips, bitId, input: inp, fairSeed: s });
      flipped += r.won.length; fouls += r.foul ? 1 : 0;
    }
    console.log(`${mode.padEnd(4)} ${bitId.padEnd(5)}: ${(flipped / N).toFixed(2)} фишек/бросок, фолов ${fouls}`);
  }
}

// Сквозной тест: два «телефона» (WebSocket-клиенты Node) играют через настоящий сервер.
// node server/test/e2e.js
import assert from 'node:assert/strict';
import { startServer } from '../server.js';
import { Store } from '../store.js';
import { signInitData } from '../auth.js';
import { MockRapier } from './mock-rapier.js';

const TOKEN = '1234567:TEST-ONLY-NOT-A-REAL-TOKEN';
const store = new Store(':memory:');
const fakeBot = { inviteLink: (id) => `https://t.me/sotki_test_bot/play?startapp=${id}`, stop() {} };
const srv = await startServer({ RAPIER: MockRapier, port: 0, store, botToken: TOKEN, devAuth: true, bot: fakeBot,
  timers: { mode: 3000, rps: 3000, aim: 1500 }, graceMs: 300 });
const URL_ = `ws://127.0.0.1:${srv.port}/ws`;

function initData(id, name, extra = {}) {
  return signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }), ...extra }, TOKEN);
}

class Client {
  constructor(name) { this.name = name; this.log = []; this.waiters = []; }
  connect() {
    return new Promise((ok, fail) => {
      this.ws = new WebSocket(URL_);
      this.ws.onopen = ok; this.ws.onerror = fail;
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data); this.log.push(m);
        if (m.t === 'state') this.state = m.state;
        this.waiters = this.waiters.filter(w => !(w.pred(m) && (w.ok(m), true)));
      };
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  wait(pred, ms = 4000, label = '') {
    const hit = this.log.find(pred);
    if (hit) { this.log.splice(this.log.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((ok, fail) => {
      const w = { pred, ok: (m) => { clearTimeout(timer); this.log.splice(this.log.indexOf(m), 1); ok(m); } };
      const timer = setTimeout(() => fail(new Error(`${this.name}: не дождались ${label}`)), ms);
      this.waiters.push(w);
    });
  }
  waitT(t, extra = () => true, ms) { return this.wait(m => m.t === t && extra(m), ms, t); }
  close() { this.ws.close(); }
}

const ok = (s) => console.log('  ✓', s);

// 1. Вход: поддельная подпись отклоняется
{
  const c = new Client('хакер'); await c.connect();
  c.send({ t: 'hello', initData: initData(1, 'X').replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64)) });
  const e = await c.waitT('error'); assert.equal(e.code, 'auth');
  c.send({ t: 'create' }); assert.equal((await c.waitT('error')).code, 'auth');
  c.close(); ok('поддельный initData и действия без входа отклоняются');
}

// 2. Два игрока, приглашение по ссылке
const A = new Client('Алекс'), B = new Client('Борис');
await A.connect(); await B.connect();
A.send({ t: 'hello', initData: initData(111, 'Алекс') });
const wa = await A.waitT('welcome'); assert.equal(wa.me.chips, 12); assert.equal(wa.me.ratings.slam, 1000);
await A.waitT('lobby');
A.send({ t: 'create' });
const lob = await A.waitT('lobby', m => m.room);
assert.match(lob.invite, /startapp=[A-Z0-9]{5}$/); assert.equal(lob.waiting, true);
ok(`Алекс вошёл (12 стартовых фишек), стол ${lob.room}, ссылка ${lob.invite}`);

// Борис открывает ссылку: room приходит в start_param подписанного initData
B.send({ t: 'hello', initData: initData(222, 'Борис', { start_param: lob.room }) });
await B.waitT('welcome');
const youB = await B.waitT('you'); assert.equal(youB.idx, 1); assert.equal(youB.opponent, 'Алекс');
const youA = await A.waitT('you'); assert.equal(youA.idx, 0);
await A.waitT('state', m => m.state.phase === 'mode');
ok('Борис сел за стол по start_param');

// 3. Режим выбирает только хозяин
B.send({ t: 'mode', mode: 'drop' }); assert.match((await B.waitT('error')).msg, /хозяин/);
A.send({ t: 'mode', mode: 'slam' });
await B.waitT('state', m => m.state.phase === 'rps' && m.state.mode === 'slam');
A.send({ t: 'rps', choice: 'rock' }); B.send({ t: 'rps', choice: 'scissors' });
let st = (await A.waitT('state', m => m.state.phase === 'aim')).state;
assert.equal(st.current, 0); assert.equal(st.table.length, 10); assert.ok(st.deadline > Date.now());
ok('режим «на битах», камень-ножницы → первым бьёт Алекс, на кону 10 фишек');

// 4. Чужой ход и не тот режим отклоняются
const inp = (mode = 'slam') => ({ mode, power: 600, tilt: 100, dir: 30, aim: 500 });
B.send({ t: 'throw', turn: st.turn, input: inp(), clientSeed: 'ab'.repeat(8) });
assert.match((await B.waitT('error')).msg, /Не ваш ход/);
A.send({ t: 'throw', turn: st.turn, input: inp('drop'), clientSeed: 'ab'.repeat(8) });
assert.match((await A.waitT('error')).msg, /на битах/);
ok('чужой ход и бросок не тем способом отклонены');

// 5. Обрыв связи и возвращение посреди партии
B.close();
assert.equal((await A.waitT('peer')).status, 'away');
const B2 = new Client('Борис-2'); await B2.connect();
B2.send({ t: 'hello', initData: initData(222, 'Борис') });
assert.equal((await B2.waitT('you')).idx, 1);
await B2.waitT('state');
assert.equal((await A.waitT('peer')).status, 'back');
ok('Борис переподключился и вернулся за тот же стол');

// 6. Таймер хода: пропуск
const before = st.turn;
const skip = await A.waitT('state', m => m.state.turn === before + 1, 3000);
assert.equal(skip.state.current, 1);
ok('Алекс не успел за отведённое время — ход перешёл к Борису');

// 7. Играем до конца
const players = [A, B2];
let results = 0;
for (let guard = 0; guard < 200; guard++) {
  st = players[0].state;
  if (st.phase === 'over') break;
  if (st.phase === 'aim') {
    const me = players[st.current];
    me.send({ t: 'throw', turn: st.turn, input: inp(), clientSeed: 'cd'.repeat(8) });
    await me.waitT('result', m => m.turn === st.turn);
    results++;
  }
  await A.waitT('state', m => m.state.turn > st.turn || m.state.phase === 'over', 3000).catch(() => {});
}
st = A.state;
assert.equal(st.phase, 'over');
const r = await A.waitT('ratings');
ok(`партия окончена за ${results} бросков, победитель: ${st.winner === null ? 'ничья' : st.players[st.winner].name}, рейтинг ${r.ratings.join(' / ')}`);

// 8. База: фишки сохранены и никуда не пропали
const total = store.chipsOf('tg111').length + store.chipsOf('tg222').length;
assert.equal(total, 24);
assert.equal(st.players[0].chips.length, store.chipsOf('tg111').length);
const throws = store.throwsOf(1);
assert.equal(throws.length, results);
ok(`в базе 24 фишки (у Алекса ${store.chipsOf('tg111').length}, у Бориса ${store.chipsOf('tg222').length}), записано бросков: ${throws.length}`);

// 9. Случайный соперник + уход посреди партии возвращает ставки
const C = new Client('Вера'), D = new Client('Глеб');
await C.connect(); await D.connect();
C.send({ t: 'hello', dev: { id: 'v', name: 'Вера' } }); await C.waitT('lobby');
D.send({ t: 'hello', dev: { id: 'g', name: 'Глеб' } }); await D.waitT('lobby');
C.send({ t: 'quick' }); await C.waitT('lobby', m => m.room && m.random);
D.send({ t: 'quick' });
await D.waitT('you'); await C.waitT('you');
await C.waitT('state', m => m.state.phase === 'mode');
C.send({ t: 'mode', mode: 'drop' });
await C.waitT('state', m => m.state.phase === 'rps');
D.close();
await C.waitT('notice', m => /не вернулся/.test(m.msg), 3000);
await C.waitT('lobby', m => m.room === null);
assert.equal(store.chipsOf('dev_v').length, 12); assert.equal(store.chipsOf('dev_g').length, 12);
ok('случайный подбор работает; соперник пропал — партия отменена, ставки у владельцев');

// 10. Статика: клиент отдаётся, серверный код и база — нет
const base = `http://127.0.0.1:${srv.port}`;
const html = await (await fetch(base + '/')).text();
assert.match(html, /telegram-web-app\.js/);
assert.equal((await fetch(base + '/client/app.js')).status, 200);
assert.equal((await fetch(base + '/server/core.js')).status, 200);
for (const p of ['/server/store.js', '/server/server.js', '/data/sotki.db', '/package.json', '/%2e%2e/etc/passwd'])
  assert.equal((await fetch(base + p)).status, 404, p);
ok('раздаётся только клиент; серверный код, база и package.json закрыты');

A.close(); B2.close(); C.close();
srv.close();
console.log('\nВсе проверки пройдены');
process.exit(0);

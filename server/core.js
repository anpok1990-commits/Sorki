// Авторитетная логика матча. Клиент НИКОГДА не присылает результат —
// только ввод (целые числа) и свой clientSeed. Всё остальное решает сервер.
// Этот же класс работает в демо в браузере (LocalTransport) и на сервере (rooms.js).
// В демо фишки «минтятся» в памяти; на сервере игроки и фишки приходят из базы,
// а каждый бросок и переход фишек записываются через хуки.

import { simulateThrow, validateInput, SIM_VERSION } from '../shared/sim.js';
import { randomHex, sha256Hex, deriveFairSeed, prngFromHex } from '../shared/fair.js';
import { SKINS, SKIN_BY_ID, BITS, RARITY } from '../shared/content.js';

const RARITY_WEIGHTS = { common: 64, rare: 26, epic: 8, legendary: 2 };
const MAX_TURNS = 40;

export class GameCore {
  /**
   * @param RAPIER инициализированный Rapier
   * @param send   (playerIndex | 'all', message) => void
   * @param opts.players  [{id, name, bit, chips}] — игроки из базы (сервер); без них — демо
   * @param opts.hooks    { onNewGame, onMode, onThrow, onGameOver, refill } — запись в базу
   * @param opts.timers   { mode, rps, aim } в мс — таймер хода (только онлайн)
   */
  constructor(RAPIER, send, { names = ['Игрок 1', 'Игрок 2'], players = null, stake = 5, hooks = {}, timers = null } = {}) {
    this.R = RAPIER;
    this.send = send;
    this.stake = stake;
    this.hooks = hooks;
    this.timers = timers;
    this.timer = null;
    this.deadline = null;
    this.busy = false;
    this.serial = 0;
    if (players) {
      this.players = players.map(p => ({ id: p.id, name: p.name, bit: BITS[p.bit] ? p.bit : 'std', chips: [...p.chips] }));
    } else {
      this.players = names.map((name, i) => ({ id: 'p' + i, name, bit: 'std', chips: [] }));
      const rng = prngFromHex(randomHex(16));
      for (const p of this.players) for (let i = 0; i < 12; i++) p.chips.push(this.mintChip(rng));
    }
    this.newGame();
  }

  // «Минт» фишки для демо. На сервере фишки выпускает store.js.
  mintChip(rng) {
    let r = rng.next() * 100, rarity = 'common';
    for (const [k, w] of Object.entries(RARITY_WEIGHTS)) { if (r < w) { rarity = k; break; } r -= w; }
    const pool = SKINS.filter(s => s.rarity === rarity);
    const skin = pool[rng.int(pool.length)];
    this.serial++;
    return { uid: `c${this.serial.toString(36)}${rng.int(1e6).toString(36)}`, skin: skin.id, serial: this.serial };
  }

  chipValue(c) { return RARITY[SKIN_BY_ID[c.skin].rarity].value; }

  newGame() {
    this.clearTimer();
    // у кого не осталось фишек — получает утешительные (на сервере их выпускает база)
    this.players.forEach((p, i) => {
      if (p.chips.length === 0 && this.hooks.refill) p.chips.push(...this.hooks.refill(i));
    });
    // оба ставят поровну; чередуем в стопке
    const stake = Math.min(this.stake, ...this.players.map(p => p.chips.length));
    this.table = [];
    this.origin = {};
    const bets = this.players.map((p, i) => {
      const bet = p.chips.splice(0, stake);
      for (const c of bet) this.origin[c.uid] = i;
      return bet;
    });
    for (let k = 0; k < stake; k++) for (const b of bets) if (b[k]) this.table.push(b[k]);
    // Способ игры выбирается на всю партию, как во дворе: «на битах» или «стопкой».
    // Выбирает хозяин стола (игрок 0). У каждого режима свой рейтинг.
    this.mode = null;
    this.phase = 'mode';
    this.rps = [null, null];
    this.rpsLog = null;
    this.current = 0;
    this.turn = 0;
    this.commit = null;
    this.serverSeed = null;
    this.won = [[], []];
    this.winner = null;
    this.hooks.onNewGame?.();
    this.armTimer();
    this.broadcastState();
  }

  publicState() {
    return {
      phase: this.phase, mode: this.mode, turn: this.turn, current: this.current, commit: this.commit,
      simVersion: SIM_VERSION, winner: this.winner,
      deadline: this.deadline, now: Date.now(),
      table: this.table,
      rpsReady: this.rps.map(Boolean), rpsLog: this.rpsLog,
      players: this.players.map((p, i) => ({
        name: p.name, bit: p.bit, chips: p.chips,
        value: p.chips.reduce((s, c) => s + this.chipValue(c), 0),
        wonThisGame: this.won[i],
      })),
    };
  }
  broadcastState() { this.send('all', { t: 'state', state: this.publicState() }); }
  error(p, msg) { this.send(p, { t: 'error', msg }); }

  // ---- таймер хода: в онлайне никто не может «подвесить» партию ----
  clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.deadline = null; }
  armTimer() {
    this.clearTimer();
    const ms = this.timers?.[this.phase];
    if (!ms) return;
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => { this.timer = null; this.onTimeout().catch(() => {}); }, ms);
    this.timer.unref?.();
  }
  async onTimeout() {
    if (this.busy) return;
    if (this.phase === 'mode') {
      this.send('all', { t: 'notice', msg: 'Хозяин стола не выбрал способ — играем на битах' });
      return this.handle(0, { t: 'mode', mode: 'slam' });
    }
    if (this.phase === 'rps') {
      const opts = ['rock', 'scissors', 'paper'];
      const rng = prngFromHex(randomHex(8));
      for (const i of [0, 1]) if (!this.rps[i]) { this.rps[i] = opts[rng.int(3)]; }
      return this.onRps(0, this.rps[0], true);
    }
    if (this.phase === 'aim') {
      this.send('all', { t: 'notice', msg: `${this.players[this.current].name} не успел — ход переходит` });
      if (this.turn >= MAX_TURNS) return this.finish();
      this.current = 1 - this.current;
      return this.startTurn();
    }
  }

  async startTurn() {
    this.turn++;
    this.serverSeed = randomHex(32);
    this.commit = await sha256Hex(this.serverSeed);  // публикуем ТОЛЬКО хэш
    this.phase = 'aim';
    this.armTimer();
    this.broadcastState();
  }

  async handle(p, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'mode':
        if (this.phase !== 'mode') return this.error(p, 'Способ уже выбран');
        if (p !== 0) return this.error(p, 'Способ выбирает хозяин стола');
        if (msg.mode !== 'slam' && msg.mode !== 'drop') return this.error(p, 'Нет такого способа');
        this.mode = msg.mode;
        this.hooks.onMode?.(this.mode);
        this.phase = 'rps';
        this.armTimer();
        return this.broadcastState();
      case 'rps': return this.onRps(p, msg.choice);
      case 'bit':
        if (!BITS[msg.bitId]) return this.error(p, 'Нет такой биты');
        if (this.phase === 'sim') return this.error(p, 'Нельзя менять биту во время броска');
        this.players[p].bit = msg.bitId;
        this.hooks.onBit?.(p, msg.bitId);
        return this.broadcastState();
      case 'throw': return this.onThrow(p, msg);
      case 'new':
        if (this.phase !== 'over') return this.error(p, 'Партия ещё идёт');
        if (this.hooks.canRestart && !this.hooks.canRestart()) return this.error(p, 'Соперник ещё не вернулся');
        return this.newGame();
    }
  }

  async onRps(p, choice, forced = false) {
    if (this.phase !== 'rps') return;
    if (!forced) {
      if (!['rock', 'scissors', 'paper'].includes(choice)) return this.error(p, 'Неверный выбор');
      this.rps[p] = choice;
    }
    if (!this.rps[0] || !this.rps[1]) return this.broadcastState();
    const [a, b] = this.rps;
    const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
    if (a === b) {
      this.rpsLog = { a, b, tie: true };
      this.rps = [null, null];
      this.armTimer();
      return this.broadcastState();
    }
    this.current = beats[a] === b ? 0 : 1;
    this.rpsLog = { a, b, first: this.current };
    this.rps = [null, null];
    await this.startTurn();
  }

  async onThrow(p, msg) {
    if (this.busy) return this.error(p, 'Бросок уже обрабатывается');
    if (this.phase !== 'aim') return this.error(p, 'Сейчас нельзя бросать');
    if (p !== this.current) return this.error(p, 'Не ваш ход');
    if (msg.turn !== this.turn) return this.error(p, 'Устаревший ход');
    const bad = validateInput(msg.input);
    if (bad) return this.error(p, `Неверный ввод: ${bad}`);
    if (msg.input.mode !== this.mode)
      return this.error(p, this.mode === 'slam' ? 'В этой партии играем на битах' : 'В этой партии играем стопкой');
    if (typeof msg.clientSeed !== 'string' || !/^[0-9a-f]{16,64}$/.test(msg.clientSeed))
      return this.error(p, 'Неверный clientSeed');

    this.busy = true;
    this.clearTimer();
    this.phase = 'sim';
    try {
      const input = {
        mode: msg.input.mode, power: msg.input.power, tilt: msg.input.tilt,
        dir: msg.input.dir, aim: msg.input.aim,
      };
      const bitId = this.players[p].bit;
      const chipUids = this.table.map(c => c.uid);
      const fairSeed = await deriveFairSeed(this.serverSeed, msg.clientSeed, this.turn);
      const res = await simulateThrow(this.R, { chips: chipUids, bitId, input, fairSeed, record: false });
      const request = { chips: chipUids, bitId, input };

      // сначала запись в базу (если упадёт — бросок не засчитан, состояние не тронуто)
      if (this.hooks.onThrow) {
        const fromIds = {};
        for (const uid of res.won) fromIds[uid] = this.players[this.origin[uid]].id;
        this.hooks.onThrow({
          turn: this.turn, playerId: this.players[p].id, fromIds,
          serverSeed: this.serverSeed, clientSeed: msg.clientSeed, simVersion: SIM_VERSION,
          request, hash: res.hash, won: res.won,
        });
      }

      // перенос выигранных фишек
      const wonSet = new Set(res.won);
      const wonChips = this.table.filter(c => wonSet.has(c.uid));
      this.table = this.table.filter(c => !wonSet.has(c.uid));
      this.players[p].chips.push(...wonChips);
      this.won[p].push(...wonChips);

      // раскрываем сид: теперь любой может проверить бросок
      this.send('all', {
        t: 'result', turn: this.turn, player: p,
        reveal: { serverSeed: this.serverSeed, commit: this.commit, clientSeed: msg.clientSeed },
        request,
        result: { jittered: res.jittered, foul: res.foul, won: res.won, outcome: res.outcome, steps: res.steps, fineSteps: res.fineSteps, simTime: res.simTime, hash: res.hash },
      });

      if (this.table.length === 0 || this.turn >= MAX_TURNS) this.finish();
      else {
        this.current = 1 - this.current;
        await this.startTurn();
      }
    } catch (e) {
      this.phase = 'aim';
      this.armTimer();
      this.error(p, 'Ошибка симуляции: ' + (e && e.message));
    } finally {
      this.busy = false;
    }
  }

  /** Конец партии: остаток стопки возвращается владельцам, победитель — кто выиграл больше по ценности. */
  finish() {
    this.clearTimer();
    for (const c of this.table) this.players[this.origin[c.uid]].chips.push(c);
    this.table = [];
    const val = this.won.map(list => list.reduce((s, c) => s + this.chipValue(c), 0));
    this.winner = val[0] > val[1] ? 0 : val[1] > val[0] ? 1 : null;
    this.phase = 'over';
    this.commit = null;
    this.hooks.onGameOver?.({ winner: this.winner, mode: this.mode });
    this.broadcastState();
  }

  /** Партия брошена (игрок ушёл): ставки остаются у владельцев. */
  abandon() {
    this.clearTimer();
    for (const c of this.table) this.players[this.origin[c.uid]].chips.push(c);
    this.table = [];
    this.phase = 'over';
    this.commit = null;
  }
}

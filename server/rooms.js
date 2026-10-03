// Столы (комнаты), приглашения, случайный подбор, переподключение.
// Один игрок — одно активное соединение и один стол.

import { randomInt } from 'node:crypto';
import { GameCore } from './core.js';
import { randomHex, prngFromHex } from '../shared/fair.js';
import { BITS } from '../shared/content.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // без 0/O и 1/I
const RECONNECT_GRACE_MS = 60_000;     // столько ждём вернувшегося игрока
const WAIT_ROOM_TTL_MS = 30 * 60_000;  // пустой стол с приглашением живёт полчаса
const TIMERS = { mode: 30_000, rps: 20_000, aim: 45_000 };

// В логах — только короткий обезличенный номер игрока, без имён
const who = (pid) => '#' + String(pid).slice(-4);
const log = (...a) => console.log('[room]', ...a);

export class Rooms {
  /**
   * @param RAPIER   инициализированный Rapier
   * @param store    Store
   * @param inviteLink (roomId) => string
   */
  constructor(RAPIER, store, { inviteLink = (id) => id, timers = TIMERS, graceMs = RECONNECT_GRACE_MS, botSpeed = 1 } = {}) {
    this.botSpeed = botSpeed;   // в тестах бот ходит быстрее
    this.R = RAPIER;
    this.store = store;
    this.inviteLink = inviteLink;
    this.timers = timers;
    this.graceMs = graceMs;
    this.rooms = new Map();      // id → room
    this.sessions = new Map();   // playerId → { conn, roomId }
    this.queue = null;           // roomId стола, ждущего случайного соперника
  }

  newRoomId() {
    for (;;) {
      let id = '';
      for (let i = 0; i < 5; i++) id += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
      if (!this.rooms.has(id)) return id;
    }
  }

  // ---------- соединения ----------

  /** Игрок прошёл авторизацию. */
  attach(conn, player, wantRoom = null) {
    const prev = this.sessions.get(player.id);
    if (prev?.conn && prev.conn !== conn) {
      this.sendTo(prev.conn, { t: 'error', msg: 'Игра открыта в другом окне' });
      prev.conn.__replaced = true;
      prev.conn.close(4000);
    }
    const session = { conn, roomId: prev?.roomId || null };
    this.sessions.set(player.id, session);
    conn.playerId = player.id;

    const room = session.roomId && this.rooms.get(session.roomId);
    if (room) return this.rejoin(room, player.id);
    session.roomId = null;
    if (wantRoom) return this.join(player.id, wantRoom);
    this.sendTo(conn, this.emptyLobby(player.id));
  }

  detach(conn) {
    const pid = conn.playerId;
    if (!pid || conn.__replaced) return;
    const session = this.sessions.get(pid);
    if (!session || session.conn !== conn) return;
    session.conn = null;
    const room = session.roomId && this.rooms.get(session.roomId);
    if (!room) { this.sessions.delete(pid); return; }
    const seat = room.seats.findIndex(s => s.pid === pid);
    if (seat < 0) return;
    room.seats[seat].online = false;
    this.toSeat(room, 1 - seat, { t: 'peer', status: 'away', graceSec: Math.round(this.graceMs / 1000) });
    clearTimeout(room.seats[seat].grace);
    // хозяин пустого стола может спокойно уйти и вернуться по ссылке; идущую партию ждём минуту
    const wait = room.seats.length < 2 ? WAIT_ROOM_TTL_MS : this.graceMs;
    room.seats[seat].grace = setTimeout(() => this.closeRoom(room, 'gone', pid), wait);
    room.seats[seat].grace.unref?.();
  }

  sendTo(conn, msg) { if (conn && conn.readyState === 1) conn.send(JSON.stringify(msg)); }
  toSeat(room, i, msg) { const s = room.seats[i]; if (s) this.sendTo(this.sessions.get(s.pid)?.conn, msg); }
  toRoom(room, to, msg) {
    if (to === 'all') room.seats.forEach((_, i) => this.toSeat(room, i, msg));
    else this.toSeat(room, to, msg);
  }

  // ---------- лобби ----------

  meInfo(pid) {
    const p = this.store.getPlayer(pid);
    return { id: pid, name: p?.name, chips: this.store.chipsOf(pid).length,
      ratings: { slam: this.store.rating(pid, 'slam'), drop: this.store.rating(pid, 'drop') } };
  }
  emptyLobby(pid) { return { t: 'lobby', room: null, me: this.meInfo(pid) }; }

  lobbyMsg(room, pid) {
    return { t: 'lobby', room: room.id, invite: this.inviteLink(room.id), seat: room.seats.findIndex(s => s.pid === pid),
      waiting: room.seats.length < 2, random: room.random };
  }

  create(pid, { random = false } = {}) {
    this.leaveIfWaiting(pid);
    const session = this.sessions.get(pid);
    if (session.roomId) return this.sendTo(session.conn, { t: 'error', msg: 'Вы уже за столом' });
    const player = this.store.getPlayer(pid);
    const room = { id: this.newRoomId(), seats: [{ pid, name: player.name, online: true, grace: null }],
      core: null, matchId: null, random, createdAt: Date.now() };
    this.rooms.set(room.id, room);
    log(room.id, random ? 'создан (случайный соперник)' : 'создан (по приглашению)', who(pid));
    session.roomId = room.id;
    this.sendTo(session.conn, this.lobbyMsg(room, pid));
    return room;
  }

  quick(pid) {
    const q = this.queue && this.rooms.get(this.queue);
    if (q && q.seats.length === 1 && q.seats[0].pid !== pid) {
      this.queue = null;
      return this.join(pid, q.id);
    }
    const room = this.create(pid, { random: true });
    if (room) this.queue = room.id;
  }

  /**
   * Тренировка с ботом: проверить игру в одиночку.
   * Фишки тренировочные (выпускаются в памяти), база и рейтинг не трогаются.
   */
  training(pid) {
    this.leaveIfWaiting(pid);
    const session = this.sessions.get(pid);
    if (session.roomId) return this.sendTo(session.conn, { t: 'error', msg: 'Вы уже за столом' });
    const player = this.store.getPlayer(pid);
    const BOT = 'bot:' + pid;
    const room = { id: this.newRoomId(), training: true, random: false, createdAt: Date.now(), matchId: null,
      seats: [{ pid, name: player.name, online: true, grace: null }, { pid: BOT, name: 'Бот-тренер', online: true, grace: null, bot: true }] };
    this.rooms.set(room.id, room);
    session.roomId = room.id;
    log(room.id, 'тренировка с ботом', who(pid));
    this.toSeat(room, 0, { t: 'you', idx: 0, room: room.id, opponent: 'Бот-тренер', opponentOnline: true, training: true });

    const timers = new Set();
    const later = (ms, fn) => {
      const t = setTimeout(() => { timers.delete(t); if (this.rooms.get(room.id) === room) fn(); }, ms * this.botSpeed);
      t.unref?.(); timers.add(t);
    };
    room.stopBot = () => { for (const t of timers) clearTimeout(t); timers.clear(); };
    const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
    let lastTurnSeen = -1;
    // «Мозг» бота: смотрит на состояние, как живой игрок, и ходит с паузой
    const brain = (msg) => {
      if (msg.t !== 'state') return;
      const st = msg.state, core = room.core;
      if (st.phase === 'rps' && !st.rpsReady[1]) {
        later(rnd(700, 1500), () => core.handle(1, { t: 'rps', choice: ['rock', 'scissors', 'paper'][rnd(0, 2)] }));
      }
      if (st.phase === 'aim' && st.current === 1 && st.turn !== lastTurnSeen) {
        lastTurnSeen = st.turn;
        const turn = st.turn;
        // ждём, пока у человека доиграет повтор предыдущего броска
        later(rnd(4500, 6500), () => {
          if (core.phase !== 'aim' || core.current !== 1 || core.turn !== turn) return;
          const mode = core.mode;
          core.handle(1, { t: 'throw', turn, clientSeed: randomHex(16), input: {
            mode, power: mode === 'slam' ? rnd(450, 950) : rnd(350, 900),
            tilt: rnd(20, 190), dir: rnd(0, 359), aim: mode === 'slam' ? rnd(350, 900) : rnd(0, 1000),
          } });
        });
      }
    };
    room.core = new GameCore(this.R, (to, msg) => {
      this.toRoom(room, to, msg);
      if (to === 'all' || to === 1) brain(msg);
    }, {
      names: [player.name, 'Бот-тренер'],
      timers: this.timers,
      hooks: {
        canRestart: () => room.seats[0].online,
        // проигравшему всё — новые тренировочные фишки
        refill: () => { const rng = prngFromHex(randomHex(16)); return Array.from({ length: 5 }, () => room.core.mintChip(rng)); },
      },
    });
    room.core.players[0].bit = BITS[player.bit] ? player.bit : 'std';
    room.core.broadcastState();
  }

  join(pid, roomId) {
    const session = this.sessions.get(pid);
    roomId = String(roomId || '').toUpperCase().replace(/^ROOM_/, '').slice(0, 8);
    const room = this.rooms.get(roomId);
    if (session.roomId === roomId && room) return this.rejoin(room, pid);
    this.leaveIfWaiting(pid);
    if (session.roomId) return this.sendTo(session.conn, { t: 'error', msg: 'Вы уже за другим столом' });
    // стол по ссылке не найден или занят — сообщаем и обязательно показываем лобби, иначе экран останется пустым
    const fail = (msg, code) => {
      this.sendTo(session.conn, { t: 'error', msg, code });
      if (!session.roomId) this.sendTo(session.conn, this.emptyLobby(pid));
    };
    if (!room) { log(roomId, 'не найден при входе', who(pid)); return fail('Стол по этой ссылке уже закрыт — создайте новый', 'no_room'); }
    if (room.seats.length >= 2) return fail('За этим столом уже двое', 'full');
    const player = this.store.getPlayer(pid);
    room.seats.push({ pid, name: player.name, online: true, grace: null });
    session.roomId = room.id;
    if (this.queue === room.id) this.queue = null;
    log(room.id, 'сел второй игрок', who(pid), '— партия началась');
    this.startMatch(room);
  }

  /** Выйти из стола, где ещё нет соперника (или из очереди). */
  leaveIfWaiting(pid) {
    const session = this.sessions.get(pid);
    const room = session?.roomId && this.rooms.get(session.roomId);
    if (room && room.seats.length === 1) this.closeRoom(room, 'cancel');
  }

  leave(pid) {
    const session = this.sessions.get(pid);
    const room = session?.roomId && this.rooms.get(session.roomId);
    if (!room) return this.sendTo(session?.conn, this.emptyLobby(pid));
    this.closeRoom(room, room.seats.length < 2 ? 'cancel' : 'left', pid);
  }

  rejoin(room, pid) {
    const i = room.seats.findIndex(s => s.pid === pid);
    const seat = room.seats[i];
    clearTimeout(seat.grace);
    seat.grace = null;
    const wasAway = !seat.online;
    seat.online = true;
    const conn = this.sessions.get(pid).conn;
    if (!room.core) return this.sendTo(conn, this.lobbyMsg(room, pid));
    this.sendTo(conn, { t: 'you', idx: i, room: room.id, opponent: room.seats[1 - i]?.name, opponentOnline: !!room.seats[1 - i]?.online, training: !!room.training });
    this.sendTo(conn, { t: 'state', state: room.core.publicState() });
    if (wasAway) this.toSeat(room, 1 - i, { t: 'peer', status: 'back' });
  }

  // ---------- партия ----------

  startMatch(room) {
    const store = this.store;
    const players = room.seats.map(s => store.login({ id: s.pid, name: s.name, username: store.getPlayer(s.pid).username }));
    room.seats.forEach((s, i) => this.toSeat(room, i, { t: 'you', idx: i, room: room.id, opponent: room.seats[1 - i].name, opponentOnline: true }));
    const ids = room.seats.map(s => s.pid);
    room.core = new GameCore(this.R, (to, msg) => this.toRoom(room, to, msg), {
      players,
      timers: this.timers,
      hooks: {
        onNewGame: () => { room.matchId = store.createMatch(room.id, ids[0], ids[1]); },
        onMode: (mode) => store.setMatchMode(room.matchId, mode),
        onBit: (i, bitId) => { if (BITS[bitId]) store.setBit(ids[i], bitId); },
        onThrow: (rec) => store.recordThrow(room.matchId, rec),
        onGameOver: ({ winner, mode }) => {
          store.endMatch(room.matchId, { status: 'done', winner, mode, players: ids });
          room.matchId = null;
          this.toRoom(room, 'all', { t: 'ratings', mode, ratings: ids.map(id => store.rating(id, mode)) });
        },
        refill: (i) => store.refill(ids[i]),
        canRestart: () => room.seats.every(s => s.online),
      },
    });
  }

  /** Сообщение игры от игрока: пересылаем в GameCore его стола. */
  game(pid, msg) {
    const session = this.sessions.get(pid);
    const room = session?.roomId && this.rooms.get(session.roomId);
    if (!room?.core) return this.sendTo(session?.conn, { t: 'error', msg: 'Вы не за столом' });
    const seat = room.seats.findIndex(s => s.pid === pid);
    return room.core.handle(seat, msg);
  }

  closeRoom(room, reason, byPid = null) {
    if (!this.rooms.has(room.id)) return;
    this.rooms.delete(room.id);
    log(room.id, 'закрыт:', reason, byPid ? who(byPid) : '');
    if (this.queue === room.id) this.queue = null;
    room.stopBot?.();
    if (room.core) {
      if (room.core.phase !== 'over') room.core.abandon();
      room.core.clearTimer();
      if (room.matchId) this.store.endMatch(room.matchId, { status: 'abandoned' });
    }
    const text = {
      gone: 'Соперник не вернулся — партия отменена, ставки вернулись владельцам',
      left: 'Соперник вышел из-за стола — ставки вернулись владельцам',
      cancel: null,
    }[reason];
    for (const s of room.seats) {
      clearTimeout(s.grace);
      const session = this.sessions.get(s.pid);
      if (!session) continue;
      session.roomId = null;
      if (!session.conn) { this.sessions.delete(s.pid); continue; }
      if (s.pid !== byPid && text) this.sendTo(session.conn, { t: 'notice', msg: text });
      this.sendTo(session.conn, this.emptyLobby(s.pid));
    }
  }

  stats() { return { rooms: this.rooms.size, online: [...this.sessions.values()].filter(s => s.conn).length }; }
}

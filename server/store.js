// Хранилище на встроенном SQLite (node:sqlite, Node ≥ 22.13) — без внешних пакетов.
// Здесь живут игроки, их фишки, партии, каждый бросок (для проверки честности) и рейтинги.
// На хостинге файл базы должен лежать на постоянном диске (DATA_DIR), иначе всё сотрётся при деплое.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SKINS, BITS } from '../shared/content.js';

const RARITY_WEIGHTS = { common: 64, rare: 26, epic: 8, legendary: 2 };
export const STARTER_CHIPS = 12;
const ELO_START = 1000, ELO_K = 24;

function rollSkin() {
  const r0 = randomBytes(4).readUInt32BE() / 2 ** 32 * 100;
  let r = r0, rarity = 'common';
  for (const [k, w] of Object.entries(RARITY_WEIGHTS)) { if (r < w) { rarity = k; break; } r -= w; }
  const pool = SKINS.filter(s => s.rarity === rarity);
  return pool[randomBytes(2).readUInt16BE() % pool.length].id;
}

export class Store {
  constructor(dir = process.env.DATA_DIR || './data') {
    const file = dir === ':memory:' ? ':memory:' : (mkdirSync(dir, { recursive: true }), join(dir, 'sotki.db'));
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT,
        bit TEXT NOT NULL DEFAULT 'std',
        created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chips (
        uid TEXT PRIMARY KEY, serial INTEGER NOT NULL UNIQUE,
        owner_id TEXT NOT NULL REFERENCES players(id),
        skin TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chips_owner ON chips(owner_id);
      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, mode TEXT,
        p0 TEXT NOT NULL, p1 TEXT NOT NULL, winner INTEGER,  -- 0, 1, NULL = ничья/брошена
        status TEXT NOT NULL DEFAULT 'live',                 -- live | done | abandoned
        started_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE TABLE IF NOT EXISTS throws (
        match_id INTEGER NOT NULL REFERENCES matches(id), turn INTEGER NOT NULL,
        player_id TEXT NOT NULL, server_seed TEXT NOT NULL, client_seed TEXT NOT NULL,
        sim_version TEXT NOT NULL, request_json TEXT NOT NULL,
        hash TEXT NOT NULL, won_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (match_id, turn));
      CREATE TABLE IF NOT EXISTS ratings (
        player_id TEXT NOT NULL REFERENCES players(id), mode TEXT NOT NULL,
        rating REAL NOT NULL, games INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, mode));
    `);
    this.q = {
      getPlayer: this.db.prepare('SELECT * FROM players WHERE id = ?'),
      insPlayer: this.db.prepare('INSERT INTO players (id, name, username, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'),
      touchPlayer: this.db.prepare('UPDATE players SET name = ?, username = ?, last_seen = ? WHERE id = ?'),
      setBit: this.db.prepare('UPDATE players SET bit = ? WHERE id = ?'),
      chipsOf: this.db.prepare('SELECT uid, skin, serial FROM chips WHERE owner_id = ? ORDER BY serial'),
      maxSerial: this.db.prepare('SELECT COALESCE(MAX(serial), 0) AS s FROM chips'),
      insChip: this.db.prepare('INSERT INTO chips (uid, serial, owner_id, skin, created_at) VALUES (?, ?, ?, ?, ?)'),
      moveChip: this.db.prepare('UPDATE chips SET owner_id = ? WHERE uid = ? AND owner_id = ?'),
      insMatch: this.db.prepare('INSERT INTO matches (room, p0, p1, started_at) VALUES (?, ?, ?, ?)'),
      setMode: this.db.prepare('UPDATE matches SET mode = ? WHERE id = ?'),
      endMatch: this.db.prepare('UPDATE matches SET status = ?, winner = ?, ended_at = ? WHERE id = ?'),
      insThrow: this.db.prepare(`INSERT INTO throws (match_id, turn, player_id, server_seed, client_seed,
        sim_version, request_json, hash, won_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      getThrows: this.db.prepare('SELECT * FROM throws WHERE match_id = ? ORDER BY turn'),
      getRating: this.db.prepare('SELECT rating, games FROM ratings WHERE player_id = ? AND mode = ?'),
      upRating: this.db.prepare(`INSERT INTO ratings (player_id, mode, rating, games) VALUES (?, ?, ?, 1)
        ON CONFLICT(player_id, mode) DO UPDATE SET rating = excluded.rating, games = games + 1`),
      top: this.db.prepare('SELECT p.name, r.rating, r.games FROM ratings r JOIN players p ON p.id = r.player_id WHERE r.mode = ? ORDER BY r.rating DESC LIMIT ?'),
    };
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Найти или завести игрока. Новичку выдаются стартовые фишки. */
  login({ id, name, username = null }) {
    const now = Date.now();
    return this.tx(() => {
      let p = this.q.getPlayer.get(id);
      if (p) this.q.touchPlayer.run(name, username, now, id);
      else {
        this.q.insPlayer.run(id, name, username, now, now);
        this.mint(id, STARTER_CHIPS);
      }
      p = this.q.getPlayer.get(id);
      return { id: p.id, name: p.name, bit: BITS[p.bit] ? p.bit : 'std', chips: this.chipsOf(id) };
    });
  }

  mint(ownerId, n) {
    let serial = this.q.maxSerial.get().s;
    const now = Date.now(), out = [];
    for (let i = 0; i < n; i++) {
      serial++;
      const uid = 'c' + serial.toString(36) + randomBytes(3).toString('hex');
      const skin = rollSkin();
      this.q.insChip.run(uid, serial, ownerId, skin, now);
      out.push({ uid, skin, serial });
    }
    return out;
  }
  /** Утешительные фишки тому, кто проиграл всё. */
  refill(ownerId, n = 5) { return this.tx(() => this.mint(ownerId, n)); }

  chipsOf(id) { return this.q.chipsOf.all(id).map(r => ({ uid: r.uid, skin: r.skin, serial: r.serial })); }
  getPlayer(id) { return this.q.getPlayer.get(id) || null; }
  setBit(id, bit) { this.q.setBit.run(bit, id); }

  createMatch(room, p0, p1) { return Number(this.q.insMatch.run(room, p0, p1, Date.now()).lastInsertRowid); }
  setMatchMode(matchId, mode) { this.q.setMode.run(mode, matchId); }

  /** Бросок: запись для проверки + переход выигранных фишек к броску — одной транзакцией. */
  recordThrow(matchId, { turn, playerId, fromIds, serverSeed, clientSeed, simVersion, request, hash, won }) {
    this.tx(() => {
      this.q.insThrow.run(matchId, turn, playerId, serverSeed, clientSeed, simVersion,
        JSON.stringify(request), hash, JSON.stringify(won), Date.now());
      for (const uid of won) {
        // фишка переходит, только если всё ещё у того, кто её ставил (защита от двойного списания)
        const r = this.q.moveChip.run(playerId, uid, fromIds[uid]);
        if (r.changes !== 1 && fromIds[uid] !== playerId) throw new Error('chip ownership mismatch ' + uid);
      }
    });
  }

  /** Конец партии. winner: 0 / 1 / null (ничья). status 'abandoned' — рейтинг не трогаем. */
  endMatch(matchId, { status, winner = null, mode = null, players = null }) {
    this.tx(() => {
      this.q.endMatch.run(status, winner, Date.now(), matchId);
      if (status !== 'done' || !mode || !players) return;
      const r = players.map(id => this.q.getRating.get(id, mode)?.rating ?? ELO_START);
      const exp0 = 1 / (1 + 10 ** ((r[1] - r[0]) / 400));
      const s0 = winner === 0 ? 1 : winner === 1 ? 0 : 0.5;
      this.q.upRating.run(players[0], mode, r[0] + ELO_K * (s0 - exp0));
      this.q.upRating.run(players[1], mode, r[1] + ELO_K * ((1 - s0) - (1 - exp0)));
    });
  }

  rating(id, mode) { return Math.round(this.q.getRating.get(id, mode)?.rating ?? ELO_START); }
  top(mode, n = 10) { return this.q.top.all(mode, n).map(r => ({ name: r.name, rating: Math.round(r.rating), games: r.games })); }
  throwsOf(matchId) { return this.q.getThrows.all(matchId); }
  close() { this.db.close(); }
}

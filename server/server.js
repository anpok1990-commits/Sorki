// Сервер «Соток»: раздаёт клиент, держит столы по WebSocket, хранит игроков и фишки, запускает бота.
//
// Переменные окружения (секреты — только здесь, никогда в коде и в чате):
//   BOT_TOKEN          токен от @BotFather
//   APP_URL            публичный https-адрес этого сервера, например https://sotki.up.railway.app
//   BOT_APP_SHORTNAME  (необязательно) короткое имя Mini App из BotFather → /newapp
//   DATA_DIR           папка для базы (на хостинге — постоянный диск), по умолчанию ./data
//   PORT               порт (хостинг задаёт сам), по умолчанию 8080
//   DEV_AUTH=1         вход без Telegram (для локальной отладки; на проде НЕ включать)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attachWebSocket } from './ws.js';
import { verifyInitData } from './auth.js';
import { Store } from './store.js';
import { Rooms } from './rooms.js';
import { Bot } from './bot.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
// что можно отдавать браузеру (серверный код, база и секреты — нельзя)
const PUBLIC = [/^\/index\.html$/, /^\/client\/[\w.-]+\.js$/, /^\/shared\/[\w.-]+\.js$/, /^\/server\/core\.js$/];

export async function startServer({ RAPIER, port = 8080, store = new Store(), botToken = '', appUrl = '', shortName = '', devAuth = false, bot = null, timers, graceMs } = {}) {
  if (!botToken && !devAuth) console.warn('[server] BOT_TOKEN не задан и DEV_AUTH выключен — войти в игру будет нельзя');
  const rooms = new Rooms(RAPIER, store, { inviteLink: (id) => bot?.inviteLink(id) || null, timers, graceMs });

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let path = decodeURIComponent(url.pathname);
      if (path === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...rooms.stats(),
          bot: bot ? { status: bot.status, username: bot.username, error: bot.lastError } : (botToken ? 'APP_URL не задан' : 'BOT_TOKEN не задан'),
          appUrl: appUrl || null }));
      }
      if (path === '/') path = '/index.html';
      if (!PUBLIC.some(re => re.test(path))) throw new Error('forbidden');
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT + (ROOT.endsWith(sep) ? '' : sep))) throw new Error('forbidden');
      let body = await readFile(file);
      if (path === '/index.html') {
        // index.html написан как фрагмент (для хостинга артефактов) — добавляем каркас и SDK Telegram
        body = '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
          '<title>Сотки</title>' +
          '<script src="https://telegram.org/js/telegram-web-app.js"></script>' +
          '<style>body{margin:0}[hidden]{display:none!important}</style></head><body>' + body + '</body></html>';
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found');
    }
  });

  attachWebSocket(httpServer, (ws) => {
    let win = { t: 0, n: 0 };
    ws.on('message', async (raw) => {
      const now = Date.now();
      if (now - win.t > 1000) win = { t: now, n: 0 };
      if (++win.n > 20) return;                         // антиспам: 20 сообщений в секунду
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try {
        if (msg.t === 'hello') return hello(ws, msg);
        const pid = ws.playerId;
        if (!pid) return rooms.sendTo(ws, { t: 'error', msg: 'Сначала войдите', code: 'auth' });
        switch (msg.t) {
          case 'create': return rooms.create(pid);
          case 'quick': return rooms.quick(pid);
          case 'join': return rooms.join(pid, msg.room);
          case 'leave': return rooms.leave(pid);
          case 'top': return rooms.sendTo(ws, { t: 'top', mode: msg.mode, list: store.top(msg.mode === 'drop' ? 'drop' : 'slam') });
          case 'mode': case 'rps': case 'bit': case 'throw': case 'new':
            return await rooms.game(pid, msg);
        }
      } catch (e) {
        console.error('[ws]', e);
        rooms.sendTo(ws, { t: 'error', msg: 'Ошибка сервера' });
      }
    });
    ws.on('close', () => rooms.detach(ws));
  });

  function hello(ws, msg) {
    if (ws.playerId) return;
    let who = null;
    if (botToken && msg.initData) who = verifyInitData(msg.initData, botToken);
    else if (devAuth && msg.dev && /^[\w-]{1,24}$/.test(String(msg.dev.id))) {
      who = { id: 'dev_' + msg.dev.id, name: String(msg.dev.name || 'Гость').slice(0, 24), username: null, startParam: null };
    }
    if (!who) return rooms.sendTo(ws, { t: 'error', msg: 'Не удалось войти — откройте игру через бота в Telegram', code: 'auth' });
    const player = store.login({ id: who.id, name: who.name, username: who.username });
    rooms.sendTo(ws, { t: 'welcome', me: { id: player.id, name: player.name, chips: player.chips.length,
      ratings: { slam: store.rating(player.id, 'slam'), drop: store.rating(player.id, 'drop') } } });
    const room = typeof msg.room === 'string' && msg.room ? msg.room : who.startParam;
    rooms.attach(ws, player, room && /^(room_)?[A-Za-z0-9]{4,8}$/.test(room) ? room : null);
  }

  await new Promise(r => httpServer.listen(port, r));
  return { httpServer, rooms, store, port: httpServer.address().port, close: () => { httpServer.close(); bot?.stop(); } };
}

// ---- запуск как программы: node server/server.js ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: RAPIER } = await import('@dimforge/rapier3d-deterministic-compat');
  await RAPIER.init();
  const env = process.env;
  const botToken = env.BOT_TOKEN || '';
  // частая ошибка — адрес без https:// или с пробелом: чиним сами
  let appUrl = (env.APP_URL || '').trim().replace(/\/+$/, '');
  if (appUrl && !/^https?:\/\//.test(appUrl)) appUrl = 'https://' + appUrl;
  const botTokenClean = botToken.trim();
  const bot = botTokenClean && appUrl ? new Bot(botTokenClean, { appUrl, shortName: env.BOT_APP_SHORTNAME || '' }) : null;
  if (botToken && !appUrl) console.warn('[server] APP_URL не задан — бот не запущен');
  const srv = await startServer({
    RAPIER, port: Number(env.PORT || 8080), store: new Store(env.DATA_DIR || './data'),
    botToken: botTokenClean, appUrl, devAuth: env.DEV_AUTH === '1', bot,
  });
  // если Telegram недоступен или токен неверный — пробуем снова каждые 30 с, ошибку видно в /health
  const startBot = () => bot.start().catch(e => {
    console.error('[bot] не запустился:', bot.lastError || bot.safe(e.message));
    setTimeout(startBot, 30_000);
  });
  if (bot) startBot();
  console.log(`Сотки: порт ${srv.port}${env.DEV_AUTH === '1' ? '  (DEV_AUTH: вход без Telegram)' : ''}`);
  const shutdown = () => { srv.close(); srv.store.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

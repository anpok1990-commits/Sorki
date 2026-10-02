// Telegram-бот на long polling (без вебхука и без внешних пакетов).
// Делает три вещи: кнопка «Играть» в меню чата, ответ на /start и приглашения на стол.
// Токен берётся ТОЛЬКО из переменной окружения BOT_TOKEN.

const API = 'https://api.telegram.org';

export class Bot {
  constructor(token, { appUrl, shortName = '' } = {}) {
    this.token = token;
    this.appUrl = appUrl;
    this.shortName = shortName;
    this.username = null;
    this.offset = 0;
    this.running = false;
    this.status = 'starting';     // для /health: видно, жив ли бот, без секретов
    this.lastError = null;
  }

  // в тексте ошибки не должно оказаться токена (он есть в URL запроса)
  safe(msg) { return String(msg).split(this.token).join('***'); }

  async call(method, params = {}) {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(40_000),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
  }

  /** Ссылка-приглашение на стол. С короткой ссылкой Mini App игра открывается сразу, без чата с ботом. */
  inviteLink(roomId) {
    if (!this.username) return null;
    return this.shortName
      ? `https://t.me/${this.username}/${this.shortName}?startapp=${roomId}`
      : `https://t.me/${this.username}?start=room_${roomId}`;
  }

  appUrlFor(roomId) {
    const u = new URL(this.appUrl);
    if (roomId) u.searchParams.set('room', roomId);
    return u.toString();
  }

  async start() {
    let me;
    try { me = await this.call('getMe'); }
    catch (e) { this.status = 'error'; this.lastError = 'getMe: ' + this.safe(e.message); throw e; }
    this.username = me.username;
    // Удаляем вебхук, если был — иначе getUpdates не работает
    await this.call('deleteWebhook', { drop_pending_updates: false });
    await this.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: this.appUrl } } })
      .catch(e => console.warn('[bot] menu button:', e.message));
    await this.call('setMyCommands', { commands: [
      { command: 'start', description: 'Открыть игру' },
      { command: 'help', description: 'Как играть' },
    ] }).catch(() => {});
    this.running = true;
    this.status = 'running';
    console.log(`[bot] @${this.username} запущен`);
    this.loop();
  }

  stop() { this.running = false; }

  async loop() {
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message'] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.onUpdate(u).catch(e => { this.lastError = 'update: ' + this.safe(e.message); console.warn('[bot] update:', this.lastError); });
        }
      } catch (e) {
        if (!this.running) break;
        this.lastError = 'polling: ' + this.safe(e.message);
        console.warn('[bot]', this.lastError);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  async onUpdate(u) {
    const m = u.message;
    if (!m?.text || m.chat?.type !== 'private') return;
    const [cmd, payload = ''] = m.text.trim().split(/\s+/, 2);
    if (cmd === '/start') {
      const room = /^room_([A-Z0-9]{4,8})$/i.test(payload) ? payload.slice(5).toUpperCase() : null;
      const text = room
        ? `Вас позвали за стол ${room}. Жмите «Играть» — сядете прямо к сопернику.`
        : 'Сотки — игра в фишки с честной физикой. Жмите «Играть», создайте стол и позовите друга.';
      return this.call('sendMessage', {
        chat_id: m.chat.id, text,
        reply_markup: { inline_keyboard: [[{ text: '🎯 Играть', web_app: { url: this.appUrlFor(room) } }]] },
      });
    }
    if (cmd === '/help') {
      return this.call('sendMessage', {
        chat_id: m.chat.id,
        text: 'Каждый ставит фишки в общую стопку. Зажмите биту (или стопку) и тяните вверх — чем выше, тем сильнее удар; '
          + 'влево-вправо — наклон и прицел. Перевернулись лицом вверх — ваши. Способ игры выбирает хозяин стола на всю партию.\n\n'
          + 'Каждый бросок можно проверить: сервер заранее публикует хэш своего сида и раскрывает его после броска.',
      });
    }
  }
}

// Проверка подписи Telegram Mini App (initData).
// Telegram подписывает данные пользователя ключом, выведенным из токена бота.
// Подделать имя или id без токена нельзя — поэтому сервер доверяет только проверенным данным.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * @returns {{id:string, tgId:number, name:string, username:string|null, startParam:string|null} | null}
 */
export function verifyInitData(initData, botToken, maxAgeSec = 24 * 3600) {
  if (typeof initData !== 'string' || !initData || initData.length > 4096 || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = createHmac('sha256', secret).update(checkString).digest('hex');
  if (!timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return null; }
  if (!user || !Number.isSafeInteger(user.id)) return null;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim().slice(0, 32)
    || user.username || 'Игрок';
  return {
    id: 'tg' + user.id,
    tgId: user.id,
    name,
    username: user.username || null,
    startParam: params.get('start_param') || null,
  };
}

/** Для тестов: собрать initData так же, как это делает Telegram. */
export function signInitData(fields, botToken) {
  const params = new URLSearchParams(fields);
  const checkString = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(checkString).digest('hex'));
  return params.toString();
}

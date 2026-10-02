// Каталог контента: скины фишек и биты.
// Всё здесь — данные, а не логика. В продакшене скины = NFT-метаданные.

export const RARITY = {
  common:    { label: 'Обычная',     value: 1,  color: '#9aa4b2' },
  rare:      { label: 'Редкая',      value: 3,  color: '#3d8bfd' },
  epic:      { label: 'Эпическая',   value: 8,  color: '#a855f7' },
  legendary: { label: 'Легендарная', value: 25, color: '#f5b301' },
};

// pattern — как клиент рисует лицевую сторону (процедурно, без внешних картинок)
export const SKINS = [
  { id: 's01', name: 'Солнце',        rarity: 'common',    bg: '#ffb703', fg: '#fb8500', pattern: 'rays',    glyph: '☀' },
  { id: 's02', name: 'Волна',         rarity: 'common',    bg: '#8ecae6', fg: '#219ebc', pattern: 'waves',   glyph: '≈' },
  { id: 's03', name: 'Клетка',        rarity: 'common',    bg: '#e9edc9', fg: '#606c38', pattern: 'checker', glyph: '#' },
  { id: 's04', name: 'Мишень',        rarity: 'common',    bg: '#ffffff', fg: '#e63946', pattern: 'rings',   glyph: '◎' },
  { id: 's05', name: 'Горох',         rarity: 'common',    bg: '#ffc8dd', fg: '#cd5d8f', pattern: 'dots',    glyph: '•' },
  { id: 's06', name: 'Молния',        rarity: 'common',    bg: '#22223b', fg: '#fee440', pattern: 'bolt',    glyph: 'ϟ' },
  { id: 's07', name: 'Кактус',        rarity: 'common',    bg: '#d8f3dc', fg: '#2d6a4f', pattern: 'stripes', glyph: '✱' },
  { id: 's08', name: 'Спираль',       rarity: 'rare',      bg: '#caf0f8', fg: '#0077b6', pattern: 'spiral',  glyph: '@' },
  { id: 's09', name: 'Ракета',        rarity: 'rare',      bg: '#1d3557', fg: '#f1faee', pattern: 'stars',   glyph: '▲' },
  { id: 's10', name: 'Череп-2000',    rarity: 'rare',      bg: '#111111', fg: '#e5e5e5', pattern: 'rings',   glyph: '☠' },
  { id: 's11', name: 'Инь-ян',        rarity: 'rare',      bg: '#f8f9fa', fg: '#212529', pattern: 'yinyang', glyph: '' },
  { id: 's12', name: 'Кибер-кот',     rarity: 'rare',      bg: '#3a0ca3', fg: '#4cc9f0', pattern: 'grid',    glyph: '^.^' },
  { id: 's13', name: 'Дракон',        rarity: 'epic',      bg: '#6a040f', fg: '#ffba08', pattern: 'rays',    glyph: '🜂' },
  { id: 's14', name: 'Голограмма',    rarity: 'epic',      bg: '#240046', fg: '#ff9ef3', pattern: 'holo',    glyph: '◆' },
  { id: 's15', name: 'Галактика',     rarity: 'epic',      bg: '#03045e', fg: '#e0aaff', pattern: 'stars',   glyph: '✦' },
  { id: 's16', name: 'Золотая сотка', rarity: 'legendary', bg: '#7f5539', fg: '#ffd166', pattern: 'holo',    glyph: '100' },
  { id: 's17', name: 'Нулевые',       rarity: 'legendary', bg: '#0b090a', fg: '#80ffdb', pattern: 'grid',    glyph: '00' },
];

export const SKIN_BY_ID = Object.fromEntries(SKINS.map(s => [s.id, s]));

// Биты — это «сайдгрейды»: у каждой есть плюс и минус, нет лучшей.
// Больше силы -> больше разброс (серверный джиттер). Так магазин не превращается в pay-to-win.
// Баланс (caps-sim-4, по 16–20 ударов ребром): Классика 1.56, Свинчатка 1.38, Блин 1.81 фишки/удар —
// разница в пределах разброса выборки (исход хаотичен, нужна проверка на 200+ бросках: npm test).
// radius/halfHeight в сантиметрах, density в г/см³.
export const BITS = {
  std: {
    id: 'std', name: 'Классика', desc: 'Сбалансированная пластиковая бита',
    radius: 2.2, halfHeight: 0.22, density: 2.2, speedMul: 1,
    powerJitter: 0.05, tiltJitter: 2.0, aimJitter: 0.25, price: 0,
  },
  heavy: {
    id: 'heavy', name: 'Свинчатка', desc: 'Тяжелее в полтора раза, но летит медленнее, и рука дрожит сильнее',
    radius: 2.0, halfHeight: 0.25, density: 3.6, speedMul: 0.8,
    powerJitter: 0.09, tiltJitter: 3.6, aimJitter: 0.45, price: 150,
  },
  wide: {
    id: 'wide', name: 'Блин', desc: 'Широкая и лёгкая: накрывает больше стопки и точнее, но бьёт мягче',
    radius: 2.6, halfHeight: 0.18, density: 1.9, speedMul: 1.1,
    powerJitter: 0.035, tiltJitter: 1.4, aimJitter: 0.18, price: 150,
  },
};

// Для режима «бросок стопкой» (без биты) — джиттер руки
export const HAND = { powerJitter: 0.05, tiltJitter: 2.0, dirJitterDeg: 12 };

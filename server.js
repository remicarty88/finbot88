// Запуск: IIKO_LOGIN=Angel IIKO_PASS=... node server.js   (Node 18+, без зависимостей)
// Telegram-бот подключается в приложении: Настройки → Telegram-уведомления
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const HOST = process.env.IIKO_HOST || 'https://neon-takshkent-co.iiko.it';
const LOGIN = process.env.IIKO_LOGIN, PASS = process.env.IIKO_PASS, PORT = process.env.PORT || 3000;
if (!LOGIN || !PASS) { console.error('Задайте IIKO_LOGIN и IIKO_PASS'); process.exit(1); }

let token = null;
async function raw(p, opt) {
  const r = await fetch(HOST + p, opt), t = await r.text();
  if (!r.ok) throw new Error(r.status + ' ' + t.slice(0, 200));
  return t;
}
async function getKey() {
  if (!token) {
    const hash = crypto.createHash('sha1').update(PASS).digest('hex');
    token = (await raw('/resto/api/auth?login=' + encodeURIComponent(LOGIN) + '&pass=' + hash)).trim();
  }
  return token;
}
async function api(p, opt) {
  const go = async () => raw(p + (p.includes('?') ? '&' : '?') + 'key=' + await getKey(), opt);
  try { return await go(); } catch (e) { if (/^40[13]/.test(e.message)) { token = null; return go(); } throw e; }
}
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
function rows(xml, tag) {
  const out = [], re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g'); let m;
  while ((m = re.exec(xml))) {
    const o = {}; m[1].replace(/<(\w+)>([^<]*)<\/\1>/g, (_, k, v) => { o[k] = unesc(v); }); out.push(o);
  }
  return out;
}
const day = d => d.toISOString().slice(0, 10);
function range(q) {
  const to = q.get('to') || day(new Date(Date.now() + 864e5));
  const from = q.get('from') || day(new Date(Date.now() - 14 * 864e5));
  return { from, to };
}

async function staff(q) {
  const { from, to } = range(q);
  const [emp, roles, att] = await Promise.all([
    api('/resto/api/employees'), api('/resto/api/employees/roles'),
    api(`/resto/api/employees/attendance?from=${from}&to=${to}`)]);
  const roleName = Object.fromEntries(rows(roles, 'role').map(r => [r.id, r.name]));
  const people = {};
  rows(emp, 'employee').forEach(e => {
    people[e.id] = { id: e.id, name: e.name || e.login || e.id, role: roleName[e.mainRoleId] || e.mainRoleCode || '', shifts: [] };
  });
  rows(att, 'attendance').forEach(a => {
    const p = people[a.employeeId]; if (!p) return;
    p.shifts.push({ from: a.dateFrom, to: a.dateTo || null, dept: a.departmentName || '', role: roleName[a.roleId] || '' });
  });
  return Object.values(people).filter(p => p.shifts.length);
}

async function olap(q, t) {
  const { from, to } = range(q);
  const body = {
    reportType: 'SALES', buildSummary: false,
    groupByRowFields: ['OpenDate.Typed', 'OrderNum', 'OpenTime', 'Cashier', 'Department', 'OrderDeleted', 'Storned', ...t.fields],
    aggregateFields: ['DishSumInt', 'DishDiscountSumInt', ...t.aggs],
    filters: { 'OpenDate.Typed': { filterType: 'DateRange', periodType: 'CUSTOM', from: from + 'T00:00:00.000', to: to + 'T00:00:00.000', includeLow: true, includeHigh: false } }
  };
  // без этих фильтров iiko по умолчанию отдаёт только неудалённое — удалений в отчёте просто нет
  body.filters.OrderDeleted = { filterType: 'IncludeValues', values: ['NOT_DELETED', 'DELETED'] };
  if (t.fields.includes('DeletedWithWriteoff'))
    body.filters.DeletedWithWriteoff = { filterType: 'IncludeValues', values: ['NOT_DELETED', 'DELETED_WITH_WRITEOFF', 'DELETED_WITHOUT_WRITEOFF'] };
  const res = JSON.parse(await api('/resto/api/v2/reports/olap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return res.data || [];
}
// поле «Время печати блюда»: пусто → блюдо удалили до отправки на кухню (можно переопределить через PRINT_FIELD)
const PRINT = process.env.PRINT_FIELD || 'DishServicePrintTime';
// поле «Касса» (1, 2, 3): если в вашем iiko оно называется иначе, задайте CASH_FIELD
const CASH = process.env.CASH_FIELD || 'CashRegisterName';
// от полного набора полей к минимальному: если iiko не принимает поле, пробуем меньше
const TIERS = [
  { fields: ['TableNum', 'DishName', 'DeletedWithWriteoff', 'AuthUser', 'OrderDiscount.Type', PRINT, CASH], aggs: ['DishAmountInt'] },
  { fields: ['TableNum', 'DishName', 'DeletedWithWriteoff', 'AuthUser', 'OrderDiscount.Type', PRINT], aggs: ['DishAmountInt'] },
  { fields: ['TableNum', 'DishName', 'DeletedWithWriteoff', PRINT], aggs: ['DishAmountInt'] },
  { fields: ['TableNum', 'DishName', 'DeletedWithWriteoff', 'AuthUser', 'OrderDiscount.Type'], aggs: ['DishAmountInt'] },
  { fields: ['TableNum', 'DishName', 'DeletedWithWriteoff'], aggs: ['DishAmountInt'] },
  { fields: [], aggs: [] }
];
// Акции, которые не считаются подозрительными: блюдо подходит по маске, время открытия заказа в окне [from; to) часов, скидка в пределах min–max.
// Переопределить: PROMOS='[{"name":"Кальян","dish":"кальян","from":1,"to":15,"min":0.29,"max":0.35}]'
const PROMOS = (() => {
  try { if (process.env.PROMOS) return JSON.parse(process.env.PROMOS).map(p => ({ ...p, re: new RegExp(p.dish, 'i') })); } catch (e) { console.error('PROMOS:', e.message); }
  return [{ name: 'Кальян', re: /кальян/i, from: 1, to: 15, min: 0.29, max: 0.35 },
          { name: 'Тарификация PS-5', re: /ps-?5|кабинк/i, from: 1, to: 15, min: 0.29, max: 0.35 }];
})();
const STAFF = /стаф|staff|сотрудн/i;   // скидка для персонала никогда не считается акцией
const promoOf = (dish, time, ratio, dname) => {
  const h = +String(time).slice(11, 13);
  if (STAFF.test(dname || '')) return null;
  return PROMOS.find(p => p.re.test(dish) && h >= p.from && h < p.to && ratio >= p.min && ratio <= p.max);
};
const opKey = o => [o.time, o.order, o.type, o.dish, o.qty, o.sum, o.kd].join('|');
async function danger(q) {
  let rows, tier = 0, err;
  for (; tier < TIERS.length; tier++) {
    try { rows = await olap(q, TIERS[tier]); break; } catch (e) { err = e; if (!/^409/.test(e.message)) throw e; }
  }
  if (!rows) throw err;
  const ops = [], f = TIERS[tier].fields, hasPrint = f.includes(PRINT);
  // если время печати пустое у всех удалений, поле бесполезно — ничего не переклассифицируем
  const dels = rows.filter(r => r.DeletedWithWriteoff && r.DeletedWithWriteoff !== 'NOT_DELETED');
  const printUseful = hasPrint && dels.some(r => r[PRINT]);
  rows.forEach(r => {
    const sum = +r.DishSumInt || 0, disc = sum - (+r.DishDiscountSumInt || 0);
    const base = { time: r.OpenTime, order: r.OrderNum, table: r.TableNum || '', dish: r.DishName || '', qty: +r.DishAmountInt || 0,
      reg: r[CASH] || '', cashier: r.Cashier || '—', auth: r.AuthUser || '', dept: r.Department || '', sum, discount: disc, discountName: disc > 0 ? (r['OrderDiscount.Type'] || 'Не указано') : '', pct: sum > 0 && disc > 0 ? Math.round(disc / sum * 100) : 0, kd: disc };
    const nod = { ...base, discount: 0, discountName: '', pct: 0 };   // у удалений скидку не показываем: это не скидка, а убранная позиция
    const item = r.DeletedWithWriteoff && r.DeletedWithWriteoff !== 'NOT_DELETED';
    const st = r.Storned === true || /^true$/i.test(r.Storned);
    const pv = r[PRINT], empty = pv == null || /^\s*(|null|none|-|—|0|0001-01-01.*|1970-01-01.*)\s*$/i.test(String(pv));
    // «Удаление со списанием» всегда настоящее (блюдо уже готовили), его не прячем; «без списания» с пустой печатью = неотпечатанное
    const unprinted = item && printUseful && empty && /WITHOUT/i.test(r.DeletedWithWriteoff);
    if (unprinted) ops.push({ ...nod, type: 'Удаление', severity: 'low' });
    else if (item) ops.push({ ...nod, type: /WITHOUT/i.test(r.DeletedWithWriteoff) ? 'Удаление без списания' : 'Удаление со списанием', severity: 'high' });
    else if (r.OrderDeleted === 'DELETED') ops.push({ ...nod, type: 'Удалённый заказ', severity: 'high' });
    else if (st) ops.push({ ...nod, type: 'Сторно', severity: 'high' });
    else if (sum > 0 && disc > 0 && promoOf(base.dish, r.OpenTime, disc / sum, base.discountName)) ops.push({ ...base, type: 'Скидка по акции', severity: 'low' });   // ночная/дневная акция — не тревога
    else if (sum > 0 && disc / sum >= 0.3) ops.push({ ...base, type: 'Скидка от 30%', severity: 'mid' });
    else if (disc > 0) ops.push({ ...base, type: 'Скидка', severity: 'mid' });   // любая скидка (10, 15, 20%…) — в списке «Важные»
  });
  ops.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  ops.forEach(o => { o.id = opKey(o); });
  const lack = [];
  if (!f.includes(PRINT)) lack.push('нет времени печати блюда: неотпечатанные удаления не отличить от настоящих');
  if (!f.includes(CASH)) lack.push('нет номера кассы: фильтр по кассам недоступен');
  if (!f.includes('AuthUser')) lack.push('нет данных о том, кто подтвердил, и названия скидки');
  if (!f.includes('DishName')) lack.push('нет стола и блюда');
  const note = lack.length ? 'iiko не принял часть полей отчёта (' + lack.join('; ') + ')' : '';
  const mx = a => a.reduce((m, x) => x > m ? x : m, '');
  const dayK = {}; rows.forEach(r => { const d = String(r['OpenDate.Typed'] || '').slice(0, 10); dayK[d] = (dayK[d] || 0) + 1; });
  const dr = rows.filter(r => (+r.DishSumInt || 0) - (+r.DishDiscountSumInt || 0) > 0), discBy = {};
  dr.forEach(r => { const k = (r.AuthUser || r.Cashier || '—') + (r.AuthUser && r.Cashier && r.AuthUser !== r.Cashier ? ' (касса: ' + r.Cashier + ')' : ''); discBy[k] = (discBy[k] || 0) + 1; });
  const stats = { tier, rows: rows.length, latest: mx(rows.map(r => String(r.OpenTime || ''))), days: dayK, disc: dr.length, discLatest: mx(dr.map(r => String(r.OpenTime || ''))), discBy, from: q.get ? q.get('from') : '', to: q.get ? q.get('to') : '' };
  return { ops, note, stats, ...(q.get && q.get('debug') ? { used: f, sample: rows.filter(r => r.DeletedWithWriteoff && r.DeletedWithWriteoff !== 'NOT_DELETED').slice(0, 15) } : {}) };
}

// состав заказа: что пробили, помимо удалённого блюда
async function order(q) {
  const num = q.get('num'), d = (q.get('date') || '').slice(0, 10), dept = q.get('dept') || '', time = q.get('time') || '';
  if (!num || !/^\d{4}-\d\d-\d\d$/.test(d)) throw new Error('Нужны номер заказа и дата');
  const t0 = new Date(d + 'T12:00:00Z').getTime();
  // бизнес-дата заказа может отличаться от даты открытия (ночные заказы), поэтому берём сутки до и после
  const from = day(new Date(t0 - 864e5)), to = day(new Date(t0 + 2 * 864e5));
  const run = async (fields, useDept) => {
    const filters = {
      'OpenDate.Typed': { filterType: 'DateRange', periodType: 'CUSTOM', from: from + 'T00:00:00.000', to: to + 'T00:00:00.000', includeLow: true, includeHigh: false },
      OrderNum: { filterType: 'IncludeValues', values: [/^\d+$/.test(num) ? +num : num] },   // номер заказа в iiko — число
      OrderDeleted: { filterType: 'IncludeValues', values: ['NOT_DELETED', 'DELETED'] },
      DeletedWithWriteoff: { filterType: 'IncludeValues', values: ['NOT_DELETED', 'DELETED_WITH_WRITEOFF', 'DELETED_WITHOUT_WRITEOFF'] }
    };
    if (useDept) filters.Department = { filterType: 'IncludeValues', values: [dept] };
    const res = JSON.parse(await api('/resto/api/v2/reports/olap', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportType: 'SALES', buildSummary: false, groupByRowFields: ['OrderNum', 'OpenTime', ...fields],
        aggregateFields: ['DishAmountInt', 'DishSumInt', 'DishDiscountSumInt'], filters }) }));
    return res.data || [];
  };
  let data = [], withPrint = true, err;
  search: for (const useDept of dept ? [true, false] : [false])
    for (const f of [['DishName', 'DeletedWithWriteoff', PRINT], ['DishName', 'DeletedWithWriteoff']]) {
      try { const r = await run(f, useDept); withPrint = f.includes(PRINT); if (r.length) { data = r; break search; } }
      catch (e) { err = e; }
    }
  if (!data.length && err) throw err;
  // тот самый чек: совпадает номер, заведение и время открытия
  if (time && data.length) {
    let pick = data.filter(r => r.OpenTime === time);
    if (!pick.length) {
      const T = Date.parse(time); let best = null, bd = Infinity;
      data.forEach(r => { const x = Math.abs(Date.parse(r.OpenTime) - T); if (x < bd) { bd = x; best = r.OpenTime; } });
      if (best && bd < 36e5) pick = data.filter(r => r.OpenTime === best);
    }
    if (pick.length) data = pick;
  }
  const lines = data.map(r => {
    const sum = +r.DishSumInt || 0, del = r.DeletedWithWriteoff && r.DeletedWithWriteoff !== 'NOT_DELETED';
    const state = !del ? 'ok' : /WITHOUT/i.test(r.DeletedWithWriteoff) ? (withPrint && !r[PRINT] ? 'unp' : 'del_wo') : 'del_w';
    return { dish: r.DishName || '', qty: +r.DishAmountInt || 0, sum, disc: del ? 0 : Math.max(0, sum - (+r.DishDiscountSumInt || 0)), state };
  }).sort((a, b) => (a.state !== 'ok') - (b.state !== 'ok'));
  return { lines, total: lines.filter(l => l.state === 'ok').reduce((t, l) => t + l.sum - l.disc, 0) };
}

// ───── Telegram: бот подключается в «Настройках» по токену, подписка через /start ─────
// Переменные нужны только для первого запуска (дальше всё хранится в tg.json): TG_TOKEN, TG_CHAT, TG_SEVERITY=high,mid
// Прочее: TG_POLL_MIN=2 (как часто проверять iiko), STATE_DIR (где хранить файлы)
const DIR = process.env.STATE_DIR || __dirname;
const TG_FILE = path.join(DIR, 'tg.json'), STATE = path.join(DIR, 'tg-sent.json');
const TG_POLL = (+process.env.TG_POLL_MIN || 2) * 60e3;
let tg = { token: '', bot: null, sev: ['high', 'mid'], subs: [], offset: 0 };
try { tg = { ...tg, ...JSON.parse(fs.readFileSync(TG_FILE, 'utf8')) }; }
catch (e) {                                                           // первый запуск: берём из переменных окружения
  tg.token = process.env.TG_TOKEN || '';
  if (process.env.TG_SEVERITY) tg.sev = process.env.TG_SEVERITY.split(',');
  if (process.env.TG_CHAT) tg.subs.push({ id: String(process.env.TG_CHAT), name: 'Из TG_CHAT', username: '' });
}
const saveTg = () => { try { fs.writeFileSync(TG_FILE, JSON.stringify(tg), { mode: 0o600 }); } catch (e) { console.error('TG:', e.message); } };
let sent = null;                                                      // Set ключей уже обработанных операций
try { sent = new Set(JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch (e) {}
const save = () => { try { fs.writeFileSync(STATE, JSON.stringify([...sent].slice(-5000))); } catch (e) {} };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = x => Math.round(x).toLocaleString('ru-RU');
const ICON = { high: '🔴', mid: '🟠', low: '🟡' };
// токен наружу не отдаётся
const tgState = () => ({ connected: !!(tg.token && tg.bot), bot: tg.bot, severity: tg.sev.includes('mid') ? 'mid' : 'high', subs: tg.subs });

async function tgCall(method, payload, tok = tg.token) {
  const r = await fetch(`https://api.telegram.org/bot${tok}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { const e = new Error('TG ' + (j.error_code || r.status) + ' ' + (j.description || '')); e.code = j.error_code; throw e; }
  return j.result;
}
async function tgSend(chat, text) {
  try { await tgCall('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }); return true; }
  catch (e) {
    if (e.code === 403) { tg.subs = tg.subs.filter(s => s.id !== String(chat)); saveTg(); }   // бот заблокирован → убираем подписчика
    console.error('TG:', e.message); return false;
  }
}
const when = t => { const m = String(t).match(/(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/); return m ? `${m[3]}.${m[2]} · ${m[4]}:${m[5]}` : String(t); };
const where = o => [o.dept, o.reg && (/касс/i.test(o.reg) ? '' : 'касса ') + o.reg].filter(Boolean).join(' · ');
const LINE = '─'.repeat(14);
const card = o => [
  where(o) && `🏪 ${esc(where(o))}`,
  `🧾 Заказ №${esc(o.order)}${o.table ? ' · стол ' + esc(o.table) : ''}`,
  o.dish ? `🍽 ${esc(o.dish)}${o.qty > 1 ? ' ×' + o.qty : ''} — <b>${money(o.sum)} сум</b>` : `💰 ${money(o.sum)} сум`,
  o.discount > 0 && `🏷 <b>${esc(o.discountName || 'Скидка')}</b> · −${money(o.discount)} сум${o.pct ? ' (' + o.pct + '%)' : ''}`,
  `👤 ${esc(o.cashier)}${o.auth && o.auth !== o.cashier ? ' · подтвердил ' + esc(o.auth) : ''}`,
  `🕐 ${when(o.time)}`
].filter(Boolean).join('\n');
const fmt = o => `${ICON[o.severity] || '⚪'} <b>${esc(o.type)}</b>\n${LINE}\n${card(o)}`;
const fmtMark = (o, st) => `${st === 'ok' ? '✅ <b>Проверено</b>' : '🔎 <b>Нужно разобраться</b>'} · ${esc(o.type)}\n${LINE}\n${card(o)}`;

// Приём /start и /stop: кто нажал Start, тот получает уведомления
let tgGen = 0;
async function tgUpdates(my) {
  while (my === tgGen && tg.token) {
    try {
      const upd = await tgCall('getUpdates', { offset: tg.offset, timeout: 25, allowed_updates: ['message'] });
      if (my !== tgGen) return;
      for (const x of upd) {
        tg.offset = x.update_id + 1;
        const m = x.message; if (!m || m.chat.type !== 'private') continue;
        const id = String(m.chat.id), t = (m.text || '').trim();
        if (/^\/start/.test(t)) {
          if (!tg.subs.some(s => s.id === id)) tg.subs.push({ id, name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' '), username: m.from.username || '' });
          saveTg(); await tgSend(id, 'Готово. Сюда будут приходить опасные операции. Отписаться: /stop');
        } else if (/^\/stop/.test(t)) {
          tg.subs = tg.subs.filter(s => s.id !== id); saveTg(); await tgSend(id, 'Вы отписались. Чтобы вернуться, нажмите /start');
        }
      }
      if (upd.length) saveTg();
    } catch (e) { if (e.code === 401) { tg.bot = null; saveTg(); console.error('TG: токен больше не действует'); return; } console.error('TG:', e.message); await sleep(5000); }
  }
}
async function tgStart() {
  const my = ++tgGen;
  if (!tg.token) return;
  try {
    if (!tg.bot) { const b = await tgCall('getMe'); tg.bot = { username: b.username, name: b.first_name }; saveTg(); }
    await tgCall('deleteWebhook').catch(() => {});
    tgUpdates(my);
  } catch (e) { console.error('TG:', e.message); }
}

// ───── отметки «проверено / разобраться»: общие для всех, хранятся в marks.json ─────
const MARKS = path.join(DIR, 'marks.json');
let marks = {};
try { marks = JSON.parse(fs.readFileSync(MARKS, 'utf8')); } catch (e) {}
const saveMarks = () => {
  const k = Object.keys(marks); if (k.length > 3000) k.sort((a, b) => String(marks[a].at).localeCompare(String(marks[b].at))).slice(0, k.length - 3000).forEach(x => delete marks[x]);
  try { fs.writeFileSync(MARKS, JSON.stringify(marks)); } catch (e) { console.error('marks:', e.message); }
};
const readBody = (req, lim = 2e4) => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > lim) { req.destroy(); no(new Error('Слишком большой запрос')); } }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(e); } }); });
async function notifyMark(o, st) { if (!(tg.token && tg.bot)) return; for (const x of [...tg.subs]) { await tgSend(x.id, fmtMark(o, st)); await sleep(60); } }

let busy = false;
async function pollTg() {
  if (busy || !(tg.token && tg.bot)) return;
  busy = true;
  try {
    // окно в 2 дня назад, чтобы не потерять операции из-за часовых поясов; дубли отсекает sent
    const q = new URLSearchParams({ from: day(new Date(Date.now() - 2 * 864e5)) });
    const { ops } = await danger(q);
    const all = ops.map(o => [o, opKey(o)]).reverse();   // старые → новые
    const list = all.filter(([o]) => tg.sev.includes(o.severity));
    if (!sent) { sent = new Set(all.map(x => x[1])); save(); console.log('TG: базовая линия, пропущено ' + sent.size + ' старых операций'); return; }
    if (tg.subs.length) for (const [o, k] of list) {
      if (sent.has(k)) continue;
      const text = fmt(o); let ok = 0;
      for (const s of [...tg.subs]) { if (await tgSend(s.id, text)) ok++; await sleep(60); }
      if (!ok) throw new Error('операцию не получил ни один подписчик, повтор в следующем цикле');
      sent.add(k); save();
      await sleep(1100);                                              // лимит Telegram ~1 сообщ/сек в один чат
    }
    all.forEach(x => sent.add(x[1])); save();                         // остальное (без подписчиков или другой уровень) считаем просмотренным
  } finally { busy = false; }
}
async function tgLoop() {
  try { await pollTg(); } catch (e) { console.error('TG:', e.message); }
  setTimeout(tgLoop, TG_POLL);
}
tgStart(); tgLoop();

async function tgApi(req, res, u, send) {
  const J = (c, b) => send(c, 'application/json', JSON.stringify(b));
  try {
    let d = ''; for await (const c of req) d += c;
    const b = d ? JSON.parse(d) : {}, sub = u.pathname.slice('/api/telegram'.length);
    if (req.method === 'GET' && !sub) return J(200, tgState());
    if (req.method === 'POST' && !sub) {
      const token = String(b.token || '').trim();
      let bot; try { bot = await tgCall('getMe', {}, token); }
      catch (e) { throw new Error(e.code ? 'Токен не подошёл. Скопируйте его из @BotFather целиком.' : 'Не удалось связаться с Telegram: ' + e.message); }
      if (token !== tg.token) { tg.subs = []; tg.offset = 0; }
      tg.token = token; tg.bot = { username: bot.username, name: bot.first_name }; sent = null; saveTg();
      await tgStart(); pollTg().catch(e => console.error('TG:', e.message));   // сразу фиксируем текущие операции как старые
      return J(200, tgState());
    }
    if (req.method === 'POST' && sub === '/severity') { tg.sev = b.severity === 'mid' ? ['high', 'mid'] : ['high']; saveTg(); return J(200, tgState()); }
    if (req.method === 'POST' && sub === '/test') {
      if (!tg.subs.length) throw new Error('Нет подписчиков: сначала нажмите Start в боте.');
      for (const s of [...tg.subs]) await tgSend(s.id, '✅ Тестовое уведомление. Всё работает.');
      return J(200, tgState());
    }
    if (req.method === 'DELETE' && !sub) { tgGen++; tg = { ...tg, token: '', bot: null, subs: [], offset: 0 }; saveTg(); return J(200, tgState()); }
    if (req.method === 'DELETE' && sub.startsWith('/subs/')) {
      const id = decodeURIComponent(sub.slice(6)); tg.subs = tg.subs.filter(s => s.id !== id); saveTg(); tgSend(id, 'Вас отключили от уведомлений.');
      return J(200, tgState());
    }
    J(404, { error: 'Не найдено' });
  } catch (e) { J(400, { error: e.message }); }
}


// ───── Зарплата: ставки, премии, штрафы, авансы, выплаты — общие для всех устройств, хранятся в payroll.json ─────
// Записи не удаляются физически: «отмена» только помечает запись (del), чтобы осталась история.
const PAYF = path.join(DIR, 'payroll.json'), PAY_KINDS = ['shift', 'advance', 'bonus', 'fine', 'payout'];
// Фото и подпись получателя: для аванса и выплаты обязательны, лежат файлами в proofs/ (в payroll.json только флаг proof)
const PROOFS = path.join(DIR, 'proofs'), PROOF_KINDS = ['advance', 'payout'];
let pay = { rates: {}, entries: [] };
try { const j = JSON.parse(fs.readFileSync(PAYF, 'utf8')); pay = { rates: j.rates || {}, entries: Array.isArray(j.entries) ? j.entries : [] }; } catch (e) {}
const savePay = () => {
  try { fs.writeFileSync(PAYF + '.tmp', JSON.stringify(pay)); fs.renameSync(PAYF + '.tmp', PAYF); }
  catch (e) { console.error('payroll:', e.message); throw new Error('Не удалось сохранить на сервере: ' + e.message); }
};
async function payApi(req, u, send) {
  const J = (c, b) => send(c, 'application/json', JSON.stringify(b)), sub = u.pathname.slice('/api/payroll'.length);
  if (req.method === 'GET' && !sub) return J(200, pay);
  if (req.method !== 'POST') return J(405, { error: 'Метод не поддерживается' });
  try {
    const b = await readBody(req, sub === '/entry' ? 4e6 : 2e4), amount = Math.round(+b.amount);
    if (sub === '/rate') {
      const id = String(b.id || '').slice(0, 100);
      if (!id) throw new Error('Не указан сотрудник');
      if (!(amount >= 0 && amount <= 1e11)) throw new Error('Некорректная сумма');
      if (amount) pay.rates[id] = { type: b.type === 'hour' ? 'hour' : 'shift', amount, name: String(b.name || '').slice(0, 100) };
      else delete pay.rates[id];                                       // 0 или пусто = убрать ставку
    } else if (sub === '/entry') {
      const emp = String(b.emp || '').slice(0, 100), date = String(b.date || '');
      if (!emp) throw new Error('Не указан сотрудник');
      if (!PAY_KINDS.includes(b.kind)) throw new Error('Неизвестный тип записи');
      if (!(amount > 0 && amount <= 1e11)) throw new Error('Введите сумму больше нуля');
      if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error('Некорректная дата');
      const qty = Math.round(+b.qty * 100) / 100;                       // для доп. смены: сколько смен (можно 0,5)
      if (b.kind === 'shift' && !(qty > 0 && qty <= 100)) throw new Error('Количество смен: от 0,01 до 100');
      const eid = crypto.randomBytes(6).toString('hex');
      let proof = false;
      if (PROOF_KINDS.includes(b.kind)) {
        const P1 = 'data:image/jpeg;base64,', P2 = 'data:image/png;base64,', ph = String(b.photo || ''), sg = String(b.sig || '');
        if (!ph.startsWith(P1)) throw new Error('Нужно фото получателя');
        if (!sg.startsWith(P2)) throw new Error('Нужна подпись получателя');
        const pb = Buffer.from(ph.slice(P1.length), 'base64'), sb = Buffer.from(sg.slice(P2.length), 'base64');
        if (pb.length < 2e3 || pb.length > 1.5e6 || sb.length < 200 || sb.length > 5e5 || pb[0] !== 0xFF || pb[1] !== 0xD8 || sb[0] !== 0x89 || sb[1] !== 0x50) throw new Error('Фото или подпись некорректны');
        try { fs.mkdirSync(PROOFS, { recursive: true }); fs.writeFileSync(path.join(PROOFS, eid + '.jpg'), pb); fs.writeFileSync(path.join(PROOFS, eid + '-sig.png'), sb); }
        catch (e) { throw new Error('Не удалось сохранить фото: ' + e.message); }
        proof = true;
      }
      pay.entries.push({ id: eid, emp, name: String(b.name || '').slice(0, 100), kind: b.kind, amount, ...(b.kind === 'shift' ? { qty } : {}), date, note: String(b.note || '').slice(0, 200), at: new Date().toISOString(), ...(proof ? { proof: true } : {}) });
    } else if (sub === '/void') {
      const e = pay.entries.find(x => x.id === b.id);
      if (!e) throw new Error('Запись не найдена');
      e.del = new Date().toISOString();
    } else return J(404, { error: 'Не найдено' });
    savePay();
    return J(200, pay);
  } catch (e) { return J(400, { error: e.message }); }
}

// ───── Вход по PIN-коду ─────  (PIN: переменная APP_PIN, по умолчанию 1188)
const PIN_HASH = crypto.createHash('sha256').update(String(process.env.APP_PIN || '1188')).digest();
const SESS_FILE = path.join(__dirname, 'sessions.json');
const sha = x => crypto.createHash('sha256').update(String(x)).digest('hex');
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch (e) {}
const saveSess = () => {
  const now = Date.now(); for (const k in sessions) if (sessions[k] < now) delete sessions[k];
  try { fs.writeFileSync(SESS_FILE, JSON.stringify(sessions)); } catch (e) {}
};
saveSess();
const cookieOf = (req, name) => { for (const c of (req.headers.cookie || '').split(';')) { const i = c.indexOf('='); if (i > 0 && c.slice(0, i).trim() === name) return decodeURIComponent(c.slice(i + 1).trim()); } return ''; };
const authed = req => { const sid = cookieOf(req, 'sid'); if (!sid) return false; const h = sha(sid), e = sessions[h]; if (!e) return false; if (e < Date.now()) { delete sessions[h]; saveSess(); return false; } return true; };
const clientIp = req => (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const tries = new Map();   // ip → { n, lvl, until }  — защита от подбора: 5 ошибок → пауза 30 с, дальше 1, 2, 4… минут (до 10)
const retryIn = ip => { const t = tries.get(ip); return t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0; };
setInterval(() => { const now = Date.now(); for (const [k, v] of tries) if (v.until < now - 36e5 && v.n === 0) tries.delete(k); }, 6e5).unref();
const setCookie = (req, sid, maxAge) => 'sid=' + sid + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, data) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' }); res.end(data); };
  try {
    if (u.pathname === '/api/session') return send(200, 'application/json', JSON.stringify({ ok: authed(req), retry: retryIn(clientIp(req)) }));
    if (u.pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req), wait = retryIn(ip);
      if (wait) return send(429, 'application/json', JSON.stringify({ error: 'Слишком много попыток', retry: wait }));
      const b = await readBody(req), t = tries.get(ip) || { n: 0, lvl: 0, until: 0 };
      const good = crypto.timingSafeEqual(crypto.createHash('sha256').update(String(b.pin || '')).digest(), PIN_HASH);
      if (!good) {
        t.n++; let retry = 0, left = 5 - t.n;
        if (t.n >= 5) { retry = Math.min(600, 30 * 2 ** t.lvl); t.lvl++; t.n = 0; t.until = Date.now() + retry * 1000; left = 0; }
        tries.set(ip, t);
        return send(401, 'application/json', JSON.stringify({ error: 'Неверный PIN-код', left, retry }));
      }
      tries.delete(ip);
      const sid = crypto.randomBytes(32).toString('hex'), ttl = b.remember ? 30 * 864e2 : 12 * 36e2;
      sessions[sha(sid)] = Date.now() + ttl * 1000; saveSess();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': setCookie(req, sid, ttl) });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (u.pathname === '/api/logout') {
      const sid = cookieOf(req, 'sid'); if (sid) { delete sessions[sha(sid)]; saveSess(); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': setCookie(req, '', 0) });
      return res.end('{"ok":true}');
    }
    if (u.pathname.startsWith('/api/') && !authed(req)) return send(401, 'application/json', JSON.stringify({ error: 'auth' }));
    if (u.pathname === '/api/staff') return send(200, 'application/json', JSON.stringify(await staff(u.searchParams)));
    if (u.pathname === '/api/order') return send(200, 'application/json', JSON.stringify(await order(u.searchParams)));
    if (u.pathname === '/api/mark' && req.method === 'POST') {
      const b = await readBody(req), id = String(b.id || '').slice(0, 400), st = b.s === 'ok' || b.s === 'todo' ? b.s : '';
      if (!id) throw new Error('Нет id операции');
      if (st) marks[id] = { s: st, at: new Date().toISOString() }; else delete marks[id];
      saveMarks();
      if (st && b.op && typeof b.op === 'object') notifyMark(b.op, st).catch(e => console.error('TG:', e.message));
      return send(200, 'application/json', JSON.stringify({ marks }));
    }
    if (u.pathname === '/api/danger') return send(200, 'application/json', JSON.stringify({ ...(await danger(u.searchParams)), marks }));
    const pm = /^\/api\/payroll\/proof\/([0-9a-f]{12})\/(photo|sig)$/.exec(u.pathname);
    if (pm && req.method === 'GET') {
      const f = path.join(PROOFS, pm[1] + (pm[2] === 'photo' ? '.jpg' : '-sig.png'));
      if (!fs.existsSync(f)) return send(404, 'application/json', JSON.stringify({ error: 'Нет файла' }));
      res.writeHead(200, { 'Content-Type': pm[2] === 'photo' ? 'image/jpeg' : 'image/png', 'Cache-Control': 'private, max-age=86400' });
      return res.end(fs.readFileSync(f));
    }
    if (u.pathname.startsWith('/api/payroll')) return payApi(req, u, send);
    if (u.pathname.startsWith('/api/telegram')) return tgApi(req, res, u, send);
    send(200, 'text/html', fs.readFileSync(path.join(__dirname, 'index.html')));
  } catch (e) { send(500, 'application/json', JSON.stringify({ error: e.message })); }
}).listen(PORT, () => console.log('http://localhost:' + PORT));

const bye = async () => { try { if (token) await raw('/resto/api/logout?key=' + token); } catch (e) {} process.exit(); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);

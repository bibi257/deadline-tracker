// 未完了の締切から .ics を作る。deadline-data の build_ics.py と同じ規則（UID・通知の鳴らし方も同じ。
// 購読中のカレンダーで予定が重複しないように、ここを変えるときは build_ics.py の出力と比べること）。
//
//   - 期間つきの予定は DTSTART〜DTEND、それ以外は締切の30分間
//   - 繰り返しは RRULE。通知は毎回鳴るよう相対トリガーにする
//   - 繰り返しでない予定の通知は絶対時刻(UTC)
//   - 通知はカテゴリごとの設定（catReminders: 何日前か）に従う。未設定なら「1週間前 / 前日 / 当日」
//     N日前は締切と同じ時刻、当日は「当日リマインドの時」に鳴る
import { DAY, addDaysStr, dateStr, diffDays, fromJst, icsUtc, isObj, jstParts, parseDt } from './time.js';

const REMINDER_DEFAULT = [7, 1, 0];

/** RFC5545 のテキスト用エスケープ */
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\r\n/g, '\\n').replace(/\n/g, '\\n');

/** コードポイントの UTF-8 でのバイト数（TextEncoder を文字ごとに呼ぶと、無料プランの CPU 時間を食うため計算で出す） */
const utf8Len = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** 1行75オクテット以内に折る。日本語があるのでバイト数で判定する */
function fold(line) {
  if (line.length <= 24) return line; // 1文字は最大3バイト（UTF-16 の1単位あたり）なので、24単位までは72バイトを超えない
  const out = [];
  let cur = '';
  let n = 0;
  for (const ch of line) {
    const b = utf8Len(ch.codePointAt(0));
    if (n + b > 72) {
      out.push(cur);
      cur = '';
      n = 0;
    }
    cur += ch;
    n += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const alarmAbs = (trigger, label) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(label)}`,
  `TRIGGER;VALUE=DATE-TIME:${icsUtc(trigger)}`, 'END:VALARM'];

const alarmRel = (minutesBefore, label, relatedEnd) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(label)}`,
  `TRIGGER${relatedEnd ? ';RELATED=END' : ''}:-PT${minutesBefore}M`, 'END:VALARM'];

/** data の catReminders を検証する（アプリの cleanCatReminders と同じ規則） */
export function cleanReminders(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const [k, arr] of Object.entries(v)) {
    if (!Array.isArray(arr)) continue;
    const ok = [...new Set(arr.filter((n) => Number.isInteger(n) && n >= 0 && n <= 60))].sort((a, b) => b - a);
    out[k] = ok;
  }
  return out;
}

function reminderLabel(n) {
  if (n === 0) return '今日が締切';
  if (n === 1) return '明日が締切';
  if (n % 7 === 0) return `あと${n / 7}週間`;
  return `あと${n}日`;
}

/**
 * 毎月・毎年で基準日が29〜31日のとき、無い月は月末に丸める（アプリと同じ）ための RRULE の追加分。
 * 素の FREQ=MONTHLY は31日が無い月を飛ばしてしまうため、「基準日」と「月末」のうち早い方（BYSETPOS=1）を指定する。
 * DTSTART は時刻つきなら UTC、終日なら日付で書くため、締切日(JST)との日数差 diff を引いて合わせる。
 */
function monthEndRule(it, rep, due, start, begin, allDay) {
  if (rep !== 'monthly' && rep !== 'yearly') return '';
  const dueJ = jstParts(due);
  const anchor = Number.isInteger(it.repDay) ? it.repDay : dueJ.d;
  if (anchor < 29) return '';
  const first = allDay ? dateStr(start ?? due) : new Date(begin).toISOString().slice(0, 10);
  const diff = diffDays(dateStr(due), first);
  const firstMonth = Number(first.slice(5, 7));
  if (diff < 0 || anchor - diff < 1 || firstMonth !== dueJ.mo) return ''; // 月をまたぐ期間つきなどは表せないので、従来どおりにする
  let rule = `;BYMONTHDAY=${anchor - diff},${-(1 + diff)};BYSETPOS=1`;
  if (rep === 'yearly') rule = `;BYMONTH=${firstMonth}${rule}`;
  return rule;
}

const ymd = (date) => date.replaceAll('-', '');

/** 取りやめた回のキー（"YYYY-MM-DD"）から、その日（JST）の暦を作る。実在しない日付は null */
function skipDate(k) {
  if (typeof k !== 'string') return null;
  const parts = k.split('-');
  if (parts.length !== 3 || !parts.every((x) => /^\s*\d+\s*$/.test(x))) return null;
  const [y, m, d] = parts.map((x) => parseInt(x, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return { y, m, d };
}

function vevent(it, dayHour, reminders, { now, noMemo }) {
  const due = parseDt(it.due);
  const start = it.start ? parseDt(it.start) : null;
  const allDay = !!it.allDay;
  // 期間つきは開始〜締切。無い場合は締切の30分前から締切まで
  // （締切時刻を予定の「終了」に置き、日をまたいで見えるのを防ぐ）
  const begin = start ?? due - 30 * 60 * 1000;
  const end = due;

  const lines = ['BEGIN:VEVENT', `UID:${it.id ?? 'x'}@deadline-tracker`, `DTSTAMP:${icsUtc(now)}`,
    `SEQUENCE:${Number.isFinite(it.seq) ? Math.trunc(it.seq) : 0}`];
  const dueDate = dateStr(due);
  if (allDay) {
    // 終日予定。DTENDは翌日を指す決まりなので1日足す
    lines.push(`DTSTART;VALUE=DATE:${ymd(dateStr(start ?? due))}`);
    lines.push(`DTEND;VALUE=DATE:${ymd(dateStr(due + DAY))}`);
  } else {
    lines.push(`DTSTART:${icsUtc(begin)}`);
    lines.push(`DTEND:${icsUtc(end)}`);
  }
  lines.push(`SUMMARY:${esc(it.title ?? '')}`);
  lines.push(`CATEGORIES:${esc(it.cat || 'その他')}`);
  // noMemo のときはメモを書き出さない（購読URLなど、外に置く用途向け）
  if (it.memo && !noMemo) lines.push(`DESCRIPTION:${esc(it.memo)}`);

  const rep = it.rep || 'none';
  const repeating = rep !== 'none';
  const dueJ = jstParts(due);
  if (repeating) {
    let freq = { weekly: 'FREQ=WEEKLY', biweekly: 'FREQ=WEEKLY;INTERVAL=2', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY' }[rep];
    if (freq) {
      const count = it.repCount || 0;
      freq += monthEndRule(it, rep, due, start, begin, allDay);
      lines.push(`RRULE:${freq}${Number.isInteger(count) && count > 0 ? `;COUNT=${count}` : ''}`);
    }
    // 取りやめた回は EXDATE で除外する。skip のキーは各回の「締切日(JST)」だが、
    // EXDATE は各回の DTSTART と一致させる必要があるため、開始までの差だけずらす
    for (const k of Array.isArray(it.skip) ? it.skip : []) {
      const s = skipDate(k);
      if (!s) continue; // 壊れたキー（文字列でない・日付でない）は無視する
      const exDue = fromJst(s.y, s.m, s.d, dueJ.h, dueJ.mi, dueJ.s, dueJ.ms);
      if (allDay) {
        // 取りやめた回の「締切日」から、開始日までの差だけ戻した日付
        const back = diffDays(dueDate, dateStr(start ?? due));
        const day = addDaysStr(`${String(s.y).padStart(4, '0')}-${String(s.m).padStart(2, '0')}-${String(s.d).padStart(2, '0')}`, -back);
        lines.push(`EXDATE;VALUE=DATE:${ymd(day)}`);
      } else {
        lines.push(`EXDATE:${icsUtc(exDue - (end - begin))}`);
      }
    }
  }

  const title = it.title ?? '';
  const days = Object.hasOwn(reminders, it.cat || 'その他') ? reminders[it.cat || 'その他'] : REMINDER_DEFAULT;
  if (repeating) {
    // 締切＝予定の終了なので、通知はすべて終了基準に揃える。
    // 終日予定の終了(DTEND)は翌日0時なので、締切(23:59など)との差を足して、繰り返しでない予定と同じ時刻に鳴るようにする
    let gap = 0;
    if (allDay) {
      const endJst = fromJst(dueJ.y, dueJ.mo, dueJ.d + 1);
      gap = Math.floor((endJst - due) / 60000);
    }
    for (const n of days) {
      if (n > 0) {
        lines.push(...alarmRel(n * 24 * 60 + gap, `${title}：${reminderLabel(n)}`, true));
        continue;
      }
      const mins = (dueJ.h - dayHour) * 60 + dueJ.mi;
      if (mins > 0) lines.push(...alarmRel(mins + gap, `${title}：${reminderLabel(0)}`, true));
    }
  } else {
    for (const n of days) {
      if (n > 0) {
        lines.push(...alarmAbs(due - n * DAY, `${title}：${reminderLabel(n)}`));
        continue;
      }
      const dayOf = fromJst(dueJ.y, dueJ.mo, dueJ.d, dayHour, 0, 0, 0);
      if (dayOf < due) lines.push(...alarmAbs(dayOf, `${title}：${reminderLabel(0)}`));
    }
  }
  lines.push('END:VEVENT');
  return lines;
}

/**
 * data から .ics の本文を作る。now はミリ秒。書き出すものが無ければ null。
 * 読めない締切は除き、その旨を warnings に入れて返す。
 */
export function buildIcs(data, { now, dayHour = 9, noMemo = false }) {
  const items = [];
  const warnings = [];
  for (let i of Array.isArray(data.items) ? data.items : []) {
    if (!isObj(i) || i.done) continue;
    if (Number.isNaN(parseDt(i.due))) {
      warnings.push(`締切日時が読めないため除外: ${i.title ?? i.id}`);
      continue;
    }
    if (i.start && Number.isNaN(parseDt(i.start))) {
      // 開始だけが壊れているときは、開始なし（締切だけの予定）として書き出す
      warnings.push(`開始日時が読めないため締切のみで出力: ${i.title ?? i.id}`);
      i = { ...i };
      delete i.start;
    }
    items.push(i);
  }
  if (!items.length) return { ics: null, warnings };

  // アプリと同じ並び順（期間つきは開始日、同じなら締切の早い順）
  items.sort((a, b) => (parseDt(a.start || a.due) - parseDt(b.start || b.due)) || (parseDt(a.due) - parseDt(b.due)));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//deadline-tracker//JP', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  const reminders = cleanReminders(data.catReminders);
  for (const it of items) lines.push(...vevent(it, dayHour, reminders, { now, noMemo }));
  lines.push('END:VCALENDAR');
  return { ics: `${lines.map(fold).join('\r\n')}\r\n`, warnings };
}


// 締切トラッカー：iPhone のホーム画面ウィジェット（Scriptable 用）
// iPhone が購読しているカレンダー「締切トラッカー」を端末内で読んで、締切を日付・曜日つきで並べる。
// 通信・鍵・購読 URL は使わない。アプリの URL は、ウィジェットの Parameter に入れる（タップで開く）。

const CAL_NAME = '締切トラッカー';
const DAY = 86400000;
// 表示する件数の上限。超えた分は最後の行に「ほかN件」
const COUNT = { small: 5, medium: 6, large: 16 };
const WD = ['日', '月', '火', '水', '木', '金', '土'];

// 色は「色だけに頼らない」ため、文字（超過／今日）も必ず出す
const COLOR = {
  over: new Color('#d83a3a'),
  today: new Color('#e07a10'),
  soon: new Color('#2f7d5b'),
  normal: new Color('#3a3a3a'),
  sub: new Color('#8a8a8a'),
  bg: new Color('#fbf7ee'),
};

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** 締切の日時。予定の終了が締切。終日は終了が翌日 0:00 なので、前日を締切日にする */
function dueOf(ev) {
  const end = ev.endDate;
  return ev.isAllDay ? new Date(end.getTime() - DAY) : end;
}

/**
 * 締切日を曜日つきで書く（0 埋めしない）。
 * 中・大は「M/D(曜)」（例: 11/22(日)）、小は「D(曜)」（例: 28(土)）
 */
function fmtDate(due, family) {
  const wd = WD[due.getDay()];
  if (family === 'small') return `${due.getDate()}(${wd})`;
  return `${due.getMonth() + 1}/${due.getDate()}(${wd})`;
}

/**
 * 残り日数（暦日の差）と締切日から、表示の文字と色を決める。
 * 2〜6日は曜日（例: 水曜）、7日以上は曜日つきの日付。7日目は今日と同じ曜日になるため日付にする。
 */
function label(days, due, family) {
  const wd = `${WD[due.getDay()]}曜`;
  if (days < 0) return { text: `超過${-days}日`, color: COLOR.over };
  if (days === 0) return { text: '今日', color: COLOR.today };
  if (days === 1) return { text: '明日', color: COLOR.soon };
  if (days <= 3) return { text: wd, color: COLOR.soon };
  if (days <= 6) return { text: wd, color: COLOR.normal };
  return { text: fmtDate(due, family), color: COLOR.normal };
}

async function load(now) {
  // iOS は購読カレンダーの名前を、.ics の名前でなく購読 URL にすることがある。URL の形（/ics/ を含む）でも探す
  const cals = await Calendar.forEvents();
  const cal = cals.find((c) => c.title === CAL_NAME) || cals.find((c) => /\/ics\/[^/]+\.ics$/.test(c.title));
  if (!cal) return null;
  // 締切を過ぎた未完了の締切も購読に残るので、30日前から読む
  const events = await CalendarEvent.between(new Date(now.getTime() - 30 * DAY), new Date(now.getTime() + 14 * DAY), [cal]);
  return events
    .map((ev) => ({ title: ev.title, due: dueOf(ev), allDay: ev.isAllDay }))
    .sort((a, b) => a.due - b.due);
}

function message(text) {
  const w = new ListWidget();
  w.backgroundColor = COLOR.bg;
  const t = w.addText(text);
  t.font = Font.systemFont(13);
  t.textColor = COLOR.sub;
  return w;
}

async function build() {
  const now = new Date();
  let items;
  try {
    items = await load(now);
  } catch (e) {
    return message('カレンダーを読めませんでした。Scriptable にカレンダーへのアクセスを許可してください');
  }
  if (!items) return message(`カレンダー『${CAL_NAME}』を購読してください`);

  const family = config.widgetFamily || 'medium';
  const max = COUNT[family] || COUNT.medium;
  const small = family === 'small';
  const labelFont = small ? 11 : 12;
  const labelWidth = small ? 46 : 60;
  const titleFont = small ? 11 : 12;

  const w = new ListWidget();
  w.backgroundColor = COLOR.bg;
  w.setPadding(8, 12, 8, 12);

  const head = w.addText(`締切  ${items.length}件`);
  head.font = Font.boldSystemFont(11);
  head.textColor = COLOR.sub;
  w.addSpacer(3);

  if (!items.length) {
    const t = w.addText('未完了の締切はありません');
    t.font = Font.systemFont(13);
    t.textColor = COLOR.sub;
  }
  const today = startOfDay(now);
  const dayOf = (it) => Math.round((startOfDay(it.due) - today) / DAY);

  let prevText = null;
  const shown = items.slice(0, max);
  for (let i = 0; i < shown.length; i++) {
    const it = shown[i];
    const l = label(dayOf(it), it.due, family);
    if (i > 0) w.addSpacer(2);
    const row = w.addStack();
    row.centerAlignContent();

    // 日付の欄は幅を固定して、タイトルの位置をそろえる。同じ日の二行目は文字を出さず、欄だけ空ける
    const cell = row.addStack();
    cell.size = new Size(labelWidth, 0);
    if (l.text !== prevText) {
      const d = cell.addText(l.text);
      d.font = Font.boldSystemFont(labelFont);
      d.textColor = l.color;
      d.lineLimit = 1;
      d.minimumScaleFactor = 0.8;
    }
    prevText = l.text;

    row.addSpacer(6);
    const t = row.addText(it.title || '(無題)');
    t.font = Font.systemFont(titleFont);
    t.textColor = COLOR.normal;
    t.lineLimit = 1;
  }

  // 件数の上限を超えたら、最後に残りの件数と締切日の範囲を出す（隠れた中に超過があれば先頭に「超過含む」）
  const hidden = items.slice(max);
  if (hidden.length) {
    const n = hidden.length;
    const first = fmtDate(hidden[0].due, family);
    const last = fmtDate(hidden[n - 1].due, family);
    const anyOver = hidden.some((it) => dayOf(it) < 0);
    let text;
    if (small) text = `ほか${n}件`;
    else if (first === last) text = `ほか${n}件 · ${first}`;
    else text = `ほか${n}件 · ${first}〜${last}`;
    if (anyOver) text = `超過含む ${text}`;
    w.addSpacer(2);
    const o = w.addText(text);
    o.font = Font.systemFont(10);
    o.textColor = anyOver ? COLOR.over : COLOR.sub;
    o.lineLimit = 1;
  }
  w.addSpacer();

  // 次の締切の時刻か 30 分後の早いほうに更新（実際の更新は iOS が決める）
  const next = items.map((i) => i.due.getTime()).find((t) => t > now.getTime());
  const soon = now.getTime() + 30 * 60000;
  w.refreshAfterDate = new Date(next ? Math.min(next, soon) : soon);

  // タップで開く先はスクリプトに書かず、Parameter で渡す。空なら何も開かない
  const url = (args.widgetParameter || '').trim();
  if (/^https?:\/\//.test(url)) w.url = url;
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();

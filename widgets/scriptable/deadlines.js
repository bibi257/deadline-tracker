// 締切トラッカー：iPhone のホーム画面ウィジェット（Scriptable 用）
// iPhone が購読しているカレンダー「締切トラッカー」を端末内で読んで、残り日数つきで並べる。
// 通信・鍵・購読 URL は使わない。アプリの URL は、ウィジェットの Parameter に入れる（タップで開く）。

const CAL_NAME = '締切トラッカー';
const DAY = 86400000;
const COUNT = { small: 3, medium: 4, large: 10 };

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

/** 残り日数（暦日の差）から表示を決める */
function label(days) {
  if (days < 0) return { text: `超過${-days}日`, color: COLOR.over };
  if (days === 0) return { text: '今日', color: COLOR.today };
  if (days === 1) return { text: '明日', color: COLOR.soon };
  return { text: `あと${days}日`, color: days <= 3 ? COLOR.soon : COLOR.normal };
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
  const w = new ListWidget();
  w.backgroundColor = COLOR.bg;
  w.setPadding(10, 12, 10, 12);

  const head = w.addText(`締切  ${items.length}件`);
  head.font = Font.boldSystemFont(11);
  head.textColor = COLOR.sub;
  w.addSpacer(4);

  if (!items.length) {
    const t = w.addText('未完了の締切はありません');
    t.font = Font.systemFont(13);
    t.textColor = COLOR.sub;
  }
  const today = startOfDay(now);
  for (const it of items.slice(0, max)) {
    const days = Math.round((startOfDay(it.due) - today) / DAY);
    const l = label(days);
    const row = w.addStack();
    row.centerAlignContent();
    const d = row.addText(l.text);
    d.font = Font.boldSystemFont(12);
    d.textColor = l.color;
    d.lineLimit = 1;
    row.addSpacer(8);
    const t = row.addText(it.title || '(無題)');
    t.font = Font.systemFont(12);
    t.textColor = COLOR.normal;
    t.lineLimit = 1;
    w.addSpacer(3);
  }

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

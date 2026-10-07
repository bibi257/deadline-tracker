#!/usr/bin/env python3
"""data.json から未完了の締切をまとめた .ics を作る。

アプリ(index.html)の書き出しと同じ仕様に合わせてある:
  - 期間つきの予定は DTSTART〜DTEND、それ以外は締切の30分間
  - 繰り返しは RRULE。通知は毎回鳴るよう相対トリガーにする
  - 繰り返しでない予定の通知は絶対時刻(UTC)
  - 通知はカテゴリごとの設定(catReminders: 何日前か)に従う。未設定なら「1週間前 / 前日 / 当日」
    N日前は締切と同じ時刻、当日は「当日リマインドの時」に鳴る
使い方: python3 build_ics.py <data.json> <出力先.ics> [当日リマインドの時]
"""
import json
import sys
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))


def parse_dt(s):
    """ISO8601(末尾Z / ミリ秒つきも可)を datetime に変換する。"""
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def esc(s):
    """RFC5545 のテキスト用エスケープ。"""
    return (str(s).replace("\\", "\\\\").replace(";", "\\;")
            .replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n"))


def utc(dt):
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def fold(line):
    """1行75オクテット以内に折る。日本語があるのでバイト数で判定する。"""
    out, cur, n = [], "", 0
    for ch in line:
        b = len(ch.encode("utf-8"))
        if n + b > 72:
            out.append(cur)
            cur, n = "", 0
        cur += ch
        n += b
    out.append(cur)
    return "\r\n ".join(out)


def alarm_abs(trigger, label):
    return ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(label),
            "TRIGGER;VALUE=DATE-TIME:" + utc(trigger), "END:VALARM"]


def alarm_rel(minutes_before, label, related_end):
    rel = ";RELATED=END" if related_end else ""
    return ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(label),
            "TRIGGER%s:-PT%dM" % (rel, minutes_before), "END:VALARM"]


REMINDER_DEFAULT = [7, 1, 0]


def clean_reminders(v):
    """data.json の catReminders を検証する（アプリの cleanCatReminders と同じ規則）。"""
    out = {}
    if not isinstance(v, dict):
        return out
    for k, arr in v.items():
        if not isinstance(arr, list):
            continue
        ok = sorted({n for n in arr
                     if isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= 60},
                    reverse=True)
        out[k] = ok
    return out


def reminder_label(n):
    if n == 0:
        return "今日が締切"
    if n == 1:
        return "明日が締切"
    if n % 7 == 0:
        return "あと%d週間" % (n // 7)
    return "あと%d日" % n


def month_end_rule(it, rep, due, start, begin, all_day):
    """毎月・毎年で基準日が29〜31日のとき、無い月は月末に丸める（アプリと同じ）ための RRULE の追加分。
    RFC 5545 の素の FREQ=MONTHLY は31日が無い月を飛ばしてしまうため、
    「基準日」と「月末」のうち早い方（BYSETPOS=1）を指定する。
    DTSTART は時刻つきなら UTC、終日なら日付で書くので、締切日(JST)との日数差 diff を引いて合わせる。"""
    if rep not in ("monthly", "yearly"):
        return ""
    due_jst = due.astimezone(JST)
    anchor = it.get("repDay") if isinstance(it.get("repDay"), int) else due_jst.day
    if anchor < 29:
        return ""
    first = (start or due).astimezone(JST).date() if all_day else begin.astimezone(timezone.utc).date()
    diff = (due_jst.date() - first).days
    if diff < 0 or anchor - diff < 1 or first.month != due_jst.month:
        return ""  # 月をまたぐ期間つきなどは表せないので、従来どおりにする
    rule = ";BYMONTHDAY=%d,%d;BYSETPOS=1" % (anchor - diff, -(1 + diff))
    if rep == "yearly":
        rule = ";BYMONTH=%d" % first.month + rule
    return rule


def vevent(it, day_hour, reminders=None):
    due = parse_dt(it["due"])
    start = parse_dt(it["start"]) if it.get("start") else None
    all_day = bool(it.get("allDay"))
    # 期間つきは開始〜締切。無い場合は締切の30分前から締切まで
    # （締切時刻を予定の「終了」に置き、日をまたいで見えるのを防ぐ）
    begin = start or (due - timedelta(minutes=30))
    end = due

    lines = ["BEGIN:VEVENT",
             "UID:%s@deadline-tracker" % it.get("id", "x"),
             "DTSTAMP:" + utc(datetime.now(timezone.utc)),
             "SEQUENCE:%d" % it.get("seq", 0)]
    if all_day:
        # 終日予定。DTENDは翌日を指す決まりなので1日足す
        s = (start or due).astimezone(JST)
        e = due.astimezone(JST) + timedelta(days=1)
        lines.append("DTSTART;VALUE=DATE:" + s.strftime("%Y%m%d"))
        lines.append("DTEND;VALUE=DATE:" + e.strftime("%Y%m%d"))
    else:
        lines.append("DTSTART:" + utc(begin))
        lines.append("DTEND:" + utc(end))
    lines.append("SUMMARY:" + esc(it.get("title", "")))
    lines.append("CATEGORIES:" + esc(it.get("cat") or "その他"))
    if it.get("memo"):
        lines.append("DESCRIPTION:" + esc(it["memo"]))

    rep = it.get("rep") or "none"
    repeating = rep != "none"
    if repeating:
        freq = {"weekly": "FREQ=WEEKLY",
                "biweekly": "FREQ=WEEKLY;INTERVAL=2",
                "monthly": "FREQ=MONTHLY",
                "yearly": "FREQ=YEARLY"}.get(rep)
        if freq:
            count = it.get("repCount") or 0
            freq += month_end_rule(it, rep, due, start, begin, all_day)
            lines.append("RRULE:" + freq + (";COUNT=%d" % count if isinstance(count, int) and count > 0 else ""))
        # 取りやめた回は EXDATE で除外する。skip のキーは各回の「締切日(JST)」だが、
        # EXDATE は各回の DTSTART と一致させる必要があるため、開始までの差だけずらす
        due_jst = due.astimezone(JST)
        skip = it.get("skip")
        for k in (skip if isinstance(skip, list) else []):
            try:
                y, m, d = (int(x) for x in k.split("-"))
                ex_due = due_jst.replace(year=y, month=m, day=d)
            except (ValueError, AttributeError):
                continue  # 壊れたキー（文字列でない・日付でない）は無視する
            if all_day:
                s_day = (start or due).astimezone(JST).date()
                ex = ex_due.date() - (due_jst.date() - s_day)
                lines.append("EXDATE;VALUE=DATE:" + ex.strftime("%Y%m%d"))
            else:
                lines.append("EXDATE:" + utc(ex_due - (end - begin)))

    title = it.get("title", "")
    days = (reminders or {}).get(it.get("cat") or "その他", REMINDER_DEFAULT)
    if repeating:
        # 締切＝予定の終了なので、通知はすべて終了基準に揃える。
        # 終日予定の終了(DTEND)は翌日0時なので、締切(23:59など)との差を足して
        # 繰り返しでない予定と同じ時刻に鳴るようにする
        due_jst = due.astimezone(JST)
        if all_day:
            end_jst = datetime.combine(due_jst.date() + timedelta(days=1),
                                       datetime.min.time(), JST)
            gap = int((end_jst - due_jst).total_seconds() // 60)
        else:
            gap = 0
        for n in days:
            if n > 0:
                lines += alarm_rel(n * 24 * 60 + gap, title + "：" + reminder_label(n), True)
                continue
            mins = (due_jst.hour - day_hour) * 60 + due_jst.minute
            if mins > 0:
                lines += alarm_rel(mins + gap, title + "：" + reminder_label(0), True)
    else:
        due_jst = due.astimezone(JST)
        for n in days:
            if n > 0:
                lines += alarm_abs(due - timedelta(days=n), title + "：" + reminder_label(n))
                continue
            day_of = due_jst.replace(hour=day_hour, minute=0, second=0, microsecond=0)
            if day_of < due_jst:
                lines += alarm_abs(day_of, title + "：" + reminder_label(0))

    lines.append("END:VEVENT")
    return lines


def main():
    data_path, out_path = sys.argv[1], sys.argv[2]
    day_hour = int(sys.argv[3]) if len(sys.argv) > 3 else 9

    with open(data_path, encoding="utf-8") as f:
        data = json.load(f)

    items = []
    for i in data.get("items", []):
        if i.get("done"):
            continue
        try:
            parse_dt(i["due"])
        except (KeyError, TypeError, ValueError, AttributeError):
            print("締切日時が読めないため除外: %s" % i.get("title", i.get("id")), file=sys.stderr)
            continue
        if i.get("start"):
            try:
                parse_dt(i["start"])
            except (TypeError, ValueError, AttributeError):
                # 開始だけが壊れているときは、開始なし（締切だけの予定）として書き出す
                print("開始日時が読めないため締切のみで出力: %s" % i.get("title", i.get("id")), file=sys.stderr)
                i = dict(i)
                del i["start"]
        items.append(i)
    if not items:
        return 2  # 書き出すものが無い（エラー時の1と区別する）

    # アプリと同じ並び順（期間つきは開始日、同じなら締切の早い順）
    items.sort(key=lambda i: (parse_dt(i.get("start") or i["due"]), parse_dt(i["due"])))

    lines = ["BEGIN:VCALENDAR", "VERSION:2.0",
             "PRODID:-//deadline-tracker//JP", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH"]
    reminders = clean_reminders(data.get("catReminders"))
    for it in items:
        lines += vevent(it, day_hour, reminders)
    lines.append("END:VCALENDAR")

    with open(out_path, "w", encoding="utf-8", newline="") as f:
        f.write("\r\n".join(fold(l) for l in lines) + "\r\n")
    print(len(items))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""feed.json の内容を、モーニングブリーフが Gmail から読めるよう自分宛てにメールで送る。

件名は「【締切トラッカー】M/D（曜）の締切」で固定し、ブリーフはこの件名で検索する。
対象日は実行時刻(JST)で決める：15時以降なら翌日分、それより前なら当日分。
（GitHub Actions の定期実行は数時間遅れることがあるため、前日の夜にも送っておく）

環境変数:
  GMAIL_ADDRESS       送信元＝宛先の Gmail アドレス（Secret）
  GMAIL_APP_PASSWORD  Google アカウントのアプリパスワード（Secret）
  TARGET              today / tomorrow / auto（既定 auto）
  DRY_RUN=1           送らずに本文を表示する
使い方: python3 send_feed_mail.py <feed.json>
"""
import json
import os
import re
import smtplib
import sys
from datetime import date, datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.utils import formatdate, make_msgid

JST = timezone(timedelta(hours=9))
DOW = "月火水木金土日"
SUBJECT_PREFIX = "【締切トラッカー】"


def jp(d):
    return "%d/%d（%s）" % (d.month, d.day, DOW[d.weekday()])


def line(e, today=None):
    due = date.fromisoformat(e["due_date"])
    when = jp(due) + (" " + e["due_time"] if e.get("due_time") else " 終日")
    if e.get("start_date"):
        st = date.fromisoformat(e["start_date"])
        when = jp(st) + (" " + e["start_time"] if e.get("start_time") else "") + " 〜 " + when
    mark = "🔁 " if e.get("recurring") else ""
    extra = ""
    if today and due < today:
        extra = "（%d日超過）" % (today - due).days
    elif today and due > today:
        extra = "（あと%d日）" % (due - today).days
    s = "- %s%s ［%s］ %s%s" % (mark, e["title"], e.get("category", ""), when, extra)
    if e.get("repeat"):
        s += " ／" + e["repeat"]
    if e.get("memo"):
        s += "\n    メモ: " + e["memo"].replace("\n", " ")
    return s


# おすすめの順番で使うカテゴリの重み（無いカテゴリは0）
CAT_WEIGHT = {"考査": 15, "課題": 10, "サブスクなど": -20}
TOP_N = 5


def score(e, target):
    due = date.fromisoformat(e["due_date"])
    d = (due - target).days
    if d < 0:
        s, why = 100 + min(-d * 5, 50), "%d日超過" % -d
    elif d == 0:
        s, why = 80, "今日が締切"
        if e.get("due_time"):
            h = int(e["due_time"][:2])
            s += max(0, 10 - max(0, h - 8))   # 午前の締切ほど先に
            why += "（%s）" % e["due_time"]
    elif d <= 3:
        s, why = 60 - d * 10, "あと%d日" % d
    elif d <= 7:
        s, why = 20 - d, "あと%d日" % d
    else:
        return None
    if e.get("recurring"):
        s -= 10
    w = CAT_WEIGHT.get(e.get("category", ""), 0)
    if w:
        s += w
        why += "・%sを優先" % e["category"] if w > 0 else ""
    return s, why


def priority_section(items, target):
    rows = []
    for e in items:
        r = score(e, target)
        if r:
            rows.append((r[0], r[1], e))
    rows.sort(key=lambda x: (-x[0], x[2]["due_date"], x[2]["title"]))
    out = ["■ おすすめの順番（上位%d件）" % TOP_N]
    if not rows:
        out.append("- 急ぎのものはありません")
    for i, (_, why, e) in enumerate(rows[:TOP_N], 1):
        out.append("%d. %s ［%s］ … %s" % (i, e["title"], e.get("category", ""), why))
    out.append("")
    return out


def build_body(feed, target):
    items = feed.get("items", [])
    over = [e for e in items if date.fromisoformat(e["due_date"]) < target]
    today = [e for e in items if date.fromisoformat(e["due_date"]) == target]
    during = [e for e in items if e.get("start_date")
              and date.fromisoformat(e["start_date"]) <= target < date.fromisoformat(e["due_date"])]
    soon = [e for e in items if target < date.fromisoformat(e["due_date"]) <= target + timedelta(days=7)
            and e not in during]

    out = ["%sの締切（締切トラッカーより自動送信）" % jp(target), ""]
    out.extend(priority_section(items, target))

    def section(title, rows, empty):
        out.append("■ %s（%d件）" % (title, len(rows)))
        out.extend(line(e, target) for e in rows) if rows else out.append("- " + empty)
        out.append("")

    section("今日が締切", today, "なし")
    section("期限切れ", over, "なし")
    section("期間中", during, "なし")
    section("今後7日間の締切", soon, "なし")
    out.append("-- ")
    out.append("この日付: %s ／ データ更新: %s" % (target.isoformat(), feed.get("source_updated_at") or "不明"))
    out.append("このメールは deadline-data の GitHub Actions が自動で送っています。返信不要です。")
    return "\n".join(out)


def _starttls():
    s = smtplib.SMTP("smtp.gmail.com", 587, timeout=30)
    try:
        s.starttls()
    except BaseException:
        s.close()
        raise
    return s


def _ssl():
    return smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30)


def _text(v):
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        feed = json.load(f)

    now = datetime.now(JST)
    mode = os.environ.get("TARGET", "auto")
    if mode == "tomorrow" or (mode == "auto" and now.hour >= 15):
        target = now.date() + timedelta(days=1)
    else:
        target = now.date()

    subject = "%s%sの締切" % (SUBJECT_PREFIX, jp(target))
    body = build_body(feed, target)

    if os.environ.get("DRY_RUN") == "1":
        print("件名:", subject)
        print(body)
        return 0

    # コピー時に混ざりやすい空白(全角・改行・ゼロ幅を含む)や引用符を取り除く
    addr = re.sub(r"[\s\u200b\ufeff\"']", "", os.environ.get("GMAIL_ADDRESS", ""))
    pw = re.sub(r"[\s\u200b\ufeff\"']", "", os.environ.get("GMAIL_APP_PASSWORD", ""))
    if not addr or not pw:
        print("GMAIL_ADDRESS / GMAIL_APP_PASSWORD の Secret が未設定のため、メールは送りません。", file=sys.stderr)
        return 0  # 未設定でもワークフロー全体は失敗扱いにしない

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = addr
    msg["To"] = addr
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain="deadline-tracker")
    # Secret の中身は一部でもログに出さない。形が合っているかだけ伝える
    if not re.fullmatch(r"[^@]+@[^@]+\.[^@]+", addr):
        print("GMAIL_ADDRESS がメールアドレスの形ではありません。", file=sys.stderr)
        return 1
    if not re.fullmatch(r"[A-Za-z]{16}", pw):
        print("GMAIL_APP_PASSWORD がアプリパスワード（英字16文字）の形ではありません。通常のログインパスワードでは送れません。", file=sys.stderr)

    # 587(STARTTLS) で失敗したら 465(SSL) でもう一度試す。
    # ただし送信が済んだ後の切断（QUIT の失敗など）では再送しない（二重送信を防ぐ）
    last = None
    for name, factory in (("587/STARTTLS", _starttls), ("465/SSL", _ssl)):
        sent = False
        try:
            s = factory()
            try:
                s.login(addr, pw)
                s.send_message(msg)
                sent = True
                s.quit()
            finally:
                s.close()
            last = None
            break
        except smtplib.SMTPAuthenticationError as e:
            print("認証に失敗しました（%s）: %s %s" % (name, e.smtp_code, _text(e.smtp_error)[:120]), file=sys.stderr)
            print("→ アプリパスワードが正しいか、2段階認証が有効か、アドレスがそのアカウントのものか確認してください。", file=sys.stderr)
            return 1
        except (smtplib.SMTPException, OSError) as e:
            if sent:
                print("送信後の切断でエラーが出ました（%s）。送信自体は済んでいます: %s" % (name, type(e).__name__), file=sys.stderr)
                last = None
                break
            print("送信に失敗しました（%s）: %s: %s" % (name, type(e).__name__, e), file=sys.stderr)
            last = e
    if last is not None:
        return 1
    print("送信しました:", subject)
    return 0


if __name__ == "__main__":
    sys.exit(main())

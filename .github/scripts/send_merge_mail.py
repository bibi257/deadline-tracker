#!/usr/bin/env python3
"""マージした PR の変更点を、自分宛てに Gmail で送る（.github/workflows/merge-mail.yml から呼ぶ）。

本文：PR のタイトル・URL・マージした日時と人・説明・コミット・変更したファイル（追加/変更/削除と行数）。
deadline-data と deadline-tracker で同じファイルを使う（片方を直したら、もう片方にも写す）。

環境変数:
  GMAIL_ADDRESS       送信元＝宛先の Gmail アドレス（Secret）
  GMAIL_APP_PASSWORD  Google アカウントのアプリパスワード（Secret）
  GH_TOKEN            コミットとファイルの一覧を取るためのトークン（ワークフローの github.token）
  DRY_RUN=1           送らずに件名と本文を表示する
使い方: python3 send_merge_mail.py <イベントの JSON（$GITHUB_EVENT_PATH）>
"""
import json
import os
import re
import smtplib
import ssl
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.utils import formatdate, make_msgid

JST = timezone(timedelta(hours=9))
STATUS = {"added": "追加", "modified": "変更", "removed": "削除", "renamed": "名前変更",
          "copied": "複製", "changed": "変更"}
MAX_BODY = 8000   # PR の説明はこの文字数で切る
MAX_FILES = 100   # ファイルの一覧はこの件数まで出す


def gh_list(path):
    """GitHub API の一覧を全ページ取る（gh は runner に標準で入っている）"""
    out, page = [], 1
    while True:
        r = subprocess.run(["gh", "api", "%s%sper_page=100&page=%d" % (path, "&" if "?" in path else "?", page)],
                           capture_output=True, text=True, check=True)
        rows = json.loads(r.stdout)
        out += rows
        if len(rows) < 100 or page >= 30:
            return out
        page += 1


def jst(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(JST).strftime("%Y/%m/%d %H:%M")
    except (AttributeError, ValueError):
        return "不明"


def build(event, commits, files):
    pr = event["pull_request"]
    repo = event["repository"]["full_name"]
    name = repo.split("/")[-1]
    subject = "【%s】#%d %s をマージしました" % (name, pr["number"], pr["title"])

    out = ["%s に PR #%d がマージされました。" % (repo, pr["number"]), "",
           "タイトル: %s" % pr["title"],
           "マージ: %s（JST）／ %s" % (jst(pr.get("merged_at")), (pr.get("merged_by") or {}).get("login", "不明")),
           "ブランチ: %s → %s" % (pr["head"]["ref"], pr["base"]["ref"]),
           "URL: %s" % pr["html_url"], ""]

    desc = (pr.get("body") or "").strip()
    out.append("■ 変更の概要（PR の説明）")
    if not desc:
        out.append("（説明はありません）")
    elif len(desc) > MAX_BODY:
        out.append(desc[:MAX_BODY] + "\n…（長いため省略しました。続きは URL から）")
    else:
        out.append(desc)
    out.append("")

    out.append("■ コミット（%d件）" % len(commits))
    for c in commits:
        first = (c["commit"]["message"].splitlines() or [""])[0]
        out.append("- %s %s" % (c["sha"][:7], first))
    out.append("")

    adds = sum(f.get("additions", 0) for f in files)
    dels = sum(f.get("deletions", 0) for f in files)
    out.append("■ 変更したファイル（%d件、+%d / -%d）" % (len(files), adds, dels))
    for f in files[:MAX_FILES]:
        label = STATUS.get(f.get("status"), f.get("status", "?"))
        fname = f["filename"]
        if f.get("previous_filename"):
            fname = "%s → %s" % (f["previous_filename"], fname)
        out.append("- %s　%s（+%d -%d）" % (label, fname, f.get("additions", 0), f.get("deletions", 0)))
    if len(files) > MAX_FILES:
        out.append("- ほか %d件" % (len(files) - MAX_FILES))
    out += ["", "-- ", "このメールは %s の GitHub Actions が自動で送っています。返信不要です。" % repo]
    return subject, "\n".join(out)


def _starttls():
    s = smtplib.SMTP("smtp.gmail.com", 587, timeout=30)
    try:
        s.starttls(context=ssl.create_default_context())  # 証明書を検証する（context なしだと検証されない）
    except BaseException:
        s.close()
        raise
    return s


def _ssl():
    return smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30, context=ssl.create_default_context())


def _text(v):
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        event = json.load(f)
    pr = event["pull_request"]
    base = "repos/%s/pulls/%d" % (event["repository"]["full_name"], pr["number"])
    subject, body = build(event, gh_list(base + "/commits"), gh_list(base + "/files"))

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
    if not re.fullmatch(r"[^@]+@[^@]+\.[^@]+", addr):
        print("GMAIL_ADDRESS がメールアドレスの形ではありません。", file=sys.stderr)
        return 1
    if not re.fullmatch(r"[A-Za-z]{16}", pw):
        print("GMAIL_APP_PASSWORD がアプリパスワード（英字16文字）の形ではありません。通常のログインパスワードでは送れません。", file=sys.stderr)

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = addr
    msg["To"] = addr
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain="deadline-tracker")

    # 587(STARTTLS) で失敗したら 465(SSL) でもう一度試す。送信が済んだ後の切断では再送しない（二重送信を防ぐ）
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
    print("送信しました: %s" % subject)
    return 0


if __name__ == "__main__":
    sys.exit(main())

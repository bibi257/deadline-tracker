#!/usr/bin/env python3
"""通知文・feed.json・メール本文・.ics を、テスト用データ（tests/fixtures/data.json）と
固定した日時で作り、tests/expected/ の正解と1文字ずつ比べる。

CI の「エラーなく作れるか」だけでは、期限切れが今日の欄に出る・件数がずれる、
といった中身の誤りに気づけない。スクリプトを直したときに、意図しない変化を拾うためのもの。

使い方（リポジトリの最上位で）:
  python3 tests/run_snapshots.py           # 比べる。違いがあれば差分を出して終了コード1
  python3 tests/run_snapshots.py --update  # 正解を作り直す（出力を変える修正をしたとき。
                                           # git diff tests/expected で変化が意図どおりか確かめてからコミット）
"""
import difflib
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, ".github", "scripts")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "data.json")
EXPECTED = os.path.join(ROOT, "tests", "expected")

# テスト用データは 2026/1/30（金）前後を想定して作ってある
MORNING = "2026-01-30 06:47"
EVENING = "2026-01-30 20:47"
WEEKLY = "2026-02-01 21:45"   # 月の最初の日曜（支出まとめも出る）
MAIL_EVE = "2026-01-29 20:23"  # 前日の夜に送る回（翌日 1/30 分）


def pinned_digest(tmp):
    """send_digest.sh の個人設定（メンションのユーザーID・アプリのURL）をテスト用の固定値に差し替えた写しを作る。
    本物の設定が変わっても、正解ファイルに本物のIDが入っても、テストの結果が変わらないようにする。
    テンプレート側（設定が空）でも同じ正解で通る。写しは tmp に置くので、スクリプトの場所は絶対パスにする。"""
    with open(os.path.join(SCRIPTS, "send_digest.sh"), encoding="utf-8") as f:
        src = f.read()
    for pat, rep in ((r'^MENTION_USER_ID=.*$', 'MENTION_USER_ID="100000000000000001"'),
                     (r'^APP_URL=.*$', 'APP_URL="https://example.com/app/"'),
                     (r'^SCRIPT_DIR=.*$', 'SCRIPT_DIR="%s"' % SCRIPTS)):
        src, n = re.subn(pat, lambda m: rep, src, count=1, flags=re.M)
        assert n == 1, "send_digest.sh に %s の行が見つかりません" % pat
    path = os.path.join(tmp, "send_digest.sh")
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    return path


def cases(tmp):
    """(正解ファイル名, コマンド, 環境変数, 出力の取り方)。出力は標準出力か、書き出したファイル。
    feed-mail は feed.json の出力を使うので、feed.json より後に置く。"""
    feed = os.path.join(tmp, "feed.json")
    ics = os.path.join(tmp, "deadlines.ics")
    sub = os.path.join(tmp, "sub.ics")
    digest = ["bash", pinned_digest(tmp)]
    return [
        ("digest-daily.txt", digest, {"NOW": MORNING}, None),
        ("digest-evening.txt", digest, {"NOW": EVENING, "DIGEST_MODE": "evening"}, None),
        ("digest-weekly.txt", digest, {"NOW": WEEKLY, "DIGEST_MODE": "weekly"}, None),
        ("feed.json", ["python3", os.path.join(SCRIPTS, "build_feed.py"), FIXTURE, feed], {"NOW": MORNING}, feed),
        ("feed-mail.txt", ["python3", os.path.join(SCRIPTS, "send_feed_mail.py"), feed], {"NOW": MAIL_EVE}, None),
        ("deadlines.ics", ["python3", os.path.join(SCRIPTS, "build_ics.py"), FIXTURE, ics, "9"], {"NOW": MORNING}, ics),
        ("deadlines-nomemo.ics", ["python3", os.path.join(SCRIPTS, "build_ics.py"), FIXTURE, sub, "9"],
         {"NOW": MORNING, "ICS_NO_MEMO": "1"}, sub),
    ]


def main():
    update = "--update" in sys.argv[1:]
    failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        base = dict(os.environ)
        # 本物の送信先が環境にあっても、テストでは絶対に送らない
        for k in ("DISCORD_WEBHOOK_URL", "GMAIL_ADDRESS", "GMAIL_APP_PASSWORD", "DATA_URL", "DIGEST_MODE", "TARGET"):
            base.pop(k, None)
        base.update({"DRY_RUN": "1", "DATA_FILE": FIXTURE, "RUNNER_TEMP": tmp})
        for name, cmd, env, out_file in cases(tmp):
            r = subprocess.run(cmd, cwd=ROOT, env=dict(base, **env), capture_output=True)
            if r.returncode != 0:
                print("✗ %s: 終了コード %d\n%s" % (name, r.returncode, r.stderr.decode("utf-8", "replace")))
                failed += 1
                continue
            if out_file:
                with open(out_file, "rb") as f:
                    got = f.read()
            else:
                got = r.stdout
            path = os.path.join(EXPECTED, name)
            if update:
                os.makedirs(EXPECTED, exist_ok=True)
                with open(path, "wb") as f:
                    f.write(got)
                print("更新: tests/expected/%s" % name)
                continue
            try:
                with open(path, "rb") as f:
                    want = f.read()
            except FileNotFoundError:
                print("✗ %s: 正解ファイルがありません（--update で作る）" % name)
                failed += 1
                continue
            if got == want:
                print("✓ %s" % name)
                continue
            failed += 1
            print("✗ %s: 正解と違います（- 正解 / + 今回）" % name)
            sys.stdout.writelines(difflib.unified_diff(
                want.decode("utf-8").splitlines(True), got.decode("utf-8").splitlines(True),
                "expected/" + name, "actual/" + name))
            print()
    if failed and not update:
        print("%d 件が正解と違います。意図した変更なら `python3 tests/run_snapshots.py --update` で正解を作り直してください。" % failed)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""繰り返しの日付計算が、実装どうしで食い違っていないかを確かめる。

同じ計算が send_digest.sh（jq の add_rep / next_occ）、build_feed.py（add_rep / expand）、
アプリ（deadline-tracker の app.js の nextOccurrence）にそれぞれある。1か所だけ直すとずれるので、
ずれやすい場面（月末の丸め・2/29・年またぎ・JST の0時台・取りやめた回・回数の上限）を表にして、
jq 版と Python 版の両方がその表と一致するかを見る。

表の「正解」は、app.js の nextOccurrence に同じ入力を与えて求めたもの（2026/10/11 時点）。
アプリ側の計算を変えたときは、この表も見直すこと。

使い方: python3 tests/test_recurrence.py   （jq が必要。CI の ubuntu-latest には入っている）
"""
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, ".github", "scripts")
sys.path.insert(0, SCRIPTS)
import build_feed  # noqa: E402

JST = timezone(timedelta(hours=9))

# 基準の回(JST), 繰り返し, 何回進めるか, 基準日(repDay), 正解(JST)
ADD_REP = [
    ("2026-01-23 19:00", "weekly", 1, None, "2026-01-30 19:00"),
    ("2026-01-23 19:00", "weekly", 3, None, "2026-02-13 19:00"),
    ("2026-01-16 23:59", "biweekly", 2, None, "2026-02-13 23:59"),
    # 31日の毎月：無い月は末日に丸め、次の月は31日に戻る
    ("2026-01-31 23:59", "monthly", 1, 31, "2026-02-28 23:59"),
    ("2026-01-31 23:59", "monthly", 2, 31, "2026-03-31 23:59"),
    ("2026-01-31 23:59", "monthly", 3, 31, "2026-04-30 23:59"),
    ("2026-01-31 23:59", "monthly", 13, 31, "2027-02-28 23:59"),
    # アプリが2月まで進めた後でも、基準日(repDay)があれば31日に戻る。無ければ28日のまま
    ("2026-02-28 23:59", "monthly", 1, 31, "2026-03-31 23:59"),
    ("2026-02-28 23:59", "monthly", 1, None, "2026-03-28 23:59"),
    # JST の0時台（UTC では前日）でも、暦は JST で数える
    ("2026-01-31 00:30", "monthly", 1, 31, "2026-02-28 00:30"),
    ("2026-12-31 10:00", "monthly", 2, 31, "2027-02-28 10:00"),
    # 2/29 の毎年：平年は2/28、うるう年は2/29
    ("2024-02-29 09:00", "yearly", 1, 29, "2025-02-28 09:00"),
    ("2024-02-29 09:00", "yearly", 4, 29, "2028-02-29 09:00"),
    ("2025-02-28 09:00", "yearly", 3, 29, "2028-02-29 09:00"),
    ("2025-02-28 09:00", "yearly", 3, None, "2028-02-28 09:00"),
]

# 「この時刻以降で最初の回」（send_digest.sh の next_occ）。正解 None は「もう回が無い」
NEXT_OCC = [
    # 取りやめた回(skip)は飛ばす
    ({"due": "2026-01-23 19:00", "rep": "weekly", "skip": ["2026-01-30"]}, "2026-01-30 06:47", "2026-02-06 19:00"),
    # 回数指定(repCount)は今の回を含めた残り回数
    ({"due": "2026-01-09 10:00", "rep": "weekly", "repCount": 2}, "2026-01-16 09:00", "2026-01-16 10:00"),
    ({"due": "2026-01-09 10:00", "rep": "weekly", "repCount": 2}, "2026-01-20 00:00", None),
    ({"due": "2026-01-31 23:59", "rep": "monthly", "repDay": 31}, "2026-02-01 00:00", "2026-02-28 23:59"),
    ({"due": "2026-01-31 23:59", "rep": "monthly", "repDay": 31, "skip": ["2026-02-28"]}, "2026-02-01 00:00", "2026-03-31 23:59"),
]

# build_feed.py の expand：範囲 frm〜to に入る各回の締切日。自動完了でない回が過ぎていれば、その回も1件出す
EXPAND = [
    ({"due": "2026-01-23 19:00", "rep": "weekly", "skip": ["2026-01-30"]},
     "2026-01-30 06:47", "2026-01-30", "2026-02-13", ["2026-01-23", "2026-02-06", "2026-02-13"]),
    ({"due": "2026-01-09 10:00", "rep": "weekly", "repCount": 2, "autoComplete": True},
     "2026-01-12 08:00", "2026-01-12", "2026-01-26", ["2026-01-16"]),
    ({"due": "2026-01-09 10:00", "rep": "weekly", "repCount": 2, "autoComplete": True},
     "2026-01-20 08:00", "2026-01-20", "2026-02-03", []),
    ({"due": "2026-01-31 23:59", "rep": "monthly", "repDay": 31, "autoComplete": True},
     "2026-01-30 06:47", "2026-01-30", "2026-04-30", ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]),
]


def jst(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=JST)


def iso_utc(s):
    """JST の "YYYY-MM-DD HH:MM" を、data.json と同じ形（UTC・ミリ秒つき）にする"""
    return jst(s).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fmt(epoch):
    return None if epoch is None else datetime.fromtimestamp(epoch, JST).strftime("%Y-%m-%d %H:%M")


def jq_lib():
    with open(os.path.join(SCRIPTS, "send_digest.sh"), encoding="utf-8") as f:
        m = re.search(r"^JQ_LIB='\n(.*?)^'$", f.read(), re.S | re.M)
    if not m:
        sys.exit("send_digest.sh から JQ_LIB を取り出せません（書き方が変わった？）")
    return m.group(1)


def run_jq(program, data):
    r = subprocess.run(["jq", "-c", jq_lib() + program], input=json.dumps(data),
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def item(spec):
    it = dict(spec, id="x", title="x", due=iso_utc(spec["due"]))
    return it


def main():
    fails = []

    # add_rep：jq と Python
    jq_in = [{"base": iso_utc(b), "rep": r, "n": n, "anchor": a} for b, r, n, a, _ in ADD_REP]
    jq_out = run_jq('[.[] | . as $c | ($c.base | ep) | add_rep($c.rep; $c.n; $c.anchor)]', jq_in)
    for (b, r, n, a, want), got_jq in zip(ADD_REP, jq_out):
        got_py = build_feed.add_rep(jst(b), r, n, a).strftime("%Y-%m-%d %H:%M")
        label = "add_rep(%s, %s, %d回, repDay=%s)" % (b, r, n, a)
        if fmt(got_jq) != want:
            fails.append("%s jq: %s（正解 %s）" % (label, fmt(got_jq), want))
        if got_py != want:
            fails.append("%s Python: %s（正解 %s）" % (label, got_py, want))

    # next_occ：jq
    jq_in = [{"item": item(s), "t": int(jst(t).timestamp())} for s, t, _ in NEXT_OCC]
    jq_out = run_jq('[.[] | . as $c | $c.item | next_occ($c.t)]', jq_in)
    for (s, t, want), got in zip(NEXT_OCC, jq_out):
        if fmt(got) != want:
            fails.append("next_occ(%s, 基準 %s) jq: %s（正解 %s）" % (json.dumps(s, ensure_ascii=False), t, fmt(got), want))

    # expand：Python
    for s, now, frm, to, want in EXPAND:
        got = [e["due_date"] for e in build_feed.expand(
            item(s), date.fromisoformat(frm), date.fromisoformat(to), jst(now))]
        if got != want:
            fails.append("expand(%s, %s〜%s) Python: %s（正解 %s）" % (json.dumps(s, ensure_ascii=False), frm, to, got, want))

    total = len(ADD_REP) * 2 + len(NEXT_OCC) + len(EXPAND)
    for m in fails:
        print("✗ " + m)
    print("繰り返しの計算: %d 件中 %d 件が正解と一致" % (total, total - len(fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

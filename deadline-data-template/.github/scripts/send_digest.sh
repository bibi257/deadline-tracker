#!/usr/bin/env bash
# 毎朝、近日中の締切をDiscordにまとめて送るスクリプト。
# GitHub Actionsのcronから呼ばれる。ubuntu-latestに標準で入っているcurl/jq/dateだけで動く。
#
# 動作確認用の環境変数:
#   DRY_RUN=1          Discordへ送らず、送る内容を標準出力に表示する
#   NOW="2026-10-01 07:00"  「現在時刻」を差し替える(JSTとして解釈)。日付をまたぐ挙動の確認用
#   DIGEST_MODE=weekly 週次レビューを送る
#   DIGEST_MODE=evening 夜の再通知（期限切れ・今日が締切だけ。0件なら送らない）
set -euo pipefail

# このスクリプトが置かれているディレクトリ（build_ics.py の場所）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- 設定（ここを書き換えれば他の設定は不要） ------------------------------
# 通知先のDiscordウェブフックURL。
# ※このリポジトリがPublicの場合、このURLは誰でも閲覧できます。
#   リポジトリの Settings → Secrets and variables → Actions に
#   DISCORD_WEBHOOK_URL を登録すると、そちらが優先して使われます。
#   悪用されたときはDiscordのチャンネル設定→連携サービス→ウェブフックから削除し、
#   新しいURLを発行してここ(またはSecret)を書き換えてください。
DEFAULT_WEBHOOK_URL=""
# 毎朝メンションで呼び出すユーザーID。メンション不要なら空文字にする
MENTION_USER_ID=""
# 何日以内の締切を対象にするか
DEFAULT_WINDOW_DAYS="7"
# data.jsonをバックアップとして添付する曜日(JST)。1=月 2=火 … 7=日。0にすると添付しない
BACKUP_DOW="1"
# 通知に載せるアプリのURL。空にするとリンクを出さない
APP_URL=""
# 未完了全件の.icsを毎回添付するか。
# ※iOSでは添付を直接タップすると「照会カレンダー」になり更新が反映されにくいため、
#   既定では添付せず、上のAPP_URLに ?export=all を付けたリンクから保存させる。
#   添付も欲しい場合は 1 にする
ATTACH_ICS="0"
# .ics内の「当日リマインド」の時刻(24時間表記の時)
ICS_DAY_HOUR="9"
# 週次レビューの負荷予報で ⚠️ を付ける件数（1週間の合計 / 1カテゴリ）
LOAD_WARN="6"
CAT_WARN="3"
# 週次レビューの月初めに支出をまとめるカテゴリ。メモの「¥1,980」「1980円」を集計する。空にすると出さない
SUBSC_CAT="サブスクなど"
# 通知の期限切れ・今日が締切の行に「✅完了」リンク(APP_URL?done=ID)を付けるか。1=付ける
DONE_LINKS="1"
# ---------------------------------------------------------------------------

# 環境変数が指定されていればそちらを優先する（Secretsを使いたくなった場合用）
# 通常はこのリポジトリ内の data.json をそのまま読む。DATA_URLを指定した場合のみHTTP経由で取得する。
DATA_FILE="${DATA_FILE:-data.json}"
WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-$DEFAULT_WEBHOOK_URL}"
WINDOW_DAYS="${WINDOW_DAYS:-$DEFAULT_WINDOW_DAYS}"
DRY_RUN="${DRY_RUN:-0}"

if [ -z "$WEBHOOK_URL" ] && [ "$DRY_RUN" != "1" ]; then
  echo "エラー: DiscordのWebhook URLが未設定です。send_digest.sh 冒頭の DEFAULT_WEBHOOK_URL に記入するか、" >&2
  echo "       リポジトリの Secret に DISCORD_WEBHOOK_URL を登録してください。" >&2
  exit 1
fi

# 「現在時刻」。NOW を指定すると差し替えられる（動作確認用）
if [ -n "${NOW:-}" ]; then
  NOW_EPOCH=$(TZ=Asia/Tokyo date -d "$NOW" +%s)
else
  NOW_EPOCH=$(date +%s)
fi
WINDOW_EPOCH=$(( NOW_EPOCH + WINDOW_DAYS*86400 ))
TODAY_KEY=$(TZ=Asia/Tokyo date -d "@$NOW_EPOCH" +%Y-%m-%d)
# 今日(JST)の0時。JSTに夏時間は無いので日付の加減算は86400秒単位でよい
TODAY_START=$(TZ=Asia/Tokyo date -d "$TODAY_KEY" +%s)

MENTION=""
if [ -n "$MENTION_USER_ID" ]; then
  MENTION="<@${MENTION_USER_ID}> "$'\n'
fi

# ---- Discordへの送信 --------------------------------------------------------
# 一時的なエラー(429/5xx)は数回リトライする。DRY_RUN=1 なら送らずに表示だけする
post_json(){  # $1=JSON本文
  if [ "$DRY_RUN" = "1" ]; then
    echo "----- [DRY_RUN] 送信内容 -----"
    echo "$1" | jq -r '.content'
    return 0
  fi
  curl -sf --retry 3 --retry-delay 2 \
    -H "Content-Type: application/json" -d "$1" "$WEBHOOK_URL" >/dev/null
}
post_with_file(){  # $1=JSON本文 $2=ファイルパス $3=ファイル名 $4=MIMEタイプ
  if [ "$DRY_RUN" = "1" ]; then
    echo "----- [DRY_RUN] 送信内容（添付: $3）-----"
    echo "$1" | jq -r '.content'
    return 0
  fi
  # payload_json は --form-string で渡す（本文中の ; や < を curl に解釈させない）
  curl -sf --retry 3 --retry-delay 2 \
    --form-string "payload_json=$1" \
    -F "files[0]=@$2;filename=$3;type=$4" \
    "$WEBHOOK_URL" >/dev/null
}
# 本文(テキスト)を送る。メンションは指定ユーザーだけ許可する
send_content(){  # $1=本文 $2=添付ファイルパス(省略可) $3=ファイル名 $4=MIMEタイプ
  local truncated body
  # Discordの本文上限は2000文字。件数が多い日は超えることがあるため切り詰める
  truncated=$(truncate_for_discord "$1")
  body=$(jq -n --argjson c "$truncated" --arg uid "$MENTION_USER_ID" '
    {content: $c} + (if $uid == "" then {} else {allowed_mentions: {parse: [], users: [$uid]}} end)')
  if [ -n "${2:-}" ]; then
    post_with_file "$body" "$2" "$3" "$4" || post_json "$body"
  else
    post_json "$body"
  fi
}

# Discordの本文上限(2000文字)を超えないよう切り詰める。
# ロケールがPOSIXの環境ではcutやwcが日本語を正しく1文字として数えないことがあるため、
# UTF-8を確実に扱えるjqで文字数を数えて切る
truncate_for_discord(){
  local text="$1" limit=1850
  printf '%s' "$text" | jq -Rs --argjson limit "$limit" '
    if (length > $limit) then
      (.[0:$limit] + "\n\n…（件数が多いため省略しました。詳しくはアプリでご確認ください）")
    else . end'
}
# ---------------------------------------------------------------------------

# data.json を読み込む(存在しないならその旨だけ送って終了)
JSON=""
if [ -n "${DATA_URL:-}" ]; then
  JSON=$(curl -fsSL "$DATA_URL" 2>/dev/null) || JSON=""
elif [ -f "$DATA_FILE" ]; then
  JSON=$(cat "$DATA_FILE")
fi

if [ -z "$JSON" ] || ! echo "$JSON" | jq -e '.items' >/dev/null 2>&1; then
  post_json '{"content":"⚠️ 締切データ(data.json)がまだ同期されていません。アプリの設定タブから「GitHubに同期する」を実行してください。"}'
  exit 0
fi

# 締切(due)が無い・日時として読めない項目は、全体を止めないよう除外して警告だけ出す
BROKEN=$(echo "$JSON" | jq -r '
  [ .items[]? | select(.done|not)
    | select((.due | type) != "string"
             or ((.due | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch null) == null)) ]
  | map(.title // .id // "?" | tostring | gsub("[\n\r]"; " ")) | join("、")')
if [ -n "$BROKEN" ]; then
  echo "締切日時が読めない項目を除外しました: $BROKEN" >&2
fi

# 各jqで共通して使う関数
#   ep       : ISO8601(ミリ秒つき可)をepoch秒に
#   ok       : 締切日時が読める項目だけ通す
#   add_rep  : 繰り返しを n 回分進めた日時。月・年単位はJSTの暦で進め、
#              月末(31日など)は各月の末日に丸める。$anchor はアプリが記録した基準日(repDay)
#   next_occ : 基準時刻 $t 以降で最初の回(取りやめた回=skip は飛ばす)
#   rows_safe: 1行1件で渡すため、タイトル等の改行と区切り文字を除く
JQ_LIB='
def ep: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
def ok: (.due | type) == "string" and ((.due | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch null) != null);
def jstkey: (. + 32400) | strftime("%Y-%m-%d");
def add_rep($rep; $n; $anchor):
  if $n == 0 then .
  elif $rep == "weekly" then . + $n*7*86400
  elif $rep == "biweekly" then . + $n*14*86400
  elif $rep == "monthly" or $rep == "yearly" then
    ((. + 32400) | gmtime) as $t
    | ($t[1] + (if $rep == "monthly" then $n else $n*12 end)) as $mo
    | ($t[0] + ($mo / 12 | floor)) as $y
    | ($mo % 12) as $m
    | ([$y, $m + 1, 0, 0, 0, 0, 0, 0] | mktime | gmtime | .[2]) as $last
    | ([$y, $m, ([($anchor // $t[2]), $last] | min), $t[3], $t[4], ($t[5] | floor), 0, 0] | mktime) - 32400
  else . end;
def next_occ($t):
  (.due | ep) as $b | (.rep // "none") as $r | (.skip // [] | if type == "array" then . else [] end) as $sk
  | (.repDay // null) as $a | ((.repCount // 0) | tonumber? // 0) as $lim
  # repCount は「今の回を含めた残り回数」（アプリが回を進めるたびに減らす）。0 は無期限
  | (first(range(0; (if $lim > 0 then $lim else 1100 end)) as $n
      | ($b | add_rep($r; $n; $a))
      | select(. >= $t)
      | select(jstkey as $k | $sk | any(.[]; . == $k) | not)) // null);
def clean: tostring | gsub("[\n\r\u001f]"; " ");
# 開始日時が壊れている項目は、開始なし（締切だけ）として扱う（手で書き換えた data.json でも止まらないように）
def fixstart: if (.start | type) == "string" and ((.start | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch null) == null) then del(.start) else . end;
'

# 未完了かつ「期限切れ」または「WINDOW_DAYS以内」の項目を、締切が近い順に抽出
# 期間つきは開始日を基準に並べる（アプリの表示と揃える）
# 繰り返し(rep)のあるものは下の「定期予定」で扱うが、
# 自動完了(autoComplete)でないものの締切が過ぎていれば「期限切れ」にも入れる
ROWS=$(echo "$JSON" | jq -r --argjson now "$NOW_EPOCH" --argjson win "$WINDOW_EPOCH" "$JQ_LIB"'
  [ .items[]? | select(.done|not) | select(ok) | fixstart
    | (.rep // "none") as $rep
    | . + {epoch: (.due | ep)}
    | select($rep == "none" or ((.autoComplete|not) and .epoch < $now))
    | . + {refep: (if $rep == "none" then ((.start // .due) | ep) else .epoch end)}
    | select(.refep <= $win)
  ] | sort_by(.refep) | .[]
  | [ (.epoch|tostring), (.title // "" | clean), (.cat // "その他" | clean), .due, (.start // ""),
      ((.allDay // false)|tostring), (.refep|tostring), (.rep // "none"), (.id // "" | clean) ]
  | join("\u001f")
')

# 定期予定。次回(今から先で最初の回)が近い順。期間の指定に関わらず全件出す
# data.json の due は「アプリで最後に進めた回」のままのことがあるので、ここで次回を計算し直す
REP_ROWS=$(echo "$JSON" | jq -r --argjson now "$NOW_EPOCH" "$JQ_LIB"'
  [ .items[]? | select(.done|not) | select(ok)
    | select((.rep // "none") != "none")
    | . + {epoch: next_occ($now)}
    | select(.epoch != null)  # 回数を使い切った繰り返しは出さない
  ] | sort_by(.epoch) | .[]
  | [ (.epoch|tostring), (.title // "" | clean), (.cat // "その他" | clean), .due, .rep, ((.allDay // false)|tostring) ]
  | join("\u001f")
')

# 曜日を日本語で返す（$1 は date -d に渡せる文字列。"@epoch" も可）
jp_dow(){ case "$(TZ=Asia/Tokyo date -d "$1" +%u)" in
    1) echo 月;; 2) echo 火;; 3) echo 水;; 4) echo 木;;
    5) echo 金;; 6) echo 土;; 7) echo 日;; esac; }

# 日時をJSTで整形する。終日なら時刻を出さない
fmt_when(){  # $1=ISO日時 または @epoch  $2=allDay
  local dow; dow=$(jp_dow "$1")
  if [ "$2" = "true" ]; then
    TZ=Asia/Tokyo date -d "$1" "+%-m/%-d（${dow}）" 2>/dev/null || echo "$1"
  else
    TZ=Asia/Tokyo date -d "$1" "+%-m/%-d（${dow}） %H:%M" 2>/dev/null || echo "$1"
  fi
}
# 今日(JST)から見て何日後かを返す。過去なら負の数
days_from_today(){  # $1=epoch
  local key; key=$(TZ=Asia/Tokyo date -d "@$1" +%Y-%m-%d)
  echo $(( ( $(TZ=Asia/Tokyo date -d "$key" +%s) - TODAY_START ) / 86400 ))
}
# 「✅完了」リンク（アプリが ?done=ID を受け取れる場合に、そのまま完了確認を開く）。IDの無い項目・設定オフでは空
done_link(){  # $1=ID
  [ "$DONE_LINKS" = "1" ] && [ -n "$APP_URL" ] && [ -n "$1" ] || return 0
  printf '　[✅完了](%s?done=%s)' "$APP_URL" "$(printf '%s' "$1" | jq -sRr @uri)"
}
# 残り日数の文言を作る
fmt_remain(){  # $1=基準epoch $2=締切epoch $3=開始があるか
  local ref="$1" due="$2" has_start="$3"
  local diff; diff=$(days_from_today "$ref")
  if [ "$due" -lt "$NOW_EPOCH" ]; then
    local od; od=$(( -$(days_from_today "$due") ))
    if [ "$od" -eq 0 ]; then echo "期限切れ"; else echo "${od} 日 超過"; fi
  elif [ "$diff" -lt 0 ]; then
    echo "進行中"
  elif [ "$diff" -eq 0 ]; then
    if [ -n "$has_start" ] && [ "$(days_from_today "$due")" -ne 0 ]; then echo "今日から開始"; else echo "今日"; fi
  elif [ -n "$has_start" ]; then
    echo "${diff} 日後に開始"
  else
    echo "${diff} 日後"
  fi
}

# 指定曜日(JST)なら data.json をファイルとして添付し、控えを残す
send_backup(){
  [ "$BACKUP_DOW" = "0" ] && return 0
  [ "$(TZ=Asia/Tokyo date -d "@$NOW_EPOCH" +%u)" = "$BACKUP_DOW" ] || return 0
  local stamp count tmp body
  stamp="$TODAY_KEY"
  count=$(echo "$JSON" | jq '[.items[]?] | length')
  tmp="${RUNNER_TEMP:-/tmp}/deadline-backup-${stamp}.json"
  printf '%s' "$JSON" > "$tmp"
  body=$(jq -n --arg c "🗄️ 週次バックアップ（${stamp} / 全${count}件）　アプリの設定タブ→「JSONを読み込む」で復元できます。" '{content: $c}')
  post_with_file "$body" "$tmp" "deadline-backup-${stamp}.json" "application/json" \
    || echo "バックアップの添付に失敗しました" >&2
}

# 週次レビュー本文を組み立てて送る（来週7日間の見通し・今週の完了数・滞留件数）
send_weekly_review(){
  # 対象は「明日0時〜8日後0時(JST)」の7日間。繰り返しは次回の日付で拾う
  local ws=$(( TODAY_START + 86400 )) we=$(( TODAY_START + 8*86400 ))
  local NEXT7
  NEXT7=$(echo "$JSON" | jq -r --argjson ws "$ws" --argjson we "$we" "$JQ_LIB"'
    [ .items[]? | select(.done|not) | select(ok)
      | . + {epoch: (if (.rep // "none") == "none" then (.due | ep) else next_occ($ws) end)}
      | select(.epoch >= $ws and .epoch < $we)
    ] | sort_by(.epoch) | .[]
    | [ (.epoch | jstkey), (.title // "" | clean), (.cat // "その他" | clean), (.rep // "none") ]
    | join("\u001f")
  ')

  local BY_DAY="" off d dow label DAY_LINES key title cat rep mark
  for off in 1 2 3 4 5 6 7; do
    d=$(TZ=Asia/Tokyo date -d "@$(( TODAY_START + off*86400 ))" +%Y-%m-%d)
    dow=$(jp_dow "$d")
    label=$(TZ=Asia/Tokyo date -d "$d" "+%-m/%-d（${dow}）")
    DAY_LINES=""
    if [ -n "$NEXT7" ]; then
      while IFS=$'\x1f' read -r key title cat rep; do
        if [ "$key" = "$d" ]; then
          mark="-"
          [ "$rep" != "none" ] && mark="🔁"
          DAY_LINES="${DAY_LINES}${mark} ${title}　\`${cat}\`"$'\n'
        fi
      done <<< "$NEXT7"
    fi
    if [ -n "$DAY_LINES" ]; then
      BY_DAY="${BY_DAY}**${label}**"$'\n'"${DAY_LINES}"$'\n'
    fi
  done
  [ -z "$BY_DAY" ] && BY_DAY="来週の締切はまだ登録されていません。"$'\n'

  # 今週(過去7日)に完了した件数
  local DONE_COUNT
  DONE_COUNT=$(echo "$JSON" | jq -r --argjson now "$NOW_EPOCH" "$JQ_LIB"'
    [ .items[]? | select(.done and .doneAt)
      | select((.doneAt | try ep catch 0) > ($now - 7*86400))
    ] | length')

  # 7日以上の滞留件数（自動完了の繰り返しは、締切が過ぎても次回へ進むだけなので数えない）
  local STALE_COUNT
  STALE_COUNT=$(echo "$JSON" | jq -r --argjson now "$NOW_EPOCH" "$JQ_LIB"'
    [ .items[]? | select(.done|not) | select(ok)
      | select(((.rep // "none") != "none" and .autoComplete) | not)
      | select((.due | ep) < ($now - 7*86400))
    ] | length')

  # アプリが記録している「完了の記録」(completions)から、この1週間の完了のタイミングをまとめる。
  # 記録が無い（古いアプリのデータ）場合は、従来どおり件数だけを出す
  local WEEK_DONE
  WEEK_DONE=$(echo "$JSON" | jq -r --argjson now "$NOW_EPOCH" "$JQ_LIB"'
    def dow: ["日","月","火","水","木","金","土"][(. + 32400 | gmtime | .[6])];
    def md: (. + 32400 | strftime("%m/%d") | sub("^0"; "") | sub("/0"; "/")) + "（" + dow + "）" + (. + 32400 | strftime(" %H:%M"));
    def leadtxt: if .kind == "auto" then "自動完了"
                 elif .lead < 0 then "締切を" + ((- .lead) | if . < 24 then "\(floor)時間" else "\(./24 | floor)日" end) + "過ぎて"
                 elif .lead < 24 then "締切の\(.lead | floor)時間前"
                 else "締切の\(.lead/24 | floor)日前" end;
    def band: (. + 32400 | gmtime | .[3]) as $h
      | if $h < 5 then "深夜（0〜5時）" elif $h < 12 then "朝（5〜12時）" elif $h < 18 then "昼（12〜18時）" else "夜（18〜24時）" end;
    def r1: . * 10 | round / 10;
    if (.completions | type) != "array" then empty else
      ([ .completions[] | select(type == "object" and (.doneAt | type) == "string")
         | . + {t: (.doneAt | try ep catch 0), lead: ((.lead // 0) | tonumber? // 0), kind: (.kind // "ontime"), exp: ((.exp // 0) | tonumber? // 0)} ]) as $all
      | ([ $all[] | select(.t > ($now - 7*86400) and .t <= $now) ] | sort_by(.t)) as $wall
      | ([ $wall[] | select(.kind != "bonus") ]) as $w
      | ([ $wall[] | select(.kind == "bonus") ] | length) as $clears
      | ([ $w[] | select(.kind != "auto") ]) as $man
      | (((.expCarry // 0) | tonumber? // 0) + ([ $all[] | select(.t <= $now) | .exp ] | add // 0)) as $total
      | ([ $wall[] | .exp ] | add // 0) as $gain
      | (($total / 100 | floor) + 1) as $lv
      | (($total - $gain) / 100 | floor + 1) as $lv0
      | [ "- 完了：\($w | length)件（前倒し \([$w[] | select(.kind == "early")] | length)・期限内 \([$w[] | select(.kind == "ontime")] | length)・遅れ \([$w[] | select(.kind == "late")] | length)・自動 \([$w[] | select(.kind == "auto")] | length)）",
          (if ($man | length) > 0 then
             ([ $man[] | .lead ] | add / length) as $avg
             | "- 平均：" + (if $avg >= 0 then "締切の\($avg/24 | r1)日前に完了" else "締切を\(- $avg/24 | r1)日過ぎて完了" end)
           else empty end),
          (if ($man | length) > 0 then
             ($man | group_by(.t | band) | max_by(length)) as $g
             | "- 完了が多い時間帯：\($g[0].t | band)に\($g | length)件"
           else empty end),
          (if ($man | length) > 0 then ($man | max_by(.lead)) as $b | select($b.lead >= 24)
             | "- 一番早く片付けた：「\($b.title // "" | clean)」（\($b | leadtxt)）" else empty end),
          (if ([ $w[] | select(.kind == "late") ] | length) > 0 then
             "- 遅れたもの：" + ([ $w[] | select(.kind == "late") | "「\(.title // "" | clean)」" ] | .[0:3] | join("・"))
           else empty end),
          (if $clears > 0 then "- 🌟 本日のクエスト全クリア：\($clears)日" else empty end),
          "- 獲得EXP：+\($gain)（Lv.\($lv)・累計 \($total) EXP）" + (if $lv > $lv0 then "　🎉 Lv.\($lv0) → Lv.\($lv) にレベルアップ！" else "" end),
          (if ($w | length) > 0 then
             "\n### ✅ 完了したもの",
             ([ $w | reverse | .[0:10][] | "- \(.t | md)　\(.title // "" | clean)　`\(.cat // "その他" | clean)`　\(leadtxt)" ] | .[]),
             (if ($w | length) > 10 then "- ほか \(($w | length) - 10)件" else empty end)
           else empty end)
        ] | .[]
    end
  ' 2>/dev/null || true)

  local CONTENT="# 📅 来週の見通し"$'\n'"### $(TZ=Asia/Tokyo date -d "@${NOW_EPOCH}" "+%-m月%-d日（$(jp_dow "@$NOW_EPOCH")）")の週次レビュー"$'\n\n'
  CONTENT="${CONTENT}## 🗓️ 来週7日間"$'\n'"${BY_DAY}"
  if [ -n "$WEEK_DONE" ]; then
    CONTENT="${CONTENT}"$'\n'"## 🏆 この1週間の達成"$'\n'"${WEEK_DONE}"
  else
    CONTENT="${CONTENT}"$'\n'"## 📊 この1週間"$'\n'"- 完了：${DONE_COUNT}件"
  fi
  if [ "$STALE_COUNT" -gt 0 ]; then
    CONTENT="${CONTENT}"$'\n'"- ⚠️ 7日以上の滞留：${STALE_COUNT}件"
  fi
  local EXTRA=""
  local REP_STATS
  REP_STATS=$(echo "$JSON" | jq -r --argjson now "$NOW_EPOCH" "$JQ_LIB"'
    def r1: . * 10 | round / 10;
    ([ .items[]? | select((.rep // "none") != "none") | {key: .id, value: .title} ] | from_entries) as $titles
    | if (.completions | type) != "array" then empty else
      [ .completions[] | select(type == "object" and .rep == true and (.doneAt | type) == "string")
        | select((.doneAt | try ep catch 0) > ($now - 28*86400))
        | select(.kind != "bonus") ]
      | group_by(.itemId)[]
      | (length) as $n
      | ([ .[] | select(.kind == "early" or .kind == "ontime") ] | length) as $ok
      | ([ .[] | select(.kind == "late") ] | length) as $late
      | ([ .[] | select(.kind == "auto") ] | length) as $auto
      | ([ .[] | select(.kind != "auto") | (.lead // 0) ]) as $leads
      | "- \(($titles[.[0].itemId] // .[0].title // "?") | clean)　"
        + (if $auto == $n then "自動 \($auto)"
           else "期限内 \($ok)/\($n - $auto)"
             + (if ($leads | length) > 0 then
                  ($leads | add / length) as $a
                  | "　平均 " + (if $a >= 0 then "締切の\($a/24 | r1)日前" else "締切を\(-$a/24 | r1)日過ぎて" end)
                else "" end)
             + (if $late > 0 then "　⚠️ 遅れ\($late)" else "" end)
           end)
    end' 2>/dev/null || true)
  if [ -n "$REP_STATS" ]; then
    EXTRA="${EXTRA}"$'\n'"## 🔁 繰り返しの調子（直近4週）"$'\n'"${REP_STATS}"
  fi

  local LOAD
  LOAD=$(echo "$JSON" | jq -r --argjson s "$(( TODAY_START + 86400 ))" \
      --argjson lw "$LOAD_WARN" --argjson cw "$CAT_WARN" "$JQ_LIB"'
    def md: (. + 32400 | strftime("%m/%d") | sub("^0"; "") | sub("/0"; "/"));
    # 毎週・隔週は14日に2回入ることがあるので、次回から周期ずつ足して展開する
    def occs($from; $to):
      if (.rep // "none") == "none" then (.due | ep) | select(. >= $from and . < $to)
      else next_occ($from) as $f
        | ({"weekly": 7, "biweekly": 14}[.rep] // null) as $p
        | if $f == null then empty
          elif $p == null then $f
          else range(0; 3) as $k | $f + $k * $p * 86400
          end
        | select(. < $to)
      end;
    [ .items[]? | select(.done|not) | select(ok) | (.cat // "その他") as $c
      | occs($s; $s + 14*86400) | {c: $c, w: (((. - $s) / (7*86400)) | floor)} ] as $all
    | range(0; 2) as $w
    | [ $all[] | select(.w == $w) ] as $x
    | ($s + $w*7*86400) as $ws
    | ([ $x | group_by(.c)[] | {c: .[0].c, n: length} ] | sort_by(-.n)) as $cats
    | "- " + (if $w == 0 then "来週" else "再来週" end)
      + " \($ws | md)〜\(($ws + 6*86400) | md)：\($x | length)件"
      + (if ($x | length) >= $lw then " ⚠️" else "" end)
      + (if ($cats | length) > 0 then "　" + ([ $cats[] | "\(.c | clean) \(.n)" + (if .n >= $cw then " ⚠️" else "" end) ] | join("・")) else "" end)
  ')
  EXTRA="${EXTRA}"$'\n'"## 📈 負荷予報"$'\n'"${LOAD}"

  # 月の最初の日曜（1〜7日）だけ支出まとめを出す
  if [ -n "$SUBSC_CAT" ] && [ "$(TZ=Asia/Tokyo date -d "@$NOW_EPOCH" +%-d)" -le 7 ]; then
    local SUBSC
    SUBSC=$(echo "$JSON" | jq -r --arg cat "$SUBSC_CAT" "$JQ_LIB"'
      def yen: (.memo // "") | [ scan("(?:¥|￥)\\s*([0-9][0-9,]*)|([0-9][0-9,]*)\\s*円") | map(select(. != null))[0] ]
               | first // null | if . == null then null else gsub(","; "") | tonumber end;
      def permonth: {"monthly": 1, "yearly": (1/12), "weekly": (52/12), "biweekly": (26/12)}[.rep] as $f
               | if $f == null then null else (.v * $f | round) end;
      [ .items[]? | select(.done|not) | select((.cat // "") == $cat)
        | {t: (.title // "" | clean), v: yen, rep: (.rep // "none")} ] as $xs
      | [ $xs[] | select(.v != null) | . + {m: permonth} | select(.m != null) ] as $ok
      | [ $xs[] | select(.v == null) | .t ] as $no
      | ([ $ok[] | .m ] | add // 0) as $sum
      | "- 月あたり 約\($sum)円（年 約\($sum * 12)円）",
        ($ok | sort_by(-.m)[] | "  - \(.t)：\(.m)円/月"),
        (if ($no | length) > 0 then "-# 金額が未記入：" + ($no | join("・")) + "（メモに ¥1,980 のように書くと集計されます）" else empty end)
    ')
    EXTRA="${EXTRA}"$'\n'"## 💳 ${SUBSC_CAT}"$'\n'"${SUBSC}"
  fi

  if [ -n "$APP_URL" ]; then
    EXTRA="${EXTRA}"$'\n'"## 🔗 リンク"$'\n'"- [アプリを開く](${APP_URL})"
  fi

  # 節が増えて2000文字を超えやすいので、見通しと達成／繰り返し・負荷・支出に分けて送る
  send_content "$CONTENT"
  send_content "# 📈 先々の見通し"$'\n'"${EXTRA}"
}

# 週次レビュー（日曜夜のcron、または手動実行で DIGEST_MODE=weekly のとき）
if [ "${DIGEST_MODE:-}" = "weekly" ]; then
  send_weekly_review
  exit 0
fi

# 夜の再通知（DIGEST_MODE=evening）。朝の通知を見逃した人向けに、
# 「期限切れ」と「今日が締切」のものだけを送る。対象が0件なら何も送らない
if [ "${DIGEST_MODE:-}" = "evening" ]; then
  EVE_LINES=""
  EVE_COUNT=0
  if [ -n "$ROWS" ]; then
    while IFS=$'\x1f' read -r epoch title cat due start allday refep rep id; do
      d=$(days_from_today "$epoch")
      [ "$d" -le 0 ] || continue
      MARK=""
      [ "$rep" != "none" ] && MARK="🔁 "
      if [ "$epoch" -lt "$NOW_EPOCH" ]; then
        if [ "$d" -eq 0 ]; then STATE="🔴 締切を過ぎました"; else STATE="🔴 $(( -d )) 日超過"; fi
      elif [ "$allday" = "true" ]; then
        STATE="⚡ 今日中"
      else
        STATE="⚡ 今日 $(TZ=Asia/Tokyo date -d "@$epoch" +%H:%M) まで"
      fi
      EVE_LINES="${EVE_LINES}- ${MARK}**${title}**　\`${cat}\`　${STATE}$(done_link "$id")"$'\n'
      EVE_COUNT=$((EVE_COUNT+1))
    done <<< "$ROWS"
  fi
  if [ "$EVE_COUNT" -eq 0 ]; then
    echo "夜の再通知：対象なし（送信しません）"
    exit 0
  fi
  CONTENT="${MENTION}# 🌙 まだ終わっていません（${EVE_COUNT}件）"$'\n'"${EVE_LINES}"
  if [ -n "$APP_URL" ]; then
    CONTENT="${CONTENT}"$'\n'"[アプリで完了にする](${APP_URL})"
  fi
  send_content "$CONTENT"
  exit 0
fi

# 定期予定のセクションを組み立てる（次回の締切日と残り日数を表示）
REP_LINES=""
if [ -n "$REP_ROWS" ]; then
  while IFS=$'\x1f' read -r epoch title cat due rep allday; do
    RDATE=$(fmt_when "@$epoch" "$allday")
    case "$rep" in
      weekly)   RLABEL="毎週" ;;
      biweekly) RLABEL="隔週" ;;
      monthly)  RLABEL="毎月" ;;
      yearly)   RLABEL="毎年" ;;
      *)        RLABEL="$rep" ;;
    esac
    RDIFF=$(days_from_today "$epoch")
    if [ "$RDIFF" -eq 0 ]; then RREMAIN="今日"; else RREMAIN="${RDIFF} 日後"; fi
    REP_LINES="${REP_LINES}- **${title}**　\`${cat}\`　${RLABEL}"$'\n'"  次は ${RDATE}　── ${RREMAIN}"$'\n'
  done <<< "$REP_ROWS"
fi

REP_SECTION=""
if [ -n "$REP_LINES" ]; then
  REP_SECTION=$'\n'"## 🔁 定期予定"$'\n'"${REP_LINES}"
fi

TODAY_JST=$(TZ=Asia/Tokyo date -d "@$NOW_EPOCH" "+%-m月%-d日（$(jp_dow "@$NOW_EPOCH")）")
LINK_SECTION=""
if [ -n "$APP_URL" ]; then
  LINK_SECTION=$'\n'"## 🔗 リンク"$'\n'"- [アプリを開く](${APP_URL})"$'\n'"- [カレンダーに入れる](${APP_URL}?export=all)"$'\n'
fi

if [ -z "$ROWS" ]; then
  CONTENT="# 📋 締切トラッカー"$'\n'"### ${TODAY_JST}の連絡"$'\n\n'
  CONTENT="${CONTENT}## ⏳ ${WINDOW_DAYS}日以内の締切"$'\n'"-# 予定はありません"$'\n'
  CONTENT="${CONTENT}${REP_SECTION}${LINK_SECTION}"
  send_content "$CONTENT"
  send_backup
  exit 0
fi

OVER_LINES=""
STALE_LINES=""
TODAY_LINES=""
SOON_LINES=""
OVERDUE_COUNT=0
STALE_COUNT=0
TODAY_COUNT=0
SOON_COUNT=0
while IFS=$'\x1f' read -r epoch title cat due start allday refep rep id; do
  JDATE=$(fmt_when "$due" "$allday")
  if [ -n "$start" ]; then
    SDATE=$(fmt_when "$start" "$allday")
    # 終日で開始日と締切日が同じなら1つだけ出す
    [ "$SDATE" != "$JDATE" ] && JDATE="${SDATE} 〜 ${JDATE}"
  fi
  REMAIN=$(fmt_remain "$refep" "$epoch" "$start")
  MARK=""
  [ "$rep" != "none" ] && MARK="🔁 "
  ENTRY="- ${MARK}**${title}**　\`${cat}\`"$'\n'"  ${JDATE}　── ${REMAIN}"$'\n'
  # 期限切れ・今日が締切の行だけ、完了リンクを付ける（文字数の上限があるため）
  if [ "$(days_from_today "$epoch")" -le 0 ]; then
    ENTRY="- ${MARK}**${title}**　\`${cat}\`$(done_link "$id")"$'\n'"  ${JDATE}　── ${REMAIN}"$'\n'
  fi
  if [ "$epoch" -lt "$NOW_EPOCH" ]; then
    OVER_LINES="${OVER_LINES}${ENTRY}"
    OVERDUE_COUNT=$((OVERDUE_COUNT+1))
    # 7日以上放置されているものは別途警告する
    ELAPSED=$(( -$(days_from_today "$epoch") ))
    if [ "$ELAPSED" -ge 7 ]; then
      STALE_COUNT=$((STALE_COUNT+1))
      if [ "$STALE_COUNT" -le 3 ]; then
        STALE_LINES="${STALE_LINES}- ${MARK}**${title}**　\`${cat}\`"$'\n'"  $(fmt_when "$due" "$allday") 締切 ── ${ELAPSED}日経過"$'\n'
      fi
    fi
  elif [ "$(days_from_today "$epoch")" -eq 0 ]; then
    # 「今日が締切」は締切日で判断する（期間つきで今日始まり・後日締切のものは入れない）
    TODAY_LINES="${TODAY_LINES}${ENTRY}"
    TODAY_COUNT=$((TODAY_COUNT+1))
  else
    SOON_LINES="${SOON_LINES}${ENTRY}"
    SOON_COUNT=$((SOON_COUNT+1))
  fi
done <<< "$ROWS"

CONTENT="${MENTION}# 📋 締切トラッカー"$'\n'"### ${TODAY_JST}の連絡"$'\n'
if [ "$STALE_COUNT" -gt 0 ]; then
  CONTENT="${CONTENT}"$'\n'"## ⚠️ 長く残っています（${STALE_COUNT}件）"$'\n'"${STALE_LINES}"
  if [ "$STALE_COUNT" -gt 3 ]; then
    CONTENT="${CONTENT}-# ほか $((STALE_COUNT-3)) 件"$'\n'
  fi
  CONTENT="${CONTENT}-# 完了か削除をおすすめします"$'\n'
fi
if [ "$OVERDUE_COUNT" -gt 0 ]; then
  CONTENT="${CONTENT}"$'\n'"## 🔴 期限切れ（${OVERDUE_COUNT}件）"$'\n'"${OVER_LINES}"
fi
if [ "$TODAY_COUNT" -gt 0 ]; then
  CONTENT="${CONTENT}"$'\n'"## ⚡ 今日が締切（${TODAY_COUNT}件）"$'\n'"${TODAY_LINES}"
fi
CONTENT="${CONTENT}"$'\n'"## ⏳ ${WINDOW_DAYS}日以内の締切"
if [ "$SOON_COUNT" -gt 0 ]; then
  CONTENT="${CONTENT}（${SOON_COUNT}件）"$'\n'"${SOON_LINES}"
else
  CONTENT="${CONTENT}"$'\n'"-# 予定はありません"$'\n'
fi
CONTENT="${CONTENT}${REP_SECTION}${LINK_SECTION}"

# 未完了全件の.icsを作って添付する（失敗しても本文だけは必ず送る）
ICS_PATH=""
ICS_NAME=""
if [ "$ATTACH_ICS" = "1" ]; then
  TMP_DIR="${RUNNER_TEMP:-/tmp}"
  printf '%s' "$JSON" > "$TMP_DIR/_digest_data.json"
  ICS_NAME="deadlines-${TODAY_KEY}.ics"
  if python3 "$SCRIPT_DIR/build_ics.py" "$TMP_DIR/_digest_data.json" "$TMP_DIR/$ICS_NAME" "$ICS_DAY_HOUR" >/dev/null 2>&1; then
    ICS_PATH="$TMP_DIR/$ICS_NAME"
    CONTENT="${CONTENT}"$'\n'"📎 下の.icsは長押し→「ファイルに保存」してから開いてください（直接タップすると照会カレンダーになります）"
  fi
fi

if [ -n "$ICS_PATH" ]; then
  send_content "$CONTENT" "$ICS_PATH" "$ICS_NAME" "text/calendar"
else
  send_content "$CONTENT"
fi

send_backup

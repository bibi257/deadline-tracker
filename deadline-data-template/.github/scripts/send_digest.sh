#!/usr/bin/env bash
# 毎朝、近日中の締切をDiscordにまとめて送るスクリプト。
# GitHub Actionsのcronから呼ばれる。ubuntu-latestに標準で入っているcurl/jq/dateだけで動く。
set -euo pipefail

# このスクリプトが置かれているディレクトリ（build_ics.py の場所）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- 設定（ここを書き換えれば他の設定は不要） ------------------------------
# 通知先のDiscordウェブフックURL。
# ※このリポジトリがPublicの場合、このURLは誰でも閲覧できます。
#   悪用されたときはDiscordのチャンネル設定→連携サービス→ウェブフックから削除し、
#   新しいURLを発行してここを書き換えてください。
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
# ---------------------------------------------------------------------------

# 環境変数が指定されていればそちらを優先する（Secretsを使いたくなった場合用）
# 通常はこのリポジトリ内の data.json をそのまま読む。DATA_URLを指定した場合のみHTTP経由で取得する。
DATA_FILE="${DATA_FILE:-data.json}"
WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-$DEFAULT_WEBHOOK_URL}"
WINDOW_DAYS="${WINDOW_DAYS:-$DEFAULT_WINDOW_DAYS}"

MENTION=""
if [ -n "$MENTION_USER_ID" ]; then
  MENTION="<@${MENTION_USER_ID}> "
fi

# 通知先が未設定なら、何もせず理由を表示して終了する（テンプレートのまま実行された場合）
if [ -z "$WEBHOOK_URL" ]; then
  echo "DEFAULT_WEBHOOK_URL が設定されていません。" >&2
  echo "このスクリプトの冒頭に、DiscordのウェブフックURLを記入してください。" >&2
  echo "（チャンネル設定 → 連携サービス → ウェブフック から取得できます）" >&2
  exit 1
fi

# data.json を読み込む(存在しないならその旨だけ送って終了)
JSON=""
if [ -n "${DATA_URL:-}" ]; then
  JSON=$(curl -fsSL "$DATA_URL" 2>/dev/null) || JSON=""
elif [ -f "$DATA_FILE" ]; then
  JSON=$(cat "$DATA_FILE")
fi

if [ -z "$JSON" ] || ! echo "$JSON" | jq -e '.items' >/dev/null 2>&1; then
  curl -sf -H "Content-Type: application/json" \
    -d '{"content":"⚠️ 締切データ(data.json)がまだ同期されていません。アプリの設定タブから「GitHubに同期する」を実行してください。"}' \
    "$WEBHOOK_URL" >/dev/null
  exit 0
fi

NOW_EPOCH=$(date +%s)
WINDOW_EPOCH=$(( NOW_EPOCH + WINDOW_DAYS*86400 ))

# 未完了かつ「期限切れ」または「WINDOW_DAYS以内」の項目を、締切が近い順に抽出
# 未完了かつ「期限切れ」または「WINDOW_DAYS以内」の項目を、締切が近い順に抽出
# 繰り返し(rep)のあるものは「定期予定」として分けて扱う
# 期間つきは開始日を基準に並べる（アプリの表示と揃える）
ROWS=$(echo "$JSON" | jq -r --argjson now "$NOW_EPOCH" --argjson win "$WINDOW_EPOCH" '
  [ .items[]? | select(.done|not)
    | select((.rep // "none") == "none")
    | . + {epoch: (.due | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)}
    | . + {refep: ((.start // .due) | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)}
    | select(.refep <= $win)
  ] | sort_by(.refep) | .[]
  | [ (.epoch|tostring), .title, (.cat // "その他"), .due, (.start // ""), ((.allDay // false)|tostring), (.refep|tostring) ]
  | join("\u001f")
')

# 定期予定。直近の締切日(=次回)が近い順。期間の指定に関わらず全件出す
REP_ROWS=$(echo "$JSON" | jq -r '
  [ .items[]? | select(.done|not)
    | select((.rep // "none") != "none")
    | . + {epoch: (.due | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)}
  ] | sort_by(.epoch) | .[]
  | [ (.epoch|tostring), .title, (.cat // "その他"), .due, .rep, ((.allDay // false)|tostring) ]
  | join("\u001f")
')

# 曜日を日本語で返す
jp_dow(){ case "$(TZ=Asia/Tokyo date -d "$1" +%u)" in
    1) echo 月;; 2) echo 火;; 3) echo 水;; 4) echo 木;;
    5) echo 金;; 6) echo 土;; 7) echo 日;; esac; }

# 日時をJSTで整形する。終日なら時刻を出さない
fmt_when(){  # $1=ISO日時 $2=allDay
  local dow; dow=$(jp_dow "$1")
  if [ "$2" = "true" ]; then
    TZ=Asia/Tokyo date -d "$1" "+%-m/%-d（${dow}）" 2>/dev/null || echo "$1"
  else
    TZ=Asia/Tokyo date -d "$1" "+%-m/%-d（${dow}） %H:%M" 2>/dev/null || echo "$1"
  fi
}
# 残り日数の文言を作る
fmt_remain(){  # $1=基準epoch $2=締切epoch $3=開始があるか
  local ref="$1" due="$2" has_start="$3"
  local today ref_day diff
  today=$(TZ=Asia/Tokyo date +%Y-%m-%d)
  ref_day=$(TZ=Asia/Tokyo date -d "@$ref" +%Y-%m-%d)
  diff=$(( ( $(date -d "$ref_day" +%s) - $(date -d "$today" +%s) ) / 86400 ))
  if [ "$due" -lt "$NOW_EPOCH" ]; then
    local od
    od=$(( ( $(date -d "$today" +%s) - $(date -d "$(TZ=Asia/Tokyo date -d "@$due" +%Y-%m-%d)" +%s) ) / 86400 ))
    if [ "$od" -eq 0 ]; then echo "期限切れ"; else echo "${od} 日 超過"; fi
  elif [ "$diff" -lt 0 ]; then
    echo "進行中"
  elif [ "$diff" -eq 0 ]; then
    echo "今日"
  elif [ -n "$has_start" ]; then
    echo "${diff} 日後に開始"
  else
    echo "${diff} 日後"
  fi
}

# 指定曜日(JST)なら data.json をファイルとして添付し、控えを残す
send_backup(){
  [ "$BACKUP_DOW" = "0" ] && return 0
  [ "$(TZ=Asia/Tokyo date +%u)" = "$BACKUP_DOW" ] || return 0
  local stamp count tmp
  stamp=$(TZ=Asia/Tokyo date +%Y-%m-%d)
  count=$(echo "$JSON" | jq '[.items[]?] | length')
  tmp="/tmp/deadline-backup-${stamp}.json"
  printf '%s' "$JSON" > "$tmp"
  curl -sf \
    -F "payload_json={\"content\":\"🗄️ 週次バックアップ（${stamp} / 全${count}件）　アプリの設定タブ→「JSONを読み込む」で復元できます。\"}" \
    -F "files[0]=@${tmp};filename=deadline-backup-${stamp}.json;type=application/json" \
    "$WEBHOOK_URL" >/dev/null || echo "バックアップの添付に失敗しました" >&2
}

# 定期予定のセクションを組み立てる（次回の締切日を表示）
REP_LINES=""
if [ -n "$REP_ROWS" ]; then
  while IFS=$'\x1f' read -r epoch title cat due rep allday; do
    RDATE=$(fmt_when "$due" "$allday")
    case "$rep" in
      weekly)   RLABEL="毎週" ;;
      biweekly) RLABEL="隔週" ;;
      monthly)  RLABEL="毎月" ;;
      yearly)   RLABEL="毎年" ;;
      *)        RLABEL="$rep" ;;
    esac
    REP_LINES="${REP_LINES}- **${title}**　\`${cat}\`　${RLABEL}"$'\n'"  次は ${RDATE}"$'\n'
  done <<< "$REP_ROWS"
fi

REP_SECTION=""
if [ -n "$REP_LINES" ]; then
  REP_SECTION=$'\n'"## 🔁 定期予定"$'\n'"${REP_LINES}"
fi

TODAY_JST=$(TZ=Asia/Tokyo date "+%-m月%-d日（$(jp_dow now)）")
LINK_SECTION=""
if [ -n "$APP_URL" ]; then
  LINK_SECTION=$'\n'"## 🔗 リンク"$'\n'"- [アプリを開く](${APP_URL})"$'\n'"- [カレンダーに入れる](${APP_URL}?export=all)"$'\n'
fi

if [ -z "$ROWS" ]; then
  CONTENT="# 📋 締切トラッカー"$'\n'"### ${TODAY_JST}の連絡"$'\n\n'
  CONTENT="${CONTENT}## ⏳ ${WINDOW_DAYS}日以内の締切"$'\n'"-# 予定はありません"$'\n'
  CONTENT="${CONTENT}${REP_SECTION}${LINK_SECTION}"
  BODY=$(jq -n --arg c "$CONTENT" '{content: $c}')
  curl -sf -H "Content-Type: application/json" -d "$BODY" "$WEBHOOK_URL" >/dev/null
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
TODAY_KEY=$(TZ=Asia/Tokyo date +%Y-%m-%d)
while IFS=$'\x1f' read -r epoch title cat due start allday refep; do
  JDATE=$(fmt_when "$due" "$allday")
  if [ -n "$start" ]; then
    SDATE=$(fmt_when "$start" "$allday")
    JDATE="${SDATE} 〜 ${JDATE}"
  fi
  REMAIN=$(fmt_remain "$refep" "$epoch" "$start")
  ENTRY="- **${title}**　\`${cat}\`"$'\n'"  ${JDATE}　── ${REMAIN}"$'\n'
  REF_KEY=$(TZ=Asia/Tokyo date -d "@$refep" +%Y-%m-%d)
  if [ "$epoch" -lt "$NOW_EPOCH" ]; then
    OVER_LINES="${OVER_LINES}${ENTRY}"
    OVERDUE_COUNT=$((OVERDUE_COUNT+1))
    # 7日以上放置されているものは別途警告する
    DUE_KEY=$(TZ=Asia/Tokyo date -d "@$epoch" +%Y-%m-%d)
    ELAPSED=$(( ( $(date -d "$TODAY_KEY" +%s) - $(date -d "$DUE_KEY" +%s) ) / 86400 ))
    if [ "$ELAPSED" -ge 7 ]; then
      STALE_COUNT=$((STALE_COUNT+1))
      if [ "$STALE_COUNT" -le 3 ]; then
        STALE_LINES="${STALE_LINES}- **${title}**　\`${cat}\`"$'\n'"  $(fmt_when "$due" "$allday") 締切 ── ${ELAPSED}日経過"$'\n'
      fi
    fi
  elif [ "$REF_KEY" = "$TODAY_KEY" ]; then
    TODAY_LINES="${TODAY_LINES}${ENTRY}"
    TODAY_COUNT=$((TODAY_COUNT+1))
  else
    SOON_LINES="${SOON_LINES}${ENTRY}"
    SOON_COUNT=$((SOON_COUNT+1))
  fi
done <<< "$ROWS"

CONTENT="${MENTION}"$'\n'"# 📋 締切トラッカー"$'\n'"### ${TODAY_JST}の連絡"$'\n'
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
if [ "$ATTACH_ICS" = "1" ]; then
  printf '%s' "$JSON" > /tmp/_digest_data.json
  ICS_STAMP=$(TZ=Asia/Tokyo date +%Y-%m-%d)
  if python3 "$SCRIPT_DIR/build_ics.py" /tmp/_digest_data.json "/tmp/deadlines-${ICS_STAMP}.ics" "$ICS_DAY_HOUR" >/dev/null 2>&1; then
    ICS_PATH="/tmp/deadlines-${ICS_STAMP}.ics"
    CONTENT="${CONTENT}"$'\n'"📎 下の.icsは長押し→「ファイルに保存」してから開いてください（直接タップすると照会カレンダーになります）"
  fi
fi

BODY=$(jq -n --arg c "$CONTENT" --arg uid "$MENTION_USER_ID" '
  {content: $c} + (if $uid == "" then {} else {allowed_mentions: {parse: [], users: [$uid]}} end)')

if [ -n "$ICS_PATH" ]; then
  curl -sf -F "payload_json=${BODY}" \
    -F "files[0]=@${ICS_PATH};filename=deadlines-${ICS_STAMP}.ics;type=text/calendar" \
    "$WEBHOOK_URL" >/dev/null \
    || curl -sf -H "Content-Type: application/json" -d "$BODY" "$WEBHOOK_URL" >/dev/null
else
  curl -sf -H "Content-Type: application/json" -d "$BODY" "$WEBHOOK_URL" >/dev/null
fi

send_backup

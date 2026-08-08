#!/usr/bin/env bash
# 毎朝、近日中の締切をDiscordにまとめて送るスクリプト。
# GitHub Actionsのcronから呼ばれる。ubuntu-latestに標準で入っているcurl/jq/dateだけで動く。
set -euo pipefail

# ---- 設定（ここを書き換えれば他の設定は不要） ------------------------------
# 通知先のDiscordウェブフックURL。
# ※このリポジトリがPublicの場合、このURLは誰でも閲覧できます。
#   悪用されたときはDiscordのチャンネル設定→連携サービス→ウェブフックから削除し、
#   新しいURLを発行してここを書き換えてください。
DEFAULT_WEBHOOK_URL="https://discord.com/api/webhooks/1535447927139467350/-S2MZrillKvNbcwQsHjfCKchHgexdpigK2XwjVYl6P7Iqm0GmfI2AT5-EtJN8k4DU5LR"
# 毎朝メンションで呼び出すユーザーID。メンション不要なら空文字にする
MENTION_USER_ID="1212746144481017908"
# 何日以内の締切を対象にするか
DEFAULT_WINDOW_DAYS="7"
# ---------------------------------------------------------------------------

# 環境変数が指定されていればそちらを優先する（Secretsを使いたくなった場合用）
DATA_URL="${DATA_URL:?DATA_URL is required}"
WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-$DEFAULT_WEBHOOK_URL}"
WINDOW_DAYS="${WINDOW_DAYS:-$DEFAULT_WINDOW_DAYS}"

MENTION=""
if [ -n "$MENTION_USER_ID" ]; then
  MENTION="<@${MENTION_USER_ID}> "
fi

# data.json を取得(存在しない/空ならその旨だけ送って終了)
if ! JSON=$(curl -fsSL "$DATA_URL" 2>/dev/null); then
  curl -sf -H "Content-Type: application/json" \
    -d '{"content":"⚠️ 締切データ(data.json)がまだ同期されていません。アプリの設定タブから「GitHubに同期する」を実行してください。"}' \
    "$WEBHOOK_URL" >/dev/null
  exit 0
fi

NOW_EPOCH=$(date +%s)
WINDOW_EPOCH=$(( NOW_EPOCH + WINDOW_DAYS*86400 ))

# 未完了かつ「期限切れ」または「WINDOW_DAYS以内」の項目を、締切が近い順に抽出
ROWS=$(echo "$JSON" | jq -r --argjson now "$NOW_EPOCH" --argjson win "$WINDOW_EPOCH" '
  [ .items[]? | select(.done|not)
    | . + {epoch: (.due | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)}
    | select(.epoch <= $win)
  ] | sort_by(.epoch) | .[]
  | "\(.epoch)\t\(.title)\t\(.cat // "その他")\t\(.due)"
')

if [ -z "$ROWS" ]; then
  BODY=$(jq -n --arg d "$WINDOW_DAYS日以内の締切はありません。" '{content: $d}')
  curl -sf -H "Content-Type: application/json" -d "$BODY" "$WEBHOOK_URL" >/dev/null
  exit 0
fi

LINES=""
OVERDUE_COUNT=0
while IFS=$'\t' read -r epoch title cat due; do
  # JSTの日付・時刻に整形
  JDATE=$(TZ=Asia/Tokyo date -d "$due" "+%-m/%-d(%a) %H:%M" 2>/dev/null || echo "$due")
  if [ "$epoch" -lt "$NOW_EPOCH" ]; then
    LINES="${LINES}🔴 **${title}**  [${cat}] ${JDATE} ── 期限切れ"$'\n'
    OVERDUE_COUNT=$((OVERDUE_COUNT+1))
  else
    LINES="${LINES}・**${title}**  [${cat}] ${JDATE}"$'\n'
  fi
done <<< "$ROWS"

TODAY_JST=$(TZ=Asia/Tokyo date "+%-m月%-d日(%a)")
HEADER="📋 締切トラッカー：${TODAY_JST} の連絡"
if [ "$OVERDUE_COUNT" -gt 0 ]; then
  HEADER="${HEADER}(期限切れ ${OVERDUE_COUNT}件あり)"
fi

CONTENT="${MENTION}${HEADER}"$'\n\n'"${LINES}"
BODY=$(jq -n --arg c "$CONTENT" --arg uid "$MENTION_USER_ID" '
  {content: $c} + (if $uid == "" then {} else {allowed_mentions: {parse: [], users: [$uid]}} end)')
curl -sf -H "Content-Type: application/json" -d "$BODY" "$WEBHOOK_URL" >/dev/null

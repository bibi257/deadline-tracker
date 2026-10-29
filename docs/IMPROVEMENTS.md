# 改善案の一覧（deadline-tracker）

リポジトリ全体を読んで見つけた課題と、その改善案の記録。コードは変えず、ここに書くのは方針と指示だけ。
実装する人（別の AI を含む）は、取り組む項目の「実装担当への指示文」だけを読めば作業できるように書いてある。

- 画面の見た目・使い勝手の改善案は別ファイル `docs/DESIGN-IMPROVEMENTS.md` にある
- 2回目以降の見直しでは、このファイルを読み、前回からの変化（完了・新規・優先度の変更）を「更新履歴」に書く。完了した項目は消さず、状態を「完了」にして残す

## 更新履歴

| 回 | 日付 | 対象のコミット | 内容 |
|---|---|---|---|
| 1 | 2026-10-29 | `92e10aa`（PR #62 のマージ） | 初回の洗い出し。16件 |

### 第1回の確認結果（参考）

- `npm test`：106件すべて成功。`npm run build`：成功
- 未解決の Issue：0件。開いている PR：Dependabot の #58（actions/checkout 4.4.0 → 7.0.1）・#59（actions/setup-node 4.4.0 → 7.1.0）
- 秘密情報（パスワード・API キー・トークン・Webhook URL）：現在のファイルにも、コミット履歴にも見つからなかった。テストにあるのは見本の値（`test/unit/jobs.test.js`・`test/unit/digest.test.js` の `SECRET-TOKEN` など）だけで、本物ではない
- 読めなかったファイル：なし。ただし非公開リポジトリ `deadline-data`（旧環境の Actions・Python スクリプト）は、このセッションの対象外のため読んでいない

## 状態と重大度の意味

- 状態：未着手／対応中／完了／要確認（事実か、方針を決める必要があるか、まだ確かめていないもの）
- 重大度：高＝データの食い違い・機能の喪失につながる／中＝放っておくと困る・事故の元／低＝余裕があるときでよい

## 一覧

| 番号 | タイトル | 重大度 | 分類 | 状態 |
|---|---|---|---|---|
| 1 | 自動完了が自動取り込みより先に走り、複数端末で同期が止まる | 高 | バグ | 完了 |
| 2 | 夜の再通知・週次レビューを Worker に移植する（Cron の本数上限に注意） | 高 | 使いやすさ | 完了 |
| 3 | キー違いの端末の自動通信で、同じ回線の端末ごと締め出される | 中 | セキュリティ | 完了 |
| 4 | README が旧構成のままで、Cloudflare 版の説明がない | 中 | ドキュメント | 完了 |
| 5 | キャッシュ用の版番号を手で更新している（更新忘れの修正が繰り返し発生） | 中 | 保守性 | 完了 |
| 6 | 世代バックアップをアプリから見て戻す画面がない | 中 | 使いやすさ | 完了 |
| 7 | app.js の中心の処理に単体テストがない | 中 | テスト | 未着手 |
| 8 | .ics・繰り返し・Discord 本文が app.js と Worker で二重実装 | 中 | 保守性 | 未着手 |
| 9 | privacy.html のインライン style が CSP で止められる | 低 | バグ | 完了 |
| 10 | 自動同期のたびに全データを読み直している | 低 | 性能 | 未着手 |
| 11 | API の CORS が全オリジン許可（`*`） | 低 | セキュリティ | 完了 |
| 12 | GitHub Actions の版のばらつきと、Dependabot PR の放置 | 低 | 保守性 | 要確認 |
| 13 | 端末が JST 以外だと、アプリと Worker で日付がずれる | 低 | バグ | 要確認 |
| 14 | snapshots の `at` に索引がない | 低 | 性能 | 完了 |
| 15 | 完了の記録を使った達成カレンダー・実績バッジ（面白機能） | 低 | 使いやすさ | 未着手 |
| 16 | 購読用 .ics の改善（カレンダー名・更新間隔・URL の確認） | 低 | 使いやすさ | 未着手 |

おすすめの着手順：1 → 3 → 2 → 4 → 7 → 5 → 9 → 6 → 8 → 10 以降。
1・3 は小さく直せて効果が大きい。2 は段階4（本番切り替え）の前に必要。

---

## 1. 自動完了が自動取り込みより先に走り、複数端末で同期が止まる

- 重大度：高
- 分類：バグ
- 状態：完了（起動・画面復帰・10分ごとの順序を「取り込み → 自動完了」にした。`refreshThenAutoComplete()`。実機での確認はまだ）

**問題の内容と該当箇所**

起動時の処理が `app.js:3985` で `load(); autoCompleteOverdueItems();` → `app.js:3990` で `autoPullIfStale()` の順になっている。
「期限を過ぎたら自動で完了」の予定（`autoComplete`）が過ぎていると、`autoCompleteOverdueItems()`（`app.js:3740`）が先に `save()` して `db.updatedAt` を更新する。
その後の自動取り込み `autoPullWith()` は `localChanged=(localAt!==known)`（`app.js:2503`）で「この端末に未同期の変更がある」と判断し、他の端末の新しい内容を取り込まない（「自動反映していません」のトースト）。
3秒後の自動同期も、保存先の rev が進んでいるため 409 で止まる（`app.js:940` の `runAutoSync`）。
10分ごとの `setInterval`（`app.js:3989`）でも同じことが起きる。

**なぜ問題なのか**

自動完了の予定は毎週・毎日のように過ぎるので、端末を2台以上使うと「どちらの端末にも未同期の変更がある」状態が日常的に起きる。
同期が止まるたびに手動で読み込みか上書きを選ぶ必要があり、上書きを選ぶと他の端末の編集が消える（世代バックアップには残る）。

**改善案**

- 起動時と画面復帰時は、先に自動取り込み（`autoPullIfStale()` の Promise）を待ってから `autoCompleteOverdueItems()` を実行する。取り込みが失敗・不要でも、終わったら自動完了を行う
- さらに、自動完了だけの変更は「取り込みを妨げる変更」とみなさない方法も検討する。例：自動完了は保存先から取り込んだ直後に、取り込んだデータに対して改めて実行する（同じ締切は同じ結果になるので、端末間で食い違わない）

**実装担当への指示文**

> 目的：締切トラッカー（`app.js`、ES5 風の素の JavaScript、フレームワークなし）で、自動完了の処理が他の端末の更新の自動取り込みを妨げないようにする。
> 対象ファイル：`app.js`（起動処理は末尾 3980 行付近、`autoCompleteOverdueItems` は 3740 行付近、`autoPullIfStale`/`autoPullWith` は 2468〜2535 行付近、画面復帰の `visibilitychange` は 3959 行付近）、テストは `test/unit/cf-sync.test.js`（app.js の関数を `test/support/appFns.js` で取り出して vm で動かす方式）。
> やること：
> 1. 起動時に `autoCompleteOverdueItems()` を `autoPullIfStale()` の完了後（成功・失敗どちらでも）に呼ぶよう順序を変える。`render()` は先に一度呼んでよい（画面を早く出すため）。`handleDoneParam(_pullDone)` の動きは変えない
> 2. 画面復帰（`visibilitychange`）と 10 分ごとのタイマーでも、取り込み → 自動完了の順にする。1分ごとの `autoCompleteOverdueItems()` は、取り込み中（Promise が未完了の間）は呼ばない
> 3. `test/unit/cf-sync.test.js` に、「端末Aで自動完了→同期済みの状態で、端末Bを起動すると、Bは A の内容を自動で取り込み、409 にならない」ことを確かめるテストを足す（既存の `world()` を使う）
> 4. `index.html` の `app.js?v=...` と `build-stamp` を新しい日時に更新する
> 完了の条件：`npm test` と `npm run build` が成功する。追加したテストが、修正前のコードでは失敗し、修正後は成功する。コミットメッセージは `fix: 要約`（日本語）。ユーザーに見える文言は日本語。

**関連する項目**：7（テストの追加）、10（同期の通信）

---

## 2. 夜の再通知・週次レビューを Worker に移植する（Cron の本数上限に注意）

- 重大度：高
- 分類：使いやすさ（機能の移植）
- 状態：完了（Cron は3本にまとめた。時刻の変更と、月曜の data.json 添付を移植しないことは持ち主に確認済み。本番での実際の送信は未確認）

**問題の内容と該当箇所**

旧環境の `send_digest.sh`（雛形は `deadline-data-template/.github/scripts/send_digest.sh`）には3種類の Discord 通知がある。

- 朝（毎日 6:47）
- 夜の再通知（月〜土 20:47。`DIGEST_MODE=evening`、同ファイル 482〜530 行付近）
- 週次レビュー（日曜 21:45。`DIGEST_MODE=weekly`、`send_weekly_review`、273〜474 行付近）

Worker（`worker/src/jobs.js`・`worker/src/digest.js`）には朝の分しかない。
`docs/cloudflare-migration.md` の段階4では「Cron を有効にして旧 Actions を止める」予定だが、このままだと夜の再通知と週次レビュー（来週の見通し・1週間の達成・繰り返しの調子・負荷予報・月初めの支出まとめ）がなくなる。
月曜の朝の data.json 添付（`send_backup`）も Worker にない。

Cron Triggers は無料プランで**アカウント全体で5本まで**（[Cloudflare Workers の制限](https://developers.cloudflare.com/workers/platform/limits/)）。このWorkerだけで既に4本使っている（`wrangler.jsonc:31`）ので、2本足すと上限を超える。同じアカウントの他の Worker（例：`tournament`）が Cron を使っていれば、さらに余裕がない（要確認）。

**なぜ問題なのか**

段階4で旧 Actions を止めた日から、夜の再通知と週次レビューが届かなくなる。
Cron を単純に足すと、デプロイが失敗するか、他の Worker の Cron と取り合いになる。

**改善案**

Cron の本数を増やさず、時刻をまとめて3本に減らす（1本で複数の仕事をする）。

| Cron（UTC） | JST | する仕事 |
|---|---|---|
| `47 21 * * *` | 毎日 6:47 | 朝の締切一覧（今と同じ） |
| `23 11 * * *` | 毎日 20:23 | 翌日分のメール ＋ 月〜土は夜の再通知、日曜は週次レビュー |
| `23 20 * * *` | 毎日 5:23 | 当日分のメール ＋ 世代バックアップの間引き |

夜の再通知は 20:47 から 20:23 に、週次レビューは 21:45 から 20:23 に早まる。変更が困る場合は相談する。
1つの仕事が失敗しても、同じ Cron の他の仕事は実行し、最後にまとめて失敗として投げる（ダッシュボードの履歴に残るように）。

月曜の data.json 添付は、D1 の世代バックアップ（毎日 3:10 に間引き、30分間隔で保存）があるため、移植しない案を推す。
添付すると Discord にメモを含む全データが毎週置かれる点も、移植しない理由になる（要確認：移植しないでよいか、持ち主に確認する）。

**実装担当への指示文**

> 目的：旧環境の bash スクリプトにある「夜の再通知」と「週次レビュー」を、Cloudflare Worker（`worker/src/`、外部依存なし）に移植する。文面は旧スクリプトと1文字まで同じにする。Cron Triggers の本数は増やさない。
> 対象ファイル：`worker/src/digest.js`（朝の一覧 `buildDigest`、分割 `splitForDiscord`、送信 `postDiscord`）、`worker/src/jobs.js`（Cron の振り分け `runScheduled`）、`worker/src/index.js`（確認用 API）、`wrangler.jsonc`（`triggers.crons`）、`test/unit/digest.test.js`・`test/unit/jobs.test.js`、`test/expected/`、`docs/cloudflare-migration.md`。正解の文面の元は `deadline-data-template/.github/scripts/send_digest.sh`（`DIGEST_MODE=evening` と `send_weekly_review`）。
> やること：
> 1. 正解の文面を作る。`DATA_FILE=test/fixtures/data.json DRY_RUN=1 NOW="<JST の日時>" DIGEST_MODE=evening bash deadline-data-template/.github/scripts/send_digest.sh` のように実行して、標準出力を `test/expected/digest-evening.txt` に保存する。週次は `DIGEST_MODE=weekly` で日曜の日時を使い `test/expected/digest-weekly.txt` に保存する。支出まとめの節を確かめるため、月の1〜7日の日曜の分も作る。`test/fixtures/data-long.json` でも作る。メンション・APP_URL は既存の `digest-daily.txt` を作ったときと同じ設定にそろえる（`test/unit/digest.test.js` の冒頭を参照）。bash と jq が必要
> 2. `worker/src/digest.js` に `buildEvening(data, opts)`（0件なら null）と `buildWeekly(data, opts)`（2通分の本文の配列）を足す。閾値 `LOAD_WARN=6`・`CAT_WARN=3`、支出のカテゴリ「サブスクなど」は定数にする。完了の記録（`data.completions`）と `expCarry` の扱いは bash 版の jq と同じ規則にする
> 3. `worker/src/jobs.js` で、`23 11 * * *`（JST 20:23）のときは、メールの送信のあとに、JST の曜日が日曜なら週次レビュー、それ以外なら夜の再通知を送る。`23 20 * * *`（JST 5:23）のときは、メールのあとに `runMaintenance` を実行する。`10 18 * * *` はやめる。どれかが失敗しても残りは実行し、最後に例外を投げる
> 4. `wrangler.jsonc` の `crons` を `["47 21 * * *", "23 11 * * *", "23 20 * * *"]` の3本にし、コメントの時刻の説明も直す
> 5. 確認用 API を足す（`GET /api/digest?kind=evening|weekly` で本文を返す。認証は既存の `authorize` を通す。送信の POST も同様）。認証のない API は増やさない
> 6. テスト：手順1の正解と `buildEvening`/`buildWeekly` の出力が一致すること、`runScheduled` が曜日で振り分けること、1つの仕事が失敗しても他が実行されることを確かめる
> 7. `docs/cloudflare-migration.md` の段階3に「3d：夜の再通知・週次レビュー」を足し、Cron の表を更新する。月曜の data.json 添付は移植しない、と書く（持ち主の確認が取れていなければ「要確認」と書く）
> 制約：Worker の CPU 時間は 10ms 以内（無料プラン）。D1 の読み込みは1回の Cron につき締切データ1行だけにする。秘密（Webhook URL など）をログやエラー文に出さない。メンションは `allowed_mentions` で指定ユーザーだけに限る（既存の `discordBodies` を使う）。
> 完了の条件：`npm test` と `npm run build` が成功する。追加した正解ファイルと Worker の出力が一致する。コミットメッセージは `feat: 要約`。

**関連する項目**：4（README の更新）、8（二重実装）

---

## 3. キー違いの端末の自動通信で、同じ回線の端末ごと締め出される

- 重大度：中
- 分類：セキュリティ（使いやすさにも影響）
- 状態：完了（アプリは 401 で自動の通信を止めて一度だけ知らせる。Worker は正しいキーの成功でその IP の失敗の記録を消す。実機での確認はまだ）

**問題の内容と該当箇所**

Worker は認証の失敗を IP ごとに数え、10分に10回失敗するとその IP からの要求を 429 で止める（`worker/src/index.js:118-133`）。
アプリは、保存したアクセスキーが古い（`APP_KEY` を変えた・打ち間違えた）端末でも、10分ごとと画面復帰のたびに `/api/data` を読みに行く（`app.js:3994`・`3959` → `autoPullWith`）。
失敗は `.catch(function(){})` で黙って捨てられ、利用者には何も表示されない（`app.js:2477` 付近）。

**なぜ問題なのか**

自宅の Wi-Fi のように IP を共有していると、古いキーの端末1台が失敗を重ねるだけで、正しいキーの端末も 10 分間使えなくなる。
しかも原因が画面に出ないので、気づきにくい。

**改善案**

- アプリ：自動処理で 401 を受けたら、その起動中は自動の通信（自動取り込み・自動同期）を止め、「アクセスキーが違います。設定で入れ直してください」を1回だけ表示する。429 のときも理由を表示する
- Worker：今の仕組み（総当たりへの対策）は残す。ただし、正しいキーで認証できたときは、その IP の失敗回数を消す（`DELETE FROM limits WHERE k = ?`）。D1 への書き込みを増やさないよう、失敗の記録があるときだけ消す

**実装担当への指示文**

> 目的：アクセスキーが間違っている端末が自動通信で認証失敗を重ね、同じ IP の正しい端末まで 429 で締め出されるのを防ぐ。
> 対象ファイル：`app.js`（`cfFetchData` 2400 行付近、`autoPullWith` 2472 行付近、`runAutoSync` 940 行付近）、`worker/src/index.js`（`authorize` 118 行付近、`isLimited`・`countHit`）、テストは `test/unit/worker.test.js`・`test/unit/cf-sync.test.js`。
> やること：
> 1. `app.js`：Cloudflare の自動処理（自動取り込み・自動同期）で 401 を受けたら、モジュール内の変数で「認証失敗」を覚え、ページを開き直すか設定でキーを保存し直すまで自動の通信をしない。トーストは1回だけ「アクセスキーが違うため、自動の読み込み・同期を止めました。設定（右上の歯車）で入れ直してください」。429 なら「認証の失敗が続いたため、しばらく使えません」を1回だけ
> 2. `worker/src/index.js`：認証に成功したとき、`isLimited` で読んだ行（失敗の記録）があれば、その IP の行を消す。記録がないときは D1 に書き込まない
> 3. テスト：Worker 側で「9回失敗→正しいキーで成功→さらに9回失敗しても 429 にならない」、アプリ側で「401 を受けた後は自動取り込みが fetch しない」を確かめる
> 4. `index.html` の `app.js?v=...` と `build-stamp` を更新する
> 制約：キーやトークンをログ・画面に出さない。認証のない API を増やさない。
> 完了の条件：`npm test` と `npm run build` が成功する。コミットメッセージは `fix: 要約`。

**関連する項目**：なし

---

## 4. README が旧構成のままで、Cloudflare 版の説明がない

- 重大度：中
- 分類：ドキュメント
- 状態：完了（README を Cloudflare 版中心に書き直し、旧構成は「旧環境」の節に移した。シークレット名・Cron・API のパスはコードと照合済み。項目6で画面ができたので、復元手順を更新した）

**問題の内容と該当箇所**

`README.md` は GitHub Pages ＋ 非公開リポジトリ `deadline-data` ＋ GitHub Actions の構成だけを説明している。

- 冒頭の図（7〜13 行）
- 「構成」（137〜179 行）
- 「技術構成」（181〜189 行）
- 「セットアップ」（193〜241 行）
- 「データとバックアップ」（307〜318 行）

Cloudflare Worker・D1・アクセスキー・購読 URL `/ics/<トークン>.ics`・世代バックアップについての記述がない（「Cloudflare」「Worker」の語は1回だけ）。
説明は `docs/cloudflare-migration.md` と `worker/src/index.js` の冒頭のコメントに散らばっている。
CSP の説明（README 348 行）の「通信先は GitHub・Discord だけ」も、Worker から配信するときの同じオリジンへの通信を書いていない。

**なぜ問題なのか**

自分で細部を把握していない部分があるため、どこに何があるかをコードから探すことになる。
障害時（キーをなくした・データを戻したい）の手順が、どこにも書かれていない。

**改善案**

README を「今の構成（Cloudflare）」中心に書き直し、旧構成（GitHub Pages）は「移行が終わるまでの旧環境」として短い節にまとめる。
次の節を足す。

- 構成図
- シークレットの一覧（名前と用途だけ。値は書かない）
- API の一覧
- Cron の時刻
- 復元手順（世代バックアップ・JSON）
- アクセスキーを変えるときの手順

**実装担当への指示文**

> 目的：README を現在の構成（Cloudflare Workers + D1）に合わせ、持ち主が README だけで構成・設定・復旧の手順を把握できるようにする。
> 対象ファイル：`README.md`。参照元：`docs/cloudflare-migration.md`、`worker/src/index.js` 冒頭のコメント（API の一覧）、`worker/src/jobs.js`（Cron）、`worker/src/mail.js`・`worker/src/jobs.js` の `readConfig`（シークレット名）、`wrangler.jsonc`、`CLAUDE.md`。
> やること：
> 1. 冒頭の説明と図を「アプリ（Worker から配信）→ Worker の API → D1」「Cron → Discord／Gmail」「購読 .ics」に直す
> 2. 「構成」に `worker/src/` の各ファイルの役割、`scripts/build.mjs`・`web/`（生成物）、`test/` を書く
> 3. 「Cloudflare の設定」節：シークレットの名前と用途の表（`APP_KEY`、`FEED_TOKEN`、`DISCORD_WEBHOOK_URL`、`DISCORD_USER_ID`、`APP_URL`、`DONE_LINKS`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN`、`MAIL_TO`、`MAIL_FROM`）。値は絶対に書かない
> 4. 「API」節（`/api/health` 以外は `Authorization: Bearer` が必要）と「定時の処理」節（Cron の時刻を JST で）
> 5. 「バックアップと復元」節：D1 の世代バックアップ（30分間隔、間引きの規則）、`GET /api/snapshots` で一覧を見る手順、JSON の書き出し・読み込み
> 6. 「アクセスキーを変える」手順（Cloudflare のシークレットを変える → 各端末の設定で入れ直す）
> 7. 旧構成の説明は「旧環境（GitHub Pages・deadline-data）」の節に移し、「移行が終わるまで残す」と書く。CSP の説明に、Worker 配信時は同じオリジン（`'self'`）の `/api/` に通信することを足す
> 8. 項目2（夜の再通知・週次レビューの移植）が終わっていなければ、その旨を「未移植」として書く
> 完了の条件：README の内容が実際のコード・設定と一致している（シークレット名・Cron の時刻・API のパスを、ソースと照らし合わせて確認する）。秘密の値や個人の締切データを書いていない。コミットメッセージは `docs: 要約`。

**関連する項目**：2、6

---

## 5. キャッシュ用の版番号を手で更新している（更新忘れの修正が繰り返し発生）

- 重大度：中
- 分類：保守性
- 状態：完了（Worker 配信の `web/` はビルドが自動で書き換える。ルートの手作業は GitHub Pages をやめるまで残る。build-stamp は「版の日時（画面のファイルを最後に変えたコミットの日時）・ハッシュ・説明」にした）

**問題の内容と該当箇所**

`app.js`・`styles.css` を変えるたびに、手で次の値を変える決まりになっている（`index.html:18-20` のコメント）。

- `index.html:118` の `app.js?v=...`
- `index.html:33` の `styles.css?v=...`
- `index.html:20` の `build-stamp`
- 必要なら `service-worker.js:7` の `CACHE_NAME`

更新を忘れた修正のコミットが繰り返し出ている（`e6b5142 fix: app.js の v を更新する`、`6d771e3 app.js の v を更新する`）。
今も `styles.css?v=20261027-0300` と `app.js?v=20261027-1200` で値がそろっていない。
同じ指摘が繰り返し残るのは、手作業に頼る仕組みそのものが原因。

**なぜ問題なのか**

更新を忘れると、古い `app.js` がブラウザに残り、直したはずの不具合が端末で直らない。
レビューでも毎回同じ点を見る手間が増える。

**改善案**

Worker から配信するファイルは `scripts/build.mjs` が `web/` に写しているので、写すときに内容のハッシュ（例：SHA-256 の先頭10文字）で `?v=` と `build-stamp` と `CACHE_NAME` を自動で書き換える。
ルート（GitHub Pages 用）のファイルは手作業のまま残るが、移行後（段階5）に Pages をやめれば手作業はなくなる。
CI に「ルートの `?v=` が変わっていないのに `app.js` が変わった PR は失敗」という検査を足す案もある（移行が終わるまでの保険）。

**実装担当への指示文**

> 目的：`app.js`・`styles.css` の変更時に、キャッシュ対策の版番号を手で更新しなくてよいようにする。
> 対象ファイル：`scripts/build.mjs`（画面のファイルを `web/` に写すスクリプト。`web/` は生成物でコミットしない）、`test/unit/build.test.js`。ルートの `index.html`・`service-worker.js` は変えない（GitHub Pages の旧環境が使っている）。
> やること：
> 1. `scripts/build.mjs` で `app.js`・`styles.css` の内容の SHA-256（`node:crypto`）の先頭10文字を求める。`web/index.html` の `app.js?v=...`・`styles.css?v=...` をそのハッシュに置き換える
> 2. `web/index.html` の `<meta name="build-stamp" content="...">` を「ビルドした日時（JST）＋ハッシュ」に置き換える。`web/service-worker.js` の `CACHE_NAME` を `deadline-tracker-<ハッシュ>` に置き換える
> 3. 置き換え対象が見つからないときは例外でビルドを失敗させる（黙って古い値のまま出さない）
> 4. `test/unit/build.test.js` に、置き換えの関数を直接呼んで期待どおりの文字列になることを確かめるテストを足す（ファイルを作るのは直接実行したときだけ、という今の作りを保つ）
> 5. `index.html` のコメント（18〜19 行）に「Worker 配信分はビルドで自動。ルートは GitHub Pages 用で、移行が終わるまで手で更新」と書き足す（コメントの変更は可）
> 制約：外部の npm パッケージを足さない（Node の標準モジュールだけ）。
> 完了の条件：`npm test` と `npm run build` が成功し、`web/index.html` の `?v=` がハッシュになっている。コミットメッセージは `build: 要約`。

**関連する項目**：9（同じ `build.mjs` を触る）

---

## 6. 世代バックアップをアプリから見て戻す画面がない

- 重大度：中
- 分類：使いやすさ
- 状態：完了（設定の「バックアップと復元」に一覧・中身の確認・「この時点に戻す」を足した。戻す前の内容も世代バックアップに残る。実機での確認はまだ）

**問題の内容と該当箇所**

Worker は保存のたびに世代バックアップ（snapshots）を残し、`GET /api/snapshots`・`GET /api/snapshots/:id` で読める（`worker/src/index.js:235-245`）。
アプリにはそれを使う画面がなく（`app.js` に `snapshots` の記述がない）、戻すには `curl` などで API を直接呼ぶ必要がある。

**なぜ問題なのか**

上書きの事故（項目1の競合で「上書き」を選んだときなど）から戻す手段が、実質的に使えない。

**改善案**

設定画面の「バックアップと復元」に「Cloudflare の世代バックアップ」を足す。一覧（日時・版・大きさ）を出し、選ぶと中身の件数とタイトルの先頭数件を見せ、確認のうえで「この時点に戻す」。
戻すときは、今の内容も必ず世代バックアップに残す（`PUT /api/data?backup=1` を使う）。

**実装担当への指示文**

> 目的：Cloudflare に保存している世代バックアップを、アプリの設定画面から一覧・確認・復元できるようにする。
> 対象ファイル：`app.js`（設定画面 `renderSettings` 1981 行付近の「バックアップと復元」、Cloudflare 用の `cfConfigFor`・`cfFetchData`・`cfPut` 2393〜2436 行付近）、`styles.css`、テストは `test/unit/cf-sync.test.js`。Worker 側の API（`/api/snapshots`）は既にあるので変えない。
> やること：
> 1. Cloudflare から配信されているとき（`CF===true`）だけ、設定の「バックアップと復元」に「世代バックアップ（Cloudflare）」の一覧を出す。日時は JST の「YYYY/M/D HH:MM」、大きさは KB。読み込みは、ボタンを押したときだけにする（設定を開くたびに API を呼ばない）
> 2. 1件を選ぶと `GET /api/snapshots/:id` で中身を読み、締切の件数とタイトルの先頭5件を表示する
> 3. 「この時点に戻す」は `confirm` で確認してから、読み込んだ内容を `sanitizeIncomingItems` で検査し、`cfPut` を `cfg.backup=true`（`?backup=1`）で呼んで保存する。成功したら画面のデータも置き換え、`cf-known-rev` を更新する
> 4. エラー（401・404・通信の失敗）は画面に理由を出す。トークンは出さない
> 5. テスト：復元の流れ（一覧 → 中身 → 保存で `?backup=1` が付く）を `test/unit/cf-sync.test.js` の `world()` で確かめる
> 6. `index.html` の `app.js?v=...`・`styles.css?v=...`・`build-stamp` を更新する
> 完了の条件：`npm test` と `npm run build` が成功する。ユーザーに見える文言は日本語。コミットメッセージは `feat: 要約`。

**関連する項目**：4（README の復元手順）

---

## 7. app.js の中心の処理に単体テストがない

- 重大度：中
- 分類：テスト
- 状態：未着手

**問題の内容と該当箇所**

`app.js`（約4000行）で単体テストがあるのは、同期まわり（`test/unit/cf-sync.test.js`）とカレンダーの負荷（`test/unit/calendar-load.test.js`）の一部だけ。
次の処理にはテストがない。

- クイック入力の解析 `parseQuick`（`app.js:1329`）
- 繰り返しの前進 `advanceRepeating`（3348）
- 次の回の計算 `nextOccurrence`（3760）
- 展開 `expandOccurrences`（3773）
- 完了と EXP の計算 `logCompletion`・`applyCompletionCore`（3305〜3346）
- アプリ側の .ics `veventOf`・`buildICS`（438・532）
- 残り日数の表示 `remainText`（245）

テストが関数を取り出す方法（`test/support/appFns.js` の `extractFunction`）は「行頭の `\n}` まで」を関数の終わりとみなすため、書き方が変わると静かに壊れる。

**なぜ問題なのか**

日付・繰り返しの計算は月末・うるう年・取りやめた回などの境目で間違えやすく、AI に書かせた部分ほど、細部の把握が難しい。
二重実装（項目8）がずれても気づけない。

**改善案**

上の関数ごとに、境目のケースを含む表形式のテストを足す。
`extractFunction` は、取り出したソースを `vm` で実行できなければ失敗するので、取り出し範囲の誤りはテストの失敗として表に出る。念のため「関数が1つだけ定義されたこと」も確かめる。

**実装担当への指示文**

> 目的：`app.js` の日付・繰り返し・入力解析・完了の計算に単体テストを足し、壊れたら気づけるようにする。コードの動きは変えない（テストだけを足す）。
> 対象ファイル：新しく `test/unit/app-logic.test.js` を作る。取り出しの仕組みは `test/support/appFns.js` の `loadAppFunctions(names, globals)`（関数名を指定して vm に読み込む）を使う。対象の関数：`parseQuick`、`toHalfWidth`、`nextOccurrence`、`advanceRepeating`、`anchorDayOf`、`expandOccurrences`、`upcomingDue`、`logCompletion`、`applyCompletionCore`、`rewardOf`、`levelOf`、`remainText`、`statusOf`、`veventOf`、`buildICS`（依存する関数・変数もあわせて読み込むか、globals で渡す）。
> やること：
> 1. 時刻は固定する（`Date` を差し替えるか、関数に now を渡す）。タイムゾーンは `process.env.TZ='Asia/Tokyo'` をテストの最初で設定する
> 2. `nextOccurrence`/`advanceRepeating`：1/31 の毎月（2月は月末に丸め、3月は31日に戻る）、2/29 の毎年、隔週、`repCount` が 1（最終回）、`skip` に次の回が入っている場合
> 3. `expandOccurrences`：無期限で古い締切から表示範囲まで送れること、回数指定の上限、取りやめた回が出ないこと
> 4. `parseQuick`：README の「1行クイック入力」の例（「明日 17時 レポート提出」「毎週水曜 17:00 バイト #バイト」）と、入力欄の「書き方の例」にある書き方を表にして確かめる
> 5. `logCompletion`：前倒し・期限内・遅れ・自動の EXP（`app.js:3313` 付近の規則）
> 6. `buildICS` と Worker の `worker/src/ics.js` の `buildIcs`：同じデータで、UID・RRULE・EXDATE・VALARM の行が一致することを確かめる（差があれば、テストに「既知の差」として注記し、項目8で直す）
> 完了の条件：`npm test` が成功する。追加したテストは `app.js` を変えずに通る（通らない場合はバグの可能性があるので、テストを `{ todo: '…' }` にして内容をこのファイル `docs/IMPROVEMENTS.md` に新しい項目として報告する）。コミットメッセージは `test: 要約`。

**関連する項目**：1、8

---

## 8. .ics・繰り返し・Discord 本文が app.js と Worker で二重実装

- 重大度：中
- 分類：保守性
- 状態：未着手

**問題の内容と該当箇所**

同じ規則が2か所にある。

- .ics：アプリの `veventOf`・`buildICS`（`app.js:438-537`）と Worker の `worker/src/ics.js`
- 繰り返し：アプリの `nextOccurrence`（`app.js:3760`）と Worker の `worker/src/recurrence.js`
- Discord の本文：アプリの `buildDigestText`・`sendToDiscord`（`app.js:2650`・`2717`）と Worker の `worker/src/digest.js`

さらに旧環境の Python 版（`deadline-data`）もある。
アプリは端末の時刻（ローカル時刻）、Worker は JST 固定で計算している（項目13）。

**なぜ問題なのか**

片方だけ直すと、ダウンロードした .ics と購読中のカレンダーの予定がずれる（UID が同じでも中身が違う）。
Discord の「今すぐ送る」と毎朝の通知の文面が違うものになる。

**改善案**

- 段階的に、Worker の実装を「正」にする
- Cloudflare から配信しているときは、アプリの「カレンダーへ（全件）」「Discord へ今すぐ送る」を Worker の API（`GET /api/ics`、`POST /api/digest`）に任せる
- 1件ずつの .ics の書き出しなど、オフラインで要る機能だけアプリに残し、項目7の一致テストで守る
- GitHub Pages の旧環境をやめた後（段階5）、アプリ側の Discord 送信のコード（Webhook URL の端末保存を含む）を消す

**実装担当への指示文**

> 目的：Cloudflare 版では、.ics の全件書き出しと Discord への手動送信を Worker の API に任せ、規則の二重管理を減らす。
> 前提：項目7（`buildICS` と Worker の `buildIcs` の一致テスト）が先に終わっていること。
> 対象ファイル：`app.js`（`downloadICS` 538 行付近、`handleExportParam` 3858 行付近、`sendToDiscord` 2717 行付近、設定画面の Discord の節）、`worker/src/index.js`（`GET /api/ics`、`POST /api/digest` は既にある）。
> やること：
> 1. `CF===true` で、アクセスキーを保存しているときは、「全件」「表示中まとめて」の .ics を `GET /api/ics`（メモあり）から取ってダウンロードさせる。表示中まとめては、件数が全件と違うならアプリ側の `buildICS` のままでよい。オフライン・失敗時はアプリ側の `buildICS` に戻す
> 2. 同じ条件で「Discord へ今すぐ送る」を `POST /api/digest` に切り替え、端末に Webhook URL が無くても送れるようにする。GitHub Pages から開いたときは今までどおり
> 3. 切り替えた分のテストを `test/unit/cf-sync.test.js` に足す
> 4. GitHub Pages の旧環境をやめた後に消すコード（`buildDigestText`、Webhook URL の端末保存など）の一覧を `docs/cloudflare-migration.md` の段階5に書く（この作業では消さない）
> 5. `index.html` の `app.js?v=...`・`build-stamp` を更新する
> 完了の条件：`npm test` と `npm run build` が成功する。コミットメッセージは `feat: 要約`。

**関連する項目**：7（先に必要）、2、13

---

## 9. privacy.html のインライン style が CSP で止められる

- 重大度：低
- 分類：バグ
- 状態：完了（`privacy.css` に移した。実機・本番での表示確認はまだ）

**問題の内容と該当箇所**

`privacy.html:7` に `<style>` 要素がある。
一方、`scripts/build.mjs:200-209` の `buildHeaders` が作る `web/_headers` は、全ページ（`/*`）に index.html と同じ CSP（`style-src-elem 'self' https://fonts.googleapis.com`）を付ける。
インラインの `<style>` は許されないので、Worker から配信した `/privacy.html` は装飾（幅・行間・ダークモードの色）なしで表示されるはず。

**なぜ問題なのか**

Google の OAuth の審査で見られるページで、読みにくくなる。致命的ではない。

**改善案**

`privacy.html` のスタイルを `privacy.css`（新しいファイル）に移して `<link>` で読み込み、`build.mjs` の写すファイルに足す。

**実装担当への指示文**

> 目的：Worker から配信したプライバシーポリシーのページで、CSP にスタイルを止められないようにする。
> 対象ファイル：`privacy.html`、新しく `privacy.css`、`scripts/build.mjs`（`files` の配列）、`test/unit/build.test.js`。
> やること：
> 1. `privacy.html` の `<style>`〜`</style>` の中身をそのまま `privacy.css` に移し、`<link rel="stylesheet" href="privacy.css">` に置き換える
> 2. `scripts/build.mjs` の `files` に `privacy.css` を足す
> 3. `test/unit/build.test.js` に「`privacy.html` に `<style` が無い」「`web/privacy.css` ができる」を足す
> 4. 可能なら `npx wrangler dev` か静的サーバーで `web/` を開き、`/privacy.html` に装飾が付くことを確かめる（できなければ省略してよい）
> 完了の条件：`npm test` と `npm run build` が成功する。コミットメッセージは `fix: 要約`。

**関連する項目**：5

---

## 10. 自動同期のたびに全データを読み直している

- 重大度：低
- 分類：性能
- 状態：未着手

**問題の内容と該当箇所**

自動同期 `runAutoSync`（`app.js:940`）は、送る前に `fetchRemoteState` → Cloudflare では `cfFetchData`（`app.js:1007`・`2400`）で締切データ全体を GET してから PUT する。
Cloudflare の PUT は `If-Match`（rev）で衝突を検出できるので、先の GET は判定に使う rev を知るためだけになっている。
また Worker の `GET /api/data` は保存してある JSON 文字列を `JSON.parse` してから `JSON.stringify` し直して返す（`worker/src/index.js:186`）。

**なぜ問題なのか**

今のデータの大きさなら問題ない。ただし保存できる上限（約1.9MB）に近づくと、通信量が2倍になり、Worker の CPU 時間（無料プランは 10ms）を JSON の解析・再変換が圧迫する。

**改善案**

- Cloudflare の自動同期は、手元の `cf-known-rev` を `If-Match` に付けて直接 PUT し、409 のときだけ今の流れ（止めて知らせる）にする
- Worker の GET は、保存してある JSON 文字列をそのまま応答の中に埋め込む（`'{"ok":true,"rev":' + rev + ',"data":' + row.json + ...`）

**実装担当への指示文**

> 目的：Cloudflare 同期の通信量と Worker の CPU 時間を減らす。動き（衝突したら止めて知らせる）は変えない。
> 対象ファイル：`app.js`（`runAutoSync` 940 行付近の `checkedPut`）、`worker/src/index.js`（`getData` 183 行付近）、テストは `test/unit/cf-sync.test.js`・`test/unit/worker.test.js`。
> やること：
> 1. `runAutoSync` で `cfg.kind==="cf"` のときは、`fetchRemoteState` を呼ばずに `cfPut` する。`cf-known-rev` が無い端末は今までどおり送らない（自動同期の対象外）
> 2. `getData` は `JSON.parse` せず、`row.json` の文字列をそのまま組み立てた JSON 文字列の中に入れて返す（`updatedAt` は `JSON.stringify` して入れる）。ヘッダーは今の `json()` と同じにする
> 3. 既存のテストがすべて通ることと、409 のときに自動で上書きしないことのテストがあることを確かめる（無ければ足す）
> 4. `index.html` の `app.js?v=...`・`build-stamp` を更新する
> 完了の条件：`npm test` と `npm run build` が成功する。コミットメッセージは `fix: 要約`（または `feat:`）。

**関連する項目**：1

---

## 11. API の CORS が全オリジン許可（`*`）

- 重大度：低
- 分類：セキュリティ
- 状態：完了（CORS ヘッダーを外した。OPTIONS は CORS なしの 204）

**問題の内容と該当箇所**

`worker/src/index.js:46-51` で `Access-Control-Allow-Origin: *` を全 API に付けている。
認証は `Authorization: Bearer` で、クッキーは使っていないため、キーを知らない第三者のサイトからは何もできない（実害は小さい）。
アプリは同じオリジン（Worker 自身）から配信されるので、CORS 自体が要らない。

**なぜ問題なのか**

キーが何かの形で漏れたとき、任意のサイトのスクリプトから API を呼べる余地を残している。防御を一枚減らしている状態。

**改善案**

CORS のヘッダーを外す（同じオリジンだけで使う）。別のオリジンから使う予定がある場合は、その URL だけを許可する。

**実装担当への指示文**

> 目的：Worker の API を、同じオリジンのアプリからだけ使えるようにする。
> 対象ファイル：`worker/src/index.js`（`CORS` 定数と `json()`、`OPTIONS` の処理 382 行付近）、`test/unit/worker.test.js`・`test/unit/security-headers.test.js`。
> やること：
> 1. `CORS` を応答に付けるのをやめ、`OPTIONS` は 204 ではなく 404（またはヘッダーなしの 204）にする
> 2. テストに「`/api/data` の応答に `Access-Control-Allow-Origin` が無い」を足す
> 3. 念のため、`app.js` の通信がすべて `location.origin` 宛て（同じオリジン）であることを確かめる（`cfConfigFor` など）
> 完了の条件：`npm test` と `npm run build` が成功する。コミットメッセージは `fix: 要約`。

**関連する項目**：なし

---

## 12. GitHub Actions の版のばらつきと、Dependabot PR の放置

- 重大度：低
- 分類：保守性
- 状態：要確認（レビューの CI が Dependabot の PR で失敗するかを未確認）

**問題の内容と該当箇所**

`actions/checkout` の版がワークフローごとに違う（`ci.yml` は v4.4.0、`claude-code-review.yml` は v6.1.0、`merge-mail.yml` は v7.0.1）。
Dependabot の PR #58（checkout 4.4.0 → 7.0.1）・#59（setup-node 4.4.0 → 7.1.0）が 2026-10-26 から開いたまま。
`claude-code-review.yml` は `secrets.CLAUDE_CODE_OAUTH_TOKEN` を使うが、Dependabot の PR には Actions の Secret が渡らないため、レビューのジョブが失敗している可能性がある（要確認）。

**なぜ問題なのか**

赤い CI が常に出ていると、本当の失敗を見落とす。古い版はセキュリティ修正を取り込めない。

**改善案**

- #58・#59 の CI を確かめてマージする（メジャー版の更新なので、Node 22 の CI が通ることを確認）
- `claude-code-review.yml` に `if: github.actor != 'dependabot[bot]'` を足して、Dependabot の PR ではレビューを動かさない

**実装担当への指示文**

> 目的：GitHub Actions の版をそろえ、Dependabot の PR で不要な失敗が出ないようにする。
> 対象ファイル：`.github/workflows/ci.yml`、`.github/workflows/claude-code-review.yml`、開いている Dependabot の PR #58・#59。
> やること：
> 1. PR #58・#59 の CI（`test` ジョブ）が成功しているか確かめる。`Code Review` ジョブが Secret 不足で失敗していれば、その事実をこの項目に追記する
> 2. 成功していれば、持ち主の了承を得てマージする（了承がなければマージしない）
> 3. `claude-code-review.yml` の `jobs.review` に `if: github.actor != 'dependabot[bot]'` を足す
> 4. どのワークフローも、第三者のアクションはコミット SHA で固定し、末尾のコメントに版を書く今の方式を守る
> 完了の条件：3つのワークフローで `actions/checkout` の版がそろっている。Dependabot の PR で赤い CI が出ない。コミットメッセージは `ci: 要約`。

**関連する項目**：なし

---

## 13. 端末が JST 以外だと、アプリと Worker で日付がずれる

- 重大度：低
- 分類：バグ
- 状態：要確認（日本国外や、タイムゾーンが JST 以外の端末で使うかどうか）

**問題の内容と該当箇所**

アプリは日付を端末のローカル時刻で計算する（`app.js:224-227` の `toLocalISO`・`startOfDay`、`nextOccurrence` の `getDate`/`setDate` など）。
Worker は JST 固定（`worker/src/time.js`）。
取りやめた回のキー（`skip` の "YYYY-MM-DD"）もアプリは端末の日付で作る（`app.js:3802` 付近）。

**なぜ問題なのか**

旅行などで端末のタイムゾーンが変わると、「今日が締切」の判定や、取りやめた回・毎月の繰り返しの日付が、アプリと通知（Worker）で1日ずれることがある。日本国内だけで使うなら起きない。

**改善案**

日本国内だけで使うなら「対応しない」と README に明記して閉じる。
海外でも使うなら、アプリの日付計算を JST 固定の関数（Worker の `time.js` と同じ考え方）に置き換える（影響範囲が広いので項目7のテストが先）。

**実装担当への指示文**

> 目的：（持ち主が「国内のみ」と決めた場合）タイムゾーンの前提を文書に残す。（「海外でも使う」と決めた場合）アプリの日付計算を JST 固定にする。
> 前提：どちらにするかを持ち主に確認してから着手する。後者なら項目7のテストが先に必要。
> 対象ファイル：前者は `README.md` の「既知の注意点」。後者は `app.js` の日付ユーティリティ（224〜232 行付近）と、それを使う全ての箇所。
> やること（前者）：「端末のタイムゾーンは日本時間（JST）を前提にしている。他のタイムゾーンでは、締切日・取りやめた回・通知の日付が1日ずれることがある」と書く。
> やること（後者）：`app.js` に JST の暦で日付を扱う関数（`jstParts`・`fromJst` 相当）を作り、`toLocalISO`・`startOfDay`・`daysBetween`・`nextOccurrence`・カレンダーの描画を順に置き換える。各段階で `npm test` を通す。
> 完了の条件：前者は README の記述。後者は `TZ=America/Los_Angeles npm test` でも全テストが通ること。コミットメッセージは `docs:` または `fix:`。

**関連する項目**：7、8

---

## 14. snapshots の `at` に索引がない

- 重大度：低
- 分類：性能
- 状態：完了（索引 `snapshots_at` を追加。`size` 列は急ぎでないので見送り）

**問題の内容と該当箇所**

保存（PUT）のたびに `SELECT MAX(at) AS at FROM snapshots` を実行している（`worker/src/index.js:216`）。
テーブル定義（`worker/src/index.js:37`）に `at` の索引がないので、世代バックアップの件数だけ行を読む。
一覧の `LENGTH(json)`（236 行）も全行の JSON を読む。

**なぜ問題なのか**

間引き（毎日）で件数は数十〜百件程度に収まるため、今は問題にならない。D1 の無料枠は「読んだ行数」で数えるので、件数が増えると効いてくる。

**改善案**

- `CREATE INDEX IF NOT EXISTS snapshots_at ON snapshots(at)` を `SCHEMA` に足す
- 大きさは保存時に `size` の列として持つ（既存の行は `LENGTH(json)` で埋める）。急ぎではない

**実装担当への指示文**

> 目的：世代バックアップの件数が増えても、保存時の D1 の読み込み行数が増えないようにする。
> 対象ファイル：`worker/src/index.js`（`SCHEMA` 35 行付近、`putData` 216 行付近）、`test/support/d1Shim.js`（node:sqlite のシム）、`test/unit/worker.test.js`。
> やること：
> 1. `SCHEMA` に `CREATE INDEX IF NOT EXISTS snapshots_at ON snapshots(at)` を足す
> 2. `MAX(at)` の代わりに `SELECT at FROM snapshots ORDER BY at DESC LIMIT 1` を使ってもよい（索引が効く形）
> 3. 既存のテストがすべて通ることを確かめる
> 完了の条件：`npm test` と `npm run build` が成功する。本番の D1 では、デプロイ後に初回のリクエストで索引が作られる（`initDb`）ことを確認する。コミットメッセージは `fix: 要約`。

**関連する項目**：なし

---

## 15. 完了の記録を使った達成カレンダー・実績バッジ（面白機能）

- 重大度：低
- 分類：使いやすさ（面白機能）
- 状態：未着手

**問題の内容と該当箇所**

完了の記録（`db.completions`。いつ・締切の何時間前か・前倒し／期限内／遅れ・EXP）は端末間で同期されている（`app.js:162-183`・`3313`）。
しかし、画面ではレベルと直近7日の連続日数（`streakInfo`・`renderLevelBar`、`app.js:3578`・`3606`）にしか使われていない。
週次レビュー（項目2）で集計している内容も、アプリでは見られない。

**なぜ問題なのか**

問題ではなく、伸ばせる点。続ける動機づけ（ゲーム風の演出）を、記録の振り返りまで広げられる。

**改善案（アイデア）**

- 達成カレンダー：「完了」タブの上に、GitHub の草のような直近12週のマス（1日の完了件数で濃さ）。前倒しの日は印を付ける
- 実績バッジ：「7日連続」「前倒し10回」「全クリア5日」など、条件を満たすと設定のバッジ欄に並ぶ（`completions` から毎回計算し、新しいデータは増やさない）
- 称号：レベル帯ごとの称号。趣味にちなんだ遊びとして、レベルが上がるごとに野鳥の名前の称号が増える「図鑑」形式もできる（例：Lv.1 スズメ → Lv.5 カワセミ…。画像は使わず文字だけ）
- 週次レビューの要約を、日曜夜〜月曜にアプリの一覧の上に1行で出す（「先週は 12 件完了・前倒し 5 件」）

**実装担当への指示文**

> 目的：完了の記録（`db.completions`）を使って、振り返りが楽しくなる表示を足す。まずは「達成カレンダー」と「実績バッジ」の2つ。
> 対象ファイル：`app.js`（完了タブ `renderDone` 1831 行付近、`completions` の扱い 162〜183 行付近、演出の設定 `motionOn`・`techoStyle`）、`styles.css`、テストは新しく `test/unit/achievements.test.js`。
> やること：
> 1. 純粋な関数 `buildActivityGrid(completions, today)`（直近84日の日ごとの件数と、前倒しの有無）と `buildBadges(completions, expCarry)`（条件を満たしたバッジの配列）を作り、テストを書く。自動完了（`kind==="auto"`）とボーナス（`kind==="bonus"`）は数えない
> 2. 完了タブの先頭に、12列×7行のマス（週ごとの列）を描く。色は件数で3段階（0・1〜2・3以上）。各マスに `title`（例「10/29（木） 3件」）を付け、色だけに頼らない。演出「なし」のときもマスは出す
> 3. バッジ：「連続7日」「前倒し10回」「全クリア5日」「Lv.10」。設定画面の「演出」の節に一覧で出す（未達成は薄く）
> 4. データは増やさない（毎回 `completions` から計算する）。同期の形式（`syncPayload`）を変えない
> 5. デザインは `styles.css` の方針（紙の手帳風・影なし・角 2px・状態色は記号と組で使う）に合わせる。`docs/DESIGN-IMPROVEMENTS.md` も参照する
> 6. `index.html` の `app.js?v=...`・`styles.css?v=...`・`build-stamp` を更新する
> 完了の条件：`npm test` と `npm run build` が成功する。ユーザーに見える文言は日本語。コミットメッセージは `feat: 要約`。

**関連する項目**：2（週次レビューと同じ集計の規則にそろえる）

---

## 16. 購読用 .ics の改善（カレンダー名・更新間隔・URL の確認）

- 重大度：低
- 分類：使いやすさ
- 状態：未着手

**問題の内容と該当箇所**

購読用 `/ics/<FEED_TOKEN>.ics`（`worker/src/index.js:268`）が返す .ics には、カレンダー名（`X-WR-CALNAME`）と更新間隔の指定（`REFRESH-INTERVAL`・`X-PUBLISHED-TTL`）がない（`worker/src/ics.js:209`）。
iPhone で購読すると名前が URL 由来になり、更新の頻度もアプリ任せになる。
購読 URL はシークレットから自分で組み立てる必要があり、アプリから確認できない。

**なぜ問題なのか**

購読を設定するときに迷いやすく、変更がカレンダーに反映されるまでの時間が読めない。

**改善案**

- 購読用の .ics に限り、`X-WR-CALNAME:締切トラッカー`、`REFRESH-INTERVAL;VALUE=DURATION:PT1H`、`X-PUBLISHED-TTL:PT1H` を足す（Python 版との1文字一致テストは「購読用のみ追加の3行」として期待値を直す）
- 設定画面に「購読用 URL を表示」ボタンを足す。Worker に認証つきの `GET /api/feed-url` を作り、`FEED_TOKEN` から組み立てた URL を返す。画面では伏せ字にして、押したときだけ表示・コピーする

**実装担当への指示文**

> 目的：iPhone のカレンダーで購読しやすくし、購読 URL をアプリから確かめられるようにする。
> 対象ファイル：`worker/src/ics.js`（`buildIcs` の VCALENDAR の見出し 209 行付近）、`worker/src/index.js`（`serveIcs` 268 行付近、ルーティング `route`）、`app.js`（設定画面）、テスト `test/unit/feed-ics.test.js`・`test/unit/worker.test.js`。
> やること：
> 1. `buildIcs` に `subscribe: true` の選択肢を足し、そのときだけ `METHOD:PUBLISH` の後に `X-WR-CALNAME:締切トラッカー`・`REFRESH-INTERVAL;VALUE=DURATION:PT1H`・`X-PUBLISHED-TTL:PT1H` を足す。`serveIcs` だけが `subscribe: true` で呼ぶ（`/api/ics` は今のまま）
> 2. 既存の Python 版との一致テストは壊さない（`/api/ics` の出力は変わらない）。購読用には「3行が足されていること」のテストを足す
> 3. `GET /api/feed-url`（認証が必要）を足し、`FEED_TOKEN` が設定済みなら `{ ok:true, url: <origin>/ics/<FEED_TOKEN>.ics }`、未設定なら `{ ok:false }` を返す。ログには出さない
> 4. 設定画面に「購読用 URL を表示」ボタンを足し、押したときだけ API を呼んで表示し、「コピー」ボタンでクリップボードに入れる。表示には「この URL を知っている人は締切（メモを除く）を見られます」と注意を添える
> 5. `index.html` の `app.js?v=...`・`build-stamp` を更新する
> 制約：トークンを画面に常時表示しない、ログに出さない。認証のない API を増やさない。
> 完了の条件：`npm test` と `npm run build` が成功する。コミットメッセージは `feat: 要約`。

**関連する項目**：8

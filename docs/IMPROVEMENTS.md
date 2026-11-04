# 改善案の一覧（deadline-tracker）

リポジトリ全体を読んで見つけた課題と、その改善案の記録。コードは変えず、ここに書くのは方針と指示だけ。
実装する人（別の AI を含む）は、取り組む項目の「実装担当への指示文」だけを読めば作業できるように書いてある。

- 画面の見た目・使い勝手の改善案は別ファイル `docs/DESIGN-IMPROVEMENTS.md` にある
- 2回目以降の見直しでは、このファイルを読み、前回からの変化（完了・新規・優先度の変更）を「更新履歴」に書く。完了した項目は消さず、状態を「完了」にして残す

## 更新履歴

| 回 | 日付 | 対象のコミット | 内容 |
|---|---|---|---|
| 1 | 2026-10-29 | `92e10aa`（PR #62 のマージ） | 初回の洗い出し。16件 |
| 2 | 2026-10-31 | `8b0d711`（PR #82 のマージ、v3.1） | 1〜16 がすべて完了したことを確認（`npm test` 192件成功）。円卓議論（6人・3ラウンド）で次の機能を検討し、17〜20 を追加。検討して見送った案と、持ち主が不要と決めた案を「見送った案」に記録 |
| 3 | 2026-11-04 | `5fc74a8`（PR #91 のマージ、v4.0） | 17〜19 の完了と 20 の見送りを確認（`npm test` 220件成功）。第2回以降の差分を監査し、21〜28 を追加。移行の手作業の完了を記録 |

### 第3回の確認結果（前回からの差分）

- 対象：`5fc74a8`（PR #91 のマージ、v4.0）。`npm test` 220件すべて成功、`npm run build` 成功
- 完了：17・18・19、D13・D14。20 は見送り（2026-11-02 に持ち主が決定）
- 前回からの主な変更：「今日の一手」（v3.2）、メモ内チェックリスト（v3.3）、旧環境のコードの削除（v4.0、移行の段階5b）、監査で見つかった不具合の修正（約10件。同期の If-Match・編集中の上書き防止・Z の無い日時・保存 API の型の検査・Service Worker のキャッシュ削除の範囲など）、PR の自動レビュー（`.claude/skills/pr-review` と `.claude/agents/pr-review-*.md`）
- 移行の手作業（GitHub Pages の停止・`deadline-data` のアーカイブなど）は、持ち主が完了と報告（2026-11-04）。`docs/cloudflare-migration.md` に「済」と記録した
- 新規：21〜28（下の一覧）。今回は前回以降の差分（約4,300行）のコード監査が中心で、新しい機能の案は入れていない
- 秘密情報：今回の差分にも見つからなかった
- 確認できなかったもの：GitHub の接続が切れていたため、開いている PR・Issue の一覧は見ていない（代わりに git でブランチを調べ、未マージの修正を1件見つけた＝22）

### 第2回の確認結果（前回からの差分）

- 完了：1〜16 の全件（各項目の「状態」に、何をしたかと未確認の点が書いてある）。デザインの D1〜D12 も全件完了
- 新しく見つかった不具合：なし（今回は機能の検討が中心で、コードの再監査はしていない）
- 新規：17「今日の一手」、18「メモ内チェックリスト」、19「今日の一手の使用日数を数える」、20「作業予定日」（2026-11-02 に持ち主が見送りと決定）。画面側は `docs/DESIGN-IMPROVEMENTS.md` の D13・D14
- 持ち主の決定：Gmail の自分宛てメールは本人は基本読まない（Claude のルーティン用）。野鳥図鑑の称号は不要

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
| 7 | app.js の中心の処理に単体テストがない | 中 | テスト | 完了 |
| 8 | .ics・繰り返し・Discord 本文が app.js と Worker で二重実装 | 中 | 保守性 | 完了 |
| 9 | privacy.html のインライン style が CSP で止められる | 低 | バグ | 完了 |
| 10 | 自動同期のたびに全データを読み直している | 低 | 性能 | 完了 |
| 11 | API の CORS が全オリジン許可（`*`） | 低 | セキュリティ | 完了 |
| 12 | GitHub Actions の版のばらつきと、Dependabot PR の放置 | 低 | 保守性 | 完了 |
| 13 | 端末が JST 以外だと、アプリと Worker で日付がずれる | 低 | バグ | 完了 |
| 14 | snapshots の `at` に索引がない | 低 | 性能 | 完了 |
| 15 | 完了の記録を使った達成カレンダー・実績バッジ（面白機能） | 低 | 使いやすさ | 完了 |
| 16 | 購読用 .ics の改善（カレンダー名・更新間隔・URL の確認） | 低 | 使いやすさ | 完了 |
| 17 | 今日の一手（その日に手を付ける締切に印を付ける。前の晩にも付けられる） | 中 | 使いやすさ | 完了 |
| 18 | メモ内チェックリスト（`- [ ]` の行をチェック欄にし、進み具合を出す） | 中 | 使いやすさ | 完了 |
| 19 | 今日の一手を使った日数を端末内で数える（20 を決める材料） | 低 | 使いやすさ | 完了 |
| 20 | 作業予定日（数日先まで「やる日」を決める） | 低 | 使いやすさ | 見送り |
| 21 | 端末内の古い型の締切で、自動同期が 400 で止まり、何も知らせない | 中 | バグ | 完了 |
| 22 | pr-review の修正（2回目の実行で mkdir が失敗する退行）が未マージ | 中 | 保守性 | 完了 |
| 23 | `CLAUDE.md` が旧環境を「移行が終わるまで壊さない」と指示したまま | 中 | ドキュメント | 完了 |
| 24 | ルートの `?v=`・`build-stamp` を、まだ毎回手で更新している | 低 | 保守性 | 完了 |
| 25 | Cron の CPU 時間（無料プランは 10ms）を測っていない | 低 | 性能 | 要確認 |
| 26 | 2つの自動レビュー（`claude-code-review.yml` と pr-review）が同じ PR を二重に見ている | 低 | 保守性 | 完了 |
| 27 | マージ済みのブランチが約30本残っている | 低 | 保守性 | 要確認 |
| 28 | 設定の見出しなどに、v4.0 で消えた機能の名残の文言がある | 低 | 使いやすさ | 完了 |

おすすめの着手順（第1回）：1 → 3 → 2 → 4 → 7 → 5 → 9 → 6 → 8 → 10 以降。
1・3 は小さく直せて効果が大きい。2 は段階4（本番切り替え）の前に必要。

おすすめの着手順（第2回）：17（＋D13）→ 18（＋D14）→ 19 → 2〜3週間使ってから 20 を判断。
17 と 18 はどちらもデータの形をほとんど変えず、新しい API・Cron・D1 の表を作らない。

おすすめの着手順（第3回）：22 → 21 → 23 → 24 → 28 → 27 → 25・26（要確認の結論が出てから）。
22 はコミット2つを取り込むだけ。21 は同期が黙って止まる不具合なので、コードの変更の中では最優先。

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
- 状態：完了（`test/unit/app-logic.test.js` に21件。`app.js` は変えずに通った＝見つかったバグは無い。アプリの .ics と Worker の .ics は、同じデータで1文字まで一致した。取り出しの仕組みは、構文として読める最初の `}` で終わる方式に直した）

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
- 状態：完了（段階5b＝v4.0 で、残りのコード〔Discord を端末から直接送る処理と GitHub 同期〕を消した。`docs/cloudflare-migration.md` の段階5。Cloudflare 版では、未完了の全件の .ics を Worker の `GET /api/ics` から取り、Discord の「今すぐ送る」は保存済みの URL のままなら Worker から送る。残りは段階5で消すコードを `docs/cloudflare-migration.md` に一覧にした。実機での確認はまだ）

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
- 状態：完了（Cloudflare の自動同期は、全データを先に読み直さず、手元の rev を `If-Match` に付けて直接送る。衝突は Worker が 409 で断り、今までどおり止めて知らせる。Worker の `GET /api/data` は、保存してある JSON を解析し直さずに返す）

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
- 状態：完了（#58 はマージ済み。#59 は閉じられたため、同じ内容の setup-node v7.1.0 を `ci.yml` に取り込んだ。確認できた事実：Dependabot の PR では `Code Review` が「人以外の実行者（dependabot）は許可リストに無い」で失敗していた。`claude-code-review.yml` に `if: github.actor != 'dependabot[bot]'` を足した。3つのワークフローで `actions/checkout` は v7.0.1 にそろった）

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
- 状態：完了（持ち主が「国内のみ」と決めた。README の「既知の注意点」に、端末のタイムゾーンは JST が前提で、他では日付が1日ずれることがあると明記した。コードは変えていない）

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
- 状態：完了（達成カレンダーと実績バッジ。持ち主の選択で、称号（図鑑）と週次レビューの1行表示は入れていない。完了の記録から毎回計算し、データ・同期の形式は増やしていない）

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
- 状態：完了（購読用 .ics に `X-WR-CALNAME`・`REFRESH-INTERVAL`・`X-PUBLISHED-TTL` を足した。`/api/ics` の出力は変えていない。認証つきの `GET /api/feed-url` と、設定の「カレンダーで購読する」（押したときだけ表示・コピー、60秒で隠す）を追加）

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

---

# 第2回で追加した項目（2026-10-31）

ここから下は、円卓議論（利用者代表・推進派・現実派・懐疑派・異端者・UI/UX の専門家の6人、3ラウンド）の結果をもとにした項目。
議論の記録は、このファイルの末尾の「第2回の円卓議論の記録」にある。

## 17. 今日の一手（その日に手を付ける締切に印を付ける。前の晩にも付けられる）

- 重大度：中
- 分類：使いやすさ
- 状態：完了（v3.2。`pick` を `picksFor`／`canPick` で扱い、カードの「…」に「今日の一手にする」「明日の一手にする」「一手から外す」。完了・延期・この回は休み・繰り返しで次の回へ進むと外れる。取り込みと Worker の保存は文字列でなければ除く。朝の Discord は先頭に「◎ 今日の一手」の節（印の無い日は文面が変わらないことをテストで確認）、メールは先頭に「■ 今日の一手」。未確認：iPhone の実機で前の晩に「明日の一手」を付け、翌朝 6:47 の Discord の先頭に出るか）

**問題の内容と該当箇所**

締切までの距離を見せる道具はそろっているが、「今日どれに手を付けるか」に答える場所がない。

- 今日のサマリー（`app.js` の `todaySummary` 1544 行付近）
- 残り日数
- 負荷の濃淡
- 超過一覧
- 朝の Discord（`worker/src/digest.js` の `buildDigest`）

持ち主は毎朝、通知や一覧を見ながら頭の中で優先順位を組み直している。

**なぜ問題なのか**

締切は .ics・Discord・メールで十分届いている。足りないのは「開いたときに今日の行動が決まっている」状態で、毎日の効果が一番大きい。
円卓議論の最終投票では、6人全員がこの案を最上位（9点）にした。

**改善案**

締切1件に、任意の項目 `pick`（"YYYY-MM-DD"、JST）を1つだけ足す。
意味は「この日に手を付ける」。日付が過ぎた印は無視するので、持ち越しの山はできない（消す処理も要らない）。

- 付け方：カードの「…」に「今日の一手にする」「明日の一手にする」を置く。登録画面には足さない（登録時の入力を増やさない）
- 前の晩にも付けられる：6:47 の朝の Discord に間に合わせるため。20:23 の夜の通知を見た後に、明日の分を決める使い方を想定する
- 1日3件まで：4件目は付けず、トーストで知らせる
- 一覧の最上段に「今日の一手」の欄（見た目は `docs/DESIGN-IMPROVEMENTS.md` の D13）
- 朝 6:47 の Discord の先頭に「◎ 今日の一手」の節を出す。印が無ければ節ごと出さない（今の文面と1文字も変わらない）
- 完了・延期・この回は休み・繰り返しで次の回へ進んだときは、`pick` を消す

所要時間の見積もりは入れない。学生の見積もりは外れやすく、外れると数字が信用されなくなる。入力も増える。

**実装担当への指示文**

> 目的：締切に「この日に手を付ける」印（今日の一手）を付けられるようにし、一覧の最上段と朝の Discord に出す。データは締切1件に任意の文字列項目 `pick` を1つ足すだけにする。
> 対象ファイル：
> - `app.js`：カードの組み立て `cardOf` 907 行付近（「…」の中の操作）、今日のサマリー `todaySummary` 1544 行付近と一覧の組み立て `renderListBody` 1576 行付近、完了 `applyCompletionCore` 3719 行付近、延期 `postpone` 1257 行付近、取りやめ `skipOccurrence` 4325 行付近、取り込みの検査 `sanitizeIncomingItems` 185 行付近
> - `worker/src/index.js`：保存の検査 `ITEM_STRING_KEYS` 30 行
> - `worker/src/digest.js`：朝の一覧 `buildDigest` 63 行付近
> - `styles.css`
> - テスト：`test/unit/app-logic.test.js`・`test/unit/digest.test.js`・`test/unit/worker.test.js`
> やること：
> 1. 純粋な関数 `picksFor(items, dateKey)`（その日の印が付いた未完了の締切の配列、締切の早い順）と `canPick(items, dateKey)`（3件未満か）を `app.js` に作り、テストを書く。日付の比較は今の `toLocalISO`（端末の日付。README のとおり JST が前提）を使う
> 2. カードの「…」に「今日の一手にする」と「明日の一手にする」を足す。既に印があれば「一手から外す」にする。4件目は付けず「一手は1日3件までです」とトーストを出す。付け外しは `save()` と `scheduleAutoSync()` を呼ぶ。登録・編集画面には項目を足さない
> 3. 完了（繰り返しで次の回へ進む場合を含む）・明日に延期・この回は休みのとき、その締切の `pick` を消す
> 4. `sanitizeIncomingItems` で、`pick` が "YYYY-MM-DD" の形の文字列でなければ消す
> 5. `worker/src/index.js` の `ITEM_STRING_KEYS` に `'pick'` を足す（文字列でない値を保存させない）
> 6. `worker/src/digest.js` の `buildDigest` で、JST の今日の日付と `pick` が一致する未完了の締切を、見出しのすぐ後に `## ◎ 今日の一手（N件）` の節として出す。各行は今の行と同じ形（タイトル・カテゴリ・日時・残り）で、「✅完了」リンクを付ける。同じ締切が下の節（期限切れ・今日・7日以内）にも出てよいが、その行の頭に `◎ ` を付ける。印が1件も無ければ節を出さない。`test/expected/` の既存の正解ファイル（印の無いデータ）が1文字も変わらないことを確かめる
> 7. テスト：印つきのデータを `test/fixtures/` に足し、朝の一覧に節が出ること、昨日の日付の印は無視されること、完了で印が消えることを確かめる
> 8. 一覧の最上段の欄は `docs/DESIGN-IMPROVEMENTS.md` の D13 に従って作る
> 9. （任意）メール本文（`worker/src/mail.js` の `buildMailBody`）の先頭にも「■ 今日の一手」を出す。持ち主はメールを読まないが、Claude のルーティンが読むので、今日の予定の組み立てに使える。印が無ければ何も足さない
> 10. `index.html` の `app-version` を 3.2 に、`package.json` の `version` を 3.2.0 にし、`docs/VERSIONS.md` の履歴に1行足す（`docs/VERSIONS.md` の決まり）。README の「機能」に1項目足す
> 制約：新しい API・Cron・D1 の表を作らない。Worker の CPU 時間は 10ms 以内（印の判定は締切の配列を1回なめるだけ）。ユーザーに見える文言は日本語。ES5 風の書き方（`app.js`）。
> 完了の条件：`npm test` と `npm run build` が成功する。印の無いデータで朝の Discord の文面が変わらない。iPhone の実機で、前の晩に「明日の一手」を付けると翌朝 6:47 の Discord の先頭に出る（本番で確かめられたら状態に追記する）。コミットメッセージは `feat: 要約`。

**関連する項目**：D13（画面）、19（使用日数）、20（作業予定日への拡張）

---

## 18. メモ内チェックリスト（`- [ ]` の行をチェック欄にし、進み具合を出す）

- 重大度：中
- 分類：使いやすさ
- 状態：完了（v3.3。`parseChecklist`・`toggleChecklist`・`checklistProgress` を純粋な関数にし、表形式のテストで境目（`[X]`・行頭の空白・`*`・`\r\n`・文字列でないメモ）と「他の行が1文字も変わらない」ことを確認。カードのチェックはその場で表示を直し、保存・同期する。5行を超えたら「ほか N 件」に畳む）

**問題の内容と該当箇所**

校内紙の入稿データチェックのように、1つの締切の中に毎回同じ手順がある作業を、今は1件の締切としてしか持てない。
メモ（`app.js` の `cardOf` 931 行付近で `<p class="memo">` としてそのまま表示）に手順を書いても、どこまで済んだかが分からない。

**なぜ問題なのか**

手順の抜け（写真のクレジット・見出しの字数・PDF の書き出しなど）は、締切の当日に気づくと取り返しがつかない。

**改善案**

専用のサブタスク機能は作らない。メモの中の `- [ ] 〜`／`- [x] 〜` の行を、カードではチェック欄として表示する。
押すとメモの文字（`[ ]` ↔ `[x]`）を書き換える。カードの2行目（属性の行）に「☑ 3/7」と進み具合を出す。

データの形は変わらない（メモは今も文字列）ので、同期・世代バックアップ・.ics・Worker の検査には触れない。
テンプレートは今もメモを写す（`saveAsTemplate`・`applyTemplate`、1181〜1225 行付近）ので、「入稿チェック」のテンプレートを1つ作れば、毎号同じ手順が付く。追加の作業は要らない。

1つチェックするごとに EXP を付けることはしない（EXP が水増しされ、完了の記録の意味が変わるため）。

**実装担当への指示文**

> 目的：メモに書いた `- [ ]` の行を、カードの上でチェックできるようにし、進み具合を出す。データの形（メモは文字列）は変えない。
> 対象ファイル：`app.js`（`cardOf` 907 行付近のメモの表示 931 行と、2行目の属性の行）、`styles.css`、テスト `test/unit/app-logic.test.js`。見た目は `docs/DESIGN-IMPROVEMENTS.md` の D14。
> やること：
> 1. 純粋な関数 `parseChecklist(memo)` を作る。行ごとに `{text, checked, line}` か通常の文の行かを返す。チェックの行は `/^\s*[-*]\s\[( |x|X)\]\s+(.*)$/`
> 2. 純粋な関数 `toggleChecklist(memo, line)` を作る。その行の `[ ]` と `[x]` だけを入れ替えた新しい文字列を返す。他の行・空白・改行コードは1文字も変えない
> 3. `checklistProgress(memo)` を作る。`{done, total}` を返し、チェックの行が無ければ null
> 4. 1〜3 に表形式のテストを書く。境目のケース：`[X]` の大文字、行頭の空白、`*` の箇条、チェック行の間の普通の文、`\r\n`、空のメモ、メモが文字列でない場合
> 5. `cardOf` でメモを描くとき、チェックの行は `<label><input type="checkbox">文</label>` にする。文は必ず `escHtml` を通す。通常の行は今までどおり文として出す。チェックを変えたら、その締切の `memo` を `toggleChecklist` で書き換え、`save()`・`scheduleAutoSync()`・描き直しをする。完了済みのカードと、カレンダーの繰り返しの複製（`isExpanded`）ではチェックを押せないようにする（表示だけ）
> 6. 進み具合があれば、カードの2行目（属性の行）に「☑ 3/7」を出す。全部済んだら「☑ 7/7 済」
> 7. 登録画面のメモ欄の `placeholder` か、その下の小さな説明に「`- [ ] 手順` と書くとチェックできます」と添える。メモの上限（`index.html` の `maxlength="500"`）は変えない
> 8. Discord・メールの文面は変えない（メモは `- [ ]` のまま出る。気になる場合は別の項目として提案する）
> 9. `index.html` の `app-version`・`package.json` の `version` を上げ（17 と同じ版にまとめてもよい）、`docs/VERSIONS.md` と README の「機能」を更新する
> 制約：外部ライブラリ（Markdown のパーサーなど）を使わない。HTML にインラインの style・`onclick` を書かない（CSP）。
> 完了の条件：`npm test` と `npm run build` が成功する。チェックを押しても、他の行のメモの文字が変わらない（テストで確認）。コミットメッセージは `feat: 要約`。

**関連する項目**：D14（画面）

---

## 19. 今日の一手を使った日数を端末内で数える（20 を決める材料）

- 重大度：低
- 分類：使いやすさ
- 状態：完了（v3.2。印を付けた日付を localStorage の `pick-days` に最大60日分残し、設定の「このアプリについて」に「直近14日のうち N日で使用」と出す。`pickDaysIn` のテストあり。2〜3週間後に 20 を判断する材料にする）

**問題の内容と該当箇所**

17 を入れた後、本当に毎日使われているかを知る手段がない。
作業予定日（20）へ広げるかの判断には、「印を付けた日がどれくらいあるか」が要る。

**なぜ問題なのか**

使われていない機能を広げると、手間だけが増える。円卓議論の懐疑派の指摘で、全員が「2〜3週間使ってから判断する」に同意した。

**改善案**

印を付けた日付だけを、端末の中（localStorage）に最大60日分残す。同期・D1 には送らない。
設定の「このアプリについて」に「今日の一手：直近14日のうち N日で使用」と1行出す。
端末ごとの数になる（iPhone と PC は別々に数える）ことも、その行に書く。

機能全体の使用回数を数えて棚卸しする案（懐疑派の当初案）は、作る手間に見合わないので、ここまで縮めた。

**実装担当への指示文**

> 目的：「今日の一手」（項目17）を使った日数を端末内だけで数え、2〜3週間後に作業予定日（項目20）へ広げるかを判断できるようにする。
> 前提：項目17が終わっていること。
> 対象ファイル：`app.js`（17 で作った印の付け外しの処理、設定画面 `renderSettings` 2219 行付近の「このアプリについて」）、テスト `test/unit/app-logic.test.js`。
> やること：
> 1. 印を付けたとき、その印の日付（"YYYY-MM-DD"）を `store`（localStorage）のキー `pick-days` に重ねず足す。60件を超えたら古いものから捨てる。外したときは消さない
> 2. 純粋な関数 `pickDaysIn(days, todayKey, n)`（直近 n 日のうち何日あるか）を作ってテストする
> 3. 設定の「このアプリについて」に「今日の一手：直近14日のうち N日で使用（この端末だけの数）」と出す
> 4. 締切データ・同期・Worker には何も足さない
> 完了の条件：`npm test` と `npm run build` が成功する。コミットメッセージは `feat: 要約`。

**関連する項目**：17、20

---

## 20. 作業予定日（数日先まで「やる日」を決める）

- 重大度：低
- 分類：使いやすさ
- 状態：見送り（2026-11-02 に持ち主が決定。着手しない。再提案は下の「見送った案（第2回）」の条件を満たしたときだけ）

**問題の内容と該当箇所**

入稿のように数日前から逆算して進める作業では、「今日・明日」だけの印（17）では段取りを表しきれない可能性がある。
円卓議論の推進派は、最終的にはこの形を目指すべきだという意見を最後まで残した（少数意見）。

**なぜ問題なのか**

まだ問題かどうか分からない。逆に、最初からこの形で作ると、異端者・現実派・懐疑派が指摘した重さがのしかかる。

- 締切と「やる日」の2本の日付がカレンダー・.ics・週次レビュー・繰り返しのすべてに分岐を作る
- やる日を過ぎた分の「持ち越し」が、超過一覧と同じような罪悪感の山になる

**改善案**

17 の `pick` は日付なので、「明日」より先の日付も付けられるようにすれば、データの形を変えずに広げられる。
持ち越し（やる日を過ぎて終わっていない）は、翌朝に1回だけ控えめに出し、積み上げない。
判断の目安は次の2つ。

- 19 の数で、直近14日のうちおおむね10日以上使っている
- 持ち主が「3日前に校正、のように先の日に割り振りたい」と感じている

どちらにも当てはまらなければ、この項目は「見送り」にする。

**実装担当への指示文**

> 目的：（持ち主が着手すると決めた場合のみ）「今日の一手」の印を、先の日付にも付けられるように広げる。
> 前提：項目17・19が終わり、持ち主がこの項目に着手すると決めていること。決めていなければ何もしない。
> 対象ファイル：`app.js`（17 で作った付け外しの操作・`picksFor`）、`styles.css`、`worker/src/digest.js`（朝の節は今日の分だけのまま）、テスト。
> やること：
> 1. 「…」の操作に「日付を選んで一手にする」を足し、`<input type="date">` で先の日付を選べるようにする（1日3件までの決まりは日付ごとに守る）
> 2. 今週ビュー（`renderWeek`）の各日に、その日の一手を ◎ 付きで出す
> 3. 日付が過ぎて未完了の印は、翌日の最上段の欄に1回だけ「持ち越し」として小さく出し、その翌日には出さない（`pick` は消さずに無視するだけ）
> 4. カレンダー・.ics・週次レビューには、やる日を出さない（締切の意味を変えない）
> 完了の条件：`npm test` と `npm run build` が成功する。コミットメッセージは `feat: 要約`。

**関連する項目**：17、19

---

## 見送った案（第2回）

円卓議論で出たが、今回は入れないと決めた案。2回目以降の見直しで、同じ案を理由なく再提案しないための記録。

| 案 | 決定 | 理由 | 考え直す条件 |
|---|---|---|---|
| 野鳥図鑑の称号（実績を観察記録帳に見立てる） | **不要（持ち主が決定）** | 持ち主の意向。演出はすでに十分ある | 持ち主から言われない限り、再提案しない |
| 通知の重複整理（20:23 の Gmail と Discord など） | 対応不要 | 持ち主は Gmail の自分宛てメールを基本読まない（Claude のルーティン用）ので、重複の実害がない | 持ち主がメールを読むようになったとき |
| スワイプ（右＝済、左＝明日へ）・キーボード操作 | 見送り | 誤操作、縦スクロールや iOS の戻る操作との衝突、端末ごとの確認の手間に見合わない。今の操作が遅いという証拠もない | ボタン操作が遅いと持ち主が感じたとき。PC のキーボード操作だけなら小さく足せる |
| 延期・休みの理由印（週次レビューで集計） | 見送り | 延期のたびに1手増える。延期がどれくらい起きているか分からない | 延期が週に数回以上あると分かったとき |
| 週刊ゲラ（来週7日を新聞の組版風に印刷） | 見送り | 印刷用 CSS だけで作れて安いが、紙を見る習慣が確かめられていない | 持ち主が紙で予定を見たいと言ったとき |
| 機能全体の使用回数の記録と棚卸し | 縮小して 19 に | 利用者1人なら本人に聞けば足りる。記録の仕組み自体が負債になる | — |
| 作業予定日（数日先まで「やる日」を決める → 20） | **見送り（持ち主が決定）** | 締切と「やる日」の2本の日付がカレンダー・.ics・週次レビュー・繰り返しに分岐を作り、持ち越しが超過一覧のような山になる。今日・明日の一手（17）で足りるかを先に確かめる | 今日の一手を使っていて、先の日に割り振りたいと持ち主が感じたとき（19 の使用日数が直近14日のうちおおむね10日以上が目安） |
| 所要時間の見積もり | 見送り | 学生の見積もりは外れやすく、外れると信用を失う。1件ごとの入力が増える | 作業予定日（20）を入れた後、1日の作業量を見たくなったとき |
| 最初の画面を絞る | D13 に統合 | 今日の一手の欄を最上段に置けば、目的の大半を果たせる | — |

---

## 第2回の円卓議論の記録

- 問い：改善案を全件終えた締切トラッカー（v3.1）に、次に入れる機能・デザインは何か
- 判断の基準：毎日の効果／実現しやすさ／維持の手間／楽しさ
- 進め方：6人（利用者代表・推進派・現実派・懐疑派・異端者・UI/UX の専門家）に、まず別々に案を出させ（ラウンド1）、互いに反論・修正させ（ラウンド2）、最終投票（ラウンド3）。議長は途中で意見を混ぜていない。ただし事実の補足として「Gmail のメールは Claude のルーティン用」という点を全員に同じ形で渡した

**最終の点数（10点満点）**

| 候補 | 利用者代表 | 推進派 | 現実派 | UI/UX | 懐疑派 | 異端者 | 平均 | ばらつき |
|---|---|---|---|---|---|---|---|---|
| B 今日の一手（→ 17） | 9 | 9 | 9 | 9 | 9 | 9 | 9.0 | 0 |
| C メモ内チェックリスト（→ 18） | 8 | 8 | 8 | 8 | 7 | 8 | 7.8 | 1 |
| A 作業予定日（→ 20） | 7 | 8 | 7 | 6 | 6 | 6 | 6.7 | 2 |
| J 最初の画面を絞る（→ D13） | 6 | 7 | 6 | 7 | 6 | 7 | 6.5 | 1 |
| H 使用回数の記録（→ 19 に縮小） | 6 | 6 | 4 | 5 | 6 | 6 | 5.5 | 2 |
| I 通知の重複整理 | 5 | 6 | 6 | 6 | 4 | 6 | 5.5 | 2 |
| F 延期の理由印 | 5 | 6 | 5 | 5 | 5 | 5 | 5.2 | 1 |
| E スワイプ・キー操作 | 5 | 6 | 5 | 5 | 4 | 5 | 5.0 | 2 |
| G 週刊ゲラ | 4 | 5 | 6 | 5 | 4 | 5 | 4.8 | 2 |
| D 野鳥図鑑の称号 | 4 | 5 | 3 | 3 | 2 | 4 | 3.5 | 3 |

**議論で変わったこと**

- ラウンド1では6人中4人が A（作業予定日）を最優先にした
- ラウンド2で異端者が反論した。A は日付が2本になって分岐が広がり、持ち越しが溜まる。A の効果の大半は、その日で消える印（B）で得られ、B から A へは後から広げられる。これを受けて5人が B に移った
- 懐疑派は「何も足さず棚卸し」から「B を入れて、使われるか確かめる」に移った
- 通知の重複整理（I）はラウンド2で上がったが、Gmail が Claude のルーティン用だという事実で全員が下げた

**少数意見（消さずに残す）**

- 推進派：最終的に目指すのは A（作業予定日）。入稿のように何日も前から逆算する作業は、B だけでは表しきれない
- 異端者（B の弱点）：朝に印を付ける作りでは、6:47 の Discord に間に合わない。そのため、前の晩に「明日の一手」を付けられるようにする（17 に取り込み済み）
- 懐疑派：機能は2か月で急に増えた。B が毎朝使われると確かめてから次へ進むべき（19 として取り込み済み）

**結論が変わる条件**

- 何日も前から段取りを決めたいと持ち主が感じる → 20 を早める
- 17 を2〜3週間使っても印がほとんど付かない → 20 は見送り、17 自体も見直す
- 入稿チェックの手順が毎号大きく変わる → 18 のテンプレートとしての価値が下がる

---

# 第3回で追加した項目（2026-11-04）

第2回以降に入ったコード（`8b0d711..5fc74a8`、約4,300行）を監査して見つけたもの。

## 21. 端末内の古い型の締切で、自動同期が 400 で止まり、何も知らせない

- 重大度：中
- 分類：バグ
- 状態：完了（PR #93。`normalizeItemTypes` を `load()` でも使い、自動同期が 400・413・5xx で断られたら理由を1回だけトーストと設定に出す。`cf-sync.test.js` で、補正しないと Worker が 400・補正すると保存できることを確認。実際の端末に古い型の項目があったかは未確認）

**問題の内容と該当箇所**

- Worker の保存 API は、締切1件ごとの型を厳しく調べる（`worker/src/index.js` の `checkItemValues`）。対象は `rep`・`repCount`・`repDay`・`seq`・`skip`・`pick`・`done`・`allDay`・`autoComplete`・`calHide`。1件でも合わなければ、全体を 400 で断る
- アプリ側で型をそろえる `sanitizeIncomingItems`（`app.js` 191 行付近）は、取り込みの経路（読み込み・自動取り込み・世代バックアップの復元・JSON の読み込み）でしか使われない
- 起動時に端末内のデータを読む `load()`（`app.js:108`）は、「自分自身の localStorage は検証しない」というコメントのとおり、型をそろえない
- 自動同期 `runAutoSync`（`app.js:1145`）は、409（衝突）と 401・429（認証）以外の失敗の応答を、何もせず捨てる。400・413・500 では、トーストも出さず、記録も残さない

**なぜ問題なのか**

保存の検査を厳しくする前の版で書かれた、古い型の項目（例：`seq` が文字列、`skip` に日付でない値）が端末内に残っていることがある。
そうした端末では、編集のたびの自動同期が 400 で失敗し続ける。それなのに画面には何も出ない。
他の端末にも Discord の通知にも変更が届かないまま、気づくのは「最終同期が1日以上前」の警告が出たときになる。

**改善案**

- 起動時の `load()` でも、`sanitizeIncomingItems` と同じ型の補正をする。ただし、項目を隔離（一覧から外す）するのは今までどおり取り込み時だけにし、端末内のデータでは型の補正だけを行う（既存の表示を急に消さない、という今の方針を守る）
- 自動同期が 400・413・5xx で失敗したら、その理由（Worker が返す `error` の文）を1回だけトーストで出し、設定の同期の節にも「最後の自動同期は失敗しました（理由）」と出す。同じ失敗が続く間は、トーストを繰り返さない

**実装担当への指示文**

> 目的：端末内に古い型の締切が残っていても自動同期が黙って止まらないようにし、失敗したときは理由を知らせる。
> 対象ファイル：`app.js`（`load` 108 行付近、`sanitizeIncomingItems` 191 行付近、`runAutoSync` 1145 行付近、設定の同期の節 2593 行付近）、テスト `test/unit/app-logic.test.js`・`test/unit/cf-sync.test.js`。Worker（`worker/src/index.js` の `checkItemValues`）は変えない。
> やること：
> 1. `sanitizeIncomingItems` のうち「型の補正」の部分（`skip`・`repCount`・`repDay`・`seq`・`allDay`・`autoComplete`・`calHide`・`pick`・`done`・`rep`・`memo`・`cat` の補正）を、隔離をしない純粋な関数 `normalizeItemTypes(item)` に切り出す。`sanitizeIncomingItems` はそれを使う（動きは変えない）
> 2. `load()` で、`db.items` の各項目に `normalizeItemTypes` をかける。id・title・due が壊れた項目も、隔離はせずそのまま残す（今の方針どおり）。補正で値が変わったときだけ `writeDb()` で保存し直す（`updatedAt` は変えない）
> 3. `runAutoSync` で、応答が `ok` でなく、409・401・429 でもないとき、応答の JSON の `error`（無ければ「HTTP 400」など）を取り、「自動同期に失敗しました：（理由）。設定（右上のメニュー（☰））の同期から送り直せます」と1回だけトーストを出す。同じ理由の失敗が続く間は出さない。成功したらこの記録を消す
> 4. 設定の同期の節に、最後の自動同期が失敗していれば、その理由を `c-red` の文字で1行出す
> 5. テスト：古い型の項目（`seq:"3"`、`skip:["x"]`、`allDay:"true"`）を localStorage に入れて `load` を通すと、Worker の `checkItemValues` を通る形になること（`worker/src/index.js` の保存 API に実際に送って 200 になることを `cf-sync.test.js` の `world()` で確かめる）。Worker が 400 を返したとき、トーストが1回だけ出ること
> 6. `index.html` の `app.js?v=...`・`build-stamp` を更新し（項目24が終わっていれば不要）、`package.json` の patch を上げる（`docs/VERSIONS.md` の決まり）
> 制約：ユーザーに見える文言は日本語。ES5 風の書き方。キー・トークンを画面やログに出さない。
> 完了の条件：`npm test` と `npm run build` が成功する。追加したテストが、修正前のコードでは失敗する。コミットメッセージは `fix: 要約`。

**関連する項目**：なし（第1回の 1・3 と同じく、同期が止まる系の不具合）

---

## 22. pr-review の修正（2回目の実行で mkdir が失敗する退行）が未マージ

- 重大度：中
- 分類：保守性
- 状態：完了（PR #92。2コミットを `cherry-pick`。修正した手順の作業フォルダの作成を、2回続けて実行して失敗しないことを確認。ブランチ `claude/blissful-knuth-i1n1m4` は項目27で整理する）

**問題の内容と該当箇所**

ブランチ `claude/blissful-knuth-i1n1m4` に、`main` に入っていないコミットが2つある。

- `593084f fix: pr-review の作業フォルダ作成の退行と状態の表記を直す`
- `cb78ece docs: pr-review の件数に前回からの未対応を含めると明記する`

PR #88 はこの2つを含まずにマージされた。`main` の `.claude/skills/pr-review/SKILL.md`（50 行）は、作業フォルダを `mkdir -m 700` で作るよう書いていて、`-p` が付いていない。
そのため、同じ環境で2回目に実行すると（`CLAUDE.md` が求める「追加のプッシュ後の差分レビュー」がまさにこれ）、フォルダが既にあって `mkdir` が失敗する。

**なぜ問題なのか**

`CLAUDE.md` は、PR を作った直後とプッシュのたびに pr-review を実行し、指摘が出なくなるまで直して繰り返すよう定めている。
2回目で手順が止まると、この繰り返しが回らない。

**改善案**

2つのコミットを `main` に取り込む（中身は `SKILL.md` の4〜5行の変更だけ）。

**実装担当への指示文**

> 目的：pr-review の手順書の修正（`claude/blissful-knuth-i1n1m4` の2コミット）を `main` に取り込む。
> 対象ファイル：`.claude/skills/pr-review/SKILL.md` だけ。
> やること：
> 1. `git fetch origin claude/blissful-knuth-i1n1m4` し、`git diff origin/main...FETCH_HEAD` が `SKILL.md` の数行だけであることを確かめる
> 2. 作業ブランチを `main` から作り、2つのコミット（`cb78ece`・`593084f`）を `git cherry-pick` する。衝突したら、`main` の今の内容を基に、`mkdir -p "$HOME/.cache"` と `mkdir -p -m 700 "$HOME/.cache/pr-review"` の2点と、状態の表記・件数の書き方を手で反映する
> 3. `CLAUDE.md` の決まりどおり、Open の PR を作り、pr-review を実行する（この PR 自体が、直した手順書での2回目の実行の確認になる）
> 4. マージ後、ブランチ `claude/blissful-knuth-i1n1m4` を削除する
> 完了の条件：`main` の `SKILL.md` で、作業フォルダの作成が `mkdir -p` になっている。`npm test` と `npm run build` が成功する。コミットメッセージは元のコミットのまま。

**関連する項目**：26、27

---

## 23. `CLAUDE.md` が旧環境を「移行が終わるまで壊さない」と指示したまま

- 重大度：中
- 分類：ドキュメント
- 状態：完了（PR #94。`CLAUDE.md` の旧環境の行を消し、`scripts/build.mjs` のコメントを今の状態に直した）

**問題の内容と該当箇所**

`CLAUDE.md` の「1. 構成」10 行に「旧環境: GitHub Pages（ルートから配信）と、非公開リポジトリ `deadline-data` への GitHub 同期。移行が終わるまで壊さない」とある。
しかし、GitHub 同期のコードは v4.0 で削除済みで、GitHub Pages の停止と `deadline-data` のアーカイブも済んだ（2026-11-04、持ち主が報告）。
同じく `scripts/build.mjs` の冒頭（2〜3 行）と 88 行のコメントも「GitHub Pages がルートから配信している間は」のままになっている。

**なぜ問題なのか**

`CLAUDE.md` は、実装担当の AI が作業前に必ず読む規則。
古い指示が残っていると、次のような判断の誤りにつながる。

- 消えた環境を守るための手作業（ルートの `?v=` の手での更新など）を続ける
- 「旧環境を壊さない」ために、要らない分岐を残す

**改善案**

`CLAUDE.md` の「1. 構成」から旧環境の行を消し、「移行は完了。経緯は `docs/cloudflare-migration.md`」の1行にする。
`scripts/build.mjs` のコメントも今の状態に合わせる（コードの動きは変えない。動きを変えるのは項目24）。

**実装担当への指示文**

> 目的：`CLAUDE.md` と `scripts/build.mjs` のコメントを、移行が完了した今の状態に合わせる。
> 対象ファイル：`CLAUDE.md`（「1. 構成」）、`scripts/build.mjs`（冒頭のコメントと 88 行付近のコメント）。
> やること：
> 1. `CLAUDE.md` の「旧環境: …移行が終わるまで壊さない」の行を消す。「移行の計画と進捗」の行を「Cloudflare への移行は完了（2026-11-04）。経緯は `docs/cloudflare-migration.md`」に変える
> 2. `CLAUDE.md` の他の行で、旧環境（GitHub Pages・`deadline-data`・GitHub 同期）を前提にした記述が無いか探して直す
> 3. `scripts/build.mjs` の「GitHub Pages がリポジトリのルートから配信している間は…」のコメントを、「ルートの画面のファイルが元で、web/ はビルドで作る写し（Worker の静的配信用）」に直す。コードは変えない
> 完了の条件：`grep -n "GitHub Pages\|deadline-data\|壊さない" CLAUDE.md scripts/build.mjs` で、旧環境を前提にした記述が残っていない（経緯として触れるだけの文は可）。`npm test` と `npm run build` が成功する。コミットメッセージは `docs: 要約`。

**関連する項目**：24

---

## 24. ルートの `?v=`・`build-stamp` を、まだ毎回手で更新している

- 重大度：低
- 分類：保守性
- 状態：完了（PR #94。ルートの `?v=`・`build-stamp`・`CACHE_NAME` を `dev` に固定し、ビルドが本当の値に置き換える。`build.test.js` で、ルートが `dev` のままであること・`web/` に `dev` が残らないことを確認）

**問題の内容と該当箇所**

第1回の項目5で、Worker から配信する `web/` の版番号はビルドが自動で書き換えるようになった。
一方、ルートの `index.html` の次の3か所は、変更のたびに手で更新されている（直近のコミットでも `20261104-1200` に更新されている）。

- `app.js?v=...`（118 行）
- `styles.css?v=...`（38 行）
- `build-stamp`（22 行）

`index.html` 20〜21 行のコメントは「この手作業は必須ではない」と言いつつ、手順として残している。
GitHub Pages は停止したので、ルートの値を使うのは、ファイルを直接開いたときだけになった。

**なぜ問題なのか**

毎回の差分に意味のない変更が入り、更新忘れの指摘（第1回の項目5の根本原因）が残り続ける。
レビューの手間も増える。

**改善案**

ルートの `index.html` の3か所を、決まった印（例：`app.js?v=dev`、`build-stamp` は `dev`）に固定し、ビルドだけが本当の値に置き換えるようにする。
コメントの「v も同じ日時に変える」という手順を消す。

**実装担当への指示文**

> 目的：ルートの `index.html` の版番号を手で更新する作業をなくす。Worker 配信（`web/`）の動きは変えない。
> 対象ファイル：`index.html`（20〜22 行のコメントと `build-stamp`、38 行、118 行）、`scripts/build.mjs`（置き換えの処理）、`test/unit/build.test.js`、`CLAUDE.md`・`docs/VERSIONS.md`（手順の記述があれば）。
> やること：
> 1. `index.html` の `styles.css?v=...`・`app.js?v=...` を `?v=dev` に、`build-stamp` の内容を `dev` に固定する。`app-version`（`3.x` などの版番号）は今までどおり手で決める値なので変えない
> 2. `scripts/build.mjs` の置き換えが、`dev` から本当の値（ハッシュ・日時）に置き換えられることを確かめる（今の正規表現で置き換えられなければ直す）。置き換え対象が見つからなければビルドを失敗させる、という今の作りは保つ
> 3. `index.html` のコメントから「v も同じ日時に変える」の手順を消し、「ルートは dev のまま。web/ はビルドが書き換える」と書く
> 4. `CLAUDE.md`・`docs/VERSIONS.md`・`.claude/` 内の手順書に、「`?v=` と `build-stamp` を更新する」という指示が残っていれば消す
> 5. `test/unit/build.test.js` に「ルートの index.html は dev のまま」「web/index.html は dev を含まない」を足す
> 6. 設定の「バージョン」表示が、`dev` のまま開いた（ルートを直接開いた）ときに崩れないか確かめる
> 完了の条件：`npm test` と `npm run build` が成功する。`web/index.html` に `dev` が残らない。コミットメッセージは `build: 要約`。

**関連する項目**：23、第1回の 5

---

## 25. Cron の CPU 時間（無料プランは 10ms）を測っていない

- 重大度：低
- 分類：性能
- 状態：一部完了（PR #96。20:23 の Cron で D1 の読み込みを1回にし、データの共有で互いに影響しないこと・失敗を握りつぶさないことをテストで確認。架空の大きめのデータ〔締切300・繰り返し50・完了500〕で測った文面づくりは、朝 約3.0ms／夜 月〜土 約3.9ms／夜 日曜 約4.5ms〔この環境の Node。D1 の読み込み・JSON の解析を含まない〕。**残り：本番の CPU 時間を、Cloudflare のダッシュボード（Workers → deadline-tracker → Metrics → CPU time）で、日曜 20:23 の回を持ち主が一度確かめる**）

**問題の内容と該当箇所**

20:23 の Cron（`worker/src/jobs.js` の `runScheduled`、146 行付近）は、1回の実行で次の2つを行う。

- 翌日分のメール
- 夜の再通知（日曜は週次レビュー）

それぞれが別々に締切データを D1 から読み、`JSON.parse` する（`loadData` が2回）。
週次レビュー（`worker/src/review.js`）は、完了の記録（最大500件）の集計と、繰り返しの展開を行う。
無料プランの CPU 時間の上限（10ms）は Cron にも当たるが、データが増えたときにどれくらいかかるかを測るテストや記録がない。

**なぜ問題なのか**

上限を超えると、その回の通知が届かない（Cron の履歴に失敗が残るだけ）。
データ（締切・完了の記録）は使うほど増えるので、ある日から日曜だけ届かない、という形で現れうる。

**改善案**

- 大きめのテスト用データ（締切300件・完了の記録500件・繰り返し50件など）で、`buildWeekly`・`buildDigest`・メール本文の作成にかかる時間を `node --test` の中で測り、目安（例：合計 5ms）を超えたら警告するテストを足す（Node と Workers の速さは同じではないので、目安は余裕を持たせる）
- 20:23 の Cron では、データを1回だけ読んで、メールと夜の通知の両方に渡す
- 本番の CPU 時間は、Cloudflare のダッシュボード（Workers → deadline-tracker → Metrics の CPU time）で、日曜 20:23 の回を持ち主が一度確かめる

**実装担当への指示文**

> 目的：Cron 1回あたりの CPU 時間が、データが増えても無料プランの上限（10ms）に収まるかを確かめられるようにし、無駄な読み込みを減らす。
> 対象ファイル：`worker/src/jobs.js`（`runScheduled`・`loadData`・`runMail`・`sendDigest`）、テスト `test/unit/jobs.test.js`、新しいテスト用データ `test/fixtures/data-large.json`（架空の内容で作る。実在の名前は使わない）。
> やること：
> 1. 架空のデータを作るスクリプトをテストの中に書くか、`data-large.json` を作る：締切300件（繰り返し50件を含む）、完了の記録500件
> 2. `buildDigest`・`buildEvening`・`buildWeekly`・メール本文の作成を、このデータで10回ずつ実行し、1回あたりの時間（`performance.now()`）を測る。合計が 5ms を超えたら `t.diagnostic` で警告を出す（テストは失敗させない。CI の速さで揺れるため）
> 3. `runScheduled` の 20:23 の分岐で、締切データを1回だけ読み、メールと夜の通知（週次レビュー）の両方に渡すようにする（`sendMail`・`sendDigest` に、読んだデータを渡せる引数を足す。渡されなければ今までどおり自分で読む）
> 4. 既存の正解ファイル（`test/expected/`）との一致テストがすべて通ることを確かめる
> 5. 結果（測った時間）を、この項目の「状態」に書き足す
> 完了の条件：`npm test` と `npm run build` が成功する。20:23 の Cron で D1 の読み込みが1回になる。コミットメッセージは `fix: 要約`（測定のテストは `test: 要約` で分けてもよい）。

**関連する項目**：第1回の 2

---

## 26. 2つの自動レビュー（`claude-code-review.yml` と pr-review）が同じ PR を二重に見ている

- 重大度：低
- 分類：保守性
- 状態：完了（持ち主が案2〔pr-review に一本化〕を選んだ〔2026-11-04〕。PR #97 で `claude-code-review.yml` を削除し、`CLAUDE.md` を合わせた。Secret `CLAUDE_CODE_OAUTH_TOKEN` の削除と、ブランチ保護の必須チェックに `Code Review` が入っていないかの確認は、持ち主が行う）

**問題の内容と該当箇所**

PR ごとに、次の2つのレビューが動いている。

- GitHub Actions の `.github/workflows/claude-code-review.yml`：PR の作成・プッシュのたびに `code-review` プラグインが行コメントを付ける
- `CLAUDE.md` の「自動レビュー」の決まり：PR を作った Claude Code のセッションが、`pr-review` スキル（3つの視点のサブエージェント）でまとめコメントを付ける

`CLAUDE.md` は、両方（`claude[bot]` と pr-review）の指摘を自動で直すよう定めている。

**なぜ問題なのか**

同じ差分を2回レビューするので、時間・利用枠を2倍使う。
指摘が重なったり食い違ったりすると、直す側（実装担当の AI）の繰り返しが増える。
意図して両方を使っているなら問題ではない。

**改善案（持ち主が選ぶ）**

- 案1：両方残す（観点が違うので二重チェックとして使う）。`CLAUDE.md` に、両者の役割の違いと、指摘が食い違ったときの扱い（どちらを優先するか）を書く
- 案2：`claude-code-review.yml` をやめ、pr-review に一本化する（Actions の Secret `CLAUDE_CODE_OAUTH_TOKEN` も不要になる）
- 案3：pr-review をやめ、Actions のレビューに一本化する

**実装担当への指示文**

> 目的：（持ち主が案を選んだ後に）PR の自動レビューの重複を整理する。
> 前提：持ち主が案1〜3のどれにするか決めていること。決まっていなければ何もしない。
> 対象ファイル：案1は `CLAUDE.md` の「自動レビュー」。案2は `.github/workflows/claude-code-review.yml` の削除と `CLAUDE.md`・README の記述。案3は `.claude/skills/pr-review/`・`.claude/agents/pr-review-*.md` の削除と `CLAUDE.md`。
> やること（案1）：`CLAUDE.md` の「自動レビュー」に、Actions のレビュー（行ごとの指摘）と pr-review（3視点のまとめ）の役割の違いと、両者の指摘が食い違ったら利用者に確認する、という決まりを書く。
> やること（案2・3）：使わない側のファイルを消し、`CLAUDE.md`・README から記述を消す。案2のときは、Actions の Secret `CLAUDE_CODE_OAUTH_TOKEN` を消してよいことを持ち主に伝える（Secret の削除は持ち主が行う）。
> 完了の条件：`npm test` と `npm run build` が成功する。`CLAUDE.md` の記述と実際の仕組みが一致している。コミットメッセージは `ci:` または `docs:`。

**関連する項目**：22

---

## 27. マージ済みのブランチが約30本残っている

- 重大度：低
- 分類：保守性
- 状態：一部完了（2026-11-04：持ち主が「取り込み済みの35本だけ削除する」と決めた。残す：`main`・作業中の PR のブランチ・`claude/blissful-knuth-i1n1m4`（変更は #92 で `main` に入っている）・`claude/practical-pasteur-wk2mtv-pr2`（#56 のマージコミットだけ）。**残り：削除の実行。Claude Code の環境では、ブランチの削除が権限で止められたため、持ち主が実行する**）

**問題の内容と該当箇所**

GitHub に作業ブランチが30本ほど残っている（例：`design/d1-count-label`、`improve/item17-picks`、`cleanup/stage5b`）。
`main` に入っていないのは2本だけ。

- `claude/blissful-knuth-i1n1m4`：pr-review の修正。項目22で取り込む
- `claude/practical-pasteur-wk2mtv-pr2`：2026-10-27 の古いマージコミットだけ。中身は `main` に入っているとみられる（要確認）

**なぜ問題なのか**

どれが作業中なのか分からなくなる。
未マージの修正（項目22）も、この中に埋もれて見落とされていた。

**改善案**

マージ済みのブランチを消す。
今後は GitHub の設定「Automatically delete head branches」（Settings → General → Pull Requests）をオンにして、マージ時に自動で消えるようにする（設定は持ち主が行う）。

**実装担当への指示文**

> 目的：マージ済みの作業ブランチを整理し、今後は自動で消えるようにする。
> 前提：ブランチの削除は取り消しにくいので、消す一覧を持ち主に見せて了承を得てから行う。
> やること：
> 1. `git fetch origin` の後、`main` 以外の各ブランチについて `git merge-base --is-ancestor origin/<ブランチ> origin/main` で、マージ済みかを調べ、一覧を作る
> 2. `claude/practical-pasteur-wk2mtv-pr2` は、`git diff origin/main...origin/claude/practical-pasteur-wk2mtv-pr2` が空（または `main` に同じ内容がある）ことを確かめ、結果を一覧に書く
> 3. 一覧を持ち主に見せ、了承を得たブランチだけを `git push origin --delete <ブランチ>` で消す。`claude/blissful-knuth-i1n1m4` は項目22が終わるまで消さない
> 4. 持ち主に、GitHub の Settings → General → Pull Requests の「Automatically delete head branches」をオンにするよう伝える
> 完了の条件：GitHub に残るブランチが、`main` と作業中のものだけになる。この項目の「状態」に、消したブランチの数を書く。

**関連する項目**：22

---

## 28. 設定の見出しなどに、v4.0 で消えた機能の名残の文言がある

- 重大度：低
- 分類：使いやすさ
- 状態：完了（PR #95。同期の節の見出し・保存領域の案内・トーストの文言を直した。見た目のたとえ・コードのコメント・端末内の記録のキー名は変えていない）

**問題の内容と該当箇所**

v4.0 で GitHub 同期と Discord の直接送信を消したが、画面の文言に名残がある。

- 設定の同期の節の見出しが「端末間の同期とDiscord通知」（`app.js:2589`・`2593`）。Discord の Webhook の入力欄はもう無く、Discord への送信は Worker が行う
- 保存領域が使えない環境の案内が「GitHub Pages に置けば端末内に保存されます」（`app.js:772`）。GitHub Pages は停止した

**なぜ問題なのか**

存在しない設定を探して迷う。小さいが、毎回目に入る見出し。

**改善案**

見出しを「端末間の同期」に、案内を「この画面ではブラウザの保存領域が使えないため、入力内容は再読み込みで消えます。プライベートブラウズを使っていれば、通常のウィンドウで開いてください」のように、今の環境に合う文にする。
他にも、画面の文言に「GitHub」「Webhook」「Pages」が残っていないか探す（「GitHub の草のよう」のような見た目の説明は残してよい）。

**実装担当への指示文**

> 目的：v4.0 で消えた機能（GitHub 同期・Discord の直接送信・GitHub Pages）を指す、画面の文言を今の状態に合わせる。
> 対象ファイル：`app.js`（772 行付近、2589 行・2593 行付近、その他 `grep -n "GitHub\|Webhook\|Pages\|Discord" app.js` で見つかる画面の文言）、`index.html`、README（画面の説明と食い違う箇所があれば）。
> やること：
> 1. 設定の同期の節の見出し「端末間の同期とDiscord通知」を「端末間の同期」にする（2か所）。目次（設定の先頭）に同じ文言があれば合わせる
> 2. `app.js:772` の案内から「GitHub Pages に置けば」を外し、今の環境で取れる行動（通常のウィンドウで開く、など）を書く
> 3. `grep` で見つけた画面の文言のうち、消えた機能を指すものを直す。「GitHub の草」など見た目のたとえ、コード中のコメント、端末内の記録のキー名（`gh-known-updatedAt` など。名前を変えると記録が消える）は変えない
> 4. 文言を変えたテストがあれば合わせる
> 5. `index.html` の版番号（項目24が終わっていなければ `app.js?v=...`・`build-stamp`）と `package.json` の patch を上げる
> 完了の条件：`npm test` と `npm run build` が成功する。設定画面に、存在しない機能を指す見出し・説明が無い。コミットメッセージは `fix: 要約`。

**関連する項目**：23

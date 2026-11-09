# フィードの定期取得とバックログ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 購読フィードをCloudflareの定期実行で取得してD1に90日分ためておき、端末はその差分を受け取ってFor You（関心度順）やフィードごとの一覧でさかのぼって読めるようにする。

**Architecture:** サーバー側は `lib/backlog/`（D1への記事の追加・差分配信・既読・期限切れ削除・取得順の決定）と、Workerの `scheduled` ハンドラー、薄いAPIルートから成る。端末側はIndexedDBに記事をため、同期データ（保存・メモなど保持対象だけを持つ）とバックログを合わせた「表示用のreader」を作って、既存の画面にそのまま渡す。

**Tech Stack:** TypeScript、vinext、Cloudflare Workers（Cron Trigger、無料プラン）、D1（drizzle-kitでmigration生成）、IndexedDB、node:test＋node:sqlite（D1の代わり）。

**Spec:** `docs/superpowers/specs/2026-11-09-feed-backlog-design.md`（実装前に全文を読むこと）。リポジトリの決まりは `AGENTS.md`。

## Global Constraints

- 記事の保持期間は90日（`RETENTION_DAYS = 90`）。基準は `fetched_at`。
- 定期実行は `*/5 * * * *`。1回に「優先フィード1件＋通常フィード1件」。どちらも `last_fetched_at` が最も古い（未取得はさらに優先）ものを選ぶ。優先が0件なら通常を2件。
- 優先フィードは最大5件（`MAX_PRIORITY_FEEDS = 5`）。
- 1フィードの取り込み上限は `MAX_ARTICLES = 200`（変更しない）。
- 差分取得は1回最大1,000件（`MAX_CHANGES_PAGE = 1000`）。既読の更新は1回最大1,000件（`MAX_READ_BATCH = 1000`）。
- 定期取得の対象は、`last_seen_at` が90日以内かつ `email` が `FOLIO_ALLOWED_EMAILS` に含まれる利用者。`last_seen_at` の更新は1時間に1回まで。
- 期限切れ削除は1日1回（UTC 03:00〜03:04の実行時）、1回最大5,000行。
- `folio_articles.payload` に `content` / `contentFetchedAt` を入れない。
- 定期取得を外部から起動するHTTPエンドポイントを作らない。
- 配信元の応答本文やエラーメッセージは保存・表示しない。失敗は種類だけ記録する：`network` / `http` / `format` / `timeout`。
- 画面の文言（そのまま使う）：「優先して取得」「優先して取得できるのは5件までです。」「最後に取得：{日時}」「まだ取得していません」「取得に失敗しました」「新着{n}件」「すべて既読にする」「表示中の未読{n}件を既読にします。」「既読にする」「キャンセル」
- 既存の決まり（`AGENTS.md`）：利用者は `getCurrentUser()` からだけ取る／同期データに足す項目は任意項目にし、項目の無い既存文書を読めるようにする／テストから読むモジュールは `.ts` 拡張子付きで import／ルートは薄く、判断は `lib/` に置いてテストする。
- 各タスクの最後に `npm test`・`npx tsc --noEmit`・`npm run lint`（エラー0）が通ること。

## Review Focus

1. **同じURLの記事が2つのフィードから届く、またはGUIDが変わる**：記事は1件にまとまり、既読状態が保たれる。→ Task 3 のテスト。
2. **同じ端末で別の利用者に切り替わる**：前の利用者のバックログを表示・送信しない。→ Task 7 のテスト。
3. **購読を解除した直後に定期取得が走る**：解除したフィードは取得しない。→ Task 4 のテスト。
4. **オフラインで既読にしてから再読み込み・再接続する**：既読操作は失われず、接続後に送られる。→ Task 7 のテスト。
5. **1,000件を超える「すべて既読にする」が途中で失敗する**：送れた分は既読のまま、残りは再試行でき、件数が分かる。→ Task 9 のテスト。

---

### Task 1: D1のテーブルとテスト用D1

**Files:**
- Modify: `db/schema.ts`
- Create: `drizzle/0002_*.sql`（`npx drizzle-kit generate` で生成。meta も更新される）
- Create: `tests/helpers/d1.ts`
- Modify: `tests/cloud-library.test.ts`（自前のD1もどきを helper に置き換える）
- Test: `tests/backlog-schema.test.ts`

**Interfaces:**
- Produces（`tests/helpers/d1.ts`）：`createTestD1(): D1Like & { sqlite: DatabaseSync }`。`node:sqlite` の `:memory:` に `drizzle/*.sql` をファイル名順に適用する。`prepare(sql).bind(...).first/all/run`、`batch(statements)`（トランザクション、2MB制限の検査は既存の実装を移す）を持つ。
- Produces（スキーマ。列名はspec 2章どおり）：
  - `folio_articles`：`user_id` TEXT, `article_id` TEXT, `feed_id` TEXT, `url` TEXT, `published_at` TEXT, `fetched_at` TEXT, `read_at` TEXT NULL, `updated_seq` INTEGER, `payload` TEXT。PK `(user_id, article_id)`、UNIQUE `(user_id, url)`、INDEX `(user_id, updated_seq, article_id)`、INDEX `(fetched_at)`。
  - `folio_feeds`：`user_id`, `feed_id`, `url`, `name`, `priority` INTEGER（0/1）。PK `(user_id, feed_id)`。
  - `folio_users`：`user_id` PK, `email`, `last_seen_at`。
  - `folio_feed_state`：`user_id`, `feed_id`, `last_fetched_at` NULL, `etag` NULL, `last_modified` NULL, `last_error` NULL。PK `(user_id, feed_id)`。
  - 計画上の判断：specの `seq` 列は `updated_seq` に一本化する（追加時も既読変更時も同じ列を進めれば差分取得に足りる）。値は「その利用者の `MAX(updated_seq)` ＋1」を同じSQL文の中で求める。同じ文で複数行を書くと同値になるため、カーソルは `(updated_seq, article_id)` の組で進める（Task 3）。

- [ ] **Step 1: 失敗するテストを書く**（`tests/backlog-schema.test.ts`）：`createTestD1()` 後、`PRAGMA table_info` で4テーブルの列名が上記と一致し、`folio_articles` に同じ `(user_id,url)` の2行目を入れると失敗すること。
- [ ] **Step 2:** `npm test` で失敗を確認。
- [ ] **Step 3:** `db/schema.ts` に4テーブルを追加し、`npx drizzle-kit generate` でmigrationを生成。`tests/helpers/d1.ts` を作り、`tests/cloud-library.test.ts` をhelper利用に切り替える（期待値は変えない）。
- [ ] **Step 4:** テスト・型チェック・lintが通る。
- [ ] **Step 5:** Commit `feat(db): バックログ用のテーブルを追加する`

### Task 2: 条件付き取得に対応した `fetchFeed`

**Files:**
- Modify: `lib/feeds.ts`、`tests/feeds.test.ts`

**Interfaces:**
- Produces：
  - `type FeedFetchResult = { status: 'ok'; feed: ParsedFeed; etag: string | null; lastModified: string | null } | { status: 'not-modified' }`
  - `fetchFeedConditional(feedUrl: string, options?: { etag?: string | null; lastModified?: string | null; fetcher?: typeof fetch }): Promise<FeedFetchResult>`：`If-None-Match` / `If-Modified-Since` を付け、304なら解析せず `not-modified`。安全性の検査・リダイレクト・タイムアウト・2MiBは既存 `fetchFeed` と同じ。
  - 既存の `fetchFeed(feedUrl, fetcher)` は `fetchFeedConditional` を使う形に書き換え、戻り値と挙動は変えない。
  - `feedErrorKind(error: unknown): 'network' | 'http' | 'format' | 'timeout'`：`FeedError` の status 504→timeout、502かつ接続失敗→network、502かつHTTP→http、それ以外→format。

- [ ] **Step 1: 失敗するテストを書く**：etag/lastModifiedを渡すと要求ヘッダーに載る／304で `not-modified`、本文を読まない／200で応答の `ETag`・`Last-Modified` を返す／リダイレクト先が危険なら従来どおり拒否／`feedErrorKind` の対応表。
- [ ] **Step 2〜4:** 失敗確認→実装→通過（既存のfeedsテストも通る）。
- [ ] **Step 5:** Commit `feat(feeds): ETagとLast-Modifiedによる条件付き取得に対応する`

### Task 3: バックログの保存・差分・既読・期限切れ（サーバー）

**Files:**
- Create: `lib/backlog/constants.ts`、`lib/backlog/store.ts`、`tests/backlog-store.test.ts`

**Interfaces:**
- Consumes: Task 1 のテーブル・`createTestD1`。
- Produces（`constants.ts`）：`RETENTION_DAYS = 90`、`MAX_CHANGES_PAGE = 1000`、`MAX_READ_BATCH = 1000`、`MAX_PRIORITY_FEEDS = 5`。
- Produces（`store.ts`、`db` は `Pick<D1Database,'prepare'|'batch'>`）：
  - `type StoredArticle = Omit<Article, 'content' | 'contentFetchedAt'>`
  - `type BacklogEntry = { article: StoredArticle; feedId: string; fetchedAt: string; readAt: string | null }`
  - `insertArticles(db, userId: string, feedId: string, articles: Article[], now: Date): Promise<number>`：新しい記事だけ追加（`article_id` か `url` が既にあれば無視＝既読を保つ）。`content`/`contentFetchedAt` は捨てる。戻り値は追加件数。
  - `listChanges(db, userId: string, cursor: string | null, limit?: number): Promise<{ entries: BacklogEntry[]; next: string; hasMore: boolean }>`：`(updated_seq, article_id)` の昇順。カーソルは `"<updated_seq>:<article_id>"`（`encodeURIComponent` で安全に）。不正なカーソルは `BacklogInputError`。
  - `setRead(db, userId: string, articleIds: string[], read: boolean, now: Date): Promise<number>`：1,000件超は `BacklogInputError`。変化した行の `updated_seq` を進める。
  - `importArticles(db, userId: string, articles: Article[], readIds: string[], now: Date): Promise<{ inserted: number; markedRead: number }>`：`insertArticles` と同じ規則で追加し、`readIds` に含まれる行で未読のものを既読にする。何度実行しても結果が同じ。
  - `purgeExpired(db, now: Date, limit?: number): Promise<number>`：`fetched_at` が90日より前の行を最大 `limit`（既定5,000）件削除。
  - `class BacklogInputError extends Error`

- [ ] **Step 1: 失敗するテストを書く**
  - 追加：新規だけ入る／同じURL・別IDは無視（Review Focus 1）／既読の行が再取得で未読に戻らない／`content` が `payload` に入らない。
  - 差分：利用者ごとに分かれる／1,500件を `limit` 1,000で2ページに分けて漏れ・重複が無い（同じ `updated_seq` の行がページ境界をまたぐケースを含む）／既読の変更が後のページに現れる。
  - 既読：1,001件で `BacklogInputError`／他の利用者の行は変わらない。
  - 取り込み：2回実行しても件数・既読が変わらない。
  - 期限切れ：90日と1分前の行は消え、89日の行は残る／`limit` を守る。
- [ ] **Step 2〜4:** 失敗確認→実装→通過。
- [ ] **Step 5:** Commit `feat(backlog): 記事の蓄積・差分・既読・期限切れ削除を実装する`

### Task 4: 購読一覧の写し・利用者の記録・取得順の決定

**Files:**
- Create: `lib/backlog/schedule.ts`、`tests/backlog-schedule.test.ts`
- Modify: `lib/types.ts`（`Feed` に `priority?: boolean`）、`lib/storage.ts`（feed検証で `priority` を許可）、`lib/cloud-library.ts`（zodの `feed` に `priority: z.boolean().optional()`）、`tests/cloud-library.test.ts`

**Interfaces:**
- Produces（`schedule.ts`）：
  - `syncFeedList(db, userId: string, feeds: Feed[]): Promise<void>`：`folio_feeds` を購読一覧と一致させる（追加・名前/URL/優先の更新・削除）。優先は購読順に最初の5件だけを1にする。
  - `touchUser(db, userId: string, email: string, now: Date): Promise<void>`：`last_seen_at` が1時間以上前（または未登録）のときだけ書く。
  - `type FeedTarget = { userId: string; feedId: string; url: string; etag: string | null; lastModified: string | null; priority: boolean }`
  - `pickFeedsToFetch(db, now: Date, allowedEmails: Set<string>): Promise<FeedTarget[]>`：対象利用者のフィードから、優先1件＋通常1件（優先0件なら通常2件、通常0件なら優先2件）。各グループ内は `last_fetched_at` が NULL のもの→古いもの、同値なら `feed_id` 順。
  - `recordFeedResult(db, userId: string, feedId: string, now: Date, result: { ok: true; etag: string | null; lastModified: string | null } | { ok: false; error: 'network' | 'http' | 'format' | 'timeout' }): Promise<void>`：失敗時も `last_fetched_at` を進める（同じフィードで詰まらないように）。成功時は `last_error` を消す。
  - `listFeedStates(db, userId: string): Promise<{ feedId: string; lastFetchedAt: string | null; lastError: string | null }[]>`

- [ ] **Step 1: 失敗するテストを書く**
  - `syncFeedList`：追加・削除・優先変更が反映／優先が7件あっても1になるのは先頭5件。
  - `touchUser`：59分後は書かない、61分後は書く。
  - `pickFeedsToFetch`：未取得が最優先／優先と通常から1件ずつ／優先0件・通常0件の場合／`last_seen_at` が91日前の利用者や許可外メールの利用者は対象外／`syncFeedList` で削除したフィードは選ばれない（Review Focus 3）。
  - 同期データ：`priority` 付きの文書が検証を通り、無い文書も通る。
- [ ] **Step 2〜4:** 失敗確認→実装→通過。
- [ ] **Step 5:** Commit `feat(backlog): 取得順の決定と購読一覧の写しを実装する`

### Task 5: 定期実行（scheduled ハンドラーとCron設定）

**Files:**
- Create: `lib/backlog/scheduled.ts`、`tests/backlog-scheduled.test.ts`
- Modify: `worker/index.ts`、`scripts/cloudflare-config.mjs`、`tests/cloudflare-config.test.ts`、`cloudflare-env.d.ts`（必要なら）

**Interfaces:**
- Consumes: Task 2 `fetchFeedConditional` / `feedErrorKind`、Task 3 `insertArticles` / `purgeExpired`、Task 4 `pickFeedsToFetch` / `recordFeedResult`。
- Produces：
  - `runScheduledFetch(deps: { db; now: Date; allowedEmails: Set<string>; fetcher?: typeof fetch }): Promise<{ fetched: number; inserted: number; failed: number; purged: number }>`：選んだフィードを順に取得・追加・記録する。1件の失敗で止まらない。UTC 03:00〜03:04 のときだけ `purgeExpired` を呼ぶ。
  - `parseAllowedEmails(value: string | undefined): Set<string>`（小文字化・空要素除外）。
  - `worker/index.ts` に `scheduled(controller, env, ctx)` を追加し、`ctx.waitUntil(runScheduledFetch({ db: env.DB, now: new Date(controller.scheduledTime), allowedEmails: parseAllowedEmails(env.FOLIO_ALLOWED_EMAILS) }))`。`env.DB` が無ければ何もしない。
  - `workerConfiguration` に `triggers: { crons: ['*/5 * * * *'] }`。開発用の設定（`scripts/vite/cloudflare-config.ts` の serve）には含めない。

- [ ] **Step 1: 失敗するテストを書く**：偽の `fetcher` で、新規記事が入り `last_fetched_at` が進む／304でETagを保ったまま解析しない／1件目が失敗しても2件目は処理し、`last_error` が `http` 等になる／03:02なら90日超の行が消え、04:00なら消えない／`workerConfiguration(...).triggers.crons` が `['*/5 * * * *']`。
- [ ] **Step 2〜4:** 失敗確認→実装→通過。`npm run cloudflare:dry-run` の出力に Cron の設定が含まれることを確認。
- [ ] **Step 5:** Commit `feat(backlog): 5分ごとの定期取得を追加する`

### Task 6: バックログのAPI

**Files:**
- Create: `lib/backlog/api.ts`、`tests/backlog-api.test.ts`、`app/api/articles/route.ts`（GET）、`app/api/articles/read/route.ts`（POST）、`app/api/articles/import/route.ts`（POST）、`app/api/feeds/refresh/route.ts`（POST）、`app/api/feeds/state/route.ts`（GET）
- Modify: `app/api/library/route.ts`

**Interfaces:**
- Consumes: Task 3・4・2。`getCurrentUser()`、`isSameOrigin`、`readLimitedText`、`NO_STORE_HEADERS`。
- Produces（`api.ts`。各関数は `Request` と `{ db, user }` を受けて `Response` を返す。ルートはログイン・`env.DB` の確認だけして委譲する）：
  - `handleListChanges`：`?after=` → `listChanges` の結果をJSONで返す。
  - `handleSetRead`：body `{ ids: string[], read: boolean }`。same-origin必須。1,000件超は400。
  - `handleImport`：body `{ articles: Article[], read: string[] }`（上限8MiB）。same-origin必須。
  - `handleRefreshFeed`：`?feed=<feedId>`。`folio_feeds` にその利用者のフィードとして存在する場合だけ `fetchFeedConditional`→`insertArticles`→`recordFeedResult`。結果 `{ inserted, error? }`。
  - `handleFeedStates`：`listFeedStates` を返す。
  - 既存 `PUT /api/library`：保存成功後に `syncFeedList(db, user.id, document.reader.feeds)`。既存 `GET /api/library`：`touchUser(db, user.id, user.email, now)`（失敗しても応答は変えない）。
- 文言：未ログイン401「ログインしてください。」、別オリジン403「同じサイトから操作してください。」、件数超過400「一度に既読にできるのは1,000件までです。」、存在しないフィード404「フィードが見つかりません。」

- [ ] **Step 1: 失敗するテストを書く**：各ハンドラーの正常系／他の利用者の記事やフィードに触れられない／別オリジンで403／1,001件で400／不正カーソルで400／refreshで未登録フィードは404。
- [ ] **Step 2〜4:** 失敗確認→実装→通過。
- [ ] **Step 5:** Commit `feat(backlog): 差分取得・既読・取り込み・即時取得のAPIを追加する`

### Task 7: 端末側のバックログ（IndexedDBと同期）

**Files:**
- Create: `lib/backlog/client-state.ts`（純粋関数）、`lib/backlog/client-db.ts`（IndexedDBの薄い層）、`hooks/use-backlog.ts`、`tests/backlog-client.test.ts`

**Interfaces:**
- Consumes: Task 6 のAPI、`BacklogEntry`。
- Produces（`client-state.ts`）：
  - `type BacklogState = { ownerId: string; cursor: string | null; entries: Map<string, BacklogEntry>; pendingReads: Map<string, boolean> }`
  - `applyChanges(state, entries: BacklogEntry[], next: string): BacklogState`（新しいものを上書き。ただし未送信の既読操作がある記事は端末の状態を優先）
  - `expireEntries(state, now: Date): BacklogState`（90日超を除く）
  - `queueRead(state, ids: string[], read: boolean): BacklogState`
  - `takePendingBatches(state, size = 1000): { ids: string[]; read: boolean }[]`
  - `forOwner(state | null, ownerId: string): BacklogState`（別の持ち主なら空の状態を返す）
- Produces（`client-db.ts`）：DB名 `folio-backlog`、ストアは利用者ごとにキーを分ける。`loadBacklog(ownerId)`、`saveBacklog(state)`、`saveContent(ownerId, articleId, content, fetchedAt)`、`loadContent(ownerId, articleId)`。IndexedDBが使えない環境ではメモリーだけで動く。
- Produces（`use-backlog.ts`）：`useBacklog(ownerId: string | null)` → `{ ready: boolean; articles: Article[]; readIds: Set<string>; setRead(ids: string[], read: boolean): void; sync(): Promise<void>; refreshFeeds(feedIds: string[]): Promise<void>; lastError: string }`。開いたとき・`sync()`・画面表示中の5分ごとに差分を取得。既読操作はまずIndexedDBの `pendingReads` に入れてから1,000件ずつ送る。

- [ ] **Step 1: 失敗するテストを書く**（純粋関数のみ）：差分の適用と上書き規則／未送信の既読が差分で上書きされない（Review Focus 4）／90日超の除去／2,500件の既読が1,000・1,000・500に分かれる／別の持ち主では空になる（Review Focus 2）。
- [ ] **Step 2〜4:** 失敗確認→実装→通過。
- [ ] **Step 5:** Commit `feat(backlog): 端末側のバックログと差分同期を実装する`

### Task 8: 同期データの意味の変更と移行

**Files:**
- Modify: `lib/types.ts`（`ReaderState` に `backlogMigratedAt?: string`）、`lib/storage.ts`、`lib/cloud-library.ts`、`lib/retention.ts`、`lib/library-backup.ts`
- Create: `lib/backlog/migration.ts`、`tests/backlog-migration.test.ts`
- Modify: `tests/retention.test.ts`、`tests/library-backup.test.ts`

**Interfaces:**
- Produces：
  - `retainedArticleIds(reader, intelligence)`：現行の対象から `reader.read` を除く（保存・メモ・ダイジェスト・AI回答の引用・ストーリー比較の参照）。
  - `needsBacklogMigration(reader: ReaderState): boolean`（`backlogMigratedAt` が無い、かつ保持対象外の記事か `read` がある）
  - `migrationPayload(reader, intelligence): { articles: Article[]; read: string[] }`
  - `trimToRetained(reader, intelligence, now: Date): ReaderState`：`articles` を保持対象だけに、`read` を保持対象のIDだけにし、`backlogMigratedAt` を入れる。
  - `retainArticle(reader: ReaderState, article: Article): ReaderState`：保持対象にした記事本体を `reader.articles` に写す（既にあれば何もしない）。
- 古い形式のバックアップを読み込んだ後は `backlogMigratedAt` が無いので、同じ移行が走る（Task 9 で実行）。

- [ ] **Step 1: 失敗するテストを書く**：既読だけの記事は保持対象にならない／`trimToRetained` 後に保存・メモの記事と、その既読だけが残る／`backlogMigratedAt` 付きは移行不要／`backlogMigratedAt` を含む文書と含まない文書の両方が検証を通る／古い形式のバックアップは移行対象になる。
- [ ] **Step 2〜4:** 失敗確認→実装→通過。
- [ ] **Step 5:** Commit `feat(backlog): 同期データを保持対象だけにし、移行の判定を追加する`

### Task 9: 画面の統合（表示用reader・For You・すべて既読）

**Files:**
- Create: `lib/backlog/view.ts`、`tests/backlog-view.test.ts`、`components/folio/mark-all-read.tsx`
- Modify: `app/page.tsx`、`components/folio/article-reader.tsx`、`components/folio/library-dialogs.tsx`（フィード追加後の即時取得）

**Interfaces:**
- Consumes: Task 7 `useBacklog`、Task 8 の関数。
- Produces（`view.ts`、純粋関数）：
  - `buildReaderView(state: ReaderState, backlog: { articles: Article[]; readIds: Set<string> }): ReaderState`：`articles` は保持対象とバックログの和（URLで重複除去、保持対象を優先）、`read` は同期データの `read` とバックログ既読の和。既存の画面にはこれを `reader` として渡す。
  - `freezeOrder(previous: string[] | null, ranked: Article[], refreshToken: number): string[]`：`refreshToken` が変わるまで並び順を固定し、新着は末尾に足さず件数だけ返す（`newCount`）。
  - `chunk<T>(items: T[], size: number): T[][]`
- 画面：
  - For You と各一覧は `buildReaderView` の結果を使う。既読にした記事はその場で消さない。差分で届いた新着は「新着{n}件」を一覧上部に出し、押すと並び直す。
  - 既読の切り替え・元記事を開いたときの自動既読は、バックログの記事なら `useBacklog().setRead`、保持対象なら同期データの `read` を更新する。
  - 「すべて既読にする」ボタン（`mark-all-read.tsx`）：表示中の一覧の未読件数を出し、確認（「表示中の未読{n}件を既読にします。」「既読にする」「キャンセル」）後に1,000件ずつ送る。途中で失敗したら、送れた件数と再試行を表示する（Review Focus 5）。
  - 「更新」：優先フィードを順に `refreshFeeds` してから `sync()`。ブラウザーからRSSを直接取得する現行の処理は削除。
  - 起動時、`needsBacklogMigration` なら `POST /api/articles/import` を（1,000件ずつ）送り、成功後に `trimToRetained` を同期データに反映する。
  - 「AIで選び直す」の対象は For You の上位の未読から30件（現行どおり）。AIの結果が参照した記事は `retainArticle` で同期データに写す。
  - 記事詳細で取得した本文：保持対象の記事なら同期データの記事に付ける（現行）、それ以外は `saveContent` で端末にだけ置き、開いたときに `loadContent` で読む。
  - フィード追加後、そのフィードを `refreshFeeds([id])`。
  - バックアップ画面（`components/folio/library-backup-transfer.tsx`）の説明文を、spec「判断した点」のバックアップの範囲に合わせる（90日分の記事と、保存・メモ以外の記事の既読は含まれない旨）。

- [ ] **Step 1: 失敗するテストを書く**：`buildReaderView` の重複除去と既読の合成／`freezeOrder` が `refreshToken` 不変のあいだ順序を保ち新着数を数える／`chunk` の分割／すべて既読で2回目の送信が失敗したとき、1回目の1,000件は既読のまま残り件数が返る（`mark-all-read` の送信ロジックを純粋関数 `sendReadBatches(batches, send) → { sent: number; failedAt: number | null }` として `view.ts` に置いてテスト）。
- [ ] **Step 2〜3:** 失敗確認→実装。
- [ ] **Step 4:** テスト・型・lintが通る。`npm run dev` で（ローカルD1にmigration適用後）、フィード追加→即時取得→一覧表示→既読→再読み込みで既読が保たれる→「すべて既読にする」を確認。
- [ ] **Step 5:** Commit `feat(backlog): 一覧・For You・すべて既読をバックログに対応させる`

### Task 10: フィード管理画面（優先して取得・取得状況）

**Files:**
- Modify: `components/folio/library-dialogs.tsx` または フィード管理を描画している箇所（`app/page.tsx` の `modal==='feeds'`）
- Create: `lib/backlog/priority.ts`、`tests/backlog-priority.test.ts`

**Interfaces:**
- Produces：`togglePriority(feeds: Feed[], feedId: string): { feeds: Feed[]; error: string | null }`（6件目は変更せず「優先して取得できるのは5件までです。」）、`formatFetchState(state: { lastFetchedAt: string | null; lastError: string | null } | undefined, now: Date): string`（「最後に取得：…」「まだ取得していません」「取得に失敗しました」）。
- 画面：フィードごとに「優先して取得」の切り替えと取得状況を表示。状況は `GET /api/feeds/state` から読む。

- [ ] **Step 1: 失敗するテストを書く**：5件までON、6件目でエラー文言、OFFは常にできる／`formatFetchState` の3パターン。
- [ ] **Step 2〜4:** 失敗確認→実装→通過。画面で切り替えて再読み込み後も保たれることを確認。
- [ ] **Step 5:** Commit `feat(ui): フィードの優先取得と取得状況を表示する`

### Task 11: 件数が増えても遅くならないようにする

**Files:**
- Modify: `lib/discovery.ts`、`app/page.tsx`・`components/folio/intelligence-panels.tsx`（ニュースのまとまりの対象を直近7日に）
- Create: `tests/backlog-performance.test.ts`

**Interfaces:**
- Produces：`clusterStories(articles, readIds, now)` は同じ結果を返したまま、件数に比例する処理にする（索引で候補を絞る）。`recentArticles(articles: Article[], now: Date, days = 7): Article[]` を追加し、ニュースのまとまりはこれを通した記事で作る。

- [ ] **Step 1: 失敗するテストを書く**：既存の discovery / personalization のテストは期待値そのまま／30,000件の合成記事で `rankPersonalized` が2,000ms以内、7日分（5,000件）で `clusterStories` が1,000ms以内（CIの揺れを見込んだ値。手元で1秒以内の目安はspec 7章）。
- [ ] **Step 2〜4:** 失敗確認→改善→通過。
- [ ] **Step 5:** Commit `perf: 大量の記事でもおすすめとニュースのまとまりを速く計算する`

### Task 12: ドキュメント

**Files:**
- Modify: `README.md`、`docs/self-host-cloudflare.md`、`AGENTS.md`

- [ ] **Step 1:** README：定期取得（5分ごと・優先5件・90日）、For You の並び、すべて既読、既読や本文の保存先、バックアップの範囲、ローカルでは定期取得が動かないこと（「更新」で即時取得）、新しいmigrationの適用手順。
- [ ] **Step 2:** `docs/self-host-cloudflare.md`：Cron Trigger が自動で入ること、無料プランの制限とspec 9章の「切り替え後に確認すること」。
- [ ] **Step 3:** `AGENTS.md`：記事本体はバックログ（`lib/backlog/`）と同期データ（保持対象だけ）に分かれていること、同期データに大量の記事や既読IDを入れないこと。
- [ ] **Step 4:** `npm test`・`npx tsc --noEmit`・`npm run lint`・`npm run cloudflare:dry-run` がすべて通る。
- [ ] **Step 5:** Commit `docs: 定期取得とバックログについて記載する`

# Cloudflare専用化とAI提供元の切り替え Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sites／ChatGPT依存を取り除いてCloudflare専用にし、Node 24化し、AI提供元（OpenAI／Claude／OpenRouter／Workers AI）・モデル・推論の深さを画面で選べるようにする。

**Architecture:** Worker入口でCloudflare Access（開発時はloopback限定のdev認証）を検証し、`AsyncLocalStorage` で利用者を持ち回る。AIは提供元ごとの `AIProvider` 実装に送信だけを任せ、指示文・出力スキーマ・アプリ側検証は共通の `lib/ai.ts` に残す。AI設定は `IntelligenceState.ai` としてD1へ同期する。

**Tech Stack:** TypeScript、vinext（Next.js互換、Vite）、Cloudflare Workers・D1・Workers AI、jose、zod 3、`@anthropic-ai/sdk` 1.6系、node:test（Node 24のネイティブ型除去）。

**Spec:** `docs/superpowers/specs/2026-11-08-cloudflare-only-multi-ai-design.md`（実装前に必ず全文を読むこと）

## Global Constraints

- Node.js `>=24`。`.nvmrc` は `24`。
- 利用者IDの形式 `cloudflare-access:<sub>` を変えない。
- 受信ヘッダー `oai-*` を一切参照しない。
- APIキーはCloudflare Secretのみ（`OPENAI_API_KEY`／`ANTHROPIC_API_KEY`／`OPENROUTER_API_KEY`）。ブラウザー・D1・ログ・エラーメッセージに出さない。提供元の応答本文を利用者向けメッセージに含めない。
- `OPENAI_MODEL` は廃止。
- 既定モデル：OpenAI `gpt-6-luna`、Claude `claude-haiku-5-5`、OpenRouter `openai/gpt-6-luna`、Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`。
- 推論の深さの既定は `medium`（Workers AIは `auto`）。`auto` は推論設定を送らない。
- モデルIDは `^[A-Za-z0-9@/._:-]{1,200}$`。
- タイムアウト／最大出力トークン：`auto`・`none`・`low` → 45,000ms／16,000、`medium` → 90,000ms／16,000、`high`・`xhigh`・`max` → 120,000ms／32,000。ブラウザー側はサーバー＋10,000ms。
- 自動選択順：`anthropic` → `openai` → `openrouter`。`workers-ai` は自動選択しない。
- レート制限：利用者単位で1分6回（現行維持）。
- 画面文言（そのまま使う）：
  - 提供元名：`OpenAI`／`Claude`／`OpenRouter`／`Workers AI`
  - `auto` の表示：「モデルに任せる」
  - 「キー未設定」「この環境では使えません」「深いほど時間と費用がかかります」
  - `invalid_model`(400)：「選んだモデルを確認してください（提供元：{label}、モデル：{model}）」
  - `input_too_long`(413)：「対象の記事を減らすか、扱える長さの大きいモデルを選んでください（提供元：{label}、モデル：{model}）」
  - `unsupported_effort`(400)：「このモデルは推論の深さの指定に対応していません。『モデルに任せる』を選んでください（提供元：{label}、モデル：{model}）」
  - `incomplete_output`(502)：「AIの出力が途中で終わりました。推論の深さを下げるか対象記事を減らしてください。」
  - 401（同期）：「ログインしてください。」
- 既存テストはすべて維持（変更した仕様に合わせて期待値を直すのは可）。各タスクの最後に `npm test` と `npx tsc --noEmit` が通ること。

## Review Focus

1. **`ai` 項目の無い既存のD1文書・JSONバックアップ**：これまでどおり読み込め、既定（自動選択・`medium`）で動く。→ Task 10 のテスト。
2. **提供元のエラー本文にキーや内部情報が含まれる場合**：利用者向けメッセージに出ない（4提供元すべて）。→ Task 5〜8 の各テスト。
3. **`Cf-Access-Jwt-Assertion` が無い・不正なのに `oai-authenticated-user-*` だけ偽装したリクエスト**：403で、アプリ本体に届かない。→ Task 3 のテスト。
4. **保存済み設定の提供元のキーが後から削除された場合**：その提供元は「キー未設定」と表示され、POSTは503 `not_configured`。黙って別の提供元に切り替えない。→ Task 9 のテスト。
5. **Workers AIが `response` をオブジェクト・JSON文字列・```json で囲った文字列のどれで返しても**：同じように解釈し、壊れていれば `invalid_output`。→ Task 8 のテスト。

---

### Task 0: git管理を始める

**Files:** なし（リポジトリ初期化のみ）

- [ ] **Step 1:** `git init && git add -A && git commit -m "chore: import existing Folio source"`。`.gitignore` が `node_modules/`・`.folio/`・`.env*`・`.dev.vars*` を除外していることを `git status --ignored` で確認。
- [ ] **Step 2:** 作業ブランチを作る：`git switch -c cloudflare-only-multi-ai`。
- [ ] **Step 3:** 基準を記録：`npm test`（137 pass）、`npx tsc --noEmit`（0件）。

### Task 1: Node.js 24

**Files:**
- Modify: `package.json`（`engines.node`、`scripts.test`、`devDependencies.@types/node`）
- Create: `.nvmrc`

- [ ] **Step 1:** `engines.node` を `">=24"`、`scripts.test` を `"node --test tests/*.test.ts"` にし、`.nvmrc` に `24` を書く。
- [ ] **Step 2:** `npm install -D @types/node@^24`。
- [ ] **Step 3:** `npm test` → 137 pass、`npx tsc --noEmit` → エラーなし。
- [ ] **Step 4:** Commit `chore: require Node.js 24`。

### Task 2: HTTP共通処理

**Files:**
- Create: `lib/http.ts`、`tests/http.test.ts`
- Modify: `app/api/ai/route.ts`、`app/api/article/route.ts`、`app/api/library/route.ts`、`lib/ai.ts`（`readResponse` を置き換え）、`lib/article-content.ts`（`readHTML` を置き換え）

**Interfaces:**
- Produces:
  - `isSameOrigin(request: Request): boolean` — Originが無いか同一、かつ `sec-fetch-site` が `cross-site` でない。
  - `class BodyTooLargeError extends Error`
  - `readLimitedBytes(body: ReadableStream<Uint8Array> | null, contentLength: string | null, maxBytes: number): Promise<Uint8Array>` — 上限超過で `BodyTooLargeError`（ストリームをcancel）。
  - `readLimitedText(...)`（同引数、UTF-8 fatalで復号）
  - `NO_STORE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }`

- [ ] **Step 1: 失敗するテストを書く**（`tests/http.test.ts`）
  - `isSameOrigin`：Originなし→true、同一→true、別Origin→false、`sec-fetch-site: cross-site`→false。
  - `readLimitedBytes`：上限ちょうど→成功、上限＋1（content-lengthあり／なしの両方）→ `BodyTooLargeError`、body null→空配列。
  - `readLimitedText`：不正UTF-8 → reject。
- [ ] **Step 2:** `npm test` で新テストが失敗することを確認。
- [ ] **Step 3:** `lib/http.ts` を実装し、3ルート・`lib/ai.ts`・`lib/article-content.ts` の重複処理を置き換える。エラーメッセージとステータスは各ルートの現行のまま。
- [ ] **Step 4:** `npm test`・`npx tsc --noEmit` が通る。
- [ ] **Step 5:** Commit `refactor: share same-origin and bounded body helpers`。

### Task 3: 認証の作り替えとSitesの入口・開発プラグインの削除

**Files:**
- Create: `lib/auth/context.ts`、`lib/auth/dev.ts`、`worker/handler.ts`、`tests/auth.test.ts`
- Rename: `worker/cloudflare.ts` → `worker/index.ts`（旧 `worker/index.ts` は削除）
- Modify: `lib/cloudflare-access.ts`、`tests/cloudflare-access.test.ts`、`app/api/{ai,article,library,feeds}/route.ts`、`lib/client-library.ts:152,199`、`scripts/cloudflare-config.mjs`（`main` を `./worker/index.ts`）、`scripts/cloudflare.mjs`（`runtimeConfig` の `main`）、`tests/cloudflare-config.test.ts`、`vite.config.ts`、`scripts/vite/cloudflare-config.ts`、`package.json`（scripts）
- Delete: `app/chatgpt-auth.ts`、`scripts/vite/sites-vite-plugin.ts`、`scripts/vite/sites-vite-plugin.LICENSE`、`scripts/vite/connector-preview-plugin.mjs`、`scripts/connector-preview/`、`lib/connectors.ts`、`lib/connector-context.ts`、`lib/connector-contract.mts`、`lib/connector-errors.mts`、`lib/connector-preview.d.ts`、`.openai/`

**Interfaces:**
- Produces:
  - `type AuthUser = { id: string; email: string; displayName: string }`（`lib/auth/context.ts`）
  - `runWithUser<T>(user: AuthUser, run: () => T): T`、`getCurrentUser(): AuthUser | null`
  - `authenticateAccessRequest(request: Request, env: AccessEnvironment, options?): Promise<AuthUser>`（戻り値を `Request` から `AuthUser` に変更。`id` は `cloudflare-access:${sub}`、`displayName` は `name` が空でなければ `name`、なければ email）
  - `authenticateDevRequest(request: Request): AuthUser`（`lib/auth/dev.ts`）：URLのhostnameが `127.0.0.1`／`localhost`／`[::1]` なら `{ id: 'dev:local', email: 'dev@localhost', displayName: '開発ユーザー' }`、それ以外は `AccessAuthError(403)`。
  - `createWorkerFetch(deps: { handler: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>; authenticate: (req: Request, env: Env) => Promise<AuthUser> | AuthUser }): (req, env, ctx) => Promise<Response>`（`worker/handler.ts`）：認証失敗時は現 `worker/cloudflare.ts` と同じ文言・ヘッダーの403／503。成功時は `runWithUser(user, () => deps.handler(request, env, ctx))`。リクエストは改変せずに渡す。
  - `worker/index.ts`：`createWorkerFetch({ handler: vinextHandler.fetch, authenticate: import.meta.env.DEV ? authenticateDevRequest : authenticateAccessRequest })`。

- [ ] **Step 1: 失敗するテストを書く**
  - `tests/auth.test.ts`：
    - `getCurrentUser()` は `runWithUser` の外で `null`、中で渡した値。並行する2つの `runWithUser` が互いの値を見ない。
    - `createWorkerFetch`：authenticateが投げたら403で、handlerを呼ばない。`oai-authenticated-user-id: attacker` を付けてもhandler内の `getCurrentUser().id` は認証結果の値。
    - `authenticateDevRequest`：`http://127.0.0.1:5173/` → dev利用者、`https://folio.example/` → 403。
  - `tests/cloudflare-access.test.ts`：ヘッダー置換を確かめていたテストを、戻り値の `AuthUser` を確かめる形に書き換える（`id === 'cloudflare-access:user-123'`、`displayName === '山田 太郎'`、名前なし→email）。拒否系のテストはそのまま。
  - `tests/cloudflare-config.test.ts`：`worker.main === './worker/index.ts'`。
- [ ] **Step 2:** 失敗を確認。
- [ ] **Step 3:** 上記Interfacesを実装する。
  - ルートはすべて `getCurrentUser()` を使う。`/api/feeds` にも `isSameOrigin` とログイン確認を追加する（未ログイン401「RSSの取得にはログインが必要です。」）。
  - 同期の401文言を「ログインしてください。」にする。
  - `vite.config.ts` は現 `scripts/vite/cloudflare-config.ts` の `selfHostedCloudflareConfig(command)` を返すだけにする。serve時の `sites({mockAuth:true})` は外す（dev認証はWorker側で行う）。
  - `package.json`：`dev`／`build` を `FOLIO_DEPLOY_TARGET` なしでCloudflare構成にする。`start` は `.folio/deploy/wrangler.json` を使う。`scripts/cloudflare.mjs` の `build`／`dev` から `FOLIO_DEPLOY_TARGET` を外す。
- [ ] **Step 4:** `npm test`・`npx tsc --noEmit` が通る。`npm run dev` を起動し、`http://127.0.0.1:5173/` で `/api/library` が200（dev利用者）になることを確認して停止。
- [ ] **Step 5:** `npm run cloudflare:build` 後、`grep -r "dev@localhost" dist/` が0件であること（dev認証が本番ビルドから除かれている）。
- [ ] **Step 6:** Commit `feat: neutral request-scoped auth; drop ChatGPT header contract`。

### Task 4: Sites・未使用資産の削除

**Files:**
- Delete: `examples/`、`db/index.ts`、`scripts/install-ci.mjs`、`scripts/install-ci.sh`、`scripts/npm-install.mjs`、`scripts/pnpm-install.mjs`、`scripts/install-pnpm.sh`、`scripts/build-verified.sh`、`scripts/sites-env.sh`、`scripts/execution-profile.mjs`、`components/ui/`、`hooks/use-mobile.ts`、`components.json`、`lib/utils.ts`、`vendor/`（いずれも削除直前に `grep -rn` で参照0件を確認）
- Rename: `scripts/sites-env.mjs` → `scripts/tool-env.mjs`（参照箇所：`package.json` の `start`、README、docs）
- Modify: `scripts/tool-environment.mjs`（既定の置き場所を `.folio/tools` に）、`scripts/run-framework.mjs`（managed-linux分岐を削除）、`package.json`（`install:ci` 削除・未使用依存の削除）、`eslint.config.mjs`（`components/ui` 用ルールと `.sites-runtime` を削除）、`tsconfig.json`（exclude の `examples`・`.sites-runtime`・`outputs`・`work` を整理）、`.gitignore`（`/.sites-runtime/`・`/.agents/`・`/.codex/` を削除）

- [ ] **Step 1:** 依存ごとに `grep -rln "from ['\"]<pkg>" app components hooks lib worker db scripts tests` が0件であることを確かめ、0件のものだけ `npm uninstall` する（候補：`@base-ui/react @hookform/resolvers @shadcn/react cmdk date-fns embla-carousel-react input-otp next-themes radix-ui react-day-picker react-hook-form react-resizable-panels recharts sonner vaul class-variance-authority clsx tailwind-merge tw-animate-css json-rpc-2.0 raw-body`）。
- [ ] **Step 2:** ファイルを削除・リネームし、参照を直す。
- [ ] **Step 3:** `npm test`、`npx tsc --noEmit`、`npm run lint`（エラーは既存の `app/page.tsx` 3件のみ）、`npm run cloudflare:dry-run` が通る。
- [ ] **Step 4:** Commit `chore: remove Sites scaffolding and unused UI kit`。

### Task 5: AI共通部の分離とOpenAI提供元

**Files:**
- Create: `lib/ai/types.ts`、`lib/ai/schema.ts`、`lib/ai/provider-error.ts`、`lib/ai/providers/openai.ts`、`tests/ai-openai.test.ts`
- Modify: `lib/ai.ts`、`lib/intelligence-types.ts`、`tests/ai.test.ts`

**Interfaces:**
- Produces（`lib/ai/types.ts`）：
  - `type ProviderId = 'openai' | 'anthropic' | 'openrouter' | 'workers-ai'`
  - `type Effort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`
  - `PROVIDERS: Record<ProviderId, { label: string; defaultModel: string; efforts: readonly Effort[]; defaultEffort: Effort }>`。efforts は spec 4.4.1 の表（workers-ai は `['auto']`、defaultEffort `'auto'`、他は `'medium'`）。
  - `MODEL_ID_PATTERN = /^[A-Za-z0-9@/._:-]{1,200}$/`
  - `effortBudget(effort: Effort): { timeoutMs: number; maxOutputTokens: number }`（Global Constraintsの値）
  - `type StructuredRequest = { model: string; effort: Effort; instructions: string; input: string; schemaName: string; schema: Schema; maxOutputTokens: number; signal: AbortSignal }`
  - `type StructuredResult = { kind: 'ok'; json: unknown } | { kind: 'refused' } | { kind: 'incomplete' }`
  - `interface AIProvider { id: ProviderId; generate(request: StructuredRequest): Promise<StructuredResult> }`
- Produces（`lib/ai/schema.ts`）：`type Schema`、`resultSchema(action)`、`conforms(value, schema)`（`lib/ai.ts` から移動）。
- Produces（`lib/ai/provider-error.ts`）：`providerFailure(kind: 'invalid_model'|'input_too_long'|'unsupported_effort'|'rate_limited'|'provider_error', provider: ProviderId, model: string): AIError`（Global Constraintsの文言。`rate_limited` は現行の429文言、`provider_error` は現行の502文言）。
- Produces（`lib/ai.ts`）：`runAI(request: AIRequest, runtime: { provider: AIProvider; model: string; effort: Effort; now?: () => Date }): Promise<AIResult>`。指示文の組み立て、`effortBudget` によるタイムアウト（AbortController）、`refused`→422、`incomplete`→502 `incomplete_output`、`ok`→`JSON.parse` 済みの値に `validateResult`。`DEFAULT_AI_MODEL` は削除。
- Produces（`lib/ai/providers/openai.ts`）：`createOpenAIProvider(options: { apiKey: string; fetcher?: typeof fetch }): AIProvider`。
- Modifies（`lib/intelligence-types.ts`）：`AIRequest` に `provider?: ProviderId; model?: string; effort?: Effort` を追加。

- [ ] **Step 1: 失敗するテストを書く**
  - `tests/ai.test.ts`：`runAI(...,{apiKey,fetcher})` 呼び出しを、テスト内のフェイク `AIProvider`（`generate` が固定の `StructuredResult` を返す）に置き換える。検証系テスト（引用・analyze・digest・compare・preferences）の期待値は変えない。追加：`refused`→422、`incomplete`→502 で上記文言、`generate` がsignalのabortで投げたら504。
  - `tests/ai-openai.test.ts`（現 `tests/ai.test.ts` の輸送系テストを移す）：
    - URL `https://api.openai.com/v1/responses`、`redirect:'manual'`、`store:false`、`text.format.strict:true`、`model` はrequestの値。
    - effort `medium`→`reasoning:{effort:'medium'}`、`auto`→`reasoning` キーなし、`max_output_tokens` が `maxOutputTokens`。
    - 400 `{error:{code:'context_length_exceeded'}}`→`input_too_long`、400で `error.param` が `reasoning.effort`→`unsupported_effort`、404 または `error.code==='model_not_found'`→`invalid_model`、429→`rate_limited`、3xx→`provider_error`（fetchは1回）。
    - エラー本文 `{"error":{"message":"sk-secret"}}` のとき、投げた `AIError.message` に `sk-secret` を含まない。
    - `status:'incomplete'`→`{kind:'incomplete'}`、`refusal` 部品→`{kind:'refused'}`、2MiB超→ `provider_error` 系の `AIError`。
- [ ] **Step 2:** 失敗を確認。
- [ ] **Step 3:** 実装する。エラー本文は `readLimitedText(..., 64*1024)` で読み、分類にだけ使う。
- [ ] **Step 4:** `npm test`・`npx tsc --noEmit` が通る（`app/api/ai/route.ts` はこの時点では `createOpenAIProvider({apiKey: env.OPENAI_API_KEY})` と `PROVIDERS.openai.defaultModel`・`'medium'` で動くように最小修正）。
- [ ] **Step 5:** Commit `refactor(ai): provider interface and OpenAI provider`。

### Task 6: Claude提供元

**Files:**
- Create: `lib/ai/providers/anthropic.ts`、`tests/ai-anthropic.test.ts`
- Modify: `package.json`（`npm install @anthropic-ai/sdk@^1.6.0`）、`lib/ai/schema.ts`

**Interfaces:**
- Consumes: Task 5 の `AIProvider`／`StructuredRequest`／`providerFailure`。
- Produces:
  - `stripUnsupportedForClaude(schema: Schema): Schema`（`lib/ai/schema.ts`）：再帰的に `minLength`・`maxLength`・`minimum`・`maximum`・`minItems`・`maxItems` を除いた複製を返す。元は変更しない。
  - `createAnthropicProvider(options: { apiKey: string; fetch?: typeof fetch }): AIProvider`：`new Anthropic({ apiKey, fetch, maxRetries: 0 })`、`client.messages.create({ model, max_tokens: maxOutputTokens, system: instructions, messages:[{role:'user', content: input}], output_config: { format: { type:'json_schema', schema: stripUnsupportedForClaude(schema) }, ...(effort!=='auto' ? { effort } : {}) } }, { signal })`。

- [ ] **Step 1: 失敗するテストを書く**（SDKの `fetch` オプションにフェイクを渡し、送信本文を検査する）
  - `stripUnsupportedForClaude`：`resultSchema('digest')` を通すと上記キーが1つも残らず、`additionalProperties:false` と `required` は残る。元のスキーマは不変。
  - 送信：URLが `https://api.anthropic.com/v1/messages`、`x-api-key` ヘッダー、`model`、`max_tokens`、`output_config.format.type==='json_schema'`、effort `medium`→`output_config.effort==='medium'`、`auto`→`effort` なし。
  - 応答：`stop_reason:'end_turn'` と text ブロック→`{kind:'ok', json}`、`refusal`→`refused`、`max_tokens`→`incomplete`。
  - エラー：404 `not_found_error`→`invalid_model`、400で message に `prompt is too long`→`input_too_long`、400で message に `effort`→`unsupported_effort`、429→`rate_limited`、500→`provider_error`。いずれも message に応答本文を含まない。
- [ ] **Step 2:** 失敗を確認。
- [ ] **Step 3:** 実装（SDKの型付き例外 `Anthropic.NotFoundError`／`RateLimitError`／`BadRequestError`／`APIError` で分類）。
- [ ] **Step 4:** テスト・型チェックが通る。
- [ ] **Step 5:** Commit `feat(ai): Claude provider`。

### Task 7: OpenRouter提供元

**Files:**
- Create: `lib/ai/providers/openrouter.ts`、`tests/ai-openrouter.test.ts`

**Interfaces:**
- Produces: `createOpenRouterProvider(options: { apiKey: string; fetcher?: typeof fetch }): AIProvider`。`POST https://openrouter.ai/api/v1/chat/completions`、`redirect:'manual'`、本文 `{ model, max_tokens, messages:[{role:'system',content:instructions},{role:'user',content:input}], response_format:{ type:'json_schema', json_schema:{ name: schemaName, strict:true, schema } }, provider:{ require_parameters:true }, ...(effort!=='auto' ? { reasoning:{ effort } } : {}) }`。

- [ ] **Step 0:** OpenRouterの公式資料で `reasoning.effort` の受け付ける値と、既定モデル `openai/gpt-6-luna` のslugを確認する。spec 4.4.1／4.2と違えば `PROVIDERS.openrouter` を直し、計画とspecの差分をコミットメッセージに書く。
- [ ] **Step 1: 失敗するテストを書く**
  - 送信本文の各項目（上記）と `Authorization: Bearer`。
  - 応答：`choices[0].message.content` のJSON文字列→`ok`、`finish_reason:'length'`→`incomplete`、`message.refusal` が文字列→`refused`。
  - エラー：400で message に `context length`→`input_too_long`、400／404で message に `model`（例 `not a valid model ID`）→`invalid_model`、400で message に `reasoning`→`unsupported_effort`、429→`rate_limited`、3xx→`provider_error`。応答本文を message に含めない。
- [ ] **Step 2〜4:** 失敗確認→実装（2MiB上限読み取り）→テスト・型チェック通過。
- [ ] **Step 5:** Commit `feat(ai): OpenRouter provider`。

### Task 8: Workers AI提供元とバインディング

**Files:**
- Create: `lib/ai/providers/workers-ai.ts`、`tests/ai-workers.test.ts`
- Modify: `scripts/cloudflare-config.mjs`（`workerConfiguration` に `ai:{binding:'AI'}`）、`scripts/vite/cloudflare-config.ts`（serve時は `ai` を外す）、`cloudflare-env.d.ts`、`tests/cloudflare-config.test.ts`

**Interfaces:**
- Produces: `createWorkersAIProvider(options: { ai: { run(model: string, input: unknown, options?: unknown): Promise<unknown> } }): AIProvider`。`ai.run(model, { messages:[system,user], response_format:{ type:'json_schema', json_schema: schema }, max_tokens: maxOutputTokens })`。effort は送らない。
- Modifies: `Cloudflare.Env` に `AI?: Ai`、`ANTHROPIC_API_KEY?: string`、`OPENROUTER_API_KEY?: string` を追加し、`OPENAI_MODEL` を削除。

- [ ] **Step 1: 失敗するテストを書く**
  - `response` がオブジェクト→そのまま `ok`。JSON文字列→parseして `ok`。```` ```json\n{...}\n``` ```` で囲まれた文字列→囲みを外して `ok`。parseできない文字列→`ok` にせず `invalid_output`（502）の `AIError`。
  - `run` が `JSON Mode couldn't be met` を含むErrorで失敗→`invalid_output`。その他のErrorで `model` を含む→`invalid_model`、それ以外→`provider_error`。Errorのmessageを利用者向けに含めない。
  - 送信内容に `reasoning`／`effort` キーが無い。
  - `tests/cloudflare-config.test.ts`：`workerConfiguration(config).ai` が `{binding:'AI'}`。
- [ ] **Step 2〜4:** 失敗確認→実装→テスト・型チェック通過。`npm run dev` がCloudflareへのログインなしで起動することを確認。
- [ ] **Step 5:** Commit `feat(ai): Workers AI provider and binding`。

### Task 9: 提供元の選択とAPI

**Files:**
- Create: `lib/ai/registry.ts`、`tests/ai-registry.test.ts`
- Modify: `app/api/ai/route.ts`、`lib/ai.ts`（`validateRequest` に `provider`／`model`／`effort`）、`scripts/cloudflare.mjs`、`tests/cloudflare-cli.test.ts`

**Interfaces:**
- Consumes: Task 5〜8 の各 `create*Provider`、`PROVIDERS`、`MODEL_ID_PATTERN`。
- Produces（`lib/ai/registry.ts`）：
  - `type AIEnv = { OPENAI_API_KEY?: string; ANTHROPIC_API_KEY?: string; OPENROUTER_API_KEY?: string; AI?: { run: ... } }`
  - `type ProviderStatus = { id: ProviderId; label: string; available: boolean; defaultModel: string; efforts: Effort[]; defaultEffort: Effort; reason?: string }`
  - `providerStatuses(env: AIEnv, options: { dev: boolean }): ProviderStatus[]`：キー（trim後）が空なら `available:false, reason:'キー未設定'`。workers-ai は `env.AI` が無いか `dev` なら `reason:'この環境では使えません'`。
  - `resolveSelection(request: Pick<AIRequest,'provider'|'model'|'effort'>, statuses: ProviderStatus[]): { provider: ProviderId; model: string; effort: Effort }`：providerが指定されていればそのまま（未使用可でも切り替えない）。未指定なら `anthropic`→`openai`→`openrouter` のうち最初の `available`。どれも無ければ `AIError(503,'not_configured','AIは未接続です。設定画面で提供元を選び、APIキーを登録してください。')`。model未指定→その `defaultModel`、effort未指定→その `defaultEffort`。
  - `createProvider(id: ProviderId, env: AIEnv): AIProvider`
- Modifies（`validateRequest`）：`provider` は4値のenum、`model` は `MODEL_ID_PATTERN`、`effort` は7値のenum。`provider` と `effort` が両方ある場合、`PROVIDERS[provider].efforts` に含まれなければ400 `invalid_effort`「選んだ提供元では、この推論の深さを指定できません。」。
- Route：`GET` は `{ providers: ProviderStatus[] }`。`POST` は same-origin→ログイン→`validateRequest`→`resolveSelection`→選んだ提供元が `available:false` なら503 `not_configured`「{label}は使えません（{reason}）。設定画面で別の提供元を選んでください。」→`rateLimit`→`runAI`。`dev` は `import.meta.env.DEV`。
- CLI：`cloudflare:secret <KEY>` と `cloudflare:secret-from-env <file> <KEY>`。KEYは `OPENAI_API_KEY`／`ANTHROPIC_API_KEY`／`OPENROUTER_API_KEY` のみ。

- [ ] **Step 1: 失敗するテストを書く**
  - `providerStatuses`：キーなし／空白のみ→`キー未設定`、`dev:true` のworkers-ai→`この環境では使えません`。
  - `resolveSelection`：未指定でanthropic・openai両方あり→anthropic。workers-aiしか無い→503。`provider:'anthropic'` 指定でキーなし→`anthropic` を返す（切り替えない）。effort未指定→openaiは `medium`、workers-aiは `auto`。
  - `validateRequest`：`model:'a b'`・201文字→400、`provider:'workers-ai', effort:'medium'`→400 `invalid_effort`、`provider:'anthropic', effort:'none'`→400。
  - CLI：`secret` に許可外のキー名→終了コード1。
- [ ] **Step 2〜4:** 失敗確認→実装→テスト・型チェック通過。
- [ ] **Step 5:** Commit `feat(ai): provider selection API`。

### Task 10: AI設定の同期

**Files:**
- Modify: `lib/intelligence-types.ts`、`lib/cloud-library.ts`、`tests/cloud-library.test.ts`、`tests/library-backup.test.ts`、`tests/client-library.test.ts`

**Interfaces:**
- Produces：`type AISettings = { provider: ProviderId; models: Partial<Record<ProviderId, string>>; efforts: Partial<Record<ProviderId, Effort>> }`、`IntelligenceState.ai?: AISettings`（`DEFAULT_INTELLIGENCE` には含めない）。zod：`ai` は `.strict()` のoptional、`models` の値は `MODEL_ID_PATTERN`、`efforts` の値は `Effort` enum、キーは `ProviderId` のみ。

- [ ] **Step 1: 失敗するテストを書く**
  - `ai` なしの既存文書が `validateSyncDocument` を通る（既存テストで担保されていることを確認）。
  - `ai:{provider:'anthropic',models:{anthropic:'claude-haiku-5-5'},efforts:{anthropic:'high'}}` が通る。
  - `provider:'gemini'`、`models:{openai:'bad id'}`、`efforts:{openai:'extreme'}`、`models:{unknown:'x'}`、`ai` に未知キー → それぞれ不合格。
  - `parseLibraryBackup` が `ai` 付きの文書を復元できる。
- [ ] **Step 2〜4:** 失敗確認→実装→テスト・型チェック通過。
- [ ] **Step 5:** Commit `feat: sync AI settings with library`。

### Task 11: 画面（AI設定欄・状態表示・送信）とlintエラー

**Files:**
- Create: `lib/ai-settings.ts`、`components/folio/ai-settings.tsx`、`tests/ai-settings.test.ts`
- Modify: `app/page.tsx`、`components/folio/intelligence-panels.tsx`（`AIStatus`）、`components/folio/library-dialogs.tsx`（`NaturalPreferenceEditor` に設定欄を差し込む）、`app/intelligence.css` か `components/folio/intelligence-panels.css`

**Interfaces:**
- Consumes：`ProviderStatus`（Task 9）、`AISettings`（Task 10）、`PROVIDERS`／`effortBudget`（Task 5）。
- Produces（`lib/ai-settings.ts`、Reactに依存しない純粋関数）：
  - `effectiveSelection(settings: AISettings | undefined, statuses: ProviderStatus[]): { provider: ProviderId; model: string; effort: Effort; available: boolean; label: string } | null` — サーバーの `resolveSelection` と同じ規則（未指定時の順序・既定値）。
  - `clientTimeoutMs(effort: Effort): number` — `effortBudget(effort).timeoutMs + 10_000`。
  - `updateProvider(settings, provider)`／`updateModel(settings, provider, model)`／`updateEffort(settings, provider, effort)`：`AISettings` を返す。`updateModel` は `MODEL_ID_PATTERN` に合わない値を受け付けない（元の値を返す）。
- `components/folio/ai-settings.tsx`：`AISettingsEditor({ statuses, settings, onChange })`。提供元4つ（使えないものに「キー未設定」または「この環境では使えません」）、モデル（`<input list>` と `<datalist>`、候補は `defaultModel`）、推論の深さ（`PROVIDERS[id].efforts`、`auto` は「モデルに任せる」、Workers AIでは非表示、横に「深いほど時間と費用がかかります」）。
- `app/page.tsx`：`GET /api/ai` の結果を `ProviderStatus[]` で保持し、`aiAvailable` を `effectiveSelection(...)?.available` から求める。`requestAI` は `provider`／`model`／`effort` を付けて送り、`AbortSignal.timeout(clientTimeoutMs(effort))` を使う。`AIStatus` に `{label}・{model}` を渡す。
- lint：`app/page.tsx:95`（renderでのref代入→`useEffect` で同期）、`:103`（effect内で `fetch().then()` の中だけでsetState）、`:159`（`next/link` の `Link`）。

- [ ] **Step 1: 失敗するテストを書く**（`tests/ai-settings.test.ts`）
  - `effectiveSelection(undefined, statuses)` がサーバーの `resolveSelection` と同じ結果（anthropic優先、既定モデル、`medium`）。
  - 保存済みproviderが使えない→ `available:false` でそのproviderを返す。
  - `clientTimeoutMs('medium') === 100_000`、`clientTimeoutMs('high') === 130_000`、`clientTimeoutMs('auto') === 55_000`。
  - `updateModel` に `'bad id'`→設定不変。`updateEffort(settings,'anthropic','none')`→不変（Claudeは `none` 不可）。
- [ ] **Step 2〜3:** 失敗確認→実装。
- [ ] **Step 4:** `npm test`、`npx tsc --noEmit`、`npm run lint`（エラー0）。
- [ ] **Step 5:** `npm run dev` で、好み設定モーダルからClaude→OpenAIに切り替え、モデル入力と推論の深さの選択肢が提供元に合わせて変わること、再読み込み後も設定が残ることを確認（キー未設定なら「キー未設定」表示とAIボタン無効を確認）。
- [ ] **Step 6:** Commit `feat(ui): choose AI provider, model and effort`。

### Task 12: ドキュメントと最終確認

**Files:**
- Modify: `README.md`、`docs/self-host-cloudflare.md`

- [ ] **Step 1:** README：
  - 「ChatGPTのユーザーごとに」→「ログイン中の利用者ごとに」。
  - Node.js 24以上。
  - 起動・ローカルDBの手順をCloudflare版に統一（`/signin-with-chatgpt` の記述削除。ローカルはloopbackで自動ログイン）。
  - 「生成AI」節を4提供元・画面での切り替え・既定モデル・推論の深さ・Secret名・`OPENAI_MODEL` 廃止・各提供元の管理画面で利用額上限を設定すること、に書き換え。
  - 更新時、旧版の画面を開いたままの端末は再読み込みが必要、の一文。
- [ ] **Step 2:** `docs/self-host-cloudflare.md`：Sitesの記述とSites版との並存の記述を削除、`cloudflare:secret <KEY>` の使い方、Workers AIのバインディング（自動で入ること、課金はCloudflare側）を追記。
- [ ] **Step 3:** `grep -rni "chatgpt\|signin-with\|oai-authenticated\|\.openai/\|sites" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs/superpowers .` の結果が、意図したもの（`lib/feeds.ts` のタグ判定の正規表現など）だけであること。
- [ ] **Step 4:** `npm test`、`npx tsc --noEmit`、`npm run lint`、`npm run cloudflare:dry-run` がすべて成功。
- [ ] **Step 5:** Commit `docs: Cloudflare-only setup and multi-provider AI`。

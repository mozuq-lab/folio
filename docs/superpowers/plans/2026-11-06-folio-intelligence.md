# Folio 全追加機能 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** 提案した全8機能を実装して、同じ本人限定Siteに反映する。
**Architecture:** 既存Vinext、pure TypeScriptの集約/ランキング、serverのD1同期とOpenAI Responses API。
**Tech Stack:** React / TypeScript / Cloudflare D1 / fast-xml-parser / OpenAI REST。
**Spec:** docs/superpowers/specs/2026-11-06-folio-intelligence-design.md

## Global Constraints
- 日本語。全既存機能を維持し、秘密値をclientへ渡さない。
- 共通interfaceはlib/types.tsとlib/intelligence-types.ts。
- AI未接続と実出力、抽出と生成を明確に区別。引用は入力記事で検証。
- user単位の認可、schema migrationsのみでDB構築、revisionによるconflict検知。
- API依存のない独立ファイルは並行実装。UIと共通型は親だけが編集。

## Review Focus
- 複数端末の同時編集を黙って上書きしない。
- OPMLの外部entityや危険URLと入れ子folderを検証。
- ニュース集約で同じトピックというだけの記事をまとめない。
- AIの未接続/エラー/不正な引用でも既存機能を壊さない。
- 旧localStorageからの移行と記事保存/ノート/既読の保持。

### Task 1: D1同期・OPML
- [x] db/schema.ts、lib/cloud-library.ts、app/api/library/route.tsにuser単位のGET/PUT、revision409、サイズ/型検証。
- [x] lib/opml.tsにparseOpml(xml)、exportOpml(feeds)、重複/危険URL/階層対応。
- [x] tests/cloud-library.test.ts、tests/opml.test.tsを先に失敗確認して実装。
- [x] npm run db:generateでmigrationを生成し確認。

### Task 2: 集約・重要度・探索・読書プラン
- [x] lib/discovery.tsにclusterStories、scoreImportance、selectExploration、buildReadingPlan、searchLibraryを実装。
- [x] tests/discovery.test.tsでrelated/unrelated、続報、重要度の独立性、時間予算、探索除外、出典検索を検証。

### Task 3: 生成AI・公開記事本文
- [x] lib/ai.ts、app/api/ai/route.tsにAI statusとanalyze/preferences/digest/compare/ask。
- [x] lib/article-content.ts、app/api/article/route.tsに安全な公開記事本文抽出。
- [x] tests/ai.test.ts、tests/article-content.test.tsで未設定/validation/引用/timeout/HTML抽出を検証。
- [x] 明示承認後に1日有効のキーを作成し、確認済みの無視対象 `.dev.vars` に保存。ローカルの実APIで5種類の処理を確認。
- [ ] Sites runtime secretへの安全な登録経路を確保し、本番AIを接続して確認。

### Task 4: UI・offline cache・sync
- [x] hooks/use-library.tsで旧データ移行、cloud hydrate、自動同期、競合の解決。
- [x] components/folio/にDigest/Stories/Notebook/Explore/AI設定・OPML dialog。
- [x] app/page.tsxへnav、機能、notes/highlight、関心/重要度、本文取得を接続。
- [x] app/globals.cssで既存の白/緑トーンを保つレスポンシブ表示。

### Task 5: 統合・公開
- [x] 全test、tsc、build、local migration、browser操作検証。
- [x] 独立review、重大欠陥修正、README更新。
- [x] 同じSiteへsource pushと本人限定deploy、成功確認。

## 2026-11-06 検証記録

初回100テスト・tsc・build成功。実RSSで2媒体の同ニュース集約、メモ検索、OPML重複除外付き取り込み、スマートフォン表示、ローカルD1同期とrevision競合409/明示的解決を確認。reviewのDTO境界/Notebook非表示/owner分離/oversize cache/D1 row limit/ランキング性能/根拠のない回答を回帰テスト付きで修正。全追加機能のソースを同じ本人限定Siteへ公開した。

キー作成の追加承認後、ローカルのFolioから `gpt-5-mini` でanalyze/preferences/digest/compare/askの5種類すべてがHTTP 200で成功。明示した架空のサンプル2記事で関心/重要度、自然文の好み、5分以内のダイジェスト（4分）、既読からの差分・媒体比較、実在する引用付き回答（4引用）を確認。検証用の記事や結果を利用者のクラウドライブラリには保存していない。

実接続でCloudflare Workersが `redirect:'error'` をサポートしない問題を検出。`manual` に変更し、3xxで別URLへ認証情報を転送しない回帰テストを追加した。修正後101テストとtscが成功。

本番キー登録は未完了。native Sitesの環境変数ツールは `value:string` のみを受け取り、確認済みローカル秘密ファイルを直接受け取る機能がない。秘密を標準出力やモデルへ露出せずに渡せる経路を確認できていない。公開版は引き続きAI未接続表示。ローカルキーの有効期間は作成から24時間。

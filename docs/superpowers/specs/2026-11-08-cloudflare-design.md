# ご自身のCloudflareへの移行

ユーザー指定の移行先は、ご自身のCloudflareアカウント。既存のWorkers/Vinext/D1構成を利用し、本人限定の認証にCloudflare Accessを提案している。ログイン方式については回答待ちのため、この方式は実装側の仮定であり、ユーザーが選択済みとは扱わない。

- 別のWorker entryとビルド設定を追加し、Sitesの信頼ヘッダーに依存しないJWT署名検証を行う。
- 認証の設定不足やJWTの不正は必ず拒否する。認証設定前のbootstrapデプロイでも記事・API・静的ファイルを公開しない。
- D1 bindingは既存のDB、既存migrationをそのまま使用。メールアドレス許可リストと署名済みsubjectで利用者を識別する。
- 設定ファイルには非秘密のCloudflare情報だけを保存し、OpenAIキーはCloudflare Secretへ登録する。作成済みの期限切れキーは再利用しない。
- 既存のJSONバックアップをプレビュー付きで取り込めるようにし、別ドメインへのデータ移行を可能にする。
- 専用CLIで初期設定、ログイン、D1作成/migration、ビルド、dry-run、bootstrap、デプロイ、Secret設定を用意する。
- Cloudflareへのログインが未設定のため、外部リソースの作成・本番反映はログイン後。現在のSites版の公開先・利用者設定を変更しない。

署名検証はCloudflare公式例のjoseを使用する。ctx.accessはStatic Assetsの内部routerから伝搬しない制限があるため、JWTを検証する。

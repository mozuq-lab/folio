# Folio の全追加機能

ユーザーは直前に提示した全機能の実装を依頼した。対象は5分ダイジェスト、同一ニュースの集約と既読後の差分、自然文の好み、関心度/重要度の分離、保存記事への出典付き質問とノート/ハイライト、探索枠、端末間同期、OPML取り込み。既存RSS機能と日本語UIを保持する。

方式: 現在のVinext/Reactを維持しD1へChatGPT user IDでライブラリを保存。ブラウザーcacheはoffline用に保持、revisionによる楽観的排他で別端末の変更を黙って消さない。生成AIはOpenAI Responses APIをserverから利用し、秘密値はSites runtime secrets。キー有効化はOpenAI Developers skillが要求するapprovalを尊重。未接続時にAI実行済みと表示しない。

代替: ブラウザー内巨大モデルは初回downloadと端末制約、全処理LLMは遅延/コストが大きい。そこでローカル集約/ランキングと、明示操作による生成AIを組み合わせる。

記事の本文は取得できる公開HTTPSページだけを安全に抽出し、取得できなければRSS概要を用いる。paywallを回避しない。AI出力は入力記事のIDと引用で検証し、根拠のない回答は不足を伝える。外部生成AIには操作に必要な記事・好み・質問だけを渡し、キーや他userのデータを渡さない。

画面: サイドバーにダイジェスト/ニュース集約/ノート/探索。For Youに関心/重要度切替とAI再評価。興味設定に自然文指示と探索割合。drawerに本文取得、note/highlight。Cloud接続/同期状態、競合時の明示的選択。フィードdialogにOPML preview/import/export。

品質: 旧保存データ互換、更新/削除後の保存記事保持、user単位権限、同期conflict、危険RSS/OPML/XML、AI未接続/timeout/schema不整合、予算超過、引用ID/引用文不正、同名だが別ニュースの誤結合をtestする。

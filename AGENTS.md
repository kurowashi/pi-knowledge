# AGENTS.md — pi-knowledge

読者: pi-knowledge を変更するエージェントと開発者。利用者向けの仕様は README、設計判断は DESIGN.md。
共通の検証と規則はルートの `AGENTS.md` にある。

## 壊してはいけない制約

- 表面（ツール・コマンド・hook）は固定。モデル向けのツールは `kb_search` だけ、コマンドは `/knowledge` だけ。専用の write 系ツールを登録しない。Pi のイベントは5種、opencode の hook は5種で、それぞれ各1ハンドラ（`test/contract/surface.test.ts`）。
- 依存関係: `src/core/` は host パッケージを import しない。`src` の import は node builtin・相対 `.ts`・host パッケージだけ。`@opencode/plugin` は型のみ。実行時依存を持たない（`test/contract/dependencies.test.ts`）。
- プラグインはファイルのパスを書き換えず、ID を生成しない。ID はモデルが命名し、`^[a-z0-9]+(_[a-z0-9]+)*$`・40文字以内。`[0-9a-f]{8}` は受理する（`test/unit/lint.test.ts`、`test/unit/write_path.test.ts`）。
- 既存エントリのパスへの `write` は拒否する。更新は `edit` だけ。readonly root への `write` / `edit` は `write.enforce: "warn"` でも拒否する。root 外と `.md` 以外には干渉しない（`test/unit/write_path.test.ts`）。
- 書き込み前の内容検証はしない。`edit` と `patch` には介入しない。`write` / `edit` の後に lint の結果を添える。shell は再走査のみ（`test/integration/extension.test.ts`）。
- 注入はセッション開始と compaction 後だけ再生成する。それ以外のセッション中は更新しない（`test/integration/extension.test.ts`）。
- 注入するのは索引だけで、本文は注入しない。注入は実効予算内に縮退する。固定費が上回るときはヘッダだけを注入し `overBudget` を表示する（`test/unit/render.test.ts`）。
- 固定文・ツール宣言・スキルはトークン予算内（`test/contract/budget.test.ts`）。
- 検索は backend が使えないとき、結果を空にせず lexical で答え、fallback と理由を必ず示す。キャッシュ無効でも動く（`test/unit/search_service.test.ts`）。
- FTS5 と埋め込みキャッシュは指紋一致時だけ再利用する。壊れていても再構築できる（`test/unit/index_cache.test.ts`）。
- catalog が変わったら検索サービスを必ず作り直す（`test/integration/opencode.test.ts`）。
- 設定はグローバル → プロジェクトの順にマージし、project が優先する。未信頼プロジェクトの設定は無視する。壊れた設定と範囲外の値は警告して既定値へ戻す（`test/unit/config.test.ts`）。
- `enabled: false` は全機能を無効化し、`/knowledge status` だけ残す（`test/integration/extension.test.ts`）。
- 同一 scope の root は優先度の高い1つだけ有効。有効 root は最大3（`test/unit/roots.test.ts`）。
- `/knowledge review` は候補をモデルへ渡す。プラグイン自身は書き込まない（`test/integration/extension.test.ts`）。
- 配布物は `files` の whitelist 内だけ。Pi は `pi.extensions`、opencode は `exports` の `./server` で同じパッケージを読む（`test/ci/package-contents.test.ts`）。

## 変更時の手順

- 表面（ツール・コマンド・hook）を増減するときは、`test/contract/surface.test.ts` を先に更新する。
- host 依存を `src/core` に持ち込まない。両 host で揃えたい挙動は `src/core` に置き、アダプタは呼び出しだけを書く。
- 不変条件を変えるときは、DESIGN.md を先に更新し、対応するテストを同じ変更で更新する。
- 用語・設定キーを追加するときは、DESIGN.md の用語表か設定スキーマに定義を足す。
- 知識（エントリ）を追加・更新するときの判断は DESIGN.md §11.5 の採用規則に従う。規則をここに写さない。

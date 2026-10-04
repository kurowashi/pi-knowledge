# AGENTS.md — pi-knowledge で作業するエージェント向けの指示

読者は pi-knowledge を変更する AI エージェントと開発者です。利用者向けの仕様は README に、設計判断は DESIGN.md と PHILOSOPHY.md に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、下の表はその索引です。実装と表が食い違った場合はテストが正です。

## 完了条件

`npm run verify`(= `npm run check` + `npm run knip` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。CI は同じ `verify` を Node 22.19 / 24 で実行します。
カバレッジは `test/unit` と `test/integration` で計測します。

## 制約

### 表面

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| モデル向けツールは `kb_search` の1つだけ | `test/contract/surface.test.ts` | `src/index.ts` |
| コマンドは `/kb` の1つだけ | `test/contract/surface.test.ts` | `src/index.ts` |
| イベントは `session_start` / `before_agent_start` / `session_compact` / `tool_call` / `tool_result` の5種で各1ハンドラ | `test/contract/surface.test.ts` | `src/index.ts` |
| 専用の write 系ツールを登録しない | `test/contract/surface.test.ts` | `src/index.ts` |

### 不変条件

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| ID はプラグインが付与し、`[0-9a-f]{8}`。モデルは生成しない | `test/unit/hooks.test.ts` | `src/hooks.ts` |
| 既存エントリへの `write` は常にブロック。更新は `edit` のみ | `test/unit/hooks.test.ts` | `src/hooks.ts` |
| readonly・shadow への書き込みは `write.enforce: "warn"` でもブロック | `test/unit/hooks.test.ts` | `src/hooks.ts` |
| ルート外と `.md` 以外には干渉しない | `test/unit/hooks.test.ts` | `src/hooks.ts` |
| 注入は session_start と `session_compact` 後に再生成し、それ以外のセッション中は更新しない | `test/integration/extension.test.ts` | `src/index.ts` |
| 注入は実効予算内に縮退する。固定費が上回る場合はヘッダのみを注入し `overBudget` を表示する | `test/unit/render.test.ts` | `src/render.ts` |
| 固定文・ツール宣言・スキルはトークン予算内 | `test/contract/budget.test.ts` | `src/render.ts` |
| lint サマリは error/warning があるとき、上位8件を session_start ごとに1回モデルへ送る | `test/integration/extension.test.ts` | `src/index.ts` |
| 本文は注入しない | `test/unit/render.test.ts` | `src/render.ts` |
| 文書索引は生成物自身とバイナリを除外し、注入しない | `test/unit/docs.test.ts` | `src/docs.ts` |
| Git 不在・shallow では git 日付をスキップして警告 | `test/unit/stale.test.ts` | `src/stale.ts` |
| refs は `[[id]]` と `supersedes`(`scope:id` を含む)を拾う | `test/unit/refs.test.ts` | `src/refs.ts` |
| 未知フィールドは catalog が無視し lint が警告する | `test/unit/catalog.test.ts` + `test/unit/lint.test.ts` | `src/catalog.ts` |
| 同一エントリの tags は重複除去する | `test/unit/catalog.test.ts` | `src/catalog.ts` |
| supersede で置換された active エントリは lint 警告する | `test/unit/lint.test.ts` | `src/lint.ts` |
| `/kb review` は候補を `sendUserMessage` で渡す(プラグイン自身は書き込まない) | `test/integration/extension.test.ts` + `test/contract/surface.test.ts` | `src/index.ts` |
| `kb dups --max N` は候補ペアが N 超で終了コード1 | `test/unit/cli.test.ts` | `src/cli.ts` |
| 検索結果の content は tags を含む | `test/integration/extension.test.ts` | `src/format.ts` |
| 利用不可の backend は lexical へフォールバックし、理由を必ず表示する | `test/unit/search_service.test.ts` | `src/search_service.ts` |
| embedding 失敗は分類され、検索を止めない | `test/unit/search_service.test.ts` | `src/backend_embedding.ts` |
| FTS5 が無い環境でも lexical で動く | `test/unit/search_service.test.ts` | `src/backend_fts.ts` |

### 設定

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 設定はグローバル→プロジェクトの順にマージし、project が優先 | `test/unit/config.test.ts` | `src/config.ts` |
| 未信頼プロジェクトの設定は無視する | `test/unit/config.test.ts` | `src/config.ts` |
| 壊れた設定は警告して既定値で動き、セッションを止めない | `test/unit/config.test.ts` | `src/config.ts` |
| 同一 scope の root は優先度の高い1つだけ有効。有効 root は最大3 | `test/unit/roots.test.ts` | `src/roots.ts` |
| `floorTokens` > `maxTokens` は `maxTokens` に補正する | `test/unit/config.test.ts` | `src/config.ts` |
| team root は書き込みを常にブロックする | `test/unit/hooks.test.ts` | `src/hooks.ts` |
| FTS5・埋め込みキャッシュは指紋一致時のみ再利用し、壊れていても再構築できる | `test/unit/index_cache.test.ts` + `test/unit/search_service.test.ts` | `src/index_cache.ts` |
| キャッシュ無効でも検索は動作する | `test/unit/search_service.test.ts` | `src/search_service.ts` |

### 依存関係・配布

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 実行時依存を持たない(`dependencies` は空) | `test/contract/dependencies.test.ts` | `package.json` |
| `src` の import は node builtin・相対 `.ts`・Pi 提供パッケージのみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` |
| 循環依存を作らない | `npx biome check .` | `biome.jsonc` の `noImportCycles` |
| 未宣言の依存を import しない(import 元パッケージの `package.json` へ先に宣言する) | `npx biome check .` | `biome.jsonc` の `noUndeclaredDependencies` |
| 未使用の export・依存・ファイルを検出しない | `npm run knip` | `knip.jsonc` |
| 配布物は `files` の whitelist 内のみ | `test/ci/package-contents.test.ts` | `package.json` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/package-contents.test.ts` | `package.json` |

### コード品質

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` |
| `console` を使わない | `npx biome check .` | `biome.jsonc` |
| 認知複雑度は 12 以下 | `npx biome check .` | `biome.jsonc` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` | `tsconfig.json` |

## 変更時の手順

- 表面(ツール・コマンド・イベント)を増減する場合は `test/contract/surface.test.ts` を先に更新する。
- 不変条件を変える場合は DESIGN.md を先に更新し、対応するテストを同じ変更で更新する。
- 用語・設定キーを追加する場合は DESIGN.md の用語表または設定スキーマに定義を追加する。
- 新しいフェーズの機能を追加する場合は DESIGN.md の実装フェーズと README を同じ変更で更新する。

# AGENTS.md — pi-knowledge で作業するエージェント向けの指示

読者は pi-knowledge を変更する AI エージェントと開発者です。利用者向けの仕様は README に、設計判断は DESIGN.md と PHILOSOPHY.md に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、下の表はその索引です。実装と表が食い違った場合はテストが正です。

## 完了条件

`npm run verify`(= `npm run check` + `npm run knip` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。CI は同じ `verify` を Node 22.19 / 24 で実行します。
カバレッジは `test/unit` と `test/integration` で計測します。

## 構成

| 層 | 場所 | 制約 |
|---|---|---|
| host 中立のコア | `src/core/` | host パッケージを import しない(§依存関係) |
| host アダプタ | `src/hosts/pi.ts`、`src/hosts/opencode.ts` | イベント購読・ツール登録・コマンド・設定パス・キャッシュだけを持つ |
| CLI | `src/cli.ts` | host に依存せず、global 2ファイルと project 2ファイルを読む |

## 制約

### 表面

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| モデル向けツールは `kb_search` の1つだけ | `test/contract/surface.test.ts` | `src/hosts/pi.ts`、`src/hosts/opencode.ts` |
| コマンドは `/kb` の1つだけ | `test/contract/surface.test.ts` | `src/hosts/pi.ts`、`src/hosts/opencode.ts` |
| Pi のイベントは `session_start` / `before_agent_start` / `session_compact` / `tool_call` / `tool_result` の5種で各1ハンドラ | `test/contract/surface.test.ts` | `src/hosts/pi.ts` |
| opencode の hook は `session:context` / `session:compaction` / `tool:execute.before` / `tool:execute.after` / `permission:evaluate` の5種 | `test/contract/surface.test.ts` | `src/hosts/opencode.ts` |
| 専用の write 系ツールを登録しない | `test/contract/surface.test.ts` | `src/hosts/*.ts` |

### 不変条件

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| ID はモデルが命名し、`^[a-z0-9]+(_[a-z0-9]+)*$`・40文字以内。`[0-9a-f]{8}` は受理する | `test/unit/lint.test.ts` | `src/core/catalog.ts` |
| プラグインはパスを書き換えない。ID を生成しない | `test/unit/write_path.test.ts` | `src/core/write_path.ts` |
| 既存エントリパスへの `write` は拒否する。更新は `edit` のみ | `test/unit/write_path.test.ts` | `src/core/write_path.ts` |
| readonly root へのファイルツールの書き込み(`write` / `edit`)は `write.enforce: "warn"` でも拒否する。shell 経由は既知の gap | `test/unit/write_path.test.ts` + `test/integration/extension.test.ts` | `src/core/write_path.ts`、`src/hosts/pi.ts` |
| root 外と `.md` 以外には干渉しない | `test/unit/write_path.test.ts` | `src/core/write_path.ts` |
| 書き込み前の内容検証をしない。`edit` と `patch` には介入しない | `test/integration/extension.test.ts` | `src/core/engine.ts` |
| `write` / `edit` の後に lint の error/warning をツール結果に添える。shell は再走査のみ | `test/integration/extension.test.ts` + `test/integration/opencode.test.ts` | `src/core/engine.ts` |
| ID 規則に合わないファイルは書き込み直後に invalid として記録し、ツール結果に error として出す | `test/integration/opencode.test.ts` + `test/unit/lint.test.ts` | `src/core/engine.ts`、`src/core/catalog.ts` |
| catalog が変わったら検索サービスを必ず作り直す | `test/integration/opencode.test.ts` | `src/core/engine.ts` |
| opencode の hook は Pi と同じ判定を行う(index 注入・拒否・通知・コマンド) | `test/integration/opencode.test.ts` | `src/hosts/opencode.ts` |
| 注入はセッション開始と compaction 後に再生成し、それ以外のセッション中は更新しない | `test/integration/extension.test.ts` | `src/core/engine.ts` |
| 注入は実効予算内に縮退する。固定費が上回る場合はヘッダのみを注入し `overBudget` を表示する | `test/unit/render.test.ts` | `src/core/render.ts` |
| 固定文・ツール宣言・スキルはトークン予算内 | `test/contract/budget.test.ts` | `src/core/render.ts` |
| lint サマリは error/warning があるとき、上位8件をセッションごとに1回モデルへ送る | `test/integration/extension.test.ts` | `src/core/engine.ts` |
| 本文は注入しない | `test/unit/render.test.ts` | `src/core/render.ts` |
| 文書索引は生成物自身とバイナリを除外し、注入しない | `test/unit/docs.test.ts` | `src/core/docs.ts` |
| `source` がリポジトリ内相対パスなら lint が警告する(自己仕様の転記) | `test/unit/lint.test.ts` | `src/core/lint.ts` |
| Git 不在・shallow では git 日付をスキップして警告 | `test/unit/stale.test.ts` | `src/core/stale.ts` |
| refs は `[[id]]` と `supersedes`(`scope:id` を含む)を拾う | `test/unit/refs.test.ts` | `src/core/refs.ts` |
| 未知フィールドは catalog が無視し lint が警告する | `test/unit/catalog.test.ts` + `test/unit/lint.test.ts` | `src/core/catalog.ts` |
| 同一エントリの tags は重複除去する | `test/unit/catalog.test.ts` | `src/core/catalog.ts` |
| supersede で置換された active エントリは lint 警告する | `test/unit/lint.test.ts` | `src/core/lint.ts` |
| ID の重複(root をまたぐ shadow)は lint error にする | `test/unit/lint.test.ts` | `src/core/lint.ts` |
| `/kb review` は候補をモデルへ渡す(プラグイン自身は書き込まない) | `test/integration/extension.test.ts` | `src/core/review.ts`、`src/core/engine.ts` |
| `/kb review` の候補は重複・陳腐化・未参照を出し、ID だけを単独で表示しない | `test/integration/extension.test.ts` + `test/unit/similar.test.ts` | `src/core/review.ts`、`src/core/similar.ts` |
| 候補は上限を超える件数を必ず開示し、`scope:id` 参照は自スコープにだけ効く | `test/unit/review.test.ts` | `src/core/review.ts` |
| `kb dups --max N` は候補ペアが N 超で終了コード1 | `test/unit/cli.test.ts` | `src/cli.ts` |
| 検索結果の content は tags を含む | `test/integration/extension.test.ts` | `src/core/format.ts` |
| 検索結果の content が上限を超えたら、省いたことを注記する | `test/integration/extension.test.ts` | `src/core/engine.ts` |
| embedding 失敗は分類され、検索を止めない | `test/unit/search_service.test.ts` | `src/core/backend_embedding.ts` |
| backend が使えないとき結果は空にせず、lexical で答え、fallback と理由を必ず示す | `test/unit/search_service.test.ts` | `src/core/search_service.ts` |
| OpenCode でも fallback をツール結果の本文で示す | `test/integration/opencode.test.ts` | `src/hosts/opencode.ts` |
| `enabled: false` は全機能を無効化し、`/kb status` だけ残す | `test/integration/extension.test.ts` + `test/integration/opencode.test.ts` | `src/core/engine.ts` |
| `/kb config` は解決済み設定を JSON で返す | `test/integration/extension.test.ts` | `src/core/report.ts` |

### 設定

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 設定はグローバル→プロジェクトの順にマージし、project が優先 | `test/unit/config.test.ts` | `src/core/config.ts` |
| 未信頼プロジェクトの設定は無視する | `test/unit/config.test.ts` | `src/core/config.ts` |
| 壊れた設定は警告して既定値で動き、セッションを止めない | `test/unit/config.test.ts` | `src/core/config.ts` |
| 型不正・範囲不正の設定値は警告して既定値へ戻す | `test/unit/config.test.ts` | `src/core/config.ts` |
| `kb` は host を選ばず、global 2ファイルと project 2ファイルを順に解決する | `test/unit/config.test.ts` | `src/core/config.ts` |
| キャッシュディレクトリだけ host ごとに違う | `test/unit/config.test.ts` | `src/core/config.ts` |
| 同一 scope の root は優先度の高い1つだけ有効。有効 root は最大3 | `test/unit/roots.test.ts` | `src/core/roots.ts` |
| `floorTokens` > `maxTokens` は `maxTokens` に補正する | `test/unit/config.test.ts` | `src/core/config.ts` |
| FTS5・埋め込みキャッシュは指紋一致時のみ再利用し、壊れていても再構築できる | `test/unit/index_cache.test.ts` + `test/unit/search_service.test.ts` | `src/core/index_cache.ts` |
| キャッシュ無効でも検索は動作する | `test/unit/search_service.test.ts` | `src/core/search_service.ts` |

### 依存関係・配布

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 実行時依存を持たない(`dependencies` は空) | `test/contract/dependencies.test.ts` | `package.json` |
| `src/core` は host パッケージを import しない | `test/contract/dependencies.test.ts` | `src/core/` |
| `@opencode/plugin` は型のみの import。実行時に読まない | `test/contract/dependencies.test.ts` | `src/hosts/opencode.ts` |
| `src` の import は node builtin・相対 `.ts`・host パッケージのみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` |
| 循環依存を作らない | `npx biome check .` | `biome.jsonc` の `noImportCycles` |
| 未宣言の依存を import しない(import 元パッケージの `package.json` へ先に宣言する) | `npx biome check .` | `biome.jsonc` の `noUndeclaredDependencies` |
| 未使用の export・依存・ファイルを検出しない | `npm run knip` | `knip.jsonc` |
| 配布物は `files` の whitelist 内のみ | `test/ci/package-contents.test.ts` | `package.json` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/package-contents.test.ts` | `package.json` |
| Pi は `pi.extensions`、opencode は `exports` の `./server` で同じパッケージを読む | `test/ci/package-contents.test.ts` | `package.json` |

### コード品質

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` |
| `console` を使わない | `npx biome check .` | `biome.jsonc` |
| 認知複雑度は 12 以下 | `npx biome check .` | `biome.jsonc` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` | `tsconfig.json` |

## 変更時の手順

- host 依存を `src/core` に持ち込まない。挙動を両 host で揃えたい場合は `src/core` に置き、アダプタは呼び出しだけを書く。
- 表面(ツール・コマンド・hook)を増減する場合は `test/contract/surface.test.ts` を先に更新する。
- 不変条件を変える場合は DESIGN.md を先に更新し、対応するテストを同じ変更で更新する。
- 用語・設定キーを追加する場合は DESIGN.md の用語表または設定スキーマに定義を追加する。
- 新しいフェーズの機能を追加する場合は DESIGN.md の実装フェーズと README を同じ変更で更新する。
- 知識(エントリ)を追加・更新する判断の正は DESIGN.md §11.5 の採用規則にある。設計の転記を書かない。

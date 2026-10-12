# pi-knowledge

プロジェクトで得た知識は、セッションが終わると次のエージェントに伝わりません。同じ調査がやり直され、同じ落とし穴に再び当たります。

pi-knowledge は、リポジトリの `knowledge/` に置いた Markdown を知識ベースとして扱います。セッション開始時に索引を注入し、エージェントは必要なエントリだけを読みます。書き込みは書き込み後に検証され、CI の `kb lint` で劣化を検出します。Pi と OpenCode の両方で動きます。

ここでの「エントリ」は、結論・条件・根拠を持つ 1 件の Markdown です。

```
セッション開始
  └ 索引（id・title・when）を注入
作業中
  ├ kb_search で検索 → read で本文を読む
  └ write / edit で追加・更新 → 検証結果をツール結果に表示
CI
  └ kb lint で形式エラー・参照切れ・陳腐化を検出
```

## 使い方

### 知識を書く

`knowledge/<id>.md` を作ります。id はファイル名から `.md` を除いた部分で、ツールがファイル名を変えることはありません。

```markdown
---
title: "External API responses must be schema-checked"
when:
  - When calling a new external API
tags: [api, validation]
status: active
review_after: 2027-03-31
source: https://example.com/api.md
---

Conclusion: validate external API responses against the expected schema before use.
Conditions: the response comes from a third-party service.
```

記録する内容は次の 3 つすべてに当てはまるものだけです。

| 基準 | 問い |
|---|---|
| 読み取り可能性 | コード・設計書・README から読み取れない内容か |
| 変更耐性 | 設計を変えても結論が壊れないか |
| 再検証可能性 | URL・絶対パス・再現手順など、根拠を指せるか |

書き方は、同梱の `knowledge-curation` スキルが指示します。

### 知識を使う

- エージェントは、セッション開始時の索引で既存エントリの存在を知ります。
- 索引には本文が含まれません。本文は、索引の id と Roots 行から `knowledge/<id>.md` を求めて `read` で読みます。`kb_search` の結果にも `path` が含まれます。
- 人は `/kb search <query>`、`/kb find <tag>...`、`/kb list` で探せます。

### 知識を整理する

- `/kb lint` で形式エラーと警告を確認します。
- `/kb review [focus]` で、重複・陳腐化・未参照のエントリをエージェントに渡します。エージェントは `write` / `edit` で整理します。プラグインはエントリを書きません。
- `/kb stale`、`/kb dups`、`/kb refs <id>` で、個別の観点から確認できます。

## インストール

### Pi

```bash
pi install git:github.com/kurowashi/pi-knowledge
```

ref を固定する場合は `pi install git:github.com/kurowashi/pi-knowledge@<tag|commit>` を使います。

ローカルの作業コピーを使う場合は `pi install /path/to/pi-knowledge` を使います。

> [!WARNING]
> npm の `pi-knowledge` は別のパッケージです。`pi install npm:pi-knowledge` では、このプラグインは入りません。

### OpenCode

ローカルの作業コピーのディレクトリを指定します。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./pi-knowledge"],
  "skills": ["./pi-knowledge/skills"]
}
```

`plugins` に npm の `pi-knowledge` を指定しないでください。別のパッケージが入ります。

### CLI（`kb`）

CI では、作業コピーの `src/cli.ts` を Node で直接実行します。ビルドは不要で、Node 22.19 以上が必要です。

```bash
node path/to/pi-knowledge/src/cli.ts lint
```

以下のコマンド例では、この実行を `kb` と書きます。

## 設定

設定は JSON で書きます。読み込む場所は次のとおりです。

| 対象 | グローバル | プロジェクト |
|---|---|---|
| Pi | `$PI_CODING_AGENT_DIR/knowledge.json`（未設定時は `~/.pi/agent/knowledge.json`） | `.pi/knowledge.json`（プロジェクトが信頼されているときだけ） |
| OpenCode | `$XDG_CONFIG_HOME/opencode/knowledge.json`（未設定時は `~/.config/opencode/knowledge.json`） | `.opencode/knowledge.json` |
| CLI | 上記の両方 | 上記の両方（`.pi` の次に `.opencode` を読み、後の値が優先） |

- グローバル設定を先に読み、プロジェクト設定で項目ごとに上書きします。
- `roots` は配列ごと置き換えます。
- 不明なキーは無視します。型や範囲が不正な値は警告を出し、既定値を使います。設定の不備でセッションは止まりません。

主なキーは次のとおりです。

| キー | 既定 | 内容 |
|---|---|---|
| `enabled` | `true` | `false` で全機能を止めます。`/kb status` だけが残ります。 |
| `roots` | `knowledge` を project root として 1 つ | 知識を置くディレクトリです。`roots` が未指定で `knowledge/` もなければ、何もしません。 |
| `injection.enabled` | `true` | 索引を注入します。 |
| `injection.maxTokens` | `4000` | 索引の上限トークン数です。 |
| `injection.floorTokens` | `1000` | 文脈窓が小さい場合の下限です。 |
| `injection.contextFraction` | `0.02` | 文脈窓に対する割合です。 |
| `search.backend` | `lexical` | 検索方式です。`lexical` / `fts5` / `embedding` / `hybrid` から選びます。 |
| `search.embedding.endpoint` / `model` / `apiKeyEnv` / `timeoutMs` | 空 / 空 / 空 / `5000` | embedding の接続先です。`apiKeyEnv` には API キーを入れた環境変数名を書きます。 |
| `write.enforce` | `block` | 既存エントリへの `write` の扱いです。[書き込みの検証](#書き込みの検証)を参照してください。 |
| `recall.mode` | `off` | `hint` にすると、プロンプトに関連するエントリの id を、そのターンに追加します。同じセッションで一度追加した id は、再び追加しません。 |
| `capture.mode` | `manual` | `off` にすると `/kb capture` を無効にします。 |
| `docs.path` / `include` / `exclude` / `maxLines` | `docs/INDEX.md` / `["docs/**"]` / `[]` / `500` | `kb docs` の出力先と対象です。 |
| `stale.days` | `365` | Git の最終更新日がこの日数を超えたエントリを陳腐化候補にします。 |
| `cache.enabled` | `true` | 検索インデックスをキャッシュします。 |

### root の scope

`roots` の各 root は `scope` を持ちます。

- `project`（既定）: このリポジトリの知識です。
- `user`: 個人の知識です。明示的に設定した場合だけ使います。
- `team`: 共有の知識です。`readonly: true` を付けると、プラグインからの書き込みを拒否します。

有効な root は最大 3 つで、同じ scope の root は優先度が最も高い 1 つだけが有効になります。

### 検索インデックスのキャッシュ

キャッシュは次の場所に作られます。`.gitignore` に追加してください。

- Pi: `.pi/knowledge-fts.sqlite`、`.pi/knowledge-embeddings.json`
- OpenCode: `.opencode/knowledge-*`

キャッシュを無効にするには `"cache": { "enabled": false }` を設定します。

### embedding

`search.backend` が `embedding` または `hybrid` のときだけ、エントリ本文と検索クエリを `search.embedding.endpoint` へ送信します。既定ではネットワークを使いません。

## 仕組み

### エントリ形式

| フィールド | 必須 | 役割 | 条件 |
|---|---|---|---|
| `title` | 必須 | 索引の見出し | 文字列。120 字を超えると警告 |
| `when` | 任意 | 適用条件 | 英語1文の文字列1本。15 語を超えると警告。配列は 1 件まで |
| `tags` | 任意 | 絞り込み | 文字列の配列 |
| `status` | 任意 | 状態 | `active`（既定）・`superseded`・`deprecated`。`active` 以外は索引と既定の検索から外れます。 |
| `supersedes` | 任意 | 置き換えた古いエントリの id | 指す先が `active` のままだと警告 |
| `review_after` | 任意 | 再確認日 | `YYYY-MM-DD`（UTC）。過ぎると警告 |
| `source` | 任意 | 出典 | URL または絶対パス。リポジトリ内の相対パスは警告 |

frontmatter は、プレーンな値・引用符付き文字列・インライン配列・`- item` 形式のリストを書けます。`#` で始まる行はコメントとして無視します。ネストしたマッピング・ブロックスカラー（`>` / `|`）・想定外のインデントはエラーです。

### id（ファイル名）

- 形式は `^[a-z0-9]+(_[a-z0-9]+)*$`、40 字以内です。
- 形式に合わないファイル名は、エントリとして扱わず、`kb lint` でエラーになります。
- 旧形式の `[0-9a-f]{8}` も有効です。
- 同じ id のファイルが複数の root にあると、エラーになります。

### 索引

- セッション開始時と、compaction が成功した後に生成します。
- 1 件のエントリにつき 1 行で、`id  title — when` の形式です。
- 索引には本文を含めません。
- 上限を超える場合は、`title` を短くし、それでも超える場合は件数とタグだけにします。固定費だけで上限を超える場合は、固定文と Roots 行だけを注入し、`/kb status` に `over fixed budget` と表示します。
- 実効上限は `min(maxTokens, max(floorTokens, 文脈窓 × contextFraction))` です。文脈窓が 200k なら 4000、100k なら 2000、32k なら 1000 トークンになります。
- 会話の途中で作ったエントリは、`kb_search` で見つかります。索引に載るのは次のセッションか、次の compaction の後です。Pi では、compaction 後の索引は次の実行の開始時に反映されます。

### 検索

`kb_search` は、エージェントが使える唯一の検索ツールです。

| 引数 | 既定 | 内容 |
|---|---|---|
| `query` | なし | 検索語。`tags` と両方が空ならエラーです。 |
| `tags` | なし | 全タグが一致するものだけを返します。 |
| `status` | `active` | `active` / `any` / `superseded` / `deprecated` |
| `scope` | なし | `project` / `user` / `team` で絞ります。 |
| `backend` | 設定値 | この呼び出しだけ検索方式を変えます。 |
| `limit` | `10` | 1〜50 |

検索方式は次のとおりです。

| 方式 | 内容 |
|---|---|
| `lexical` | 既定。外部サービスを使いません。 |
| `fts5` | Node の `node:sqlite` の FTS5 を使います。利用できないときは `lexical` に戻ります。 |
| `embedding` | 設定したエンドポイントで意味的に近いエントリを探します。 |
| `hybrid` | `lexical` と `embedding` の結果を順位で統合します。 |

- `embedding` と `hybrid` は、`query` が空のとき（タグだけの検索）は `lexical` で絞り込みます。
- 利用できない方式は `lexical` で答えます。結果には、実際に使った方式と理由（`unavailable` / `auth` / `network` / `rate_limited` / `server` / `protocol`）を必ず示します。黙って切り替えることはありません。
- 返す本文の抜粋は、全体で約 3000 トークンまでです。超えた分は件数を減らし、その旨を示します。

### 書き込みの検証

書き込みの内容は、保存する前には検証しません。保存後に検証し、結果をツール結果に添えます。

| 操作 | 動作 |
|---|---|
| 既存エントリのパスへの `write` | 既定では拒否します。`edit` で更新するよう理由を返します。`write.enforce` を `warn` にすると、注記付きで許可します。 |
| 新規パスへの `write` | 許可します。パスは書き換えません。 |
| readonly root への `write` / `edit` | どの `write.enforce` の設定でも拒否します。 |
| `write` / `edit` の後 | エントリを読み直し、lint の結果を `kb: ...` としてツール結果に添えます。 |
| シェル（`bash` / `shell` / `powershell`）の後 | すべてのエントリを読み直します。結果は表示せず、書き込みも拒否しません。 |

読み直しでエラーになったエントリは、索引・検索・注入から外れます。ファイルは残り、`kb lint` のエラーとして報告されます。

セッション開始時には、エラーや警告がある場合だけ、上位 8 件と残りの件数をエージェントに渡します。Pi では件数を通知にも出します。OpenCode では、各セッションの最初のモデル呼び出しの時点で渡します。

### lint

`kb lint` と `/kb lint` は、次の内容を確認します。

- エラー（エントリから外れます）
  - frontmatter がない、閉じていない、または解析できない
  - `title` がない、空、または文字列でない
  - 各フィールドの型や値が合わない（`status`、`review_after` を含む）
  - ファイル名が id の形式に合わない
  - 同じ id が複数の root にある
- 警告（保存は許可されます）
  - `title` が 120 字を超える、`when` が 15 語を超える、`when` が 2 件以上ある
  - 本文が空または 50 字未満
  - 未知のフィールドがある
  - `[[id]]` や `supersedes` の参照先がない
  - `supersedes` で置き換えられた entry が `active` のまま
  - `source` がリポジトリ内の相対パス、または存在しない絶対パス（URL は確認しません）
  - `review_after` が過ぎている
  - 内容が似たエントリがある
  - root 直下のサブディレクトリにある `.md`（エントリとして扱いません）

### 整理

- `/kb review [focus]` は、次の候補をエージェントに渡します。
  - 重複（最大 5 組）
  - 陳腐化（`review_after` が過ぎたもの、または Git の最終更新から `stale.days` を超えたもの。最大 10 件）
  - 未参照（`[[id]]` と `supersedes` のどちらからも参照されない `active` のもの。最大 10 件）
- 結論が他に吸収されている低価値なエントリや、結論の衝突は、エージェントが判断します。
- Git の日付は、Git の管理下にないディレクトリでは使えません。その場合は警告を出して、日付による判定を飛ばします。

### 文書索引

`kb docs` は、`docs.include` に一致するファイルの一覧を `docs.path`（既定は `docs/INDEX.md`）に書きます。1 行は `<パス> — <最初の見出し>` です。索引には注入されず、`read` で見つけるためのものです。`kb docs --check` は、索引が存在しないとき、または現在の内容と違うときに終了コード 1 を返します。

## コマンド

### `/kb`

| コマンド | 内容 |
|---|---|
| `/kb status` | 有効状態、有効な root、索引の段階と推定トークン数、lint の件数、検索方式を表示します。引数がない場合の既定です。 |
| `/kb config` | 既定値を適用した後の設定を JSON で表示します。 |
| `/kb lint` | lint の結果を表示します。 |
| `/kb list` | `active` のエントリを一覧します。 |
| `/kb tags` | タグと件数を表示します。 |
| `/kb find <tag>...` | 全タグを持つ `active` のエントリを表示します。 |
| `/kb search <query>` | 設定の検索方式で検索します。 |
| `/kb stale` | 陳腐化の候補を表示します。 |
| `/kb dups` | 内容が似たエントリの組を表示します。 |
| `/kb refs <id>` | そのエントリを参照しているエントリを表示します。 |
| `/kb review [focus]` | 整理の候補をエージェントに渡します。 |
| `/kb docs` | 文書索引を生成します。 |
| `/kb bench <fixture.json>` | 検索方式ごとの再現率と速度を計測します。 |
| `/kb capture [focus]` | このセッションで得た知識を、エージェントに記録させます。`capture.mode` が `manual` のときだけ動きます。 |

### `kb`（CLI）

| コマンド | 内容 | 終了コード |
|---|---|---|
| `kb list [--all]` | エントリを一覧します。`--all` は `active` 以外も含めます。 | 0 |
| `kb tags` | タグと件数を表示します。 | 0 |
| `kb find <tag>...` | 全タグを持つエントリを表示します。 | 一致 0 件で 1 |
| `kb search <query> [--json] [--limit N] [--status S] [--scope S] [--backend B] [--require-backend]` | 検索します。`--require-backend` は、指定した方式が使えなければ終了コード 3 にします。 | 3 は `--require-backend` で方式が使えないとき |
| `kb lint` | エラーと警告を表示します。 | エラーありで 1 |
| `kb stale` | 陳腐化の候補を表示します。 | 0 |
| `kb refs <id>` | 参照しているエントリを表示します。 | 0 |
| `kb dups [--max N]` | 内容が似たエントリの組を表示します。 | 組が N を超えると 1。N が 0 以上の整数でないと 2 |
| `kb docs [--check]` | 文書索引を生成します。`--check` は生成せず、差分を確認します。 | 差分ありで 1。読み書きの失敗で 2 |
| `kb bench <fixture.json> [--repeat N] [--backend B]` | 検索方式ごとに計測し、JSON で表示します。 | 0 |

## 制限

- 書き込みの検証は `write` と `edit` にだけ働きます。`patch` は検証しません。`patch` で既存のエントリを変えると、拒否されません。
- シェルからの書き込みは止められません。シェルの後にはエントリを読み直しますが、既存エントリへの書き込みを拒否しません。
- 中身の検証は書き込み後に行います。不正な内容も一度は保存されます。
- 索引は、セッション開始と compaction の後にだけ更新されます。会話の途中で変えても、索引には反映されません。
- `mtime` とサイズが同じ外部変更は検出できません。次のセッション開始か CI の `kb lint` で見つけます。
- `recall` のヒントは保存されません。セッションを再開すると、再び注入されることがあります。
- OpenCode には、画面に出る通知がありません。警告は会話とツール結果に出ます。
- 開発と検証に使う Pi は 0.87.1、`@opencode/plugin` は 2.0.27 です。これ以外のバージョンでの動作は保証しません。

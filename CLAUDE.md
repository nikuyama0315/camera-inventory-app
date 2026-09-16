# camera-inventory-app

仕入在庫受発注管理システム(中古カメラ転売business)。**ソースコードはこのフォルダにはなく、VPS上にのみ存在する。**

## ソースコードの場所とアクセス方法

- ソース: VPS上 `/opt/camera-inventory-app-src`
- デプロイ先: `/var/www/camera-inventory`(nginx配信、**ポート8080**。ポート80は無関係の別サイト)
- アクセス手段: `ssh-vps-manager` MCPツール(`run_command`)経由。ローカルにgit clone等は無い。
- git: VPS上の `/opt/camera-inventory-app-src` で管理(2026-09-07に`git init`、ローカルにはリポジトリ無し)。`.env`はコミット対象外。
- Supabase project ref: `ceupmjnothcitgyffhke`(Supabase上のプロジェクト名は`ebay_automation`)。Supabase MCPツール(`mcp__05c17e31-...`)でEdge Function・DBに直接アクセス可能。

## ビルド・デプロイ手順(VPS上で実行)

```
cd /opt/camera-inventory-app-src
npm run build   # tsc -b && vite build (型チェック込み)
cp -r dist/* /var/www/camera-inventory/
md5sum dist/assets/index-*.js /var/www/camera-inventory/assets/index-*.js  # 一致確認
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/  # 200確認(ポート8080必須)
git add -A && git commit -m "..."
```

## 重要な注意点

- **大きなテキストブロックをSSH経由で転記するのは信頼できない**: このセッションでUTF-8破損事故が過去に起きており(system-info.md参照)、さらに2026-09-07には数KB超のbase64文字列をSSHコマンドとして手動生成する際に転記ミスでmd5不一致が発生した。コード編集は`python3`のヒアドキュメント+`decode('utf-8')`検証で小〜中規模なら概ね安全だが、数十KB規模のファイル転送(このclaude/配下のドキュメント等)をこの方法で行うのは避けること。
- `/opt/ebay-automation`(同一VPS上、別プロジェクト)は変更禁止。ユーザーから直接名指しで依頼された場合のみ例外。

## 参考ドキュメント

`claude/`フォルダ配下に、過去セッションでの提案・実装記録が入っている(**ローカルのみ、VPS上には無い**):

- `claude/system-info.md` — システム全体の現状(最も重要、まずこれを読む)
- `claude/ebay-sales-sync-proposal.md` — eBay売上自動同期の設計・実装経緯
- `claude/report-import-proposal.md` — CSV/PDFレポート取込機能の設計・実装経緯
- `claude/profit-calculator-ttm-rate.md` — `/opt/ebay-automation`側の為替レート自動取得機能
- `claude/forgot-password-spec.md` — 古い仕様メモ(2026-09-08にebay-automation方式(共有ユーザー名/パスワード+リカバリーコード)へ全面刷新済み。`src/pages/LoginPage.tsx`+`src/pages/AccountSecurityPage.tsx`+`src/lib/api/auth.ts`+Edge Functions `app-login`/`app-change-password`/`app-recovery-code-reissue`/`app-forgot-password`参照。Supabase Authの`ResetPasswordPage.tsx`は廃止・削除済み)

## セッション要点(2026-09-15〜09-16)

直近2日間のセッションで実装した主な機能・修正。詳細な経緯は各コミットメッセージ参照。

### 利益管理票・his50s連携
- `EbayXlsxFillPanel.tsx`(利益管理票更新用データの作成): 仕入値(税込)の右に「送料・クーリエ・日本郵便」列を追加。eBay APIではなくDB(`ebay_transaction_lines`→`sales.shipping_cost_paid`)からOrder No突合で取得、未登録ならブランク。Excel側は既存テンプレートに元々あった未使用S列にそのまま書き込むだけで済んだ(列挿入不要)。
- his50s.com(Japan Retro Camera Wholesale)連携: 商品が売れた際、Edge Function `notify-his50s-sold`が公式API(`POST /api/v1/seller/listings/sold`)を呼び出し、his50s側の在庫を自動で減らす。`src/lib/api/sales.ts`の`createSale()`からfire-and-forgetで呼ばれる(失敗しても売上登録自体は成功扱い)。APIキーは`his50s_credentials`テーブル(RLS有効・ポリシー無し、service_roleのみアクセス可)。実行時(sold API成功時)はGmail通知+`event_log`テーブルへの記録も行う(`move-drive-folder`等と同じパターン)。

### 基本情報・在庫アラート
- 基本情報タブのブランド・機種名: `<datalist>`で登録済み値を候補表示しつつ自由入力も可能に。
- 在庫アラート画面: 機種名フォルダ自体をテキストボックス+保存ボタンで編集(リネーム)可能にし、右に「Driveフォルダ」列(URL表示・編集・「フォルダを開く」ボタン)を追加。表示URLは`model_stock_alert_settings.drive_folder_url`(手動保存)を優先し、無ければ`model_drive_stock_counts.drive_folder_id`(Google Drive同期で自動取得)から自動生成。

### 詳細編集・一覧表示
- 詳細編集モードの絞り込み条件に「仕入品名」「出品者名」「仕入日(範囲)」「仕入先種別」を追加し、指定順の6段レイアウトに整理(`ItemListPane.tsx`)。出品者名・仕入日・仕入先を指定した場合のみ`purchases`を`!inner`結合に切り替える(該当データが無い商品は除外)。
- 一覧表示(`ItemTableView.tsx`)の各行に「複写して登録」ボタンを追加。押すと画面遷移せずモーダルを新規登録+コピー元指定モードで開く(`InventoryPage.tsx`の`modalCopySourceItemId`)。
- 一覧表示に「邦プラットフォーム販売価格」「粗利」列を追加(`sales.jp_platform_price`/`sales.gross_profit_jpy`)。
- **注意**: 一覧表示の「削除」「複写して登録」ボタンは元々`position: sticky`で右端固定の「操作」列にまとめてある。理由: テーブルの`table-layout: fixed`は`<colgroup>`の`<col>`幅指定が優先されるため、列を追加/統合する際は`<colgroup>`側の幅(%)も忘れずに調整すること(忘れるとボタンがテーブル外にはみ出す)。また画面全体が横スクロール不可になる場合は、テーブルを囲むflexラッパーに`minWidth: 0`が無いのが原因であることが多い(flex itemの既定`min-width: auto`がテーブルの内容幅でコンテナを押し広げてしまうため)。

### 仕入登録の自動化(メルカリ/Yahoo!フリマ/ヤフオク購入品)
- ユーザーがG:ドライブ上のテキストファイル(サイトのページ内容をコピペしたもの)を渡し、そこから商品名等を抽出→該当サイトの取引詳細ページをブラウザで開いて仕入高・出品者・購入日・URLを取得→`items`+`purchases`を新規登録、という一括登録フローを複数回実施。
- 新規登録はUI操作ではなく、Supabase RPC `create_item_with_purchase`(item_id + management_no を返す)を直接呼ぶ方が確実(「+新規登録」フォームが最終的に呼ぶのと同じRPC)。account列はこの関数では設定されない(status='awaiting_arrival'は関数内で固定)ため、登録後に`update items set account=... where management_no=...`が必要。
- 管理番号(YYMMDD-nn)のnnは、DBの`generate_management_no(base_date)`関数で次の番号を確認できる。
- 上記ファイルはShift-JIS(cp932)で保存されているため、Readツールでそのまま読むと文字化けする。PowerShellで`[System.Text.Encoding]::GetEncoding(932)`を使いUTF-8に変換してから読むこと。
- メルカリ・ヤフオクとも「ストア」出品者(法人ショップ)からの購入は、個人間取引と画面構成が異なる(メルカリ:「メルカリShops」、ヤフオク:買い物カゴ経由のストア注文ページ)ため、指示通りの文言(「支払い金額」「出品者：」等)がそのまま存在しないことがある。その場合は同等の情報(商品金額・ストア名等)で代替した。

### 検品タブ
- 各項目(全体・外観・シャッター確認等、日本語+英訳の計18項目)に「候補から選択」プルダウンを追加。`inspections`テーブル全件から項目ごとに頻度順で集計(件数が小規模な前提。将来的に増えたら要見直し)。
- **修正済みの不具合**: 検品タブの保存(`handleSave`)は元々毎回`saveInspection`(INSERT)を呼んでおり、状態ランク等を変更して保存するたびに新しい行が増え続けていた(表示順未指定のため、どの行が画面に出るか不定になり「変更が反映されない」ように見えていた)。既存の検品データがあれば`updateInspection`で更新するよう修正し、`fetchItemDetail`の`inspections`埋め込みにも`inspected_at`降順のORDER BYを追加した。

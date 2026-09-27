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

## セッション要点(2026-09-27〜09-28)

出品タブの新機能群、大規模データ更新、他プロジェクト(`/opt/ebay-automation`)への機能追加を実施。詳細な経緯は各コミットメッセージ参照。

### 出品(Listing)タブ
- **利益簡易計算モーダル**(`ProfitCalcModal.tsx`): `/opt/ebay-automation`のdashboard_v2.htmlの計算ロジックをそのまま移植。Item price横の「利益簡易計算」ボタンから開き、商品本体価格・仕入高・Shipping policyの$額を初期値として渡す。「変更値を元画面に反映する」で商品本体価格とShipping policy(最も近い`EXP_$00NN`に自動マッチ)を書き戻す。
- **Payment/Shipping policyのライブ取得化**: 従来ハードコードしていた選択肢(実際の登録数と不一致だった)をやめ、Edge Function `listing-seller-policies`でeBay Account APIから毎回取得する方式に変更。Account API/Marketing APIは通常の`ebay_credentials.refresh_token`では403(sell.account/sell.marketingスコープ不足)になるため、`ebay_credentials.broad_scope_refresh_token`(`/opt/ebay-automation`と同一eBayアカウントの別OAuth grant)を新設し、そちらでアクセストークンを取得する仕組みにした(現状`soulcamera`のみ設定済み)。
- **Sold積み出品(ReviseItem)機能**: eBay上でQTY=0(Restock待ち)の既存出品を流用し、売上履歴・検索順位を温存したまま新しい現物用に内容を差し替える機能。Item Specificsセクションに「既存ItemID」入力欄+「既存出品データ取得」ボタンを追加(`listing-item-specifics-lookup`をitemId指定にも対応させ拡張)。取得成功で`existing_item_id`(=`reviseTargetItemId`)が設定され、「出品する」ボタンが「更新出品する」に変わりReviseItemで送信される。Edge Function `listing-publish`が新規(AddFixedPriceItem、VerifyAddFixedPriceItemで事前検証)/更新(ReviseItem、事前検証呼び出しは存在しないため無し)の両モードに対応。
  - **既知の制約**: 対象ItemIDがeBayのInventory API(V2)で作成された出品の場合、eBay側がReviseItem自体を拒否する(`Inventory-based listing management is not currently supported by this tool.`)。Trading API側では回避不可、Trading API(AddFixedPriceItem)で作成されたItemIDのみ対象にできる。
  - 「更新出品(Sold積み出品)モード」表示の横に「新規出品モードに切り替え」ボタンを追加(`reviseTargetItemId`等だけクリアし、他の入力済みデータは保持)。
  - 出品結果(成功/失敗)は画面下部のテキストに加え、`window.alert()`でも必ず通知する(テキストだけだと見逃しやすいというユーザー報告への対応)。
- **Promoted Listings**: General(固定入札率、%入力欄)・Priority(ON/OFFトグル)を追加。出品成功後に`listing-publish`内で`sell.marketing`スコープ(broad_scope_refresh_token)を使い`ad_campaign`へ登録を試みる(失敗しても出品自体は成功扱い、`promotedWarning`として警告表示)。
- 写真セクション見出し横に「画像保管フォルダを開く」ボタン追加(検品タブと同パターン)。「保存」の右に「クリア」ボタン(DB保存はせず画面入力のみリセット)。
- `crypto.randomUUID is not a function`エラー修正: プレーンHTTP配信(非Secure Context)では一部ブラウザで無効化されるため、`listingDraft.ts`にフォールバック付き`generateId()`を追加。

### 出品チェックタブ
- 「チェック実行」ボタンを「eBay-アプリ同期チェック」に改名。
- **「直販PF-アプリ同期チェック」ボタン新設**: his50s.com(Japan Retro Camera Wholesale)の公開中(`status='published'`)出品と、アプリ側account=soulcamera・ステータスが検品済出品待ち/出品中(`items.category != '雑貨'`、雑貨はhis50s非取扱のため対象外)のアイテムを管理番号で突合。新規Edge Function `his50s-listing-check`。「アプリのみ」「his50sのみ」「両方に存在」の3表で表示、仕入品名/Item Titleの2行表示対応。

### 直販プラットフォーム登録用CSV作成(`DirectSalesCsvPanel.tsx`/`platformExportCsv.ts`)
- ステータス絞り込みを2枠化(両方指定時はOR=いずれかに一致、他の条件とはAND)。
- CSV列のロジック変更: `title`は「ブランド 機種名 管理番号」のスペース区切り連結(旧: 直近売上のeBay出品タイトル)。`condition_description`は3行構成——1行目「検品タブの状態チェック表(`check_shutter`等8項目)でOKの項目を`, `連結+`[Tested functions] ... Confirmed working.`」、2行目`[Lens] `+検品レンズ英訳、3行目`[Finder] `+検品ファインダー英訳(各行、値が無ければ省略)。`category`(`platform_category`)・`grade`は従来通り。

### eBay商品ページからの基本情報一括反映
- eBay出品ページ(`https://itm.ebaydesc.com/itmdesc/{ItemID}`、静的HTMLなのでヘッドレスブラウザ不要・fetch()で取得可能)の商品説明欄から、ITEM TITLE・Brand/Model・Body/Lens Serial No.・Tested functions・Includes・GRADEを抽出し、`items`テーブル(item_title/serial_number/lens_serial_number/grade/accessories_included/platform_category)と`inspections.other_notes_en`に反映する作業を40件実施(URLはユーザー指定、ブランド/機種名は既存値を優先し上書きしない方針で対応)。「Soulcamera Item Info」/「ADMIN NO.」の値(先頭の"20"を除くと管理番号)で対象アイテムを自動特定できることを確認。この場での判断: 個別の突発リクエストなら都度ブラウザ抽出で対応、恒常機能化するならEdge Function+GetItem方式(Trading API経由、ヘッドレスブラウザ不要)が望ましい。

### 大規模DB更新(一括)
- `items.account='soulcamera'`: 333件(管理番号リスト指定)。
- `items.category='雑貨'`: 164件(仕入品名リスト指定、重複タイトル起因で3件は意図せず含まれる可能性ありと開示済み)。
- `items.category='カメラ関連品'`: 169件(管理番号リスト指定)。
- `account='soulcamera' AND management_no LIKE 'Z-%'` → `category='雑貨'`: 241件(直前の「カメラ関連品」更新77件分を上書きする旨ユーザー確認済みで実施)。

### `/opt/ebay-automation`への機能追加(ユーザーから直接名指しで依頼された例外対応)
- **eBay相場検索機能**: 既存の`search_ebay_organic_rank`(Browse API、App Token=ログイン不要)と同じ認証方式で、Best Match上位15件のUS$価格から平均値・中央値を算出する`search_ebay_market_price()`を`scripts/sell_similar.py`に追加。定期スキャン(`run_scan()`、既存cronで自動実行)に組み込み済みのほか、ダッシュボード(v2)の各行に「相場を更新」ボタン(個別リアルタイム実行)を新設。`ebay_sell_similar_queue`テーブルに`market_avg_price_usd`/`market_median_price_usd`/`market_sample_size`/`market_checked_at`列を追加。利益簡易計算モーダルのタイトル横にも表示(明るめの臙脂色 `#D9455F`)。
- UI改善: 検索語横にコピーアイコンボタン(プレーンHTTP配信のため`navigator.clipboard`不可な場合は`execCommand('copy')`にフォールバック)。Priority ON/OFFのプルダウンをトグルボタン化。
- 変更ファイル: `scripts/sell_similar.py`、`webapp/app.py`(新規ルート`/queue/<row_id>/refresh-market-price`)、`webapp/templates/dashboard_v2.html`。編集前に`.bak-pre-<スラッグ>-20260927`でバックアップ、`python3 -c "import ast; ast.parse(...)"`で構文確認、`sudo systemctl restart ebay-automation-webapp`はユーザー確認の上で実行。**このプロジェクトはCLAUDE.mdの管理対象外のためcommit運用は行っていない。**

### Windows側SSH鍵のトラブルシューティング(デプロイ手順に関する既知の注意点)
- デプロイコマンドは必ず`ssh -i <鍵パス> ubuntu@133.18.147.130 "<リモートコマンド>"`の形で**SSHラッパーごと**1コマンドとして渡すこと(ラッパー無しでbash構文のコマンドをそのまま渡すと、ユーザーのローカルシェルがPowerShellのため`&&`未対応・`md5sum`無し等で失敗する)。
- `vps_key_openssh.key`のWindows ACLが緩いと(このセッションでは`LENOVO-L13\CodexSandboxUsers`という余分なアクセス権が付与されていたことが原因)、OpenSSHクライアントが鍵を拒否してパスワード認証にフォールバックし失敗する。修正は`cmd /c`経由のicaclsで行うこと(PowerShellの`$env:USERNAME:R`のような記法は`:`の解釈でエラーになりやすい):
  ```
  cmd /c 'icacls "<鍵パス>" /inheritance:r && icacls "<鍵パス>" /remove "<余分なアカウント名>" && icacls "<鍵パス>" /grant:r "%username%:R"'
  ```

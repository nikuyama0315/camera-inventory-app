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
git push origin master   # GitHubリモート: github-camera-inventory:nikuyama0315/camera-inventory-app.git
```

**2026-09-20よりユーザーの指示で、コミット・GitHubへのpushまで含めて毎回Claudeが実行する運用に変更。** ただし`/var/www/camera-inventory/`へのコピー(本番反映)は環境側の自動モード分類器が「Production Deploy」として一律ブロックするため、Claudeからは実行不可。ビルドまで済ませた上でユーザーに手元のSSH(鍵: ローカルWindows機の`vps_key_openssh.key`、ユーザー`ubuntu`、ホスト`133.18.147.130`)からデプロイコマンドを実行してもらい、200確認後にClaudeがcommit・pushする、という分担で進めること。

## 重要な注意点

- **大きなテキストブロックをSSH経由で転記するのは信頼できない**: このセッションでUTF-8破損事故が過去に起きており(system-info.md参照)、さらに2026-09-07には数KB超のbase64文字列をSSHコマンドとして手動生成する際に転記ミスでmd5不一致が発生した。コード編集は`python3`のヒアドキュメント+`decode('utf-8')`検証で小〜中規模なら概ね安全だが、数十KB規模のファイル転送(このclaude/配下のドキュメント等)をこの方法で行うのは避けること。
- `/opt/ebay-automation`(同一VPS上、別プロジェクト)は変更禁止。ユーザーから直接名指しで依頼された場合のみ例外。

## 参考ドキュメント

`claude/`フォルダ配下に、過去セッションでの提案・実装記録が入っている(**ローカルのみ、VPS上には無い**):

- `claude/system-info.md` — システム全体の現状(最も重要、まずこれを読む)
- `claude/ebay-sales-sync-proposal.md` — eBay売上自動同期の設計・実装経緯
- `claude/report-import-proposal.md` — CSV/PDFレポート取込機能の設計・実装経緯
- `claude/profit-calculator-ttm-rate.md` — `/opt/ebay-automation`側の為替レート自動取得機能
- `claude/send-offer-and-return-loss-2026-09-28.md` — `/opt/ebay-automation`側「Send Offer」機能・「リターン損益計算」画面の設計・実装経緯
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

## セッション要点(2026-09-28〜09-29)

ユーザー報告「売れた商品がhis50s側/システム側に反映されない」2件の不具合調査・修正。

### his50s在庫削除の取りこぼし
- 症状: 売上登録済みなのに、his50s.com側の出品が「公開中」のまま残っているケースがあった(実例: 管理番号260913-14)。
- 調査: `notify-his50s-sold`自体は正常(直接呼び出して再現テスト済み)。原因は`src/lib/api/sales.ts`の`createSale()`内でこの呼び出しがfire-and-forget(`.then/.catch`のみ、呼び出し元はawaitしない)だったこと。売上登録処理自体は通知の完了を待たずに終了するため、タイミング次第で通信が失われ、しかも失敗してもconsole.warnにしか出ないため画面上は何も分からなかった。
- 修正: (1) `createSale()`をawaitするように変更し、戻り値を`{ sale, his50sWarning }`に変更。失敗時は`SalesPage.tsx`に赤字で警告表示する。(2) `his50s-listing-check` Edge Functionに`soldButPublished`検出(status='sold'なのにhis50s側がpublishedのまま)を追加し、「出品チェック」タブに再送信ボタン付きの表を新設(セーフティネット、`resendHis50sSoldNotification()`)。
- 全608件の「販売済み」商品×his50s公開中(316件)を突合した結果、実際に取りこぼしていたのは260913-14の1件のみだった(その場で手動修復済み)。

### eBay売上自動同期のSKUマッチング失敗(根本原因を特定・修正済み)
- 症状: eBayで実際に売れている(管理番号260912-02、260618-03)のに、システム上は「出品中」のまま、売上未登録。`ebay_transaction_lines`には明細が取り込まれていたが`match_status='unmatched'`のままだった。
- **当初の推測は誤りだった**: SKU(Custom Label、`"260618-03 260630 2040-V2R1790513546"`のようにInventory API再出品由来の`-V2R<timestamp>`識別子付き)の形式問題だと推測したが、実際にはSKUの先頭9文字とitems.management_noは完全一致しており、マッチングロジック自体に問題は無かった。
- **真の原因**: `ebay-sync-orders` Edge Functionの`items`テーブル取得(`itemsByKey`の元データ)が`.range()`指定の無い単発`select()`だったため、Supabase(PostgREST)側のデフォルト上限(max-rows、既定1000件)で暗黙的に打ち切られていた。実測`items`全1230件のうち1000件を超えた分(該当2商品を含む)が`itemsByKey`に含まれず、商品自体は存在するのに「該当なし」として突合漏れになっていた。他のEdge Function(`ebay-listing-check`等)で既に修正済みの既知のパターンと同一原因。
- **修正**: `fetchAllItems()`でrangeベースのページネーションを行い、件数に関わらず全件を確実に取得するよう変更(version 13にデプロイ済み)。再同期テストで該当2件を含む5/5件が正しくmatched_pendingになることを確認済み。
- その場での暫定対応(修正版デプロイ前): `ebay_transaction_lines.matched_item_id`/`match_status`を手動UPDATE(psql直接接続、`SUPABASE_DB_*`環境変数を`.env`から使用)し、`matched_pending`にして該当itemへ紐付けたが、根本修正前は再同期のたびに`unmatched`へ巻き戻っていた(修正後は解消)。

### 補足: Supabase MCPツールの一時的な分類器エラー
- このセッション中、`mcp__05c17e31-...`(Supabase MCP)の`execute_sql`/`get_edge_function`等が「server-side auto mode classifierがno verdict」エラーで断続的に失敗する時間帯があった。フォールバックとして、VPSの`.env`にある`SUPABASE_DB_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD`を使い、VPS上から`psql`で直接Supabase Postgresに接続して調査・修正を続行した(読み取り・書き込みとも可能、MCPツールとは独立した経路)。

## セッション要点(2026-09-30〜10-01)

`/opt/ebay-automation`への機能追加・不具合修正を中心に実施(いずれもユーザーから直接名指しで依頼された例外対応)。camera-inventory-app本体への変更は無し。

### ebay-automation: Send Offer関連のダッシュボード改修
- ダッシュボード(v2)の各行、承認/却下ボタンの下に、その商品がSend Offer送信から96時間以内(`send_offer_eligible_items.offer_sent_at`基準)なら赤字で「Send Offer is valid」を表示。
- 一括承認(Best Match順位による一括承認・経過日数による一括承認)それぞれに「Send Offerから96時間以内のアイテムは除外する」チェックボックスを追加(`queue_bulk_approve_by_rank`/`queue_bulk_approve_by_elapsed_days`、対象IDを`target_id=not.in.(...)`でPATCHフィルタに追加)。
- レイアウト調整: フォントサイズ11px→13px、「Sold除外」「Send Offer除外」の2つのチェックボックスを縦並びに、一括承認フォームを「数量入力欄(1行目)」+「チェックボックス2行+一括承認ボタン(2行目、横並び)」の2段構成に整理。

### 「仕入額0円」の粗利計算バグ(ebay-automation): 調査の顛末と最終修正
- ユーザー報告(ItemID 287617356131、Soulcamera Item Info「260531-04 260930 0」)を受け、`_parse_original_purchase_cost()`(`webapp/app.py`)を調査。
- **当初の誤った修正(撤回済み)**: 「仕入額0円は実運用上あり得ず、データ未登録のプレースホルダーのはず」と誤って判断し、パース結果が0のとき空文字列(データ無し扱い)を返すよう変更してしまった。ユーザーから「仕入額が本当に0円ということはあり得ます」(無料入手品・景品等)と指摘を受け、この変更は撤回。0は文字通り0円として利益計算に使う(=原価を差し引かない)のが正しい挙動。
- **真の原因**: 当該商品はダッシュボードの「Soulcamera Item Info: ...」表示自体は`ebay_sell_similar_queue.sku`列(Item/SKU欄)の値を表示しているが、仕入額の抽出には別列`soulcamera_item_info`(GetItemのItem Specifics由来、未設定の出品も多い)を使っており、この商品はItem Specifics側が空だったため仕入額が一切抽出できていなかった(0円ではなく「データ無し」の状態)。
- **最終修正**: 新設の`_cost_source_value(soulcamera_item_info, sku)`フィルタで、Item Specifics(`soulcamera_item_info`)を最優先、無ければCustom Label(`sku`)にフォールバックする方式に変更。ただしV2(Inventory API)再出品による機械的な識別子(`-V2R`サフィックス付きSKU)は仕入額の出典として信頼できないため対象外とする(`get_soulcamera_item_info()`の既存ロジックと同じ理由)。対象: `dashboard_v2.html`・`listing_info_update.html`の計4箇所の`data-cost`属性。

### ebay-automation: 自動スキャン時刻変更時のリセット機能
- 症状: 設定画面(`/settings`)の自動再スキャン時刻(`scan_schedule_jst`)を当日中に変更しても、変更前の時刻で既にその日1回実行済みだと、`scripts/scheduled_scan.py`の「1日1回」ガード(`.scheduler_state.json`の`last_run_date`、日付単位でしか見ていない)により新しい時刻でもスキップされてしまっていた(実例: 16:00→20:00に変更したが20:00には実行されなかった)。
- 修正: `settings_save()`で保存前後の`scan_schedule_jst`を比較し、変更があった場合のみ`.scheduler_state.json`を削除(`_reset_scheduler_last_run_date()`)して本日分をやり直せるようにした。同じ時刻のまま再保存した場合はリセットしない(重複実行防止)。

### ebay-automation: 「終了品バックアップ」機能、Inventory API版(v2)への実装漏れを修正
- 症状: EndItemで旧出品を終了した後、新規出品の公開(publishOffer)が失敗したアイテムなのに「終了品バックアップ」一覧で「バックアップなし」と表示されていた。
- 原因: 2026-09-30に追加したバックアップ機能(EndItem直前に出品データ・画像を保存、失敗時はEndItem自体を中止)は`sell_similar.py`の`do_action()`(Trading API/AddFixedPriceItem版)にのみ実装されており、`sell_similar_v2.py`の`do_action_v2()`(Inventory API版、出品情報更新機能で使われる方)には呼び出しが漏れていた。
- 修正: `do_action_v2()`に`shop_id`引数を追加し、EndItem直前に`ss.backup_listing_before_end()`を呼び、失敗時はEndItem自体を中止するよう`do_action()`と同じ合意事項を適用。publishOffer失敗時・成功時の`update_backup_relist_result()`呼び出しも追加。呼び出し元3箇所(`run_v2`/`run_execute_approved_v2`/bulk-dry-run-report相当)に`shop_id`を渡すよう修正。この関数は常にサブプロセスとして起動されるため、webapp再起動不要(次回実行から反映)。

### ebay-automation: 「終了品バックアップ」一覧を直近1回の実行ジョブ分のみに限定
- 従来は`ebay_sell_similar_history`(shop_id・target_idの組でUPSERT、全期間の最新結果が累積)を無制限(直近300件)に一覧表示していたが、ユーザー要望により直近1回の実行ジョブの対象分のみに変更。
- 実装: `webapp/jobs.db`(SQLite、「実行ジョブ一覧」と同じデータ源)から、実際に出品の終了・作成を伴うジョブ(mode が`scan`/`dry_run`/`bulk_dry_run_report`で始まらないもの)を直近1件特定する`_latest_relisting_job()`を追加し、そのジョブの`started_at`〜`finished_at`の範囲で`ebay_sell_similar_history.action_at`を絞り込む(`ebay_sell_similar_history`自体にはどのジョブで記録されたかを示す列が無いための代替策)。画面上部に対象ジョブ(mode・開始〜終了時刻)を表示。

### 補足: eBay Seller Hub「Inactive」タブに終了出品が出ない件(Web検索で調査)
- ユーザー質問「アプリでEnd Listingした場合、なぜSeller HubのInactiveで見れないのか」についてWeb検索で調査。eBay Community上で広く報告されている既知の現象で、eBay公式も"ALERT17029"として終了・新規出品・再出品したアイテムがSeller Hubの想定セクションに正しく反映されない問題を調査中と報告されている。APIで終了した場合に限った仕様ではなく、UI上で手動終了した場合でも同様の報告が多数あり、eBay全体の同期処理の遅延・不具合による「limbo状態」(ActiveでもEnded/Unsold/Inactiveでもない一時的な未分類状態)が原因と見られる。だからこそ「終了品バックアップ」機能がSeller Hub側の表示に頼れない場合の実質的なセーフティネットとして機能する。

### Windows側SSH鍵の正確なパス(訂正)
- `vps_key_openssh.key`は本セッションのプロジェクトフォルダ(`C:\Users\straw\projects\camera-inventory-app`)内には無く、実際には`C:\Users\straw\vps_key_openssh.key`に配置されている。ユーザーがプロジェクトフォルダから相対パスでssh実行し「Identity file not accessible」で失敗する事例が発生したため、デプロイコマンドを案内する際は必ずフルパス(`C:\Users\straw\vps_key_openssh.key`)を使うこと。
- 同じACL問題(`LENOVO-L13\CodexSandboxUsers`の余分な権限)が`C:\Users\straw\vps_key_openssh.key`本体でも再発した。`icacls`での修正はClaude自身がPowerShellツール経由で実行可能(ローカルの自分の鍵ファイルのACL調整は低リスク)。ただし一度直しても再発することがあり(原因不明、サンドボックス機構側の挙動の可能性)、ユーザーが同じエラーに遭遇したら都度`icacls`で再確認・再修正すること。

## セッション要点(2026-10-01、続き)

### camera-inventory-app: 利益簡易計算モーダルのPromoted Listings General入札率が出品タブに反映されない不具合を修正
- 症状: 出品タブの「利益簡易計算」モーダルで「Promo Listing(General広告料率)」を入力・「変更値を元画面に反映する」を押しても、出品タブ本体の「Promote listing - General」欄に反映されない。
- 原因: `ProfitCalcModal.tsx`の`promo`stateは常に`DEFAULTS.promo`(0%)で初期化され、`onApply(priceUsd, shippingUsd)`も商品本体価格・送料しか呼び出し元へ返しておらず、出品タブの`promotedGeneralRate`stateと双方向とも完全に無関係だった。
- 修正: `ProfitCalcModal`に`initialPromoRate`propを追加(開いた時点の値を引き継ぐ)、`onApply`のシグネチャを`(priceUsd, shippingUsd, promoRate)`に拡張。`ListingTab.tsx`側で`promotedGeneralRate`をモーダルに渡し、Apply時に`setPromotedGeneralRate`へ反映。ビルド(型チェック込み)・デプロイ・commit/push済み。

### ebay-automation: 「出品情報更新」画面に「個別指定」検索機能を新設
- 要望: 「View数・Watch数を取得」の上に、ItemIDをテキストボックスで指定して「検索」ボタンを押すと、見つかった場合に一覧表示と同じ内容をそのアイテム1件分だけ表示する機能。
- 当初案(承認キュー`ebay_sell_similar_queue`内のみを検索)をまず実装したが、ユーザーが実際に試したところ候補条件(未売却・一定日数経過等)を満たさないItemID(例: 287618468836)は「見つかりませんでした」になった。ユーザーに確認したところ、候補条件に関わらずeBayから直接取得して表示する仕様が望ましいとのことで拡張。
- 実装: `sell_similar.py`に`fetch_and_register_single_item(shop_id, auth, target_id)`を新設(`run_scan()`の1件分の処理内容を流用、GetItem→価格/送料→Best Match順位→相場→Promoted Listings状態→Soulcamera Item Info取得→`upsert_queue_pending()`)。`upsert_queue_pending()`に`status`引数(既定`'pending'`)を追加し、この用途では`status='manual_lookup'`で登録する。Sell Similar本体の承認キュー一覧(`_fetch_pending_queue()`、`status=in.(pending,rejected,approved,failed)`のみ取得)には`manual_lookup`行は一切出てこないため、ダッシュボード側の承認フロー(誤って既存出品をEnd Listingしてしまうリスク)には影響しない。
- `listing_info_update()`ルート: `target_id`クエリパラメータ指定時、まずキャッシュ(承認キュー)を検索し、無ければ上記関数でeBayから取得・登録してから再取得して表示。ItemID形式不正・GetItem失敗時はそれぞれエラーメッセージを表示。
- `webapp/app.py`(Flask本体)の変更のため、反映には`systemctl restart`が必要(sell_similar.py側は各リクエストで`importlib.reload(ss)`されるため本来再起動不要だが、呼び出し元のapp.py自体が変更されているため結局再起動要)。

## セッション要点(2026-10-01〜10-02、続き)

### camera-inventory-app: 「送料設定早見表」機能を新設
- 「送料登録」タブを「送料」に改名。タブ内の送料登録UI(CPaSS/eLogi取込)の**上**に新セクション「送料設定早見表」を追加。
- ユーザー提供のエクセル(CPaSS実績242行、列: ブランド・機種名・Shipping Service・Service Type・Incoterms・Package Type・寸法1〜3・重量・支払額(JPY)・関税VAT等・配送先国・Ship to)をSupabaseの新規テーブル`shipping_rate_reference`に全件登録(RLSは他テーブルと同じ「authenticated users full access」パターン)。
- ブランド→機種名→…→重量まで10項目を順にプルダウンで絞り込み、支払額(K列)にたどり着く「早見表」UIと、同データを画面上で行ごとに追加・編集・削除できる「データの追加・編集」(折りたたみ)UIの両方を実装(`ShippingRateLookupPanel.tsx`/`shippingRateReference.ts`)。追加・編集インタフェースは、早見表機能実装後にユーザーから改めて要望されたもの。
- ユーザー要望で列幅を複数回調整: 機種名列は表示側max-width(ellipsis+ホバーで全文)・編集入力欄幅・早見表プルダウン幅すべてを段階的に縮小(最終的に初期値の60%)。長い機種名でテーブル全体が画面からはみ出す問題への対応。

### camera-inventory-app: 「入荷アラート」機能を新設
- メニュー名「在庫アラート」→「入荷・在庫アラート」に変更。既存の在庫アラート表示の上に「入荷アラート」セクションを新設(`ArrivalAlertPanel.tsx`)。
- ステータス「入荷待ち」(`awaiting_arrival`)で、アイテム登録日(`items.created_at`)からn日以上経過している商品を、アカウント・管理番号・仕入品名(`items.title`)・仕入先/出品者名(`purchases.source_name`)・購入元URL(「購入サイトでみる」ボタン、`purchases.source_url`)・仕入高(`purchases.purchase_price`)・経過日数で一覧表示。該当件数がある場合は赤枠バナーで警告。
- n日のしきい値はテキストボックス+「設定」ボタンで変更可能(初期値5、新規テーブル`arrival_alert_settings`の単一行に保存、`purchase_memo`と同じ単一行upsertパターン)。
- 「仕入・在庫・販売画面で見る」ボタンで、詳細編集タブをステータス=入荷待ちで絞り込んだ状態に遷移する機能を新設。**このアプリにはReact Routerが入っておらず**、タブ切替は`App.tsx`のローカルstateのみで行っているため、ページ間でのプリセットフィルタの受け渡しは前例が無かった。`App.tsx`に`pendingInventoryFilters` stateを新設し、`StockAlertsPage`→`App.tsx`→`InventoryPage`(新規props `initialFilters`/`onInitialFiltersConsumed`)という形で親経由で受け渡す設計にした。
- **修正済みの不具合**: 上記遷移直後、`filters` stateを`useEffect`内で事後的に`setFilters(initialFilters)`していたため、マウント直後に走る「フィルタ無し(全件)」の初回取得と、フィルタ適用後の取得が非同期で競合し、全件取得のレスポンスが後から返ってきて絞り込み結果を上書きしてしまうレースコンディションがあった(画面上は絞り込みドロップダウンは「入荷待ち」のままなのに一覧は全件表示、という不具合として現れた)。`useState`のlazy initializerで`initialFilters`をマウント時点から直接適用するよう修正して解消。
- 「在庫アラート」セクション自体にも見出し(`<h3>在庫アラート</h3>`)を追加(入荷アラートと2セクション構成になったため)。

### ebay-automation: Send Offer関連の機能追加・不具合修正(ユーザーから直接名指しで依頼された例外対応)
- ダッシュボードの「Send Offer is valid」表示の下に、送信から96時間後の期限までの残り時間を「残り H:MM:SS」形式で1秒ごとに更新表示するカウントダウンを追加(`send_offer_deadline_iso`をサーバー側で計算しテンプレートに渡し、クライアント側JSの`setInterval`で表示を更新)。
- **「終了品バックアップ」の警告は誤検知ではなく正確だった事案**: ユーザーから「ItemID 287612025268は終了済みだが新規出品の公開に失敗(400 Bad Request)」という警告について「新規出品できているのでは?」と質問を受け調査。実際には該当オファー(`287893100011`)は`UNPUBLISHED`のまま一度も公開されておらず、約23時間出品ゼロの状態だった(その後、別の後発の再出品サイクルで別のオファー経由で復旧)。eBayが返した実際のエラー本文は、例外の`str(e)`(400のステータス行のみ)しかログに残しておらず、`do_action_v2()`内で`e.response.text`を取得していなかったため、根本原因(どのAspect不足で400になったか等)は事後的に特定不能だった。
- **Send Offerの重大な価格計算バグを発見・修正**: ユーザーが実際にオファー送信に失敗した際のエラー「Price must be at least 5.0% less than your Buy It Now price.」を報告。調査の結果、割引後価格の計算(`webapp/app.py`の`send_offer_send()`)が`round()`(最近接丸め)を使っていたため、価格の端数次第で「5%以上値引き」という閾値をわずかに超えて切り上がってしまうケースが、$20.00〜$1000.00の全価格帯で検証した結果**約46%の確率**で発生していたと判明(コイントスに近い確率で、商品の現在価格の端数次第で毎回起こり得るバグだった)。`Decimal`+`ROUND_DOWN`(必ず切り捨て)に変更し、98,000通りの価格で検証して失敗ゼロを確認。`send_offers.html`側のJSプレビュー(`soRenderPrice()`/`soComputeEstimate()`)も同じロジック(`Math.floor(v*100+1e-7)/100`)に統一し、画面表示と実際の送信価格が常に一致するよう修正。副次的に、失敗時のフラッシュメッセージに対象商品名を含めるよう改善(複数カード表示時にどの商品の失敗か分かるように)。

## セッション要点(2026-10-02〜10-03)

### インフラ: `biz.soulmen.net`をHTTPS化(Caddy + Let's Encrypt無料証明書)
- 経緯: `133.18.147.130`(KAGOYA VPS)にドメイン`biz.soulmen.net`を設定済み(DNS解決済み)。plain HTTPの`:8080`アクセスを、無料証明書付きのHTTPSにしたいという依頼。
- 構成: `Caddy(:443、TLS終端) → 127.0.0.1:8080(既存nginx、camera-inventory-app+/marketing/、無変更)`。ufwに`443/tcp`を追加、Caddyはaptで導入(Ubuntu 24.04標準の2.6.2)。
- **port 80はnginxの`default_server`(無関係の別サイト、`server_name _`)が既に使用中のため、Caddyにはport 80を一切触らせない設計にした**。`/etc/caddy/Caddyfile`:
  ```
  {
      email shopmaster@soulmen.net
      auto_https disable_redirects
  }
  biz.soulmen.net {
      tls {
          issuer acme {
              disable_http_challenge
          }
      }
      reverse_proxy 127.0.0.1:8080
  }
  ```
  `disable_http_challenge`でHTTP-01(port 80必須)を無効にしてTLS-ALPN-01(port 443のみで完結)に絞り、`auto_https disable_redirects`でCaddyが自動でport 80の待受(HTTP→HTTPSリダイレクト)を作るのも止めている。どちらか片方だけだと`bind: address already in use`でCaddyが起動に失敗する(デフォルトのCaddyfileでも実際にそうなった)。元のCaddyfileは`Caddyfile.bak-default-20261002`。証明書の更新はCaddyが自動で行う(cron等は不要)。ログは`journalctl -u caddy`。
- **アクセス方法**: `https://biz.soulmen.net`(ポート番号なし)。`biz.soulmen.net:8080`のように`:8080`を付けると、Chromeが`https://`を自動補完して8080(TLS非対応のplain HTTP)へTLS接続を試み、`ERR_SSL_PROTOCOL_ERROR`になる。ブックマークは`:8080`を外すこと。
- 既知の残課題: `http://biz.soulmen.net`(port 80)は、引き続き既存の別サイト(`default_server`)が応答する(ホスト名で振り分けていないため)。必要になれば、`server_name biz.soulmen.net`のnginx vhostを別ファイルで追加して`/.well-known/acme-challenge/`以外を`https://`へリダイレクトする方針が考えられる(既存のdefault設定は変更しない)。

### camera-inventory-app: 「送料設定早見表」の改善(`ShippingRateLookupPanel.tsx`)
- 絞り込み(プルダウン)を大文字・小文字非区別に変更: 元データが"Canon"/"CANON"のように表記ゆれしているため。選択肢は小文字キーで重複排除(表示は最初に見つかった表記)し、一致判定も小文字比較(数値列は対象外)。
- 「データの追加・編集」の新規行追加・編集時、テキスト列を`<datalist>`の候補プルダウンから選べるように(自由入力も可)。`<datalist>`は行ごとではなくフィールドごとに1回だけ描画する(DOMのid重複を避けるため)。
- ブランド+機種名の2つを選んだ時点で、該当N件の上に「寸法1×2×3(cm) / 重量(kg)」を表示(ラベル太字・寸法`var(--accent)`青・`/`黒・重量`var(--danger-text)`赤、同一ブランド・機種名で組み合わせが複数あれば重複排除して全列挙)。
- 該当N件リスト: 支払額の右に「実質送料(円)」(=支払額−関税VAT等、関税未登録は0扱い)、続けて関税VAT等・寸法・重量・Shipping Service・Package Type・Incoterms・配送先国を表示(該当1件時はインライン、複数件時はテーブル列)。**支払額の昇順**で表示(未登録は末尾)、10件分の高さでスクロール(ヘッダー固定)。

### camera-inventory-app: 出品タブのItem Specificsに「Soulcamera Item Info」追加ボタン(`ListingTab.tsx`)
- 表示中のItem Specificsに「Soulcamera Item Info」が無い場合のみ、未設定の警告・追加ボタン・追加される値のプレビューを表示(自動追加ではなくボタン方式)。値は検品タブの「生成データ保存」で下書きに保存済みの`soulcamera_item_info`を優先し、無ければ`generateSoulcameraItemInfo(item)`(管理番号 今日の日付YYMMDD 仕入高)で生成。
- 用語メモ: ユーザーが言う「すっぴん画面」はコード内に出てこない呼称。確認の結果、出品タブのことだった(不明な呼称は推測せず、候補を挙げて確認すること)。

### ebay-automation: 「終了品バックアップ」関連の修正・機能追加
- **「バックアップ済み」なのに一覧が「バックアップなし」になる不具合**: 前回(10-01)追加したInventory API版(`do_action_v2()`)のバックアップ結果`backup_id`が、呼び出し元4箇所(`run_v2`/`run_execute_approved_v2`の成功・失敗)で`record_history`のdetailに埋め込まれていなかったため。4箇所を修正。修正前の履歴向けに、一覧画面で`old_item_id`一致かつ実行日時より前で最新のバックアップを補完して引き当てる処理も追加(日時はdatetimeとして比較)。
- 詳細画面: 説明文(HTML)が空だった原因は、`raw_item_xml`が`GetItemResponse`全体のため`Description`が直下ではなく`Item/Description`にあるのに直下を探していたこと(Item Specificsは`.iter()`で再帰検索していたため取得できていた)。XML表示が読めなかった原因は、グローバルの`pre`が「濃紺背景+薄い文字」なのにこの画面だけ背景を薄いグレーに上書きしていたこと(文字色`#1f2937`を明示)。
- 説明文(HTML)の上に「出品内容」表を追加: Item title / Condition description / Item price(`StartPrice`) / Shipping policy(`SellerShippingProfile/ShippingProfileName`)、およびPromoted listing General(入札率%または未登録)・Priority(ON/OFF)。**Promoted Listingsの設定はGetItemのXMLに含まれずEndItemで出品が終了すると取れなくなる**ため、`ebay_end_listing_backups`に列`promoted_general_bid_percentage`(text)・`promoted_priority_enabled`(boolean)を追加(NULL許可)し、`backup_listing_before_end()`がEndItem直前に取得済みの値(`do_action`/`do_action_v2`の`promotion`/`priority_status`)を記録する。記録開始前の既存バックアップ(51件)は、承認キューのスキャン時点の値で補完して表示し、画面に「直近スキャン時点の値」と注記する(`promoted_priority_enabled`が非NULLなら記録済み、NULLなら補完、という判定)。
- 画像のZIPダウンロード: 詳細画面の画像見出し横のボタン、ルート`/end-listing-backups/<id>/images.zip`(Storage上の画像をサーバー側で並列取得し、`01.jpg`…の連番で格納、ZIP名は`<管理番号>_images.zip`)。1枚でも取得に失敗したらエラーにして欠けたZIPは渡さない。
- **7日で自動削除**: `scripts/cleanup_end_listing_backups.py`+systemd `ebay-automation-cleanup-backups.timer`(毎日04:10 JST)。作成日時(`created_at`)から7日超の行について、**Storageの画像を先に削除→成功した場合のみDB行を削除**(失敗した行は残して次回再試行、画像だけが残る孤児を作らない)。`--dry-run`(対象のみ表示)・`--days N`あり、1回100件上限、ログは`webapp/logs/cleanup_backups.log`。**再出品に失敗した(`failed`)バックアップも7日で削除される**点に注意(復旧用の唯一の控えになり得るため、必要なら除外条件を追加する)。削除直後でも公開URLが200を返すことがあるが、CDNキャッシュ(`cf-cache-status: HIT`)で、Storage自体からは削除済み(Storageの一覧API・認証付き取得で確認)。

### ebay-automation: ダッシュボード/オファの改善
- 「Send offers」(オファ)画面の並び順を、新しく対象になった順(`first_seen_at`降順)に変更(従来は古い順)。
- **一括承認(Best Match順位/経過日数)で、編集した価格・送料・General入札率・Priorityが元に戻る不具合**: 一括承認は`status`をPATCHするだけで、行ごとの入力欄(別フォーム`form-<id>`に属する)の編集内容を一切送信・保存していなかったため、再読込でDBの値に戻っていた。修正: 一括承認フォームの送信直前に、現在値から変更のあった項目だけを`ov_price__<行id>`等の隠しフィールドとして添付(JS `bulkAttachOverrides()`)、サーバー側`_apply_bulk_overrides()`が承認された行にだけ上書き値として保存する。**承認されなかった行(条件に合わない行)の編集値は保存しない**(従来どおり戻る)。

### ebay-automation: eBay売上の自動登録で、his50sへの「売れた」通知が漏れていた(重要)
- 症状: 「出品チェック」に「売却済みなのにhis50sで公開中のまま(通知の取りこぼし)」が3件(260531-04/260614-10/260616-03)。ユーザー報告は「eBayで売れたのに同期されていません」。
- 原因: `scripts/ebay_sales_sync.py`(20分おきの売上自動登録、2026-09-07〜)の`_mark_item_sold_best_effort()`は、`createSale()`の副作用(商品を`sold`に更新・Driveフォルダ移動)を再現していたが、`createSale()`に9/15に追加された`notify-his50s-sold`の呼び出しが抜けていた。9/28の対応(`createSale()`のawait化等)は手動登録経路のみで、この自動登録経路は未対応だった。見分け方: 該当`sales`の`created_at`が同期の実行時刻ちょうど(:00/:20/:40の07〜08秒)で、`ebay_transaction_line_id`が付いている。
- 修正: 自動登録時に同じ順序(sold更新で`management_no`を取得 → Drive移動 → `notify-his50s-sold`呼び出し、`_notify_his50s_sold_best_effort()`)で通知。失敗しても売上登録は成功扱い(取りこぼしは「出品チェック」の再送信で復旧可能)。HTTP呼び出しをモックして呼び出し順・失敗時に例外が出ないこと・管理番号が取れない場合のスキップを検証。再起動不要(次回の自動同期から有効)。
- 3件は「再送信」と同じ処理(同Edge Functionを呼び出し)で救済、3件とも`notified`、再チェックで取りこぼし0件(his50s公開中129→126件)。
- 教訓: 副作用を「再現」している別経路は、元の処理に副作用を足したときに追従漏れが起きる。`createSale()`に副作用を追加するときは`ebay_sales_sync.py`側も確認すること。

### 調査メモ: 再出品直後の商品が「対象を再スキャン」前の一覧に出ない(不具合ではない)
- ユーザー報告「再スキャンで[Near MINT++] Pentax Espio 120SW…が表示されない」。調査の結果、再出品でItemIDが変わる(旧287620273773→新287622268231)ため、再出品後に一度もスキャンされていない新ItemIDは承認キューに行が無く、ダッシュボードに出ないだけだった。直近のスキャン(20:00 JSTの定期スキャン)は再出品(00:26 JST)より前に終了していた。再出品された28件がまとめて未表示だった(ダッシュボードの30件との差が一致)。
- 確認方法: `webapp/jobs.db`の`jobs`テーブルで、再出品ジョブ(`execute_approved_v2`)より後に`scan`/`scan_v3`が開始されているか(実行中ジョブも含めて)。読み取り専用で`ss.fetch_targets_fast(auth, force_item_ids=[])`を呼べば、再スキャンで拾われるかを書き込み無しで確認できる(今回は58件、対象に含まれた)。対応は「対象を再スキャン(高速版)」の実行。スキャンは既存の承認待ち・失敗の行を承認待ちに戻す仕様。

### 運用メモ(このセッションで判明)
- Windows側SSH鍵ACLの`CodexSandboxUsers`問題は、このセッションでも再発(合計3回)。Claudeの`PowerShell`ツールで鍵ファイルのACLを確認した後に再付与される傾向があるため、`icacls`で修正した直後は、同じツールで鍵ファイルに触れずにユーザーへ実行を依頼すること。
- `ssh-vps-manager`の`run_command`は、`sleep`を長めに含む(目安として数十秒以上の)コマンドや、出力が空で終了コードが非0になるコマンド(`grep -v`で全行が除外された場合など)が、`Error:`だけを返すことがある。数十秒以上かかる処理は`nohup ... > /tmp/x.out &`でバックグラウンド実行し、短いコマンドで出力ファイルを読む方式にすること。

## セッション要点(2026-10-03〜10-04)

### camera-inventory-app
- **送料の相違レポート(CPaSS/eLogi請求明細 ↔ 販売済みの登録送料)**: 「レポート取込」の「eLogi送料CSV取込」「CPaSS請求明細取込」各パネル内に`ShippingReconcileSection.tsx`を組み込み(`shippingReconcileCore.ts`・`api/shippingReconcile.ts`)。ファイル選択で自動照合し、相違を一覧表示→チェックした行を請求額で上書き。CPaSSの「order no」は追跡番号(28文字、EM/EX/EE…)で、1注文の請求額=全明細(負の調整含む)の合計。分類は`under`(登録額<請求額、初期チェック対象)/`over`(登録額>請求額)/`shared`(1請求に複数売上が紐付き按分不可、上書き対象外)。**`over`は盲目的に上書きしない**(登録額はCPaSSの「EST. SHIPPING FEE」由来で関税・VAT込みの可能性があり、実測169件・344,282円がこれ)。上書きは「画面表示時の登録額と同じ場合だけ」更新する楽観ロック(`eq("shipping_cost_paid", registeredRaw)`)。`sales.gross_profit_jpy`等はGENERATED列のため、`shipping_cost_paid`更新で粗利も自動再計算される。
- **データ作成画面**: 「利益管理票更新用データの作成」(`EbayXlsxFillPanel`)を「直販プラットフォーム登録用CSV作成」と2段横並び(左)に移動。各パネルの背景色を利益管理票のものに統一。
- **送料登録の「eLogiファイル選択」を購入者ID(username)突合に変更**(`cpassShipping.ts`、コミット b747e5c・ec6744b): `ebay_transaction_lines.buyer_username`(ilike、大文字小文字非区別、`_`等のLIKE特殊文字はエスケープ必須)が一致し`matched_item_id`がある行を探す。CPaSSは従来どおりオーダー番号。CSVは「発送済一覧」(追跡番号・eBayオーダー番号・初回請求金額+追加請求/返金金額・購入者ID)と「発送を完了する一覧」(請求書ID/ラベル印刷日/追跡番号/購入者ID/請求金額…、オーダー番号列なし、送料=請求金額)の両方可。同一購入者が複数商品に一致する場合は オーダー番号→販売済み→追跡番号未登録 の順に絞り、決まらなければ`ambiguous`でスキップ(誤上書き防止)。**注意**: `buyer_username`が入っているのは商品突合済み91行中55行のみ(売上自動同期由来の新しい行)。突合差分レポート(`parseElogiCsv`をオプション無しで呼ぶ側)は従来の「発送済一覧」のみ対応のまま。
- **Google Driveの権限事故**: ユーザーがDriveの共有設定を変更したため`drive-folder-info`等が404になった(404は本当に「共有されていない」意味で、不安定さの問題ではない)。共有者として指定する名前=サービスアカウント`camera-inventory-drive-bot@camera-inventory-drive.iam.gserviceaccount.com`(Supabase secretsのDrive鍵)。ルートフォルダ例: `1Gz8DjNr5pYWr1y6utpJDtoXSEdG-tYVr`。スコープは`drive-folder-info`/`sync-drive-stock-counts`が`drive.readonly`、`move-drive-folder`のみ`drive`(書込)。移動時にDriveが一時的に503を返すことがあり、再試行で成功する。`tmp-show-sa-email`はMCPから削除できないため410を返すスタブに上書きしてある。

### ebay-automation(いずれもユーザーから直接名指しで依頼された例外対応、commit運用なし、変更前は`.bak-pre-<スラッグ>-20261004`)
- **ダッシュボード(/v2)**: (1)承認/却下等の行操作後にスクロール位置を維持(`dashboardV2ScrollRestore`、flashは固定トースト化)。(2)一括承認の3カードを1カード「一括承認」に統合(ラジオで方式選択、共通の除外チェック2つ+ボタン)。入口は`POST /queue/bulk-approve`(`queue_bulk_approve_unified`)が既存の3ハンドラ(`rank`/`elapsed`/`original`)に振り分ける。新方式「初出品からの経過日数」(`queue_bulk_approve_by_original_days`)は、`soulcamera_item_info`の11〜16桁(YYMMDD)をPythonで計算(UTC日付、一覧の「初出品からの経過日数」列と同じ)、**初出品日を判定できない行は対象外**で件数をflash表示(従来の「経過日数」方式は日付不明も含む)。(3)レイアウト: `[一括承認 | (Dry Runレポート / 一括リセット+承認済みを実行を縦積み)]`、その下に「View数・Watch数を取得」を2列分の幅で1段表示。「一括確定(ショートカット)」は削除。(4)一覧の列順: 商品→出品日/経過日数/初出品から→Best Match順位→Views・Watches・表示回数(縦積み)→クリック率→診断→本体価格→送料→General広告料率→Priority→操作(「ジョブ実行時刻」「販売数」列は削除/非表示)。
- **View/Watch/表示回数・クリック率・診断(ダッシュボードと「出品情報更新」で共通)**:
  - Watch数=`GetMyeBaySelling`(ActiveList)全ページ(WatchCountは0だと省略→0扱い)、30日のViews/表示回数/販売数/CTR=Analytics API `getTrafficReport`(`dimension=LISTING`、`listing_ids`最大200件/回)。スキャン完了時(`run_scan`末尾)と、画面の「View数(30日間)・Watch数を更新」ボタン(`POST /queue/refresh-traffic`、`return_to`で戻り先指定)で`refresh_queue_traffic_metrics()`が更新。キューの列: `views_30d`/`impressions_30d`/`transactions_30d`/`ctr_30d`/`watch_count`/`traffic_checked_at`。
  - **APIの癖**: 返るメトリクスの並びはリクエスト順ではなくレスポンス`header.metrics[].key`の順(必ずkeyで対応付ける)。応答に載らない出品=期間内の記録なし(0扱い、ただし「本当に0」と「データなし」は区別不能)。eBayの集計日は米国太平洋時間で、確定済みの最新日=PTの「昨日」(`ebay_traffic_latest_complete_date()`)。`DAY`次元は`listing_ids`を無視する(アカウント全体)。CTRは小数2桁に丸められて返る。
  - **Analytics APIは1日100回**(リセット=07:00Z=16:00 JST)。日別Impressions(スキャンごと1回)・キュー更新(1回)・日次保存と共有。**`getRateLimits`の残り回数は呼び出し直後には減らず遅れて反映される**。
  - **日次の日別保存**: テーブル`ebay_listing_traffic_daily`(shop_id,item_id,date,`item_key`,impressions,views,transactions)と`ebay_traffic_fetch_days`(取得済み日の記録)。`item_key`=SKU先頭トークン(=管理番号)、`V2R`を含む機械的SKUや空は`item:<ItemID>`。再出品でItemIDが変わっても同一商品として連結される。`scripts/traffic_daily_sync.py`(systemd `ebay-automation-traffic-daily.timer`、**毎日16:30 JST**、ログ`webapp/logs/traffic_daily.log`)が直近2日の取り直し+30日分の未取得日バックフィル。**予算は実行開始時に1回だけ「min(上限60, その時点の残り−予備15)」で決め、自分で数えた回数で打ち切り、429が出たら全体を中断**。⚠️初回(10/4 10:30)は日ごとに残り回数を再取得する作りで、表示の遅れのせいで枠を使い切り429が発生した(上記の予算方式に修正済み、実行時刻も枠リセット直後の16:30に変更)。バックフィルで取れるのは**現在のItemIDの履歴のみ**(再出品前の旧IDは取得不可)。10/4時点で9/4〜10/3の30日分が揃った。
  - **画面**: Viewsと表示回数に矢印(直近7日 vs その前の7日、±20%で▲/▼、前7日の記録なしは「–比較なし」)。表示回数の下に日別スパークライン(クリックで30日グラフ、未取得日は灰色)。診断ラベル(閾値は仮): 表示ほぼ0(30日の表示<50)/表示多・閲覧少(表示≥300かつCTR<1%)/閲覧多・未販売(Views≥30かつ販売0)/販売あり/標準。
- **ツール(旧「カテゴリ書換」、`/store-category`)**: メニュー名を「ツール」に変更。ページを開いただけでは一覧を読み込まず、「最新の状態に再読み込み」(`?load=1`)でのみ読み込む。US Active Listing一覧は同カード内、「リストを畳む」ボタン付き。**メッセージ履歴**: Username入力→過去のメッセージをExcel(A送信日・B送信時刻(JST)・C発信者・D内容、古い順)でダウンロード(`scripts/ebay_messages.py`、Trading API `GetMyMessages`)。**`StartTime`/`EndTime`を指定しないと直近約90日分しか返らない**(受信箱905件中496件のみ)ため364日分を明示。受信箱の`Sender`/送信箱の`SendToName`で絞り込み、本文は`<div id="UserInputtedText">`の中身(Textは25〜50KBのメールHTML)。発信者が「eBay」の自動通知は対象外。Excel作成用に`openpyxl`をWebアプリのvenvへ追加(requirements.txtは無い)。
- **ジョブ詳細**: 失敗した商品に「終了品バックアップへ」ボタン(`_failed_item_backup_map()`が旧ItemID→最新バックアップIDを引き、無ければ一覧ページへ)。
- **調査メモ**: (1)Sold(在庫切れ休止)表示は`is_sold_out`のスキャン時スナップショットで、スキャン後は更新されない。287623902508が実際はQty=1・売却0なのにSold表示だった件は、スキャン時のGetItem応答(在庫数)を保存していないため原因不明(該当1行のフラグだけ手動で直した)。再発に備えスキャン時の在庫数・売却数を保存する案は未実装。(2)自動再スキャン(20:00 JST)は直近12日間毎日定刻に実行されていた(約15分で完了、`scripts/.scheduler_state.json`)。`jobs.finished_at`は「誰かがダッシュボードを開いた時刻」で遅れるため、実際の完了は`log_finished_at`を見ること。**潜在リスク**: `scripts/scheduled_scan.py`の`_running_job()`は完了判定をしないので、前回ジョブが「実行中」のまま(ダッシュボード未表示)だと翌日の自動実行が見送られ続けうる(未修正、修正案=ログの終了マーカー/PID消滅を見て無視する)。

### 運用メモ(このセッションで判明)
- Windows側SSH鍵のACL問題(`LENOVO-L13\CodexSandboxUsers`)はさらに再発(累計5回前後)。`PowerShell`ツールの`cmd /c icacls`で直した後は、同じツールで鍵に触れずにユーザーへ実行を依頼する。
- VPSでの確認コマンド: `sqlite3`のCLIは無い(`python3`の`sqlite3`モジュールを使う)。`node`は`/usr/bin/node`(`python3`のsubprocess経由のbashではPATHに無いことがある)。DDLやマイグレーションはMCPではなく、`.env`の`SUPABASE_DB_*`+`psql`で実行できる。
- eBay/Analyticsの日次枠や`getRateLimits`のように「呼び出し直後に反映されない残り回数」を判定に使う場合は、開始時に1回だけ読んで自前でカウントする。

## セッション要点(2026-10-05〜10-07)

### camera-inventory-app(コミット 8503fb4)
- **検品タブ**: 「Description生成へ」ボタンを、タブ行右端(`ItemDetailPane.tsx`)から、検品タブの「登録済みアイテムからオートフィル」行の右端(`InspectionTab.tsx`)へ移動。押すとDescription生成セクションへスクロールするのは同じだが、`InspectionTab`内で`descriptionSectionRef.scrollIntoView`を直接呼ぶ形にし、親の`descriptionScrollTrigger`state・`scrollToDescriptionTrigger`propは削除した。**副作用: ボタンは検品タブでしか押せなくなった**(以前は他タブからも検品タブへ飛べた)。
- **出品タブ**: 「写真(n/24)」「画像保管フォルダを開く」の行の右端に「出品へ」ボタンを追加。押すと画面の最後(出品ボタン・結果表示)へスクロール(ルート要素末尾の`bottomRef`に`scrollIntoView`)。

### ebay-automation(いずれもユーザーから直接名指しで依頼された例外対応、commit運用なし、変更前は`.bak-pre-<スラッグ>-2026100x`)
- **ダッシュボード(/v2)**: 画面下部の「直近のジョブ実行履歴」カードを、「対象を再スキャン(高速版)」の横の「直近のジョブ実行履歴」ボタンから開くモーダル(`jobHistoryModal`、閉じる/背景クリック/Escで閉じる)へ移設。モーダル最大幅は既存の順位推移モーダルの1224pxを基準に140%の1714px(ユーザー指定「120%」→「140%」、基準は常に元の1224px)。**旧ダッシュボード(`/`、`dashboard.html`)は未変更**。ナビの「ダッシュボード」は`/v2`。
- **一括承認「Send Offerの除外」をプルダウン化し、基準を「残り時間」に変更**: 当初は「Send Offerから96時間以内を除外」の96をプルダウン(96〜16、10刻み)にしたが、ユーザーの意図は「Offerの残り時間」基準だった。最終仕様は**「Send Offerの残り時間が[N]時間以上のアイテムは除外する」**(Nは96,86,…,16)。残り時間=96−送信後の経過時間(96=`SEND_OFFER_VALID_HOURS`=`SEND_OFFER_DURATION_DAYS`4日)。残りがN時間未満(送っていない・期限切れを含む)は承認対象、N以上は対象外(ちょうどNも対象外)。実装は`_send_offer_exclude_hours()`が選択値Nを「経過時間の窓=96−N」へ換算して`_fetch_send_offer_valid_target_ids(..., hours=窓)`へ渡す(フォームに値が無い旧画面・選択肢外はNone=従来どおり96時間以内をすべて除外)。**注意**: `hours or 既定値`と書くと窓0(N=96)が既定の96に化けるため、`is None`で判定すること。N=96は実質「除外なし」、N=16が従来の「全部除外」に最も近い。チェックボックス「除外する」を外すとプルダウンは使われない。
- **Views/Watches更新ボタンの移設**: 「View数(30日間)・Watch数を更新」ボタンを、一覧表題行の「表示回数(30日間)」の下へ移し、表記を「Views/Watches更新」に変更(ダッシュボード/v2と「出品情報更新」の両方)。ダッシュボードはヘッダー内に独立した`<form>`、「出品情報更新」は一覧全体が1つの`<form id="update-form">`のためネスト不可で、既存の「相場を更新」と同じ`formaction`+`name="return_to"`方式(`window.__liuSkipConfirm`で確認ダイアログを抑止)。上部カードの説明文も書き換え、貼り付け取得(別方法)はカードに残した。
- **View/Watchの取得タイミング**: 通常版・高速版のどちらのスキャンでも、`run_scan()`末尾(承認キューの整理後)の`refresh_queue_traffic_metrics()`で一括取得・保存する(高速版は`run_scan(use_fast_scan=True)`を呼ぶだけ)。失敗してもスキャンは継続、画面の値は前回のまま。画面のボタンでスキャン無しにも更新できる。
- **View/Watch更新メッセージに1日の残り回数を表示**: 「GetMyeBaySelling n回(1日の残りx回)・Analytics m回(1日の残りy回)」。`get_quota_snapshot()`が`getRateLimits`1回でTradingAPI `GetMyeBaySelling`(5000回/日、他のTrading API呼び出しと共通のカウンタ)と`sell.analytics.traffic_report`(100回/日)の残りを取得。値は**呼び出し前の残り−今回の呼び出し回数**を表示(`getRateLimits`は呼び出し直後に減らないため)。取得不能は「不明」。枠のリセットは07:00Z=16:00 JST。
- **調査メモ**: (1)ユーザーから、実際の商品カードを貼って「効いていない」と報告された件が複数あったが、2件とも「一括承認の方式(Best Match順位=指定順位**以下**だけが対象)」や選択値の勘違いで、コードは正常だった。商品の`send_offer_eligible_items.offer_sent_at`・`ebay_sell_similar_queue.status`・`search_rank`をDBで確認すると原因が分かる。症状だけで修正せず、まず該当商品のデータを確認し、仕様の解釈(基準が経過時間か残り時間か等)は選択肢を示して確認すること。(2)「終了品バックアップ」の警告(新規出品の公開に失敗)は、オファーが`UNPUBLISHED`のままで正確だった(約23時間出品ゼロ)。eBayのエラー本文は`str(e)`しか記録しておらず原因不明。**未対応の改善案**: `do_action_v2()`のpublishOffer失敗時に`e.response.text`をログ・エラーメッセージに残す。(3)Send Offerの実際の有効期間は4日=96時間(eBayは4 DAYのみ受け付ける)。(4)ユーザーからVercel移行の可否を問われた。メリット=git pushで自動デプロイ(SSH鍵・手動`cp`の手間が消える)・HTTPS/CDN/プレビュー/ロールバック、デメリット=公開URL化(現状は`biz.soulmen.net`のHTTPSで公開済みだが、機微な業務データのため追加のアクセス制限設計が前提)・環境変数移行・アカウント管理増・現行の「ユーザーが目視してからデプロイ」の2段階フローの再設計。実施はしていない。

### 運用メモ(このセッションで判明)
- ebay-automationの動作確認用curlは**`http://127.0.0.1:8443`(httpsではない)**。gunicornが直接プレーンHTTPで待ち受けており(`ebay-automation-webapp.service`の`--bind 127.0.0.1:8443`、TLS無し)、`https://`だと`000`が返る。未ログインのログイン必須ページは`302`が正常。
- Windows側SSH鍵のACL問題(`GRAM2\CodexSandboxUsers`)は10-06にも再発。`PowerShell`ツールの`cmd /c icacls`で直し、直後の確認で同ツールを鍵ファイルに使わずユーザーへ再実行を依頼する運用が有効だった。なお`ssh-vps-manager`の`run_command`では`sudo -n systemctl restart ebay-automation-webapp`が**パスワード不要で実行できる**(鍵問題で詰まったときの代替手段。ただし再起動はユーザーに依頼する運用が基本)。
- PowerShellから`ssh ... "curl ... \"%{http_code}\""`のようにバックスラッシュでエスケープしたダブルクォートを渡すと引数が壊れる。シングルクォート(`'%{http_code}\n'`)を使うこと。
- ブラウザに古いHTMLが残っていて「反映されていない」ことがあった。サーバー側の更新時刻・再起動時刻・レンダリング結果を確認したうえで、まず`Ctrl+F5`を依頼する。
- 不明瞭・途中で切れたユーザー入力(「た」「ん」等)は推測で作業せず、内容を聞き返す。

## セッション要点(2026-10-07〜10-08)

### 購入品の一括登録(メルカリ/ヤフオク/ヤフーフリマ)の実施記録と手順上の注意
- 流れ: G:ドライブの`1.メルカリ…txt`/`2.ヤフオク…txt`/`3.ヤフーフリマ…txt`(いずれもShift-JIS。cp932でUTF-8へ変換して読む)から商品名を取り出し→各サイトの購入履歴をブラウザで開いて仕入高・出品者・購入日・URLを取得→Supabase RPC `create_item_with_purchase`で登録(UIの「+新規登録」ではなくRPC直接)。登録前に`purchases.source_url`で重複確認、管理番号は`generate_management_no(日付)`の続きから連番。
- 登録実績: **メルカリ**=261006-01〜08・261005-01(Chromeの購入履歴、アカウント「にくやま」)と261005-02(Edgeの購入履歴、アカウント「うおかわ」)。**ヤフオク**=261007-01〜03(支払い済み)と261006-09〜13(まとめ取引・支払い前)。**ヤフーフリマ**=261007-04。
- **要フォローアップ**: 261006-09〜13(出品者okubocamera、まとめ取引の依頼中で支払い前。仕入高は落札価格のみ=4,800/3,300/3,300/7,300/6,700、仕入日は落札日10/6)。出品者の請求確定・支払い後に、仕入高を送料込みの支払い額(5件合算の可能性があり按分が必要)・仕入日を支払い日へ修正する。
- RPCの注意: `items.category`はNOT NULL(ブランド・機種名はNULL可)。登録時は既存と同じ`カメラ関連品`を入れた。`source_type`は`mercari`/`yahoo_auction`/`yahoo_furima`、取引相手は`consumer`。**`account`はRPCでは設定されない**ため登録後に`update items set account='soulcamera'`が必要(1トランザクションにまとめた)。出品者名に`®️`(U+00AE+U+FE0F)や`☺︎`(U+263A+U+FE0E)等の不可視文字が入ることがあるため、SQLは日本語を直接ssh経由で渡さず、`\uXXXX`のASCIIエスケープをPythonの`json.loads`で戻して生成する(転記ミス防止)。
- ブラウザ操作の注意: Claude in Chromeは複数のブラウザが同時に接続されうる(`list_connected_browsers`)。**使用中のBrowserがChromeかEdgeかは`navigator.userAgentData.brands`で判定**し、ユーザーがEdgeを指定したら`select_browser`で切り替える。ChromeとEdgeでサイトのログインアカウントが別だった。メルカリの購入履歴の商品名は通常のDOMに無い(座標クリックが必要)。**ページ遷移直後の最初のクリックは無視される**ことがあり、直前に縮小スクリーンショット(`scale: 0.1`)を挟むと効く。メルカリShopsの注文は`mercari-shops.com/orders/<id>`(取引情報の商品行をクリックすると`jp.mercari.com/shops/product/<id>`)。
- ヤフオク: 落札一覧のタイトル→商品ページ(`/jp/auction/<id>`)→「取引ナビ」→**「情報」タブ**に支払い金額(落札金額+送料)・出品者・取引の状況(「支払い完了の連絡を行いました。」の日付)がある。指定どおりの「お届け情報・お支払い情報などを確認する」リンクは無かった。「支払い明細」リンクはYahoo!の再認証(ログイン)画面に飛ぶため使えない(取引ナビのURL`contact.auctions.yahoo.co.jp/trade/top?aid=…&oid=…`で代用)。「まとめて取引を依頼中」の商品は支払い金額・支払い完了日がまだ無い。ヤフーフリマ: 取引画面`paypayfleamarket-sec.yahoo.co.jp/item/<id>/trade/buyer`から取得、商品画像のクリックで`paypayfleamarket.yahoo.co.jp/item/<id>`。

### 売上の自動突合: 旧形式SKUが突合できない(調査のみ、未修正・ユーザー回答待ち)
- 症状: 送料登録(CPaSS)で注文`08-15260-54449`が「eBay取引未突合」。取引明細はあるが`match_status='unmatched'`。
- 原因: Edge Function `ebay-sync-orders`の`skuMatchKey()`が、SKUの**先頭9文字**を`items.management_no`と完全一致で比較している。旧形式SKU(例`20260504-03 0616 4111-V2R…`、先頭に「20」が付く)は先頭が`20260504-`になり、管理番号`260504-03`と一致しない。
- 規模: 未突合のSALE明細152件中148件が旧形式。先頭の「20」を外せば124件が1商品に決まるが、**うち118件は商品がすでに`sold`で売上もある**(売上が明細に紐付いていない)。突合ロジックだけを直してデプロイすると、`ebay_sales_sync.py`(20分おきの自動登録)が二重売上・his50s通知・Drive移動を実行してしまう(二重登録の防止は「同一line_idの売上が既にあるか」だけ)。修正する場合は、「商品がすでにsold」「同じorder_number/sales_record_referenceの売上あり」を除外する条件と、履歴の整理が前提。対応案は(1)手動処理、(2)この1件だけ紐付け、(3)安全条件付きの全体修正、をユーザーに提示済み。
- `260504-03`は8/2に売上済み(売上は明細に未紐付け)のあとステータスが「出品中」に戻っており、10/5の注文は新しい売上(未登録)。送料登録は「販売済みではありません」で止まるため、先に売上登録が要る。

### camera-inventory-app: 詳細編集の左ペイン一覧
- `ItemListPane.tsx`: 各アイテムの1行目末尾に「・ 仕入高 ¥n,nnn」を追加(`purchases.purchase_price`、未仕入は非表示)。コミット a8a5684。

### 運用メモ(このセッションで判明)
- Windows側SSH鍵のACL問題(`CodexSandboxUsers`)はさらに再発。`PowerShell`の`cmd /c icacls`で直し、直後に同ツールで鍵に触れずユーザーへ再実行を依頼する運用を継続。
- **CLAUDE.mdは、別セッションが同じファイルを更新していることがある**。VPS上に別セッション追記の未コミットのセクション(2026-10-05〜10-07)があった。更新前に、ローカルとVPSのmd5と`git status`(VPS側の未コミット変更)を比べること。
- 報告の訂正: 261005-02を登録した際の説明で「同じ日付のヤフオク分(261005-01)の続き」と書いたが、261005-01はメルカリ(Autoboy 2、出品者daiki camera)の登録だった(ヤフオクではない)。

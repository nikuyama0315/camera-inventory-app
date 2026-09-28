---
title: 「Send Offer」機能・「リターン損益計算」画面の新設
system: /opt/ebay-automation (eBay Sell Similarツール。camera-inventory-app とは別の既存本番ツール)
status: 実装・デプロイ・commit/push済み(2026-09-28)
created: 2026-09-28
---

# 「Send Offer」機能・「リターン損益計算」画面の新設 (2026-09-28)

いずれもユーザーから直接名指しで依頼された、`/opt/ebay-automation`側への機能追加(CLAUDE.mdの「変更禁止」の例外)。

## 1. Send Offer機能

### 背景・経緯

eBayでWatch/カートに入れたが未購入の買い手に対する「Send Offer(割引オファー)」対応を半自動化してほしいという依頼。30分ごとに対象商品を自動検知し、メール通知+両アプリ(camera-inventory-app・ebay-automation)へのバナー表示+専用画面での割引オファー送信、までを実装した。

### 事前調査で判明した制約

- eBay Negotiation API の `findEligibleItems` は**対象ItemID一覧のみ**を返し、「興味を持っている買い手の人数」は一切返らない(`sendOfferToInterestedBuyers`実行後のレスポンスで買い手ごとの明細が初めて分かるが、それでは「送信前に人数を見て判断する」という運用に合わない)。
- 代替として、Trading APIの`GetItem`(`IncludeWatchCount=true`、出品者本人のみ取得可)の**Watch数**を「n watcher(s)」の代用値として採用(ユーザー承認済み)。
- Negotiation APIの呼び出しは、`.env`の既存`EBAY_REFRESH_TOKEN`(`EbayAuth`、`scripts/ebay_auth.py`)でスコープがカバーされていることを実機確認済み(camera-inventory-app側で使っている`broad_scope_refresh_token`のような別OAuth grantは不要だった)。
- `sendOfferToInterestedBuyers`のofferDurationは、実機テストで「4 DAYのみ有効」というバリデーションエラー(errorId=150027)を確認し、デフォルトを3日→4日に修正。

### 実装内容

- **`scripts/send_offer_check.py`(新規)**: 30分おきsystemdタイマー(`ebay-automation-sendoffer.timer`)で実行。`findEligibleItems`→`GetItem`(Watch数付き、並列)→SKUから管理番号・仕入高(円)を抽出→Supabaseの`send_offer_eligible_items`テーブル(新規作成)にUPSERT/DELETE→新規対象があればメール通知+`event_log`記録(`event_notifier.py`と同じパターン)。
- **`webapp/app.py`**: `/send-offers`(一覧・共通条件パネル・粗利試算)、`POST /send-offers/<item_id>/send`(オファー送信、失敗時はeBayのエラー詳細を抽出して表示)、`_attach_promoted_listings_status()`(各商品のPromoted Listings General率・Priority ON/OFF状態を`scripts/sell_similar.py`の既存関数`get_fixed_promotion`/`get_priority_status`で並列取得)、全画面共通のバナー用件数(`context_processor`)。
- **`webapp/templates/send_offers.html`(新規)**: 利益シミュレーターと同じDDP/Non-DDP粗利計算式(`dashboard_v2.html`の`pcmRender()`を移植)で、ディスカウント前後の粗利を商品ごとに試算・表示。「オファする」は実際の買い手に届く取り消し不可能な操作のため、JS確認ダイアログでの再確認必須。**Claudeはこのボタンを自分では押さない**運用にした(実機テストはユーザー自身が実施)。
- **`webapp/templates/base.html`**: ナビに「Send offers」リンク追加(後に「オファ」に短縮)、対象商品がある場合の上部バナー追加(localStorageでdismiss状態を管理)。
- **camera-inventory-app側**: `src/lib/api/sendOffers.ts`(新規)+`src/App.tsx`にバナー追加(既存の在庫アラート等と同じ表示パターン、`send_offer_eligible_items`テーブルを直接select)。

### Supabaseテーブル(新規、プロジェクト`ceupmjnothcitgyffhke`)

```sql
create table public.send_offer_eligible_items (
  shop_id text not null default 'main',
  item_id text not null,
  management_no text,
  item_title text,
  sku text,
  current_price_usd numeric,
  purchase_price_jpy numeric,
  watch_count integer,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  notified_at timestamptz,
  offer_sent_at timestamptz,
  offer_detail jsonb,
  primary key (shop_id, item_id)
);
alter table public.send_offer_eligible_items enable row level security;
create policy "authenticated can select" on public.send_offer_eligible_items for select to authenticated using (true);
```

### 検証・実績

- 実機で3商品を検知(Olympus μ mju、Konica C35、Konica Big Mini)、メール送信・`event_log`記録・重複通知防止を確認。
- ユーザー自身が実際に1件オファー送信し、成功を確認(期間4日修正後)。

## 2. リターン損益計算画面(`/return-loss`)

### 背景・経緯

eBayの「リターンリクエスト」をアクセプトした場合の損益を、都度手計算せずシミュレーションできる画面が欲しいという依頼。ユーザー提供のPDF(`前提.pdf`、デスクトップに保存)に計算ロジックの数値例が示されていた。**eBayへの書き込みを一切行わない計算専用画面**のため、Send Offerと異なり段階的ロールアウトは不要。

### PDFから一般化した計算式

- 販売時: `FVF = (ItemPrice+Shipping)×eBay手数料率 + $0.40固定`、`Promo = (ItemPrice+Shipping)×Promo率`
- 返金時の手数料クレジット: バイヤー都合(購入者都合の返品)は固定$0.40込みで全額、セラー都合(商品不良・説明相違)は固定$0.40を除いてクレジット。
- 代数的に展開すると、全額返金時はFVF/Promoの料率が数式上ちょうど相殺され、両シナリオの差は固定$0.40の有無だけになることを確認(PDFの数値例: バイヤー都合$50.00損失/セラー都合$50.40損失と完全一致、実装前にPythonで検証済み)。
- 部分返金時は返金比率に比例して手数料がクレジットされるという一般化で実装(PDFに明記が無いため、こちらの拡張である旨をコード注釈に明記)。
- **返品あり/なしと仕入高の扱い**(ユーザー指定): 返品あり→仕入高を損失額に足し戻す(在庫が戻るため)、返品なし→仕入高を損失額から差し引く(在庫が戻らないため追加の損失)。
- **返品なしの場合、Shipping label(返送料)は計算に含めない**(返送される商品が無いため。ユーザー指摘を受けて修正)。

### 実装内容

- **`webapp/app.py`**: `GET /return-loss`。Order No.から、camera-inventory-appと共有しているSupabaseの`ebay_transaction_lines`テーブル(`ebay_sales_sync.py`が20分おきに同期済み)を1回クエリするだけで、Item price(`item_subtotal`)・Shipping(`shipping_and_handling`)・custom_label(→管理番号・仕入高)がすべて揃うことを確認して実装(eBayへの追加API呼び出し不要)。`type='SALE'`で絞り込み。1つのOrder Noに複数商品が紐づく場合は選択画面を表示。USD建て以外(実データにCAD建ても存在)は非対応。
- **`webapp/templates/return_loss.html`(新規)**: 前提項目(eBay手数料率・Promo Listing・為替レート自動取得)+返金シミュレーション欄(Item price/Shipping/Item refund/Shipping label/Amount after deductions/仕入高)+4シナリオ結果タイル。Shipping labelは円入力+「換算」ボタンでUSDへ変換可能。

### 検証・実績

- Order No `17-15207-46772`(実データ)で取得ボタンの動作を確認。
- 複数商品を含むOrder No `13-14949-72119`で選択画面の動作を確認。
- Flask test_client + session偽装で GET/POST の主要パスを確認してからデプロイ。

## 3. その他の細かい修正(このセッション内)

- 為替レート自動取得の`NameError`修正(`_fetch_latest_mufg_ttm_cached`等3関数が2026-09-22の別機能追加時に誤って削除されていたのを復元)。
- 利益シミュレーター等の「通関方法」表記を「発送方法」に統一(全画面対象、camera-inventory-appの`ProfitCalcModal.tsx`含む)。
- グローバルナビのメニュー表記を短縮(個別ITEM指定・エラーアイテム再処理→個別指定・再処理、カスタムラベル書換→SKU書換、実行ジョブ一覧→実行中ジョブ、実行履歴→ジョブログ、Send offers→オファ、リターン損益→返品損益、利益シミュレーター→利益シミュレータ、直販利益計算表→直販利益、Store Category一括設定→カテゴリ書換)。

## デプロイ運用上の注意(このセッションで確立)

- `/opt/ebay-automation`側のファイル編集(`webapp/app.py`・テンプレート等)は自動モード分類器にブロックされないことが多いが、**`systemctl restart`は毎回「Production Deploy」としてブロックされる**ため、ユーザーの手元SSHで実行してもらう運用に統一した。
- Flaskアプリの構文検証は`python3 -m py_compile`(Python)+`app.jinja_env.get_template(name)`(Jinja、`Environment(FileSystemLoader(...))`単体だとカスタムフィルター`utc_jst`等が無く誤検知するため、必ず実際の`app`オブジェクト経由で検証すること)。
- `git add`で意図せず他セッションの未コミット変更(例: 市場価格機能の`dashboard_v2.html`)を巻き込んでしまう事故が1回発生。`git diff --cached --stat`の行数が想定より多い場合は要注意(今回は既に本番稼働中のコードだったため実害無しと判断したが、次回以降はより慎重にファイル単位でaddすること)。

## 未対応・注意事項

- Send Offerの「n watcher(s)」はeBay API仕様上の制約でWatch数による代用(厳密な「興味を持っている買い手数」ではない)。
- リターン損益の部分返金時の手数料按分ロジックは、PDFに明記の無い箇所をこちらの合理的な一般化で実装(全額返金時はPDF数値と完全一致)。
- Send Offer・リターン損益とも、複数店舗運用時は`shop_id='main'`固定(現状single-shop運用のため未対応)。

import { useEffect, useState } from "react";
import type { EbayTransactionLineDetail, ItemDetail } from "../../../lib/types";
import { deleteSale, updateSale, type Sale } from "../../../lib/api/sales";
import { fetchAdFeeForOrderItem, fetchTransactionFeeForOrderItem } from "../../../lib/api/ebaySync";

interface Props {
  item: ItemDetail;
  onChanged: () => void;
}

const ROW_STYLE: React.CSSProperties = { display: "flex", gap: 12, marginBottom: 8, fontSize: 13 };
const LABEL_STYLE: React.CSSProperties = { color: "var(--text-secondary)", width: 190, flexShrink: 0 };

interface EditForm {
  ebay_price_usd: string;
  ebay_shipping_collected_usd: string;
  ebay_handling_fee_usd: string;
  ebay_ad_fee_usd: string;
  shipping_cost_paid: string;
}

type SaleRow = ItemDetail["sales"][number];

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function jpy(value: number): string {
  return `¥${value.toLocaleString()}`;
}

/**
 * 2026-09-06: Convert an ebay_transaction_lines local-currency amount (item_subtotal,
 * shipping_and_handling, final_value_fee+international_fee, etc.) to USD using
 * transaction_currency/exchange_rate. Fixes bug reported by user: non-USD sales showed
 * their local-currency amount as if it were already USD.
 */
function lineToUsd(line: EbayTransactionLineDetail, localValue: number): number {
  const usdValue =
    !line.transaction_currency || line.transaction_currency === "USD"
      ? localValue
      : localValue * (line.exchange_rate ?? 1);
  return Math.round(usdValue * 100) / 100;
}

/**
 * 在庫タブ「詳細編集」の「販売」タブ(2026-09-06追加)。
 *
 * ユーザーからの要望「在庫・販売済タブ 詳細編集の右ペインに『販売』タブを追加。表示項目は、受注日、
 * Order番号、Sales Record #、SKU、ITEM TITLE、ITEM ID、Buyer、バイヤー居住国、subtotal、shipping、
 * transaction fees、Ad fee general、order earnings」「表示情報はebayから取得してください」に対応。
 *
 * 表示方針: 受注日・Order番号・Sales Record #・SKU・ITEM TITLE・ITEM ID・Buyer・バイヤー居住国・
 * subtotal・shipping・transaction feesは、この売上に紐づくeBay取引明細(ebay_transaction_lines、
 * sales.ebay_transaction_line_id経由)から取得する(実際にeBayから同期された値)。Ad Fee Generalは
 * ebay_transaction_linesに列が無いため、ebay_tax_invoice_lines(fee_category='ad_fee')を
 * order_number・item_number(=ITEM ID)で別途集計する。order earningsはsubtotal+shipping-
 * transaction fees-Ad Fee Generalとしてその場で計算する(sales.usd_subtotalと同じ考え方)。
 *
 * eBay取引明細が紐づいていない売上(手動登録、または90日を超えて再取得できない古い注文)は、
 * 該当項目を「-」表示にしたうえで、subtotal/shipping/transaction feesのみsalesテーブル自体の
 * 登録値(ebay_price_usd等)にフォールバックする(Order番号・SKU・ITEM ID・Buyer・バイヤー居住国は
 * salesテーブルに保持していないため、フォールバック手段が無く常に「-」)。
 *
 * 2026-09-06追加: 「邦プラットフォーム販売価格(円)」「邦プラットフォーム手数料(円)」「送料支払額(円)」を
 * 追跡番号の下に追加表示。これらはeBay固有ではなくsalesテーブル自体の列(jp_platform_price/
 * jp_platform_fee/shipping_cost_paid)をそのまま表示するだけで、eBay取引明細への依存は無い
 * (メルカリ等の国内プラットフォーム経由の売上でも必ず埋まりうる項目のため)。
 *
 * 「編集」ボタンは、eBay同期データそのもの(ebay_transaction_lines)ではなく、この売上(sales)の
 * 登録済み金額(ebay_price_usd/ebay_shipping_collected_usd/ebay_handling_fee_usd/ebay_ad_fee_usd、
 * 「売上・粗利」タブの編集フォームと同じ列)を修正する。ebay_transaction_linesは同期専用の読み取り
 * 専用データという既存の設計方針を踏襲し、手で書き換える経路は用意していない。
 */
export default function SalesTab({ item, onChanged }: Props) {
  const sales = item.sales ?? [];
  const [adFeeBySaleId, setAdFeeBySaleId] = useState<Record<string, number>>({});
  const [transactionFeeBySaleId, setTransactionFeeBySaleId] = useState<Record<string, number>>({});
  const [loadingAdFee, setLoadingAdFee] = useState(false);
  const [editingSaleId, setEditingSaleId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    ebay_price_usd: "0",
    ebay_shipping_collected_usd: "0",
    ebay_handling_fee_usd: "0",
    ebay_ad_fee_usd: "0",
    shipping_cost_paid: "0",
  });
  const [busy, setBusy] = useState(false);
  const [resettingSaleId, setResettingSaleId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadFees() {
      setLoadingAdFee(true);
      try {
        const adFeeEntries: Array<readonly [string, number]> = [];
        const txFeeEntries: Array<readonly [string, number]> = [];
        await Promise.all(
          sales.map(async (sale) => {
            const line = sale.ebay_transaction_lines;
            const lineTxFeeFallback = line
              ? lineToUsd(line, (line.final_value_fee ?? 0) + (line.international_fee ?? 0))
              : sale.ebay_handling_fee_usd;
            if (!line?.order_number) {
              adFeeEntries.push([sale.id, sale.ebay_ad_fee_usd]);
              txFeeEntries.push([sale.id, lineTxFeeFallback]);
              return;
            }
            const [adFeeResult, txFeeResult] = await Promise.allSettled([
              fetchAdFeeForOrderItem(line.order_number, line.item_id),
              fetchTransactionFeeForOrderItem(line.order_number, line.item_id),
            ]);
            adFeeEntries.push([sale.id, adFeeResult.status === "fulfilled" ? adFeeResult.value : sale.ebay_ad_fee_usd]);
            // ebay_tax_invoice_lines(月次Tax Invoice)にまだ取り込まれていない直近の注文は合計が0になりうるため、
            // その場合はebay_transaction_lines由来の内訳(final_value_fee+international_fee)にフォールバックする
            // (国際取引ではFINAL_VALUE_FEE_FIXED_PER_ORDER等が欠けるため厳密には少なめになりうるが、0円表示よりは実用的)。
            const txFeeValue = txFeeResult.status === "fulfilled" && txFeeResult.value > 0 ? txFeeResult.value : lineTxFeeFallback;
            txFeeEntries.push([sale.id, txFeeValue]);
          }),
        );
        if (!cancelled) {
          setAdFeeBySaleId(Object.fromEntries(adFeeEntries));
          setTransactionFeeBySaleId(Object.fromEntries(txFeeEntries));
        }
      } finally {
        if (!cancelled) setLoadingAdFee(false);
      }
    }
    void loadFees();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, sales.length]);

  function startEdit(sale: Sale) {
    setEditingSaleId(sale.id);
    setErrorMessage(null);
    setEditForm({
      ebay_price_usd: String(sale.ebay_price_usd),
      ebay_shipping_collected_usd: String(sale.ebay_shipping_collected_usd),
      ebay_handling_fee_usd: String(sale.ebay_handling_fee_usd),
      ebay_ad_fee_usd: String(sale.ebay_ad_fee_usd),
      shipping_cost_paid: String(sale.shipping_cost_paid),
    });
  }

  function cancelEdit() {
    setEditingSaleId(null);
    setErrorMessage(null);
  }

  function updateEditField<K extends keyof EditForm>(key: K, value: EditForm[K]) {
    setEditForm((prev) => ({ ...prev, [key]: value }));
  }

  async function saveEdit(saleId: string) {
    setBusy(true);
    setErrorMessage(null);
    try {
      await updateSale(saleId, {
        ebay_price_usd: Number(editForm.ebay_price_usd) || 0,
        ebay_shipping_collected_usd: Number(editForm.ebay_shipping_collected_usd) || 0,
        ebay_handling_fee_usd: Number(editForm.ebay_handling_fee_usd) || 0,
        ebay_ad_fee_usd: Number(editForm.ebay_ad_fee_usd) || 0,
        shipping_cost_paid: Number(editForm.shipping_cost_paid) || 0,
      });
      setEditingSaleId(null);
      onChanged();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 「販売データリセット」ボタン(2026-09-08追加)。販売済みの商品が返品・キャンセルとなり、
   * ステータスを出品中・検品済(出品待ち)等へ差し戻す運用があるため、この売上(sales)1件分を
   * まるごと削除して「販売時にセットされたデータ」を無かった状態に戻す。フィールドを個別に0/空へ
   * 書き換えるのではなくレコード自体を削除する方式にしたのは、値だけ空にすると「売上・粗利」タブの
   * 一覧・集計に$0のみの実体の無い行が残ってしまうため(deleteSale()は同タブの削除機能で既に使用)。
   * items.statusの変更は行わない(ステータス変更は既存の「ステータス(修正用)」等の操作に委ねる)。
   */
  async function resetSaleData(sale: SaleRow) {
    if (
      !window.confirm(
        `${sale.sale_date}の売上データを削除します(この操作は取り消せません)。\n返品・キャンセル等でこの商品の販売記録を取り消す場合に実行してください。よろしいですか?`,
      )
    ) {
      return;
    }
    setResettingSaleId(sale.id);
    setErrorMessage(null);
    try {
      await deleteSale(sale.id);
      if (editingSaleId === sale.id) setEditingSaleId(null);
      onChanged();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "販売データのリセットに失敗しました");
    } finally {
      setResettingSaleId(null);
    }
  }

  if (sales.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
        この商品にはまだ売上(販売)記録が登録されていません。「売上・粗利」タブから登録してください。
      </p>
    );
  }

  return (
    <div>
      {sales.map((sale: SaleRow) => {
        const line = sale.ebay_transaction_lines;
        const adFeeUsd = adFeeBySaleId[sale.id] ?? sale.ebay_ad_fee_usd;
        // 2026-09-06: line.item_subtotal/shipping_and_handling are in the local transaction
        // currency (not always USD) - convert via lineToUsd() before display.
        const subtotal = line ? lineToUsd(line, line.item_subtotal ?? 0) : sale.ebay_price_usd;
        const shipping = line ? lineToUsd(line, line.shipping_and_handling ?? 0) : sale.ebay_shipping_collected_usd;
        // 2026-09-06修正: 以前はline.final_value_fee+international_feeのみを表示していたが、これは
        // ebay_tax_invoice_lines側のFINAL_VALUE_FEE_FIXED_PER_ORDER等を含まず実額より少なく表示される
        // 不具合があった(詳細はfetchTransactionFeeForOrderItem()のコメント参照)。非同期集計が終わるまでは
        // 一旦line由来の内訳を暫定表示し、集計完了後にtransactionFeeBySaleIdの値(Tax Invoice実額)へ差し替える。
        const lineTransactionFeesFallback = line
          ? lineToUsd(line, (line.final_value_fee ?? 0) + (line.international_fee ?? 0))
          : sale.ebay_handling_fee_usd;
        const transactionFees = transactionFeeBySaleId[sale.id] ?? lineTransactionFeesFallback;
        const orderEarnings = subtotal + shipping - transactionFees - adFeeUsd;
        const isEditing = editingSaleId === sale.id;

        return (
          <div
            key={sale.id}
            style={{
              border: "0.5px solid var(--border)",
              borderRadius: 8,
              padding: "12px 14px",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <p style={{ fontSize: 13, fontWeight: 500, margin: 0, color: "var(--text-secondary)" }}>
                {sale.sale_date}の売上{line ? "(eBay同期データ)" : "(eBay取引明細未紐付け)"}
              </p>
              {!isEditing && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => startEdit(sale)}
                    style={{ fontSize: 12, padding: "4px 10px" }}
                    title="この売上の登録金額(subtotal/shipping/transaction fees/Ad fee general)を修正します"
                  >
                    編集
                  </button>
                  <button
                    type="button"
                    onClick={() => void resetSaleData(sale)}
                    disabled={resettingSaleId === sale.id}
                    style={{ fontSize: 12, padding: "4px 10px", color: "var(--danger-text)" }}
                    title="返品・キャンセル等でステータスを差し戻す際に、この売上記録を削除して販売時のデータをリセットします"
                  >
                    {resettingSaleId === sale.id ? "処理中..." : "販売データリセット"}
                  </button>
                </div>
              )}
            </div>

            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>受注日</span>
              <span>{line?.transaction_date ?? sale.sale_date}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>Order番号</span>
              <span>{line?.order_number ?? "-"}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>Sales Record #</span>
              <span>{line?.sales_record_reference ?? sale.sales_record_reference ?? "-"}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>SKU</span>
              <span>{line?.custom_label ?? "-"}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>ITEM TITLE</span>
              <span>{line?.item_title ?? sale.sale_item_title ?? "-"}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>ITEM ID</span>
              <span>{line?.item_id ?? "-"}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>Buyer</span>
              <span>{line?.buyer_username ?? "-"}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>バイヤー居住国</span>
              <span>{line?.buyer_country ?? "-"}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>追跡番号</span>
              <span>{sale.tracking_info ?? "-"}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>邦プラットフォーム販売価格(円)</span>
              <span>{jpy(sale.jp_platform_price)}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>邦プラットフォーム手数料(円)</span>
              <span>{jpy(sale.jp_platform_fee)}</span>
            </div>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>送料支払額(円)</span>
              {isEditing ? (
                <input
                  type="number"
                  value={editForm.shipping_cost_paid}
                  onChange={(e) => updateEditField("shipping_cost_paid", e.target.value)}
                  style={{ width: 140 }}
                />
              ) : (
                <span>{jpy(sale.shipping_cost_paid)}</span>
              )}
            </div>

            <div style={{ borderTop: "0.5px dashed var(--border)", margin: "10px 0" }} />

            {isEditing ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>subtotal($)</label>
                    <input
                      type="number"
                      value={editForm.ebay_price_usd}
                      onChange={(e) => updateEditField("ebay_price_usd", e.target.value)}
                      style={{ width: "100%" }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>shipping($)</label>
                    <input
                      type="number"
                      value={editForm.ebay_shipping_collected_usd}
                      onChange={(e) => updateEditField("ebay_shipping_collected_usd", e.target.value)}
                      style={{ width: "100%" }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>transaction fees($)</label>
                    <input
                      type="number"
                      value={editForm.ebay_handling_fee_usd}
                      onChange={(e) => updateEditField("ebay_handling_fee_usd", e.target.value)}
                      style={{ width: "100%" }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>Ad fee general($)</label>
                    <input
                      type="number"
                      value={editForm.ebay_ad_fee_usd}
                      onChange={(e) => updateEditField("ebay_ad_fee_usd", e.target.value)}
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>
                {errorMessage && (
                  <p style={{ color: "var(--danger-text)", fontSize: 12, marginBottom: 8 }}>{errorMessage}</p>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void saveEdit(sale.id)}
                    style={{ fontSize: 12, padding: "4px 12px" }}
                  >
                    {busy ? "保存中..." : "保存"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={cancelEdit}
                    style={{ fontSize: 12, padding: "4px 12px" }}
                  >
                    キャンセル
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={ROW_STYLE}>
                  <span style={LABEL_STYLE}>subtotal</span>
                  <span>{usd(subtotal)}</span>
                </div>
                <div style={ROW_STYLE}>
                  <span style={LABEL_STYLE}>shipping</span>
                  <span>{usd(shipping)}</span>
                </div>
                <div style={ROW_STYLE}>
                  <span style={LABEL_STYLE}>transaction fees</span>
                  <span>{usd(transactionFees)}</span>
                </div>
                <div style={ROW_STYLE}>
                  <span style={LABEL_STYLE}>Ad fee general</span>
                  <span>{loadingAdFee ? "読み込み中..." : usd(adFeeUsd)}</span>
                </div>
                <div style={ROW_STYLE}>
                  <span style={LABEL_STYLE}>order earnings</span>
                  <span style={{ fontWeight: 500 }}>{usd(orderEarnings)}</span>
                </div>
                {/* 2026-09-06 added: gross profit (JPY), per user request */}
                <div style={ROW_STYLE}>
                  <span style={LABEL_STYLE}>粗利(円)</span>
                  <span style={{ fontWeight: 500 }}>{jpy(sale.gross_profit_jpy)}</span>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

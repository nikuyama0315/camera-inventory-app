import { useEffect, useState } from "react";
import { fetchLatestMufgTtm, fetchMonthlyMufgDailyRates } from "../../../lib/api/mufgRate";

interface Props {
  open: boolean;
  title: string;
  initialPriceUsd: number;
  initialShippingUsd: number;
  initialCostJpy: number;
  onClose: () => void;
  onApply: (priceUsd: number, shippingUsd: number) => void;
}

/**
 * 2026-09-27新規追加(ユーザー指示): 「出品」タブの「利益簡易計算」ボタン用モーダル。
 * /opt/ebay-automation の marketing/v2(dashboard_v2.html「利益簡易計算」モーダル、
 * webapp/templates/dashboard_v2.html 653-995行目)の入力項目・計算式をそのまま移植している。
 * DDP(関税込み)・Non-DDP(関税別payment)の2パターンを同時に算出して両方表示する。
 * 「変更値を元画面に反映する」を押すと、商品本体価格・DDP上乗せ分＋送料徴取額を
 * onApply(priceUsd, shippingUsd) で呼び出し元(出品タブ)へ返す(実際の反映先へのマッピングは
 * 呼び出し元が行う)。
 */

const DEFAULTS = {
  ebayFee: 9.35,
  vat: 15,
  payoneer: 2,
  intlFee: 1.35,
  promo: 0,
  actualCost: 3500,
  actualShip: 3500,
  rate: 156.59,
  tariff: 12.5,
  clearance: "FedEx_FICP_below",
  ptRateDdp: 8,
  nonddpSurcharge: 0,
  ptRateNonDdp: 8,
};

const CLEARANCE_OPTIONS: { value: string; label: string }[] = [
  { value: "SPK_Economy", label: "SPK Economy" },
  { value: "FedEx_IP_below", label: "FedEx IP（$2,500以下）" },
  { value: "FedEx_FICP_below", label: "FedEx FICP（$2,500以下）" },
  { value: "FedEx_IP_over", label: "FedEx IP（$2,500超）" },
  { value: "FedEx_FICP_over", label: "FedEx FICP（$2,500超）" },
  { value: "DHL_below", label: "DHL（$2,500以下）" },
  { value: "DHL_over", label: "DHL（$2,500超）" },
];

function clearanceFeeJpy(method: string, rate: number): number {
  switch (method) {
    case "SPK_Economy":
      return 225;
    case "FedEx_IP_below":
      return 296 + 2.69 * rate;
    case "FedEx_FICP_below":
      return 2.69 * rate;
    case "FedEx_IP_over":
      return 296 + 33.58 * rate;
    case "FedEx_FICP_over":
      return 33.58 * rate;
    case "DHL_below":
      return 850 + 1.34 * rate;
    case "DHL_over":
      return 1500 + 850 + 33.58 * rate;
    default:
      return 0;
  }
}

function feeChainTotal(base: number, ebayFee: number, intlFee: number, promo: number, payoneer: number): number {
  const fvf = base * ebayFee;
  const intl = base * intlFee;
  const fixed = 0.4;
  const taxTxn = (fvf + intl + fixed) * 0.1;
  const txn1 = fvf + intl + fixed + taxTxn;
  const ad = base * promo;
  const taxAd = ad * 0.1;
  const ad2 = ad + taxAd;
  const sum12 = txn1 + ad2;
  const payoneerFee = (base - sum12) * payoneer;
  return sum12 + payoneerFee;
}

function fmtYen(v: number): string {
  return "¥" + Math.round(v).toLocaleString("ja-JP");
}
function fmtYenSigned(v: number): string {
  return (v < 0 ? "-¥" : "¥") + Math.abs(Math.round(v)).toLocaleString("ja-JP");
}
function fmtPct(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

const fieldLabelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-secondary)", display: "block" };
const fieldInputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", marginTop: 2, fontSize: 12 };
const pinkFieldStyle: React.CSSProperties = { background: "#fff0f0", border: "0.5px solid var(--border-strong)", borderRadius: 6, padding: 6 };
const tileStyle: React.CSSProperties = {
  border: "0.5px solid var(--border)",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 12,
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
};
const accentTileStyle: React.CSSProperties = { ...tileStyle, background: "var(--surface-2)", fontWeight: 700 };

export default function ProfitCalcModal({ open, title, initialPriceUsd, initialShippingUsd, initialCostJpy, onClose, onApply }: Props) {
  const [price, setPrice] = useState(initialPriceUsd);
  const [ebayFee, setEbayFee] = useState(DEFAULTS.ebayFee);
  const [vat, setVat] = useState(DEFAULTS.vat);
  const [payoneer, setPayoneer] = useState(DEFAULTS.payoneer);
  const [intlFee, setIntlFee] = useState(DEFAULTS.intlFee);
  const [promo, setPromo] = useState(DEFAULTS.promo);
  const [actualCost, setActualCost] = useState(initialCostJpy || DEFAULTS.actualCost);
  const [actualShip, setActualShip] = useState(DEFAULTS.actualShip);
  const [rate, setRate] = useState(DEFAULTS.rate);
  const [rateNote, setRateNote] = useState("為替レートを取得中です…");

  const [ddpMarkup, setDdpMarkup] = useState(initialShippingUsd);
  const [tariff, setTariff] = useState(DEFAULTS.tariff);
  const [clearance, setClearance] = useState(DEFAULTS.clearance);
  const [ptRateDdp, setPtRateDdp] = useState(DEFAULTS.ptRateDdp);

  const [nonddpSurcharge, setNonddpSurcharge] = useState(DEFAULTS.nonddpSurcharge);
  const [ptRateNonDdp, setPtRateNonDdp] = useState(DEFAULTS.ptRateNonDdp);

  // モーダルを開くたびに、既定値へリセットした上で商品本体価格・DDP上乗せ分・仕入額のみ
  // 現在の値で上書きする(元のdashboard_v2実装と同じ「開くたびにリセット」仕様)。
  useEffect(() => {
    if (!open) return;
    setPrice(initialPriceUsd);
    setEbayFee(DEFAULTS.ebayFee);
    setVat(DEFAULTS.vat);
    setPayoneer(DEFAULTS.payoneer);
    setIntlFee(DEFAULTS.intlFee);
    setPromo(DEFAULTS.promo);
    setActualCost(initialCostJpy || DEFAULTS.actualCost);
    setActualShip(DEFAULTS.actualShip);
    setDdpMarkup(initialShippingUsd);
    setTariff(DEFAULTS.tariff);
    setClearance(DEFAULTS.clearance);
    setPtRateDdp(DEFAULTS.ptRateDdp);
    setNonddpSurcharge(DEFAULTS.nonddpSurcharge);
    setPtRateNonDdp(DEFAULTS.ptRateNonDdp);

    let cancelled = false;
    setRateNote("為替レートを取得中です…");
    (async () => {
      try {
        const now = new Date();
        const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const daily = await fetchMonthlyMufgDailyRates(yearMonth);
        const last = daily.days[daily.days.length - 1];
        if (last && !cancelled) {
          setRate(last.ttm);
          setRateNote(`${last.date} 時点のTTM(三菱UFJ公表レート、直近営業日)を自動取得しています。必要に応じて手動で修正してください。`);
          return;
        }
        throw new Error("当月の日別レートが取得できませんでした");
      } catch {
        try {
          const monthly = await fetchLatestMufgTtm();
          if (!cancelled) {
            setRate(monthly.ttm);
            setRateNote(`${monthly.source_text} 時点のTTM(三菱UFJ公表レート)を自動取得しています。必要に応じて手動で修正してください。`);
          }
        } catch (err) {
          if (!cancelled) {
            setRateNote(`為替レートの自動取得に失敗しました(${err instanceof Error ? err.message : "unknown"})。手動で入力してください。`);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, initialPriceUsd, initialShippingUsd, initialCostJpy]);

  if (!open) return null;

  const ebayFeeR = ebayFee / 100;
  const vatR = vat / 100;
  const payoneerR = payoneer / 100;
  const intlFeeR = intlFee / 100;
  const promoR = promo / 100;
  const tariffR = tariff / 100;
  const refundRateDdp = ptRateDdp / 100;
  const refundRateNonDdp = ptRateNonDdp / 100;

  const baseDdp = (price + ddpMarkup) * (1 + vatR);
  const feeTotalJpyDdp = feeChainTotal(baseDdp, ebayFeeR, intlFeeR, promoR, payoneerR) * rate;
  const dutyUsd = (price + ddpMarkup) * tariffR;
  const dutyProcUsd = dutyUsd * 0.021;
  const dutyTotalJpy = dutyUsd * rate + clearanceFeeJpy(clearance, rate) + dutyProcUsd * rate;
  const revenueDdp = (price + ddpMarkup) * rate;
  const shippingLandedDdp = actualShip + dutyTotalJpy;
  const refundDdp = actualCost * refundRateDdp;
  const profitDdp = revenueDdp - feeTotalJpyDdp - shippingLandedDdp - actualCost;
  const profitWithRefundDdp = profitDdp + refundDdp;
  const marginDdp = revenueDdp !== 0 ? profitDdp / revenueDdp : 0;
  const marginRefundDdp = revenueDdp !== 0 ? profitWithRefundDdp / revenueDdp : 0;

  const baseNon = (price + nonddpSurcharge) * (1 + vatR);
  const feeTotalJpyNon = feeChainTotal(baseNon, ebayFeeR, intlFeeR, promoR, payoneerR) * rate;
  const revenueNon = (price + nonddpSurcharge) * rate;
  const shippingLandedNon = actualShip;
  const refundNon = actualCost * refundRateNonDdp;
  const profitNon = revenueNon - feeTotalJpyNon - shippingLandedNon - actualCost;
  const profitWithRefundNon = profitNon + refundNon;
  const marginNon = revenueNon !== 0 ? profitNon / revenueNon : 0;
  const marginRefundNon = revenueNon !== 0 ? profitWithRefundNon / revenueNon : 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 8,
      }}
    >
      <div style={{ background: "var(--surface-2)", borderRadius: 8, padding: "16px 20px", width: "100%", maxWidth: 960, maxHeight: "98vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>利益簡易計算: {title}</h2>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button type="button" onClick={() => onApply(price, ddpMarkup)} style={{ padding: "4px 10px" }}>
              変更値を元画面に反映する
            </button>
            <button type="button" onClick={onClose} style={{ padding: "4px 10px" }}>
              閉じる
            </button>
          </div>
        </div>
        <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 14px" }}>
          ピンク色の欄が入力項目です。商品本体価格・DDP上乗せ分＋送料徴取額・仕入額はこの商品の現在値を反映しています(他の項目は手動調整してください)。
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          <div style={pinkFieldStyle}>
            <label style={fieldLabelStyle}>商品本体価格(USD)</label>
            <input type="number" step="0.01" value={price} onChange={(e) => setPrice(Number(e.target.value))} style={fieldInputStyle} />
          </div>
          <div style={pinkFieldStyle}>
            <label style={fieldLabelStyle}>ebay手数料率(%)</label>
            <input type="number" step="0.01" value={ebayFee} onChange={(e) => setEbayFee(Number(e.target.value))} style={fieldInputStyle} />
          </div>
          <div style={pinkFieldStyle}>
            <label style={fieldLabelStyle}>州税・VAT等 みなし加算(%)</label>
            <input type="number" step="0.01" value={vat} onChange={(e) => setVat(Number(e.target.value))} style={fieldInputStyle} />
          </div>
          <div style={pinkFieldStyle}>
            <label style={fieldLabelStyle}>Payoneer手数料率(%)</label>
            <input type="number" step="0.01" value={payoneer} onChange={(e) => setPayoneer(Number(e.target.value))} style={fieldInputStyle} />
          </div>
          <div style={pinkFieldStyle}>
            <label style={fieldLabelStyle}>海外手数料(%)</label>
            <input type="number" step="0.01" value={intlFee} onChange={(e) => setIntlFee(Number(e.target.value))} style={fieldInputStyle} />
          </div>
          <div style={pinkFieldStyle}>
            <label style={fieldLabelStyle}>Promo Listing（General広告料率）(%)</label>
            <input type="number" step="0.01" value={promo} onChange={(e) => setPromo(Number(e.target.value))} style={fieldInputStyle} />
          </div>
          <div style={pinkFieldStyle}>
            <label style={fieldLabelStyle}>仕入額（実額）(¥)</label>
            <input type="number" step="1" value={actualCost} onChange={(e) => setActualCost(Number(e.target.value))} style={fieldInputStyle} />
          </div>
          <div style={pinkFieldStyle}>
            <label style={fieldLabelStyle}>実送料支払額(¥)</label>
            <input type="number" step="1" value={actualShip} onChange={(e) => setActualShip(Number(e.target.value))} style={fieldInputStyle} />
          </div>
          <div style={pinkFieldStyle}>
            <label style={fieldLabelStyle}>為替レート（US$1.00）(¥)</label>
            <input type="number" step="0.01" value={rate} onChange={(e) => setRate(Number(e.target.value))} style={fieldInputStyle} />
            <span style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginTop: 2 }}>{rateNote}</span>
          </div>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "18px 0 0" }} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
          <div>
            <h4 style={{ fontSize: 13, color: "var(--highlight-text)", margin: "0 0 8px" }}>DDP（関税込み）</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
              <div style={tileStyle}>
                <span>売上（円）</span>
                <span>{fmtYen(revenueDdp)}</span>
              </div>
              <div style={tileStyle}>
                <span>手数料合計</span>
                <span>{fmtYen(feeTotalJpyDdp)}</span>
              </div>
              <div style={tileStyle}>
                <span>関税等合計</span>
                <span>{fmtYen(dutyTotalJpy)}</span>
              </div>
              <div style={tileStyle}>
                <span>還付・仕入控除額</span>
                <span>{fmtYen(refundDdp)}</span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
              <div style={{ ...accentTileStyle, color: profitDdp < 0 ? "var(--danger-text)" : undefined }}>
                <span>粗利益額</span>
                <span>
                  {fmtYenSigned(profitDdp)}
                  <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8 }}>粗利益率 {fmtPct(marginDdp)}</span>
                </span>
              </div>
              <div style={{ ...accentTileStyle, color: profitWithRefundDdp < 0 ? "var(--danger-text)" : undefined }}>
                <span>粗利益＋還付額 合計</span>
                <span>
                  {fmtYenSigned(profitWithRefundDdp)}
                  <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8 }}>還付込み利益率 {fmtPct(marginRefundDdp)}</span>
                </span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div style={pinkFieldStyle}>
                <label style={fieldLabelStyle}>DDP上乗せ分＋送料徴取額(USD)</label>
                <input type="number" step="0.01" value={ddpMarkup} onChange={(e) => setDdpMarkup(Number(e.target.value))} style={fieldInputStyle} />
              </div>
              <div style={pinkFieldStyle}>
                <label style={fieldLabelStyle}>関税率(%)</label>
                <input type="number" step="0.01" value={tariff} onChange={(e) => setTariff(Number(e.target.value))} style={fieldInputStyle} />
              </div>
              <div style={{ ...pinkFieldStyle, gridColumn: "span 2" }}>
                <label style={fieldLabelStyle}>通関方法（Clearance Processing）</label>
                <select value={clearance} onChange={(e) => setClearance(e.target.value)} style={fieldInputStyle}>
                  {CLEARANCE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={pinkFieldStyle}>
                <label style={fieldLabelStyle}>還付・仕入控除率</label>
                <select value={ptRateDdp} onChange={(e) => setPtRateDdp(Number(e.target.value))} style={fieldInputStyle}>
                  <option value={8}>8%</option>
                  <option value={10}>10%</option>
                </select>
              </div>
            </div>
          </div>

          <div>
            <h4 style={{ fontSize: 13, margin: "0 0 8px" }}>Non-DDP（関税別payment）</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
              <div style={tileStyle}>
                <span>売上（円）</span>
                <span>{fmtYen(revenueNon)}</span>
              </div>
              <div style={tileStyle}>
                <span>手数料合計</span>
                <span>{fmtYen(feeTotalJpyNon)}</span>
              </div>
              <div style={tileStyle}>
                <span>還付・仕入控除額</span>
                <span>{fmtYen(refundNon)}</span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
              <div style={{ ...accentTileStyle, color: profitNon < 0 ? "var(--danger-text)" : undefined }}>
                <span>粗利益額</span>
                <span>
                  {fmtYenSigned(profitNon)}
                  <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8 }}>粗利益率 {fmtPct(marginNon)}</span>
                </span>
              </div>
              <div style={{ ...accentTileStyle, color: profitWithRefundNon < 0 ? "var(--danger-text)" : undefined }}>
                <span>粗利益＋還付額 合計</span>
                <span>
                  {fmtYenSigned(profitWithRefundNon)}
                  <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8 }}>還付込み利益率 {fmtPct(marginRefundNon)}</span>
                </span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div style={pinkFieldStyle}>
                <label style={fieldLabelStyle}>送料とる場合の徴取額合計(USD)</label>
                <input
                  type="number"
                  step="0.01"
                  value={nonddpSurcharge}
                  onChange={(e) => setNonddpSurcharge(Number(e.target.value))}
                  style={fieldInputStyle}
                />
              </div>
              <div style={pinkFieldStyle}>
                <label style={fieldLabelStyle}>還付・仕入控除率</label>
                <select value={ptRateNonDdp} onChange={(e) => setPtRateNonDdp(Number(e.target.value))} style={fieldInputStyle}>
                  <option value={8}>8%</option>
                  <option value={10}>10%</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

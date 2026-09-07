export type CounterpartyType = "consumer" | "registered" | "unregistered";

export const COUNTERPARTY_TYPE_OPTIONS: { value: CounterpartyType; label: string }[] = [
  { value: "consumer", label: "消費者(個人)" },
  { value: "registered", label: "適格請求書発行事業者(インボイスあり)" },
  { value: "unregistered", label: "事業者(インボイス未登録)" },
];

export interface DeductionInfo {
  rate: number; // 0-100
  label: string;
  note: string;
}

const PHASE2_START = new Date("2026-10-01");
const PHASE3_START = new Date("2029-10-01");

/**
 * 取引先区分と日付から、消費税の仕入税額控除率を判定する。
 * - consumer: 古物商特例により古物台帳の記載を前提に常に100%
 * - registered: インボイス保存により常に100%
 * - unregistered: 経過措置対象。2023/10〜2026/9は80%、2026/10〜2029/9は50%、以降0%
 *
 * これは一般的な制度の説明に基づく簡易判定であり、税務上の最終判断ではない。
 * 個別の適用可否は顧問税理士に確認すること。
 */
export function getDeductionInfo(counterpartyType: CounterpartyType, asOf: Date = new Date()): DeductionInfo {
  if (counterpartyType === "consumer") {
    return {
      rate: 100,
      label: "古物商特例により全額控除対象",
      note: "古物台帳(Excel)に相手方氏名・住所・支払対価の額等の記載が必要です。期間限定の経過措置とは異なり、要件を満たす限り常に100%控除です。",
    };
  }
  if (counterpartyType === "registered") {
    return {
      rate: 100,
      label: "インボイス保存により全額控除対象",
      note: "仕入先から交付されたインボイス(適格請求書)を保存してください。",
    };
  }

  // unregistered: 経過措置
  if (asOf >= PHASE3_START) {
    return {
      rate: 0,
      label: "経過措置終了(控除不可)",
      note: "2029年10月以降、インボイス未登録事業者からの仕入は仕入税額控除の対象外です。",
    };
  }
  if (asOf >= PHASE2_START) {
    return {
      rate: 50,
      label: "経過措置対象(期間限定)",
      note: "2026年10月1日〜2029年9月30日は50%控除です。区分記載請求書等に相当する書類の保存と、帳簿への経過措置対象である旨の記載が必要です。",
    };
  }
  return {
    rate: 80,
    label: "経過措置対象(期間限定)",
    note: "2023年10月1日〜2026年9月30日は80%控除です。2026年10月1日から50%に変わります。区分記載請求書等に相当する書類の保存と、帳簿への経過措置対象である旨の記載が必要です。",
  };
}

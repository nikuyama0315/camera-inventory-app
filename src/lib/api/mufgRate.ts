import { supabase } from "../supabaseClient";

export interface MufgRateResult {
  year_month: string; // YYYY-MM
  ttm: number;
  tts: number;
  ttb: number;
  source_text: string;
}

/**
 * 三菱UFJ銀行公表の為替相場(TTS/TTB/TTM)を、指定した年月の月末営業日について取得する。
 * yearMonthを省略した場合は前月分を返す(後方互換のデフォルト)。
 * 1990年以降の任意の年月を指定して取得できる(Edge Function側で
 * past_3month_result.php を月末から遡って照会することで実現している)。
 */
export async function fetchLatestMufgTtm(yearMonth?: string): Promise<MufgRateResult> {
  const { data, error } = await supabase.functions.invoke("fetch-mufg-ttm", {
    body: yearMonth ? { yearMonth } : {},
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as MufgRateResult;
}

export interface MufgDailyRate {
  day: number;
  date: string; // YYYY-MM-DD
  tts: number;
  ttb: number;
  ttm: number;
}

export interface MufgMonthlyDailyResult {
  year_month: string; // YYYY-MM
  days: MufgDailyRate[];
}

/**
 * 三菱UFJ銀行公表の為替相場(TTS/TTB/TTM)を、指定した年月の営業日ぶん(最大31日)
 * 一括で取得する(経費タブ「為替」サブタブの日別推移表・折れ線グラフ用)。
 * 対象月が今月の場合は「今日」までの日数分のみ返る。土日・祝日等データの無い日は
 * 結果に含まれない。2026年1月より前の年月・未来の年月はエラーになる。
 */
export async function fetchMonthlyMufgDailyRates(yearMonth: string): Promise<MufgMonthlyDailyResult> {
  const { data, error } = await supabase.functions.invoke("fetch-mufg-ttm-daily", {
    body: { yearMonth },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as MufgMonthlyDailyResult;
}

export interface MufgCrossRateResult {
  requested_date: string; // YYYY-MM-DD
  date_used: string; // YYYY-MM-DD(休日等で遡った場合はrequested_dateと異なる)
  currency: string;
  currency_ttm_jpy: number;
  usd_ttm_jpy: number;
  rate_to_usd: number;
}

/**
 * 三菱UFJ銀行公表の為替相場から、指定した通貨(USD以外)の指定日時点における「通貨→USD」の
 * クロスレートを算出して取得する(2026-09-09追加、ユーザー指示)。
 * eBay Tax Invoice取込で、ebay_transaction_lines(注文番号一致・同日一致)からレートを
 * 自動取得できなかった通貨について、手動レート入力欄への参考値表示に使う。
 * 指定日が休日等でデータが無い場合は、Edge Function側で直近の営業日まで遡る
 * (戻り値のdate_usedで実際に使われた日付を確認できる)。
 */
export async function fetchMufgCrossRate(date: string, currency: string): Promise<MufgCrossRateResult> {
  const { data, error } = await supabase.functions.invoke("fetch-mufg-cross-rate", {
    body: { date, currency },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as MufgCrossRateResult;
}


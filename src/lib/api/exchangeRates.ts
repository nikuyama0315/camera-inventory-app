import { supabase } from "../supabaseClient";

export interface MonthlyExchangeRate {
  year_month: string; // YYYY-MM-01
  rate: number;
}

/** 登録済みの月次為替レートを全件取得し、"YYYY-MM" -> rate のマップで返す */
export async function fetchMonthlyExchangeRates(): Promise<Record<string, number>> {
  const { data, error } = await supabase.from("monthly_exchange_rates").select("year_month, rate");
  if (error) throw error;

  const map: Record<string, number> = {};
  for (const row of data as MonthlyExchangeRate[]) {
    map[row.year_month.slice(0, 7)] = row.rate;
  }
  return map;
}

/** 指定した年月(YYYY-MM)のレートを登録・更新する */
export async function upsertMonthlyExchangeRate(yearMonth: string, rate: number): Promise<void> {
  const { error } = await supabase
    .from("monthly_exchange_rates")
    .upsert({ year_month: `${yearMonth}-01`, rate }, { onConflict: "year_month" });
  if (error) throw error;
}

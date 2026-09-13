import { supabase } from "../supabaseClient";

export interface InvoiceNumberCandidate {
  id: string;
  vendor: string;
  candidate_name: string | null;
  candidate_reg_no: string | null;
  status: "pending" | "accepted" | "rejected";
  searched_at: string;
  created_at: string;
}

/**
 * 「適格請求書発行事業者番号 候補」機能(2026-09-11新規、2026-09-13に仕入先・出品者名にも対象拡大)。
 * 経費のvendor(事業者名)・仕入(purchases)のsource_name(仕入先・出品者名)から、国税庁の
 * 適格請求書発行事業者公表サイトが毎月公開する全件データ(法人・人格のない社団等分、CSV)を
 * ダウンロードして名称検索した結果を保存したもの。国税庁のWeb-APIには名称検索機能が無く
 * (登録番号での検索のみ)、個人事業主の全件データは氏名が非公開のため、この方式で見つかるのは
 * 法人・人格のない社団等のみ。検索自体は都度VPS上でスクリプトを実行して行う(scan_invoice_numbers.py)。
 * 「採用」・手動登録時は、同じ事業者名を持つexpenses.vendor・purchases.source_nameの両方のうち、
 * 登録番号が未入力の行すべてに反映する(1つの事業者名が経費・仕入の両方に登場しうるため)。
 */
export async function fetchInvoiceNumberCandidates(): Promise<InvoiceNumberCandidate[]> {
  const { data, error } = await supabase
    .from("invoice_number_candidates")
    .select("*")
    .eq("status", "pending")
    .order("vendor", { ascending: true })
    .order("candidate_name", { ascending: true });
  if (error) throw error;
  return data as InvoiceNumberCandidate[];
}

/**
 * 候補を採用する: その事業者名(vendor)を持ち、まだ登録番号が未入力の経費レコードすべてに
 * 登録番号を反映し、同じ事業者の他の候補行(このcandidateを含む)をすべて'accepted'/'rejected'に
 * 更新してリストから外す(1つの事業者につき、採用できる登録番号は実質1つのため)。
 */
export async function acceptInvoiceNumberCandidate(candidate: InvoiceNumberCandidate): Promise<number> {
  if (!candidate.candidate_reg_no) throw new Error("登録番号がありません");

  const { data: updatedExpenses, error: updateExpensesErr } = await supabase
    .from("expenses")
    .update({ invoice_registration_no: candidate.candidate_reg_no })
    .eq("vendor", candidate.vendor)
    .or("invoice_registration_no.is.null,invoice_registration_no.eq.")
    .select("id");
  if (updateExpensesErr) throw updateExpensesErr;

  const { data: updatedPurchases, error: updatePurchasesErr } = await supabase
    .from("purchases")
    .update({ invoice_registration_no: candidate.candidate_reg_no })
    .eq("source_name", candidate.vendor)
    .or("invoice_registration_no.is.null,invoice_registration_no.eq.")
    .select("id");
  if (updatePurchasesErr) throw updatePurchasesErr;

  const { error: acceptErr } = await supabase
    .from("invoice_number_candidates")
    .update({ status: "accepted" })
    .eq("id", candidate.id);
  if (acceptErr) throw acceptErr;

  const { error: rejectSiblingsErr } = await supabase
    .from("invoice_number_candidates")
    .update({ status: "rejected" })
    .eq("vendor", candidate.vendor)
    .eq("status", "pending");
  if (rejectSiblingsErr) throw rejectSiblingsErr;

  return (updatedExpenses as { id: string }[]).length + (updatedPurchases as { id: string }[]).length;
}

/** 候補を却下する(一覧から外すのみ、経費データへの反映は無し)。 */
export async function rejectInvoiceNumberCandidate(id: string): Promise<void> {
  const { error } = await supabase.from("invoice_number_candidates").update({ status: "rejected" }).eq("id", id);
  if (error) throw error;
}

/** 事業者(vendor)ごと、まとめて却下する(候補なし・全部無関係と判断した場合用)。 */
export async function rejectAllCandidatesForVendor(vendor: string): Promise<void> {
  const { error } = await supabase
    .from("invoice_number_candidates")
    .update({ status: "rejected" })
    .eq("vendor", vendor)
    .eq("status", "pending");
  if (error) throw error;
}

/**
 * 手動入力した登録番号を、その事業者名で登録番号が未入力の経費レコードすべてに反映する。
 * 簡易バリデーション(T+13桁数字)のみ行う。反映後、同じ事業者の候補行があれば却下扱いにする。
 */
export async function applyManualInvoiceNumber(vendor: string, regNo: string): Promise<number> {
  const trimmed = regNo.trim().toUpperCase();
  if (!/^T\d{13}$/.test(trimmed)) {
    throw new Error("登録番号は「T」+数字13桁の形式で入力してください(例: T1234567890123)");
  }

  const { data: updatedExpenses, error: updateExpensesErr } = await supabase
    .from("expenses")
    .update({ invoice_registration_no: trimmed })
    .eq("vendor", vendor)
    .or("invoice_registration_no.is.null,invoice_registration_no.eq.")
    .select("id");
  if (updateExpensesErr) throw updateExpensesErr;

  const { data: updatedPurchases, error: updatePurchasesErr } = await supabase
    .from("purchases")
    .update({ invoice_registration_no: trimmed })
    .eq("source_name", vendor)
    .or("invoice_registration_no.is.null,invoice_registration_no.eq.")
    .select("id");
  if (updatePurchasesErr) throw updatePurchasesErr;

  const { error: rejectErr } = await supabase
    .from("invoice_number_candidates")
    .update({ status: "rejected" })
    .eq("vendor", vendor)
    .eq("status", "pending");
  if (rejectErr) throw rejectErr;

  return (updatedExpenses as { id: string }[]).length + (updatedPurchases as { id: string }[]).length;
}


export interface InvoiceNumberScanRequest {
  id: string;
  status: "pending" | "running" | "done" | "error";
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  vendors_scanned: number | null;
  vendors_matched: number | null;
  candidates_found: number | null;
  error_message: string | null;
}

/** 最新のスキャン依頼(1件)を取得する。ボタンの状態表示用。 */
export async function fetchLatestScanRequest(): Promise<InvoiceNumberScanRequest | null> {
  const { data, error } = await supabase
    .from("invoice_number_scan_requests")
    .select("*")
    .order("requested_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data as InvoiceNumberScanRequest[])[0] ?? null;
}

/**
 * 未登録(登録番号未設定かつ未スキャン)の事業者をスキャンする依頼を出す。
 * 実際の処理(国税庁の全件データダウンロード・突合)はVPS側のcronジョブ(scan_invoice_numbers.py、
 * 10分おき)が非同期で行う。ブラウザ側では一切重い処理を行わない
 * (2026-09-12設計変更: 当初Supabase Edge Function内で処理しようとしたが、国税庁の全件データ
 * [法人分、圧縮20MB超]の展開処理がEdge FunctionのCPU時間上限[約2秒]を超えるため断念した)。
 * 既にpending/runningの依頼がある場合は新規に依頼を作らず、その依頼をそのまま返す。
 */
export async function requestInvoiceNumberScan(): Promise<InvoiceNumberScanRequest> {
  const existing = await fetchLatestScanRequest();
  if (existing && (existing.status === "pending" || existing.status === "running")) {
    return existing;
  }
  const { data, error } = await supabase
    .from("invoice_number_scan_requests")
    .insert({ status: "pending" })
    .select("*")
    .single();
  if (error) throw error;
  return data as InvoiceNumberScanRequest;
}

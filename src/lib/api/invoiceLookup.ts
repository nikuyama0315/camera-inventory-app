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
 * 「適格請求書発行事業者番号 候補」機能(2026-09-11新規)。
 * 経費に登録されている事業者名(vendor)から、国税庁の適格請求書発行事業者公表サイトが
 * 毎月公開する全件データ(法人・人格のない社団等分、CSV)をダウンロードして名称検索した結果を
 * 保存したもの。国税庁のWeb-APIには名称検索機能が無く(登録番号での検索のみ)、個人事業主の
 * 全件データは氏名が非公開のため、この方式で見つかるのは法人・人格のない社団等のみ。
 * 検索自体は都度VPS上でスクリプトを実行して行い(このテーブルへの投入は手動バッチ)、
 * ここでは候補の一覧表示・採用・却下のみを扱う。
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

  const { data: updated, error: updateErr } = await supabase
    .from("expenses")
    .update({ invoice_registration_no: candidate.candidate_reg_no })
    .eq("vendor", candidate.vendor)
    .or("invoice_registration_no.is.null,invoice_registration_no.eq.")
    .select("id");
  if (updateErr) throw updateErr;

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

  return (updated as { id: string }[]).length;
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

  const { data: updated, error: updateErr } = await supabase
    .from("expenses")
    .update({ invoice_registration_no: trimmed })
    .eq("vendor", vendor)
    .or("invoice_registration_no.is.null,invoice_registration_no.eq.")
    .select("id");
  if (updateErr) throw updateErr;

  const { error: rejectErr } = await supabase
    .from("invoice_number_candidates")
    .update({ status: "rejected" })
    .eq("vendor", vendor)
    .eq("status", "pending");
  if (rejectErr) throw rejectErr;

  return (updated as { id: string }[]).length;
}

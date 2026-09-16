import { useEffect, useState } from "react";
import type { ItemDetail } from "../../../lib/types";
import {
  fetchInspectionFieldCandidates,
  saveInspection,
  translateInspectionField,
  updateInspection,
  type InspectionFieldCandidates,
  type InspectionInput,
} from "../../../lib/api/inspections";
import {
  completeInspectionToListing,
  completeInspectionToReturnRequest,
  completeInspectionToReturned,
  markItemListed,
} from "../../../lib/api/items";
import { triggerDriveFolderMove } from "../../../lib/api/driveFolderMove";

interface Props {
  detail: ItemDetail;
  onChanged: () => void;
}

interface FieldDef {
  key: keyof Pick<
    InspectionInput,
    | "overall_notes"
    | "appearance_notes"
    | "electrical_notes"
    | "shutter_notes"
    | "aperture_exposure_notes"
    | "film_transport_notes"
    | "viewfinder_notes"
    | "lens_notes"
    | "other_notes"
  >;
  enKey: string;
  label: string;
}

// 2026-09-01: 「外観」を追加(直販プラットフォーム登録用CSVのcondition_description [Body]に対応)。
// [Total]=全体の直後に配置し、CSV出力側の並び([Total][Body][Finder][Lens][Functional])と揃えている。
const FIELDS: FieldDef[] = [
  { key: "overall_notes", enKey: "overall_notes_en", label: "全体" },
  { key: "appearance_notes", enKey: "appearance_notes_en", label: "外観" },
  { key: "electrical_notes", enKey: "electrical_notes_en", label: "電気系統(接触・通電確認)" },
  { key: "shutter_notes", enKey: "shutter_notes_en", label: "シャッター確認" },
  { key: "aperture_exposure_notes", enKey: "aperture_exposure_notes_en", label: "絞り・露出確認" },
  { key: "film_transport_notes", enKey: "film_transport_notes_en", label: "フィルム装填・巻き上げ・巻取り確認" },
  { key: "viewfinder_notes", enKey: "viewfinder_notes_en", label: "ファインダー" },
  { key: "lens_notes", enKey: "lens_notes_en", label: "レンズ" },
  { key: "other_notes", enKey: "other_notes_en", label: "その他" },
];

const CONDITION_GRADES = [
  "TOP MINT",
  "MINT",
  "Near MINT++",
  "Near MINT+",
  "Near MINT",
  "Exc +5",
  "Exc +4",
  "Exc +3",
  "For Parts",
  "Junk",
];

type FormValues = Record<string, string>;

function buildInitialValues(detail: ItemDetail): FormValues {
  const existing = detail.inspections?.[0];
  const values: FormValues = {};
  for (const f of FIELDS) {
    values[f.key] = (existing?.[f.key] as string | null) ?? "";
    values[f.enKey] = (existing?.[f.enKey as keyof typeof existing] as string | null) ?? "";
  }
  values.condition_grade = existing?.condition_grade ?? "";
  return values;
}

export default function InspectionTab({ detail, onChanged }: Props) {
  const [values, setValues] = useState<FormValues>(() => buildInitialValues(detail));
  const [translating, setTranslating] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [showReturnForm, setShowReturnForm] = useState(false);
  // 検品項目の入力候補(2026-09-16追加)。過去の検品データから頻度順に集計したものを、
  // マウント時と保存成功時(新しい値が候補に反映されるよう)に再取得する。
  const [candidates, setCandidates] = useState<InspectionFieldCandidates>({});

  function update(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function loadCandidates() {
    try {
      setCandidates(await fetchInspectionFieldCandidates());
    } catch {
      // 候補取得の失敗は入力自体をブロックしない(自由記述欄は従来通り使える)。
    }
  }

  useEffect(() => {
    void loadCandidates();
  }, []);

  async function handleTranslate(field: FieldDef) {
    const text = values[field.key];
    if (!text || !text.trim()) return;
    setTranslating(field.key);
    setErrorMessage(null);
    try {
      const translated = await translateInspectionField(text, field.key);
      update(field.enKey, translated);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "翻訳に失敗しました");
    } finally {
      setTranslating(null);
    }
  }

  async function handleSave() {
    setSaving(true);
    setErrorMessage(null);
    try {
      const notesAndGrade = {
        overall_notes: values.overall_notes || null,
        overall_notes_en: values.overall_notes_en || null,
        appearance_notes: values.appearance_notes || null,
        appearance_notes_en: values.appearance_notes_en || null,
        electrical_notes: values.electrical_notes || null,
        electrical_notes_en: values.electrical_notes_en || null,
        shutter_notes: values.shutter_notes || null,
        shutter_notes_en: values.shutter_notes_en || null,
        aperture_exposure_notes: values.aperture_exposure_notes || null,
        aperture_exposure_notes_en: values.aperture_exposure_notes_en || null,
        film_transport_notes: values.film_transport_notes || null,
        film_transport_notes_en: values.film_transport_notes_en || null,
        viewfinder_notes: values.viewfinder_notes || null,
        viewfinder_notes_en: values.viewfinder_notes_en || null,
        lens_notes: values.lens_notes || null,
        lens_notes_en: values.lens_notes_en || null,
        other_notes: values.other_notes || null,
        other_notes_en: values.other_notes_en || null,
        condition_grade: values.condition_grade || null,
      };
      const existingId = detail.inspections?.[0]?.id;
      if (existingId) {
        await updateInspection(existingId, notesAndGrade);
      } else {
        const input: InspectionInput = { item_id: detail.id, inspected_by: null, ...notesAndGrade };
        await saveInspection(input);
      }
      onChanged();
      void loadCandidates();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  async function handleCompleteToListing() {
    setSaving(true);
    setErrorMessage(null);
    try {
      await completeInspectionToListing(detail.id);
      await triggerDriveFolderMove(detail.id);
      onChanged();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  async function handleCompleteToReturnRequest() {
    if (!returnReason.trim()) {
      setErrorMessage("返品理由を入力してください");
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    try {
      await completeInspectionToReturnRequest(detail.id, returnReason);
      await triggerDriveFolderMove(detail.id);
      onChanged();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  /** 「検品済・出品待ち」→「出品中」(2026-09-04追加)。mark_item_arrived等と同じくステータスガード
   *  無しでどのステータスからでも実行可能。連動するGoogle Driveフォルダ移動も冪等なため安全。 */
  async function handleMarkListed() {
    setSaving(true);
    setErrorMessage(null);
    try {
      await markItemListed(detail.id);
      await triggerDriveFolderMove(detail.id);
      onChanged();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  /** 「検品済・返品済」への遷移(2026-09-08追加)。「着荷・検品待ち」「検品済・返品依頼中」の
   *  両方から実行できる。 */
  async function handleCompleteToReturned() {
    setSaving(true);
    setErrorMessage(null);
    try {
      await completeInspectionToReturned(detail.id);
      await triggerDriveFolderMove(detail.id);
      onChanged();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  // 2026-09-08変更: ステータス進行ボタンをこの検品タブに一本化し、常時表示(2026-09-04方式)から
  // 現在のステータスに応じた表示へ戻した(BasicInfoTab.tsxの汎用ボタンは入荷待ち→着荷・検品待ちの
  // 1段階のみに縮小)。「着荷・検品待ち」のときは3ボタン(返品依頼中にする/返品済にする/出品待ちにする)、
  // 「検品済・返品依頼中」のときは1ボタン(返品済にする)、「検品済・出品待ち」のときは1ボタン
  // (出品中にする)を表示し、それ以外のステータスでは何も表示しない。

  return (
    <div>
      {FIELDS.map((field) => (
        <div key={field.key} style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 8 }}>
            <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>{field.label}</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {(candidates[field.key]?.length ?? 0) > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) update(field.key, e.target.value);
                  }}
                  style={{ fontSize: 11, maxWidth: 540 }}
                  title="過去に入力した内容から選択"
                >
                  <option value="">候補から選択...</option>
                  {candidates[field.key].map((c) => (
                    <option key={c} value={c}>
                      {c.length > 30 ? `${c.slice(0, 30)}…` : c}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={() => handleTranslate(field)}
                disabled={translating === field.key}
                style={{ fontSize: 12, padding: "2px 10px" }}
              >
                {translating === field.key ? "翻訳中..." : "翻訳"}
              </button>
            </div>
          </div>
          <textarea
            rows={2}
            placeholder="自由記述で入力"
            value={values[field.key]}
            onChange={(e) => update(field.key, e.target.value)}
            style={{ width: "100%", marginBottom: 6 }}
          />
          {(candidates[field.enKey]?.length ?? 0) > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) update(field.enKey, e.target.value);
                }}
                style={{ fontSize: 11, maxWidth: 540 }}
                title="過去に入力した内容から選択"
              >
                <option value="">候補から選択...</option>
                {candidates[field.enKey].map((c) => (
                  <option key={c} value={c}>
                    {c.length > 30 ? `${c.slice(0, 30)}…` : c}
                  </option>
                ))}
              </select>
            </div>
          )}
          <textarea
            rows={2}
            placeholder="英訳(編集可能)"
            value={values[field.enKey]}
            onChange={(e) => update(field.enKey, e.target.value)}
            style={{ width: "100%", color: "var(--text-secondary)" }}
          />
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>状態ランク</label>
        <select value={values.condition_grade} onChange={(e) => update("condition_grade", e.target.value)}>
          <option value="">選択してください</option>
          {CONDITION_GRADES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 8 }}>{errorMessage}</p>}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={handleSave} disabled={saving}>
          検品内容を保存
        </button>
      </div>

      {detail.status === "awaiting_inspection" && (
        <div style={{ borderTop: "0.5px solid var(--border)", paddingTop: 12 }}>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
            検品完了後の対応を選択してください
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={handleCompleteToListing} disabled={saving}>
              検品済・出品待ちにする
            </button>
            <button onClick={() => setShowReturnForm((v) => !v)} disabled={saving}>
              検品済・返品依頼中にする
            </button>
            <button onClick={handleCompleteToReturned} disabled={saving}>
              検品済・返品済にする
            </button>
          </div>
          {showReturnForm && (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                placeholder="返品理由"
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                style={{ flex: 1 }}
              />
              <button onClick={handleCompleteToReturnRequest} disabled={saving}>
                返品依頼を確定
              </button>
            </div>
          )}
        </div>
      )}

      {detail.status === "inspected_return_requested" && (
        <div style={{ borderTop: "0.5px solid var(--border)", paddingTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={handleCompleteToReturned} disabled={saving}>
              検品済・返品済にする
            </button>
          </div>
        </div>
      )}

      {detail.status === "inspected_awaiting_listing" && (
        <div style={{ borderTop: "0.5px solid var(--border)", paddingTop: 12 }}>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>出品状況</p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={handleMarkListed} disabled={saving}>
              出品中にする
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

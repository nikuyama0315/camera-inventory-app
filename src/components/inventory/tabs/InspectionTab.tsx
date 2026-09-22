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
import { generateDescriptionHtml } from "../../../lib/descriptionGenerator";

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
    | "flash_notes"
    | "autofocus_notes"
    | "zoom_notes"
    | "film_counter_notes"
    | "self_timer_notes"
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
  { key: "flash_notes", enKey: "flash_notes_en", label: "フラッシュ" },
  { key: "autofocus_notes", enKey: "autofocus_notes_en", label: "オートフォーカス" },
  { key: "zoom_notes", enKey: "zoom_notes_en", label: "ズーム" },
  { key: "film_counter_notes", enKey: "film_counter_notes_en", label: "フィルムカウンター" },
  { key: "self_timer_notes", enKey: "self_timer_notes_en", label: "セルフタイマー" },
  { key: "other_notes", enKey: "other_notes_en", label: "その他" },
];

const CONDITION_GRADES = [
  "Brand New",
  "Like New",
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

/** 状態チェック表(2026-09-22追加)。OK/NGのラジオボタン、$$OKNG1$$〜$$OKNG8$$・$$WORK1$$〜$$WORK8$$の並び順と一致させる。 */
const FUNCTIONAL_CHECK_ITEMS: { key: string; label: string }[] = [
  { key: "check_shutter", label: "Shutter" },
  { key: "check_flash", label: "Flash" },
  { key: "check_autofocus", label: "Auto focus" },
  { key: "check_auto_exposure", label: "Auto exposure" },
  { key: "check_film_winding", label: "Film winding" },
  { key: "check_film_rewinding", label: "Film rewinding" },
  { key: "check_film_counter", label: "Film counter" },
  { key: "check_self_timer", label: "Self timer" },
];

/** 光学チェック表(レンズ/ファインダー共通、2026-09-22追加)。No/Few/Middle/Largeのラジオボタン。 */
const OPTICAL_CHECK_ITEMS: { suffix: "dust" | "fungus" | "haze" | "mark"; label: string }[] = [
  { suffix: "dust", label: "Dust" },
  { suffix: "fungus", label: "Fungus" },
  { suffix: "haze", label: "Haze" },
  { suffix: "mark", label: "Mark" },
];
const OPTICAL_LEVELS: { value: "none" | "few" | "middle" | "large"; label: string }[] = [
  { value: "none", label: "No" },
  { value: "few", label: "Few" },
  { value: "middle", label: "Middle" },
  { value: "large", label: "Large" },
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
  for (const item of FUNCTIONAL_CHECK_ITEMS) {
    values[item.key] = (existing?.[item.key as keyof typeof existing] as string | null) ?? "";
  }
  for (const item of OPTICAL_CHECK_ITEMS) {
    values[`optical_lens_${item.suffix}`] =
      (existing?.[`optical_lens_${item.suffix}` as keyof typeof existing] as string | null) ?? "";
    values[`optical_finder_${item.suffix}`] =
      (existing?.[`optical_finder_${item.suffix}` as keyof typeof existing] as string | null) ?? "";
  }
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
  // Description生成(2026-09-22追加)。生成結果をテキストボックスに表示、その場で編集も可能。
  const [descriptionHtml, setDescriptionHtml] = useState("");

  function handleGenerateDescription() {
    setDescriptionHtml(generateDescriptionHtml(detail, values));
  }

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
        flash_notes: values.flash_notes || null,
        flash_notes_en: values.flash_notes_en || null,
        autofocus_notes: values.autofocus_notes || null,
        autofocus_notes_en: values.autofocus_notes_en || null,
        zoom_notes: values.zoom_notes || null,
        zoom_notes_en: values.zoom_notes_en || null,
        film_counter_notes: values.film_counter_notes || null,
        film_counter_notes_en: values.film_counter_notes_en || null,
        self_timer_notes: values.self_timer_notes || null,
        self_timer_notes_en: values.self_timer_notes_en || null,
        other_notes: values.other_notes || null,
        other_notes_en: values.other_notes_en || null,
        condition_grade: values.condition_grade || null,
        check_shutter: (values.check_shutter || null) as "ok" | "ng" | null,
        check_flash: (values.check_flash || null) as "ok" | "ng" | null,
        check_autofocus: (values.check_autofocus || null) as "ok" | "ng" | null,
        check_auto_exposure: (values.check_auto_exposure || null) as "ok" | "ng" | null,
        check_film_winding: (values.check_film_winding || null) as "ok" | "ng" | null,
        check_film_rewinding: (values.check_film_rewinding || null) as "ok" | "ng" | null,
        check_film_counter: (values.check_film_counter || null) as "ok" | "ng" | null,
        check_self_timer: (values.check_self_timer || null) as "ok" | "ng" | null,
        optical_lens_dust: (values.optical_lens_dust || null) as "none" | "few" | "middle" | "large" | null,
        optical_lens_fungus: (values.optical_lens_fungus || null) as "none" | "few" | "middle" | "large" | null,
        optical_lens_haze: (values.optical_lens_haze || null) as "none" | "few" | "middle" | "large" | null,
        optical_lens_mark: (values.optical_lens_mark || null) as "none" | "few" | "middle" | "large" | null,
        optical_finder_dust: (values.optical_finder_dust || null) as "none" | "few" | "middle" | "large" | null,
        optical_finder_fungus: (values.optical_finder_fungus || null) as "none" | "few" | "middle" | "large" | null,
        optical_finder_haze: (values.optical_finder_haze || null) as "none" | "few" | "middle" | "large" | null,
        optical_finder_mark: (values.optical_finder_mark || null) as "none" | "few" | "middle" | "large" | null,
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
                  style={{ fontSize: 11, width: 620 }}
                  title="過去に入力した内容から選択"
                >
                  <option value="">候補から選択...</option>
                  {candidates[field.key].map((c) => (
                    <option key={c} value={c}>
                      {c.length > 80 ? `${c.slice(0, 80)}…` : c}
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
                style={{ fontSize: 11, width: 620 }}
                title="過去に入力した内容から選択"
              >
                <option value="">候補から選択...</option>
                {candidates[field.enKey].map((c) => (
                  <option key={c} value={c}>
                    {c.length > 140 ? `${c.slice(0, 140)}…` : c}
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

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
      <div style={{ flex: "0 0 auto" }}>
        <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
          状態チェック表
        </label>
        <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>OK</th>
              <th style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>NG</th>
              <th style={{ border: "0.5px solid var(--border)", padding: "4px 10px", textAlign: "left" }}>機能</th>
            </tr>
          </thead>
          <tbody>
            {FUNCTIONAL_CHECK_ITEMS.map((item) => (
              <tr key={item.key}>
                <td style={{ border: "0.5px solid var(--border)", padding: "4px 10px", textAlign: "center" }}>
                  <input
                    type="radio"
                    name={item.key}
                    checked={values[item.key] === "ok"}
                    onChange={() => update(item.key, "ok")}
                  />
                </td>
                <td style={{ border: "0.5px solid var(--border)", padding: "4px 10px", textAlign: "center" }}>
                  <input
                    type="radio"
                    name={item.key}
                    checked={values[item.key] === "ng"}
                    onChange={() => update(item.key, "ng")}
                  />
                </td>
                <td style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>{item.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ flex: "0 0 auto" }}>
        <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
          光学チェック表(レンズ)
        </label>
        <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}></th>
              {OPTICAL_LEVELS.map((lv) => (
                <th key={lv.value} style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>
                  {lv.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {OPTICAL_CHECK_ITEMS.map((item) => {
              const key = `optical_lens_${item.suffix}`;
              return (
                <tr key={key}>
                  <td style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>{item.label}</td>
                  {OPTICAL_LEVELS.map((lv) => (
                    <td
                      key={lv.value}
                      style={{ border: "0.5px solid var(--border)", padding: "4px 10px", textAlign: "center" }}
                    >
                      <input
                        type="radio"
                        name={key}
                        checked={values[key] === lv.value}
                        onChange={() => update(key, lv.value)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ flex: "0 0 auto" }}>
        <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
          光学チェック表(ファインダー)
        </label>
        <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}></th>
              {OPTICAL_LEVELS.map((lv) => (
                <th key={lv.value} style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>
                  {lv.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {OPTICAL_CHECK_ITEMS.map((item) => {
              const key = `optical_finder_${item.suffix}`;
              return (
                <tr key={key}>
                  <td style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>{item.label}</td>
                  {OPTICAL_LEVELS.map((lv) => (
                    <td
                      key={lv.value}
                      style={{ border: "0.5px solid var(--border)", padding: "4px 10px", textAlign: "center" }}
                    >
                      <input
                        type="radio"
                        name={key}
                        checked={values[key] === lv.value}
                        onChange={() => update(key, lv.value)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </div>

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

      <div style={{ borderTop: "0.5px solid var(--border)", paddingTop: 12, marginBottom: 16 }}>
        <button onClick={handleGenerateDescription}>Description生成</button>
        {descriptionHtml && (
          <textarea
            rows={16}
            value={descriptionHtml}
            onChange={(e) => setDescriptionHtml(e.target.value)}
            style={{ width: "100%", marginTop: 8, fontFamily: "monospace", fontSize: 11 }}
          />
        )}
      </div>

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

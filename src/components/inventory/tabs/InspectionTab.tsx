import { useState } from "react";
import type { ItemDetail } from "../../../lib/types";
import { ITEM_STATUS_LABELS } from "../../../lib/types";
import {
  saveInspection,
  translateInspectionField,
  type InspectionInput,
} from "../../../lib/api/inspections";
import {
  completeInspectionToListing,
  completeInspectionToReturnRequest,
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

  function update(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

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
      const input: InspectionInput = {
        item_id: detail.id,
        inspected_by: null,
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
      await saveInspection(input);
      onChanged();
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

  // 2026-09-04: 「着荷・検品待ち」以外のステータスからでもボタンを表示するよう変更(ユーザー指示「どのステータス
  // 状態にあっても、ステータス変更できるようにしたら不整合が起きますか?」への回答を踏まえた対応)。
  // 「検品完了・出品待ちにする」はステータスを1つ設定するだけの単純な更新なので常時実行可能にした
  // (complete_inspection_to_listing側のガードも撤廃済み)。一方「検品完了・返品依頼する」は実行のたびに
  // purchase_returnsへ新規行を挿入する副作用を持つため、二重登録を防ぐ目的で awaiting_inspection ステータス
  // からのみ実行できる制約をDB側(complete_inspection_to_return_request)に意図的に残している。
  const canCompleteInspection = true;
  const canRequestReturn = detail.status === "awaiting_inspection";

  return (
    <div>
      {FIELDS.map((field) => (
        <div key={field.key} style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>{field.label}</label>
            <button
              onClick={() => handleTranslate(field)}
              disabled={translating === field.key}
              style={{ fontSize: 12, padding: "2px 10px" }}
            >
              {translating === field.key ? "翻訳中..." : "翻訳"}
            </button>
          </div>
          <textarea
            rows={2}
            placeholder="自由記述で入力"
            value={values[field.key]}
            onChange={(e) => update(field.key, e.target.value)}
            style={{ width: "100%", marginBottom: 6 }}
          />
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

      {canCompleteInspection && (
        <div style={{ borderTop: "0.5px solid var(--border)", paddingTop: 12 }}>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
            検品完了後の対応を選択してください
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
            {/* 2026-09-04バグ修正(ユーザー指摘、3段階で修正、BasicInfoTabの「到着済みにする」ボタンと
                同じ経緯): 「現在のステータスが遷移先(inspected_awaiting_listing)と一致する場合のみ」
                →「awaiting_inspectionのときだけ行動を促す文言、それ以外は常にステータス名」の順で
                修正したが、後者だと「入荷待ち(awaiting_arrival)」の商品でもステータス名(「入荷待ち」)
                が表示されてしまい、実際には押せば検品済・出品待ちまで一気に進められる(スキップして
                進める設計を維持している)にもかかわらず行動を促す文言が消えてしまっていた
                (ユーザー指摘「出品中にすべきでは？」は、逆に出品中の商品でこのボタンが「検品完了・
                出品待ちにする」のままだった旧不具合を指しており、両方の指摘を踏まえて最終的なルールを
                「遷移先(inspected_awaiting_listing)より前の状態(awaiting_arrival・awaiting_inspection)
                のときだけ行動を促す文言、それ以外(検品済・出品待ち以降、または返品系の分岐)は常に
                現在のステータス名を表示する」に一般化した。 */}
            <button onClick={handleCompleteToListing} disabled={saving}>
              {detail.status === "awaiting_arrival" || detail.status === "awaiting_inspection"
                ? "検品完了・出品待ちにする"
                : ITEM_STATUS_LABELS[detail.status]}
            </button>
            <button onClick={() => setShowReturnForm((v) => !v)} disabled={saving}>
              検品完了・返品依頼する
            </button>
          </div>
          {/* 2026-09-04: ボタンを常時表示にしたことで、押した後も同じボタンが表示され続け「反映されて
              いないのでは」と誤解される不具合が発生したため(ユーザー報告、BasicInfoTabの「到着済みに
              する」ボタンと同じ事象)、現在のステータスと、押すと何が起きるかを明示する注記を追加した。
              遷移先(inspected_awaiting_listing)と現在のステータスが同じ場合は、上のボタン表記で既に
              現在のステータスがわかるため、この注記自体を表示しないよう条件を修正した。 */}
          {detail.status !== "awaiting_inspection" && detail.status !== "inspected_awaiting_listing" && (
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
              (現在のステータス:「{ITEM_STATUS_LABELS[detail.status]}」。「検品完了・出品待ちにする」を押すと「
              {ITEM_STATUS_LABELS.inspected_awaiting_listing}」に変更されます)
            </p>
          )}
          {!canRequestReturn && (
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
              (「返品依頼する」は「着荷・検品待ち」ステータスのときのみ実行できます)
            </p>
          )}
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

      {/* 2026-09-04追加: ユーザー指示「その後のステータスも順々に次のステータスがボタンに表示されて
          適用できるようにしてください」に対応し、「検品済・出品待ち」の次のステータスである「出品中」への
          専用ボタンを追加。「出品」専用のタブがまだ無いため(将来Phase3/4で追加予定、ItemDetailPane.tsxの
          TABS配列コメント参照)、暫定的に検品タブの末尾に配置している。他の専用ボタンと同じく、現在の
          ステータスによらず実行可能(mark_item_listed側にステータスガード無し)。 */}
      {/* 2026-09-04バグ修正(ユーザー指摘「ボタン表記を「出品中にする」であるべきでは？」、上の
          「検品完了・出品待ちにする」ボタンと同じ最終ルール): 遷移先(listed)より前の状態
          (awaiting_arrival・awaiting_inspection・inspected_awaiting_listing、いずれもスキップして
          「出品中」まで一気に進められる)のときは行動を促す文言「出品中にする」を表示し、それ以外
          (listed以降、または返品系の分岐)は常に現在のステータス名を表示する。 */}
      <div style={{ borderTop: "0.5px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>出品状況</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={handleMarkListed} disabled={saving}>
            {detail.status === "awaiting_arrival" ||
            detail.status === "awaiting_inspection" ||
            detail.status === "inspected_awaiting_listing"
              ? "出品中にする"
              : ITEM_STATUS_LABELS[detail.status]}
          </button>
          {detail.status !== "inspected_awaiting_listing" && detail.status !== "listed" && (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              (現在のステータス:「{ITEM_STATUS_LABELS[detail.status]}」。押すと「{ITEM_STATUS_LABELS.listed}」に変更されます)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

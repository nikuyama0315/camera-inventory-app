import { useEffect, useRef, useState } from "react";
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
  fetchItemDetail,
  searchItemsForInspectionAutofill,
  type ItemAutofillCandidate,
} from "../../../lib/api/items";
import { triggerDriveFolderMove } from "../../../lib/api/driveFolderMove";
import { generateDescriptionHtml, generateSellerNoteText, generateSoulcameraItemInfo } from "../../../lib/descriptionGenerator";
import { computeDriveLocalPath, windowsPathToOpenFolderUrl } from "../../../lib/constants";
import { saveGeneratedListingData } from "../../../lib/api/listingDraft";

/** 2026-09-25追加: コピーボタン用のアイコン(コードブロックのコピーボタンと同じ、
 *  2枚の四角が重なったデザイン)。絵文字ではなくSVGで統一する。 */
function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

interface Props {
  detail: ItemDetail;
  onChanged: () => void;
  /** 2026-09-23追加: タブ行の「Description生成へ」ボタンから遷移してきたときの、
   *  Description生成セクションへのスクロールトリガー。親(ItemDetailPane)が押すたびインクリメントする。 */
  scrollToDescriptionTrigger?: number;
  /** 2026-09-27追加: 「出品」ボタン用。押すと生成データを保存した上で出品タブへ切り替える。 */
  onGoToListing?: () => void;
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
  /** 2026-09-22追加(ユーザー指示): trueのときラベルを赤太字で強調表示する。 */
  highlight?: boolean;
}

// 2026-09-01: 「外観」を追加(直販プラットフォーム登録用CSVのcondition_description [Body]に対応)。
// [Total]=全体の直後に配置し、CSV出力側の並び([Total][Body][Finder][Lens][Functional])と揃えている。
const FIELDS: FieldDef[] = [
  { key: "overall_notes", enKey: "overall_notes_en", label: "全体", highlight: true },
  { key: "appearance_notes", enKey: "appearance_notes_en", label: "外観", highlight: true },
  { key: "electrical_notes", enKey: "electrical_notes_en", label: "電気系統(接触・通電確認)", highlight: true },
  { key: "shutter_notes", enKey: "shutter_notes_en", label: "シャッター確認" },
  { key: "aperture_exposure_notes", enKey: "aperture_exposure_notes_en", label: "絞り・露出確認" },
  { key: "film_transport_notes", enKey: "film_transport_notes_en", label: "フィルム装填・巻き上げ・巻取り確認" },
  { key: "viewfinder_notes", enKey: "viewfinder_notes_en", label: "ファインダー", highlight: true },
  { key: "lens_notes", enKey: "lens_notes_en", label: "レンズ", highlight: true },
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
  values.functional_check_notes = existing?.functional_check_notes ?? "";
  values.optical_check_lens_notes = existing?.optical_check_lens_notes ?? "";
  values.optical_check_finder_notes = existing?.optical_check_finder_notes ?? "";
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

export default function InspectionTab({ detail, onChanged, scrollToDescriptionTrigger, onGoToListing }: Props) {
  const [values, setValues] = useState<FormValues>(() => buildInitialValues(detail));
  const [translating, setTranslating] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [showReturnForm, setShowReturnForm] = useState(false);
  // 検品項目の入力候補(2026-09-16追加)。過去の検品データから頻度順に集計したものを、
  // マウント時と保存成功時(新しい値が候補に反映されるよう)に再取得する。
  const [candidates, setCandidates] = useState<InspectionFieldCandidates>({});
  // 候補選択欄(2026-09-23変更: <select>からinput+datalist方式に変更し、文字列入力で候補を
  // 絞り込めるようにした)。選択欄自体の入力途中の文字列を、フィールドキーごとに保持する
  // (実際の値(values[key])とは別管理。候補と完全一致した時点でvaluesへ反映し、この欄は空に戻す)。
  const [candidateSearch, setCandidateSearch] = useState<Record<string, string>>({});
  // Description生成(2026-09-22追加)。生成結果をテキストボックスに表示、その場で編集も可能。
  const [descriptionHtml, setDescriptionHtml] = useState("");
  const [sellerNoteText, setSellerNoteText] = useState("");
  const [itemTitleText, setItemTitleText] = useState("");
  const [soulcameraItemInfo, setSoulcameraItemInfo] = useState("");
  const descriptionSectionRef = useRef<HTMLDivElement>(null);
  // 2026-09-25追加: 生成したテキストボックスの内容をコピーするボタン用。コピー直後だけ
  // 「コピーしました」を表示するため、どちらのボックスをコピーしたかを保持する。
  const [copiedField, setCopiedField] = useState<"html" | "text" | "itemTitle" | "soulcameraInfo" | null>(null);
  // 2026-09-25追加: 「登録済みアイテムからオートフィル」機能用。管理番号・ブランド/機種の
  // 部分一致で他の商品を検索し、選択した商品の検品内容(FIELDS・状態ランク・各チェック表)を
  // この画面の入力エリアへ丸ごとセットする(あくまで画面上の値のみ変更、保存は別途「検品内容を
  // 保存」を押すまで行われない)。
  const [autofillQuery, setAutofillQuery] = useState("");
  const [autofillCandidates, setAutofillCandidates] = useState<ItemAutofillCandidate[]>([]);
  const [autofillBusy, setAutofillBusy] = useState(false);
  const [autofillFeedback, setAutofillFeedback] = useState<string | null>(null);

  // 2026-09-23追加: タブ行の「Description生成へ」ボタンから遷移してきたとき、
  // このセクションまで自動スクロールする(0=初期値のときは何もしない)。
  useEffect(() => {
    if (!scrollToDescriptionTrigger) return;
    descriptionSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollToDescriptionTrigger]);

  function handleGenerateDescription() {
    setDescriptionHtml(generateDescriptionHtml(detail, values));
    setSellerNoteText(generateSellerNoteText(detail, values));
    setItemTitleText(detail.item_title ?? "");
    setSoulcameraItemInfo(generateSoulcameraItemInfo(detail));
  }

  // 2026-09-27追加(ユーザー指示): 「生成データ保存」ボタン用。ITEM TITLE・Soulcamera Item Info・
  // Description HTML・Seller noteテキストの4項目をitem_listing_draftsへ保存し、新設の「出品」タブ側で
  // オートフィル表示できるようにする(出品タブ自体の他項目には触れない)。
  const [savingGeneratedData, setSavingGeneratedData] = useState(false);
  const [saveGeneratedDataMessage, setSaveGeneratedDataMessage] = useState<string | null>(null);

  async function handleSaveGeneratedData() {
    setSavingGeneratedData(true);
    setSaveGeneratedDataMessage(null);
    try {
      await saveGeneratedListingData(detail.id, {
        item_title: itemTitleText,
        soulcamera_item_info: soulcameraItemInfo,
        description_html: descriptionHtml,
        seller_note_text: sellerNoteText,
      });
      setSaveGeneratedDataMessage("保存しました");
    } catch (err) {
      setSaveGeneratedDataMessage(err instanceof Error ? `保存に失敗しました: ${err.message}` : "保存に失敗しました");
    } finally {
      setSavingGeneratedData(false);
    }
  }

  // 2026-09-27追加(ユーザー指示): 「出品」ボタン用。「生成データ保存」と同じ内容を保存した上で
  // 出品タブへ切り替える(出品タブ自身のオートフィルは、切り替え時にこの保存済みデータから行われる)。
  const [goingToListing, setGoingToListing] = useState(false);
  async function handleGoToListing() {
    setGoingToListing(true);
    try {
      await saveGeneratedListingData(detail.id, {
        item_title: itemTitleText,
        soulcamera_item_info: soulcameraItemInfo,
        description_html: descriptionHtml,
        seller_note_text: sellerNoteText,
      });
      onGoToListing?.();
    } catch (err) {
      setSaveGeneratedDataMessage(err instanceof Error ? `保存に失敗しました: ${err.message}` : "保存に失敗しました");
    } finally {
      setGoingToListing(false);
    }
  }

  /** 2026-09-26追加: 「画像保管フォルダを開く」ボタン用。BasicInfoTab.tsxの同名機能と同じ
   *  openfolder:// ハンドラ方式(各PCにインストール済み)でWindowsのエクスプローラーを直接開く。 */
  const imageFolderDriveFolder = detail.item_drive_folders?.[0];
  const imageFolderLocalPath = imageFolderDriveFolder
    ? computeDriveLocalPath(
        imageFolderDriveFolder.current_stage,
        imageFolderDriveFolder.model_folder_name,
        imageFolderDriveFolder.item_folder_name,
      )
    : null;
  function handleOpenImageFolder() {
    if (!imageFolderLocalPath) return;
    window.open(windowsPathToOpenFolderUrl(imageFolderLocalPath), "_blank", "noopener,noreferrer");
  }

  /** 2026-09-23追加: 生成したDescription HTMLを、そのままブラウザの新しいタブで開いて見た目を確認できるようにする。
   *  Blob URLを使う(テキストエリア編集後の最新の内容を都度反映するため、生成のたびに新しいURLを作る)。 */
  function handleViewDescriptionInBrowser() {
    const blob = new Blob([descriptionHtml], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /** 2026-09-25追加: Description(HTML)・セラーノート(プレーンテキスト)それぞれのテキストボックスの
   *  内容をクリップボードへコピーする。1.5秒だけ「コピーしました」を表示する。 */
  /**
   * 2026-09-25修正(ユーザー報告「コピーボタンを押してもコピーされない」): このアプリは
   * http://(非HTTPS)で配信しているため、ブラウザは非セキュアコンテキストとしてnavigator.clipboard
   * 自体を無効化する(Chrome等)。navigator.clipboard.writeText()を呼ぶとTypeError/例外になり、
   * 何も起きていないように見えていた。非表示のtextarea+document.execCommand('copy')方式
   * (非HTTPSでも動作する旧来のAPI)にフォールバックする。
   */
  async function handleCopyGeneratedText(text: string, field: "html" | "text" | "itemTitle" | "soulcameraInfo") {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!ok) throw new Error("コピーに失敗しました(このブラウザではサポートされていません)");
      }
      setCopiedField(field);
      setTimeout(() => setCopiedField((prev) => (prev === field ? null : prev)), 1500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "コピーに失敗しました");
    }
  }

  function update(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  /** 候補選択欄(input+datalist)の入力ハンドラ。入力値が候補一覧と完全一致した時点(=datalistから
   *  選択、またはユーザーが候補と同じ文字列まで手入力した時点)で実際の値へ反映し、選択欄は空に戻す。
   *  一致しない間は絞り込み中の文字列として保持するだけで、実際の値には反映しない。 */
  function handleCandidateInput(key: string, list: string[] | undefined, raw: string) {
    if (list?.includes(raw)) {
      update(key, raw);
      setCandidateSearch((prev) => ({ ...prev, [key]: "" }));
    } else {
      setCandidateSearch((prev) => ({ ...prev, [key]: raw }));
    }
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

  // 2026-09-25追加: オートフィル検索欄の入力を300msデバウンスして検索する。
  useEffect(() => {
    const q = autofillQuery.trim();
    if (!q) {
      setAutofillCandidates([]);
      return;
    }
    const handle = setTimeout(() => {
      searchItemsForInspectionAutofill(q, detail.id)
        .then(setAutofillCandidates)
        .catch(() => setAutofillCandidates([]));
    }, 300);
    return () => clearTimeout(handle);
  }, [autofillQuery, detail.id]);

  function autofillCandidateLabel(c: ItemAutofillCandidate): string {
    const brandModel = [c.brand, c.model].filter(Boolean).join(" ");
    return brandModel ? `${c.management_no} ・ ${brandModel}` : c.management_no;
  }

  async function handleApplyAutofill(candidate: ItemAutofillCandidate) {
    setAutofillBusy(true);
    setAutofillFeedback(null);
    try {
      const srcDetail = await fetchItemDetail(candidate.id);
      if (!srcDetail.inspections || srcDetail.inspections.length === 0) {
        setAutofillFeedback(`${candidate.management_no}には検品データが登録されていません`);
        return;
      }
      setValues(buildInitialValues(srcDetail));
      setAutofillFeedback(`${candidate.management_no}の検品内容を反映しました(画面上の値のみ変更、保存は「検品内容を保存」を押すまで行われません)`);
    } catch (err) {
      setAutofillFeedback(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setAutofillBusy(false);
      setAutofillQuery("");
      setAutofillCandidates([]);
    }
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
        functional_check_notes: values.functional_check_notes || null,
        optical_check_lens_notes: values.optical_check_lens_notes || null,
        optical_check_finder_notes: values.optical_check_finder_notes || null,
        check_shutter: (values.check_shutter || null) as "ok" | "ng" | "na" | null,
        check_flash: (values.check_flash || null) as "ok" | "ng" | "na" | null,
        check_autofocus: (values.check_autofocus || null) as "ok" | "ng" | "na" | null,
        check_auto_exposure: (values.check_auto_exposure || null) as "ok" | "ng" | "na" | null,
        check_film_winding: (values.check_film_winding || null) as "ok" | "ng" | "na" | null,
        check_film_rewinding: (values.check_film_rewinding || null) as "ok" | "ng" | "na" | null,
        check_film_counter: (values.check_film_counter || null) as "ok" | "ng" | "na" | null,
        check_self_timer: (values.check_self_timer || null) as "ok" | "ng" | "na" | null,
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
      {/* 2026-09-25追加(ユーザー指示): 登録済みアイテムからオートフィル。管理番号・ブランド/機種の
          部分一致で検索し、選択した商品の検品内容(FIELDS・状態ランク・各チェック表)をこの画面の
          入力エリアへ丸ごとセットする。 */}
      <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: "0.5px solid var(--border)" }}>
        <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
          登録済みアイテムからオートフィル(管理番号またはブランド/機種で検索)
        </label>
        <input
          type="text"
          list="inspection-autofill-candidates"
          value={autofillQuery}
          onChange={(e) => {
            const v = e.target.value;
            setAutofillQuery(v);
            const match = autofillCandidates.find((c) => autofillCandidateLabel(c) === v);
            if (match) void handleApplyAutofill(match);
          }}
          placeholder="例: 260913-14 / Kyocera TD"
          disabled={autofillBusy}
          style={{ width: 340 }}
        />
        <datalist id="inspection-autofill-candidates">
          {autofillCandidates.map((c) => (
            <option key={c.id} value={autofillCandidateLabel(c)} />
          ))}
        </datalist>
        {autofillFeedback && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 0" }}>{autofillFeedback}</p>
        )}
      </div>

      {FIELDS.map((field) => (
        <div key={field.key} style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 8 }}>
            <label
              style={{
                fontSize: 13,
                color: field.highlight ? "var(--highlight-text)" : "var(--text-secondary)",
                fontWeight: field.highlight ? 700 : undefined,
              }}
            >
              {field.label}
            </label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {(candidates[field.key]?.length ?? 0) > 0 && (
                <>
                  <input
                    type="text"
                    list={`candidates-${field.key}`}
                    value={candidateSearch[field.key] ?? ""}
                    onChange={(e) => handleCandidateInput(field.key, candidates[field.key], e.target.value)}
                    placeholder="候補から選択(入力して絞り込み)..."
                    style={{ fontSize: 11, width: 620 }}
                    title="過去に入力した内容から選択(文字列を入力すると候補を絞り込めます)"
                  />
                  <datalist id={`candidates-${field.key}`}>
                    {candidates[field.key].map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </>
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
              <input
                type="text"
                list={`candidates-${field.enKey}`}
                value={candidateSearch[field.enKey] ?? ""}
                onChange={(e) => handleCandidateInput(field.enKey, candidates[field.enKey], e.target.value)}
                placeholder="候補から選択(入力して絞り込み)..."
                style={{ fontSize: 11, width: 620 }}
                title="過去に入力した内容から選択(文字列を入力すると候補を絞り込めます)"
              />
              <datalist id={`candidates-${field.enKey}`}>
                {candidates[field.enKey].map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
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
        <label style={{ fontSize: 13, color: "var(--danger-text)", fontWeight: 700, display: "block", marginBottom: 4 }}>
          状態チェック表
        </label>
        <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>OK</th>
              <th style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>NG</th>
              <th style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>N/A</th>
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
                <td style={{ border: "0.5px solid var(--border)", padding: "4px 10px", textAlign: "center" }}>
                  <input
                    type="radio"
                    name={item.key}
                    checked={values[item.key] === "na"}
                    onChange={() => update(item.key, "na")}
                  />
                </td>
                <td style={{ border: "0.5px solid var(--border)", padding: "4px 10px" }}>{item.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* 2026-09-23追加: 状態チェック表の下の自由記述欄。Description HTMLではSelf timer行の
            下に、入力があるときのみ表示する(descriptionGenerator.tsのFUNCTIONALNOTES参照)。 */}
        <textarea
          rows={2}
          placeholder="状態チェック表の補足(自由記述)"
          value={values.functional_check_notes}
          onChange={(e) => update("functional_check_notes", e.target.value)}
          style={{ width: "100%", marginTop: 6, fontSize: 12 }}
        />
      </div>

      <div style={{ flex: "0 0 auto" }}>
        <label style={{ fontSize: 13, color: "var(--danger-text)", fontWeight: 700, display: "block", marginBottom: 4 }}>
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
        {/* 2026-09-23追加: 光学チェック表(レンズ)の下の自由記述欄。Description HTMLでは
            Optics Inspectionの下に、入力があるときのみ表示する(descriptionGenerator.tsのOPTICALCHECKNOTES参照)。 */}
        <textarea
          rows={2}
          placeholder="光学チェック表(レンズ)の補足(自由記述)"
          value={values.optical_check_lens_notes}
          onChange={(e) => update("optical_check_lens_notes", e.target.value)}
          style={{ width: "100%", marginTop: 6, fontSize: 12 }}
        />
      </div>

      <div style={{ flex: "0 0 auto" }}>
        <label style={{ fontSize: 13, color: "var(--danger-text)", fontWeight: 700, display: "block", marginBottom: 4 }}>
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
        {/* 2026-09-23追加: 光学チェック表(ファインダー)の下の自由記述欄。Description HTMLでは
            Optics Inspectionの下に、入力があるときのみ表示する(descriptionGenerator.tsのOPTICALCHECKNOTES参照)。 */}
        <textarea
          rows={2}
          placeholder="光学チェック表(ファインダー)の補足(自由記述)"
          value={values.optical_check_finder_notes}
          onChange={(e) => update("optical_check_finder_notes", e.target.value)}
          style={{ width: "100%", marginTop: 6, fontSize: 12 }}
        />
      </div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <label style={{ fontSize: 13, color: "var(--danger-text)", fontWeight: 700 }}>状態ランク</label>
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

      <div ref={descriptionSectionRef} style={{ borderTop: "0.5px solid var(--border)", paddingTop: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={handleGenerateDescription} style={{ width: "fit-content" }}>
              Description生成
            </button>
            <button
              type="button"
              onClick={handleSaveGeneratedData}
              disabled={savingGeneratedData || !(itemTitleText || soulcameraItemInfo || descriptionHtml || sellerNoteText)}
              style={{ width: "fit-content" }}
            >
              {savingGeneratedData ? "保存中..." : "生成データ保存"}
            </button>
            {saveGeneratedDataMessage && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{saveGeneratedDataMessage}</span>
            )}
            <button
              type="button"
              onClick={handleOpenImageFolder}
              disabled={!imageFolderLocalPath}
              title={imageFolderLocalPath ?? "画像保管フォルダの場所が特定できません"}
              style={{ width: "fit-content" }}
            >
              画像保管フォルダを開く
            </button>
            <button
              type="button"
              onClick={() => void handleGoToListing()}
              disabled={goingToListing || !onGoToListing}
              style={{ width: "fit-content" }}
            >
              {goingToListing ? "保存中..." : "出品"}
            </button>
          </div>
          {itemTitleText && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text-secondary)", width: 150 }}>ITEM TITLE:</span>
              <input
                type="text"
                value={itemTitleText}
                onChange={(e) => setItemTitleText(e.target.value)}
                style={{ fontFamily: "monospace", fontSize: 12, width: 400 }}
              />
              {copiedField === "itemTitle" && (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>コピーしました</span>
              )}
              <button
                onClick={() => handleCopyGeneratedText(itemTitleText, "itemTitle")}
                title="コピー"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: 26,
                  padding: 0,
                  border: "0.5px solid var(--border-strong)",
                  borderRadius: 6,
                  background: "var(--surface-2)",
                  color: "var(--text-secondary)",
                }}
              >
                <CopyIcon />
              </button>
            </div>
          )}
          {soulcameraItemInfo && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text-secondary)", width: 150 }}>Soulcamera Item Info:</span>
              <input
                type="text"
                value={soulcameraItemInfo}
                onChange={(e) => setSoulcameraItemInfo(e.target.value)}
                style={{ fontFamily: "monospace", fontSize: 12, width: 260 }}
              />
              {copiedField === "soulcameraInfo" && (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>コピーしました</span>
              )}
              <button
                onClick={() => handleCopyGeneratedText(soulcameraItemInfo, "soulcameraInfo")}
                title="コピー"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: 26,
                  padding: 0,
                  border: "0.5px solid var(--border-strong)",
                  borderRadius: 6,
                  background: "var(--surface-2)",
                  color: "var(--text-secondary)",
                }}
              >
                <CopyIcon />
              </button>
            </div>
          )}
        </div>
        {(descriptionHtml || sellerNoteText) && (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
            <div style={{ flex: 1, minWidth: 320, display: "flex", flexDirection: "column" }}>
              {/* 2026-09-25変更(ユーザー指示): コピーボタンをテキストボックスの外、右上端に配置。
                  コードブロックのコピーボタンと同じアイコンデザイン(絵文字ではなくSVG)を使う。 */}
              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, marginBottom: 4 }}>
                {copiedField === "html" && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>コピーしました</span>
                )}
                <button
                  onClick={() => handleCopyGeneratedText(descriptionHtml, "html")}
                  disabled={!descriptionHtml.trim()}
                  title="コピー"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 26,
                    height: 26,
                    padding: 0,
                    border: "0.5px solid var(--border-strong)",
                    borderRadius: 6,
                    background: "var(--surface-2)",
                    color: "var(--text-secondary)",
                  }}
                >
                  <CopyIcon />
                </button>
              </div>
              <textarea
                rows={16}
                value={descriptionHtml}
                onChange={(e) => setDescriptionHtml(e.target.value)}
                style={{ fontFamily: "monospace", fontSize: 11 }}
              />
              <button
                onClick={handleViewDescriptionInBrowser}
                disabled={!descriptionHtml.trim()}
                style={{ marginTop: 6, width: "fit-content" }}
              >
                ブラウザで見る
              </button>
            </div>
            <div style={{ flex: 1, minWidth: 320, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, marginBottom: 4 }}>
                {copiedField === "text" && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>コピーしました</span>
                )}
                <button
                  onClick={() => handleCopyGeneratedText(sellerNoteText, "text")}
                  disabled={!sellerNoteText.trim()}
                  title="コピー"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 26,
                    height: 26,
                    padding: 0,
                    border: "0.5px solid var(--border-strong)",
                    borderRadius: 6,
                    background: "var(--surface-2)",
                    color: "var(--text-secondary)",
                  }}
                >
                  <CopyIcon />
                </button>
              </div>
              <textarea
                rows={16}
                value={sellerNoteText}
                onChange={(e) => setSellerNoteText(e.target.value)}
                style={{ fontFamily: "monospace", fontSize: 11 }}
              />
            </div>
          </div>
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

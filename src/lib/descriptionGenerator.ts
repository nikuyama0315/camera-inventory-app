import type { ItemDetail } from "./types";

/**
 * eBay出品説明文(Description)の生成テンプレート。$$VARNAME$$形式のプレースホルダーを
 * generateDescriptionHtml()で実際の値に置換する。
 */
const DESCRIPTION_TEMPLATE = `<div itemscope="" itemtype="https://schema.org/Product" style="max-width: 700px; margin: 0px auto; background: rgb(255, 255, 255); padding: 12px 4px; box-sizing: border-box;">

  <h2 itemprop="name" style="margin: 0px 0px 4px; line-height: 1.3;"><font color="#1e2226" face="Georgia, Times New Roman, serif"><span style="font-size: 23px;">$$ITEMTITLE$$</span></font></h2>
  <p style="color: rgb(110, 115, 120); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 18px; letter-spacing: 0.08em; text-transform: uppercase; font-size: 12pt;">Inspected &amp; Graded in Japan · Admin No. $$ADMINNO$$</p>

  <div itemprop="itemCondition" content="https://schema.org/UsedCondition" style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; display: inline-block; border: 2px solid rgb(168, 103, 43); font-weight: bold; text-align: center; padding: 6px 14px; margin: 0px 0px 18px;">
    GRADE $$CONDITION1$$ $$GRADEPERCENT$$ ($$STATUS$$)
  </div>

  <p itemprop="description" style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 0px 0px 20px; font-size: 14px; line-height: 1.75;">$$OVERALL$$ Graded $$CONDITION1$$ ($$GRADEPERCENT$$) on our internal scale: $$GRADETEXT$$. Photos are of the actual item and are considered part of the description. Please review them closely.</p>

  <div style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 0px 0px 26px; padding: 14px 16px; background: rgb(247, 246, 242); border: 1px solid rgb(228, 226, 219); line-height: 1.7;">
    <p style="margin: 0px 0px 8px; font-family: &quot;Courier New&quot;, Courier, monospace; letter-spacing: 0.1em; color: rgb(110, 115, 120); text-transform: uppercase;"><font size="4" style="font-weight:bold;color:#a8672b;">Quick Facts</font></p><table aria-label="Quick Facts" style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px;line-height:1.7;"><tbody>
<tr><th scope="row" style="width:130px;padding:3px 14px 3px 0;text-align:left;vertical-align:top;font-weight:bold;">Brand / Model</th><td style="padding:3px 0;text-align:left;vertical-align:top;overflow-wrap:anywhere;">$$BRAND$$&nbsp; $$MODEL$$</td></tr>
<tr><th scope="row" style="width:130px;padding:3px 14px 3px 0;text-align:left;vertical-align:top;font-weight:bold;">Type</th><td style="padding:3px 0;text-align:left;vertical-align:top;overflow-wrap:anywhere;">$$TYPE$$</td></tr>
<tr><th scope="row" style="width:130px;padding:3px 14px 3px 0;text-align:left;vertical-align:top;font-weight:bold;">Condition</th><td style="padding:3px 0;text-align:left;vertical-align:top;overflow-wrap:anywhere;">$$STATUS$$, Grade $$CONDITION1$$ ($$GRADEPERCENT$$)</td></tr>
<tr><th scope="row" style="width:130px;padding:3px 14px 3px 0;text-align:left;vertical-align:top;font-weight:bold;">Admin No.</th><td style="padding:3px 0;text-align:left;vertical-align:top;overflow-wrap:anywhere;">$$ADMINNO$$</td></tr>
<tr><th scope="row" style="width:130px;padding:3px 14px 3px 0;text-align:left;vertical-align:top;font-weight:bold;">Body Serial No.</th><td style="padding:3px 0;text-align:left;vertical-align:top;overflow-wrap:anywhere;">$$BODYSN$$</td></tr>
<tr><th scope="row" style="width:130px;padding:3px 14px 3px 0;text-align:left;vertical-align:top;font-weight:bold;">Lens Serial No.</th><td style="padding:3px 0;text-align:left;vertical-align:top;overflow-wrap:anywhere;">$$LENSSN$$</td></tr>
<tr><th scope="row" style="width:130px;padding:3px 14px 3px 0;text-align:left;vertical-align:top;font-weight:bold;">Tested functions</th><td style="padding:3px 0;text-align:left;vertical-align:top;overflow-wrap:anywhere;">$$TESTEDFUNC$$ : Confirmed working</td></tr>
<tr><th scope="row" style="width:130px;padding:3px 14px 3px 0;text-align:left;vertical-align:top;font-weight:bold;">Includes</th><td style="padding:3px 0;text-align:left;vertical-align:top;overflow-wrap:anywhere;">As shown in the listing photos. ($$INCLUDES$$)</td></tr>
</tbody></table>
  </div>

  <h3 style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 10px; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1px solid rgb(217, 220, 221); padding-bottom: 6px; font-weight: normal;"><font size="4">■ Appearance</font></h3>
  <ul style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 0px 0px 24px; padding-left: 20px; font-size: 14px; line-height: 1.8;">
    <li>$$EXTERIOR$$, consistent with our $$CONDITION1$$ ($$GRADEPERCENT$$) grade: $$GRADETEXT$$.</li>
    <li>$$ELECTRICITY$$.</li>
    <li>Please refer to all listing photos for a full visual assessment of the actual item.</li>
  </ul>

  <h3 style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 10px; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1px solid rgb(217, 220, 221); padding-bottom: 6px; font-weight: normal;"><font size="4">■ Functional Check</font></h3>
  <ul style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 0px 0px 24px; padding-left: 0px; list-style: none; font-size: 14px; line-height: 1.9;">
    <li>$$OKNG1$$&nbsp;<strong>$$WORK1$$</strong>&nbsp;—&nbsp;Shutter</li>
    <li>$$OKNG2$$&nbsp;<strong>$$WORK2$$</strong>&nbsp;—&nbsp;Flash</li>
    <li>$$OKNG3$$&nbsp;<strong>$$WORK3$$</strong>&nbsp;—&nbsp;Auto focus</li>
    <li>$$OKNG4$$&nbsp;<strong>$$WORK4$$</strong>&nbsp;—&nbsp;Auto exposure</li>
    <li>$$OKNG5$$&nbsp;<strong>$$WORK5$$</strong>&nbsp;—&nbsp;Film winding</li>
    <li>$$OKNG6$$&nbsp;<strong>$$WORK6$$</strong>&nbsp;—&nbsp;Film rewinding</li>
    <li>$$OKNG7$$&nbsp;<strong>$$WORK7$$</strong>&nbsp;—&nbsp;Film counter</li>
    <li>$$OKNG8$$&nbsp;<strong>$$WORK8$$</strong>&nbsp;— Self timer</li>
  </ul>

  <h3 style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 10px; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1px solid rgb(217, 220, 221); padding-bottom: 6px; font-weight: normal;"><font size="4">■ Optics Inspection</font></h3>
  <div style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; overflow-x: auto; margin: 0px 0px 24px;">
    <table style="border-collapse:collapse;min-width:460px;width:100%;font-size:13px;">
      <caption style="caption-side:top;text-align:left;font-size:14px;line-height:1.75;color:#6e7378;padding-bottom:6px;">$$OPTICALTEXT$$</caption>
      <thead>
      <tr>
        <th scope="col" style="border:1px solid #d9dcdd;padding:8px 10px;background:#f4f5f4;font-weight:bold;text-align:left;">Part</th>
        <th scope="col" style="border:1px solid #d9dcdd;padding:8px 10px;background:#f4f5f4;font-weight:bold;text-align:left;">Fungus</th>
        <th scope="col" style="border:1px solid #d9dcdd;padding:8px 10px;background:#f4f5f4;font-weight:bold;text-align:left;">Haze</th>
        <th scope="col" style="border:1px solid #d9dcdd;padding:8px 10px;background:#f4f5f4;font-weight:bold;text-align:left;">Scratches / Marks</th>
        <th scope="col" style="border:1px solid #d9dcdd;padding:8px 10px;background:#f4f5f4;font-weight:bold;text-align:left;">Dust</th>
      </tr>
      </thead>
      <tbody>
      <tr>
        <th scope="row" style="border:1px solid #d9dcdd;padding:8px 10px;font-weight:bold;text-align:left;">Lens</th>
        <td style="border:1px solid #d9dcdd;padding:8px 10px;color:#3f6b4f;">$$LFUNGUS$$</td>
        <td style="border:1px solid #d9dcdd;padding:8px 10px;color:#3f6b4f;">$$LHAZE$$</td>
        <td style="border:1px solid #d9dcdd;padding:8px 10px;color:#3f6b4f;">$$LMARK$$</td>
        <td style="border:1px solid #d9dcdd;padding:8px 10px;color:#3f6b4f;">$$LDUST$$</td>
      </tr>
      <tr>
        <th scope="row" style="border:1px solid #d9dcdd;padding:8px 10px;font-weight:bold;text-align:left;">Finder</th>
        <td style="border:1px solid #d9dcdd;padding:8px 10px;color:#3f6b4f;">$$FFUNGUS$$</td>
        <td style="border:1px solid #d9dcdd;padding:8px 10px;color:#3f6b4f;">$$FHAZE$$</td>
        <td style="border:1px solid #d9dcdd;padding:8px 10px;color:#3f6b4f;">$$FMARK$$</td>
        <td style="border:1px solid #d9dcdd;padding:8px 10px;color:#3f6b4f;">$$FDUST$$</td>
      </tr>
      </tbody>
    </table>
  </div>

  <h3 style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 10px; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1px solid rgb(217, 220, 221); padding-bottom: 6px; font-weight: normal;"><font size="4">■ Included Accessories</font></h3>
  <ul style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 0px 0px 24px; padding-left: 20px; font-size: 14px; line-height: 1.8;">
    <li>$$INCLUDES$$</li><li>As shown in the listing photos (see photo gallery for exact contents).</li>
  </ul>

  <div style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 0px 0px 24px;">
    <h3 style="margin: 0px 0px 10px; font-family: &quot;Courier New&quot;, Courier, monospace; letter-spacing: 0.1em; color: rgb(138, 74, 53); text-transform: uppercase; font-weight: normal; border-bottom: 1px solid rgb(217, 220, 221); padding-bottom: 6px;"><span style="font-size: large; color: rgb(168, 103, 43); letter-spacing: 0.1em;">■</span><span style="font-size: large; color: rgb(168, 103, 43); letter-spacing: 0.1em;"> </span><font size="4">Not Recommended For</font></h3>
    <ul style="margin:0;padding-left:0;font-size:13px;line-height:1.8;color:#6e7378;list-style:none;">
      <li style="display:flex;align-items:flex-start;gap:4px;"><span aria-hidden="true" style="color:#8a4a35;flex:0 0 16px;">✗</span><span style="flex:1;min-width:0;"><strong>Not suitable:</strong> buyers seeking an unused item. This unit is graded $$STATUS$$, Grade $$CONDITION1$$ ($$GRADEPERCENT$$, with $$GRADETEXT$$.</span></li>
      <li style="display:flex;align-items:flex-start;gap:4px;"><span aria-hidden="true" style="color:#8a4a35;flex:0 0 16px;">✗</span><span style="flex:1;min-width:0;"><strong>Not suitable:</strong> buyers who cannot accept our return policy (see Shipping &amp; Returns below) before bidding/buying.</span></li>
    </ul>
  </div>

  <h3 style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 10px; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1px solid rgb(217, 220, 221); padding-bottom: 6px; font-weight: normal;"><font size="4">■ Shipping &amp; Returns</font></h3>
  <h4 style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 16px 0px 8px; font-size: 13px; display: inline !important;">Payment</h4><p style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; font-size: 14px; margin: 0px 0px 14px; line-height: 1.75;">We accept Managed Payments. Please make payment after we sent an invoice. Please pay within 3 days of the end of the auction. **Please read our Return Policy before a successful bid. Please purchase our item only if you accept our Return Policy. If you have any questions, please email us before purchase.</p><h4 style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 16px 0px 8px; font-size: 13px; display: inline !important;">Shipment</h4><p style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; font-size: 14px; margin: 0px 0px 14px; line-height: 1.75;">Shipping is FedEx, DHL, UPS or Japan Post. No other way available.</p><h4 style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 16px 0px 8px; font-size: 13px; display: inline !important;">Return</h4><p style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; font-size: 14px; margin: 0px 0px 14px; line-height: 1.75;">If there is any problem with the item, let us know within 3days after you received the item. Please use English, Japanese when you contact us about a complaint of the item. We try to write accurate descriptions for all our auctions listings, but we are human, and item description and item rank is our personal opinion. Request of return for a reason other than defective parts will be accepted only if the item description is markedly different from listings. All returns must be approved before you ship any item back to us. If you ship an item back to us without contacting us first, we will have to refuse the package &amp; it will be returned to you. All returns must be pre-approved. Make sure we authorized your return. Please do NOT purchase from us if you cannot accept our Return Policy. Please email us before leaving negative feedback or open case. We solve all issues by consultation.</p><h4 style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 16px 0px 8px; font-size: 13px; display: inline !important;">International Buyers, Please Note</h4><p style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; font-size: 14px; margin: 0px 0px 14px; line-height: 1.75;">For Buyers in the United States, Please Note: In the United States, import duties are required on all imported goods, regardless of their value. Import duties are included in the item price or shipping charges. Customers are responsible for all applicable taxes and fees, excluding customs duties. Please check with your country's customs office to determine what these additional costs will be prior to bidding/buying.</p><p style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; font-size: 14px; margin: 0px 0px 14px; line-height: 1.75;">For Buyers in the EU member states, Please Note: Import duties apply to goods valued at EUR150 or less. Import duties are included in the item price or shipping charges. Customers are responsible for all applicable taxes and fees, excluding customs duties. Please check with your country's customs office to determine what these additional costs will be prior to bidding/buying.</p><p style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; font-size: 14px; margin: 0px 0px 14px; line-height: 1.75;">For International Buyers (excluding the United States and EU member states), Please Note: Import duties, taxes and charges are not included in the item price or shipping charges. These charges are the buyer's responsibility. Please check with your country's customs office to determine what these additional costs will be prior to bidding/buying.</p><p style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; font-size: 14px; margin: 0px 0px 14px; line-height: 1.75;">We do not mark merchandise values lower than it was or items as "gifts." The declared value must be precise since the US and International government regulations prohibit such behavior.</p><p style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; font-size: 14px; margin: 0px 0px 14px; line-height: 1.75;">If there is a problem with the products we sell, please be sure to contact us via direct message before making an open request so that we can deal with it appropriately.</p><p style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; font-size: 14px; margin: 0px 0px 14px; line-height: 1.75;">Please read the full listing and feel free to contact us with any questions before purchasing. Thank you for looking.</p>

</div>`;

/**
 * セラーノート(プレーンテキスト)用テンプレート(2026-09-22追加)。$$VARNAME$$形式のプレースホルダーを
 * generateSellerNoteText()で実際の値に置換する。
 */
const SELLER_NOTE_TEMPLATE = `$$EXTERIOR$$ Consistent with our $$CONDITION1$$ ($$GRADEPERCENT$$) grade. $$GRADETEXT$$   $$TESTEDFUNC$$ : Confirmed working.   $$OPTICALTEXT$$   $$ELECTRICITY$$   Please refer to all listing photos for a full visual assessment of the actual item.`;

const GRADE_PERCENT: Record<string, string> = {
  "Brand New": "100%",
  "Like New": "99%",
  "TOP MINT": "97-98%",
  MINT: "95-96%",
  "Near MINT++": "93-94%",
  "Near MINT+": "91-92%",
  "Near MINT": "89-90%",
  "Exc +5": "87-88%",
  "Exc +4": "85-86%",
  "Exc +3": "83-84%",
  "For Parts": "81-82%",
  Junk: "75-80%",
};

const GRADE_TEXT: Record<string, string> = {
  "Brand New": "Brand new, never been used.",
  "Like New": "A new, unused item with absolutely no sign of wear, but pre-owned.",
  "TOP MINT": "It shows no signs of use at all, but pre-owned.",
  MINT: "Almost no signs of use. Almost no scratches or stains.",
  "Near MINT++": "Minimal signs of use, Still very clean.",
  "Near MINT+": "Minimal signs of use, Still very clean.",
  "Near MINT": "Minimal signs of use, Still very clean.",
  "Exc +5": "Some signs of use.",
  "Exc +4": "Some signs of use.",
  "Exc +3": "Some signs of use.",
  "For Parts": "As-is. It does not work normally. Use for parts.",
  Junk: "As-is. It does not work. Use for parts.",
};

const OPTICAL_LABEL: Record<string, string> = {
  none: "No",
  few: "Few",
  middle: "Middle",
  large: "Large",
};

/** $$OKNG1$$〜$$OKNG8$$・$$WORK1$$〜$$WORK8$$の並び順(状態チェック表と同じ順)。 */
const FUNCTIONAL_ORDER: { key: string; label: string }[] = [
  { key: "check_shutter", label: "Shutter" },
  { key: "check_flash", label: "Flash" },
  { key: "check_autofocus", label: "Auto focus" },
  { key: "check_auto_exposure", label: "Auto exposure" },
  { key: "check_film_winding", label: "Film winding" },
  { key: "check_film_rewinding", label: "Film rewinding" },
  { key: "check_film_counter", label: "Film counter" },
  { key: "check_self_timer", label: "Self timer" },
];

const OPTICAL_SUFFIXES = ["dust", "fungus", "haze", "mark"] as const;

/**
 * 検品タブの入力値(InspectionTabのFormValues、未保存の編集中の値も含む)と基本情報から、
 * $$VARNAME$$置換用のマップを組み立てる(HTML生成・セラーノート生成の両方で共有)。
 * opticalSeparatorはOPTICALTEXT(レンズの翻訳文/ファインダーの翻訳文の間の区切り)で、
 * HTML用は"<br>"、プレーンテキスト用は改行"\n"を渡す。
 */
function buildReplacements(
  detail: ItemDetail,
  values: Record<string, string>,
  opticalSeparator: string,
): Record<string, string> {
  const purchase = detail.purchases?.[0];
  const isUsed = purchase?.is_used_goods !== false;
  const statusText = isUsed ? "USED" : "BRANDNEW";

  const grade = values.condition_grade || "";
  const gradePercent = GRADE_PERCENT[grade] ?? "";
  const gradeText = GRADE_TEXT[grade] ?? "";

  const testedFunc = FUNCTIONAL_ORDER.filter((f) => values[f.key] === "ok")
    .map((f) => f.label)
    .join(", ");

  const replacements: Record<string, string> = {
    ADMINNO: detail.management_no ?? "",
    ITEMTITLE: detail.item_title ?? "",
    CONDITION1: grade,
    STATUS: statusText,
    GRADEPERCENT: gradePercent,
    GRADETEXT: gradeText,
    OVERALL: values.overall_notes_en || "",
    BRAND: detail.brand ?? "",
    MODEL: detail.model ?? "",
    TYPE: detail.type ?? "",
    TESTEDFUNC: testedFunc,
    INCLUDES: detail.accessories_included ?? "",
    EXTERIOR: values.appearance_notes_en || "",
    ELECTRICITY: values.electrical_notes_en || "",
    OPTICALTEXT: `${values.lens_notes_en || ""}${opticalSeparator}${values.viewfinder_notes_en || ""}`,
    BODYSN: detail.serial_number || "-",
    LENSSN: detail.lens_serial_number || "-",
  };

  FUNCTIONAL_ORDER.forEach((f, i) => {
    const n = i + 1;
    const state = values[f.key];
    if (state === "ok") {
      replacements[`OKNG${n}`] = "✓";
      replacements[`WORK${n}`] = "Works Properly";
    } else if (state === "na") {
      replacements[`OKNG${n}`] = "--";
      replacements[`WORK${n}`] = "N/A";
    } else {
      replacements[`OKNG${n}`] = "✗";
      replacements[`WORK${n}`] = "Not Work";
    }
  });

  OPTICAL_SUFFIXES.forEach((suffix) => {
    const lensVal = values[`optical_lens_${suffix}`] || "none";
    const finderVal = values[`optical_finder_${suffix}`] || "none";
    replacements[`L${suffix.toUpperCase()}`] = OPTICAL_LABEL[lensVal] ?? "No";
    replacements[`F${suffix.toUpperCase()}`] = OPTICAL_LABEL[finderVal] ?? "No";
  });

  return replacements;
}

function applyReplacements(template: string, replacements: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.split(`$$${key}$$`).join(value);
  }
  return result;
}

/**
 * 検品タブの入力値(InspectionTabのFormValues、未保存の編集中の値も含む)と基本情報から
 * eBay Description用HTMLを生成する。$$VARNAME$$形式のプレースホルダーを実値に置換する。
 */
export function generateDescriptionHtml(detail: ItemDetail, values: Record<string, string>): string {
  const replacements = buildReplacements(detail, values, "<br>");
  return applyReplacements(DESCRIPTION_TEMPLATE, replacements);
}

/**
 * 検品タブの入力値と基本情報から、セラーノート用のプレーンテキストを生成する(2026-09-22追加)。
 * 変数の置換ルールはgenerateDescriptionHtmlと共通(buildReplacements)だが、OPTICALTEXTの区切りは
 * HTMLの<br>ではなく改行を使う。
 */
export function generateSellerNoteText(detail: ItemDetail, values: Record<string, string>): string {
  const replacements = buildReplacements(detail, values, "\n");
  return applyReplacements(SELLER_NOTE_TEMPLATE, replacements);
}

import type { ItemDetail } from "./types";

/**
 * eBay出品説明文(Description)の生成テンプレート。$$VARNAME$$形式のプレースホルダーを
 * generateDescriptionHtml()で実際の値に置換する。
 */
const DESCRIPTION_TEMPLATE = `<div itemscope="" itemtype="https://schema.org/Product" style="max-width: 700px; margin: 0px auto; background: rgb(255, 255, 255); padding: 12px 4px; box-sizing: border-box;">

  <div style="border: 1px solid #9b3a42; padding: 10px 14px; margin: 0px 0px 18px;">
    <p style="color: #9b3a42; font-family: Arial, Helvetica, sans-serif; font-size: 14px; font-weight: bold; margin: 0px 0px 10px; line-height: 1.4;">In the United States, import duties are applied regardless of the value of the goods. In addition, for shipments to EU member states, import duties apply to goods valued at EUR150 or less.</p>
    <p style="color: #9b3a42; font-family: Arial, Helvetica, sans-serif; font-size: 14px; font-weight: bold; margin: 0px; line-height: 1.4;">For purchases from our store, we collect these import duties and the related customs handling fees as part of the Shipping Charge. As a result, customers in the United States and EU member states should not normally be required to pay additional import duties or customs-related fees at the time of customs clearance or delivery.</p>
  </div>

  <h2 itemprop="name" style="margin: 0px 0px 4px; line-height: 1.3;"><font color="#1e2226" face="Georgia, Times New Roman, serif"><span style="font-size: 23px;">$$ITEMTITLE$$</span></font></h2>
  <p style="color: rgb(110, 115, 120); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 18px; letter-spacing: 0.08em; text-transform: uppercase; font-size: 12pt;">Inspected &amp; Graded in Japan · Admin No. $$ADMINNO$$</p>

  <div itemprop="itemCondition" content="https://schema.org/UsedCondition" style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; display: inline-block; border: 2px solid rgb(168, 103, 43); font-weight: bold; text-align: center; padding: 6px 14px; margin: 0px 0px 18px;">
    GRADE: $$CONDITION1$$ $$GRADEPERCENT$$ ($$STATUS$$)
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
<tr><th scope="row" style="width:130px;padding:3px 14px 3px 0;text-align:left;vertical-align:top;font-weight:bold;">Includes</th><td style="padding:3px 0;text-align:left;vertical-align:top;overflow-wrap:anywhere;">As shown in the listing photos.$$INCLUDES_PAREN$$</td></tr>
</tbody></table>
$$GRADETABLE$$
  </div>

  <h3 style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 10px; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1px solid rgb(217, 220, 221); padding-bottom: 6px; font-weight: normal;"><font size="4">■ Appearance</font></h3>
  <ul style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 0px 0px 24px; padding-left: 20px; font-size: 14px; line-height: 1.8;">
    <li>$$EXTERIOR$$, consistent with our $$CONDITION1$$ ($$GRADEPERCENT$$) grade: $$GRADETEXT$$.</li>
    <li>$$ELECTRICITY$$.</li>
    <li>Please refer to all listing photos for a full visual assessment of the actual item.</li>
  </ul>

  <h3 style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 10px; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1px solid rgb(217, 220, 221); padding-bottom: 6px; font-weight: normal;"><font size="4">■ Functional Check</font></h3>
  <table style="border-collapse:collapse;color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 0px 0px 24px; font-size: 14px; line-height: 1.9;">
    <tr><td style="width:20px;padding:0;">$$OKNG1$$</td><td style="width:110px;padding:0;">Shutter</td><td style="padding:0;">&mdash;&nbsp;<strong>$$WORK1$$</strong></td></tr>
    <tr><td style="width:20px;padding:0;">$$OKNG2$$</td><td style="width:110px;padding:0;">Flash</td><td style="padding:0;">&mdash;&nbsp;<strong>$$WORK2$$</strong></td></tr>
    <tr><td style="width:20px;padding:0;">$$OKNG3$$</td><td style="width:110px;padding:0;">Auto focus</td><td style="padding:0;">&mdash;&nbsp;<strong>$$WORK3$$</strong></td></tr>
    <tr><td style="width:20px;padding:0;">$$OKNG4$$</td><td style="width:110px;padding:0;">Auto exposure</td><td style="padding:0;">&mdash;&nbsp;<strong>$$WORK4$$</strong></td></tr>
    <tr><td style="width:20px;padding:0;">$$OKNG5$$</td><td style="width:110px;padding:0;">Film winding</td><td style="padding:0;">&mdash;&nbsp;<strong>$$WORK5$$</strong></td></tr>
    <tr><td style="width:20px;padding:0;">$$OKNG6$$</td><td style="width:110px;padding:0;">Film rewinding</td><td style="padding:0;">&mdash;&nbsp;<strong>$$WORK6$$</strong></td></tr>
    <tr><td style="width:20px;padding:0;">$$OKNG7$$</td><td style="width:110px;padding:0;">Film counter</td><td style="padding:0;">&mdash;&nbsp;<strong>$$WORK7$$</strong></td></tr>
    <tr><td style="width:20px;padding:0;">$$OKNG8$$</td><td style="width:110px;padding:0;">Self timer</td><td style="padding:0;">&mdash;&nbsp;<strong>$$WORK8$$</strong></td></tr>
$$FUNCTIONALNOTES$$  </table>

  <h3 style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 10px; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1px solid rgb(217, 220, 221); padding-bottom: 6px; font-weight: normal;"><font size="4">■ Optics Inspection</font></h3>
  <div style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; overflow-x: auto; margin: 0px 0px $$OPTICSBOTTOMMARGIN$$px;">
    <table style="border-collapse:collapse;min-width:460px;width:65%;font-size:13px;">
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
$$OPTICALCHECKNOTES$$
  <h3 style="color: rgb(168, 103, 43); font-family: &quot;Courier New&quot;, Courier, monospace; margin: 0px 0px 10px; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1px solid rgb(217, 220, 221); padding-bottom: 6px; font-weight: normal;"><font size="4">■ Included Accessories</font></h3>
  <ul style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 0px 0px 24px; padding-left: 20px; font-size: 14px; line-height: 1.8;">
    $$INCLUDESLI$$<li>As shown in the listing photos (see photo gallery for exact contents).</li>
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

/** $$GRADETABLE$$(Quick Facts欄下部のグレード早見表、2026-09-23追加)の表示順。 */
const GRADE_ORDER = [
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

/**
 * Quick Facts欄下部に表示するグレード早見表のHTMLを組み立てる。現在の商品のグレード(currentGrade)の
 * 行だけ背景色を付けて強調し、買い手がスケール全体の中でのこの商品の位置をひと目で分かるようにする。
 */
function buildGradeCellHtml(g: string, currentGrade: string): string {
  const isCurrent = g === currentGrade;
  const style = isCurrent
    ? "padding:3px 8px;border-bottom:1px solid #e4e2db;background:#f7e9da;font-weight:bold;color:#8a4a2b;"
    : "padding:3px 8px;border-bottom:1px solid #e4e2db;color:#6e7378;";
  return `<td style="${style}">${g}${isCurrent ? " &larr;" : ""} <span style="opacity:0.7;">${GRADE_PERCENT[g]}</span></td>`;
}

function buildGradeTableHtml(currentGrade: string): string {
  // 2026-09-23変更(ユーザー指示): 縦幅を抑えるため4列組みにし、上から下へ縦方向に埋める
  // (12段階÷4列=3行、列1に1〜3番目、列2に4〜6番目…という並び)。
  const COLUMNS = 4;
  const ROWS = Math.ceil(GRADE_ORDER.length / COLUMNS);
  const columns: string[][] = [];
  for (let c = 0; c < COLUMNS; c++) {
    columns.push(GRADE_ORDER.slice(c * ROWS, c * ROWS + ROWS));
  }
  let rows = "";
  for (let r = 0; r < ROWS; r++) {
    const rowCells = columns.map((col) => (col[r] ? buildGradeCellHtml(col[r], currentGrade) : "<td></td>")).join("");
    rows += `<tr>${rowCells}</tr>`;
  }
  return `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed rgb(228,226,219);"><p style="margin:0 0 6px;font-family:&quot;Courier New&quot;,Courier,monospace;letter-spacing:0.1em;color:rgb(110,115,120);text-transform:uppercase;font-size:11px;">Grading Scale</p><table style="width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed;"><tbody>${rows}</tbody></table></div>`;
}

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
    // 2026-09-23追加(ユーザー指示): 付属物(accessories_included)が未登録の場合、Quick Facts表の
    // 「Includes」欄に空の丸括弧「()」だけが残ってしまうのを避けるため、値がある場合のみ
    // 前後の半角スペース+丸括弧ごと差し込む(無い場合はこのトークン自体が空文字列になる)。
    INCLUDES_PAREN: (detail.accessories_included ?? "").trim()
      ? ` (${detail.accessories_included})`
      : "",
    // 2026-09-23追加(ユーザー指示): Included Accessoriesの1行目(付属物そのものの記載)は、
    // 未登録の場合は空の<li></li>を残さず行ごと出力しない。
    INCLUDESLI: (detail.accessories_included ?? "").trim()
      ? `<li>${detail.accessories_included}</li>`
      : "",
    // 2026-09-23追加(ユーザー指示): 状態チェック表の下の自由記述欄(functional_check_notes)を、
    // Functional CheckテーブルのSelf timer行の下に、入力があるときのみ行として追加する。
    FUNCTIONALNOTES: (values.functional_check_notes || "").trim()
      ? `<tr><td colspan="3" style="padding:8px 0 0;color:#e0392e;">${values.functional_check_notes}</td></tr>`
      : "",
    // 2026-09-23追加(ユーザー指示): 光学チェック表(レンズ/ファインダー)の下の自由記述欄を、
    // Optics Inspectionの下に、入力があるものだけ縦積みで表示する。表示位置は表のすぐ下に
    // 近づけつつ(OPTICSBOTTOMMARGINでOptics Inspection側の下マージンを詰める)、次の見出し
    // 「Included Accessories」との間は広めに取る(OPTICALCHECKNOTES側のdivで24px確保)。
    // 入力が無い場合はOPTICSBOTTOMMARGINを元の24pxに戻し、表示エリア自体も出さない。
    OPTICSBOTTOMMARGIN: [values.optical_check_lens_notes, values.optical_check_finder_notes].some((v) => (v || "").trim())
      ? "6"
      : "24",
    OPTICALCHECKNOTES: (() => {
      const parts = [values.optical_check_lens_notes, values.optical_check_finder_notes]
        .map((v) => (v || "").trim())
        .filter(Boolean);
      if (parts.length === 0) return "";
      const paragraphs = parts
        .map(
          (t) =>
            `<p style="color: rgb(58, 63, 68); font-family: Arial, Helvetica, sans-serif; margin: 0 0 6px; font-size: 14px; line-height: 1.75;">${t}</p>`,
        )
        .join("");
      return `<div style="margin: 0px 0px 24px;">${paragraphs}</div>`;
    })(),
    EXTERIOR: values.appearance_notes_en || "",
    ELECTRICITY: values.electrical_notes_en || "",
    OPTICALTEXT: [values.lens_notes_en || "", values.viewfinder_notes_en || ""].filter(Boolean).join(opticalSeparator),
    BODYSN: detail.serial_number || "-",
    LENSSN: detail.lens_serial_number || "-",
    GRADETABLE: buildGradeTableHtml(grade),
  };

  FUNCTIONAL_ORDER.forEach((f, i) => {
    const n = i + 1;
    const state = values[f.key];
    if (state === "ok") {
      replacements[`OKNG${n}`] = "✓";
      replacements[`WORK${n}`] = "Working";
    } else if (state === "na") {
      replacements[`OKNG${n}`] = "--";
      replacements[`WORK${n}`] = "N/A";
    } else {
      replacements[`OKNG${n}`] = "✗";
      replacements[`WORK${n}`] = "Not working";
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
 * 変数の置換ルールはgenerateDescriptionHtmlと共通(buildReplacements)だが、OPTICALTEXTは
 * レンズ・ファインダーの翻訳文を改行無しで半角スペース区切りで連結する(2026-09-26修正:
 * 区切り無しで連結すると「...present.The viewfinder...」のように文末と次の文がくっついて
 * しまうバグがあったため、半角スペースを挟むよう変更)。
 */
export function generateSellerNoteText(detail: ItemDetail, values: Record<string, string>): string {
  const replacements = buildReplacements(detail, values, " ");
  return applyReplacements(SELLER_NOTE_TEMPLATE, replacements);
}

/**
 * eBay Item Specifics「Soulcamera Item Info」の値を生成する(2026-09-26追加)。
 * 形式: 「管理番号 現在の日付(YYMMDD) 仕入高(円)」の空白区切り3項目。
 * 日付は仕入日ではなく生成時点(出品直前が想定)の日付を使う。
 */
export function generateSoulcameraItemInfo(detail: ItemDetail): string {
  const managementNo = detail.management_no ?? "";
  const now = new Date();
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yymmdd = `${yy}${mm}${dd}`;
  const purchasePrice = detail.purchases?.[0]?.purchase_price ?? 0;
  return `${managementNo} ${yymmdd} ${purchasePrice}`;
}

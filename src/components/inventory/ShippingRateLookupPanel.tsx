import { useEffect, useMemo, useState } from "react";
import {
  createShippingRateReference,
  deleteShippingRateReference,
  fetchShippingRateReference,
  updateShippingRateReference,
  type ShippingRateReferenceInput,
  type ShippingRateReferenceRow,
} from "../../lib/api/shippingRateReference";

interface FieldDef {
  key: keyof ShippingRateReferenceInput;
  label: string;
  type: "text" | "number";
}

// A〜J列(早見表の絞り込み対象)。この順にプルダウンを表示し、順に絞り込んでK列(支払額)へたどり着く。
const CHAIN_FIELDS: FieldDef[] = [
  { key: "brand", label: "ブランド", type: "text" },
  { key: "model", label: "機種名", type: "text" },
  { key: "shipping_service", label: "Shipping Service", type: "text" },
  { key: "service_type", label: "Service Type", type: "text" },
  { key: "incoterms", label: "Incoterms", type: "text" },
  { key: "package_type", label: "Package Type", type: "text" },
  { key: "dimension_1_cm", label: "寸法1(cm)", type: "number" },
  { key: "dimension_2_cm", label: "寸法2(cm)", type: "number" },
  { key: "dimension_3_cm", label: "寸法3(cm)", type: "number" },
  { key: "chargeable_weight_kg", label: "重量(kg)", type: "number" },
];

// 編集テーブルの全14列(A〜N)。
const ALL_FIELDS: FieldDef[] = [
  ...CHAIN_FIELDS,
  { key: "amount_paid_jpy", label: "支払額(円)", type: "number" },
  { key: "duty_vat_other_jpy", label: "関税VAT等(円)", type: "number" },
  { key: "destination_country", label: "配送先国", type: "text" },
  { key: "ship_to", label: "Ship to", type: "text" },
];

// 長い機種名で表全体が画面からはみ出さないよう、表示時の最大幅を制限する列(2026-10-02追加)。
const DISPLAY_MAX_WIDTH: Partial<Record<keyof ShippingRateReferenceInput, number>> = {
  model: 78,
};

const BLANK_INPUT: ShippingRateReferenceInput = {
  brand: "",
  model: "",
  shipping_service: "",
  service_type: "",
  incoterms: "",
  package_type: "",
  dimension_1_cm: null,
  dimension_2_cm: null,
  dimension_3_cm: null,
  chargeable_weight_kg: null,
  amount_paid_jpy: null,
  duty_vat_other_jpy: null,
  destination_country: null,
  ship_to: null,
};

function normalizeValue(field: FieldDef, raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (field.type === "number") {
    const n = typeof raw === "number" ? raw : parseFloat(String(raw));
    return Number.isNaN(n) ? String(raw) : String(n);
  }
  return String(raw);
}

function rowToDraft(row: ShippingRateReferenceRow): ShippingRateReferenceInput {
  return {
    brand: row.brand,
    model: row.model,
    shipping_service: row.shipping_service,
    service_type: row.service_type,
    incoterms: row.incoterms,
    package_type: row.package_type,
    dimension_1_cm: row.dimension_1_cm,
    dimension_2_cm: row.dimension_2_cm,
    dimension_3_cm: row.dimension_3_cm,
    chargeable_weight_kg: row.chargeable_weight_kg,
    amount_paid_jpy: row.amount_paid_jpy,
    duty_vat_other_jpy: row.duty_vat_other_jpy,
    destination_country: row.destination_country,
    ship_to: row.ship_to,
  };
}

function EditableCell({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: string | number | null;
  onChange: (v: string | number | null) => void;
}) {
  if (field.type === "number") {
    return (
      <input
        type="number"
        step="any"
        value={value === null || value === undefined ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        style={{ width: 90, fontSize: 12, padding: "2px 4px" }}
      />
    );
  }
  return (
    <input
      type="text"
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: field.key === "model" ? 66 : field.key === "brand" ? 90 : 150, fontSize: 12, padding: "2px 4px" }}
    />
  );
}

export default function ShippingRateLookupPanel() {
  const [rows, setRows] = useState<ShippingRateReferenceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 早見表(絞り込み検索)の選択状態
  const [selections, setSelections] = useState<Record<string, string>>({});

  // 編集テーブル側の状態
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<ShippingRateReferenceInput>(BLANK_INPUT);
  const [addingNew, setAddingNew] = useState(false);
  const [newDraft, setNewDraft] = useState<ShippingRateReferenceInput>(BLANK_INPUT);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchShippingRateReference();
      setRows(data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleSelectChange(index: number, value: string) {
    setSelections((prev) => {
      const next: Record<string, string> = {};
      // このインデックスより前の選択は維持し、このインデックス以降はリセット(カスケード)
      for (let i = 0; i < index; i++) {
        const key = CHAIN_FIELDS[i].key as string;
        if (prev[key]) next[key] = prev[key];
      }
      if (value) next[CHAIN_FIELDS[index].key as string] = value;
      return next;
    });
  }

  function resetLookup() {
    setSelections({});
  }

  // 各プルダウンの選択肢・現在までの絞り込み結果を計算
  const chainState = useMemo(() => {
    const result: { options: string[]; filteredRows: ShippingRateReferenceRow[] }[] = [];
    let current = rows;
    for (let i = 0; i < CHAIN_FIELDS.length; i++) {
      const field = CHAIN_FIELDS[i];
      const optionSet = new Set<string>();
      for (const r of current) {
        const v = normalizeValue(field, r[field.key]);
        if (v) optionSet.add(v);
      }
      const options = Array.from(optionSet).sort((a, b) =>
        field.type === "number" ? Number(a) - Number(b) : a.localeCompare(b),
      );
      const sel = selections[field.key as string] ?? "";
      const filteredRows = sel ? current.filter((r) => normalizeValue(field, r[field.key]) === sel) : current;
      result.push({ options, filteredRows });
      current = filteredRows;
    }
    return result;
  }, [rows, selections]);

  const finalMatches = chainState.length > 0 ? chainState[chainState.length - 1].filteredRows : rows;
  const selectedCount = CHAIN_FIELDS.filter((f) => selections[f.key as string]).length;

  const filteredTableRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (r) => r.brand.toLowerCase().includes(term) || r.model.toLowerCase().includes(term),
    );
  }, [rows, search]);

  function startEdit(row: ShippingRateReferenceRow) {
    setEditingId(row.id);
    setEditDraft(rowToDraft(row));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(BLANK_INPUT);
  }

  async function saveEdit(id: number) {
    setBusy(true);
    setErrorMessage(null);
    try {
      await updateShippingRateReference(id, editDraft);
      await load();
      setEditingId(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("この行を削除しますか?")) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      await deleteShippingRateReference(id);
      await load();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddNew() {
    setBusy(true);
    setErrorMessage(null);
    try {
      await createShippingRateReference(newDraft);
      await load();
      setAddingNew(false);
      setNewDraft(BLANK_INPUT);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function formatYen(v: number | null): string {
    if (v === null || v === undefined) return "-";
    return `¥${v.toLocaleString()}`;
  }

  return (
    <div style={{ marginBottom: 32, paddingBottom: 24, borderBottom: "1px solid var(--border)" }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginTop: 0, marginBottom: 8 }}>送料設定早見表</h3>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        ブランド〜重量までを順に選択して絞り込むと、実際に支払った送料(過去の実績データ)が表示されます。
      </p>

      {loading ? (
        <p style={{ fontSize: 13 }}>読み込み中...</p>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 12 }}>
            {CHAIN_FIELDS.map((field, index) => {
              const sel = selections[field.key as string] ?? "";
              const options = chainState[index]?.options ?? [];
              return (
                <label key={String(field.key)} style={{ display: "flex", flexDirection: "column", fontSize: 11, color: "var(--text-muted)" }}>
                  {field.label}
                  <select
                    value={sel}
                    onChange={(e) => handleSelectChange(index, e.target.value)}
                    style={{ fontSize: 12, padding: "4px 6px", minWidth: 120 }}
                  >
                    <option value="">(指定なし)</option>
                    {options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            <button
              type="button"
              onClick={resetLookup}
              style={{ fontSize: 12, padding: "6px 12px", height: 30 }}
            >
              リセット
            </button>
          </div>

          <div
            style={{
              background: "var(--surface-2)",
              borderRadius: 6,
              padding: 12,
              fontSize: 13,
            }}
          >
            {selectedCount === 0 ? (
              <span style={{ color: "var(--text-muted)" }}>条件を選択してください(全{rows.length}件)。</span>
            ) : finalMatches.length === 0 ? (
              <span style={{ color: "var(--danger, #c0392b)" }}>該当するデータがありません。</span>
            ) : (
              <div>
                <div style={{ marginBottom: finalMatches.length > 1 ? 8 : 0 }}>
                  該当 {finalMatches.length}件
                  {finalMatches.length === 1 && (
                    <>
                      {" "}
                      — 支払額(K列):{" "}
                      <strong style={{ fontSize: 16 }}>{formatYen(finalMatches[0].amount_paid_jpy)}</strong>
                      {finalMatches[0].duty_vat_other_jpy ? (
                        <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                          (うち関税VAT等: {formatYen(finalMatches[0].duty_vat_other_jpy)})
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
                {finalMatches.length > 1 && (
                  <table style={{ fontSize: 12, borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "2px 8px" }}>支払額(円)</th>
                        <th style={{ textAlign: "left", padding: "2px 8px" }}>関税VAT等(円)</th>
                        <th style={{ textAlign: "left", padding: "2px 8px" }}>配送先国</th>
                      </tr>
                    </thead>
                    <tbody>
                      {finalMatches.map((r) => (
                        <tr key={r.id}>
                          <td style={{ padding: "2px 8px" }}>{formatYen(r.amount_paid_jpy)}</td>
                          <td style={{ padding: "2px 8px" }}>{formatYen(r.duty_vat_other_jpy)}</td>
                          <td style={{ padding: "2px 8px" }}>{r.destination_country ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {errorMessage && (
        <p style={{ color: "var(--danger, #c0392b)", fontSize: 12, marginTop: 12 }}>{errorMessage}</p>
      )}

      <details style={{ marginTop: 20 }}>
        <summary style={{ fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          データの追加・編集({rows.length}件)
        </summary>
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              type="text"
              placeholder="ブランド・機種名で絞り込み"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ fontSize: 12, padding: "4px 6px", width: 220 }}
            />
            {!addingNew ? (
              <button
                type="button"
                onClick={() => {
                  setAddingNew(true);
                  setNewDraft(BLANK_INPUT);
                }}
                style={{ fontSize: 12, padding: "4px 10px" }}
              >
                + 新規行を追加
              </button>
            ) : (
              <>
                <button type="button" onClick={handleAddNew} disabled={busy} style={{ fontSize: 12, padding: "4px 10px" }}>
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddingNew(false);
                    setNewDraft(BLANK_INPUT);
                  }}
                  style={{ fontSize: 12, padding: "4px 10px" }}
                >
                  キャンセル
                </button>
              </>
            )}
          </div>

          <div style={{ maxHeight: 420, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
            <table style={{ fontSize: 12, borderCollapse: "collapse", width: "max-content" }}>
              <thead style={{ position: "sticky", top: 0, background: "var(--surface-1)", zIndex: 1 }}>
                <tr>
                  {ALL_FIELDS.map((f) => (
                    <th key={String(f.key)} style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>
                      {f.label}
                    </th>
                  ))}
                  <th style={{ padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {addingNew && (
                  <tr style={{ background: "var(--surface-2)" }}>
                    {ALL_FIELDS.map((f) => (
                      <td key={String(f.key)} style={{ padding: "2px 6px" }}>
                        <EditableCell
                          field={f}
                          value={newDraft[f.key] as string | number | null}
                          onChange={(v) => setNewDraft((prev) => ({ ...prev, [f.key]: v }))}
                        />
                      </td>
                    ))}
                    <td style={{ padding: "2px 6px" }} />
                  </tr>
                )}
                {filteredTableRows.map((row) => {
                  const isEditing = editingId === row.id;
                  return (
                    <tr key={row.id}>
                      {ALL_FIELDS.map((f) => (
                        <td key={String(f.key)} style={{ padding: "2px 6px", whiteSpace: "nowrap" }}>
                          {isEditing ? (
                            <EditableCell
                              field={f}
                              value={editDraft[f.key] as string | number | null}
                              onChange={(v) => setEditDraft((prev) => ({ ...prev, [f.key]: v }))}
                            />
                          ) : f.type === "number" ? (
                            (row[f.key] as number | null) ?? "-"
                          ) : (
                            <span
                              title={(row[f.key] as string | null) || undefined}
                              style={{
                                display: "inline-block",
                                maxWidth: DISPLAY_MAX_WIDTH[f.key],
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                verticalAlign: "bottom",
                              }}
                            >
                              {(row[f.key] as string | null) || "-"}
                            </span>
                          )}
                        </td>
                      ))}
                      <td style={{ padding: "2px 6px", whiteSpace: "nowrap" }}>
                        {isEditing ? (
                          <>
                            <button type="button" onClick={() => saveEdit(row.id)} disabled={busy} style={{ fontSize: 11, marginRight: 4 }}>
                              保存
                            </button>
                            <button type="button" onClick={cancelEdit} style={{ fontSize: 11 }}>
                              キャンセル
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => startEdit(row)} style={{ fontSize: 11, marginRight: 4 }}>
                              編集
                            </button>
                            <button type="button" onClick={() => handleDelete(row.id)} disabled={busy} style={{ fontSize: 11 }}>
                              削除
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </div>
  );
}

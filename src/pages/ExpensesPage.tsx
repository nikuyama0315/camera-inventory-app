import { useRef, useState, useEffect } from "react";
import { pickFolderNameViaDirectoryPicker } from "../lib/folderPicker";
import {
  EXPENSE_CATEGORIES,
  TAX_CATEGORY_OPTIONS,
  createExpense,
  updateExpense,
  deleteExpense,
  fetchExpenses,
  type Expense,
  type ExpenseFilters,
  type TaxCategory,
} from "../lib/api/expenses";
import ExpensesDataManagementPanel from "../components/expenses/ExpensesDataManagementPanel";

type SubTab = "register" | "data";

interface FormState {
  expense_date: string;
  category: string;
  vendor: string;
  description: string;
  amount: string;
  tax_category: TaxCategory;
  invoice_registration_no: string;
  receipt_folder_path: string;
}

const EMPTY_FORM: FormState = {
  expense_date: new Date().toISOString().slice(0, 10),
  category: EXPENSE_CATEGORIES[0],
  vendor: "",
  description: "",
  amount: "",
  tax_category: "課税",
  invoice_registration_no: "",
  receipt_folder_path: "",
};

function expenseToForm(expense: Expense): FormState {
  return {
    expense_date: expense.expense_date,
    category: expense.category,
    vendor: expense.vendor ?? "",
    description: expense.description ?? "",
    amount: String(expense.amount),
    tax_category: expense.tax_category,
    invoice_registration_no: expense.invoice_registration_no ?? "",
    receipt_folder_path: expense.receipt_folder_path ?? "",
  };
}

export default function ExpensesPage() {
  const [subTab, setSubTab] = useState<SubTab>("register");

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [filters, setFilters] = useState<ExpenseFilters>({});
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dateSortAsc, setDateSortAsc] = useState(false);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  // 右ペインの一覧行をクリックした際に開く編集モーダル用の状態。
  // 左ペインの登録フォーム(form)とは独立させ、左ペインは常に「新規登録」専用にする。
  const [modalExpense, setModalExpense] = useState<Expense | null>(null);
  const [modalForm, setModalForm] = useState<FormState>(EMPTY_FORM);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalFormError, setModalFormError] = useState<string | null>(null);

  const receiptFolderPickerRef = useRef<HTMLInputElement>(null);
  const modalReceiptFolderPickerRef = useRef<HTMLInputElement>(null);

  async function reload() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchExpenses(filters);
      setExpenses(data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleReceiptFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const relPath = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    const folderName = relPath ? relPath.split("/")[0] : files[0].name;
    updateForm("receipt_folder_path", folderName);
    e.target.value = "";
  }

  async function handlePickReceiptFolder() {
    const name = await pickFolderNameViaDirectoryPicker();
    if (name) {
      updateForm("receipt_folder_path", name);
    } else if (!("showDirectoryPicker" in window)) {
      receiptFolderPickerRef.current?.click();
    }
  }

  async function handleSubmit() {
    setFormError(null);
    setCopyNotice(null);
    if (!form.expense_date || !form.category || !form.amount) {
      setFormError("領収日・カテゴリ・金額は必須です");
      return;
    }
    setSaving(true);
    try {
      await createExpense({
        expense_date: form.expense_date,
        category: form.category,
        vendor: form.vendor || undefined,
        description: form.description || undefined,
        amount: Number(form.amount),
        tax_category: form.tax_category,
        invoice_registration_no: form.invoice_registration_no || undefined,
        receipt_folder_path: form.receipt_folder_path || undefined,
      });
      setForm(EMPTY_FORM);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "登録に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  /** 既存データの内容をフォームにコピーする(新規登録として、コピー元は変更しない)。 */
  function handleCopyToRegister(expense: Expense) {
    setForm(expenseToForm(expense));
    setFormError(null);
    setCopyNotice("既存データの内容をフォームにコピーしました。内容を確認のうえ「登録」を押してください。");
  }

  async function handleDelete(id: string) {
    try {
      await deleteExpense(id);
      if (modalExpense?.id === id) setModalExpense(null);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "削除に失敗しました");
    }
  }

  function handleRowClick(expense: Expense) {
    setModalExpense(expense);
    setModalForm(expenseToForm(expense));
    setModalFormError(null);
  }

  function handleCloseModal() {
    setModalExpense(null);
  }

  function updateModalForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setModalForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleModalReceiptFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const relPath = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    const folderName = relPath ? relPath.split("/")[0] : files[0].name;
    updateModalForm("receipt_folder_path", folderName);
    e.target.value = "";
  }

  async function handleModalPickReceiptFolder() {
    const name = await pickFolderNameViaDirectoryPicker();
    if (name) {
      updateModalForm("receipt_folder_path", name);
    } else if (!("showDirectoryPicker" in window)) {
      modalReceiptFolderPickerRef.current?.click();
    }
  }

  async function handleModalSubmit() {
    if (!modalExpense) return;
    setModalFormError(null);
    if (!modalForm.expense_date || !modalForm.category || !modalForm.amount) {
      setModalFormError("領収日・カテゴリ・金額は必須です");
      return;
    }
    setModalSaving(true);
    try {
      await updateExpense(modalExpense.id, {
        expense_date: modalForm.expense_date,
        category: modalForm.category,
        vendor: modalForm.vendor || undefined,
        description: modalForm.description || undefined,
        amount: Number(modalForm.amount),
        tax_category: modalForm.tax_category,
        invoice_registration_no: modalForm.invoice_registration_no || undefined,
        receipt_folder_path: modalForm.receipt_folder_path || undefined,
      });
      setModalExpense(null);
      await reload();
    } catch (err) {
      setModalFormError(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setModalSaving(false);
    }
  }

  async function handleModalDelete() {
    if (!modalExpense) return;
    await handleDelete(modalExpense.id);
  }

  function handleModalCopyToRegister() {
    if (!modalExpense) return;
    handleCopyToRegister(modalExpense);
    setModalExpense(null);
  }

  const total = expenses.reduce((sum, e) => sum + e.amount, 0);

  const sortedExpenses = [...expenses].sort((a, b) => {
    const cmp = a.expense_date.localeCompare(b.expense_date);
    return dateSortAsc ? cmp : -cmp;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: 4, padding: "8px 12px", borderBottom: "0.5px solid var(--border)" }}>
        <button
          onClick={() => setSubTab("register")}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            border: "none",
            borderBottom: subTab === "register" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRadius: 0,
            background: "transparent",
            color: subTab === "register" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          経費を登録
        </button>
        <button
          onClick={() => setSubTab("data")}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            border: "none",
            borderBottom: subTab === "data" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRadius: 0,
            background: "transparent",
            color: subTab === "data" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          データ管理(一括取込・バックアップ・復元)
        </button>
      </div>

      {subTab === "data" ? (
        <ExpensesDataManagementPanel onDataChanged={reload} />
      ) : (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={{ width: "33%", borderRight: "0.5px solid var(--border)", overflowY: "auto", padding: "1rem 1.25rem" }}>
            <h3 style={{ fontSize: 14, fontWeight: 500, marginTop: 0, marginBottom: 12 }}>経費を登録</h3>

            <ExpenseFields
              form={form}
              updateForm={updateForm}
              pickerRef={receiptFolderPickerRef}
              onPickReceiptFolder={handlePickReceiptFolder}
              onReceiptFolderPicked={handleReceiptFolderPicked}
            />

            {copyNotice && (
              <p style={{ color: "var(--text-secondary)", fontSize: 12, marginBottom: 8 }}>{copyNotice}</p>
            )}
            {formError && <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 8 }}>{formError}</p>}
            <button onClick={handleSubmit} disabled={saving}>
              {saving ? "登録中..." : "登録"}
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.5rem" }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
              <input
                type="date"
                value={filters.from ?? ""}
                onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value || undefined }))}
              />
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>〜</span>
              <input
                type="date"
                value={filters.to ?? ""}
                onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value || undefined }))}
              />
              <select
                value={filters.category ?? ""}
                onChange={(e) => setFilters((prev) => ({ ...prev, category: e.target.value || undefined }))}
              >
                <option value="">カテゴリ(すべて)</option>
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="事業者名で絞り込み"
                value={filters.vendor ?? ""}
                onChange={(e) => setFilters((prev) => ({ ...prev, vendor: e.target.value || undefined }))}
                style={{ width: 160 }}
              />
              <input
                type="text"
                placeholder="内容で絞り込み"
                value={filters.description ?? ""}
                onChange={(e) => setFilters((prev) => ({ ...prev, description: e.target.value || undefined }))}
                style={{ width: 160 }}
              />
              <span style={{ fontSize: 13, color: "var(--text-secondary)", marginLeft: "auto" }}>
                表示中の合計: {total.toLocaleString()}円({expenses.length}件)
              </span>
            </div>

            {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</p>}
            {loading && <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>読み込み中...</p>}

            {!loading && (
              <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "9%" }} />
                  <col style={{ width: "7%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "7%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "27%" }} />
                </colgroup>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                    <th
                      style={{ padding: "6px 4px", fontWeight: 500, cursor: "pointer", userSelect: "none" }}
                      onClick={() => setDateSortAsc((v) => !v)}
                      title="クリックで並び替え"
                    >
                      領収日 {dateSortAsc ? "▲" : "▼"}
                    </th>
                    <th style={{ padding: "6px 4px", fontWeight: 500 }}>カテゴリ</th>
                    <th style={{ padding: "6px 4px", fontWeight: 500 }}>事業者名</th>
                    <th style={{ padding: "6px 4px", fontWeight: 500 }}>内容</th>
                    <th style={{ padding: "6px 4px", fontWeight: 500, whiteSpace: "nowrap" }}>課税区分</th>
                    <th style={{ padding: "6px 4px", fontWeight: 500 }}>領収書フォルダ</th>
                    <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>金額</th>
                    <th style={{ padding: "6px 4px", fontWeight: 500 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedExpenses.map((e, rowIndex) => {
                    const zebraBackground = rowIndex % 2 === 1 ? "var(--surface-1)" : undefined;
                    return (
                    <tr
                      key={e.id}
                      onClick={() => handleRowClick(e)}
                      title="クリックして編集"
                      style={{
                        borderTop: "0.5px solid var(--border)",
                        background: modalExpense?.id === e.id ? "var(--surface-1)" : zebraBackground,
                        cursor: "pointer",
                      }}
                    >
                      <td style={{ padding: "8px 4px" }}>{e.expense_date}</td>
                      <td style={{ padding: "8px 4px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                        {e.category}
                      </td>
                      <td style={{ padding: "8px 4px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                        {e.vendor ?? "-"}
                      </td>
                      <td style={{ padding: "8px 4px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                        {e.description ?? "-"}
                      </td>
                      <td style={{ padding: "8px 4px", whiteSpace: "nowrap" }}>
                        {e.tax_category === "不課税" ? (
                          <span
                            style={{
                              fontSize: 11,
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "var(--surface-1)",
                              color: "var(--text-secondary)",
                              border: "0.5px solid var(--border-strong)",
                            }}
                          >
                            不課税
                          </span>
                        ) : (
                          "課税"
                        )}
                      </td>
                      <td
                        style={{
                          padding: "8px 4px",
                          color: "var(--text-secondary)",
                          whiteSpace: "normal",
                          overflowWrap: "break-word",
                        }}
                      >
                        {e.receipt_folder_path ?? "-"}
                      </td>
                      <td style={{ padding: "8px 4px", textAlign: "right" }}>{e.amount.toLocaleString()}</td>
                      <td style={{ padding: "8px 4px", textAlign: "right", whiteSpace: "nowrap" }}>
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handleCopyToRegister(e);
                          }}
                          style={{ fontSize: 12, padding: "2px 8px", marginRight: 4 }}
                        >
                          コピーして登録
                        </button>
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handleDelete(e.id);
                          }}
                          style={{ fontSize: 12, padding: "2px 8px" }}
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}

            {!loading && expenses.length === 0 && (
              <p style={{ fontSize: 13, color: "var(--text-muted)" }}>該当する経費がありません</p>
            )}
          </div>
        </div>
      )}

      {modalExpense && (
        <>
          <div
            onClick={handleCloseModal}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000 }}
          />
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              top: "5vh",
              left: "50%",
              transform: "translateX(-50%)",
              width: "min(560px, calc(100% - 32px))",
              maxHeight: "90vh",
              overflowY: "auto",
              background: "var(--surface-2)",
              border: "1px solid var(--accent)",
              borderRadius: 12,
              zIndex: 1001,
              boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
              padding: "1rem 1.5rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>経費を編集</h3>
              <button onClick={handleCloseModal} style={{ fontSize: 12, padding: "4px 10px" }}>
                閉じる
              </button>
            </div>

            <ExpenseFields
              form={modalForm}
              updateForm={updateModalForm}
              pickerRef={modalReceiptFolderPickerRef}
              onPickReceiptFolder={handleModalPickReceiptFolder}
              onReceiptFolderPicked={handleModalReceiptFolderPicked}
            />

            {modalFormError && (
              <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 8 }}>{modalFormError}</p>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleModalSubmit} disabled={modalSaving}>
                {modalSaving ? "更新中..." : "更新する"}
              </button>
              <button type="button" onClick={handleModalCopyToRegister} disabled={modalSaving}>
                コピーして新規登録
              </button>
              <button
                type="button"
                onClick={handleModalDelete}
                disabled={modalSaving}
                style={{ marginLeft: "auto", color: "var(--danger-text)" }}
              >
                削除
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
        {label}
      </label>
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );
}

/** 経費の登録・編集フォームの入力項目一式。左ペインの新規登録フォームと編集モーダルの両方から使う。 */
function ExpenseFields({
  form,
  updateForm,
  pickerRef,
  onPickReceiptFolder,
  onReceiptFolderPicked,
}: {
  form: FormState;
  updateForm: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  pickerRef: React.RefObject<HTMLInputElement>;
  onPickReceiptFolder: () => void;
  onReceiptFolderPicked: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <>
      <Field label="領収日">
        <input
          type="date"
          value={form.expense_date}
          onChange={(e) => updateForm("expense_date", e.target.value)}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="カテゴリ">
        <select
          value={form.category}
          onChange={(e) => updateForm("category", e.target.value)}
          style={{ width: "100%" }}
        >
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="事業者名">
        <input
          type="text"
          value={form.vendor}
          onChange={(e) => updateForm("vendor", e.target.value)}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="内容">
        <input
          type="text"
          value={form.description}
          onChange={(e) => updateForm("description", e.target.value)}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="金額(円)">
        <input
          type="number"
          value={form.amount}
          onChange={(e) => updateForm("amount", e.target.value)}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="適格請求書発行事業者番号(任意)">
        <input
          type="text"
          value={form.invoice_registration_no}
          onChange={(e) => updateForm("invoice_registration_no", e.target.value)}
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="課税区分">
        <select
          value={form.tax_category}
          onChange={(e) => updateForm("tax_category", e.target.value as TaxCategory)}
          style={{ width: "100%" }}
        >
          {TAX_CATEGORY_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>

      <div
        style={{
          marginBottom: 16,
          padding: "10px 12px",
          border: "0.5px dashed var(--border-strong)",
          borderRadius: 8,
          background: "var(--surface-1)",
        }}
      >
        <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
          領収書保管フォルダ(任意)
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            placeholder="フォルダ名またはパス"
            value={form.receipt_folder_path}
            onChange={(e) => updateForm("receipt_folder_path", e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="button" onClick={onPickReceiptFolder}>
            フォルダを選択
          </button>
          <input
            ref={pickerRef}
            type="file"
            // @ts-expect-error webkitdirectory は標準の型定義に存在しないが主要ブラウザでサポートされている
            webkitdirectory=""
            directory=""
            multiple
            style={{ display: "none" }}
            onChange={onReceiptFolderPicked}
          />
        </div>
        <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 0" }}>
          ブラウザの仕様上、フォルダの絶対パスは自動取得できません。「フォルダを選択」でフォルダ名を自動入力し、必要であればパスの先頭部分を手動で追記してください。
        </p>
      </div>
    </>
  );
}

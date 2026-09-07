import { getDeductionInfo, type CounterpartyType } from "../../lib/taxDeduction";

export default function DeductionBadge({ counterpartyType }: { counterpartyType: CounterpartyType }) {
  const info = getDeductionInfo(counterpartyType);
  const isFull = info.rate === 100;
  const isNone = info.rate === 0;

  const bg = isNone ? "var(--danger-bg)" : isFull ? "var(--surface-1)" : "var(--surface-1)";
  const color = isNone ? "var(--danger-text)" : isFull ? "var(--text-secondary)" : "var(--text-secondary)";

  return (
    <div
      style={{
        marginBottom: 12,
        padding: "8px 10px",
        borderRadius: 8,
        background: bg,
        border: `0.5px solid ${isNone ? "var(--danger-text)" : "var(--border)"}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 12, color }}>{info.label}</span>
        <span style={{ fontSize: 16, fontWeight: 500, color }}>控除率 {info.rate}%</span>
      </div>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0" }}>{info.note}</p>
    </div>
  );
}

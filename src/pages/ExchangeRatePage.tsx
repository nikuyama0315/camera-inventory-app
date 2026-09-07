import { useEffect, useMemo, useRef, useState } from "react";
import { fetchMonthlyMufgDailyRates, type MufgDailyRate } from "../lib/api/mufgRate";

const MIN_YEAR_MONTH = "2026-01";
const ACCENT = "#185fa5";
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function todayYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function formatDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  const weekday = WEEKDAY_LABELS[new Date(dateStr + "T00:00:00").getDay()];
  return `${m}/${d}(${weekday})`;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

// 見やすい間隔(1/2/5の倍率)にY軸目盛りを丸めるための補助関数
function niceStep(roughStep: number): number {
  const exponent = Math.floor(Math.log10(roughStep));
  const fraction = roughStep / Math.pow(10, exponent);
  let niceFraction: number;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * Math.pow(10, exponent);
}

function StatTile({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 140,
        padding: "12px 16px",
        border: "0.5px solid var(--border)",
        borderRadius: 12,
        background: "var(--surface-2)",
      }}
    >
      <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 4px" }}>{label}</p>
      <p style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
        {value !== null ? value.toFixed(2) : "-"}
        <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)", marginLeft: 4 }}>{unit}</span>
      </p>
    </div>
  );
}

function TtmLineChart({ days }: { days: MufgDailyRate[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 760;
  const height = 260;
  const marginLeft = 48;
  const marginRight = 16;
  const marginTop = 16;
  const marginBottom = 32;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  if (days.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--text-muted)" }}>この月は表示できるデータがありません。</p>
    );
  }

  const ttmValues = days.map((d) => d.ttm);
  const rawMin = Math.min(...ttmValues);
  const rawMax = Math.max(...ttmValues);
  const padding = Math.max((rawMax - rawMin) * 0.15, 0.5);
  const yMin = rawMin - padding;
  const yMax = rawMax + padding;

  const step = niceStep((yMax - yMin) / 4);
  const tickStart = Math.ceil(yMin / step) * step;
  const yTicks: number[] = [];
  for (let t = tickStart; t <= yMax; t += step) {
    yTicks.push(Math.round(t * 100) / 100);
  }

  function xForIndex(i: number): number {
    if (days.length === 1) return marginLeft + plotWidth / 2;
    return marginLeft + (plotWidth * i) / (days.length - 1);
  }
  function yForValue(v: number): number {
    return marginTop + plotHeight - ((v - yMin) / (yMax - yMin)) * plotHeight;
  }

  const linePoints = days.map((d, i) => `${xForIndex(i)},${yForValue(d.ttm)}`).join(" ");

  // x軸ラベルは詰まりすぎないよう、日数に応じて間引く(最初・最後は必ず表示)
  const labelEvery = days.length <= 10 ? 1 : Math.ceil(days.length / 8);
  const xLabelIndices = days
    .map((_, i) => i)
    .filter((i) => i === 0 || i === days.length - 1 || i % labelEvery === 0);

  const lastIndex = days.length - 1;
  const lastPoint = days[lastIndex];

  function handlePointerMove(e: React.PointerEvent<SVGRectElement>) {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = width / rect.width;
    const localX = (e.clientX - rect.left) * scaleX;
    let closest = 0;
    let closestDist = Infinity;
    for (let i = 0; i < days.length; i++) {
      const dist = Math.abs(xForIndex(i) - localX);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    }
    setHoverIndex(closest);
  }

  const hovered = hoverIndex !== null ? days[hoverIndex] : null;

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        style={{ display: "block", overflow: "visible" }}
      >
        {/* Y軸グリッドライン・目盛りラベル */}
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={marginLeft}
              x2={width - marginRight}
              y1={yForValue(t)}
              y2={yForValue(t)}
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={marginLeft - 8}
              y={yForValue(t)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--text-muted)"
            >
              {t.toFixed(1)}
            </text>
          </g>
        ))}

        {/* X軸ラベル */}
        {xLabelIndices.map((i) => (
          <text
            key={i}
            x={xForIndex(i)}
            y={height - marginBottom + 16}
            textAnchor="middle"
            fontSize={11}
            fill="var(--text-muted)"
          >
            {formatDateLabel(days[i].date)}
          </text>
        ))}

        {/* TTM折れ線 */}
        <polyline
          points={linePoints}
          fill="none"
          stroke={ACCENT}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {/* 末尾の値ラベル(直接ラベルは末尾のみ) */}
        <circle
          cx={xForIndex(lastIndex)}
          cy={yForValue(lastPoint.ttm)}
          r={5}
          fill={ACCENT}
          stroke="var(--surface-2)"
          strokeWidth={2}
        />
        <text
          x={xForIndex(lastIndex)}
          y={yForValue(lastPoint.ttm) - 12}
          textAnchor="end"
          fontSize={12}
          fontWeight={600}
          fill="var(--text-primary)"
        >
          {lastPoint.ttm.toFixed(2)}
        </text>

        {/* ホバー時のクロスヘア・ハイライト点 */}
        {hovered && (
          <>
            <line
              x1={xForIndex(hoverIndex!)}
              x2={xForIndex(hoverIndex!)}
              y1={marginTop}
              y2={height - marginBottom}
              stroke="var(--border-strong)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={xForIndex(hoverIndex!)}
              cy={yForValue(hovered.ttm)}
              r={5}
              fill={ACCENT}
              stroke="var(--surface-2)"
              strokeWidth={2}
            />
          </>
        )}

        {/* ポインタ検出用の透明な当たり判定レイヤー(グラフ全体) */}
        <rect
          x={marginLeft}
          y={marginTop}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        />
      </svg>

      {hovered && (
        <div
          style={{
            position: "absolute",
            top: 4,
            left: Math.min(Math.max((xForIndex(hoverIndex!) / width) * 100, 12), 88) + "%",
            transform: "translateX(-50%)",
            background: "var(--text-primary)",
            color: "#fff",
            fontSize: 12,
            padding: "8px 10px",
            borderRadius: 8,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{formatDateLabel(hovered.date)}</div>
          <div>TTM: <strong>{hovered.ttm.toFixed(2)}</strong></div>
          <div style={{ color: "rgba(255,255,255,0.75)" }}>TTS: {hovered.tts.toFixed(2)} / TTB: {hovered.ttb.toFixed(2)}</div>
        </div>
      )}
    </div>
  );
}

export default function ExchangeRatePage() {
  const [yearMonth, setYearMonth] = useState(todayYearMonth());
  const [days, setDays] = useState<MufgDailyRate[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [ytdDays, setYtdDays] = useState<MufgDailyRate[]>([]);
  const [ytdLoading, setYtdLoading] = useState(false);
  const [ytdError, setYtdError] = useState<string | null>(null);

  // 月ごとの日別データのキャッシュ(セッション中の再取得を減らすため)。
  // 「今月」に該当する月だけは日が進むたびにデータが増えるため、常に最新を取り直す。
  const monthCacheRef = useRef<Map<string, MufgDailyRate[]>>(new Map());

  async function fetchMonthCached(ym: string, forceRefresh = false): Promise<MufgDailyRate[]> {
    const isLiveMonth = ym === todayYearMonth();
    if (!forceRefresh && !isLiveMonth && monthCacheRef.current.has(ym)) {
      return monthCacheRef.current.get(ym)!;
    }
    const result = await fetchMonthlyMufgDailyRates(ym);
    monthCacheRef.current.set(ym, result.days);
    return result.days;
  }

  async function load(targetYearMonth: string, forceRefresh = false) {
    if (targetYearMonth < MIN_YEAR_MONTH) {
      setErrorMessage(`${MIN_YEAR_MONTH}より前の年月は取得対象外です`);
      setDays([]);
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await fetchMonthCached(targetYearMonth, forceRefresh);
      setDays(result);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "取得に失敗しました");
      setDays([]);
    } finally {
      setLoading(false);
    }
  }

  // 対象年の1月〜対象月ぶんをまとめて取得し、年間推移グラフ用に連結する。
  // (各月とも既存のfetch-mufg-ttm-dailyロジックをそのまま流用。今月が対象範囲に含まれる場合、
  // その月だけは「今日までの進行日ぶん」しか返らないため、結果として範囲全体が
  // 「対象年の1月1日〜当月進行日まで」に自動的に揃う)
  async function loadYtd(targetYearMonth: string) {
    if (targetYearMonth < MIN_YEAR_MONTH) {
      setYtdDays([]);
      return;
    }
    const year = targetYearMonth.slice(0, 4);
    const targetMonthNum = Number(targetYearMonth.slice(5, 7));
    const months: string[] = [];
    for (let m = 1; m <= targetMonthNum; m++) {
      const ym = `${year}-${String(m).padStart(2, "0")}`;
      if (ym < MIN_YEAR_MONTH) continue;
      months.push(ym);
    }

    setYtdLoading(true);
    setYtdError(null);
    try {
      // 外部サイトへの同時アクセスを抑えるため、月単位でも同時実行数を制限する
      const CONCURRENCY = 3;
      const results: MufgDailyRate[][] = new Array(months.length);
      let index = 0;
      async function runNext(): Promise<void> {
        while (index < months.length) {
          const current = index++;
          results[current] = await fetchMonthCached(months[current]);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, months.length) }, () => runNext()),
      );
      const merged = results.flat().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      setYtdDays(merged);
    } catch (err) {
      setYtdError(err instanceof Error ? err.message : "取得に失敗しました");
      setYtdDays([]);
    } finally {
      setYtdLoading(false);
    }
  }

  useEffect(() => {
    void load(yearMonth);
    void loadYtd(yearMonth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearMonth]);

  const avgTts = useMemo(() => average(days.map((d) => d.tts)), [days]);
  const avgTtb = useMemo(() => average(days.map((d) => d.ttb)), [days]);
  const avgTtm = useMemo(() => average(days.map((d) => d.ttm)), [days]);

  const isCurrentMonth = yearMonth === todayYearMonth();
  const ytdYear = yearMonth.slice(0, 4);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", paddingBottom: "3rem", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>為替(三菱UFJ公表レート 日別推移)</h2>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>対象年月:</label>
        <input
          type="month"
          value={yearMonth}
          min={MIN_YEAR_MONTH}
          max={todayYearMonth()}
          onChange={(e) => setYearMonth(e.target.value)}
        />
        <button
          onClick={() => {
            void load(yearMonth, true);
            void loadYtd(yearMonth);
          }}
          disabled={loading}
          style={{ fontSize: 11, padding: "3px 8px" }}
        >
          {loading ? "取得中..." : "再取得"}
        </button>
      </div>

      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 16px" }}>
        三菱UFJ銀行公表のUSD/JPY相場(TTS・TTB・TTM)を、対象月の営業日ごとに取得して表示します。
        {isCurrentMonth
          ? " 今月を選択中のため、今日までに公表済みの営業日ぶんのみ表示しています。"
          : ""}
        {" "}土日・祝日等、レートが公表されていない日は表に含まれません。データの取得開始は2026年1月度からです。
      </p>

      {errorMessage && (
        <p style={{ fontSize: 13, color: "var(--danger-text)", marginBottom: 16 }}>{errorMessage}</p>
      )}

      {loading && days.length === 0 && !errorMessage && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>取得中...</p>
      )}

      {!loading && !errorMessage && days.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <StatTile label={`${yearMonth}分 平均TTS(${days.length}営業日)`} value={avgTts} unit="円" />
            <StatTile label={`${yearMonth}分 平均TTB(${days.length}営業日)`} value={avgTtb} unit="円" />
            <StatTile label={`${yearMonth}分 平均TTM(${days.length}営業日)`} value={avgTtm} unit="円" />
          </div>

          <div
            style={{
              marginBottom: 16,
              padding: "14px 16px",
              border: "0.5px solid var(--border)",
              borderRadius: 12,
              background: "var(--surface-2)",
            }}
          >
            <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 10px" }}>USD/JPY TTM の推移</p>
            <TtmLineChart days={days} />
          </div>

          <div
            style={{
              marginBottom: 16,
              padding: "14px 16px",
              border: "0.5px solid var(--border)",
              borderRadius: 12,
              background: "var(--surface-2)",
            }}
          >
            <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 4px" }}>
              年間推移(USD/JPY TTM){ytdDays.length > 0 && (
                <span style={{ fontWeight: 400, color: "var(--text-secondary)" }}>
                  {" "}
                  {ytdYear}年1月1日〜{formatDateLabel(ytdDays[ytdDays.length - 1].date)}
                </span>
              )}
            </p>
            {ytdError && (
              <p style={{ fontSize: 13, color: "var(--danger-text)", margin: "0 0 8px" }}>{ytdError}</p>
            )}
            {ytdLoading && ytdDays.length === 0 && !ytdError && (
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>取得中...</p>
            )}
            {!ytdLoading && !ytdError && ytdDays.length === 0 && (
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>表示できるデータがありません。</p>
            )}
            {!ytdError && ytdDays.length > 0 && <TtmLineChart days={ytdDays} />}
          </div>

          <div
            style={{
              padding: "14px 16px",
              border: "0.5px solid var(--border)",
              borderRadius: 12,
              background: "var(--surface-2)",
            }}
          >
            <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 10px" }}>日別レート一覧</p>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>日付</th>
                    <th style={{ textAlign: "right", padding: "6px 8px" }}>TTS</th>
                    <th style={{ textAlign: "right", padding: "6px 8px" }}>TTB</th>
                    <th style={{ textAlign: "right", padding: "6px 8px" }}>TTM</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.date} style={{ borderBottom: "0.5px solid var(--border)" }}>
                      <td style={{ padding: "6px 8px" }}>{formatDateLabel(d.date)}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {d.tts.toFixed(2)}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {d.ttb.toFixed(2)}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                        {d.ttm.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "2px solid var(--border-strong)", background: "var(--surface-1)" }}>
                    <td style={{ padding: "8px", fontWeight: 600 }}>平均({days.length}営業日)</td>
                    <td style={{ padding: "8px", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                      {avgTts !== null ? avgTts.toFixed(2) : "-"}
                    </td>
                    <td style={{ padding: "8px", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                      {avgTtb !== null ? avgTtb.toFixed(2) : "-"}
                    </td>
                    <td style={{ padding: "8px", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                      {avgTtm !== null ? avgTtm.toFixed(2) : "-"}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}

      {!loading && !errorMessage && days.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>この月は表示できるデータがありません。</p>
      )}
    </div>
  );
}

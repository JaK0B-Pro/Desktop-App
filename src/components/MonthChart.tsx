import { useState } from "react";
import { useApp } from "../context";
import type { MonthPoint } from "../types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: string) => {
  const [y, mm] = m.split("-");
  return `${MONTHS[Number(mm) - 1]} ${y.slice(2)}`;
};

/** Grouped bars: money in vs money out per month, with a hover tooltip. */
export function MonthChart({ data }: { data: MonthPoint[] }) {
  const { fmt } = useApp();
  const [hover, setHover] = useState<number | null>(null);
  const H = 180;
  const W = 640;
  const pad = { l: 8, r: 8, t: 10, b: 2 };
  const max = Math.max(1, ...data.flatMap((d) => [d.income, d.expense]));
  const slot = (W - pad.l - pad.r) / Math.max(1, data.length);
  const bw = Math.min(16, (slot - 10) / 2);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const base = H - pad.b;

  /** Bar with 4px rounded top, square at the baseline. */
  const bar = (x: number, v: number) => {
    const top = y(v);
    const h = base - top;
    if (h <= 0) return "";
    const r = Math.min(4, h, bw / 2);
    return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z`;
  };

  const hp = hover != null ? data[hover] : null;

  return (
    <div className="chart">
      <div className="legend">
        <span>
          <i style={{ background: "var(--series-in)" }} /> Money in
        </span>
        <span>
          <i style={{ background: "var(--series-out)" }} /> Money out
        </span>
      </div>
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
          {[0.25, 0.5, 0.75, 1].map((g) => (
            <line key={g} x1={pad.l} x2={W - pad.r} y1={y(max * g)} y2={y(max * g)} className="grid" />
          ))}
          <line x1={pad.l} x2={W - pad.r} y1={base} y2={base} className="axis" />
          {data.map((d, i) => {
            const cx = pad.l + slot * i + slot / 2;
            return (
              <g key={d.month} onMouseEnter={() => setHover(i)}>
                <rect x={pad.l + slot * i} y={0} width={slot} height={H} className={hover === i ? "hit on" : "hit"} />
                <path d={bar(cx - bw - 1, d.income)} fill="var(--series-in)" />
                <path d={bar(cx + 1, d.expense)} fill="var(--series-out)" />
              </g>
            );
          })}
        </svg>
        <div className="ticks" style={{ padding: `0 ${(pad.r / W) * 100}% 0 ${(pad.l / W) * 100}%` }}>
          {data.map((d, i) => (
            <span key={d.month}>{data.length <= 8 || i % 2 === (data.length - 1) % 2 ? monthName(d.month) : ""}</span>
          ))}
        </div>
        {hp && hover != null && (
          <div className="tooltip" style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}>
            <strong>{monthName(hp.month)}</strong>
            <div>
              <i style={{ background: "var(--series-in)" }} /> In <b>{fmt(hp.income)}</b>
            </div>
            <div>
              <i style={{ background: "var(--series-out)" }} /> Out <b>{fmt(hp.expense)}</b>
            </div>
            <div className="muted">Net {fmt(hp.income - hp.expense, { sign: true })}</div>
          </div>
        )}
      </div>
    </div>
  );
}

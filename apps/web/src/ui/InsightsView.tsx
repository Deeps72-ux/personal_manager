import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { formatPercent, formatSeconds } from "@pm/shared";
import {
  insightPoints,
  localDay,
  spanLabel,
  spanTicks,
  spanWindow,
  weightedMean,
  type InsightPoint,
  type Span,
  type Tick,
  type Window,
} from "../core/insights.ts";
import { ChevronLeft, ChevronRight } from "./icons.tsx";
import { useLive } from "./services.tsx";

const SPANS: { id: Span; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

/**
 * INSIGHTS: FOCUS and DEVIATION of every TIMER ✓ over time.
 * Move back and forth with ‹ ›, the ← → keys, or by swiping the charts.
 */
export function InsightsView() {
  const [span, setSpan] = useState<Span>("week");
  const [offset, setOffset] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [now] = useState(() => Date.now());
  const w = spanWindow(span, now, offset);

  // Rows are filed by day; a ✓ just after midnight may own a row of the day before.
  const from = localDay(w.start - 86_400_000);
  const to = localDay(w.end);
  const points =
    useLive(
      async (s) => insightPoints(await s.store.listLogsBetween(from, to)).filter((p) => p.t >= w.start && p.t < w.end),
      [from, to, w.start, w.end],
    ) ?? [];

  const move = (delta: number) => {
    setHover(null);
    setOffset((o) => o + delta);
  };
  const pickSpan = (s: Span) => {
    setHover(null);
    setSpan(s);
    setOffset(0);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "ArrowRight") move(1);
  };

  const focusAvg = weightedMean(points, (p) => p.focus);
  const devAvg = weightedMean(points, (p) => p.deviation);
  const ticks = spanTicks(span, w);
  const active = hover === null ? null : (points[hover] ?? null);

  return (
    <section className="view insights" onKeyDown={onKey}>
      <div className="calendar-head">
        <button className="icon" aria-label={`Previous ${span}`} onClick={() => move(-1)}>
          <ChevronLeft />
        </button>
        <h2>{spanLabel(span, w)}</h2>
        <button className="icon" aria-label={`Next ${span}`} onClick={() => move(1)}>
          <ChevronRight />
        </button>
        <button className="ghost small today-btn" onClick={() => move(-offset)} disabled={offset === 0}>
          Now
        </button>
      </div>

      <div className="segmented three insights-span" role="group" aria-label="Time span">
        {SPANS.map((s) => (
          <button key={s.id} type="button" aria-pressed={span === s.id} onClick={() => pickSpan(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="stat-row">
        <Stat label="Avg focus" value={focusAvg} />
        <Stat label="Avg deviation" value={devAvg} />
        <div className="stat">
          <span className="stat-label">Logs</span>
          <span className="stat-value">{points.length}</span>
        </div>
      </div>

      <Swipe onSwipe={move}>
        <Chart
          title="Focus"
          note="100% = one activity"
          points={points}
          pick={(p) => p.focus}
          w={w}
          ticks={ticks}
          hover={hover}
          onHover={setHover}
        />
        <Chart
          title="Deviation"
          note="0% = only your top priority"
          points={points}
          pick={(p) => p.deviation}
          w={w}
          ticks={ticks}
          hover={hover}
          onHover={setHover}
        />
      </Swipe>

      <div className="insight-detail" aria-live="polite">
        {active ? <PointDetail p={active} /> : points.length > 0 && <span className="hint">Hover or tap a point for details.</span>}
      </div>

      {points.length === 0 && (
        <p className="hint">No TIMER logs in this period. Scores are taken each time you press ✓ on the Timer.</p>
      )}

      {points.length > 0 && (
        <details className="insight-table">
          <summary>Show as table</summary>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Activities</th>
                <th>Time</th>
                <th>Focus</th>
                <th>Deviation</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={`${p.t}${p.title}`}>
                  <td>{when(p.t)}</td>
                  <td>{p.title}</td>
                  <td>{formatSeconds(p.seconds)}</td>
                  <td>{formatPercent(p.focus)}</td>
                  <td>{p.deviation === null ? "—" : formatPercent(p.deviation)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value === null ? "—" : formatPercent(value)}</span>
    </div>
  );
}

function PointDetail({ p }: { p: InsightPoint }) {
  return (
    <div className="point-detail">
      <strong>{when(p.t)}</strong>
      <span className="muted"> · {formatSeconds(p.seconds)}</span>
      <div className="point-title">{p.title}</div>
      <div>
        Focus <strong>{formatPercent(p.focus)}</strong> · Deviation{" "}
        <strong>{p.deviation === null ? "—" : formatPercent(p.deviation)}</strong>
      </div>
    </div>
  );
}

/** Horizontal swipe (touch, pen or mouse drag) → previous / next window. */
function Swipe({ onSwipe, children }: { onSwipe: (delta: number) => void; children: ReactNode }) {
  const startX = useRef<number | null>(null);
  const down = (e: PointerEvent) => {
    startX.current = e.clientX;
  };
  const up = (e: PointerEvent) => {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    startX.current = null;
    if (Math.abs(dx) > 60) onSwipe(dx > 0 ? -1 : 1);
  };
  return (
    <div className="swipe" onPointerDown={down} onPointerUp={up} onPointerCancel={() => (startX.current = null)}>
      {children}
    </div>
  );
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || 600);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.round(e.contentRect.width) || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const H = 170;
const PAD = { top: 12, right: 14, bottom: 26, left: 40 };
const Y_TICKS = [0, 25, 50, 75, 100];

interface ChartProps {
  title: string;
  note: string;
  points: readonly InsightPoint[];
  pick: (p: InsightPoint) => number | null;
  w: Window;
  ticks: readonly Tick[];
  hover: number | null;
  onHover: (i: number | null) => void;
}

/** One series, y fixed at 0–100%, x = time of the ✓ press. */
function Chart({ title, note, points, pick, w, ticks, hover, onHover }: ChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - w.start) / (w.end - w.start)) * plotW;
  const y = (v: number) => PAD.top + (1 - v / 100) * plotH;

  const marks = points
    .map((p, i) => ({ i, v: pick(p), cx: x(p.t) }))
    .filter((m): m is { i: number; v: number; cx: number } => m.v !== null)
    .map((m) => ({ ...m, cy: y(m.v) }));
  const path = marks.map((m, k) => `${k === 0 ? "M" : "L"}${m.cx.toFixed(1)},${m.cy.toFixed(1)}`).join("");

  // Hover snaps to the nearest point in x (hit area = whole plot).
  const nearest = (clientX: number, el: SVGSVGElement) => {
    const px = clientX - el.getBoundingClientRect().left;
    let best: number | null = null;
    let bestD = Infinity;
    for (const m of marks) {
      const d = Math.abs(m.cx - px);
      if (d < bestD) {
        bestD = d;
        best = m.i;
      }
    }
    return bestD <= 40 ? best : null;
  };

  const hovered = marks.find((m) => m.i === hover);

  return (
    <figure className="chart" ref={ref}>
      <figcaption>
        <span className="chart-title">{title}</span>
        <span className="chart-note">{note}</span>
      </figcaption>
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`${title} over time, ${marks.length} points`}
        onPointerMove={(e) => onHover(nearest(e.clientX, e.currentTarget))}
        onPointerLeave={(e) => e.pointerType === "mouse" && onHover(null)}
        onClick={(e) => onHover(nearest(e.clientX, e.currentTarget))}
      >
        {Y_TICKS.map((v) => (
          <g key={v}>
            <line className="grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
            <text className="axis" x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end">
              {v}%
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t.t} className="axis" x={x(t.t)} y={H - 8} textAnchor="middle">
            {t.label}
          </text>
        ))}
        {hovered && <line className="crosshair" x1={hovered.cx} x2={hovered.cx} y1={PAD.top} y2={PAD.top + plotH} />}
        {marks.length > 1 && <path className="series-line" d={path} />}
        {marks.map((m) => (
          <circle key={m.i} className={`series-dot ${m.i === hover ? "on" : ""}`} cx={m.cx} cy={m.cy} r={m.i === hover ? 5.5 : 4} />
        ))}
        {hovered && (
          <text
            className="value-label"
            x={Math.min(Math.max(hovered.cx, PAD.left + 20), PAD.left + plotW - 20)}
            y={hovered.cy - 10 < PAD.top + 8 ? hovered.cy + 20 : hovered.cy - 10}
            textAnchor="middle"
          >
            {formatPercent(hovered.v)}
          </text>
        )}
      </svg>
    </figure>
  );
}

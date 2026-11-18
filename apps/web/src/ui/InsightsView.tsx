import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { formatPercent, formatSeconds } from "@pm/shared";
import {
  insightPoints,
  localDay,
  matchSpan,
  panWindow,
  spanWindow,
  timeTicks,
  weightedMean,
  windowLabel,
  zoomWindow,
  type InsightPoint,
  type Span,
  type Window,
} from "../core/insights.ts";
import { ChevronLeft, ChevronRight } from "./icons.tsx";
import { useLive } from "./services.tsx";
import { attachTimeGestures } from "./time-gestures.ts";

const SPANS: { id: Span; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

const keyOf = (p: InsightPoint) => `${p.t}|${p.title}`;

/** Rows are fetched per whole month around the view, so panning re-queries rarely. */
function fetchRange(w: Window): { from: string; to: string } {
  const s = new Date(w.start);
  const e = new Date(w.end);
  return {
    from: localDay(new Date(s.getFullYear(), s.getMonth(), 0).getTime()), // last day of previous month
    to: localDay(new Date(e.getFullYear(), e.getMonth() + 1, 1).getTime()), // first day of next month
  };
}

/**
 * INSIGHTS: FOCUS and DEVIATION of every TIMER ✓ over time.
 * Day / Week / Month are presets; the time axis itself zooms and pans freely
 * (mouse wheel / drag, trackpad, pinch / swipe), down to one second.
 */
export function InsightsView() {
  const [view, setView] = useState<Window>(() => spanWindow("week", Date.now(), 0));
  const [hover, setHover] = useState<string | null>(null);

  const { from, to } = fetchRange(view);
  const all = useLive(async (s) => insightPoints(await s.store.listLogsBetween(from, to)), [from, to]) ?? [];
  const points = all.filter((p) => p.t >= view.start && p.t < view.end);
  const preset = matchSpan(view);
  const width = view.end - view.start;

  const move = (dir: number) => {
    // A preset steps by calendar unit (months differ in length); a free view by its width.
    setView((w) => {
      const s = matchSpan(w);
      return s ? spanWindow(s, w.start, dir) : panWindow(w, dir * (w.end - w.start));
    });
  };
  const pickSpan = (s: Span) => setView((w) => spanWindow(s, Math.min((w.start + w.end) / 2, Date.now()), 0));
  const now = () => {
    const t = Date.now();
    setView((w) => {
      const s = matchSpan(w);
      if (s) return spanWindow(s, t, 0);
      const width = w.end - w.start;
      return { start: t - width * 0.9, end: t + width * 0.1 };
    });
  };
  const zoom = (factor: number) => setView((w) => zoomWindow(w, factor));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") setView((w) => panWindow(w, -(w.end - w.start) / 4));
    else if (e.key === "ArrowRight") setView((w) => panWindow(w, (w.end - w.start) / 4));
    else if (e.key === "+" || e.key === "=") zoom(0.5);
    else if (e.key === "-") zoom(2);
    else return;
    e.preventDefault();
  };

  const focusAvg = weightedMean(points, (p) => p.focus);
  const devAvg = weightedMean(points, (p) => p.deviation);
  const active = hover === null ? null : (all.find((p) => keyOf(p) === hover) ?? null);
  const nowVisible = Date.now() >= view.start && Date.now() < view.end;

  return (
    <section className="view insights" onKeyDown={onKey}>
      <div className="calendar-head">
        <button className="icon" aria-label="Earlier" onClick={() => move(-1)}>
          <ChevronLeft />
        </button>
        <h2 className="insights-range">{windowLabel(view)}</h2>
        <button className="icon" aria-label="Later" onClick={() => move(1)}>
          <ChevronRight />
        </button>
        <button className="ghost small today-btn" onClick={now} disabled={nowVisible && preset !== null}>
          Now
        </button>
      </div>

      <div className="insights-controls">
        <div className="segmented three insights-span" role="group" aria-label="Time span">
          {SPANS.map((s) => (
            <button key={s.id} type="button" aria-pressed={preset === s.id} onClick={() => pickSpan(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="zoom-btns" role="group" aria-label="Zoom">
          <button className="icon" aria-label="Zoom out" onClick={() => zoom(2)}>
            −
          </button>
          <button className="icon" aria-label="Zoom in" onClick={() => zoom(0.5)}>
            +
          </button>
        </div>
      </div>

      <div className="stat-row">
        <Stat label="Avg focus" value={focusAvg} />
        <Stat label="Avg deviation" value={devAvg} />
        <div className="stat">
          <span className="stat-label">Logs</span>
          <span className="stat-value">{points.length}</span>
        </div>
      </div>

      <div className="charts">
        <Chart title="Focus" note="100% = one activity" all={all} pick={(p) => p.focus} view={view} setView={setView} hover={hover} onHover={setHover} />
        <Chart
          title="Deviation"
          note="0% = only your top priority"
          all={all}
          pick={(p) => p.deviation}
          view={view}
          setView={setView}
          hover={hover}
          onHover={setHover}
        />
      </div>
      <p className="hint">
        Drag or swipe sideways to move · scroll, pinch or double-click to zoom ({describeWidth(width)} shown)
      </p>

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
                <tr key={keyOf(p)}>
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

function describeWidth(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  if (s < 2 * 3600) return `${Math.round(s / 60)} min`;
  if (s < 2 * 86_400) return `${Math.round(s / 3600)} h`;
  if (s < 60 * 86_400) return `${Math.round(s / 86_400)} days`;
  if (s < 730 * 86_400) return `${Math.round(s / (30.44 * 86_400))} months`;
  return `${(s / (365.25 * 86_400)).toFixed(1)} years`;
}

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

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
const TICK_SPACING = 78; // px per x label

interface ChartProps {
  title: string;
  note: string;
  all: readonly InsightPoint[];
  pick: (p: InsightPoint) => number | null;
  view: Window;
  setView: (w: Window) => void;
  hover: string | null;
  onHover: (key: string | null) => void;
}

/** One series, y fixed at 0–100%, x = time of the ✓ press, zoomable / pannable. */
function Chart({ title, note, all, pick, view, setView, hover, onHover }: ChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const span = view.end - view.start;
  const x = (t: number) => PAD.left + ((t - view.start) / span) * plotW;
  const y = (v: number) => PAD.top + (1 - v / 100) * plotH;

  // Visible points, plus one on each side so the line runs off the edges.
  const scored = all.map((p) => ({ p, v: pick(p) })).filter((m): m is { p: InsightPoint; v: number } => m.v !== null);
  const firstIn = scored.findIndex((m) => m.p.t >= view.start);
  const lo = firstIn === -1 ? scored.length - 1 : Math.max(0, firstIn - 1);
  let hi = scored.findIndex((m) => m.p.t >= view.end);
  hi = hi === -1 ? scored.length : hi + 1;
  const marks = scored.slice(Math.max(0, lo), hi).map((m) => ({ key: keyOf(m.p), v: m.v, t: m.p.t, cx: x(m.p.t), cy: y(m.v) }));
  const inView = marks.filter((m) => m.t >= view.start && m.t < view.end);
  const path = marks.map((m, k) => `${k === 0 ? "M" : "L"}${m.cx.toFixed(1)},${m.cy.toFixed(1)}`).join("");
  const ticks = timeTicks(view, Math.floor(plotW / TICK_SPACING));

  // Gestures read the latest values through a ref (listeners are attached once).
  const live = useRef({ view, setView, onHover, inView, plotW });
  live.current = { view, setView, onHover, inView, plotW };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const nearest = (clientX: number): string | null => {
      const px = clientX - el.getBoundingClientRect().left;
      let best: string | null = null;
      let bestD = 32;
      for (const m of live.current.inView) {
        const d = Math.abs(m.cx - px);
        if (d <= bestD) {
          bestD = d;
          best = m.key;
        }
      }
      return best;
    };
    return attachTimeGestures(el, {
      view: () => live.current.view,
      setView: (w) => live.current.setView(w),
      plot: () => ({ left: el.getBoundingClientRect().left + PAD.left, width: live.current.plotW }),
      tap: (cx) => live.current.onHover(nearest(cx)),
      hover: (cx) => live.current.onHover(cx === null ? null : nearest(cx)),
    });
  }, []);

  const hovered = inView.find((m) => m.key === hover);
  const clipId = `clip-${title}`;

  return (
    <figure className="chart" ref={ref}>
      <figcaption>
        <span className="chart-title">{title}</span>
        <span className="chart-note">{note}</span>
      </figcaption>
      <svg ref={svgRef} width={width} height={H} role="img" aria-label={`${title} over time, ${inView.length} points`}>
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={0} width={plotW} height={H} />
          </clipPath>
        </defs>
        {Y_TICKS.map((v) => (
          <g key={v}>
            <line className="grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
            <text className="axis" x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end">
              {v}%
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <g key={t.t}>
            <line className="xtick" x1={x(t.t)} x2={x(t.t)} y1={PAD.top + plotH} y2={PAD.top + plotH + 4} />
            <text className="axis" x={x(t.t)} y={H - 8} textAnchor="middle">
              {t.label}
            </text>
          </g>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {hovered && <line className="crosshair" x1={hovered.cx} x2={hovered.cx} y1={PAD.top} y2={PAD.top + plotH} />}
          {marks.length > 1 && <path className="series-line" d={path} />}
          {inView.map((m) => (
            <circle key={m.key} className="series-dot" cx={m.cx} cy={m.cy} r={m.key === hover ? 5.5 : 4} />
          ))}
        </g>
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
        {/* Transparent surface so the whole plot (not just the marks) takes gestures. */}
        <rect className="gesture-surface" x={0} y={0} width={width} height={H} />
      </svg>
    </figure>
  );
}

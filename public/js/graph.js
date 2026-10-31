// Hand-rolled SVG strip for the run page: one sparkline per resource, one
// influence lane per character, a marker axis, and a cursor that follows the
// timeline. When t rewinds (a save reload) a new segment starts; segments
// that were later rewound over are drawn dashed and dim.
import { hm } from "./dom.js";

const NS = "http://www.w3.org/2000/svg";
const RES_H = 24;
const LANE_H = 16;
const GAP = 6;
const AXIS_H = 20;

function s(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Index of the last point whose event index is <= idx, or -1. */
function lastAtOrBefore(points, idx) {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].idx <= idx) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function niceStep(maxT, width) {
  const target = maxT / Math.max(2, Math.floor(width / 90));
  const steps = [60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
  return steps.find((step) => step >= target) ?? 28800;
}

/**
 * model: { maxT, segEnd: number[], cutAfter: number[], resources: Map<name, points>,
 *          lanes: Map<name, { points, marks }>, markers: [{ t, kind }] }
 * points: [{ t, v, seg, idx }] in event order.
 */
export function createGraph(container, model, onSeek) {
  let width = 0;
  let x = () => 0;
  let cursor = null;
  let readouts = [];
  let cursorIdx = 0;
  let cursorT = 0;

  /**
   * Step-line path(s) for one series. A point is "abandoned" when a later
   * segment (a reloaded save) restarts at or before its t: that stretch of
   * history was overwritten, so it is drawn dashed.
   */
  function stepPaths(points, y) {
    let solid = "";
    let dashed = "";
    const X = (t) => x(t).toFixed(1);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = points[i - 1];
      const next = points[i + 1];
      const cut = model.cutAfter[p.seg];
      const end = next && next.seg === p.seg ? next.t : model.segEnd[p.seg];
      const py = y(p.v).toFixed(1);
      if (prev && prev.seg === p.seg) {
        const v = `M${X(p.t)},${y(prev.v).toFixed(1)}V${py}`;
        if (p.t <= cut) solid += v;
        else dashed += v;
      }
      if (p.t < cut) solid += `M${X(p.t)},${py}H${X(Math.min(end, cut))}`;
      if (end > cut) dashed += `M${X(Math.max(p.t, cut))},${py}H${X(end)}`;
    }
    return [solid, dashed];
  }

  function band(g, top, height, points, label, format, minZero) {
    const values = points.map((p) => p.v);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (minZero) lo = Math.min(0, lo);
    if (hi === lo) hi = lo + 1;
    const y = (v) => top + height - 2 - ((v - lo) / (hi - lo)) * (height - 4);
    const [solid, dashed] = stepPaths(points, y);
    g.append(s("text", { x: 0, y: top + height / 2 + 4, class: "g-label" }, label));
    if (dashed) g.append(s("path", { d: dashed, class: "g-line abandoned" }));
    if (solid) g.append(s("path", { d: solid, class: "g-line" }));
    const readout = s("text", { x: width, y: top + height / 2 + 4, class: "g-value", "text-anchor": "end" });
    g.append(readout);
    readouts.push({ el: readout, points, format });
  }

  function render() {
    width = container.clientWidth;
    if (width === 0) return;
    const labelW = width < 520 ? 72 : 100;
    const valueW = 50;
    const x0 = labelW;
    const x1 = width - valueW;
    x = (t) => x0 + (model.maxT > 0 ? (t / model.maxT) * (x1 - x0) : 0);
    readouts = [];

    const g = s("g");
    let top = 2;
    for (const [name, points] of model.resources) {
      band(g, top, RES_H, points, name, (v) => String(v), true);
      top += RES_H;
    }
    if (model.resources.size && model.lanes.size) top += GAP;
    for (const [name, lane] of model.lanes) {
      g.append(s("line", { x1: x0, x2: x1, y1: top + LANE_H - 1.5, y2: top + LANE_H - 1.5, class: "g-lane-base" }));
      if (lane.points.length) band(g, top, LANE_H, lane.points, name, (v) => `inf ${v}`, true);
      else g.append(s("text", { x: 0, y: top + LANE_H / 2 + 4, class: "g-label" }, name));
      for (const mark of lane.marks) {
        const mx = x(mark.t);
        const mid = top + LANE_H / 2;
        const shape = mark.kind === "in" ? `${mx},${mid - 4} ${mx + 5},${mid} ${mx},${mid + 4}` : `${mx},${mid - 4} ${mx - 5},${mid} ${mx},${mid + 4}`;
        g.append(s("polygon", { points: shape, class: mark.kind === "in" ? "g-in" : "g-out" }));
      }
      top += LANE_H;
    }
    const plotBottom = top;

    // Axis: time ticks plus markers for sessions, feedback, errors and crashes.
    top += 4;
    const step = niceStep(model.maxT, x1 - x0);
    for (let t = 0; t <= model.maxT; t += step) {
      g.append(s("line", { x1: x(t), x2: x(t), y1: top, y2: top + 4, class: "g-tick" }));
      g.append(s("text", { x: x(t), y: top + AXIS_H - 3, class: "g-tick-label", "text-anchor": "middle" }, hm(t)));
    }
    for (const m of model.markers) {
      const mx = x(m.t);
      if (m.kind === "session") g.append(s("line", { x1: mx, x2: mx, y1: 0, y2: plotBottom, class: "g-session" }));
      else if (m.kind === "feedback") g.append(s("circle", { cx: mx, cy: top + 3, r: 3.5, class: "g-feedback" }));
      else if (m.kind === "error") g.append(s("line", { x1: mx, x2: mx, y1: top - 2, y2: top + 7, class: "g-error" }));
      else if (m.kind === "crash") g.append(s("text", { x: mx, y: top + 7, class: "g-crash", "text-anchor": "middle" }, "✕"));
    }
    const height = top + AXIS_H;

    cursor = s("line", { y1: 0, y2: plotBottom + 8, class: "g-cursor" });
    g.append(cursor);
    const svg = s("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "graph-svg", role: "img", "aria-label": "Resources and influence over play time" });
    svg.append(g);
    attachScrub(svg, x0, x1);
    container.replaceChildren(svg);
    setCursor(cursorIdx, cursorT);
  }

  function attachScrub(svg, x0, x1) {
    let frame = 0;
    let lastX = 0;
    const seek = () => {
      frame = 0;
      const ratio = Math.min(1, Math.max(0, (lastX - x0) / (x1 - x0)));
      onSeek(ratio * model.maxT);
    };
    const move = (event) => {
      lastX = event.clientX - svg.getBoundingClientRect().left;
      if (!frame) frame = requestAnimationFrame(seek);
    };
    svg.addEventListener("pointerdown", (event) => {
      svg.setPointerCapture(event.pointerId);
      move(event);
      svg.addEventListener("pointermove", move);
    });
    const stop = () => svg.removeEventListener("pointermove", move);
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointercancel", stop);
  }

  /** Moves the cursor to event `idx` and updates the value readouts. */
  function setCursor(idx, t) {
    cursorIdx = idx;
    cursorT = t;
    if (!cursor) return;
    const cx = x(t).toFixed(1);
    cursor.setAttribute("x1", cx);
    cursor.setAttribute("x2", cx);
    for (const r of readouts) {
      const i = lastAtOrBefore(r.points, idx);
      r.el.textContent = i >= 0 ? r.format(r.points[i].v) : "";
    }
  }

  render();
  return { render, setCursor };
}

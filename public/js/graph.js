// Hand-rolled SVG strip for the run page: one sparkline per resource, one
// influence lane per character, a marker axis, and a cursor that follows the
// timeline. Time is the replay clock (only moves forward); a save reload is a
// ↺ on the axis, not a jump back.
import { hm } from "./dom.js";
import { ICONS, RESOURCE_ICONS } from "./icons.js";

// Only characters get colour: one categorical slot each, fixed order, validated
// for CVD separation and contrast on the dark surface. Resources, and characters
// past the sixth, are drawn in neutral grey. Every series has its own labelled row,
// so colour is never the only cue.
const CHARACTER_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];
const NEUTRAL = "#b4b4b1";

const NS = "http://www.w3.org/2000/svg";
const RES_H = 24;
const LANE_H = 28;
const PROJECT_H = 18; // one per simultaneous project
const GAP = 6;
const AXIS_H = 20;

function s(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * A Phosphor icon centred on (cx, cy), `size` px square, filled with `color`, with hover text.
 * `backdrop` puts a page-coloured disc behind it so the lane line doesn't show through the
 * icon's cut-outs (eyes, mouth, fingers).
 */
function icon(name, cx, cy, size, color, title, cls, backdrop = false) {
  const g = s("g", { class: cls });
  if (title) g.append(s("title", {}, title));
  if (backdrop) g.append(s("circle", { cx, cy, r: size * 0.42, class: "g-icon-backdrop" }));
  const svg = s("svg", { x: cx - size / 2, y: cy - size / 2, width: size, height: size, viewBox: "0 0 256 256" });
  svg.append(s("path", { d: ICONS[name], fill: color }));
  g.append(svg);
  return g;
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
 * model: { maxT, resources: Map<name, points>, lanes: Map<name, { points, marks }>, markers: [{ t, kind }] }
 * points: [{ t, v, idx }] in event order. Lane marks: in / out (appeared, left) and mended / broke
 * (a grievance resolved, or refused / out of turns / dropped), with an optional hover title.
 */
export function createGraph(container, model, onSeek) {
  let width = 0;
  let valueX = 0;
  let x = () => 0;
  let cursor = null;
  let readouts = [];
  let cursorIdx = 0;
  let cursorT = 0;

  /** Step-line path for one series, held until the end of the run. */
  function stepPath(points, y) {
    let d = "";
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const next = points[i + 1];
      const py = y(p.v).toFixed(1);
      if (i > 0) d += `V${py}`;
      else d += `M${x(p.t).toFixed(1)},${py}`;
      d += `H${x(next ? next.t : model.maxT).toFixed(1)}`;
    }
    return d;
  }

  /** `readoutPoints`: what the value readout follows, when not the plotted points. */
  function band(g, top, height, points, label, format, color, iconName, readoutPoints = points) {
    const values = points.map((p) => p.v);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    lo = Math.min(0, lo);
    if (hi === lo) hi = lo + 1;
    const y = (v) => top + height - 2 - ((v - lo) / (hi - lo)) * (height - 4);
    const path = stepPath(points, y);
    const mid = top + height / 2;
    if (iconName) g.append(icon(iconName, 6, mid, 12, color, null, "g-label-icon"));
    else g.append(s("line", { x1: 0, x2: 8, y1: mid, y2: mid, stroke: color, class: "g-swatch" }));
    g.append(s("text", { x: iconName ? 17 : 14, y: mid + 4, class: "g-label" }, label));
    if (path) g.append(s("path", { d: path, stroke: color, class: "g-line" }));
    const readout = s("text", { x: valueX, y: mid + 4, class: "g-value", "text-anchor": "end" });
    g.append(readout);
    readouts.push({ el: readout, points: readoutPoints, format });
    return y;
  }

  /**
   * A grievance as a section of the character's line, drawn like a protest: an angry face where it
   * fires, a band along the line while it is open, and the outcome where it ends: check = resolved,
   * cross = refused / out of turns / dropped. No end mark while it is still open (or cut by a reload).
   */
  function grievance(g, gv, lane, y, lineY, top, color) {
    // start: where a grievance open in a loaded save carries on (no angry face: it fired earlier).
    const t0 = gv.t0 ?? gv.start ?? null;
    const t1 = gv.t1 ?? model.maxT;
    const OUTCOME = { resolved: "resolved", refused: "refused", timeout: "ran out of turns", dropped: "dropped" };
    const what = `Grievance ${gv.name ?? "?"}`;
    if (t0 !== null) {
      const id = `gv-${++clipSeq}`;
      const clip = s("clipPath", { id });
      clip.append(s("rect", { x: x(t0), y: top, width: Math.max(0, x(t1) - x(t0)), height: LANE_H }));
      g.append(clip);
      const d = y ? stepPath(lane.points, y) : `M${x(t0)},${top + LANE_H / 2}H${x(t1)}`;
      g.append(s("path", { d, stroke: color, "clip-path": `url(#${id})`, class: "g-grievance-span" }));
      if (gv.t0 !== null) g.append(icon("smileyAngry", x(t0), lineY(gv.i0), 14, color, `${what} fired`, "g-grievance", true));
    }
    if (gv.outcome) {
      const ok = gv.outcome === "resolved";
      g.append(icon(ok ? "checkCircle" : "xCircle", x(t1), lineY(gv.i1), 14, color, `${what}: ${OUTCOME[gv.outcome] ?? gv.outcome}`, "g-grievance", true));
    }
  }
  let clipSeq = 0;

  function render() {
    width = container.clientWidth;
    if (width === 0) return;
    const labelW = width < 520 ? 116 : 156;
    valueX = labelW - 12;
    const x0 = labelW;
    const x1 = width - 6;
    x = (t) => x0 + (model.maxT > 0 ? (t / model.maxT) * (x1 - x0) : 0);
    readouts = [];

    const g = s("g");
    let top = 2;
    let slot = 0;
    const nextColor = () => CHARACTER_COLORS[slot++] ?? NEUTRAL;
    for (const [name, points] of model.resources) {
      band(g, top, RES_H, points, name, (v) => String(v), NEUTRAL, RESOURCE_ICONS[name]);
      top += RES_H;
    }
    if (model.resources.size && model.lanes.size) top += GAP;
    for (const [name, lane] of model.lanes) {
      g.append(s("line", { x1: x0, x2: x1, y1: top + LANE_H - 1.5, y2: top + LANE_H - 1.5, class: "g-lane-base" }));
      const color = nextColor();
      // Behind the level steps, faint and on its own scale: influence turn by turn (rises and falls).
      const inf = lane.influence ?? [];
      if (inf.length) {
        const values = inf.map((p) => p.v);
        const lo = Math.min(...values);
        const hi = Math.max(...values) === lo ? lo + 1 : Math.max(...values);
        const yi = (v) => top + LANE_H - 3 - ((v - lo) / (hi - lo)) * (LANE_H - 6);
        g.append(s("path", { d: stepPath(inf, yi), stroke: color, class: "g-influence" }));
      }
      // Readout: "L1 4/6" (level, influence progress / target) when influence was sent, else "L1".
      const format = inf.length
        ? (v, p) => `L${p.level ?? "?"} ${p.target ? `${p.progress}/${p.target}` : "max"}`
        : (v) => `L${v}`;
      const y = lane.points.length ? band(g, top, LANE_H, lane.points, name, format, color, undefined, inf.length ? inf : lane.points) : null;
      if (!y) g.append(s("text", { x: 14, y: top + LANE_H / 2 + 4, class: "g-label" }, name));
      // Marks sit on the character's line at that moment (its influence level), not on the row.
      const lineY = (idx) => {
        const at = y && typeof idx === "number" ? lastAtOrBefore(lane.points, idx) : -1;
        return at >= 0 ? y(lane.points[at].v) : top + LANE_H / 2;
      };
      for (const mark of lane.marks) {
        const mx = x(mark.t);
        const mid = lineY(mark.idx);
        const shape = mark.kind === "in" ? `${mx},${mid - 4} ${mx + 5},${mid} ${mx},${mid + 4}` : `${mx},${mid - 4} ${mx - 5},${mid} ${mx},${mid + 4}`;
        g.append(s("polygon", { points: shape, fill: color, class: mark.kind === "in" ? "g-in" : "g-out" }));
      }
      for (const gv of lane.grievances) grievance(g, gv, lane, y, lineY, top, color);
      top += LANE_H;
    }

    // Protests: a fist where one starts, a thin line while it lasts, a dimmer fist where it ends.
    if (model.protests.length) {
      top += GAP;
      const mid = top + LANE_H / 2;
      g.append(icon("handFist", 6, mid, 12, "currentColor", null, "g-protest"));
      g.append(s("text", { x: 17, y: mid + 4, class: "g-label" }, "protest"));
      for (const p of model.protests) {
        const why = p.cause ? ` over ${p.cause}` : "";
        const end = p.t1 ?? model.maxT;
        // t0 null: a protest open in a loaded save, carrying on from the load (it started earlier).
        g.append(s("line", { x1: x(p.t0 ?? p.start), x2: x(end), y1: mid, y2: mid, class: "g-protest-span" }));
        if (p.t1 !== null && !p.cut) g.append(icon("handFist", x(p.t1), mid, 12, "currentColor", "protest ended", "g-protest ended", true));
        if (p.t0 !== null) g.append(icon("handFist", x(p.t0), mid, 13, "currentColor", `protest started${why}`, "g-protest", true));
      }
      top += LANE_H;
    }

    // Tower projects. Each runs on its own lane while it is under construction (finished ones free
    // theirs for later projects): a building where it starts, a line, a dot per piece, a check where
    // it opens. A merged project bends into the lane of the one that absorbed it, like a git branch,
    // with a dot where they join. Readout: how many are under construction.
    if (model.projects.length) {
      top += GAP;
      const laneY = (lane) => top + PROJECT_H / 2 + lane * PROJECT_H;
      g.append(icon("building", 6, laneY(0), 12, "currentColor", null, "g-project"));
      g.append(s("text", { x: 17, y: laneY(0) + 4, class: "g-label" }, "projects"));
      const marks = s("g"); // dots and icons above every line and branch
      for (const p of model.projects) {
        const y = laneY(p.lane);
        const x0 = x(p.t0 ?? p.start);
        const x1 = x(p.t1 ?? model.maxT);
        if (p.mergedInto) {
          const yB = laneY(p.mergedInto.lane);
          const bend = Math.min(16, Math.max(0, x1 - x0));
          g.append(s("path", { d: `M${x0},${y}H${x1 - bend}C${x1 - bend / 2},${y} ${x1 - bend / 2},${yB} ${x1},${yB}`, class: "g-project-span" }));
          const join = s("circle", { cx: x1, cy: yB, r: 3, class: "g-project-join" });
          join.append(s("title", {}, `${p.label} merged into ${p.mergedInto.label}`));
          marks.append(join);
        } else {
          g.append(s("line", { x1: x0, x2: x1, y1: y, y2: y, class: "g-project-span" }));
        }
        for (const piece of p.pieces) {
          const dot = s("circle", { cx: x(piece.t), cy: y, r: 2.2, class: "g-project-piece" });
          dot.append(s("title", {}, `${p.label}: ${piece.piece ?? "piece"} · ${piece.height}/${piece.target} floors`));
          marks.append(dot);
        }
        if (p.opened) marks.append(icon("checkCircle", x1, y, 13, "currentColor", `${p.label} opened`, "g-project", true));
        if (p.t0 !== null) marks.append(icon("building", x0, y, 13, "currentColor", `${p.label} started`, "g-project", true));
      }
      g.append(marks);
      const readout = s("text", { x: valueX, y: laneY(0) + 4, class: "g-value", "text-anchor": "end" });
      g.append(readout);
      readouts.push({ el: readout, points: model.projectProgress, format: (v) => (v ? `${v} active` : "") });
      top += Math.max(1, model.projectLanes) * PROJECT_H;
    }
    const plotBottom = top;

    // Axis: time ticks plus markers for sessions, save reloads, feedback, errors and crashes.
    top += 4;
    const step = niceStep(model.maxT, x1 - x0);
    for (let t = 0; t <= model.maxT; t += step) {
      g.append(s("line", { x1: x(t), x2: x(t), y1: top, y2: top + 4, class: "g-tick" }));
      g.append(s("text", { x: x(t), y: top + AXIS_H - 3, class: "g-tick-label", "text-anchor": "middle" }, hm(t)));
    }
    for (const m of model.markers) {
      const mx = x(m.t);
      if (m.kind === "session") {
        // The player left and came back (the game resumed from its save): every line carries on.
        g.append(s("line", { x1: mx, x2: mx, y1: 0, y2: plotBottom, class: "g-session" }));
        g.append(icon("floppyDisk", mx, top + 5, 12, "currentColor", m.title ?? "left and returned", "g-reload"));
      }
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
      r.el.textContent = i >= 0 ? r.format(r.points[i].v, r.points[i]) : "";
    }
  }

  render();
  return { render, setCursor };
}

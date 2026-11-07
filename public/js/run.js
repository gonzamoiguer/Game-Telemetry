// #/run/:id — sticky summary + graph, then the full event timeline.
import { api, cell, clock, date, dur, h, hm, parseJson, shortId, span } from "./dom.js";
import { CATEGORIES, renderError, renderEvent } from "./events.js";
import { createGraph } from "./graph.js";
import { iconSvg } from "./icons.js";

const CHARACTER_TYPES = new Set(["character_appeared", "character_left", "character_gave", "influence_level_up", "situation", "grievance"]);
// Grievance phases that end one. A grievance is a section of its character's line, fired → outcome.
const GRIEVANCE_END = new Set(["resolved", "refused", "timeout", "dropped"]);
const LIVE_MS = 10 * 60 * 1000;

/**
 * Derives turns, resource series, character lanes and markers on the REPLAY clock `x`: the play time
 * as the player lived it, which only moves forward. The game's own clock `t` belongs to the save and
 * goes back when an older save is loaded; there the replay just carries on, with a save (floppy disk) marker.
 */
function buildModel(data) {
  const events = data.events.map((e, idx) => ({ ...e, idx, data: parseJson(e.data) }));
  const resources = new Map();
  const lanes = new Map();
  const markers = [];
  const protests = []; // { t0, t1 (null = still on), cause }
  let prevT = null;
  let x = 0;
  let turn = null;
  let lastTurn = null;

  const lane = (name) => {
    // points: the level (steps at level-ups); influence: the per-turn total, drawn faintly behind.
    if (!lanes.has(name)) lanes.set(name, { points: [], influence: [], marks: [], grievances: [] });
    return lanes.get(name);
  };

  for (const e of events) {
    if (prevT !== null) {
      if (e.t < prevT - 0.001) {
        markers.push({ t: x, kind: "reload" });
        // What was going on in the abandoned timeline stops here, without an outcome.
        for (const l of lanes.values()) {
          const open = l.grievances.at(-1);
          if (open && open.t1 === null) Object.assign(open, { t1: x, i1: e.idx });
        }
        const protest = protests.at(-1);
        if (protest && protest.t1 === null) Object.assign(protest, { t1: x, cut: true });
      }
      else x += e.t - prevT;
    }
    prevT = e.t;
    e.x = x;

    const d = e.data;
    if ((e.type === "turn" || e.type === "card_played") && typeof d.turn === "number") turn = d.turn;
    if (e.type === "turn" && typeof d.turn === "number") lastTurn = Math.max(lastTurn ?? 0, d.turn);
    e.turn = turn;

    if (d.res && typeof d.res === "object") {
      for (const [name, value] of Object.entries(d.res)) {
        if (typeof value !== "number") continue;
        if (!resources.has(name)) resources.set(name, []);
        resources.get(name).push({ t: x, v: value, idx: e.idx });
      }
    }
    if (e.type === "turn" && d.influence && typeof d.influence === "object") {
      for (const [name, inf] of Object.entries(d.influence)) {
        if (!inf || typeof inf.total !== "number") continue;
        lane(name).influence.push({ t: x, v: inf.total, idx: e.idx, level: inf.level, progress: inf.progress, target: inf.target });
      }
    }
    if (CHARACTER_TYPES.has(e.type) && typeof d.character === "string") {
      const l = lane(d.character);
      const point = (v) => l.points.push({ t: x, v, idx: e.idx });
      if (e.type === "character_appeared") {
        l.marks.push({ t: x, idx: e.idx, kind: "in" });
        if (!l.points.length) point(0);
      } else if (e.type === "character_left") l.marks.push({ t: x, idx: e.idx, kind: "out" });
      else if (e.type === "influence_level_up" && typeof d.level === "number") point(d.level);
      else if (e.type === "grievance") {
        // { t0, i0 } fired, { t1, i1, outcome } ended; null = before the data / still open.
        const open = l.grievances.at(-1)?.t1 === null ? l.grievances.at(-1) : null;
        if (d.phase === "fired") {
          if (open) Object.assign(open, { t1: x, i1: e.idx }); // a reload can skip an outcome
          l.grievances.push({ name: d.grievance, t0: x, i0: e.idx, t1: null, i1: null, outcome: null });
        } else if (GRIEVANCE_END.has(d.phase)) {
          const g = open && open.name === d.grievance ? open : null;
          if (open && !g) Object.assign(open, { t1: x, i1: e.idx });
          const target = g ?? (l.grievances.push({ name: d.grievance, t0: null, i0: null, t1: null, i1: null, outcome: null }), l.grievances.at(-1));
          Object.assign(target, { t1: x, i1: e.idx, outcome: d.phase });
        }
      }
    }
    if (e.type === "protest") {
      const open = protests.at(-1);
      if (d.active) {
        if (open && open.t1 === null) open.t1 = x; // a reload can skip an end
        protests.push({ t0: x, t1: null, cause: typeof d.cause === "string" ? d.cause : null });
      } else if (open && open.t1 === null) open.t1 = x;
    }
    if (e.type === "feedback") markers.push({ t: x, kind: "feedback" });
    if (e.type === "error") markers.push({ t: x, kind: "error" });
  }

  return { events, resources, lanes, markers, protests, maxT: Math.max(1, x), lastTurn };
}

/** Text for a session divider. */
function sessionTitle(session, number, first, prevLastT) {
  const start = first?.type === "session_start" ? first.data : {};
  const parts = [`Session ${number}`];
  if (start.resumed) parts.push(typeof start.gap_s === "number" ? `resumed ${span(start.gap_s)} later` : "resumed");
  else if (number === 1) parts.push("new run");
  else parts.push("restarted");
  parts.push(date(session.started_at), `build ${session.build}`);
  if (session.resolution) parts.push(session.resolution.replace("x", "×"));
  if (session.env !== "release") parts.push(session.env);
  let rewind = null;
  const loaded = typeof start.loaded_t === "number" ? start.loaded_t : first?.t;
  if (prevLastT !== null && typeof loaded === "number" && loaded < prevLastT - 1) {
    rewind = `reloaded save, rewound ${dur(prevLastT - loaded)}`;
  }
  return { text: parts.join(" · "), rewind };
}

const pad2 = (n) => String(n).padStart(2, "0");

function gutter(t, turn) {
  return h("span", { class: "gutter" }, h("span", { class: "t" }, clock(t)), h("span", { class: "turn" }, turn === null ? "" : `T${pad2(turn)}`));
}

/** Builds every timeline row. Returns { el, rows } where rows are in display order. */
function buildTimeline(model, data) {
  const rows = [];
  const frag = document.createDocumentFragment();
  const errors = new Map(); // `${session}|${message}` → { badge, count }
  const bySession = new Map(data.sessions.map((s) => [s.id, []]));
  for (const e of model.events) bySession.get(e.s)?.push(e);

  // Consecutive rows of the same turn in the same session share a group,
  // so the whole turn lights up when the cursor is on any of its rows.
  let group = 0;
  let groupKey = null;
  const push = (row, key) => {
    if (key === null || key !== groupKey) group += 1;
    groupKey = key;
    rows.push({ ...row, group });
    frag.append(row.el);
  };

  let prevLastT = null; // the save's clock, for "rewound …" in the divider
  let lastX = 0;
  let lastIdx = 0;
  data.sessions.forEach((session, i) => {
    const events = bySession.get(session.id) ?? [];
    const first = events[0];
    const title = sessionTitle(session, i + 1, first, prevLastT);
    if (first && i > 0) model.markers.push({ t: first.x, kind: "session" });
    const divider = h("div", { class: "row divider" }, h("span", { class: "divider-title" }, title.text),
      title.rewind ? h("span", { class: "rewind" }, iconSvg("floppyDisk", 12), title.rewind) : null);
    push({ el: divider, idx: first?.idx ?? lastIdx, t: first?.x ?? lastX, cat: "other" }, null);

    for (const e of events) {
      if (e.type === "session_start") continue; // folded into the divider
      if (e.type === "error_repeat") {
        const known = errors.get(`${e.s}|${e.data.message}`);
        if (known) {
          known.count = Math.max(known.count, e.data.count ?? 0);
          known.badge.textContent = `×${known.count}`;
          continue;
        }
      }
      const r = e.type === "error" || e.type === "error_repeat" ? renderError(e) : renderEvent(e);
      if (r.badge) errors.set(`${e.s}|${e.data.message}`, { badge: r.badge, count: e.data.count ?? 1 });
      const el = h("div", { class: `row cat-${r.cat} ${r.cls ?? ""}` }, gutter(e.x, e.turn),
        h("div", { class: "body" }, h("div", { class: "line" }, r.body), r.extra),
        h("span", { class: "type" }, e.type));
      push({ el, idx: e.idx, t: e.x, cat: r.cat }, e.turn === null ? null : `${e.s}|${e.turn}`);
    }

    const last = events[events.length - 1];
    if (last) {
      prevLastT = last.t;
      lastX = last.x;
      lastIdx = last.idx;
    }
    if (!session.clean_exit) {
      const live = i === data.sessions.length - 1 && Date.now() - data.run.last_seen_at < LIVE_MS;
      const end = live
        ? h("div", { class: "row divider live" }, "● in progress · no session_end yet")
        : h("div", { class: "row divider crash" }, "✕ crashed / killed · no session_end");
      if (!live && last) model.markers.push({ t: last.x, kind: "crash" });
      push({ el: end, idx: lastIdx, t: lastX, cat: "other" }, null);
    }
  });

  const el = h("div", { class: "timeline" });
  el.append(frag);
  return { el, rows };
}

export async function runView(main, id) {
  const data = await api(`runs/${id}`);
  const model = buildModel(data);
  const { el: timeline, rows } = buildTimeline(model, data);
  const crashes = data.sessions.filter((s) => !s.clean_exit).length;
  const run = data.run;
  const counts = new Map();
  for (const r of rows) counts.set(r.cat, (counts.get(r.cat) ?? 0) + 1);

  // Filter chips
  const hidden = new Set();
  let visible = rows;
  const chips = h("div", { class: "chips" }, CATEGORIES.map((cat) => {
    const chip = h("button", { type: "button", class: "chip", "aria-pressed": "true" }, cat, h("span", { class: "chip-count" }, counts.get(cat) ?? 0));
    chip.addEventListener("click", () => {
      if (hidden.has(cat)) hidden.delete(cat);
      else hidden.add(cat);
      chip.setAttribute("aria-pressed", String(!hidden.has(cat)));
      timeline.classList.toggle(`hide-${cat}`, hidden.has(cat));
      visible = rows.filter((r) => !hidden.has(r.cat));
      update();
    });
    return chip;
  }));

  const graphBox = h("div", { class: "graph" });
  const toggle = h("button", { type: "button", class: "chip", "aria-pressed": "true" }, "graph");
  toggle.addEventListener("click", () => {
    graphBox.hidden = !graphBox.hidden;
    toggle.setAttribute("aria-pressed", String(!graphBox.hidden));
  });

  const playerName = run.player_note || shortId(run.player_id);
  const summary = h("div", { class: "cells" },
    cell("player", h("a", { href: `#/player/${run.player_id}` }, playerName), "wide"),
    cell("started", date(run.started_at)),
    cell("play time", hm(run.play_time)),
    cell("last turn", model.lastTurn ?? "–"),
    cell("sessions", data.sessions.length),
    cell("crashes", crashes, crashes ? "alert" : ""),
    cell("events", data.events.length),
  );
  const header = h("header", { class: "run-head" }, summary, graphBox, h("div", { class: "toolbar" }, chips, toggle));

  const del = h("button", { type: "button", class: "button danger" }, "Delete run");
  del.addEventListener("click", async () => {
    if (!confirm("Delete this run and its screenshots? This cannot be undone.")) return;
    await api(`runs/${id}`, { method: "DELETE" });
    location.hash = `#/player/${run.player_id}`;
  });

  main.replaceChildren(
    h("p", { class: "crumbs" }, h("a", { href: "#/" }, "Players"), " / ", h("a", { href: `#/player/${run.player_id}` }, playerName), " / ",
      h("span", null, `run ${shortId(run.id)}`)),
    header,
    data.events.length ? timeline : h("p", { class: "muted" }, "No events in this run."),
    h("p", { class: "help" }, "J / K  next / previous checkpoint or feedback   ·   E  next error   ·   click a row to move the cursor there   ·   ESC  close screenshot"),
    h("div", { class: "danger-zone" }, h("span", { class: "mono muted" }, `run ${run.id}`), del),
  );

  // Cursor: the row at the top of the viewport, just under the sticky header.
  // Every row of the same turn is marked "current"; the exact row is "cursor".
  let current = null;
  const byGroup = new Map();
  for (const r of rows) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
  const groupRows = (g) => byGroup.get(g) ?? [];
  function currentIndex() {
    const top = header.getBoundingClientRect().bottom + 4; // rows scroll to 2px below the header
    let lo = 0;
    let hi = visible.length - 1;
    let found = visible.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (visible[mid].el.getBoundingClientRect().bottom > top) {
        found = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return found;
  }
  function update() {
    frame = 0;
    const row = visible[currentIndex()];
    if (!row) return;
    if (current !== row) {
      if (current?.group !== row.group) {
        if (current) for (const r of groupRows(current.group)) r.el.classList.remove("current");
        for (const r of groupRows(row.group)) r.el.classList.add("current");
      }
      current?.el.classList.remove("cursor");
      row.el.classList.add("cursor");
      current = row;
    }
    graph.setCursor(row.idx, row.t);
  }
  let frame = 0;
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  function scrollToRow(row, behavior = "auto") {
    if (row) row.el.scrollIntoView({ block: "start", behavior });
  }

  // Clicking a row moves the timeline position to it; error rows also toggle their stack.
  const rowOf = new Map(rows.map((r) => [r.el, r]));
  timeline.addEventListener("click", (event) => {
    if (event.target.closest("a, img, button")) return;
    const row = rowOf.get(event.target.closest(".row"));
    if (!row) return;
    if (row.cat === "errors") row.el.classList.toggle("open");
    scrollToRow(row, "smooth");
  });

  /** Nearest visible row at replay time t; ties prefer rows near the cursor. */
  function seek(t) {
    const here = current ?? visible[0];
    let best = null;
    let bestScore = Infinity;
    for (const r of visible) {
      const score = Math.abs(r.t - t) + Math.abs(r.idx - here.idx) * 1e-6;
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    }
    scrollToRow(best);
  }

  const graph = createGraph(graphBox, model, seek);

  function jump(categories, direction) {
    const start = currentIndex();
    for (let i = start + direction; i >= 0 && i < visible.length; i += direction) {
      if (categories.includes(visible[i].cat)) return scrollToRow(visible[i]);
    }
  }
  const onKey = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.("input, textarea")) return;
    if (event.key === "j") jump(["checkpoints", "feedback"], 1);
    else if (event.key === "k") jump(["checkpoints", "feedback"], -1);
    else if (event.key === "e") jump(["errors"], 1);
  };

  const setStickyHeight = () => document.documentElement.style.setProperty("--sticky-h", `${header.offsetHeight}px`);
  const observer = new ResizeObserver(() => {
    setStickyHeight();
    onScroll();
  });
  observer.observe(header);
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(graph.render, 100);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  document.addEventListener("keydown", onKey);
  setStickyHeight();
  update();

  return () => {
    observer.disconnect();
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKey);
    if (frame) cancelAnimationFrame(frame);
  };
}

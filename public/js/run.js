// #/run/:id — sticky summary + graph, then the full event timeline.
import { api, cell, clock, date, dur, h, hm, parseJson, shortId, span } from "./dom.js";
import { CATEGORIES, renderError, renderEvent } from "./events.js";
import { createGraph } from "./graph.js";
import { iconSvg } from "./icons.js";

const CHARACTER_TYPES = new Set(["character_appeared", "character_left", "character_gave", "influence_level_up", "situation", "grievance"]);
// Grievance phases that end one. A grievance is a section of its character's line, fired → outcome.
const GRIEVANCE_END = new Set(["resolved", "refused", "timeout", "dropped"]);
const LIVE_MS = 10 * 60 * 1000;
// Bookkeeping, not play: a save that is only "older" than these lost nothing.
const NOT_PLAY = new Set(["run_start", "session_start", "session_end", "idle", "checkpoint", "error", "error_repeat", "feedback"]);

/**
 * Derives turns, resource series, character lanes and markers on the REPLAY clock `x`: the play time
 * as the player lived it, which only moves forward. The game's own clock `t` belongs to the save.
 *
 * Quitting saves, so Continue normally resumes at the very moment the player left: the next session
 * starts a hair "earlier" than the last event (the clock ticked on after the save) and that is NOT a
 * load of an older save: everything simply continues. Only when play that happened after the save is
 * lost (a crash with an older autosave, a debug load) does the replay mark it with a floppy disk and
 * undo what started after the save (see loadSave).
 */
function buildModel(data) {
  const events = data.events.map((e, idx) => ({ ...e, idx, data: parseJson(e.data) }));
  const resources = new Map();
  const lanes = new Map();
  const markers = [];
  // Sections with a duration (protests, grievances, projects) also keep s0 / s1: the GAME clock when
  // they started / ended (-Infinity = before the data). That is what a loaded save is compared with.
  const protests = []; // { t0, t1 (null = still on), cause, s0, s1 }
  // Tower projects, keyed by instance id. Several can be under construction at once, and a merge ends
  // the absorbed ones in the survivor. One span per stretch of a project:
  // { name, label, id, t0 (null = started before this span), start, t1 (null = still building), opened,
  //   undone (a load went back to before it started), mergedInto (span), pieces: [{ t, height, target, piece }],
  //   lane, s0, s1 }.
  const projects = [];
  const projectById = new Map(); // id → its latest span
  const projectProgress = []; // how many are under construction, for the readout
  const projectLabel = projectLabels(events);
  let prevT = null;
  let lastPlayT = -Infinity; // game clock of the latest gameplay event in the current timeline
  const lost = new Map(); // session id → seconds of play a load undid
  let x = 0;
  let turn = null;
  let lastTurn = null;

  const lane = (name) => {
    // points: the level (steps at level-ups); influence: the per-turn total, drawn faintly behind.
    if (!lanes.has(name)) lanes.set(name, { points: [], influence: [], marks: [], grievances: [] });
    return lanes.get(name);
  };

  /**
   * A save is a snapshot of one moment; loading it resumes the game from there. So, at the load (replay
   * time x), for each kind of section: one open at the save moment simply continues; one that started
   * after the save never happened in the loaded game, so it stops here (no outcome); one that ended
   * after the save is open again, so it continues from here (its end stays where the player saw it).
   */
  function loadSave(save, idx) {
    const EPS = 0.001;
    const startedAfter = (sp) => sp.s0 > save + EPS;
    const openAtSave = (sp) => sp.s0 <= save + EPS && sp.s1 !== null && sp.s1 > save + EPS;

    for (const sp of [...protests, ...projects, ...[...lanes.values()].flatMap((l) => l.grievances)])
      if (sp.t1 === null && startedAfter(sp)) Object.assign(sp, { t1: x, i1: idx, undone: true, cut: true });

    // Reopen: the latest span of each thing only.
    const protest = protests.at(-1);
    if (protest && openAtSave(protest) && !protests.some((p) => p.t1 === null))
      protests.push({ t0: null, start: x, t1: null, cause: protest.cause, s0: save, s1: null });
    for (const l of lanes.values()) {
      const g = l.grievances.at(-1);
      if (g && openAtSave(g)) l.grievances.push({ name: g.name, t0: null, i0: idx, start: x, t1: null, i1: null, outcome: null, s0: save, s1: null });
    }
    for (const [id, p] of projectById) {
      if (!openAtSave(p)) continue;
      const again = { ...p, t0: null, start: x, t1: null, opened: false, undone: false, cut: false, mergedInto: null, pieces: [], s0: save, s1: null };
      projects.push(again);
      projectById.set(id, again);
    }
  }

  for (const e of events) {
    if (prevT !== null) {
      if (e.t < prevT - 0.001) {
        // The game is back at the moment it was saved (its clock `save`). Only a load if play was lost.
        const save = typeof e.data?.loaded_t === "number" ? e.data.loaded_t : e.t;
        if (lastPlayT > save + 0.05) {
          markers.push({ t: x, kind: "reload" });
          lost.set(e.s, lastPlayT - save);
          loadSave(save, e.idx);
          lastPlayT = save;
        }
      }
      else x += e.t - prevT;
    }
    prevT = e.t;
    e.x = x;
    if (!NOT_PLAY.has(e.type)) lastPlayT = Math.max(lastPlayT, e.t);

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
          if (open) Object.assign(open, { t1: x, i1: e.idx, s1: e.t }); // inconsistent data: never two at once
          l.grievances.push({ name: d.grievance, t0: x, i0: e.idx, t1: null, i1: null, outcome: null, s0: e.t, s1: null });
        } else if (GRIEVANCE_END.has(d.phase)) {
          const g = open && open.name === d.grievance ? open : null;
          if (open && !g) Object.assign(open, { t1: x, i1: e.idx, s1: e.t });
          const target = g ?? (l.grievances.push({ name: d.grievance, t0: null, i0: null, t1: null, i1: null, outcome: null, s0: -Infinity, s1: null }), l.grievances.at(-1));
          Object.assign(target, { t1: x, i1: e.idx, outcome: d.phase, s1: e.t });
        }
      }
    }
    if (e.type === "project" && typeof d.id === "string") {
      d._label = projectLabel.get(d.id) ?? d.project; // for the timeline row
      let p = projectById.get(d.id);
      if (!p || p.t1 !== null) {
        // New (or first seen mid-way: it started before the data, s0 unknown).
        p = { name: d.project, label: d._label, id: d.id, t0: null, start: x, t1: null, opened: false, undone: false, mergedInto: null, pieces: [],
          s0: d.phase === "started" ? e.t : -Infinity, s1: null };
        projects.push(p);
        projectById.set(d.id, p);
      }
      if (d.phase === "started" && p.t0 === null && p.start === x && !p.pieces.length) p.t0 = x;
      if (d.phase === "piece") p.pieces.push({ t: x, height: d.height, target: d.target, piece: d.piece });
      if (d.phase === "merged" && Array.isArray(d.absorbed)) {
        d._absorbed = d.absorbed.map((id) => projectLabel.get(id) ?? "another project");
        for (const id of d.absorbed) {
          const a = projectById.get(id);
          if (a && a.t1 === null) Object.assign(a, { t1: x, mergedInto: p, s1: e.t });
        }
      }
      if (d.phase === "opened") Object.assign(p, { t1: x, opened: true, s1: e.t });
      projectProgress.push({ t: x, v: projects.filter((q) => q.t1 === null).length, idx: e.idx });
    }
    if (e.type === "protest") {
      const open = protests.at(-1);
      if (d.active) {
        if (open && open.t1 === null) Object.assign(open, { t1: x, s1: e.t }); // inconsistent data: never two at once
        protests.push({ t0: x, start: x, t1: null, cause: typeof d.cause === "string" ? d.cause : null, s0: e.t, s1: null });
      } else if (open && open.t1 === null) Object.assign(open, { t1: x, s1: e.t });
    }
    if (e.type === "feedback") markers.push({ t: x, kind: "feedback" });
    if (e.type === "error") markers.push({ t: x, kind: "error" });
  }

  const projectLanes = assignProjectLanes(projects);
  return { events, resources, lanes, markers, protests, projects, projectLanes, projectProgress, lost, maxT: Math.max(1, x), lastTurn };
}

/**
 * "Torre_Nely", or "Torre_Nely #2" when that kind of project was built more than once in the run, so
 * simultaneous (and merging) towers of the same kind can be told apart. Numbered in order of appearance.
 */
function projectLabels(events) {
  const idsByName = new Map();
  for (const e of events) {
    if (e.type !== "project" || typeof e.data?.id !== "string") continue;
    const ids = idsByName.get(e.data.project) ?? [];
    for (const id of [e.data.id, ...(Array.isArray(e.data.absorbed) ? e.data.absorbed : [])]) if (!ids.includes(id)) ids.push(id);
    idsByName.set(e.data.project, ids);
  }
  const labels = new Map();
  for (const [name, ids] of idsByName) ids.forEach((id, i) => labels.set(id, ids.length > 1 ? `${name} #${i + 1}` : name));
  return labels;
}

/**
 * Gives each project span a lane: the first lane free when it starts (a finished or merged project
 * frees its lane, so later ones reuse it); simultaneous ones stack. A span that continues the same
 * project after a reload keeps its lane when it can. Returns how many lanes are used.
 */
function assignProjectLanes(projects) {
  const laneEnd = []; // per lane: when its last project ended (Infinity = still building)
  const lastLane = new Map(); // id → lane of its previous span
  for (const p of projects) {
    const end = p.t1 ?? Infinity;
    const prev = lastLane.get(p.id);
    let lane = prev !== undefined && laneEnd[prev] <= p.start ? prev : laneEnd.findIndex((t) => t < p.start);
    if (lane < 0) lane = laneEnd.length;
    laneEnd[lane] = end;
    p.lane = lane;
    lastLane.set(p.id, lane);
  }
  return laneEnd.length;
}

/** Text for a session divider. */
/** `lost`: seconds of play the session's load undid (it loaded a save older than where play got to). */
function sessionTitle(session, number, first, lost) {
  const start = first?.type === "session_start" ? first.data : {};
  const parts = [`Session ${number}`];
  if (start.resumed) parts.push(typeof start.gap_s === "number" ? `resumed ${span(start.gap_s)} later` : "resumed");
  else if (number === 1) parts.push("new run");
  else parts.push("restarted");
  parts.push(date(session.started_at), `build ${session.build}`);
  if (session.resolution) parts.push(session.resolution.replace("x", "×"));
  if (session.env !== "release") parts.push(session.env);
  const rewind = lost ? `loaded an older save · ${dur(lost)} of play undone` : null;
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

  let lastX = 0;
  let lastIdx = 0;
  data.sessions.forEach((session, i) => {
    const events = bySession.get(session.id) ?? [];
    const first = events[0];
    const title = sessionTitle(session, i + 1, first, model.lost.get(session.id));
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

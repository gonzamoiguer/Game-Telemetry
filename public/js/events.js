// One small renderer per event type. Each returns { cat, cls?, body, extra? }.
// `cat` drives the filter chips; "other" rows are always shown.
import { dur, h, screenshot } from "./dom.js";
import { iconSvg, RESOURCE_ICONS } from "./icons.js";

export const CATEGORIES = ["cards", "characters", "turns", "situations", "projects", "shop", "errors", "idle", "checkpoints", "feedback"];

const b = (text) => h("b", null, text);

const hasEntries = (o) => o && typeof o === "object" && Object.keys(o).length > 0;

/** [wall-icon 30, lightning-icon 5]: one item per resource, its icon (or name) then the value. */
function resNodes(res, format = (v) => String(v)) {
  if (!hasEntries(res)) return [];
  return Object.entries(res).map(([name, value]) => {
    const icon = RESOURCE_ICONS[name];
    return h("span", { class: "rv", title: name }, icon ? iconSvg(icon, 13) : `${name} `, format(value));
  });
}

/** A cost as resource items, or "free". */
const costNodes = (cost) => (hasEntries(cost) ? resNodes(cost) : "free");

/** A resource change: wall-icon −20, trash-icon +3 */
const deltaNodes = (delta) => resNodes(delta, (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}`);

const list = (a) => (Array.isArray(a) && a.length ? a.join(", ") : "");

const GRIEVANCE_PHASE = {
  fired: "has a grievance",
  hunt: "sent the player looking",
  found: "problem found",
  postponed: "player said “not now”",
  resolved: "resolved",
  refused: "player refused",
  timeout: "ran out of turns",
  dropped: "dropped (character gone)",
};

function grievance(d) {
  const phase = GRIEVANCE_PHASE[d.phase] ?? String(d.phase ?? "?");
  const rel = typeof d.relationship === "number" ? ` · relationship ${d.relationship.toFixed(2)}${d.band ? ` (${d.band})` : ""}` : "";
  const parts = [b(d.character ?? "?"), " · grievance ", b(d.grievance ?? "?"), " · ", phase];
  if (d.phase === "fired") {
    if (typeof d.turn_limit === "number") parts.push(` · ${d.turn_limit} turns`);
    if (d.target) parts.push(` · at ${d.target}`);
    if (Array.isArray(d.choices)) {
      const choices = d.choices.filter(Boolean).map((c) => (c.kind === "fix" ? ["fix ", costNodes(c.cost), c.affordable === false ? " (can't afford)" : ""] : c.kind));
      if (choices.length) parts.push(" · choices: ", choices.flatMap((c, i) => (i ? [" / ", c] : [c])));
    }
  } else if (d.phase === "resolved") {
    parts.push(" · paid ", costNodes(d.paid));
  } else if (typeof d.turns_left === "number" && d.phase !== "dropped") {
    parts.push(` · ${d.turns_left} turns left`);
  }
  if (d.consequence) parts.push(` · ${d.consequence === "leave" ? "character leaves" : d.consequence.replace(/^dislike:?/, "new dislike ")}`);
  parts.push(rel);
  const cls = d.phase === "resolved" ? "good" : d.phase === "refused" || d.phase === "timeout" ? "bad" : d.phase === "fired" ? "breakpoint" : "";
  return { cat: "situations", cls, body: withRes(d, parts) };
}

/** Tower projects: start and opening stand out; pieces and the closing hand-over are quiet rows. */
function project(d) {
  const floors = typeof d.height === "number" ? ` · ${d.height}/${d.target ?? "?"} floors` : "";
  const name = b(d.project ?? "?");
  switch (d.phase) {
    case "started":
      return { cat: "projects", cls: "project", body: withRes(d, [iconSvg("building", 14, "ico project-ico"), b("Project started"), " · ", d.project ?? "?",
        d.character ? ` (${d.character})` : "", typeof d.target === "number" ? ` · goal ${d.target} floors` : ""]) };
    case "piece":
      return { cat: "projects", cls: "dim", body: withRes(d, ["Piece ", d.piece ?? "?", " on ", name, floors,
        typeof d.pieces === "number" ? ` · ${d.pieces} piece${d.pieces === 1 ? "" : "s"}` : "", typeof d.multiplier === "number" ? ` · cost ×${d.multiplier}` : ""]) };
    case "goal_met":
      return { cat: "projects", body: [name, " reached its goal", floors, d.character ? ` · ${d.character} brings the closing piece` : ""] };
    case "closing_given":
      return { cat: "projects", cls: "dim", body: ["Closing piece of ", name, " in hand"] };
    case "opened":
      return { cat: "projects", cls: "project", body: withRes(d, [iconSvg("checkCircle", 14, "ico project-ico"), b("Project opened"), " · ", d.project ?? "?",
        typeof d.pieces === "number" ? ` · ${d.pieces} piece${d.pieces === 1 ? "" : "s"}` : "", floors, hasEntries(d.opening) ? [" · opening ", resNodes(d.opening)] : ""]) };
    default:
      return { cat: "projects", body: ["Project ", name, ` · ${d.phase ?? "?"}`] };
  }
}

function shopBuy(d) {
  const parts = ["Bought ", b(d.item ?? "?"), d.kind === "offer" ? " (offer)" : " (card)", " at ", d.shop ?? "?"];
  if (d.character) parts.push(` (${d.character})`);
  parts.push(" · price ", costNodes(d.price));
  if (hasEntries(d.delta)) parts.push(" · Δ ", deltaNodes(d.delta));
  if (list(d.cards_in)) parts.push(" · in: ", list(d.cards_in));
  if (list(d.cards_out)) parts.push(" · out: ", list(d.cards_out));
  if (typeof d.left === "number") parts.push(d.left < 0 ? "" : ` · ${d.left} left`);
  if (typeof d.hand === "number") parts.push(` · hand ${d.hand}${typeof d.hand_size === "number" ? `/${d.hand_size}` : ""}`);
  return { cat: "shop", body: withRes(d, parts) };
}

function withRes(d, nodes) {
  return hasEntries(d.res) ? [nodes, h("span", { class: "res" }, resNodes(d.res))] : nodes;
}

const END_REASON = { quit: "quit the game", title: "went back to the title screen", load: "loaded a save" };

const renderers = {
  run_start: (d) => ({ cat: "other", body: ["Run started", d.scenario ? [" · scenario ", b(d.scenario)] : null, d.legacy ? " · adopted a pre-telemetry save" : null] }),
  session_end: (d) => ({ cat: "other", cls: "dim", body: ["Session ended · ", END_REASON[d.reason] ?? String(d.reason ?? "")] }),
  card_played: (d) => ({
    cat: "cards",
    body: withRes(d, ["Played ", b(d.card ?? "?"), typeof d.kind === "string" ? ` (${d.kind})` : "", typeof d.turn === "number" ? ` · turn ${d.turn}` : ""]),
  }),
  removed: (d) => ({ cat: "cards", body: withRes(d, ["Removed ", b(d.what ?? "?")]) }),
  turn: (d) => ({
    cat: "turns",
    cls: "dim",
    body: [`Turn ${d.turn ?? "?"}`, typeof d.hand === "number" ? ` · hand ${d.hand}` : "", hasEntries(d.res) ? [" · ", resNodes(d.res)] : ""],
  }),
  character_appeared: (d) => ({ cat: "characters", body: [b(d.character ?? "?"), " appeared"] }),
  character_left: (d) => ({ cat: "characters", body: [b(d.character ?? "?"), " left"] }),
  character_gave: (d) => ({ cat: "characters", body: [b(d.character ?? "?"), " gave ", Array.isArray(d.cards) ? d.cards.join(", ") : "cards"] }),
  influence_level_up: (d) => ({ cat: "characters", body: [b(d.character ?? "?"), ` reached influence ${d.level ?? "?"}`] }),
  situation: (d) => ({
    cat: "situations",
    body: [
      "Situation ", b(d.situation ?? "?"),
      d.character ? ` (${d.character})` : "",
      d.phase === "chosen" ? ` · chose option ${d.offer ?? "?"}` : " · offered",
    ],
  }),
  protest: (d) => ({
    cat: "situations",
    cls: d.active ? "protest" : "protest dim",
    body: [iconSvg("handFist", 14, "ico protest-ico"), d.active ? b("Protest started") : "Protest ended", d.active && d.cause ? ` · over ${d.cause}` : ""],
  }),
  grievance,
  shop: (d) => ({
    cat: "shop",
    cls: d.phase === "close" ? "dim" : "",
    body: d.phase === "close"
      ? ["Left ", d.shop ?? "shop", ` · bought ${d.bought ?? 0}`]
      : withRes(d, ["Opened ", b(d.shop ?? "shop"), d.character ? ` (${d.character})` : "",
        typeof d.hand === "number" ? ` · hand ${d.hand}${typeof d.hand_size === "number" ? `/${d.hand_size}` : ""}` : ""]),
  }),
  shop_buy: shopBuy,
  project,
  checkpoint: (d, e) => ({
    cat: "checkpoints",
    cls: "checkpoint",
    body: withRes(d, ["Checkpoint", typeof d.fps_avg === "number" ? h("span", { class: "fps" }, ` · ${d.fps_avg.toFixed(0)} fps avg · ${(d.fps_min ?? 0).toFixed(0)} min`) : ""]),
    extra: d.shot ? screenshot(e.s, e.seq) : null,
  }),
  idle: (d) => ({ cat: "idle", cls: "idle", body: [`idle ${dur(d.seconds ?? 0)}`] }),
  feedback: (d, e) => ({
    cat: "feedback",
    cls: "feedback",
    body: [h("span", { class: "feedback-label" }, "Feedback"), h("q", null, d.text ?? "")],
    extra: d.shot ? screenshot(e.s, e.seq) : null,
  }),
};

/** Fallback for types the viewer does not know: type plus compact data. */
function generic(d, e) {
  const json = JSON.stringify(d);
  return { cat: "other", body: [h("span", { class: "mono" }, e.type), json === "{}" ? "" : h("span", { class: "res" }, json)] };
}

export function renderEvent(e) {
  return (renderers[e.type] ?? generic)(e.data, e);
}

/** Error rows: collapsed to the message; click to expand the stack. */
export function renderError(e) {
  const d = e.data;
  const badge = h("span", { class: "badge" }, `×${d.count ?? 1}`);
  return {
    cat: "errors",
    cls: "error",
    body: ["✕ ", h("span", { class: "error-message" }, d.message ?? "error"), " ", badge],
    extra: h("pre", { class: "stack" }, d.stack || "(no stack)"),
    badge,
  };
}

// One small renderer per event type. Each returns { cat, cls?, body, extra? }.
// `cat` drives the filter chips; "other" rows are always shown.
import { dur, h, screenshot } from "./dom.js";

export const CATEGORIES = ["cards", "characters", "turns", "situations", "shop", "errors", "idle", "checkpoints", "feedback"];

const b = (text) => h("b", null, text);

/** "Dinero 30 · Materiales 5" */
function resText(res) {
  if (!res || typeof res !== "object") return "";
  return Object.entries(res).map(([name, value]) => `${name} ${value}`).join(" · ");
}

/** "Dinero 30 · Materiales 5" for a cost, or "free". */
function costText(cost) {
  return cost && typeof cost === "object" && Object.keys(cost).length ? resText(cost) : "free";
}

/** "Dinero −20 · Basura +3" */
function deltaText(delta) {
  if (!delta || typeof delta !== "object") return "";
  return Object.entries(delta).map(([name, v]) => `${name} ${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}`).join(" · ");
}

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
      const choices = d.choices.filter(Boolean).map((c) => (c.kind === "fix" ? `fix ${costText(c.cost)}${c.affordable === false ? " (can't afford)" : ""}` : c.kind));
      if (choices.length) parts.push(` · choices: ${choices.join(" / ")}`);
    }
  } else if (d.phase === "resolved") {
    parts.push(` · paid ${costText(d.paid)}`);
  } else if (typeof d.turns_left === "number" && d.phase !== "dropped") {
    parts.push(` · ${d.turns_left} turns left`);
  }
  if (d.consequence) parts.push(` · ${d.consequence === "leave" ? "character leaves" : d.consequence.replace(/^dislike:?/, "new dislike ")}`);
  parts.push(rel);
  const cls = d.phase === "resolved" ? "good" : d.phase === "refused" || d.phase === "timeout" ? "bad" : d.phase === "fired" ? "breakpoint" : "";
  return { cat: "situations", cls, body: withRes(d, parts) };
}

function shopBuy(d) {
  const parts = ["Bought ", b(d.item ?? "?"), d.kind === "offer" ? " (offer)" : " (card)", " at ", d.shop ?? "?"];
  if (d.character) parts.push(` (${d.character})`);
  parts.push(` · price ${costText(d.price)}`);
  const delta = deltaText(d.delta);
  if (delta) parts.push(` · Δ ${delta}`);
  if (list(d.cards_in)) parts.push(" · in: ", list(d.cards_in));
  if (list(d.cards_out)) parts.push(" · out: ", list(d.cards_out));
  if (typeof d.left === "number") parts.push(d.left < 0 ? "" : ` · ${d.left} left`);
  if (typeof d.hand === "number") parts.push(` · hand ${d.hand}${typeof d.hand_size === "number" ? `/${d.hand_size}` : ""}`);
  return { cat: "shop", body: withRes(d, parts) };
}

function withRes(d, nodes) {
  const res = resText(d.res);
  return res ? [nodes, h("span", { class: "res" }, res)] : nodes;
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
    body: [`Turn ${d.turn ?? "?"}`, typeof d.hand === "number" ? ` · hand ${d.hand}` : "", d.res ? ` · ${resText(d.res)}` : ""],
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
  protest: (d) => ({ cat: "situations", body: [d.active ? "Protest started" : "Protest ended"] }),
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

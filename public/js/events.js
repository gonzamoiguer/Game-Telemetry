// One small renderer per event type. Each returns { cat, cls?, body, extra? }.
// `cat` drives the filter chips; "other" rows are always shown.
import { dur, h, screenshot } from "./dom.js";

export const CATEGORIES = ["cards", "characters", "turns", "situations", "errors", "idle", "checkpoints", "feedback"];

const b = (text) => h("b", null, text);

/** "Dinero 30 · Materiales 5" */
function resText(res) {
  if (!res || typeof res !== "object") return "";
  return Object.entries(res).map(([name, value]) => `${name} ${value}`).join(" · ");
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

/** Error rows: collapsed to the message; the stack is in the row's raw data (click). */
export function renderError(e) {
  const d = e.data;
  const badge = h("span", { class: "badge" }, `×${d.count ?? 1}`);
  return { cat: "errors", cls: "error", body: ["✕ ", h("span", { class: "error-message" }, d.message ?? "error"), " ", badge], badge };
}

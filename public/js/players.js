// #/ — every player, newest first.
import { ago, api, h, hm, shortId } from "./dom.js";

const ENVS = ["release", "dev", "editor"];
const selected = new Set(["release", "dev"]); // kept while the page is open

export async function playersView(main) {
  const table = h("div");
  const chips = h(
    "div",
    { class: "chips" },
    ENVS.map((env) => {
      const chip = h("button", { type: "button", class: "chip", "aria-pressed": String(selected.has(env)) }, env);
      chip.addEventListener("click", () => {
        if (selected.has(env)) selected.delete(env);
        else selected.add(env);
        chip.setAttribute("aria-pressed", String(selected.has(env)));
        load();
      });
      return chip;
    }),
  );

  async function load() {
    const { players } = await api(`players?env=${[...selected].join(",")}`);
    table.replaceChildren(
      h("p", { class: "label count" }, `${players.length} player${players.length === 1 ? "" : "s"}`),
      players.length ? renderTable(players) : h("p", { class: "muted" }, "No players yet."),
    );
  }

  await load();
  main.replaceChildren(h("header", { class: "page-head" }, h("h1", null, "Players"), h("span", { class: "label" }, "env"), chips), table);
}

function renderTable(players) {
  const go = (id) => () => (location.hash = `#/player/${id}`);
  return h(
    "table",
    { class: "list" },
    h("thead", null, h("tr", null, h("th", null, "Player"), h("th", null, "Last seen"), h("th", { class: "num" }, "Runs"),
      h("th", { class: "num" }, "Play time"), h("th", { class: "wide" }, "Last build"), h("th", { class: "num" }, "Marks"))),
    h(
      "tbody",
      null,
      players.map((p) =>
        h(
          "tr",
          { class: "link-row", onclick: go(p.id) },
          h("td", null, h("a", { href: `#/player/${p.id}` }, p.note || shortId(p.id)), p.note ? h("span", { class: "id" }, shortId(p.id)) : null),
          h("td", { class: "muted", title: new Date(p.last_seen_at).toLocaleString() }, ago(p.last_seen_at)),
          h("td", { class: "num" }, p.runs),
          h("td", { class: "num" }, hm(p.play_time)),
          h("td", { class: "muted mono small wide" }, p.last_build ?? ""),
          h(
            "td",
            { class: "num" },
            p.has_feedback ? h("span", { class: "mark-feedback", title: "has feedback" }, "●") : null,
            p.crashes > 0 ? h("span", { class: "mark-crash", title: "sessions without a clean exit" }, ` ✕${p.crashes}`) : null,
          ),
        ),
      ),
    ),
  );
}

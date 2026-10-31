// #/player/:id — note, runs and machines of one player.
import { api, date, h, hm, shortId } from "./dom.js";

export async function playerView(main, id) {
  const { player, runs, sessions } = await api(`players/${id}`);

  const note = h("input", { class: "note", maxlength: 200, placeholder: "Add a note (e.g. “cousin, first time”)", value: player.note });
  const saved = h("span", { class: "muted small" });
  note.addEventListener("blur", async () => {
    if (note.value === player.note) return;
    await api(`players/${id}`, { method: "PATCH", body: { note: note.value } });
    player.note = note.value;
    saved.textContent = "saved";
    setTimeout(() => (saved.textContent = ""), 1500);
  });

  const del = h("button", { type: "button", class: "danger" }, "Delete player");
  del.addEventListener("click", async () => {
    if (!confirm("Delete this player, all their runs and screenshots? This cannot be undone.")) return;
    await api(`players/${id}`, { method: "DELETE" });
    location.hash = "#/";
  });

  main.replaceChildren(
    h("p", { class: "crumbs" }, h("a", { href: "#/" }, "Players"), " / ", h("span", { class: "mono" }, shortId(id))),
    h("header", { class: "page-head" }, note, saved),
    h("p", { class: "muted small" }, `First seen ${date(player.created_at)} · last seen ${date(player.last_seen_at)} · `, h("span", { class: "mono" }, id)),
    h("h2", null, "Runs"),
    runsTable(runs),
    h("h2", null, "Machines"),
    machines(sessions),
    h("div", { class: "danger-zone" }, del),
  );
}

function runsTable(runs) {
  if (!runs.length) return h("p", { class: "muted" }, "No runs.");
  return h(
    "table",
    { class: "list" },
    h("thead", null, h("tr", null, h("th", null, "Started"), h("th", { class: "num" }, "Play time"), h("th", { class: "num" }, "Last turn"),
      h("th", { class: "num" }, "Sessions"), h("th", { class: "num" }, "Crashes"), h("th", { class: "num" }, "Feedback"))),
    h(
      "tbody",
      null,
      runs.map((r) =>
        h(
          "tr",
          { class: "link-row", onclick: () => (location.hash = `#/run/${r.id}`) },
          h("td", null, h("a", { href: `#/run/${r.id}` }, date(r.started_at))),
          h("td", { class: "num" }, hm(r.play_time)),
          h("td", { class: "num" }, r.last_turn ?? "–"),
          h("td", { class: "num" }, r.sessions),
          h("td", { class: "num" }, r.crashes ? h("span", { class: "mark-crash" }, r.crashes) : "0"),
          h("td", { class: "num" }, r.feedback ? h("span", { class: "mark-feedback" }, `● ${r.feedback}`) : "0"),
        ),
      ),
    ),
  );
}

/** Groups sessions by identical hardware so each machine is listed once. */
function machines(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const key = [s.os, s.cpu, s.gpu, s.ram_mb, s.resolution].join("|");
    const group = groups.get(key) ?? { s, count: 0, builds: new Set(), envs: new Set(), languages: new Set() };
    group.count += 1;
    group.builds.add(s.build);
    group.envs.add(s.env);
    if (s.language) group.languages.add(s.language);
    groups.set(key, group);
  }
  return h(
    "div",
    { class: "machines" },
    [...groups.values()].map(({ s, count, builds, envs, languages }) =>
      h(
        "dl",
        { class: "card machine" },
        row("OS", s.os), row("CPU", s.cpu), row("GPU", s.gpu),
        row("RAM", s.ram_mb ? `${Math.round(s.ram_mb / 1024)} GB` : null),
        row("Resolution", s.resolution?.replace("x", "×")),
        row("Language", [...languages].join(", ")),
        row("Env", [...envs].join(", ")),
        row("Sessions", String(count)),
        row("Builds", [...builds].join("\n")),
      ),
    ),
  );
}

function row(label, value) {
  return [h("dt", null, label), h("dd", null, value || "–")];
}

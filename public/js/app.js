// Hash router, login form and app shell.
import { AuthError, closeOverlay, h } from "./dom.js";
import { playersView } from "./players.js";
import { playerView } from "./player.js";
import { runView } from "./run.js";

const main = document.getElementById("app");
const logoutButton = document.getElementById("logout");
let cleanup = null;

const routes = [
  [/^#?\/?$/, () => playersView(main)],
  [/^#\/player\/([\w-]+)$/, (id) => playerView(main, id)],
  [/^#\/run\/([\w-]+)$/, (id) => runView(main, id)],
];

async function route() {
  if (cleanup) cleanup();
  cleanup = null;
  closeOverlay();
  main.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  const hash = location.hash || "#/";
  const match = routes.map(([re, view]) => [hash.match(re), view]).find(([m]) => m);
  try {
    if (!match) throw new Error("Page not found");
    window.scrollTo(0, 0);
    cleanup = (await match[1](...match[0].slice(1))) ?? null;
    logoutButton.hidden = false;
  } catch (err) {
    if (err instanceof AuthError) showLogin();
    else main.replaceChildren(h("p", { class: "error-text" }, err.message));
  }
}

function showLogin() {
  logoutButton.hidden = true;
  const input = h("input", { type: "password", name: "password", autocomplete: "current-password", required: true, placeholder: "Password" });
  const message = h("p", { class: "login-message" });
  const form = h("form", { class: "login" }, h("span", { class: "label" }, "Viewer access"), input, h("button", { type: "submit", class: "button primary" }, "Enter →"), message);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: input.value }),
    });
    if (res.ok) return route();
    const data = await res.json().catch(() => ({}));
    message.textContent = data.error || `Login failed (HTTP ${res.status})`;
    input.select();
  });
  main.replaceChildren(form);
  input.focus();
}

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  showLogin();
});

const overlay = document.getElementById("overlay");
overlay.addEventListener("click", closeOverlay);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeOverlay();
});

window.addEventListener("hashchange", route);
route();

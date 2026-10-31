// Tiny DOM, API and formatting helpers. Data is only ever inserted as text.

/** h("div", { class: "x", onclick }, "text", child, [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** A labelled readout: small uppercase label over a value. */
export function cell(label, value, cls = "") {
  return h("div", { class: `cell ${cls}` }, h("span", { class: "cell-label" }, label), h("span", { class: "cell-value" }, value));
}

export class AuthError extends Error {}

/** Calls the viewer API. Throws AuthError on 401 so the app can show the login form. */
export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/v/${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("login required");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const pad = (n) => String(n).padStart(2, "0");

/** Seconds → "h:mm:ss" */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** Seconds → "h:mm" */
export function hm(seconds) {
  const m = Math.max(0, Math.floor(seconds / 60));
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

/** Seconds → "6:52" or "1:02:10" (short durations) */
export function dur(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s >= 3600 ? clock(s) : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Seconds → "2 days", "3 hours", "5 minutes" */
export function span(seconds) {
  const units = [["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [name, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"}`;
  }
  return "moments";
}

/** Unix ms → "3 days ago" */
export function ago(ms) {
  const seconds = (Date.now() - ms) / 1000;
  return seconds < 60 ? "just now" : `${span(seconds)} ago`;
}

/** Unix ms → "2026-10-31 14:05" */
export function date(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const shortId = (id) => id.slice(0, 8);

export function parseJson(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Opens a screenshot full size in the overlay. */
export function openOverlay(src) {
  const overlay = document.getElementById("overlay");
  overlay.querySelector("img").src = src;
  overlay.hidden = false;
}

export function closeOverlay() {
  const overlay = document.getElementById("overlay");
  if (overlay.hidden) return false;
  overlay.hidden = true;
  overlay.querySelector("img").removeAttribute("src");
  return true;
}

/** A lazy-loaded screenshot that opens full size on click. */
export function screenshot(sessionId, seq) {
  const src = `/api/v/shot/${encodeURIComponent(sessionId)}/${seq}`;
  const img = h("img", { class: "shot", loading: "lazy", src, alt: "screenshot", onclick: () => openOverlay(src) });
  img.addEventListener("error", () => img.replaceWith(h("div", { class: "shot missing" }, "screenshot not uploaded (yet)")));
  return img;
}

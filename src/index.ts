/** Router: ingest API, viewer API and the static viewer page. */
import { isLoggedIn, login, logout } from "./auth";
import { fail, HttpError, type Env } from "./http";
import { ingest, putShot } from "./ingest";
import { viewerApi } from "./viewer-api";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};


function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  return secured;
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  const method = request.method;
  const [first, ...rest] = path;

  if (first === "ingest" && rest.length === 0) {
    return method === "POST" ? ingest(request, env) : fail(405, "use POST");
  }
  if (first === "shot" && rest.length === 2) {
    return method === "PUT" ? putShot(request, env, rest[0], rest[1]) : fail(405, "use PUT");
  }
  if (first === "login" && rest.length === 0) {
    return method === "POST" ? login(request, env) : fail(405, "use POST");
  }
  if (first === "logout" && rest.length === 0) {
    return method === "POST" ? logout() : fail(405, "use POST");
  }
  if (first === "v") {
    if (!(await isLoggedIn(request, env))) return fail(401, "login required");
    return viewerApi(request, env, rest, url);
  }
  return fail(404, "not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      response = url.pathname.startsWith("/api/") ? await api(request, env, url) : await env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) {
        response = fail(err.status, err.message);
      } else {
        console.error(err);
        response = fail(500, "internal error");
      }
    }
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;

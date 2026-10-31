/** Authenticated viewer API under /api/v/. The router checks the cookie first. */
import * as db from "./db";
import { fail, HttpError, isId, isObject, json, readJson, type Env } from "./http";
import { shotKey, shotParams } from "./ingest";

const ENVS = ["release", "dev", "editor"];

/** Deletes every screenshot stored for a run. */
async function deleteRunShots(bucket: R2Bucket, runId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `runs/${runId}/`, cursor });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function viewerApi(request: Request, env: Env, path: string[], url: URL): Promise<Response> {
  const method = request.method;
  const [resource, id, extra] = path;

  if (resource === "players" && id === undefined && method === "GET") {
    const requested = (url.searchParams.get("env") ?? "release,dev").split(",").filter((e) => ENVS.includes(e));
    return json({ players: requested.length ? await db.listPlayers(env.DB, requested) : [] });
  }

  if (resource === "players" && isId(id) && extra === undefined) {
    if (method === "GET") {
      const player = await db.getPlayer(env.DB, id);
      return player ? json(player) : fail(404, "no such player");
    }
    if (method === "PATCH") {
      const body = await readJson(request);
      if (!isObject(body) || typeof body.note !== "string" || body.note.length > 200) {
        throw new HttpError(400, "note must be a string of up to 200 chars");
      }
      return (await db.setNote(env.DB, id, body.note.trim())) ? json({ ok: true }) : fail(404, "no such player");
    }
    if (method === "DELETE") {
      const runIds = await db.runIdsForPlayer(env.DB, id);
      for (const runId of runIds) await deleteRunShots(env.SHOTS, runId);
      return (await db.deletePlayer(env.DB, id)) ? json({ ok: true }) : fail(404, "no such player");
    }
  }

  if (resource === "runs" && isId(id) && extra === undefined) {
    if (method === "GET") {
      const run = await db.getRun(env.DB, id);
      return run ? json(run) : fail(404, "no such run");
    }
    if (method === "DELETE") {
      if (!(await db.runExists(env.DB, id))) return fail(404, "no such run");
      await deleteRunShots(env.SHOTS, id);
      await db.deleteRun(env.DB, id);
      return json({ ok: true });
    }
  }

  if (resource === "shot" && method === "GET" && path.length === 3) {
    const params = shotParams(id, extra);
    if (!params) return fail(400, "bad session id or seq");
    const runId = await db.runIdForSession(env.DB, params.sessionId);
    const object = runId ? await env.SHOTS.get(shotKey(runId, params.sessionId, params.seq)) : null;
    if (!object) return fail(404, "no screenshot");
    return new Response(object.body, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" },
    });
  }

  return fail(404, "not found");
}

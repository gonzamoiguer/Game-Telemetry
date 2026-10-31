// npm run dev — local Worker with local D1/R2 and secrets from .dev.vars.
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DB_NAME, DEV_VARS, fatal, ROOT, wrangler } from "./lib/common.mjs";

if (!existsSync(DEV_VARS)) {
  copyFileSync(path.join(ROOT, ".dev.vars.example"), DEV_VARS);
  console.log("Created .dev.vars from .dev.vars.example (viewer password: dev).");
}
if (!wrangler(["d1", "migrations", "apply", DB_NAME, "--local"], { env: { CI: "true" } }).ok) fatal("Local migrations failed.");
wrangler(["dev"]);

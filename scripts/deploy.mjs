// npm run deploy — apply new migrations, then deploy the Worker.
import { DB_NAME, fatal, wrangler } from "./lib/common.mjs";

// CI=true makes wrangler skip its "are you sure?" prompt.
if (!wrangler(["d1", "migrations", "apply", DB_NAME, "--remote"], { env: { CI: "true" } }).ok) fatal("Migrations failed.");
if (!wrangler(["deploy"]).ok) fatal("Deploy failed.");

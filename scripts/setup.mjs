// npm run setup — one idempotent command from zero to a deployed Worker.
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { BUCKET, DB_NAME, fatal, readVars, ROOT, saveSecrets, SECRETS_FILE, wrangler } from "./lib/common.mjs";

const CONFIG = path.join(ROOT, "wrangler.jsonc");
const step = (n, text) => console.log(`\n[${n}/6] ${text}`);

// A short, easy-to-type word list for generated passphrases (256 words → 32 bits for 4 words,
// plenty against 5 guesses per 15 minutes).
const WORDS = (
  "acorn album amber anchor apple arrow aspen atlas autumn badge bagel balcony bamboo banjo barley basil beacon " +
  "bench berry bicycle biscuit blanket blossom bonfire border bottle bramble breeze brick bridge brook bubble bucket " +
  "butter button cabin cactus camel candle canoe canyon carpet carrot castle cedar cello chalk cherry chimney cider " +
  "cinema citrus clover cobalt coconut comet copper coral cotton cradle crane crayon cricket crystal cupboard dahlia " +
  "daisy delta denim desert diesel dolphin domino donkey dragon drum eagle easel echo elbow ember engine falcon " +
  "fennel ferry fiddle fig flannel flute forest fossil fountain fox galaxy garden garlic gazelle geyser ginger glacier " +
  "globe goose granite grape gravel guitar hammock harbor harvest hazel hedge helmet heron hickory honey horizon " +
  "iceberg igloo indigo island ivory jacket jasmine jelly jigsaw juniper kettle kiwi koala ladder lagoon lantern " +
  "lemon lentil library lilac linen lizard lobster locket lotus magnet mango maple marble meadow melon meteor mint " +
  "mirror mitten mosaic moss muffin mushroom nectar nickel noodle nutmeg oak oasis olive onion orbit orchid otter " +
  "paddle pancake panda paper parrot pastel peach pebble pepper piano pickle pigeon pillow pine planet plum pocket " +
  "pony poppy potato prism pumpkin puzzle quartz quill rabbit radish raft rainbow raven reef ribbon river robin " +
  "rocket saddle saffron salmon sandal satin scarf shadow shell silver sketch sled sparrow spinach spruce squirrel " +
  "stable starfish stone sugar summit sunset swan tangerine teapot thistle thunder tiger timber tomato topaz tractor " +
  "tulip tundra turnip umbrella valley velvet violet volcano wagon walnut walrus willow window yogurt zebra zephyr " +
  "badger beetle candy dune ferret hollow jungle kayak"
).split(/\s+/);

function passphrase() {
  return Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]).join("-");
}

// ---- 1. login
step(1, "Checking Cloudflare login");
const who = wrangler(["whoami"], { capture: true });
if (!who.ok || /not authenticated|You are not logged in/i.test(who.output)) {
  fatal("You are not logged in to Cloudflare. Run:\n\n    npx wrangler login\n\nthen run `npm run setup` again.");
}
console.log("  logged in.");

// ---- 2. D1
step(2, `D1 database "${DB_NAME}"`);
function findDatabase() {
  const list = wrangler(["d1", "list", "--json"], { capture: true });
  if (!list.ok) fatal(`Could not list D1 databases:\n${list.output}`);
  const json = list.output.slice(list.output.indexOf("["), list.output.lastIndexOf("]") + 1);
  return JSON.parse(json).find((db) => db.name === DB_NAME);
}
let database = findDatabase();
if (!database) {
  const created = wrangler(["d1", "create", DB_NAME], { capture: true });
  if (!created.ok) fatal(`Could not create the D1 database:\n${created.output}`);
  database = findDatabase();
  if (!database) fatal("The D1 database was created but does not show up in `wrangler d1 list`. Run setup again.");
  console.log("  created.");
} else console.log("  already exists.");
const config = readFileSync(CONFIG, "utf8");
const updated = config.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${database.uuid}$2`);
if (updated !== config) {
  writeFileSync(CONFIG, updated);
  console.log(`  wrote database_id ${database.uuid} to wrangler.jsonc`);
}

// ---- 3. R2
step(3, `R2 bucket "${BUCKET}"`);
const R2_HELP =
  "R2 is not enabled on this Cloudflare account yet. It is free for this usage, but Cloudflare asks for a\n" +
  "payment method before enabling it:\n\n" +
  "  1. Open https://dash.cloudflare.com and pick your account.\n" +
  "  2. In the left sidebar choose  Storage & Databases → R2 Object Storage  (older dashboards: just \"R2\").\n" +
  "  3. Click  \"Purchase R2 Plan\" / \"Add R2 subscription\"  and add a card when asked (the free tier costs $0).\n" +
  "  4. Come back and run `npm run setup` again.";
const buckets = wrangler(["r2", "bucket", "list"], { capture: true });
if (!buckets.ok) {
  if (/enable R2|10042/i.test(buckets.output)) fatal(R2_HELP);
  fatal(`Could not list R2 buckets:\n${buckets.output}`);
}
if (new RegExp(`name:\\s*${BUCKET}\\b`).test(buckets.output)) console.log("  already exists.");
else {
  const created = wrangler(["r2", "bucket", "create", BUCKET], { capture: true });
  if (!created.ok) {
    if (/enable R2|10042/i.test(created.output)) fatal(R2_HELP);
    fatal(`Could not create the R2 bucket:\n${created.output}`);
  }
  console.log("  created.");
}

// ---- 4. migrations
step(4, "Applying D1 migrations (remote)");
// CI=true makes wrangler skip its "are you sure?" prompt.
if (!wrangler(["d1", "migrations", "apply", DB_NAME, "--remote"], { env: { CI: "true" } }).ok) fatal("Migrations failed (see above).");

// ---- 5. secrets
step(5, "Secrets");
function remoteSecrets() {
  const list = wrangler(["secret", "list", "--format", "json"], { capture: true });
  if (!list.ok) return null;
  const json = list.output.slice(list.output.indexOf("["), list.output.lastIndexOf("]") + 1);
  return new Set(JSON.parse(json || "[]").map((s) => s.name));
}
let existing = remoteSecrets();
if (existing === null) {
  // Secrets can only be attached to a Worker that exists, so deploy once first.
  console.log("  the Worker does not exist yet; deploying it once so secrets can be attached…");
  if (!wrangler(["deploy"]).ok) fatal("Deploy failed (see above).");
  existing = remoteSecrets();
  if (existing === null) fatal("Could not list Worker secrets.");
}

const wanted = ["INGEST_KEY", "SESSION_SECRET", "VIEWER_PASSWORD"].filter((name) => !existing.has(name));
const generated = {};
for (const name of wanted) {
  let value;
  if (name === "VIEWER_PASSWORD") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    value = (await rl.question("  Viewer password (leave empty to generate a 4-word passphrase): ")).trim();
    rl.close();
    if (!value) value = passphrase();
  } else value = randomBytes(32).toString("hex");
  const put = wrangler(["secret", "put", name], { input: value });
  if (!put.ok) fatal(`Could not set ${name}:\n${put.output}`);
  generated[name] = value;
  console.log(`  set ${name}`);
}
if (wanted.length === 0) console.log("  all three secrets already set.");
if (Object.keys(generated).length) {
  saveSecrets(generated);
  console.log("\n  New secret values (shown once, also saved to .secrets.local.txt):");
  for (const [name, value] of Object.entries(generated)) console.log(`    ${name}=${value}`);
}

// ---- 6. deploy
step(6, "Deploying");
const deploy = wrangler(["deploy"], { capture: true });
console.log(deploy.output.trim().replace(/^/gm, "  "));
if (!deploy.ok && /workers\.dev subdomain/i.test(deploy.output)) {
  fatal(
    "This account has no workers.dev subdomain yet. Run `npx wrangler deploy` once and accept the prompt to\n" +
      "register one (or pick one in the dashboard under Workers & Pages), then run `npm run setup` again.",
  );
}
if (!deploy.ok) fatal("Deploy failed (see above).");
const url = deploy.output.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];

const ingestKey = readVars(SECRETS_FILE).INGEST_KEY;
console.log("\n✓ Done.\n");
console.log(`  Viewer / API URL:  ${url ?? "(see the deploy output above)"}`);
console.log(`  INGEST_KEY:        ${ingestKey ?? "(set earlier; not in .secrets.local.txt — rotate it as the README explains if you lost it)"}`);
console.log(`  Viewer password:   in ${path.basename(SECRETS_FILE)}`);
console.log("\n  Paste the URL and the INGEST_KEY into the Unity client.");
if (url) console.log(`  Check it end to end with:  npm run smoke -- ${url}\n`);

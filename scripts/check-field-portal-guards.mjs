import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src", "app", "api", "field-portal");
const PUBLIC_ROUTES = new Set([
  "invites/preview/route.ts",
  "invites/accept/route.ts",
  "otp/request/route.ts",
  "otp/verify/route.ts",
]);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const failures = [];
const files = walk(ROOT);
const routes = files.filter((f) => /(^|[\\/])route\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
if (routes.length === 0) failures.push("no field-portal routes found (path moved?)");
for (const f of files) {
  if (/(^|[\\/])(page|layout|default)\.(ts|tsx|js|jsx)$/.test(f)) {
    failures.push(`${relative(ROOT, f)}: pages are not allowed under api/field-portal`);
  }
}

for (const file of routes) {
  const rel = relative(ROOT, file).split("\\").join("/");
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);
  const isPublic = PUBLIC_ROUTES.has(rel);
  const wrapper = isPublic ? "publicPortalRoute" : "withFieldPerson";
  const other = isPublic ? "withFieldPerson" : "publicPortalRoute";

  if (!/\.ts$/.test(rel)) failures.push(`${rel}: use route.ts so the check covers it`);

  const exported = [];
  for (const m of METHODS) {
    const decl = new RegExp(`export\\s+const\\s+${m}\\s*(?::[^=]+)?=\\s*([\\s\\S]{0,80})`).exec(src);
    if (decl) {
      exported.push(m);
      if (!new RegExp(`^${wrapper}\\s*(<[\\s\\S]*?>)?\\s*\\(`).test(decl[1])) {
        failures.push(`${rel}: ${m} must be wrapped in ${wrapper}(...)`);
      }
    }
  }
  if (exported.length === 0) failures.push(`${rel}: no wrapped handlers exported`);
  if (new RegExp(`\\b${other}\\b`).test(src)) failures.push(`${rel}: uses ${other}, which is not allowed here`);
  if (/export\s+(async\s+)?function\s/.test(src)) failures.push(`${rel}: exports a bare function; wrap it`);
  if (/export\s+default\b/.test(src)) failures.push(`${rel}: default export is not allowed`);
  if (/export\s*\{/.test(src)) failures.push(`${rel}: re-exports are not allowed`);
  if (/x-user-uid|requireUid|requireSubAccountMember|requireFieldServices|requireTenancy/.test(src)) {
    failures.push(`${rel}: staff auth must not be used in portal routes`);
  }
}

if (failures.length) {
  console.error("Field portal guard check failed:\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log(`✓ Field portal guard check passed: ${routes.length} routes`);

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const target = fileURLToPath(new URL("../.env.local", import.meta.url));
const random = () => randomBytes(24).toString("hex");
function applicationBindings(bootstrap) {
  const migration = new URL(bootstrap);
  migration.username = "wms_migrator";
  migration.password = random();
  const app = new URL(bootstrap);
  app.username = "wms_app";
  app.password = random();
  return {
    BOOTSTRAP_DATABASE_URL: bootstrap,
    MIGRATION_DATABASE_URL: migration.href,
    DATABASE_URL: app.href,
    BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
    BETTER_AUTH_URL: "http://localhost:3000",
    DEMO_PASSWORD: random(),
  };
}
const serialize = (values) => Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";

try {
  let existing;
  try { existing = await readFile(target, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing === undefined) {
    const password = random();
    const bootstrap = `postgresql://postgres:${password}@127.0.0.1:5432/wms_lite`;
    const content = serialize({
      POSTGRES_PASSWORD: password,
      POSTGRES_PORT: "5432",
      POSTGRES_TEST_PORT: "5433",
      ...applicationBindings(bootstrap),
      TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:5433/wms_lite_test`,
    });
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
    console.log("Created local development bindings. Secret values withheld.");
  } else if (process.argv.includes("--upgrade")) {
    const old = parseEnv(existing);
    if (old.BOOTSTRAP_DATABASE_URL) {
      console.log("P1 local settings already exist; all bindings preserved.");
    } else {
      const source = new URL(old.MIGRATION_DATABASE_URL);
      if (old.DATABASE_URL !== old.MIGRATION_DATABASE_URL || source.username !== "postgres" ||
          !["localhost", "127.0.0.1"].includes(source.hostname) || source.pathname !== "/wms_lite" ||
          decodeURIComponent(source.password) !== old.POSTGRES_PASSWORD ||
          old.BETTER_AUTH_SECRET || old.BETTER_AUTH_URL || old.DEMO_PASSWORD) {
        throw new Error("Only unchanged P0 local bindings can be upgraded automatically.");
      }
      const additions = applicationBindings(old.MIGRATION_DATABASE_URL);
      let updated = existing;
      for (const key of ["DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
        updated = updated.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${additions[key]}`);
        delete additions[key];
      }
      await writeFile(`${target}.p0-backup`, existing, { flag: "wx", mode: 0o600 });
      await writeFile(target, updated.trimEnd() + "\n" + serialize(additions), { mode: 0o600 });
      console.log("Upgraded recognized P0 local settings; original preserved in ignored .env.local.p0-backup.");
    }
  } else {
    console.log("Existing .env.local preserved. For P0 local settings use env:init -- --upgrade.");
  }
} catch {
  console.error("Environment setup failed. Review existing/custom bindings against .env.example; values withheld.");
  process.exitCode = 1;
}

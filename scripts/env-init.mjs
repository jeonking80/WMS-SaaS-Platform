import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../.env.local", import.meta.url));
const password = randomBytes(24).toString("hex");
const content = [
  `POSTGRES_PASSWORD=${password}`,
  "POSTGRES_PORT=5432",
  "POSTGRES_TEST_PORT=5433",
  `DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:5432/wms_lite`,
  `MIGRATION_DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:5432/wms_lite`,
  `TEST_DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:5433/wms_lite_test`,
  "",
].join("\n");

try {
  await writeFile(target, content, { flag: "wx", mode: 0o600 });
  console.log("Created .env.local with local-only development database settings.");
} catch (error) {
  if (error.code === "EEXIST") {
    console.log("Existing .env.local preserved.");
  } else {
    console.error("Could not create local environment settings.");
    process.exitCode = 1;
  }
}

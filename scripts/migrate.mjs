import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

const url = process.env.TURSO_DATABASE_URL?.trim() || "file:.data/qiuju.db";
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

if (url.startsWith("libsql://") && !authToken) {
  throw new Error("TURSO_AUTH_TOKEN is required for a remote Turso database.");
}

if (url.startsWith("file:")) {
  await mkdir(new URL("../.data/", import.meta.url), { recursive: true });
}

const client = createClient({ url, authToken: authToken || undefined });
const db = drizzle(client);
const migrationsFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));

await migrate(db, { migrationsFolder });
client.close();

console.log(
  `Database migrations applied to ${url.startsWith("file:") ? "local libSQL" : "Turso"}.`,
);

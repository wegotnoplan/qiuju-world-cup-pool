import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

function createDb() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

  if (!url && process.env.VERCEL) {
    throw new Error(
      "Turso is not configured. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to the Vercel project.",
    );
  }

  const resolvedUrl = url || "file:.data/qiuju.db";
  if (resolvedUrl.startsWith("libsql://") && !authToken) {
    throw new Error(
      "TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL uses a remote libSQL database.",
    );
  }

  const client = createClient({
    url: resolvedUrl,
    authToken: authToken || undefined,
  });
  return drizzle(client, { schema });
}

let database: ReturnType<typeof createDb> | null = null;

export function getDb() {
  database ??= createDb();
  return database;
}

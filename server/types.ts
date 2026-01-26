import type { createSqliteDb } from "./db/client";

export type DrizzleDb = ReturnType<typeof createSqliteDb>["db"];

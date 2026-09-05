import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export function createDatabase(databaseUrl: string) {
    const client = postgres(databaseUrl, {
        max: 10,
        connect_timeout: 5,
        idle_timeout: 20,
        connection: {
            application_name: "job-queue-api",
            statement_timeout: 5000,
            lock_timeout: 2000,
            idle_in_transaction_session_timeout: 10000,
            synchronous_commit: "on",
        },
    });
    return { db: drizzle(client), close: () => client.end({ timeout: 5 }) };
}

export type Database = ReturnType<typeof createDatabase>["db"];

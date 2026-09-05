import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { withTimeout } from "../utils/timeout.js";

const HEALTH_CHECK_TIMEOUT_MS = 500;
const STATEMENT_TIMEOUT_MS = 400;
let inFlight: Promise<void> | undefined;

/** Share only an unfinished probe; never cache a previous health result. */
export function checkDatabaseHealth(): Promise<void> {
    if (!inFlight) {
        inFlight = probeDatabase().finally(() => {
            inFlight = undefined;
        });
    }
    return inFlight;
}

async function probeDatabase(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error("DATABASE_URL is not set");
    }

    // This client belongs only to this probe. Ending it cannot affect job queries.
    const client = postgres(databaseUrl, {
        max: 1,
        connect_timeout: HEALTH_CHECK_TIMEOUT_MS / 1000,
        prepare: false,
        fetch_types: false,
        connection: {
            application_name: "job-queue-health",
            statement_timeout: STATEMENT_TIMEOUT_MS,
        },
    });

    try {
        // The deadline includes connecting and waiting for the query response.
        await withTimeout(drizzle(client).execute(sql`SELECT 1`), HEALTH_CHECK_TIMEOUT_MS);
    } finally {
        // A race alone leaves the query running. End this client's pending work
        // without waiting for a stalled query to finish, on every exit path.
        await client.end({ timeout: 0 });
    }
}

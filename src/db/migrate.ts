import "dotenv/config";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const client = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
try {
    // A session lock on a one-connection client serializes concurrent deploys.
    await client`SELECT pg_advisory_lock(74923851)`;
    await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)) });
    console.log("Migrations applied");
} finally {
    // Disconnecting releases the advisory lock even after a failed migration.
    await client.end({ timeout: 5 });
}

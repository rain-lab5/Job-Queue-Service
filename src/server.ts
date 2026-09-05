import "dotenv/config";
import { createApp } from "./app.js";
import { createDatabase } from "./db/index.js";
import { createJobRepository } from "./repositories/jobRepository.js";
import { createJobService } from "./services/jobService.js";
import { startLeaseReaper } from "./services/leaseReaper.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535");
const database = createDatabase(databaseUrl);
const repository = createJobRepository(database.db);
const stopReaper = startLeaseReaper(repository);
const server = createApp(createJobService(repository)).listen(port, () => {
    const address = server.address();
    console.log(`Listening on http://localhost:${typeof address === "object" && address ? address.port : port}`);
});
let stopping = false;
async function shutdown() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    try {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await stopReaper();
        await database.close();
    } finally {
        clearTimeout(deadline);
    }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    shutdown().catch(error => { console.error(error); process.exitCode = 1; });
});

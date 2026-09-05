import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { provisionPostgres, freePort } from "./postgres-fixture.mjs";
import { runLoad } from "./load.mjs";
import { claimJobsQuery, expireLeasesQuery } from "../src/repositories/jobQueries.ts";

execFileSync("npm", ["run", "build"], { stdio: "inherit" });
const fixture = await provisionPostgres();
let client, server;
try {
    execFileSync("npm", ["run", "migrate"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: fixture.url } });
    client = postgres(fixture.url, { max: 1, onnotice: () => {} });
    console.log("Seeding 1,000,000 jobs in a disposable database...");
    const seedStart = performance.now();
    await client`
        INSERT INTO jobs(queue, payload, status, attempts, max_attempts, worker_id, lease_expires_at, idempotency_key, created_at, updated_at)
        SELECT 'seed-' || ((n / 10) % 8), jsonb_build_object('n', n, 'text', repeat('x', 100)),
            CASE n % 10 WHEN 0 THEN 'queued'::job_status WHEN 1 THEN 'processing'::job_status WHEN 2 THEN 'dead'::job_status ELSE 'completed'::job_status END,
            CASE n % 10 WHEN 0 THEN 0 WHEN 2 THEN 3 ELSE 1 END, 3,
            CASE WHEN n % 10 IN (0,2) THEN NULL ELSE 'historical-worker' END,
            CASE WHEN n % 10 = 1 THEN now() + interval '1 day' ELSE NULL END,
            CASE WHEN n % 5 = 0 THEN 'seed-key-' || n ELSE NULL END,
            now() - n * interval '1 second', now() - n * interval '1 second'
        FROM generate_series(1,1000000) AS n
    `;
    await client`ANALYZE jobs`;
    const seedMs = performance.now() - seedStart;
    const distribution = Array.from(await client`SELECT status, count(*)::int AS count FROM jobs GROUP BY status ORDER BY status`);
    const db = drizzle(client);
    const rollback = new Error("rollback explain writes");
    async function explain(query) {
        let plan;
        try {
            await db.transaction(async tx => {
                const rows = await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
                plan = rows[0]["QUERY PLAN"][0];
                throw rollback;
            });
        } catch (error) { if (error !== rollback) throw error; }
        return plan;
    }
    const query = claimJobsQuery({ queue: "seed-0", worker_id: "explain-worker", limit: 10, lease_seconds: 300 });
    const plans = { without_claim_index: [], with_claim_index: [] };
    // Only this freshly-created benchmark database is changed. Never disable the planner.
    await client`DROP INDEX jobs_queued_idx`;
    for (let i = 0; i < 3; i++) plans.without_claim_index.push(await explain(query));
    await client`CREATE INDEX jobs_queued_idx ON jobs(queue, created_at, id) WHERE status = 'queued'`;
    await client`ANALYZE jobs`;
    for (let i = 0; i < 3; i++) plans.with_claim_index.push(await explain(query));
    plans.enqueue = await explain(sql`INSERT INTO jobs(queue, payload, max_attempts) VALUES ('explain', '{}', 3) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`);
    const [processing] = await client`SELECT id FROM jobs WHERE status = 'processing' LIMIT 1`;
    plans.ack_lock = await explain(sql`SELECT * FROM jobs WHERE id = ${processing.id} FOR UPDATE`);
    plans.ack_update = await explain(sql`UPDATE jobs SET status = 'completed', lease_expires_at = NULL, updated_at = clock_timestamp() WHERE id = ${processing.id} AND worker_id = 'historical-worker' AND status = 'processing' AND lease_expires_at > clock_timestamp() RETURNING id`);
    plans.expiry = await explain(expireLeasesQuery());
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["dist/server.js"], { env: { ...process.env, DATABASE_URL: fixture.url, PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Benchmark API failed to start")), 10000);
        server.stdout.on("data", data => { if (data.toString().includes("Listening")) { clearTimeout(timer); resolve(); } });
        server.once("error", error => { clearTimeout(timer); reject(error); });
        server.once("exit", () => { clearTimeout(timer); reject(new Error("Benchmark API exited")); });
    });
    const runs = [];
    for (let repeat = 1; repeat <= 3; repeat++) {
        for (const mode of ["enqueue", "claim", "mixed"]) {
            const queue = mode === "claim" ? `seed-${repeat - 1}` : `bench-${mode}-${repeat}`;
            console.log(`Benchmark ${repeat}/3: ${mode}`);
            const result = await runLoad({ baseUrl, mode, queue });
            assert.equal(result.failed_requests, 0, JSON.stringify(result));
            assert.equal(result.duplicate_claims, 0);
            assert.equal(result.deadline_exceeded, false);
            const rows = Array.from(await client`SELECT status, count(*)::int AS count, min(attempts) AS min_attempts, max(attempts) AS max_attempts FROM jobs WHERE queue = ${queue} GROUP BY status ORDER BY status`);
            if (mode === "mixed") {
                assert.equal(result.completed_jobs, 1000);
                assert.deepEqual(rows, [{ status: "completed", count: 1000, min_attempts: 1, max_attempts: 1 }]);
            } else if (mode === "enqueue") {
                assert.deepEqual(rows, [{ status: "queued", count: 1000, min_attempts: 0, max_attempts: 0 }]);
            } else { assert.equal(result.claimed_jobs, 5000); }
            runs.push({ repeat, ...result, verified_states: rows });
        }
    }
    const [metadata] = await client`SELECT version() AS postgres_version, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit, pg_total_relation_size('jobs')::text AS table_and_index_bytes`;
    const [count] = await client`SELECT count(*)::int AS count FROM jobs`;
    const report = { measured_at: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, memory_bytes: os.totalmem(), ...metadata, row_count: count.count, seed_ms: seedMs, initial_distribution: distribution, plans, runs };
    mkdirSync("benchmarks", { recursive: true });
    writeFileSync("benchmarks/latest.json", JSON.stringify(report, null, 2) + "\n");
    const f = n => n.toFixed(2);
    const rows = runs.map(r => `| ${r.repeat} | ${r.mode} | ${r.requests} | ${f(r.requests_per_second)} | ${f(r.mean_ms)} | ${f(r.p50_ms)} | ${f(r.p95_ms)} | ${f(r.p99_ms)} | ${r.failed_requests} |`).join("\n");
    const indexRows = [0, 1, 2].map(i => `| ${i + 1} | ${f(plans.without_claim_index[i]["Execution Time"])} | ${f(plans.with_claim_index[i]["Execution Time"])} |`).join("\n");
    writeFileSync("BENCHMARKS.md", `# Measured benchmarks\n\nGenerated by \`npm run benchmark\` at ${report.measured_at}. Raw plans, per-operation latency distributions, and correctness checks are in [benchmarks/latest.json](benchmarks/latest.json).\n\n## Environment and method\n\n- ${report.postgres_version}\n- Node ${report.node}; ${report.platform}; ${report.cpu}; ${report.logical_cpus} logical CPUs; ${(report.memory_bytes / 1024 ** 3).toFixed(1)} GiB memory.\n- API, PostgreSQL, and load generator share one machine. One API process, ten application connections, default PostgreSQL settings; fsync=${report.fsync}, synchronous_commit=${report.synchronous_commit}.\n- Seeded 1,000,000 jobs: 100,000 queued, 100,000 processing, 700,000 completed, 100,000 dead across eight queues and varied creation times. Seed and ANALYZE took ${f(seedMs / 1000)} seconds. Final row count: ${count.count}; table and indexes: ${(Number(metadata.table_and_index_bytes) / 1024 ** 2).toFixed(1)} MiB.\n- Three consecutive runs per workload; no best-run selection. Enqueue: 100 clients, 1,000 jobs. Claim: 50 workers, 500 requests claiming 5,000 jobs. Mixed: 100 enqueue clients and 50 claim/ack workers, 1,000 jobs. Lease: 300 seconds.\n- Request latency includes HTTP, JSON parsing, connection-pool waiting, SQL, and commit. RPS counts HTTP requests, including empty claims, not jobs/second. Workloads have fixed counts and are short throughput samples, not sustained saturation or soak tests.\n- Tests assert zero failed requests, no duplicate claims, and all 1,000 mixed jobs completed exactly once with attempts=1. Historical processing leases are set one day ahead so recovery does not change the seed during a run.\n\n## HTTP results\n\n| Run | Workload | Requests/samples | Requests/sec | Mean ms | p50 ms | p95 ms | p99 ms | Failed |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\nAll recorded requests succeeded (error rate 0%). Raw results contain successful/failed counts, minimum/maximum latency, per-operation metrics, and duplicate-claim counts.\n\n## Index comparison\n\nThe exact claim CTE was measured with EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), with its updates rolled back. The benchmark drops only jobs_queued_idx in its own disposable database, runs three samples, recreates it, analyzes the table, and runs three more. Other indexes and planner settings stay unchanged. Cache warming and fixed measurement order limit causal precision; this is an operational comparison, not a controlled cold-cache experiment.\n\n| Sample | Without queued index (ms) | With queued index (ms) |\n|---|---:|---:|\n${indexRows}\n\nEnqueue, acknowledgement locking/update, and expiry queries also have actual EXPLAIN ANALYZE plans in the raw artifact. Index purposes and write costs are documented in [ARCHITECTURE.md](ARCHITECTURE.md).\n\n## Reproduce and limitations\n\nRun \`npm ci && npm run benchmark\`. The script starts a fresh local PostgreSQL cluster (PG_BIN/pg_config), or a disposable Docker container if local binaries are unavailable, and stops it afterward. It never seeds or drops indexes in DATABASE_URL. Results depend on the host, caches, filesystem, and concurrent activity; they are not production capacity guarantees. Docker deployment itself was not exercised for these measurements.\n`);
    console.log("Wrote BENCHMARKS.md and benchmarks/latest.json");
} finally {
    if (server && server.exitCode === null) { server.kill("SIGTERM"); await once(server, "exit"); }
    await client?.end({ timeout: 0 });
    await fixture.stop();
}

import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/db/index.js";
import { createJobRepository } from "../src/repositories/jobRepository.js";
import { createJobService } from "../src/services/jobService.js";
import { startLeaseReaper } from "../src/services/leaseReaper.js";
import { createApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const submission = { queue: "email", payload: { to: "a@example.com", nested: [null, true, { text: " unchanged " }] }, max_attempts: 3 };
const claimBody = (worker_id, limit = 1, queue = "email", lease_seconds = 300) => ({ queue, worker_id, limit, lease_seconds });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!url)("queue API against disposable PostgreSQL", () => {
    let databases, repositories, servers, bases, observer;
    beforeAll(async () => {
        observer = postgres(url, { max: 2, onnotice: () => {} });
        databases = [createDatabase(url), createDatabase(url)];
        repositories = databases.map(database => createJobRepository(database.db));
        servers = repositories.map(repository => createApp(createJobService(repository)).listen(0, "127.0.0.1"));
        await Promise.all(servers.map(server => once(server, "listening")));
        bases = servers.map(server => `http://127.0.0.1:${server.address().port}/api/v1`);
    });
    beforeEach(async () => { await observer`TRUNCATE jobs`; });
    afterAll(async () => {
        await Promise.all((servers ?? []).map(server => new Promise(resolve => server.close(resolve))));
        await Promise.all((databases ?? []).map(database => database.close()));
        await observer?.end({ timeout: 0 });
    });
    async function request(path, body, options = {}) {
        const { instance = 0, ...headers } = options;
        const response = await fetch(`${bases[instance]}${path}`, {
            method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    }
    async function enqueue(body = submission, options) {
        const response = await request("/jobs", body, options);
        expect(response.status).toBe(201);
        return response.body;
    }
    async function claim(worker, limit = 1, queue = "email", lease = 300, instance = 0) {
        const response = await request("/jobs/claim", claimBody(worker, limit, queue, lease), { instance });
        expect(response.status).toBe(200);
        return response.body.jobs;
    }
    async function insertHistorical({ status, attempts, maxAttempts = 3, worker = null, expires = null }) {
        const [job] = await observer`
            INSERT INTO jobs(queue, payload, status, attempts, max_attempts, worker_id, lease_expires_at)
            VALUES ('email', '{}', ${status}, ${attempts}, ${maxAttempts}, ${worker}, ${expires}) RETURNING id
        `;
        return job.id;
    }

    it("enforces the complete enqueue, claim, and ack response shapes", async () => {
        const job = await enqueue();
        expect(job).toEqual({ id: expect.any(String), queue: "email", status: "queued", attempts: 0, max_attempts: 3, created_at: expect.any(String) });
        expect(new Date(job.created_at).toISOString()).toBe(job.created_at);
        const [claimed] = await claim("worker-a");
        expect(claimed).toEqual({ id: job.id, queue: "email", payload: submission.payload, attempts: 1, max_attempts: 3, lease_expires_at: expect.any(String) });
        expect(new Date(claimed.lease_expires_at).getTime()).toBeGreaterThan(Date.now() + 290000);
        expect(await request(`/jobs/${job.id}/ack`, { worker_id: "worker-b" })).toEqual({ status: 409, body: { error: "lease_not_owned" } });
        const [processing] = await observer`SELECT status FROM jobs WHERE id = ${job.id}`;
        expect(processing.status).toBe("processing");
        for (let i = 0; i < 2; i++) expect(await request(`/jobs/${job.id}/ack`, { worker_id: "worker-a" })).toEqual({ status: 200, body: { id: job.id, status: "completed" } });
        expect((await request(`/jobs/${job.id}/ack`, { worker_id: "worker-b" })).status).toBe(409);
        expect(await request("/jobs/claim", claimBody("worker-c"))).toEqual({ status: 200, body: { jobs: [] } });
        expect(await request(`/jobs/${randomUUID()}/ack`, { worker_id: "worker-a" })).toEqual({ status: 404, body: { error: "job_not_found" } });
    });

    it("rejects malformed JSON, unknown fields, invalid IDs, and out-of-range requests", async () => {
        for (const [path, body] of [["/jobs", { ...submission, extra: 1 }], ["/jobs", { ...submission, payload: [] }], ["/jobs/claim", claimBody("worker", 101)], ["/jobs/claim", { ...claimBody("worker"), lease_seconds: 4 }], [`/jobs/${randomUUID()}/ack`, { worker_id: "a", extra: true }], ["/jobs/invalid/ack", { worker_id: "a" }]]) {
            expect(await request(path, body)).toEqual({ status: 400, body: { error: "invalid_request", message: expect.any(String) } });
        }
        for (const body of ['{"queue":', '{"queue":"email","payload":{"n":1e999},"max_attempts":3}', JSON.stringify({ ...submission, payload: { text: "x".repeat(1024 * 1024) } })]) {
            const response = await fetch(`${bases[0]}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
            expect(response.status).toBe(400);
            expect((await response.json()).error).toBe("invalid_request");
        }
        expect((await observer`SELECT count(*)::int AS count FROM jobs`)[0].count).toBe(0);
    });

    it("returns 503 on all job routes when PostgreSQL is unavailable", async () => {
        const unavailableUrl = new URL(url);
        unavailableUrl.port = "1";
        const unavailableDatabase = createDatabase(unavailableUrl.toString());
        const server = createApp(createJobService(createJobRepository(unavailableDatabase.db))).listen(0, "127.0.0.1");
        await once(server, "listening");
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            for (const [path, body] of [["/jobs", submission], ["/jobs/claim", claimBody("a")], [`/jobs/${randomUUID()}/ack`, { worker_id: "a" }]]) {
                const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
                });
                expect(response.status).toBe(503);
                expect(await response.json()).toEqual({ error: "database_unavailable" });
            }
        } finally {
            errors.mockRestore();
            await new Promise(resolve => server.close(resolve));
            await unavailableDatabase.close();
        }
    });

    it("deduplicates 100 simultaneous enqueues across independent API instances", async () => {
        const key = randomUUID();
        const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => enqueue(submission, { "Idempotency-Key": key, instance: i % 2 })));
        expect(new Set(responses.map(job => job.id)).size).toBe(1);
        expect((await observer`SELECT count(*)::int AS count FROM jobs`)[0].count).toBe(1);
        const repeated = await enqueue({ ...submission, payload: { changed: true }, queue: "different" }, { "Idempotency-Key": key });
        expect(repeated.id).toBe(responses[0].id);
        const [job] = await claim("worker");
        expect(job.payload).toEqual(submission.payload);
        const withoutKeys = await Promise.all([enqueue(), enqueue()]);
        expect(withoutKeys[0].id).not.toBe(withoutKeys[1].id);
    });

    it("gives 100 competing workers at most 50 distinct jobs", async () => {
        await observer`INSERT INTO jobs(queue, payload, max_attempts) SELECT 'email', '{}', 3 FROM generate_series(1,50)`;
        const batches = await Promise.all(Array.from({ length: 100 }, (_, i) => claim(`worker-${i}`, 1, "email", 300, i % 2)));
        expect(batches.every(batch => batch.length <= 1)).toBe(true);
        const jobs = batches.flat();
        expect(jobs).toHaveLength(50);
        expect(new Set(jobs.map(job => job.id)).size).toBe(50);
        expect(jobs.every(job => job.attempts === 1)).toBe(true);
    });

    it("preserves all invariants with 50 concurrent workers and 1,200 jobs", async () => {
        await observer`INSERT INTO jobs(queue, payload, max_attempts) SELECT 'email', jsonb_build_object('n', n), 3 FROM generate_series(1,1200) AS n`;
        const seen = new Set();
        await Promise.all(Array.from({ length: 50 }, async (_, index) => {
            const worker = `worker-${index}`;
            while (true) {
                const batch = await claim(worker, 10, "email", 300, index % 2);
                if (!batch.length) break;
                expect(batch.length).toBeLessThanOrEqual(10);
                for (const job of batch) {
                    expect(seen.has(job.id)).toBe(false);
                    seen.add(job.id);
                    expect(job.attempts).toBe(1);
                    expect((await request(`/jobs/${job.id}/ack`, { worker_id: `${worker}-wrong` }, { instance: index % 2 })).status).toBe(409);
                    expect((await request(`/jobs/${job.id}/ack`, { worker_id: worker }, { instance: (index + 1) % 2 })).status).toBe(200);
                }
            }
        }));
        expect(seen.size).toBe(1200);
        const rows = await observer`SELECT status, attempts, count(*)::int AS count FROM jobs GROUP BY status, attempts`;
        expect(Array.from(rows)).toEqual([{ status: "completed", attempts: 1, count: 1200 }]);
        expect(await claim("late-worker", 100)).toEqual([]);
    }, 30000);

    it("recovers after a worker disappears and a real five-second lease expires", async () => {
        const original = await enqueue();
        const [first] = await claim("crashed-worker", 1, "email", 5);
        expect(await claim("early-worker")).toEqual([]);
        await delay(Math.max(0, new Date(first.lease_expires_at).getTime() - Date.now()) + 30);
        expect((await request(`/jobs/${original.id}/ack`, { worker_id: "crashed-worker" })).status).toBe(409);
        const [recovered] = await claim("replacement");
        expect(recovered.id).toBe(original.id);
        expect(recovered.attempts).toBe(2);
        expect((await request(`/jobs/${original.id}/ack`, { worker_id: "crashed-worker" })).status).toBe(409);
        expect((await request(`/jobs/${original.id}/ack`, { worker_id: "replacement" })).status).toBe(200);
    }, 10000);

    it("reaps exhausted attempts to dead in the background without incoming claims", async () => {
        const id = await insertHistorical({ status: "processing", attempts: 3, worker: "gone", expires: new Date(Date.now() - 1000) });
        const stop = startLeaseReaper(repositories[0], 20);
        try {
            await vi.waitFor(async () => expect((await observer`SELECT status FROM jobs WHERE id = ${id}`)[0].status).toBe("dead"));
        } finally { await stop(); }
        expect(await claim("worker")).toEqual([]);
        expect((await request(`/jobs/${id}/ack`, { worker_id: "gone" })).status).toBe(409);
    });

    it("permits successful completion on the final allowed attempt", async () => {
        const job = await enqueue({ ...submission, max_attempts: 1 });
        expect((await claim("worker"))[0].attempts).toBe(1);
        expect((await request(`/jobs/${job.id}/ack`, { worker_id: "worker" })).status).toBe(200);
    });

    it("rechecks lease time after waiting for an acknowledgement lock", async () => {
        const id = await insertHistorical({ status: "processing", attempts: 1, worker: "owner", expires: new Date(Date.now() + 250) });
        let release, locked;
        const ready = new Promise(resolve => { locked = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const transaction = observer.begin(async tx => {
            await tx`SELECT id FROM jobs WHERE id = ${id} FOR UPDATE`;
            locked();
            await gate;
        });
        await ready;
        const acknowledgement = request(`/jobs/${id}/ack`, { worker_id: "owner" });
        try { await delay(350); } finally { release(); }
        await transaction;
        expect(await acknowledgement).toEqual({ status: 409, body: { error: "lease_not_owned" } });
    });

    it("serializes concurrent acknowledgements without changing attempts", async () => {
        const job = await enqueue();
        await claim("owner");
        const results = await Promise.all(Array.from({ length: 20 }, (_, i) => request(`/jobs/${job.id}/ack`, { worker_id: "owner" }, { instance: i % 2 })));
        expect(results.every(result => result.status === 200)).toBe(true);
        expect((await observer`SELECT attempts FROM jobs WHERE id = ${job.id}`)[0].attempts).toBe(1);
    });

    it("enforces legal state transitions and immutable submissions inside PostgreSQL", async () => {
        const job = await enqueue();
        await expect(observer`UPDATE jobs SET status = 'completed', worker_id = 'a', attempts = 1 WHERE id = ${job.id}`).rejects.toMatchObject({ code: "23514" });
        await expect(observer`UPDATE jobs SET payload = '{"changed":true}' WHERE id = ${job.id}`).rejects.toMatchObject({ code: "23514" });
        await claim("owner");
        await expect(observer`UPDATE jobs SET attempts = 0 WHERE id = ${job.id}`).rejects.toMatchObject({ code: "23514" });
        await expect(observer`UPDATE jobs SET worker_id = 'thief' WHERE id = ${job.id}`).rejects.toMatchObject({ code: "23514" });
        await expect(observer`UPDATE jobs SET status = 'queued', worker_id = NULL, lease_expires_at = NULL WHERE id = ${job.id}`).rejects.toMatchObject({ code: "23514" });
        await request(`/jobs/${job.id}/ack`, { worker_id: "owner" });
        await expect(observer`UPDATE jobs SET status = 'processing', attempts = 2, lease_expires_at = now() + interval '30 seconds' WHERE id = ${job.id}`).rejects.toMatchObject({ code: "23514" });
        const dead = await insertHistorical({ status: "dead", attempts: 3 });
        await expect(observer`UPDATE jobs SET status = 'completed', worker_id = 'a' WHERE id = ${dead}`).rejects.toMatchObject({ code: "23514" });
    });

    it("isolates queues and does not wait for a locked candidate", async () => {
        const lockedJob = await enqueue();
        await enqueue({ ...submission, queue: "other" });
        let release, locked;
        const ready = new Promise(resolve => { locked = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const transaction = observer.begin(async tx => {
            await tx`SELECT id FROM jobs WHERE id = ${lockedJob.id} FOR UPDATE`;
            locked(); await gate;
        });
        await ready;
        try { expect(await claim("worker")).toEqual([]); } finally { release(); await transaction; }
        expect((await claim("worker"))[0].id).toBe(lockedJob.id);
        expect(await claim("worker")).toEqual([]);
    });

    it("keeps committed jobs after killing and restarting the API process", async () => {
        async function start() {
            const child = spawn(process.execPath, ["dist/server.js"], { env: { ...process.env, DATABASE_URL: url, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
            let output = "";
            const base = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("API startup timed out")); }, 5000);
                child.stdout.on("data", chunk => {
                    output += chunk;
                    const match = output.match(/http:\/\/localhost:(\d+)/);
                    if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}/api/v1`); }
                });
                child.once("error", error => { clearTimeout(timeout); reject(error); });
                child.once("exit", () => { clearTimeout(timeout); reject(new Error("API exited before startup")); });
            });
            return { child, base };
        }
        let running = await start();
        try {
            const response = await fetch(`${running.base}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission) });
            expect(response.status).toBe(201);
            const job = await response.json();
            running.child.kill("SIGKILL"); await once(running.child, "exit");
            running = await start();
            const claimed = await fetch(`${running.base}/jobs/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(claimBody("after-restart")) });
            expect((await claimed.json()).jobs[0].id).toBe(job.id);
        } finally { running.child.kill("SIGTERM"); await once(running.child, "exit"); }
    }, 15000);

    it.skipIf(!process.env.TEST_PG_DATA && !process.env.TEST_PG_CONTAINER)("keeps committed jobs after a PostgreSQL crash/restart", async () => {
        const job = await enqueue();
        if (process.env.TEST_PG_DATA) {
            execFileSync(join(process.env.TEST_PG_BIN, "pg_ctl"), ["-D", process.env.TEST_PG_DATA, "-l", join(process.env.TEST_PG_DATA, "..", "postgres.log"), "-m", "immediate", "-w", "restart"], { stdio: "pipe" });
        } else {
            execFileSync("docker", ["restart", "--time", "0", process.env.TEST_PG_CONTAINER], { stdio: "pipe" });
        }
        await vi.waitFor(async () => {
            expect((await observer`SELECT id FROM jobs WHERE id = ${job.id}`)[0].id).toBe(job.id);
        }, { timeout: 10000 });
        expect((await claim("after-db-restart"))[0].id).toBe(job.id);
    }, 15000);
});

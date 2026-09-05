import { pathToFileURL } from "node:url";

async function parallel(count, work) {
    await Promise.all(Array.from({ length: count }, (_, index) => work(index)));
}
function summarize(samples, elapsedMs) {
    const latencies = samples.map(sample => sample.ms).sort((a, b) => a - b);
    const percentile = p => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? 0;
    const failed = samples.filter(sample => !sample.ok).length;
    return {
        requests: samples.length, successful_requests: samples.length - failed, failed_requests: failed,
        requests_per_second: samples.length / (elapsedMs / 1000), elapsed_ms: elapsedMs,
        mean_ms: latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1),
        min_ms: latencies[0] ?? 0, max_ms: latencies.at(-1) ?? 0,
        p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99),
        error_rate: samples.length ? failed / samples.length : 0,
    };
}

/** Only sends the public API's three job operations. Use a disposable benchmark server. */
export async function runLoad({ baseUrl, mode, queue, jobs = 1000, clients = 100, workers = 50, claimRequests = 500 }) {
    const samples = [];
    const claimed = new Set();
    let duplicates = 0, completed = 0, producersDone = false, failures = 0;
    const started = performance.now();
    const deadline = started + 120000;
    async function request(operation, path, body, expected) {
        const start = performance.now();
        let ok = false;
        try {
            const response = await fetch(`${baseUrl}/api/v1${path}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
                signal: AbortSignal.timeout(10000),
            });
            const data = await response.json();
            ok = response.status === expected;
            if (!ok) failures++;
            return ok ? data : null;
        } catch { failures++; return null; }
        finally { samples.push({ operation, ms: performance.now() - start, ok }); }
    }
    function observe(batch) {
        for (const job of batch) {
            if (claimed.has(job.id)) duplicates++;
            claimed.add(job.id);
        }
    }
    async function produce() {
        let next = 0;
        await parallel(clients, async () => {
            while (next < jobs && performance.now() < deadline) {
                const n = next++;
                await request("enqueue", "/jobs", { queue, payload: { n, text: "benchmark", nested: [true, null] }, max_attempts: 3 }, 201);
            }
        });
        producersDone = true;
    }
    if (mode === "enqueue") {
        await produce();
    } else if (mode === "claim") {
        let next = 0;
        await parallel(workers, async index => {
            while (next++ < claimRequests && performance.now() < deadline) {
                const data = await request("claim", "/jobs/claim", { queue, worker_id: `${queue}-worker-${index}`, limit: 10, lease_seconds: 300 }, 200);
                observe(data?.jobs ?? []);
            }
        });
    } else if (mode === "mixed") {
        await Promise.all([produce(), parallel(workers, async index => {
            const worker = `${queue}-worker-${index}`;
            while (performance.now() < deadline) {
                const data = await request("claim", "/jobs/claim", { queue, worker_id: worker, limit: 10, lease_seconds: 300 }, 200);
                if (!data) break;
                observe(data.jobs);
                await Promise.all(data.jobs.map(async job => {
                    if (await request("ack", `/jobs/${job.id}/ack`, { worker_id: worker }, 200)) completed++;
                }));
                if (!data.jobs.length) {
                    if (producersDone) break;
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
        })]);
    } else throw new Error("mode must be enqueue, claim, or mixed");
    const elapsed = performance.now() - started;
    return {
        mode, queue, clients, workers, ...summarize(samples, elapsed),
        claimed_jobs: claimed.size, completed_jobs: completed, duplicate_claims: duplicates,
        deadline_exceeded: performance.now() >= deadline,
        operations: Object.fromEntries(["enqueue", "claim", "ack"].map(operation => [operation, summarize(samples.filter(sample => sample.operation === operation), elapsed)])),
    };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [baseUrl = "http://127.0.0.1:8080", mode = "mixed", queue = `load-${Date.now()}`] = process.argv.slice(2);
    const result = await runLoad({ baseUrl, mode, queue });
    console.log(JSON.stringify(result, null, 2));
    if (result.failed_requests || result.duplicate_claims || result.deadline_exceeded) process.exitCode = 1;
}

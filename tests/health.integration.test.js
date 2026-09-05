import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import express from "express";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleHealth } from "../src/handlers/handleHealth.js";

let server;
let baseUrl;

beforeAll(async () => {
    const app = express();
    app.get("/api/v1/health", handleHealth);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});
afterAll(async () => {
    if (server?.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

async function expectHealth(status, body) {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(body);
}
const degraded = { status: "degraded", database: "unavailable" };
const healthy = { status: "ok", database: "ok" };

it("returns the contract's 503 response when database configuration is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("DATABASE_URL", "");
    await expectHealth(503, degraded);
});

it.each(["handshake", "query"])("bounds concurrent requests stalled during %s and closes probe sockets", async (stage) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sockets = new Set();
    let connectionCount = 0;
    let queryCount = 0;
    const silentDatabase = net.createServer(socket => {
        connectionCount++;
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));
        let startup = true;
        socket.on("data", data => {
            if (startup) {
                startup = false;
                if (stage === "query") {
                    // Minimal PostgreSQL AuthenticationOk + ReadyForQuery messages.
                    // Accept the handshake, then leave SELECT 1 unanswered.
                    socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]));
                }
            } else if (data.includes(Buffer.from("SELECT 1"))) {
                queryCount++;
            }
        });
    });
    silentDatabase.listen(0, "127.0.0.1");
    await once(silentDatabase, "listening");
    vi.stubEnv("DATABASE_URL", `postgres://test:test@127.0.0.1:${silentDatabase.address().port}/test`);
    try {
        for (let round = 0; round < 2; round++) {
            const start = performance.now();
            await Promise.all(Array.from({ length: 10 }, () => expectHealth(503, degraded)));
            // Allow scheduling overhead; a multi-second connect timeout must not win.
            expect(performance.now() - start).toBeLessThan(1500);
            await vi.waitFor(() => expect(sockets.size).toBe(0));
        }
        expect(connectionCount).toBe(2);
        expect(queryCount).toBe(stage === "query" ? 2 : 0);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => silentDatabase.close(resolve));
    }
});

// Point this only at a disposable PostgreSQL instance; no tables are created.
describe.skipIf(!process.env.HEALTH_TEST_DATABASE_URL)("real PostgreSQL", () => {
    it("returns 200, reports a real authentication failure, and recovers", async () => {
        const databaseUrl = process.env.HEALTH_TEST_DATABASE_URL;
        assert.ok(databaseUrl);
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.stubEnv("DATABASE_URL", databaseUrl);
        await expectHealth(200, healthy);

        // A missing role is rejected even by a test cluster configured with trust auth.
        const invalidUrl = new URL(databaseUrl);
        invalidUrl.username = "health_test_nonexistent_role";
        vi.stubEnv("DATABASE_URL", invalidUrl.toString());
        await expectHealth(503, degraded);

        vi.stubEnv("DATABASE_URL", databaseUrl);
        await expectHealth(200, healthy);
        const observer = postgres(databaseUrl, { max: 1 });
        try {
            await vi.waitFor(async () => {
                const rows = await observer`
                    SELECT count(*)::int AS count FROM pg_stat_activity
                    WHERE application_name = 'job-queue-health'
                `;
                expect(rows[0].count).toBe(0);
            });
        } finally {
            await observer.end({ timeout: 0 });
        }
    });
});

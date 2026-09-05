import express, { type ErrorRequestHandler } from "express";
import { JobNotFoundError, LeaseNotOwnedError, ValidationError } from "./domain/jobs.js";
import { handleHealth } from "./handlers/handleHealth.js";
import { createJobHandlers } from "./handlers/jobs.js";
import type { JobService } from "./services/jobService.js";

function databaseUnavailable(error: unknown): boolean {
    for (let depth = 0; depth < 5 && error && typeof error === "object"; depth++) {
        const value = error as { code?: string; cause?: unknown };
        if (value.code && (/^(08|53|57|40)/.test(value.code) || ["55P03", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"].includes(value.code))) return true;
        error = value.cause;
    }
    return false;
}
export function createApp(service: JobService) {
    const app = express();
    app.disable("x-powered-by");
    app.get("/api/v1/health", handleHealth);
    app.use(express.json({ limit: "1mb" }));
    const handlers = createJobHandlers(service);
    app.post("/api/v1/jobs", handlers.enqueue);
    app.post("/api/v1/jobs/claim", handlers.claim);
    app.post("/api/v1/jobs/:id/ack", handlers.acknowledge);
    app.use((_req, res) => res.status(404).json({ error: "not_found" }));
    const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
        const parserError = error as { type?: string } | null;
        if (error instanceof ValidationError || parserError?.type === "entity.parse.failed" || parserError?.type === "entity.too.large" || parserError?.type === "charset.unsupported" || parserError?.type === "encoding.unsupported") {
            res.status(400).json({ error: "invalid_request", message: error instanceof ValidationError ? error.message : "Body must be valid JSON no larger than 1 MiB" });
        } else if (error instanceof JobNotFoundError) {
            res.status(404).json({ error: "job_not_found" });
        } else if (error instanceof LeaseNotOwnedError) {
            res.status(409).json({ error: "lease_not_owned" });
        } else {
            console.error(error);
            res.status(databaseUnavailable(error) ? 503 : 500).json({ error: databaseUnavailable(error) ? "database_unavailable" : "internal_error" });
        }
    };
    app.use(errors);
    return app;
}

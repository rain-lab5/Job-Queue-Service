import { sql } from "drizzle-orm";
import type { ClaimInput } from "../domain/jobs.js";

// Bounded batches keep recovery transactions short, even after a long outage.
export function expireLeasesQuery(batchSize = 1000) {
    return sql`
        WITH expired AS (
            SELECT id FROM jobs
            WHERE status = 'processing' AND lease_expires_at <= statement_timestamp()
            ORDER BY lease_expires_at, id
            LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
        )
        UPDATE jobs AS j SET
            status = CASE WHEN j.attempts >= j.max_attempts THEN 'dead'::job_status ELSE 'queued'::job_status END,
            worker_id = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
        FROM expired WHERE j.id = expired.id
        RETURNING j.id
    `;
}
export function claimJobsQuery(input: ClaimInput) {
    return sql`
        WITH candidates AS (
            SELECT id FROM jobs WHERE queue = ${input.queue} AND status = 'queued'
            ORDER BY created_at, id
            LIMIT ${input.limit} FOR UPDATE SKIP LOCKED
        )
        UPDATE jobs AS j SET
            status = 'processing', worker_id = ${input.worker_id}, attempts = j.attempts + 1,
            lease_expires_at = clock_timestamp() + ${input.lease_seconds} * interval '1 second',
            updated_at = clock_timestamp()
        FROM candidates WHERE j.id = candidates.id
        RETURNING j.id, j.queue, j.payload, j.attempts, j.max_attempts, j.lease_expires_at
    `;
}

import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { jobs } from "../db/schema/jobs.js";
import { JobNotFoundError, LeaseNotOwnedError, type ClaimInput, type EnqueueInput } from "../domain/jobs.js";
import { claimJobsQuery, expireLeasesQuery } from "./jobQueries.js";

const submissionFields = {
    id: jobs.id, queue: jobs.queue, status: jobs.status, attempts: jobs.attempts,
    maxAttempts: jobs.maxAttempts, createdAt: jobs.createdAt,
};

export function createJobRepository(db: Database) {
    return {
        async enqueue(input: EnqueueInput, idempotencyKey?: string) {
            // DO NOTHING waits for a competing insert to commit. The subsequent
            // SELECT gets a fresh READ COMMITTED snapshot, unlike a single CTE.
            const inserted = await db.insert(jobs).values({
                queue: input.queue, payload: input.payload, maxAttempts: input.max_attempts,
                idempotencyKey: idempotencyKey ?? null,
            }).onConflictDoNothing({ target: jobs.idempotencyKey }).returning(submissionFields);
            if (inserted[0]) return inserted[0];
            if (idempotencyKey === undefined) throw new Error("Enqueue returned no job");
            const [existing] = await db.select(submissionFields).from(jobs).where(eq(jobs.idempotencyKey, idempotencyKey));
            if (!existing) throw new Error("Idempotent job disappeared");
            return existing;
        },
        async claim(input: ClaimInput) {
            return db.transaction(async tx => {
                // Separate statements are intentional: the claim must see recovery's writes.
                await tx.execute(expireLeasesQuery());
                const rows = await tx.execute<{
                    id: string; queue: string; payload: Record<string, unknown>;
                    attempts: number; max_attempts: number; lease_expires_at: string;
                }>(claimJobsQuery(input));
                return Array.from(rows, row => ({
                    ...row, lease_expires_at: new Date(row.lease_expires_at).toISOString(),
                }));
            });
        },
        async acknowledge(id: string, workerId: string) {
            return db.transaction(async tx => {
                const [job] = await tx.select({ status: jobs.status, workerId: jobs.workerId }).from(jobs).where(eq(jobs.id, id)).for("update");
                if (!job) throw new JobNotFoundError();
                if (job.status === "completed" && job.workerId === workerId) return;
                if (job.status !== "processing" || job.workerId !== workerId) throw new LeaseNotOwnedError();
                // Evaluate time AFTER acquiring the row lock. A request can wait
                // for a lock long enough that its originally valid lease expires.
                const updated = await tx.update(jobs).set({
                    status: "completed", leaseExpiresAt: null, updatedAt: sql`clock_timestamp()`,
                }).where(sql`${jobs.id} = ${id} AND ${jobs.leaseExpiresAt} > clock_timestamp()`).returning({ id: jobs.id });
                if (!updated.length) throw new LeaseNotOwnedError();
            }).catch((error: unknown) => {
                // The lease can cross its deadline between the UPDATE predicate
                // and the database trigger; that still means an ownership conflict.
                const cause = error instanceof Error ? error.cause : undefined;
                if (cause && typeof cause === "object" && "code" in cause && cause.code === "JQ001") {
                    throw new LeaseNotOwnedError();
                }
                throw error;
            });
        },
        async expireLeases() {
            const rows = await db.execute(expireLeasesQuery());
            return rows.length;
        },
    };
}
export type JobRepository = ReturnType<typeof createJobRepository>;

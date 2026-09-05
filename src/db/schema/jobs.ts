import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const jobStatusEnum = pgEnum("job_status", ["queued", "processing", "completed", "dead"]);

export const jobs = pgTable("jobs", {
    id: uuid("id").primaryKey().defaultRandom(),
    queue: text("queue").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    workerId: text("worker_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
    uniqueIndex("jobs_idempotency_key_idx").on(table.idempotencyKey),
    index("jobs_queued_idx").on(table.queue, table.createdAt, table.id)
        .where(sql`${table.status} = 'queued'`),
    index("jobs_expired_idx").on(table.leaseExpiresAt, table.id)
        .where(sql`${table.status} = 'processing'`),
    check("jobs_queue_length", sql`char_length(${table.queue}) BETWEEN 1 AND 100`),
    check("jobs_payload_object", sql`jsonb_typeof(${table.payload}) = 'object'`),
    check("jobs_attempts_valid", sql`${table.maxAttempts} BETWEEN 1 AND 20 AND ${table.attempts} BETWEEN 0 AND ${table.maxAttempts}`),
    check("jobs_worker_length", sql`${table.workerId} IS NULL OR char_length(${table.workerId}) BETWEEN 1 AND 100`),
    check("jobs_key_length", sql`${table.idempotencyKey} IS NULL OR char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`),
    check("jobs_state_valid", sql`
        (${table.status} = 'queued' AND ${table.workerId} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.attempts} < ${table.maxAttempts}) OR
        (${table.status} = 'processing' AND ${table.workerId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.attempts} > 0) OR
        (${table.status} = 'completed' AND ${table.workerId} IS NOT NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.attempts} > 0) OR
        (${table.status} = 'dead' AND ${table.workerId} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.attempts} = ${table.maxAttempts})
    `),
]);

import { ValidationError, type ClaimInput, type EnqueueInput } from "../domain/jobs.js";

function invalid(message: string): never {
    throw new ValidationError(message);
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Body must be a JSON object");
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => !fields.includes(key))) invalid("Unexpected request field");
    if (fields.some(key => !Object.hasOwn(body, key))) invalid(`Required fields: ${fields.join(", ")}`);
    return body;
}
function validText(value: string): boolean {
    return !value.includes("\0") && value.isWellFormed();
}
function text(value: unknown, name: string, max = 100): string {
    if (typeof value !== "string" || !validText(value) || [...value].length < 1 || [...value].length > max) {
        invalid(`${name} must be a valid string of 1–${max} characters`);
    }
    return value;
}
function integer(value: unknown, name: string, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        invalid(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
}
function validateJson(value: unknown, depth = 0): void {
    if (depth > 64) invalid("Payload nesting cannot exceed 64 levels");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
        if (!validText(value)) invalid("Payload strings must contain valid Unicode without NUL");
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
            invalid("Payload numbers must be finite; integers must be safely representable in JavaScript");
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) validateJson(item, depth + 1);
        return;
    }
    if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            if (!validText(key)) invalid("Payload keys must contain valid Unicode without NUL");
            validateJson(item, depth + 1);
        }
        return;
    }
    invalid("Payload must contain only JSON values");
}
export function validateEnqueue(value: unknown): EnqueueInput {
    const body = object(value, ["queue", "payload", "max_attempts"]);
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) invalid("payload must be a JSON object");
    validateJson(body.payload);
    return {
        queue: text(body.queue, "queue"),
        payload: body.payload as Record<string, unknown>,
        max_attempts: integer(body.max_attempts, "max_attempts", 1, 20),
    };
}
export function validateClaim(value: unknown): ClaimInput {
    const body = object(value, ["queue", "worker_id", "limit", "lease_seconds"]);
    return {
        queue: text(body.queue, "queue"),
        worker_id: text(body.worker_id, "worker_id"),
        limit: integer(body.limit, "limit", 1, 100),
        lease_seconds: integer(body.lease_seconds, "lease_seconds", 5, 300),
    };
}
export function validateAck(value: unknown): string {
    return text(object(value, ["worker_id"]).worker_id, "worker_id");
}
export function validateId(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid("id must be a UUID");
    return value;
}
export function validateIdempotencyKey(value: string | undefined): string | undefined {
    return value === undefined ? undefined : text(value, "Idempotency-Key", 200);
}

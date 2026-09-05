import { describe, expect, it } from "vitest";
import { validateAck, validateClaim, validateEnqueue, validateId, validateIdempotencyKey } from "../src/validation/jobs.js";
const enqueue = { queue: "email", payload: { nested: [null, true, " unchanged ", { n: 1.5 }] }, max_attempts: 5 };
const claim = { queue: "email", worker_id: "worker", limit: 10, lease_seconds: 30 };

describe("enqueue validation", () => {
    it("preserves valid nested payloads and counts Unicode code points", () => {
        const input = { ...enqueue, queue: "📫".repeat(100) };
        expect(validateEnqueue(input)).toEqual(input);
        expect(validateEnqueue({ ...enqueue, max_attempts: 1 })).toBeTruthy();
        expect(validateEnqueue({ ...enqueue, max_attempts: 20 })).toBeTruthy();
    });
    it.each([null, [], {}, { ...enqueue, extra: 1 }, { ...enqueue, queue: "" }, { ...enqueue, queue: "x".repeat(101) }, { ...enqueue, payload: [] }, { ...enqueue, payload: null }, { ...enqueue, max_attempts: "5" }, { ...enqueue, max_attempts: 0 }, { ...enqueue, max_attempts: 21 }, { ...enqueue, max_attempts: 1.5 }, { ...enqueue, payload: { n: Infinity } }, { ...enqueue, payload: { n: 2 ** 53 } }, { ...enqueue, payload: { text: "\0" } }, { ...enqueue, payload: { text: "\ud800" } }])("rejects invalid input %#", input => {
        expect(() => validateEnqueue(input)).toThrow();
    });
    it("rejects excessive nesting", () => {
        let payload = {};
        for (let i = 0; i < 66; i++) payload = { payload };
        expect(() => validateEnqueue({ ...enqueue, payload })).toThrow(/nesting/);
    });
});
describe("claim validation", () => {
    it.each([{ limit: 1, lease_seconds: 5 }, { limit: 100, lease_seconds: 300 }])("accepts bounds %j", bounds => {
        expect(validateClaim({ ...claim, ...bounds })).toEqual({ ...claim, ...bounds });
    });
    it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.1 }, { limit: "10" }, { lease_seconds: 4 }, { lease_seconds: 301 }, { worker_id: "" }, { queue: "" }, { extra: true }])("rejects %j", invalid => {
        expect(() => validateClaim({ ...claim, ...invalid })).toThrow();
    });
});
it("validates acknowledgements and idempotency keys strictly", () => {
    expect(validateAck({ worker_id: "a" })).toBe("a");
    expect(() => validateAck({ worker_id: "a", extra: true })).toThrow();
    expect(() => validateAck({})).toThrow();
    expect(() => validateId("not-a-uuid")).toThrow();
    expect(validateIdempotencyKey(undefined)).toBeUndefined();
    expect(validateIdempotencyKey("x".repeat(200))).toHaveLength(200);
    expect(() => validateIdempotencyKey("")).toThrow();
    expect(() => validateIdempotencyKey("x".repeat(201))).toThrow();
});

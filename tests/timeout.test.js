import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "../src/utils/timeout.js";

afterEach(() => vi.useRealTimers());

describe("withTimeout", () => {
    it("clears the timer after success", async () => {
        vi.useFakeTimers();
        await expect(withTimeout(Promise.resolve(42), 500)).resolves.toBe(42);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the timer and preserves a database error", async () => {
        vi.useFakeTimers();
        const error = new Error("connection refused");
        await expect(withTimeout(Promise.reject(error), 500)).rejects.toBe(error);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects a stalled operation at the deadline and observes its late failure", async () => {
        vi.useFakeTimers();
        let rejectOperation;
        const operation = new Promise((_, reject) => { rejectOperation = reject; });
        const assertion = expect(withTimeout(operation, 500)).rejects.toThrow("timed out after 500ms");
        await vi.advanceTimersByTimeAsync(500);
        await assertion;
        rejectOperation(new Error("late database failure"));
        await Promise.resolve();
        expect(vi.getTimerCount()).toBe(0);
    });
});

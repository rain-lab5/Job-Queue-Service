import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), end: vi.fn(), postgres: vi.fn() }));
vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: () => ({ execute: mocks.execute }) }));
import { checkDatabaseHealth } from "../src/repositories/healthRepository.js";

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/test");
    mocks.postgres.mockReturnValue({ end: mocks.end });
    mocks.end.mockResolvedValue();
});
afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe("database health probe lifecycle", () => {
    it("closes successful probes and checks again on the next request", async () => {
        mocks.execute.mockResolvedValue([]);
        await checkDatabaseHealth();
        await checkDatabaseHealth();
        expect(mocks.execute).toHaveBeenCalledTimes(2);
        expect(mocks.end).toHaveBeenCalledTimes(2);
        expect(mocks.end).toHaveBeenCalledWith({ timeout: 0 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cleans up a rejected probe and allows recovery", async () => {
        mocks.execute.mockRejectedValueOnce(new Error("database offline"));
        await expect(checkDatabaseHealth()).rejects.toThrow("database offline");
        expect(mocks.end).toHaveBeenCalledWith({ timeout: 0 });
        mocks.execute.mockResolvedValueOnce([]);
        await expect(checkDatabaseHealth()).resolves.toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("shares concurrent checks, stops timed-out work, and allows another probe", async () => {
        mocks.execute.mockReturnValueOnce(new Promise(() => {}));
        const first = checkDatabaseHealth();
        const second = checkDatabaseHealth();
        expect(second).toBe(first);
        const assertion = expect(first).rejects.toThrow("timed out after 500ms");
        await vi.advanceTimersByTimeAsync(500);
        await assertion;
        expect(mocks.postgres).toHaveBeenCalledTimes(1);
        expect(mocks.end).toHaveBeenCalledWith({ timeout: 0 });
        mocks.execute.mockResolvedValueOnce([]);
        await expect(checkDatabaseHealth()).resolves.toBeUndefined();
        expect(mocks.postgres).toHaveBeenCalledTimes(2);
    });

    it("rejects missing configuration without creating a client", async () => {
        vi.stubEnv("DATABASE_URL", "");
        await expect(checkDatabaseHealth()).rejects.toThrow("DATABASE_URL is not set");
        expect(mocks.postgres).not.toHaveBeenCalled();
    });
});

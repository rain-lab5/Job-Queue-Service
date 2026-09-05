export interface EnqueueInput {
    queue: string;
    payload: Record<string, unknown>;
    max_attempts: number;
}
export interface ClaimInput {
    queue: string;
    worker_id: string;
    limit: number;
    lease_seconds: number;
}
export class ValidationError extends Error {}
export class JobNotFoundError extends Error {}
export class LeaseNotOwnedError extends Error {}

import type { ClaimInput, EnqueueInput } from "../domain/jobs.js";
import type { JobRepository } from "../repositories/jobRepository.js";

export function createJobService(repository: JobRepository) {
    return {
        async enqueue(input: EnqueueInput, idempotencyKey?: string) {
            const job = await repository.enqueue(input, idempotencyKey);
            return {
                id: job.id, queue: job.queue, status: job.status, attempts: job.attempts,
                max_attempts: job.maxAttempts, created_at: job.createdAt.toISOString(),
            };
        },
        async claim(input: ClaimInput) {
            return { jobs: await repository.claim(input) };
        },
        async acknowledge(id: string, workerId: string) {
            await repository.acknowledge(id, workerId);
            return { id, status: "completed" as const };
        },
    };
}
export type JobService = ReturnType<typeof createJobService>;

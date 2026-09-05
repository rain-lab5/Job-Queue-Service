import type { JobRepository } from "../repositories/jobRepository.js";

/** No overlapping sweeps in one process; SKIP LOCKED also permits many API replicas. */
export function startLeaseReaper(repository: JobRepository, intervalMs = 1000) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void> = Promise.resolve();
    function run() {
        active = repository.expireLeases().then(() => {}, error => console.error("Lease recovery failed", error)).finally(() => {
            if (!stopped) {
                timer = setTimeout(run, intervalMs);
                timer.unref();
            }
        });
    }
    run();
    return async () => {
        stopped = true;
        clearTimeout(timer);
        await active;
    };
}

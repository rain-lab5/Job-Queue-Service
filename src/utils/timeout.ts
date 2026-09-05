/** Bounds the wait; the caller remains responsible for stopping the operation. */
export async function withTimeout<T>(
    operation: PromiseLike<T>,
    ms: number,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`Operation timed out after ${ms}ms`));
                }, ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

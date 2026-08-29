import { rejects } from "node:assert";

export function timeout(ms : number) : Promise<never>
{
    return new Promise((_resolve,reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Operation timed out after ${ms}ms`));
        },ms)
        timer.unref?.();
    })
}
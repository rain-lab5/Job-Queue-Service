import { spawn } from "node:child_process";
import { provisionPostgres } from "./postgres-fixture.mjs";

async function run(command, args, env = process.env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: "inherit", env });
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    });
}
await run("npm", ["run", "build"]);
const postgres = await provisionPostgres();
try {
    const env = { ...process.env, ...postgres.restartEnv, DATABASE_URL: postgres.url, TEST_DATABASE_URL: postgres.url, HEALTH_TEST_DATABASE_URL: postgres.url };
    await run("npm", ["run", "migrate"], env);
    // Running twice checks migration bookkeeping as well as an empty-schema install.
    await run("npm", ["run", "migrate"], env);
    await run("npm", ["test"], env);
} finally {
    await postgres.stop();
}

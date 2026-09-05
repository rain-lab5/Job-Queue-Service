import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { once } from "node:events";

export async function freePort() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

/** Creates its own cluster/container. Never resets the developer's DATABASE_URL. */
export async function provisionPostgres() {
    let bin = process.env.PG_BIN;
    if (!bin) {
        try { bin = execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim(); } catch {}
    }
    if (bin && existsSync(join(bin, "initdb")) && process.getuid?.() !== 0) {
        const directory = mkdtempSync(join(tmpdir(), "job-queue-test-"));
        const data = join(directory, "data");
        const port = await freePort();
        execFileSync(join(bin, "initdb"), ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"], { stdio: "pipe" });
        try {
            execFileSync(join(bin, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"], { stdio: "pipe" });
        } catch (error) {
            console.error(readFileSync(join(directory, "postgres.log"), "utf8"));
            throw error;
        }
        return {
            url: `postgres://${encodeURIComponent(userInfo().username)}@127.0.0.1:${port}/postgres`,
            restartEnv: { TEST_PG_BIN: bin, TEST_PG_DATA: data },
            async stop() {
                if (existsSync(join(data, "postmaster.pid"))) execFileSync(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "pipe" });
            },
        };
    }
    const name = `job-queue-test-${process.pid}-${Date.now()}`;
    execFileSync("docker", ["run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", "postgres:18"], { stdio: "pipe" });
    const stop = async () => { execFileSync("docker", ["stop", name], { stdio: "pipe" }); };
    try {
        const port = execFileSync("docker", ["port", name, "5432"], { encoding: "utf8" }).trim().split(":").at(-1);
        for (let i = 0; i < 60; i++) {
            try {
                execFileSync("docker", ["exec", name, "pg_isready", "-U", "postgres"], { stdio: "pipe" });
                return { url: `postgres://postgres:test@127.0.0.1:${port}/postgres`, restartEnv: { TEST_PG_CONTAINER: name }, stop };
            } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
        }
        throw new Error("Disposable PostgreSQL did not start");
    } catch (error) { await stop(); throw error; }
}

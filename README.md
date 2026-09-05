# Durable Job Queue Service

A TypeScript/Express API backed by PostgreSQL and Drizzle. Clients submit durable jobs; external workers claim leases, perform the work, and acknowledge completion. The service does not execute job payloads.

## Run with Docker Compose

```sh
cp .env.example .env
docker compose up --build
```

The API listens on `http://localhost:8080/api/v1`. Compose starts PostgreSQL, waits for it to accept connections, applies migrations in a one-shot container, then starts the API. PostgreSQL data lives in the `postgres_data` volume and survives container restarts. `docker compose down` retains that volume; adding `-v` deletes it.

The example credentials are local development defaults. Compose uses `DB_USER`, `DB_PASS`, and `DB_NAME`; the composed connection URL requires URL-safe credential values. Local Node commands use `DATABASE_URL` instead.

## Run Node locally

Requires Node.js 24+, npm, and PostgreSQL 18. Install dependencies and build before using the compiled migration/start commands:

```sh
npm ci
cp .env.example .env
docker compose up -d postgres
npm run build
npm run migrate
npm start
# Alternatively, after migrating:
npm run dev
```

If PostgreSQL is already running elsewhere, set `DATABASE_URL` and omit the Compose command. `PORT` defaults to 8080. `npm run generate` generates Drizzle migrations after schema changes; review and commit generated SQL and metadata. The custom migration also installs a state-transition trigger. Schema generation alone does not replace it.

## API

Exactly four application endpoints are provided:

| Method | Path | Success |
|---|---|---|
| GET | `/api/v1/health` | `200 {"status":"ok","database":"ok"}` |
| POST | `/api/v1/jobs` | `201` with job metadata |
| POST | `/api/v1/jobs/claim` | `200 {"jobs":[...]}` |
| POST | `/api/v1/jobs/:id/ack` | `200 {"id":"...","status":"completed"}` |

Enqueue:

```sh
curl -i http://localhost:8080/api/v1/jobs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: welcome-email-123' \
  -d '{"queue":"email","payload":{"recipient":"a@example.com"},"max_attempts":3}'
```

Claim:

```sh
curl -s http://localhost:8080/api/v1/jobs/claim \
  -H 'Content-Type: application/json' \
  -d '{"queue":"email","worker_id":"worker-session-1","limit":10,"lease_seconds":30}'
```

Acknowledge a returned job ID after work succeeds:

```sh
curl -i http://localhost:8080/api/v1/jobs/JOB_UUID/ack \
  -H 'Content-Type: application/json' \
  -d '{"worker_id":"worker-session-1"}'
```

The field names, ranges, and response shapes follow [Contract.md](Contract.md). The choices left open by the contract are defined here:

- IDs are PostgreSQL-generated UUIDs. A malformed UUID is `400 invalid_request`; a valid but missing UUID is `404 job_not_found`.
- All request fields are required; unknown fields are rejected. Numbers are not coerced from strings. Queue and worker IDs are 1–100 Unicode code points; strings are never trimmed.
- Payloads must be JSON objects. Nested JSON arrays/objects are preserved as values; JSONB does not preserve whitespace, key ordering, or duplicate object keys. Requests are limited to 1 MiB; payload nesting to 64 levels. NUL and malformed Unicode are rejected because PostgreSQL cannot store them as JSONB strings. Numbers follow JavaScript JSON semantics; non-finite numbers and integers outside JavaScript's safe range are rejected. Use strings for identifiers or decimal values requiring arbitrary precision.
- An optional `Idempotency-Key` is 1–200 characters and is global across queues. Duplicate header fields are rejected. The first committed submission wins: reusing a key with different valid input returns the original job without changing its payload or queue. Replays return `201` and current job metadata, so status/attempts may have advanced. Keys persist with their jobs; no expiry or deletion API exists.
- `attempts` starts at zero and increases once per successful claim. The final allowed attempt may complete successfully. If its lease expires, the job becomes `dead`.
- Leases use PostgreSQL's clock. They are active only while `lease_expires_at > current database time`. Expired acknowledgements return `409 lease_not_owned`, even before recovery has run.
- Every claim recovers up to 1,000 expired jobs globally before selecting its queue. Each API process also runs a non-overlapping recovery sweep every second after its previous sweep finishes. Large expiry backlogs drain over multiple sweeps. This is eventual recovery, not an exact one-second SLA.
- Repeated acknowledgement by the completing worker returns `200`. Another worker, a queued/dead job, or an expired lease returns `409`. Completion never changes attempts or returns a job to the queue.
- Worker IDs are ownership labels, not authentication credentials. Choose a fresh worker/session identity when replacing a worker. With only `worker_id` in the contract, an old acknowledgement from the same reused identity cannot be distinguished from its newer lease. External work must tolerate at-least-once delivery; the API cannot guarantee exactly-once side effects.
- Invalid JSON/validation returns `400 {"error":"invalid_request","message":"..."}`. Database connection/unavailability or database timeout errors return `503 {"error":"database_unavailable"}` on job routes. Unexpected errors return `500 {"error":"internal_error"}`. Health retains its separate degraded response from the contract.

## Architecture and learning guide

HTTP handlers validate input and call a service. Services define response projections and call repositories. Repositories own SQL and transaction boundaries. PostgreSQL constraints and the transition trigger guard stored invariants. The health repository owns its own bounded probe connection; job requests share a pool.

Start with [ARCHITECTURE.md](ARCHITECTURE.md), then trace `src/handlers/jobs.ts` → `src/services/jobService.ts` → `src/repositories/jobRepository.ts`. The claim/recovery SQL lives in `src/repositories/jobQueries.ts`. The SQL comments explain why recovery and claiming use separate statements in one transaction.

## Tests

```sh
npm test
npm run test:integration
```

`npm test` runs unit validation, timer, health lifecycle, and HTTP stall tests. PostgreSQL-dependent tests explicitly skip unless their test URLs are supplied. `npm run test:integration` is the acceptance command: it builds the app, creates a disposable PostgreSQL cluster/container, applies migrations twice, and runs every test, including actual database and API restarts. It never resets the database in your `.env`.

The integration runner uses `pg_config --bindir` (or `PG_BIN`) to find local PostgreSQL tools. If unavailable, it starts `postgres:18` using Docker. Local `initdb` must run as a non-root user. PostgreSQL 18 is the tested version.

Coverage includes strict contract responses, 100 concurrent submissions sharing one idempotency key, 100 workers competing for 50 jobs, 50 workers processing 1,200 jobs through two independent API instances, wrong-owner acknowledgements, repeated acknowledgements, lock waits crossing lease deadlines, actual five-second lease expiry, retry exhaustion, terminal state protection, and committed data surviving API and PostgreSQL crash/restarts.

## Benchmarks

```sh
npm run benchmark
# Against an already-running disposable service:
node scripts/load.mjs http://localhost:8080 mixed my-load-queue
```

The benchmark command provisions its own PostgreSQL database, seeds one million mixed-state jobs, measures important queries with `EXPLAIN ANALYZE`, compares the claim index before/after, and runs three repetitions of enqueue, claim, and mixed HTTP workloads. It writes actual results to [BENCHMARKS.md](BENCHMARKS.md) and [benchmarks/latest.json](benchmarks/latest.json).

The standalone load program accepts `enqueue`, `claim`, or `mixed`; claim-only workloads require available jobs in the supplied queue. Measurements and their limits are documented with the results. Docker deployment configuration is included, but the recorded validation was performed with local PostgreSQL because Docker Desktop WSL integration was unavailable.

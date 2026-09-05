# Project Contract --- Durable Job Queue Service

**Project type:** Production-oriented backend systems project\
**Primary goal:** Learn concurrency, transactional correctness, queue
semantics, database performance, and failure handling.\
**Target stack:** TypeScript + Node.js/Express + PostgreSQL + Drizzle +
Docker Compose\
**Source of truth:** PostgreSQL\
**API version:** `v1`\
**Required API endpoints:** 4

------------------------------------------------------------------------

## 1. Project Objective

Build a durable HTTP job queue service.

Clients submit jobs to the queue. Multiple independent workers compete
to claim available jobs, perform the work outside the queue service, and
acknowledge successful completion.

The system must remain correct when:

-   many clients enqueue jobs concurrently;
-   many workers compete for the same jobs;
-   workers crash after claiming a job;
-   requests are retried;
-   the database contains millions of historical jobs;
-   multiple workers attempt to claim jobs at the same time;
-   a client submits the same logical job more than once.

The project is intentionally designed so that a naive implementation can
be functionally correct under light testing but fail under concurrency
or load.

The goal is **not** to build a full RabbitMQ/Kafka replacement.

The goal is to understand the engineering problems underneath a durable
work queue.

------------------------------------------------------------------------

# 2. Core Concepts

A job represents work that another process is expected to perform.

A job has a lifecycle:

``` text
QUEUED
   |
   | worker claims
   v
PROCESSING
   |
   | successful acknowledgement
   v
COMPLETED
```

A processing job can also become available again:

``` text
PROCESSING
   |
   | lease expires
   v
QUEUED
```

Repeated failures must eventually stop retrying indefinitely:

``` text
PROCESSING
   |
   | lease expires
   v
QUEUED
   |
   | claimed again
   v
...
   |
   | max attempts exceeded
   v
DEAD
```

You must define and enforce the exact state-transition rules.

------------------------------------------------------------------------

# 3. API Contract

Base URL:

``` text
/api/v1
```

The service exposes exactly four required endpoints.

  Method   Endpoint          Purpose
  -------- ----------------- ------------------------------------
  `GET`    `/health`         Verify service and database health
  `POST`   `/jobs`           Enqueue a new job
  `POST`   `/jobs/claim`     Atomically claim available jobs
  `POST`   `/jobs/:id/ack`   Acknowledge successful processing

Do not add arbitrary CRUD endpoints simply because they are convenient.

The limited API is intentional.

------------------------------------------------------------------------

# 4. Endpoint: Health

## `GET /api/v1/health`

Returns the health of the HTTP service and its PostgreSQL dependency.

### Success

**Status:** `200 OK`

``` json
{
  "status": "ok",
  "database": "ok"
}
```

The endpoint must not merely return `200` because the process is
running.

If PostgreSQL is unavailable, the endpoint must report failure.

### Database unavailable

**Status:** `503 Service Unavailable`

``` json
{
  "status": "degraded",
  "database": "unavailable"
}
```

### Requirements

-   Must execute a real database health check.
-   Must respond within a reasonable bounded time.
-   Must not perform expensive queries.
-   Must not depend on the jobs table having any rows.

------------------------------------------------------------------------

# 5. Endpoint: Enqueue Job

## `POST /api/v1/jobs`

Creates a new job.

### Request

``` json
{
  "queue": "email",
  "payload": {
    "recipient": "user@example.com",
    "template": "welcome"
  },
  "max_attempts": 5
}
```

### Required fields

  Field            Type          Rules
  ---------------- ------------- --------------------
  `queue`          string        1--100 characters
  `payload`        JSON object   Must be valid JSON
  `max_attempts`   integer       `1–20`

Additional fields must be rejected unless explicitly documented.

### Idempotency

The client may provide:

``` http
Idempotency-Key: <string>
```

If an idempotency key is provided, repeated requests using the same key
must not create multiple jobs.

The server must return the same logical job for the same idempotency
key.

The implementation must remain correct when two requests containing the
same idempotency key arrive concurrently.

### Success

**Status:** `201 Created`

``` json
{
  "id": "01J...",
  "queue": "email",
  "status": "queued",
  "attempts": 0,
  "max_attempts": 5,
  "created_at": "2026-08-25T12:00:00.000Z"
}
```

### Validation failure

**Status:** `400 Bad Request`

``` json
{
  "error": "invalid_request",
  "message": "..."
}
```

### Requirements

-   A job must be durable once the request succeeds.
-   A successful response must not be returned before the job is durably
    stored.
-   Job IDs must be generated safely under concurrent insertion.
-   The idempotency guarantee must hold under concurrent requests.
-   Payloads must not be silently modified.

------------------------------------------------------------------------

# 6. Endpoint: Claim Jobs

## `POST /api/v1/jobs/claim`

A worker asks the server for jobs it can process.

### Request

``` json
{
  "queue": "email",
  "worker_id": "worker-17",
  "limit": 10,
  "lease_seconds": 30
}
```

### Required fields

  Field             Type      Rules
  ----------------- --------- -------------------
  `queue`           string    1--100 characters
  `worker_id`       string    1--100 characters
  `limit`           integer   `1–100`
  `lease_seconds`   integer   `5–300`

### Success

**Status:** `200 OK`

``` json
{
  "jobs": [
    {
      "id": "01J...",
      "queue": "email",
      "payload": {
        "recipient": "user@example.com",
        "template": "welcome"
      },
      "attempts": 1,
      "max_attempts": 5,
      "lease_expires_at": "2026-08-25T12:00:30.000Z"
    }
  ]
}
```

If no jobs are available:

``` json
{
  "jobs": []
}
```

### Claim semantics

A successfully claimed job:

-   transitions from `queued` to `processing`;
-   receives a lease expiration time;
-   records the worker that claimed it;
-   increments its attempt count;
-   must not be claimable by another worker while its lease is valid.

### Concurrency requirement

Suppose 100 workers concurrently request jobs while only 50 jobs are
available.

The system must not:

-   give the same job to multiple workers;
-   lose jobs;
-   claim more jobs than requested;
-   corrupt attempt counts;
-   produce inconsistent states.

The solution must be correct because of database/application semantics,
not because requests happen to arrive sequentially.

### Lease expiration

If a worker claims a job but never acknowledges it, the job must
eventually become eligible for processing again after its lease expires.

You must define precisely when and how the expired lease is recognized.

### Important constraint

The endpoint must not load every queued job into application memory and
then select jobs there.

The database must perform the selection.

------------------------------------------------------------------------

# 7. Endpoint: Acknowledge Job

## `POST /api/v1/jobs/:id/ack`

Marks a successfully processed job as completed.

### Request

``` json
{
  "worker_id": "worker-17"
}
```

### Success

**Status:** `200 OK`

``` json
{
  "id": "01J...",
  "status": "completed"
}
```

### Rules

An acknowledgement is valid only when:

1.  the job exists;
2.  the job is currently being processed;
3.  the supplied worker owns the active lease.

A worker must not be able to acknowledge another worker's job.

A completed job must not return to the queue.

### Already completed

The behavior for repeated acknowledgement must be explicitly defined and
documented.

The important requirement is that repeated requests must not corrupt
state.

### Invalid worker

**Status:** `409 Conflict`

``` json
{
  "error": "lease_not_owned"
}
```

### Missing job

**Status:** `404 Not Found`

``` json
{
  "error": "job_not_found"
}
```

------------------------------------------------------------------------

# 8. Job Data Model

You must store enough information to enforce the contract.

At minimum, a job needs concepts equivalent to:

``` text
id
queue
payload
status
attempts
max_attempts
worker_id
lease_expires_at
idempotency_key
created_at
updated_at
```

You may choose different names or representations.

Do not blindly copy this structure into the database.

The design is part of the exercise.

------------------------------------------------------------------------

# 9. Job State Rules

The following transitions are legal:

``` text
queued → processing
processing → completed
processing → queued
processing → dead
```

These transitions are illegal:

``` text
queued → completed
completed → processing
completed → queued
dead → processing
dead → completed
```

You must decide where state-transition enforcement belongs and justify
the decision.

------------------------------------------------------------------------

# 10. Retry Semantics

Every time a job is claimed:

``` text
attempts += 1
```

If processing fails because the worker disappears and the lease expires,
the job becomes eligible again.

When:

``` text
attempts >= max_attempts
```

the job must not be endlessly retried.

It must transition to:

``` text
dead
```

The exact implementation of this behavior is part of the design
exercise.

------------------------------------------------------------------------

# 11. Durability Requirement

The queue is durable.

If the API process crashes immediately after a successful enqueue
response, the job must still exist after restart.

If a worker crashes after claiming a job, the queue must eventually make
that job available again.

You must distinguish between:

``` text
request succeeded
```

and:

``` text
work succeeded
```

These are not the same event.

------------------------------------------------------------------------

# 12. Database Requirements

PostgreSQL is the source of truth.

The application must not maintain a second authoritative in-memory copy
of queue state.

### Minimum scale

The database must be tested with at least:

**1,000,000 jobs**

The test dataset should contain a realistic mixture of:

-   queued jobs;
-   processing jobs;
-   completed jobs;
-   dead jobs;
-   multiple queues;
-   different creation times.

### Performance

The following operations must remain practical at million-row scale:

-   enqueueing jobs;
-   claiming jobs;
-   acknowledging jobs.

You must measure performance rather than assuming it.

------------------------------------------------------------------------

# 13. Indexing

You are responsible for determining which indexes are necessary.

Do not create indexes simply because a column exists.

For each production index, document:

1.  Which query uses it?
2.  What problem does it solve?
3.  What does it cost during writes?
4.  What happens if the index is removed?

At least one benchmark must compare an important query before and after
indexing.

Use PostgreSQL query analysis tools such as:

``` sql
EXPLAIN
EXPLAIN ANALYZE
```

Do not consider a query optimized merely because it "looks fast" on a
small dataset.

------------------------------------------------------------------------

# 14. Concurrency Requirements

The queue must support multiple workers simultaneously.

Minimum concurrency test:

``` text
50 workers
1000+ available jobs
```

The test must verify:

-   no job is successfully claimed twice while its lease is valid;
-   no job disappears;
-   attempt counts remain correct;
-   acknowledgements cannot cross worker ownership;
-   completed jobs remain completed.

The test should intentionally create contention.

A sequential test is insufficient.

------------------------------------------------------------------------

# 15. Load Testing

You must create a small load-testing program.

It should be capable of generating:

### Enqueue workload

``` text
100+ concurrent clients
```

### Claim workload

``` text
50+ concurrent workers
```

### Mixed workload

A realistic workload should contain simultaneous:

``` text
enqueue
claim
ack
```

operations.

Record at minimum:

-   requests per second;
-   successful requests;
-   failed requests;
-   latency;
-   p50;
-   p95;
-   p99;
-   error rate.

Do not optimize against one lucky run.

Run the benchmark multiple times and report the results.

------------------------------------------------------------------------

# 16. Correctness Under Load

A system that is fast but duplicates jobs is incorrect.

A system that is perfectly correct but cannot process reasonable load
does not satisfy the project.

The project therefore has two independent acceptance dimensions:

``` text
CORRECTNESS
+
PERFORMANCE
```

Both must be demonstrated.

------------------------------------------------------------------------

# 17. Failure Scenarios

You must test at least the following scenarios:

### Scenario A --- Worker crash

1.  Worker claims a job.
2.  Worker disappears.
3.  Lease expires.
4.  Another worker claims the job.
5.  Job eventually completes.

### Scenario B --- Duplicate enqueue

Two concurrent requests use the same idempotency key.

Expected:

``` text
1 logical job
```

not:

``` text
2 jobs
```

### Scenario C --- Concurrent claiming

Many workers attempt to claim jobs simultaneously.

Expected:

``` text
each job → at most one active lease
```

### Scenario D --- Wrong worker acknowledgement

Worker A claims a job.

Worker B attempts to acknowledge it.

Expected:

``` text
acknowledgement rejected
job remains processing
```

### Scenario E --- Database restart

Restart PostgreSQL.

Previously committed jobs must remain.

------------------------------------------------------------------------

# 18. Testing Requirements

Minimum test categories:

## Unit tests

Test isolated logic such as:

-   validation;
-   state transitions;
-   retry decisions;
-   lease calculations.

## Integration tests

Test against a real PostgreSQL instance.

Do not replace PostgreSQL with mocks for database behavior.

## Contract tests

Verify that API responses conform exactly to the documented contract.

## Concurrency tests

Run multiple workers simultaneously and verify queue invariants.

## Load tests

Measure throughput and latency against a large dataset.

------------------------------------------------------------------------

# 19. Required Invariants

Your implementation must preserve these invariants.

### Invariant 1

A job can have at most one active lease.

### Invariant 2

A completed job cannot be processed again.

### Invariant 3

A worker cannot acknowledge a job it does not own.

### Invariant 4

A successful enqueue cannot disappear after process restart.

### Invariant 5

An idempotency key cannot create multiple logical jobs.

### Invariant 6

Attempt counts cannot decrease.

### Invariant 7

A job exceeding its retry limit cannot remain endlessly retryable.

These invariants should appear in your tests.

------------------------------------------------------------------------

# 20. Architecture Constraints

Use a layered structure similar to:

``` text
HTTP
 ↓
validation
 ↓
service
 ↓
repository
 ↓
PostgreSQL
```

The HTTP layer should not contain database queries.

The repository layer should not decide HTTP status codes.

Business rules should not be scattered across handlers.

You may add additional layers when justified.

------------------------------------------------------------------------

# 21. Technology Constraints

Required:

-   TypeScript
-   Node.js
-   Express
-   PostgreSQL
-   Drizzle
-   Docker
-   Docker Compose

Testing framework:

-   Vitest or another TypeScript-compatible test framework.

No Redis is required.

Do not introduce Kafka, RabbitMQ, or another queue system.

**You are building the queue itself.**

------------------------------------------------------------------------

# 22. AI Usage Rule

This project is specifically intended to strengthen engineering
reasoning.

AI may be used for:

-   explaining unfamiliar concepts;
-   reviewing your design;
-   challenging assumptions;
-   identifying edge cases;
-   explaining errors;
-   reviewing code you already understand;
-   suggesting tests you may have missed.

AI should **not** be used as the default implementation engine.

Before asking AI to implement something, you should be able to answer:

``` text
What am I trying to accomplish?
Why do I think this approach works?
What are the alternatives?
What could go wrong?
```

If you cannot answer those questions, stop and learn the underlying
concept first.

------------------------------------------------------------------------

# 23. Documentation Requirements

The repository must contain:

``` text
README.md
ARCHITECTURE.md
BENCHMARKS.md
```

The README should explain:

-   what the project does;
-   how to run it;
-   API overview;
-   architecture;
-   testing;
-   benchmark results.

`ARCHITECTURE.md` should explain important design decisions.

For every non-trivial decision, document:

``` text
Problem
Decision
Reason
Alternative considered
Tradeoff
```

`BENCHMARKS.md` should contain actual measurements.

Do not invent performance numbers.

------------------------------------------------------------------------

# 24. Definition of Done

The project is complete when:

-   [ ] all four endpoints are implemented;
-   [ ] API contract is enforced;
-   [ ] jobs survive process restarts;
-   [ ] idempotent enqueue works under concurrency;
-   [ ] concurrent workers cannot double-claim an active job;
-   [ ] leases expire correctly;
-   [ ] failed jobs retry;
-   [ ] jobs eventually become dead after exceeding retry limits;
-   [ ] worker ownership is enforced;
-   [ ] PostgreSQL contains at least 1,000,000 test jobs;
-   [ ] important queries have been analyzed with `EXPLAIN ANALYZE`;
-   [ ] appropriate indexes have been justified;
-   [ ] concurrency tests pass;
-   [ ] integration tests use real PostgreSQL;
-   [ ] load tests measure throughput and latency;
-   [ ] benchmarks are documented;
-   [ ] Docker Compose can reproduce the environment;
-   [ ] README explains the system;
-   [ ] architecture decisions are documented;
-   [ ] the developer can explain the implementation without relying on
    AI.

------------------------------------------------------------------------

# 25. What This Project Is Supposed to Teach

By the end, you should be able to reason about:

### Databases

-   transactions;
-   indexes;
-   query plans;
-   row locking;
-   contention;
-   isolation;
-   large datasets.

### Concurrency

-   race conditions;
-   atomic operations;
-   ownership;
-   leases;
-   competing workers.

### Distributed-systems fundamentals

-   at-least-once delivery;
-   worker failure;
-   retries;
-   idempotency;
-   durability;
-   partial failure.

### Backend engineering

-   strict API contracts;
-   layered architecture;
-   validation;
-   error semantics;
-   integration testing;
-   load testing.

### Performance engineering

-   throughput;
-   latency;
-   p50/p95/p99;
-   database bottlenecks;
-   benchmarking;
-   measuring before optimizing.

The most important outcome is not the queue itself.

It is being able to look at a requirement such as:

> "Multiple workers need to safely claim jobs from a shared database"

and immediately start asking:

> "What race condition exists here? What state transition am I
> protecting? What transaction boundary do I need? What happens when the
> worker dies? What happens at 10 million rows?"

That is the engineering skill this project is designed to build.

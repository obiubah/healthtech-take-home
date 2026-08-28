# Implementation tickets

Tickets are ordered by dependency and should be completed one at a time.
Behavioural implementation follows red-green-refactor: add a failing test,
implement the smallest change that passes it, then improve the code without
changing behaviour. Database migrations are verified by applying them to an
actual PostgreSQL database.

## HT-001: Capture the system design

**Goal:** Record the agreed architecture, state transitions, reliability
assumptions, and deliberate limitations before implementation begins.

**Acceptance criteria:**

- The ingest, processing, retry, notification, and deduplication flows are
  documented.
- The `forms` and `jobs` data models and their constraints are documented.
- Job claiming, abandoned-job recovery, and retry behaviour are documented.
- Assumptions about `application_reference`, worker concurrency, FORM-BOT, and
  email delivery semantics are explicit.

## HT-002: Add the PostgreSQL foundation

**Goal:** Add a PostgreSQL connection and migrations for the `forms` and `jobs`
tables described in the design.

**Acceptance criteria:**

- A repeatable command applies migrations to an actual PostgreSQL database.
- The migration applies cleanly to an empty database and is idempotent.
- `application_reference` is unique when present; `session_id` is indexed but
  not unique.
- A form can retain a raw payload even when external identity fields are absent.
- A form can have at most one job of each type.

## HT-003: Ingest forms durably and idempotently

**Goal:** Implement `POST /ingest` as a short database transaction that stores
the raw payload and creates a `PROCESS_FORM` job.

**TDD sequence:**

1. Test successful acceptance, persistence, and the `202` response.
2. Test duplicate application references.
3. Test malformed/non-object request bodies and transaction rollback.
4. Implement only enough endpoint and repository code to pass each test.

**Acceptance criteria:**

- A valid JSON object is stored before the endpoint responds.
- The form and its job are committed atomically.
- Re-delivery of an existing `application_reference` does not create another
  form or processing job.
- The endpoint does not perform geocoding, transformation, or email delivery.

## HT-004: Map raw provider data to the FORM-BOT schema

**Goal:** Build a pure, test-driven source-to-target mapper for all three
provided examples.

**TDD sequence:**

1. Add a failing test for each provided example.
2. Add focused failing tests for name splitting, gender conversion, dates,
   optional fields, and nested address fields.
3. Add a failing test for a supported source-field alias.
4. Implement the smallest mapper and target validation needed to pass.

**Acceptance criteria:**

- Raw input maps directly to the supplied transformed schema.
- Required and optional target fields behave as documented by the supplied
  schemas.
- Known source aliases can be added in one focused place.
- Missing, conflicting, or invalid values produce useful errors.
- Geocoding is supplied to the mapper as coordinates rather than called by the
  pure mapping code.

## HT-005: Claim and execute jobs safely

**Goal:** Implement the polling worker and PostgreSQL-backed job state machine.

**TDD sequence:**

1. Test atomic claiming with two concurrent claim attempts.
2. Test `PENDING -> PROCESSING -> COMPLETED`.
3. Test retryable and terminal failures.
4. Test reclaiming a stale `PROCESSING` job.

**Acceptance criteria:**

- Claims use a short transaction with `FOR UPDATE SKIP LOCKED`.
- Concurrent workers cannot claim the same active job.
- `claimed_at` allows an abandoned job to be reclaimed after a documented
  timeout.
- The worker does not hold a database transaction open during external calls.
- Jobs become `FAILED` after the documented attempt limit.

## HT-006: Process forms asynchronously

**Goal:** Connect the `PROCESS_FORM` handler to postcode lookup and the mapper.

**TDD sequence:**

1. Test successful lookup, transformation, and persistence.
2. Test retry after a postcode-provider `500`.
3. Test terminal mapping errors while retaining the raw payload.
4. Test the successful database transaction atomically marks the form ready,
   completes the processing job, and creates the email job.

**Acceptance criteria:**

- Successful forms contain a complete transformed payload and are `READY`.
- A postcode-provider failure is retryable and cannot create an email job.
- A mapping failure is recorded without losing or overwriting the raw payload.
- A form cannot produce duplicate `SEND_EMAIL` jobs.

## HT-007: Send the success email durably

**Goal:** Implement the `SEND_EMAIL` handler using the provided SendGrid mock.

**TDD sequence:**

1. Test the required recipient and successful completion.
2. Test retry after a provider `500`.
3. Test that an email retry never reprocesses the form.

**Acceptance criteria:**

- The recipient is `happyforms@bots.com`.
- Email failure affects only the email job; the form remains `READY`.
- The durable job guarantees continued delivery attempts until the configured
  terminal policy is reached.
- The delivery guarantee is documented as durable attempts, including the
  provider idempotency required for exactly-once delivery.

## HT-008: Retry failed work through the API

**Goal:** Add a targeted retry endpoint for a failed form's jobs.

**TDD sequence:**

1. Test retrying a failed processing job.
2. Test retrying a failed email job independently.
3. Test rejection of unknown forms and non-failed jobs.

**Acceptance criteria:**

- `POST /forms/:id/retry` requeues only failed work associated with that form.
- A retry resets the attempt/error metadata required for another run.
- The endpoint returns `202` and does not execute work synchronously.
- Completed jobs and already-ready forms are not processed twice.

## HT-009: Verify and explain the complete system

**Goal:** Add end-to-end coverage and make the repository submission-ready.

**Acceptance criteria:**

- Integration tests cover ingestion through readiness and notification.
- Tests cover duplicate delivery, provider failure, schema/mapping failure,
  manual retry, and concurrent claims.
- The README contains setup, migration, run, worker, test, and API instructions.
- The README summarizes the selected design and its operational guarantees.
- A concise five-minute Loom outline is included.

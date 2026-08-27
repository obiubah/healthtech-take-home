# Form ingestion system design

## Scope

The service durably accepts unreliable third-party registration payloads,
asynchronously converts supported payloads into the FORM-BOT schema, enriches
them with postcode coordinates, and durably requests a success notification.
It retains failures so that a code change can be deployed and the original work
retried.

## Assumptions

- `application_reference` identifies a logical application. A repeated value is
  treated as a duplicate delivery and must not create another FORM-BOT result.
- `session_id` is provider/session metadata. Multiple applications may share a
  session, so it is indexed but not unique.
- Missing external identifiers do not prevent retention of a raw payload. Such
  a payload is expected to fail during processing with a useful error.
- Workers may run concurrently.
- The supplied postcode lookup is read-only and safe to retry.
- The supplied email provider has no idempotency-key contract. The system can
  durably guarantee continued attempts, but cannot guarantee exactly-once email
  delivery across a crash after provider acceptance and before database commit.
- The assignment requires forms to be ready for future FORM-BOT processing but
  does not define a FORM-BOT delivery API. `READY` plus a unique application
  reference is therefore the delivery boundary in this implementation.

## Components and flow

### Ingestion

`POST /ingest` stores the unmodified JSON object and creates a `PROCESS_FORM`
job in one database transaction. It returns `202 Accepted` without performing
provider calls. Duplicate application references return the existing form and
do not create more work.

### Form processing

The `PROCESS_FORM` handler:

1. Reads the stored raw payload.
2. Reads known source paths and maps them directly into the transformed schema.
3. Calls the supplied postcode lookup for coordinates.
4. Applies explicit name, gender, date, optional-field, and address conversions.
5. Validates the target object.
6. In one transaction, stores the transformed payload, marks the form `READY`,
   completes the processing job, and creates one `SEND_EMAIL` job.

Provider field aliases are defined in the source-to-target mapper. An unknown
provider change causes processing to fail; the raw payload is retained, the
mapping can be changed, and the same work can then be retried.

### Email delivery

The `SEND_EMAIL` handler calls the supplied provider for
`happyforms@bots.com`. It has an independent job lifecycle, so email failure
cannot rerun transformation or change a ready form back to failed.

### Retry

Retryable provider failures return a job to `PENDING` until the configured
attempt limit is reached. Terminal mapping/data failures become `FAILED`.
`POST /forms/:id/retry` requeues failed work asynchronously after investigation
or deployment of a compatibility fix.

## Data model

### `forms`

| Column | Purpose |
| --- | --- |
| `id` | Internal UUID primary key |
| `session_id` | Nullable, indexed provider session metadata |
| `application_reference` | Nullable unique logical-application identity |
| `raw_payload` | Required JSONB containing the unmodified accepted object |
| `transformed_payload` | Nullable JSONB populated only on complete success |
| `status` | `PENDING`, `READY`, or `FAILED` |
| `error` | Latest terminal form-processing error, when applicable |
| `created_at`, `updated_at` | Audit timestamps |

### `jobs`

| Column | Purpose |
| --- | --- |
| `id` | Internal UUID primary key |
| `form_id` | Foreign key to the owning form |
| `type` | `PROCESS_FORM` or `SEND_EMAIL` |
| `status` | `PENDING`, `PROCESSING`, `COMPLETED`, or `FAILED` |
| `attempt_count` | Number of times the job has been claimed |
| `claimed_at` | Claim time used to detect abandoned work |
| `error` | Latest execution error |
| `created_at`, `updated_at` | Audit timestamps |

`UNIQUE (form_id, type)` prevents duplicate processing and notification jobs for
one form.

## Job state machine

```text
PENDING -> PROCESSING -> COMPLETED
               |
               +-> PENDING  (retryable failure with attempts remaining)
               |
               +-> FAILED   (terminal error or attempt limit reached)

FAILED -> PENDING            (targeted manual retry)
```

Workers claim a pending job, or a processing job with an expired claim, inside
a short transaction using `FOR UPDATE SKIP LOCKED`. They set `PROCESSING`,
increment `attempt_count`, and set `claimed_at`, then commit before making any
external call. This prevents concurrent workers from claiming the same active
job without holding database locks during network operations.

Retried jobs return to `PENDING` and become eligible on the worker's next
polling cycle.

## Consistency boundaries

- Form insertion and initial job creation are atomic.
- A transformed payload, the form's `READY` state, completion of
  `PROCESS_FORM`, and creation of `SEND_EMAIL` are atomic.
- The unique application reference prevents two stored successful results for
  the assumed logical application identity.
- The unique form/job-type constraint makes job creation idempotent.
- Email-provider acceptance and local job completion cannot be one atomic
  transaction; provider-side idempotency would be required to close that gap.

## Testing strategy

Implementation follows red-green-refactor. Pure mapping behaviour is covered by
unit tests using the supplied fixtures. Database constraints, transactions, job
claiming, retry, and concurrency are covered against PostgreSQL. HTTP behaviour
is covered with Supertest, and provider modules are replaced with deterministic
test doubles at the handler boundary.

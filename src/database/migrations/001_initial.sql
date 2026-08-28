CREATE TYPE form_status AS ENUM ('PENDING', 'READY', 'FAILED');
CREATE TYPE job_type AS ENUM ('PROCESS_FORM', 'SEND_EMAIL');
CREATE TYPE job_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE forms (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	session_id TEXT,
	application_reference TEXT UNIQUE,
	raw_payload JSONB NOT NULL,
	transformed_payload JSONB,
	status form_status NOT NULL DEFAULT 'PENDING',
	error TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX forms_session_id_idx ON forms (session_id);

CREATE TABLE jobs (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	form_id UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
	type job_type NOT NULL,
	status job_status NOT NULL DEFAULT 'PENDING',
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	claimed_at TIMESTAMPTZ,
	error TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	UNIQUE (form_id, type)
);

CREATE INDEX jobs_pending_idx ON jobs (created_at)
	WHERE status = 'PENDING';

CREATE INDEX jobs_stale_claim_idx ON jobs (claimed_at)
	WHERE status = 'PROCESSING';

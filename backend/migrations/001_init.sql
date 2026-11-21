CREATE TABLE centres (id text PRIMARY KEY, name text NOT NULL, district text NOT NULL);
CREATE TABLE users (
  id text PRIMARY KEY, name text NOT NULL,
  role text NOT NULL CHECK (role IN ('CENTRE','DISTRICT','QUALITY','STATE')),
  district text, centre_id text REFERENCES centres(id));
CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centre_id text NOT NULL REFERENCES centres(id),
  title text NOT NULL, course text NOT NULL,
  status text NOT NULL,                       -- DRAFT, DISTRICT_REVIEW, QUALITY_REVIEW, STATE_REVIEW, ISSUING, ISSUED, RETURNED, REJECTED
  round int NOT NULL DEFAULT 1,               -- bumps on every resubmission; approvals of older rounds no longer count
  size int NOT NULL DEFAULT 0,
  stage_entered_at timestamptz NOT NULL DEFAULT now(),
  escalated_at timestamptz,
  return_reason text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX batches_status_idx ON batches(status);
CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  name text NOT NULL, phone text NOT NULL,
  UNIQUE (batch_id, phone));
CREATE TABLE approvals (
  id bigserial PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id),
  round int NOT NULL, stage text NOT NULL, officer_id text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, round, stage, officer_id));   -- one officer cannot approve twice
CREATE SEQUENCE cert_serial_seq;
CREATE TABLE certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial text UNIQUE NOT NULL,                    -- never shared
  candidate_id uuid UNIQUE NOT NULL REFERENCES candidates(id),   -- one certificate per candidate
  batch_id uuid NOT NULL REFERENCES batches(id),
  name text NOT NULL, phone text NOT NULL, course text NOT NULL,
  token text UNIQUE NOT NULL,                     -- unguessable public handle (QR / download link)
  status text NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID','CANCELLED')),
  cancel_reason text, cancelled_by text, cancelled_at timestamptz,
  delivery_status text NOT NULL DEFAULT 'PENDING' CHECK (delivery_status IN ('PENDING','SENT','FAILED')),
  delivery_attempts int NOT NULL DEFAULT 0,
  pdf_ready boolean NOT NULL DEFAULT false,
  issued_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX one_valid_cert_per_person ON certificates(phone, course) WHERE status = 'VALID';
CREATE INDEX certificates_batch_idx ON certificates(batch_id);
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL, action text NOT NULL,
  batch_id uuid, cert_id uuid, details jsonb NOT NULL DEFAULT '{}');
CREATE INDEX audit_batch_idx ON audit_log(batch_id, id);

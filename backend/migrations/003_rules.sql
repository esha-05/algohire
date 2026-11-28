CREATE TABLE course_rules (
  id bigserial PRIMARY KEY, course text NOT NULL, version int NOT NULL,
  min_attendance numeric NOT NULL, min_theory numeric NOT NULL, min_practical numeric NOT NULL,
  created_by text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course, version));                      -- rules are append-only; a change = a new version
ALTER TABLE batches ADD COLUMN rule_id bigint REFERENCES course_rules(id);   -- the rule version this batch was judged by
ALTER TABLE candidates
  ADD COLUMN attendance numeric, ADD COLUMN theory numeric, ADD COLUMN practical numeric,
  ADD COLUMN eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN reasons text[] NOT NULL DEFAULT '{}',
  ADD COLUMN override_reason text;
INSERT INTO course_rules(course,version,min_attendance,min_theory,min_practical,created_by) VALUES
 ('Python Programming',1,80,40,40,'seed'),('Web Development',1,75,50,40,'seed'),('Data Analytics',1,80,45,50,'seed'),
 ('Retail Sales Associate',1,75,40,0,'seed'),('Electrician Basics',1,85,50,60,'seed'),('Tailoring',1,70,0,50,'seed');

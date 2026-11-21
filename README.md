# CertiFlow — Skilling Certificate Issuance Platform

Run: `docker compose up --build` → open http://localhost:8080. Tests: `docker compose --profile test run --rm tests`. Details in [SETUP.md](SETUP.md); production plan in [DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Requirements note (decisions where the brief was unclear)

| Question | Decision | Why |
|---|---|---|
| What is "big"? | Batch ≥ **50** candidates gets quality-team review (`QUALITY_THRESHOLD`) | Brief gives no number; configurable |
| "More than one officer" at district | **2 distinct officers of the same district** (`STAGES` in `lib.ts`) | Smallest number that satisfies "more than one"; unique DB constraint stops one officer counting twice |
| Order of steps | Centre → District (2) → Quality (only if big) → State (final) | Quality is "a closer look" before the final decision |
| Sent back, then resent: what happens to approvals? | **All earlier approvals are void; the batch restarts at district stage** (`round` counter) | The content changed after they approved, so their approval no longer describes what is in front of them. Recorded in the audit log |
| Reject vs send back | Reject is final; send back lets the centre fix and resend | Matches "approve it, reject it or send it back with a reason" |
| "Officers sometimes make mistakes, so they should be able to fix them" | Interpreted as **send back / return with reason** (before issue) and **state office can cancel an issued certificate**. Approvals are not silently editable | Anything that changes a decision must leave a record |
| "Too long" with an officer | **48h** in a stage (`SLA_SECONDS`) → batch flagged STUCK, audited, realtime alert to everyone logged in; state office sees it in the list | Nobody has to chase |
| Who can verify / what do they see | Anyone, via an unguessable token in the certificate's QR code. Shows status, serial, **masked name** (“Asha R.”), course. Never phone number | Employers need genuine/not genuine; strangers need nothing more |
| How a candidate downloads | Link in the WhatsApp message contains the same unguessable token (possession = access) | No login for candidates; cancelled → HTTP 410 |
| Duplicates | One certificate per candidate (DB unique); a phone cannot hold two VALID certificates for the same course (partial unique index; checked at upload too) | "Never two certificates" |
| Spreadsheet format | **CSV** with `name,phone` (export from Excel). Whole file validated; every bad row reported; all-or-nothing | xlsx parsing was out of scope for time |

Roles: *Centre* sees only its own batches. *District officer* sees non-draft batches of its district. *Quality/State* see all non-draft batches. Only the right role at the right stage can decide; identity always comes from the signed token.

## 2. How it fits together

```
Browser ──► nginx(web) ──► API (Express, N instances) ──► PostgreSQL (source of truth + audit log)
   ▲  SSE                      │  ▲ publish                   ▲
   └──────── Redis pub/sub ◄───┘  │                          │
                                  ▼ enqueue after commit      │
                              Redis (BullMQ "issue" queue) ──► Worker (M instances): PDF → WhatsApp → mark SENT
                                  Redis (verify cache, rate limit)        │
                                                                          ▼
                                                         whatsapp-mock (fails / times out / de-dupes)
```

### What is used where, and why
| Piece | Where | Why it is there |
|---|---|---|
| React + Vite | `frontend/` | One page app: role switcher, batch list, detail, public `#/verify/<token>` page |
| nginx | `frontend/nginx.conf` | Serves the build, proxies `/api` (SSE-safe), the single entry point |
| Express + TypeScript | `backend/src/app.ts` | REST API; `lib.ts` holds auth, stage rules, CSV save helpers |
| PostgreSQL | `backend/migrations/*.sql` | Truth: batches, approvals, certificates, audit log. Uses row locks (`FOR UPDATE`), unique constraints, a sequence for serial numbers |
| Plain SQL migrations (`migrate.ts`) | `backend/migrations` | Versioned, applied once under an advisory lock (see limitations: not Prisma/Drizzle) |
| Redis | `infra.ts` | (a) BullMQ queue backend, (b) pub/sub to fan realtime events out to every API instance, (c) verify cache + rate-limit counters |
| BullMQ | `infra.ts`, `worker.ts` | Queue with retries + exponential backoff + stalled-job recovery; job id = certificate id so no duplicates |
| Worker | `worker.ts` | Generates PDF (pdfkit + QR), sends WhatsApp, marks SENT, closes batch; scheduled SLA scan + re-queue sweeper (`maint.ts`) |
| whatsapp-mock | `whatsapp-mock/` | Stand-in provider: 20% 503, 15% “slow” (delivered but response late), de-duplicates by `Idempotency-Key` |
| SSE | `app.ts /events` | Realtime without refresh; payload is only `{type, batchId}`, UI refetches through authorised endpoints (no data leaks over the stream) |
| pino | everywhere | Structured logs with request ids |
| Vitest | `backend/tests` | Integration tests against the running stack |

### Key technical decisions
1. **Concurrency:** `decision` locks the batch row (`SELECT … FOR UPDATE`) inside a transaction. Two simultaneous approvals run one after the other; count reaches 2 once, the batch advances once (test 2). Approvals have a unique key, so one officer cannot count twice.
2. **Exactly one certificate, despite WhatsApp:** DB rows are created in the approval transaction (unique per candidate). Delivery is at-least-once with an **idempotency key = certificate id**; the provider de-duplicates. The worker is idempotent (skips SENT/cancelled, PDF written once via temp file + rename). A timeout where the message *was* delivered is retried safely.
3. **Never lose work if Redis is down at approval time:** certificates are committed first, jobs enqueued after. A sweeper re-queues any certificate undelivered after 60s (also drains a WhatsApp outage, 1000 per minute).
4. **Instant cancellation:** cancel writes DB, then overwrites the verify cache with a cancelled marker. Cache fill uses `SET NX` with 30s TTL, so a stale fill cannot overwrite it; worst case if Redis is down is a 0s staleness because there is no cache to be stale.
5. **Stateless instances:** all state in Postgres/Redis; SSE broadcast via Redis; scheduler jobs run once cluster-wide. Kill any API/worker anytime.
6. **Audit:** every decision and every delivery attempt writes `audit_log` (actor, action, batch, certificate, details) inside the same transaction as the decision. `GET /api/batches/:id` returns the end-to-end timeline.

## 3. Known limitations / next steps (honest list)
- Uses `pg` + hand-written SQL migrations instead of Prisma/Drizzle (time); a migration tool swap is mechanical.
- CSV only; no xlsx. Candidate details limited to name + phone.
- Demo login (`/auth/demo-login`) has no passwords by design; production needs real SSO/OTP (`DEMO_LOGIN=0`).
- `ENABLE_TEST_HOOKS=1` in compose exposes an endpoint that fakes batch age; must be off in production.
- PDFs live on a shared volume; production plan uses object storage (DEPLOYMENT.md).
- SSE events are broadcast to all logged-in clients (ids only, no personal data).
- Retry backoff is uncapped exponential (10 attempts); the sweeper provides the long-tail retry.
- If the last undelivered certificate of a batch is cancelled, the batch stays ISSUING until touched (edge case).
- Not load-tested; tests are integration tests, no unit tests for the CSV parser.
- I could not run Docker in the authoring environment: the TypeScript and frontend compile cleanly, but run the test suite yourself before submitting.

## 4. AI usage
*Edit this to match what you actually did.* Claude generated the first version of the code and docs. I read and can explain every file; I checked the output by compiling, running the test suite, and manually exercising the flows in the UI (two officers approving at once, cancelling a certificate, escalation).

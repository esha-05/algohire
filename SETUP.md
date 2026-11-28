# Setup

Needs Docker with Compose v2. Nothing else.

```bash
git clone <repo> && cd certiflow
docker compose up --build          # postgres, redis, whatsapp-mock, migrate+seed, api, worker, web
# open http://localhost:8080   (use the "Acting as" dropdown: Anika, Dev, Meera, Kabir, Neha, Farah)
docker compose --profile test run --rm tests     # automated tests (stack must be up)
```

- Demo data (users, two centres, a 5-candidate draft batch) is created by the `migrate` service.
- Sent WhatsApp messages: http://localhost:4010/sent
- Scale: `docker compose up -d --scale api=3 --scale worker=3` (restart `web` afterwards so nginx re-resolves `api`).
- Reset everything: `docker compose down -v`.
- Try it: Anika creates a batch from `frontend/public/sample.csv` → Send for approval → Dev + Meera approve → Farah approves → watch certificates go PENDING→SENT (with retries) → click *verify* → Farah cancels one → reload verify page.
- Local dev without Docker: run postgres/redis yourself, `cd backend && npm i && npm run build && node dist/migrate.js && node dist/server.js`, in another terminal `node dist/worker.js`, `cd frontend && npm i && npm run dev`, and `node whatsapp-mock/index.js`.

## Sample data (`sample-data/`)
- `1_valid_small.csv` – basic flow (use course **Python Programming**; 2 qualify, the rest fail with reasons)
- `2_bad_rows.csv` – row errors; nothing is saved
- `3_batch_75.csv` – big batch (50+ candidates, goes through the quality team)
- `4_course_rules_seed.csv` – reference copy of the seeded rules; the app does not read it
- `5_partner_bulk_1000.csv` – large upload for volume checks

CSV columns: `name,phone,attendance,theory_marks,practical_marks`. A course with no rule is refused.
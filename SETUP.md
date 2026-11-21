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

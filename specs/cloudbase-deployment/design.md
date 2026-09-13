# Xiaopingu CloudBase Deployment Design

## Architecture

- **Web and API:** one CloudRun container named `xiaopingu-api` serves the prepared `web/` bundle and keeps the existing `/rest/v1/*` contract on the same origin.
- **Administration:** the homepage opens `admin.html` inside a same-origin, full-screen management workspace; `/admin` serves the homepage with that workspace opened.
- **Data:** five private NoSQL collections store assessments, counselors, sessions, PCOMS ratings, and visitor identities.
- **Access:** the HTTP gateway exposes `/api/*`; the function performs application-level authorization before using the admin-grade Node SDK credential.

## Security model

- A dedicated CloudBase server API key is injected as `CLOUDBASE_APIKEY`; it is never committed or returned.
- `XPG_ADMIN_PASSWORD`, `XPG_DEMO_COUNSELOR_PASSWORD`, and `XPG_SESSION_SECRET` are injected as environment variables.
- Admin and counselor logins produce signed, expiring bearer tokens.
- Public counselor reads are sanitized. Assessment reads require possession of the record's view token.
- NoSQL collections remain private because all privileged access goes through the function.
- The local ignored data file is never uploaded.

## Runtime choice

The backend is an existing containerized REST service shared by Web and mini program clients. CloudRun keeps its process and routing model intact, while `MinNum=0` allows the demonstration environment to scale to zero. Durable data remains in NoSQL rather than the container filesystem.

## Validation

- Static syntax checks for every changed JavaScript file and static-route tests for `/`, `/admin`, and `/health`.
- Local API tests using an in-memory database adapter.
- Post-deployment health, public counselor, admin authentication, and harmless database-read checks.
- Browser smoke test of the deployed Web entry page and console logs.

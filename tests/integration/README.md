# Database integration tests

Integration suites exercise the real Express composition root against PostgreSQL. They are intentionally excluded from the default Jest match, so `npm test` does not require Docker or PostgreSQL.

The runner requires both safeguards:

- `RUN_DB_TESTS=true` explicitly enables destructive database setup;
- `DATABASE_URL_TEST` must name a database containing a separate `test` or `testing` token and must use the `public` schema.

From `project/nodejs-backend` in PowerShell:

```powershell
$env:RUN_DB_TESTS = 'true'
$env:DATABASE_URL_TEST = 'postgresql://postgres:postgres@localhost:5432/practice_crm_test?schema=public'
node .\scripts\test\run-integration.mjs
```

The runner applies committed migrations once, then resets and seeds the test database before each suite. Never point `DATABASE_URL_TEST` at a development, staging, or production database.

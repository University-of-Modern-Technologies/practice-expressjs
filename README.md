# practice-expressjs

Express + TypeScript backend and Next.js frontend, orchestrated via docker-compose.

## Layout

- `nodejs-backend/` — Express API (TypeScript, Prisma, PostgreSQL, MongoDB, Redis)
- `frontend/` — Next.js App Router client
- `etc/nginx/` — reverse proxy config

## Development

```
cp .env.example .env
docker compose up
```

# Node.js Backend

Навчальна CRM API на Express.js 5, TypeScript, Prisma, PostgreSQL, Redis, MongoDB і WebSocket.

## Вимоги

- Node.js 22+
- npm
- Docker (або локально: PostgreSQL 17+, Redis 7+, MongoDB 8+)

## Локальний запуск

```bash
cp .env.example .env
# Замініть усі значення change-me у .env
npm ci
npm run dev
```

Сервіс за замовчуванням доступний на `http://localhost:3000`.

- `GET /health/live` — процес живий
- `GET /health/startup` — застосунок завершив старт
- `GET /health/ready` — залежності доступні
- `GET /health/info` — назва, версія, середовище, uptime
- `GET /docs` — Swagger UI
- `GET /openapi.json` — OpenAPI документ
- `GET /metrics` — метрики Prometheus (лише якщо задано `METRICS_TOKEN`)
- `WS /api/v1/realtime` — канал подій реального часу

## Змінні середовища

| Змінна                         | Призначення                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `NODE_ENV`                     | Середовище: `development`, `test` або `production`               |
| `HOST`                         | Адреса прослуховування HTTP-сервера                              |
| `PORT`                         | Порт HTTP-сервера                                                |
| `LOG_LEVEL`                    | Рівень логування Pino                                            |
| `CORS_ORIGINS`                 | Дозволені origins через кому                                     |
| `JSON_BODY_LIMIT`              | Максимальний розмір JSON body                                    |
| `POSTGRES_DB`                  | Назва локальної бази Docker Compose                              |
| `POSTGRES_USER`                | Користувач локальної PostgreSQL                                  |
| `POSTGRES_PASSWORD`            | Пароль локальної PostgreSQL                                      |
| `DATABASE_URL`                 | URL підключення до PostgreSQL                                    |
| `JWT_ACCESS_SECRET`            | Секрет access token, щонайменше 32 символи                       |
| `JWT_REFRESH_SECRET`           | Секрет refresh token, щонайменше 32 символи                      |
| `SEED_USER_PASSWORD`           | Пароль синтетичних користувачів seed, від 12 знаків              |
| `REDIS_URL`                    | URL підключення до Redis                                         |
| `REDIS_KEY_PREFIX`             | Префікс ключів кешу                                              |
| `CACHE_TTL_SECONDS`            | Час життя кешованих значень                                      |
| `RATE_LIMIT_WINDOW_SECONDS`    | Вікно обмеження частоти запитів                                  |
| `RATE_LIMIT_MAX_REQUESTS`      | Ліміт запитів у вікні для загальних маршрутів                    |
| `AUTH_RATE_LIMIT_MAX_REQUESTS` | Ліміт запитів у вікні для маршрутів автентифікації               |
| `MONGO_DB`                     | Назва бази подій у Docker Compose                                |
| `MONGO_USER`                   | Користувач локальної MongoDB                                     |
| `MONGO_PASSWORD`               | Пароль локальної MongoDB                                         |
| `MONGODB_URL`                  | URL підключення до сховища подій                                 |
| `EVENT_LOG_RETENTION_DAYS`     | Скільки днів зберігаються доменні події                          |
| `WS_PATH`                      | Шлях WebSocket-каналу                                            |
| `METRICS_TOKEN`                | Токен доступу до `/metrics`, від 16 символів; без нього вимкнено |
| `SHUTDOWN_GRACE_PERIOD_MS`     | Скільки чекати на завершення активних запитів                    |
| `SHUTDOWN_TIMEOUT_MS`          | Верхня межа всієї процедури зупинки                              |
| `SHUTDOWN_DRAIN_DELAY_MS`      | Пауза між відмовою в готовності та закриттям слухача             |

## Команди

```bash
npm run dev        # запуск у режимі розробки
npm run build      # production build
npm start          # запуск зібраного застосунку
npm run lint       # ESLint
npm run format     # перевірка Prettier
npm run typecheck  # перевірка TypeScript
npm test                    # unit та module-level тести
npm run test:integration    # integration тести (потребують RUN_DB_TESTS=true)
npm run ci                  # статичні перевірки, unit-тести та build
```

## Скрипти обслуговування

```bash
sh scripts/dev-up.sh        # підняти стек і дочекатися готовності
sh scripts/dev-down.sh      # зупинити стек (дані зберігаються)
sh scripts/db-reset.sh      # скинути, змігрувати та засідити базу розробки
sh scripts/logs.sh api      # логи обраного сервісу
```

## Docker

```bash
cp .env.example .env
# Замініть усі значення change-me у .env
docker compose up --build
```

Профіль `tools` додатково піднімає Portainer:

```bash
docker compose --profile tools up -d portainer
```

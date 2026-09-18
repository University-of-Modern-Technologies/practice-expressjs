# Node.js Backend

Навчальна CRM API на Express.js 5, TypeScript, Prisma, PostgreSQL, Redis, MongoDB і WebSocket.

## Вимоги

- Node.js 22+
- npm
- Docker (або локально: PostgreSQL 17+, Redis 7+, MongoDB 8+)

## Локальний запуск

Два способи запустити цей backend, і вони не виключають один одного.

**Усе в контейнерах** — швидше й нічого не треба ставити на машину. Опис у
кореневому `README.md`, команда одна: `docker compose up`.

**Застосунок на машині, сховища в контейнерах** — саме те, що описано нижче.
Дає гарячу перезбірку, дебагер і читабельні логи.

Контейнер `api` того самого стека теж слухає `:3000`, і два процеси на одному
порту мирно не вживаються: на Windows обидва стартують без помилки, а запити
дістаються лише одному з них. Тому або зупини контейнер
(`docker compose stop api` у корені репозиторію), або
постав у `.env` цього модуля інший `PORT`, наприклад `3001`. База при цьому
спільна, і працювати проти неї можуть обидва.

### 1. Підняти сховища

Порожній застосунок запуститься й без них, але одразу впаде на першому
зверненні до бази. Стек піднімається з кореня репозиторію:

```bash
cd ..                 # корінь репозиторію
cp .env.example .env
docker compose up -d postgres redis mongo migrate
```

Команда піднімає PostgreSQL, Redis і MongoDB на `localhost:5432`, `6379` і
`27017` — саме ці адреси стоять у `.env.example`. Заразом відпрацьовує сервіс
`migrate`: він застосовує міграції й наповнює базу початковими даними, після
чого завершується. Перший запуск триває кілька хвилин через збірку образів.

Перевірити, що сховища здорові:

```powershell
docker compose ps
```

У колонці стану має бути `healthy` навпроти `postgres`, `redis` і `mongo`.

### 2. Налаштувати оточення

```bash
cd nodejs-backend
cp .env.example .env
```

Тепер заміни в `.env` усі значення `change-me`. Три з них мають обмеження на
довжину, і перевіряють їх у різні моменти:

| Змінна | Вимога | Хто перевіряє |
|---|---|---|
| `JWT_ACCESS_SECRET` | щонайменше 32 символи | застосунок на старті |
| `JWT_REFRESH_SECRET` | щонайменше 32 символи | застосунок на старті |
| `SEED_USER_PASSWORD` | від 12 знаків | сценарій наповнення бази |

Тобто закороткий секрет не дасть застосунку піднятися взагалі, а закороткий
пароль наповнення виявиться лише тоді, коли дійде до сідінгу.

Паролі сховищ (`POSTGRES_PASSWORD`, `MONGO_PASSWORD`) мусять збігатися з тими,
що в кореневому `.env` — інакше застосунок на машині не зайде в базу,
підняту стеком. Ті самі значення стоять і всередині `DATABASE_URL` та
`MONGODB_URL`, тож міняти їх треба в обох місцях.

### 3. Поставити залежності

```bash
npm ci
```

У виводі має бути рядок `Generated Prisma Client`. Клієнт бази не лежить у
репозиторії: його щоразу генерують зі `prisma/schema.prisma`, і `npm ci` робить
це сам. Після будь-якої зміни схеми крок повторюють окремо:

```bash
npm run prisma:generate
```

### 4. Запустити

```bash
npm run dev
```

Готовність видно за рядком `HTTP server listening` у логах. Перевірити ззовні:

```bash
curl http://localhost:3000/health/ready
```

Відповідь `{"status":"ready", ...}` містить перелік залежностей, і кожна має
бути `up`. Якщо котрась `down`, вона названа поіменно — це і є місце, куди
дивитися.

Перевірити, що відповідає саме твій процес, а не контейнер, можна за
`GET /health/info`: там є `uptimeSeconds`, і в щойно запущеного застосунку він
малий.

Сервіс доступний на `http://localhost:3000`:

- `GET /health/live` — процес живий
- `GET /health/startup` — застосунок завершив старт
- `GET /health/ready` — залежності доступні
- `GET /health/info` — назва, версія, середовище, uptime
- `GET /docs` — Swagger UI
- `GET /openapi.json` — OpenAPI документ
- `GET /metrics` — метрики Prometheus (лише якщо задано `METRICS_TOKEN`)
- `WS /api/v1/realtime` — канал подій реального часу

### Зупинити

Сам застосунок — `Ctrl+C` у його терміналі. Сховища живуть окремо:

```bash
cd ..
docker compose down            # дані лишаються
docker compose down --volumes   # разом із базами
```

### Повернути базу до початкового стану

База локальна й нічия, тому найпростіший шлях — знести її разом із томом:

```bash
docker compose down --volumes
docker compose up -d postgres redis mongo migrate
```

Міграції й наповнення відпрацюють заново. Те саме без перезапуску стека робить
`sh scripts/db-reset.sh`.

### Якщо не запускається

**`@prisma/client did not initialize yet`.** Клієнт бази не згенерований. Так
буває, коли залежності ставили з `--ignore-scripts`. Лікується
`npm run prisma:generate`.

**`Invalid environment configuration`.** Застосунок перелічує поля, які не
пройшли перевірку, і вимогу до кожного. Найчастіше це `JWT_ACCESS_SECRET` або
`JWT_REFRESH_SECRET`, замінені на щось коротше за 32 символи.

**`ECONNREFUSED` на `:5432`, `:6379` або `:27017`.** Сховища не підняті або вже
зупинені. Перевір `docker compose ps` у корені
репозиторію.

**Пароль не підходить до бази.** `.env` цього модуля й кореневий `.env`
розійшлися. Паролі мають збігатися в обох.

**`port is already allocated`.** Порт зайнятий іншою програмою або іншим
запущеним стеком. Зупини його або задай інший порт у кореневому `.env`
(`POSTGRES_PORT`, `REDIS_PORT`, `MONGO_PORT`, `API_PORT`).

**Застосунок стартував, але відповідає не він.** Ознака — `uptimeSeconds` у
`GET /health/info` набагато більший за вік твого процесу, а зміни в коді на
відповідь не впливають. Це контейнер `api` на тому самому `:3000`. Зупини його
або візьми інший `PORT` у `.env`.

**Контейнер висить у стані `Created`.** Docker не може змонтувати робочу теку.
Перевір, що диск, на якому лежить проєкт, відкритий у налаштуваннях Docker
Desktop (Settings → Resources → File sharing).

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
npm run prisma:generate     # перегенерувати клієнт бази після зміни схеми
npm run prisma:validate     # перевірити саму схему
```

`npm test` проходить без піднятих сховищ: наскрізні набори в нього не входять і
названі окремим рядком у кінці прогону. Запускає їх `npm run test:integration`,
і йому потрібна окрема тестова база — умови в `tests/integration/README.md`.

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

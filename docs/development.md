# Розробка

Як працювати з кодом на своїй машині: запуск частинами, тести, міграції,
демо-дані, опис API й змінні оточення. Перший запуск і повний перелік команд —
у [`README.md`](../README.md), будова системи — в
[`ARCHITECTURE.md`](../ARCHITECTURE.md), розгортання — у
[`deployment.md`](deployment.md).

Усі команди `npm run …` нижче виконуються з кореня репозиторію, якщо не сказано
інше. Команди з позначкою «у `backend/`» — з теки `backend`.

## Підготовка

```bash
npm run setup           # .env і backend/.env з новими секретами, перевірка портів, хук перед комітом
npm run local:install   # залежності бекенда й клієнта: потрібні для local:*, test і check
```

Потрібні Docker з Compose v2 і Node.js 22 (версія — у `.nvmrc`). Сховища
(PostgreSQL, Redis, MongoDB) завжди працюють у Docker; API й клієнт — у Docker
або на машині.

## Локальна розробка

| Що правиш | Що запускати | Адреса |
|---|---|---|
| нічого, лише дивишся | `npm run docker:all` | http://localhost:8080 |
| бекенд | `npm run local:api` | http://localhost:8000/api/docs |
| бекенд і клієнт | `npm run local:api`, у другому терміналі `npm run local:web` | http://localhost:3000 |
| лише клієнт | `npm run docker:api`, потім `npm run local:web` | http://localhost:3000 |
| перевірити production-збірку | `npm run docker:prod` | http://localhost:8080 |

- `local:api` спершу виконує `docker:db` (сховища, міграції, базове
  наповнення), потім запускає `npm run dev` у `backend/` — `tsx watch
  src/server.ts`, тобто перезапуск при збереженні файла. Якщо порт API вже
  зайнятий (найчастіше контейнером `api`), команда не стартує: спершу
  `npm run docker:stop`.
- `local:web` запускає `next dev` на `WEB_PORT` і пересилає `/api` на
  `http://127.0.0.1:<API_PORT>` — байдуже, хто там слухає: контейнер чи
  `local:api`.
- `docker:db` → `docker:api` → `docker:all` вкладені одна в одну; те, що вже
  запущено, не перезапускається.
- `docker:api` теж перезапускає API при збереженні: у режимі розробки код
  `backend/` змонтований у контейнер (`compose.override.yaml`).
- Зупинка: процеси на машині — `Ctrl+C`, усе докерне — `npm run docker:stop`.
  `npm run docker:clean` ще й видаляє бази (питає підтвердження).
- Діагностика: `npm run docker:ps`, `npm run docker:logs` (або
  `npm run docker:logs -- api`), `npm run docker:portainer`,
  http://localhost:8000/api/health/ready.

Власні команди пакетів — у `backend/package.json` і `frontend/package.json`;
`npm run` у теці показує список.

## Тести й перевірки

| Що | Команда | Що потрібно |
|---|---|---|
| юніт-тести бекенда й клієнта | `npm test` | `local:install`; сховища не потрібні |
| інтеграційні тести бекенда | `npm run docker:db`, потім `npm run test:integration` | запущені сховища |
| усе, що перевіряє CI для бекенда й клієнта | `npm run check` | `local:install` |
| те саме лише для бекенда | `npm run check:api` | `local:install` |
| те саме лише для клієнта | `npm run check:web` | `local:install` |

**Юніт-тести бекенда** — Jest, файли `backend/src/**/*.test.ts` поруч із кодом.
Вони не відкривають жодного з'єднання: клієнти сховищ підмінено, конфігурацію
дає `backend/src/test/config.ts`. У `backend/`: `npm test`, `npm run
test:watch`, один файл — `npx jest src/modules/products/service.test.ts`.

**Інтеграційні тести** — `backend/tests/integration/*.integration.test.ts`,
проти справжніх сховищ `docker:db`. Раннер (`backend/scripts/test/run-integration.mjs`)
сам створює тестову базу PostgreSQL (назва робочої бази + `_test`), застосовує
міграції й перед кожним набором скидає та наповнює базу заново. MongoDB —
база з суфіксом `_test`, Redis — ключі з префіксом `crm-test:`. Секрети
фіксовані тестові, робочі `DATABASE_URL`, `REDIS_URL`, `MONGODB_URL` не
використовуються ніколи. Явні `DATABASE_URL_TEST`, `REDIS_URL_TEST`,
`MONGODB_URL_TEST` мають пріоритет — так адреси задає CI. Новий файл у теці
потрапляє в прогін сам. Якщо сховище не відповідає, команда падає з ненульовим
кодом і підказує `docker:db`.

**`check:api`** запускає в `backend/` `npm run ci`: перевірка схеми Prisma,
генерація клієнта, ESLint, Prettier (`--check`), `tsc --noEmit`, юніт-тести,
збірка. **`check:web`** — у `frontend/` `npm run ci`: Prettier, ESLint, типи,
Vitest, `next build`. CI запускає ці самі скрипти, тож зелений `check` на
машині — зелений pipeline. Окремими jobs CI ще ганяє інтеграційні тести,
звірку міграцій зі схемою (нижче) і збирання production-образів.

Окремі кроки в `backend/`: `npm run lint`, `npm run format` (перевірка),
`npm run format:write` (виправлення), `npm run typecheck`. У `frontend/`
навпаки: `npm run format` виправляє, `npm run format:check` перевіряє.
Наскрізні браузерні тести клієнта — `npm run e2e` у `frontend/` (Playwright).

**Хук перед комітом** (husky + lint-staged, ставить `setup`) форматує й лінтить
лише файли, що йдуть у коміт. Тести він не запускає — для них `check`.

## Міграції

Схема бази — `backend/prisma/schema.prisma`, міграції —
`backend/prisma/migrations/`. Prisma CLI запускається через
`backend/scripts/run-prisma.mjs`: він читає `.env` так само, як застосунок, тож
CLI бачить ту саму базу, що й `local:api`.

**Змінити схему** (у `backend/`, при запущеному `docker:db`):

```bash
npm run prisma:generate                     # перегенерувати клієнт бази під нову схему
npm run db:migrate -- --name add_something  # prisma migrate dev: створює міграцію й застосовує її
```

Міграцію комітять разом зі зміною `schema.prisma`. Якщо схема не змінилася,
`db:migrate` повідомляє, що база вже синхронна, і нічого не створює.

**Застосувати наявні міграції:**

- з кореня — `npm run db:migrate`: одноразовий контейнер `migrate` застосовує
  міграції (`prisma migrate deploy`) і базове наповнення. Те саме відбувається
  автоматично в кожній `docker:*`-команді, що запускає сховища;
- у `backend/` на машині — `npm run db:migrate:deploy`, лише міграції.

**Перевірити, що міграції й схема збігаються** (у `backend/`):

```bash
npm run prisma -- migrate status
npm run prisma -- migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
```

Перша показує незастосовані міграції. Друга порівнює базу, до якої веде `.env`,
зі схемою: код виходу 2 означає, що схему змінили без міграції або навпаки.
Job CI «Migrations in sync with the schema» робить те саме на порожній базі:
застосовує всі міграції й порівнює результат зі `schema.prisma`.

**Почати з чистої бази:** `npm run docker:clean`, потім `npm run docker:db`.
Без перезапуску контейнерів — `sh backend/scripts/db-reset.sh` (відмовляється
працювати при `APP_ENV=production`, питає підтвердження, у неінтерактивній
оболонці потрібен `--yes`).

Клієнт бази не лежить у репозиторії: `npm ci` генерує його сам (`postinstall`).
Помилка `@prisma/client did not initialize yet` лікується
`npm run prisma:generate` у `backend/`.

## Демо-дані

Базове наповнення (`backend/prisma/seed.ts`) створює ролі з дозволами,
облікові записи з [`README.md`](../README.md) і невеликий набір записів.
Воно наповнює лише порожню базу: якщо користувачі вже є, нічого не змінює, тож
перезапуск стека не повертає змінені паролі й залишки. Повернутися до
початкових даних — `npm run docker:clean`, потім `npm run docker:db`.

Великий демонстраційний набір за рік — контакти, угоди, замовлення, рухи
товару, аудит — завантажує

```bash
npm run db:seed:demo
```

з кореня: він виконується в контейнері `migrate` проти бази `docker:db`. У
`backend/` на машині те саме — `npm run db:seed:demo`. Рядки беруться з
`backend/prisma/demo-data/`. Скрипт видаляє лише ті рядки, які сам записав
минулого разу, тому його можна запускати скільки завгодно разів і базового
наповнення він не чіпає.

Обидва наповнення беруть пароль облікових записів із `SEED_USER_PASSWORD` і в
production працюють лише з `SEED_ALLOW_PRODUCTION=true`.

## Опис API (OpenAPI)

Опис будується з коду — як саме, розказано в
[`ARCHITECTURE.md`](../ARCHITECTURE.md#опис-api-openapi). На практиці:

- новий маршрут реєструється через `describeRoutes(...)` у `router.ts` модуля,
  з `validate(<схема>)` у ланцюжку й схемою відповіді з `types.ts`;
- відмови 4xx, які може повернути сервіс, перелічуються поруч:
  `refusals(401, 403, 404, 409)`; 400 і 500 додаються самі;
- маршрут через звичайний `router.get(...)` у опис не потрапить, і
  `src/openapi.routes.test.ts` це покаже.

Після будь-якої зміни маршрутів, схем запиту чи відповіді (у `backend/`):

```bash
npm run openapi:generate
```

Команда перезаписує `backend/openapi.json` без сервера й без сховищ, з
фіксованими налаштуваннями, тож на кожній машині виходить той самий файл.
Його комітять разом зі зміною коду: `src/openapi.drift.test.ts` (входить у
`npm test` і `check:api`) падає, якщо закомічений файл розійшовся з кодом.

Живий опис — http://localhost:8000/api/docs (Swagger UI) і
`/api/openapi.json`. У production обидва вимкнені, якщо не задано
`API_DOCS_ENABLED=true`.

## Змінні оточення

Оточення лежить у двох файлах, обидва створює `setup` з `*.env.example`:

| Файл | Що в ньому | Хто читає |
|---|---|---|
| `.env` | середовище, порти, назви й паролі сховищ | Docker Compose (для підстановки в `compose.yaml`); API на машині |
| `backend/.env` | усе, що стосується лише бекенда | контейнери `api` і `migrate`; API на машині |

API бере значення в такому порядку: змінні процесу, потім `backend/.env`, потім
кореневий `.env` (`backend/src/config/load-env.cjs`). Усі змінні бекенда
перевіряє zod-схема `backend/src/config/env.ts`; неправильне значення зупиняє
старт з переліком полів (`Invalid environment configuration`). Порожнє значення
(`KEY=`) означає те саме, що відсутнє: діє типове.

### Кореневий `.env`

Значення за замовчуванням — у `.env.example`.

| Змінна | Що означає |
|---|---|
| `PROJECT_NAME` | назва Compose-проєкту: префікс контейнерів, мережі й томів |
| `APP_ENV` | `development`, `test` або `production` для API на машині. Контейнерам Compose ставить власне значення: `production` у `compose.yaml`, `development` в override |
| `HTTP_PORT`, `API_PORT`, `WEB_PORT` | порти nginx, API й клієнта на машині. `API_PORT` — ще й порт, на якому слухає `local:api` |
| `POSTGRES_PORT`, `REDIS_PORT`, `MONGO_PORT`, `PORTAINER_PORT` | порти сховищ і Portainer; сховища й Portainer слухають лише `127.0.0.1` |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | база PostgreSQL і обліковий запис |
| `MONGO_DB`, `MONGO_USER`, `MONGO_PASSWORD` | база MongoDB і обліковий запис |

### Бекенд: адреси сховищ

`DATABASE_URL`, `REDIS_URL` і `MONGODB_URL` у файлах зазвичай не пишуть: API
збирає їх на старті з частин. Явно задана адреса перемагає зібрану.

| Змінна | Що означає | За замовчуванням |
|---|---|---|
| `DATABASE_URL` | адреса PostgreSQL | збирається з `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| `REDIS_URL` | адреса Redis | збирається з `REDIS_HOST`, `REDIS_PORT` |
| `MONGODB_URL` | адреса MongoDB | збирається з `MONGO_HOST`, `MONGO_PORT`, `MONGO_DB`, `MONGO_USER`, `MONGO_PASSWORD` (без користувача — без автентифікації) |
| `POSTGRES_HOST`, `REDIS_HOST`, `MONGO_HOST` | хост сховища | `127.0.0.1`; у Docker `compose.yaml` ставить імена сервісів |
| `POSTGRES_PORT`, `REDIS_PORT`, `MONGO_PORT` | порт сховища | `5432`, `6379`, `27017` |

### Бекенд: застосунок

| Змінна | Що означає | За замовчуванням |
|---|---|---|
| `HOST` | адреса, на якій слухає API | `0.0.0.0` |
| `PORT` | порт API; має пріоритет над `API_PORT` | `API_PORT`, інакше `8000` |
| `LOG_LEVEL` | рівень журналу: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | `info` |
| `CORS_ORIGINS` | дозволені origin через кому; `*` — будь-який | `http://localhost:3000` |
| `JSON_BODY_LIMIT` | найбільший розмір тіла запиту з одиницею (`1mb`, `512kb`) або в байтах, від 1024 до 67108864; більше тіло дістає 413 | `1mb` |
| `JSON_BODY_LIMIT_BYTES` | те саме в байтах; перемагає `JSON_BODY_LIMIT` | не задано |
| `TRUSTED_PROXIES` | адреси чи CIDR-мережі проксі через кому, яким API вірить щодо адреси клієнта (`X-Forwarded-For`); `*` не приймається. У Docker `compose.yaml` ставить `172.16.0.0/12` — мережу, з якої приходить nginx | не задано — адреса клієнта є адресою з'єднання |
| `LOG_SQL` | `true` — журнал кожного SQL-запиту з параметрами; у production не діє | `false` |
| `JWT_ACCESS_SECRET` | секрет підпису access-токена, щонайменше 32 символи | немає, обов'язкова |
| `JWT_REFRESH_SECRET` | щонайменше 32 символи; перевіряється на старті | немає, обов'язкова |
| `REDIS_KEY_PREFIX` | префікс усіх ключів Redis | `crm:` |
| `CACHE_TTL_SECONDS` | скільки живе кешований звіт, налаштування чи набір дозволів | `300` |
| `RATE_LIMIT_WINDOW_SECONDS` | вікно обмеження частоти запитів | `60` |
| `RATE_LIMIT_MAX_REQUESTS` | запитів за вікно для одного користувача (за access-токеном) чи адреси | `300` |
| `AUTH_RATE_LIMIT_MAX_REQUESTS` | додатковий, менший бюджет на `/api/v1/auth`, крім `/me` і `/logout` | `10` |
| `EVENT_LOG_RETENTION_DAYS` | скільки днів MongoDB зберігає доменні події | `90` |
| `WS_PATH` | шлях каналу подій реального часу. Фіксований: nginx і веб-клієнт з'єднуються саме з `/api/v1/realtime`, тож інше значення зламає канал | `/api/v1/realtime` |
| `API_DOCS_ENABLED` | вмикає `/api/docs` і `/api/openapi.json` | увімкнено скрізь, крім `APP_ENV=production` |
| `METRICS_TOKEN` | bearer-токен для `/api/metrics`, щонайменше 16 символів | не задано — `/api/metrics` немає |
| `SHUTDOWN_DRAIN_DELAY_MS` | пауза після сигналу зупинки, перш ніж закрити слухач | `0` |
| `SHUTDOWN_GRACE_PERIOD_MS` | скільки чекати незавершені з'єднання | `10000` |
| `SHUTDOWN_TIMEOUT_MS` | після цього процес завершується примусово | `15000` |
| `INFRA_PROFILE` | `offline` — заглушки доставки й AI і кеш без Redis, хоч би що в інших змінних; `live` — кожна залежність вирішує сама | `live` |

### Бекенд: інтеграції

Без адреси кожна інтеграція працює на вбудованій заглушці.

| Змінна | Що означає | За замовчуванням |
|---|---|---|
| `DELIVERY_BASE_URL` | адреса служби доставки | не задано — заглушка |
| `DELIVERY_API_KEY` | ключ служби доставки | не задано |
| `DELIVERY_TIMEOUT_MS` | таймаут одного запиту | `5000` |
| `DELIVERY_MAX_ATTEMPTS` | спроб на запит | `3` |
| `DELIVERY_BASE_BACKOFF_MS`, `DELIVERY_MAX_BACKOFF_MS` | пауза між спробами: початкова й найбільша | `100`, `1000` |
| `DELIVERY_FAILURE_THRESHOLD` | збоїв поспіль, після яких circuit breaker розмикається | `5` |
| `DELIVERY_COOLDOWN_MS` | скільки розімкнений circuit breaker не пускає запити | `30000` |
| `DELIVERY_QUOTE_CACHE_TTL_SECONDS` | скільки кешується тариф доставки¹ | `60` |
| `AI_ENDPOINT_URL` | адреса AI-провайдера | не задано — офлайн-заглушка |
| `AI_API_KEY`, `AI_MODEL` | ключ і модель AI-провайдера | не задано |
| `AI_TIMEOUT_MS` | таймаут одного запиту | `10000` |
| `AI_MAX_ATTEMPTS` | спроб на запит | `2` |
| `AI_MAX_TOKENS` | найбільша довжина відповіді¹ | `400` |
| `AI_MAX_INPUT_CHARS` | найбільша довжина вхідного тексту¹ | `4000` |
| `AI_CACHE_TTL_SECONDS` | скільки кешується відповідь помічника¹ | `300` |
| `CALL_PROVIDER_BASE_URL` | адреса телефонії | не задано — заглушка |
| `CALL_PROVIDER_API_KEY` | ключ телефонії | не задано |
| `CALL_PROVIDER_TIMEOUT_MS` | таймаут одного запиту | `5000` |
| `CALL_PROVIDER_MAX_ATTEMPTS` | спроб на запит | `3` |
| `CALL_PROVIDER_BACKOFF_MS` | пауза між спробами | `200` |
| `CALL_SYNC_BATCH_SIZE` | найбільше дзвінків за одну синхронізацію | `100` |

¹ Змінна проходить перевірку на старті, але до сервісу модуля значення не
доходить: `createAiService()` і `createIntegrationsService()` у
`backend/src/composition-root.ts` створюються без нього й беруть вбудоване
значення, яке збігається з типовим.

Банківська виписка змінних не має: у коді є лише заглушка.

### Бекенд: наповнення й тести

Ці змінні читає не застосунок, а скрипти наповнення й раннер тестів.

| Змінна | Що означає | За замовчуванням |
|---|---|---|
| `SEED_USER_PASSWORD` | пароль облікових записів наповнення: від 12 символів, не `change-me` | немає, обов'язкова для наповнення |
| `SEED_ALLOW_PRODUCTION` | `true` дозволяє наповнення при `APP_ENV=production` | не задано — заборонено |
| `DATABASE_URL_TEST`, `REDIS_URL_TEST`, `MONGODB_URL_TEST` | явні адреси сховищ для інтеграційних тестів; назва тестової бази мусить містити окреме слово `test` або `testing` | збираються з тих самих частин, що й робочі, з суфіксом `_test` |
| `DEBUG_DB_TESTS` | будь-яке значення вмикає журнал SQL-запитів у тестовому клієнті бази | не задано |

### Веб-клієнт

Власного файла оточення клієнт не має. У production-збірку ці змінні
потрапляють під час `next build`, а не під час запуску:

| Змінна | Що означає | За замовчуванням |
|---|---|---|
| `API_ORIGIN` | куди сервер Next.js пересилає `/api` (`rewrites` у `frontend/next.config.mjs`) | `http://127.0.0.1:8000`; `local:web` ставить `API_PORT` |
| `NEXT_PUBLIC_API_URL` | базова адреса API для клієнта | `/api/v1` |
| `NEXT_PUBLIC_WS_URL` | адреса каналу подій; порожнє значення вимикає канал | `/api/v1/realtime` на origin сторінки |

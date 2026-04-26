# План: Интеграция Dota 2 replay-парсера + аудио-журнала + AI-коуча в GamerJournal

## Context

GamerJournal сейчас покрывает рефлексию **постфактум** (mental/physical state, decisions, wins,
trainings, sleep). Не хватает **объективного слоя** — что реально происходило в игре и что юзер
говорил/чувствовал в моменте. Цель: связать три уровня данных в один контекст для AI-коуча через
существующий MCP-канал:

- **Объективный (in-game)** — статы, события, тимфайты, networth/XP леды из реплеев Dota 2
- **Коммуникационный (in-the-moment)** — записи микрофона во время сессий, транскрибированные
- **Рефлексивный (postfactum)** — текущие sessions/decisions/wins

В соседнем проекте `/Users/resolut1on/ResoAI Lovable/resoai-dota-coach` уже **готово**: Go-парсер
на manta (5–15 сек/реплей, JSON ~300 KB), Electron desktop-клиент (`replay-uploader`) под Windows
с поиском Dota, GSI cfg installer, chokidar file-watcher, аплоадером. Это сильно упрощает план —
парсинг живёт на Windows-машине пользователя, на сервер уходит уже распарсенный JSON.

Авторизация для Claude уже работает через OAuth2 + PKCE (`/authorize`, `/.well-known/oauth-*`,
api_tokens table) — никакого второго механизма не нужно. Коуч-функционал = **новые MCP-tools**,
никаких отдельных чатов на сайте.

**Главное правило:** не ломать существующий журнал. Все новые сущности — additive, без изменений
поведения текущих sessions/decisions/trainings.

## Архитектурные решения (по ответам)

1. **Парсер `.dem` → JSON живёт в Windows Electron-клиенте.** Адаптируем существующий
   `resoai-dota-coach/tools/replay-uploader` (Electron 28 + chokidar 3.5.3 + bundled Go-binary).
   На сервер шлём только JSON через REST endpoint, авторизация через тот же `api_token`, что
   юзер уже создаёт в `/settings` для Claude. Никакого Go-binary в Vercel deploy.
2. **MVP = только реплеи** (Phases 1–4). Аудио и транскрипция — отдельный инкремент (Phases 5–6).
   GSI-автозапись — финал (Phase 7).
3. **Транскрипция через OpenAI Whisper API** ($0.006/мин, JSON с per-segment timestamps).
   Server-side в Vercel function, audio через Supabase Storage.
4. **Авто-старт записи через GSI** — да, но в Phase 7 после того как Electron-клиент уже стоит
   у юзера и MCP-коуч работает.

## Принципы дизайна

1. **Тонкий сервер, толстый клиент.** Парсинг и file-watching — на Windows-машине юзера.
   Vercel принимает уже-обработанный JSON и аудио. Это снимает 60-сек serverless timeout как
   проблему и убирает бинарь из deploy.
2. **Existing patterns first.** `games` повторяет паттерн `trainings` (UPSERT по
   `(user_id, source, source_id)`, source=`dota_client_v1`, source_id=`match_id`). Audio/transcripts
   повторяют паттерн integration sync routes.
3. **Decisions ↔ game = explicit FK с auto-suggest.** `decisions.game_id` nullable, в форме
   journal — dropdown «к какой игре относится» с авто-выбором ближайшей по timestamp. Не пытаемся
   делать time-window magic на уровне БД — это lie.
4. **MCP composability.** Не один тяжёлый `get_everything`, а composable tools: `get_games` (list),
   `get_game_detail` (full payload одного матча), `get_transcripts`. Claude сам решает что нужно.
5. **Privacy radical (Pennebaker).** Audio файлы хранятся в private Supabase Storage с RLS, никогда
   не share. Транскрипт можно удалить отдельно от audio.
6. **Защита от over-engineering.** В Phase 1 не пытаемся отрисовать «всё что есть в parser_output» —
   только summary + ключевые секции. Полный JSON сохранён в БД, отрисовка по требованию.

## Архитектура

### Слой 1: БД (одна миграция на MVP, плюс отдельная миграция для Phase 5)

**Миграция `add_games` (Phase 1):**

```sql
-- Игры (Dota 2 replays)
create table public.games (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'dota_client_v1',
  source_id text not null,                         -- match_id
  match_id bigint,                                 -- продублировано для удобства запросов
  game_date date not null,                         -- день начала матча (для фильтров по дате)
  started_at timestamptz not null,                 -- из parser_output.startDateTime
  ended_at timestamptz,                            -- started_at + duration_seconds
  duration_min smallint,
  hero text,                                       -- hero пользователя (если steam_account_id matched)
  hero_id smallint,
  is_radiant boolean,
  did_win boolean,
  kills smallint, deaths smallint, assists smallint,
  gpm smallint, xpm smallint, networth int,
  game_mode smallint,
  lobby_type smallint,
  parser_output jsonb not null,                    -- ВЕСЬ output от parser, для фронта on-demand
  parser_version text not null default 'unknown',
  metadata jsonb default '{}'::jsonb,              -- replay_path, file_size, parsed_at и т.п.
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique (user_id, source, source_id)
);
create index games_user_date_idx on public.games (user_id, game_date desc);
create index games_user_started_idx on public.games (user_id, started_at desc);
alter table public.games enable row level security;
create policy games_all on public.games for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create trigger games_updated_at before update on public.games
  for each row execute function public.set_updated_at();

-- Decisions ↔ game (явная связь, default null)
alter table public.decisions
  add column if not exists game_id uuid references public.games(id) on delete set null;
create index if not exists decisions_game_idx on public.decisions (game_id);

-- Профиль: steam account id для маппинга hero (юзер вводит вручную в /settings)
alter table public.profiles
  add column if not exists steam_account_id bigint;
```

**Storage buckets** (создаются через MCP Supabase, не SQL):
- `dota-replays` (private, RLS by user_id) — опциональный бэкап .dem от Electron-клиента (Phase 8)
- `voice-recordings` (private, RLS by user_id) — аудио из live sessions (Phase 5)

### Слой 2: Конфигурация для Electron-клиента (Windows)

В `/settings` в GamerJournal у юзера уже есть API-токены (`gj_<base64>`). Electron-клиент
авторизуется тем же токеном:
- Юзер вставляет токен в desktop-клиент один раз
- Каждый upload идёт с `Authorization: Bearer gj_...`
- `authenticateApiToken` в `/api/games/upload` — тот же helper, что для MCP

Никаких отдельных API-ключей, никакой второй системы. Это = «не через api, а через auth» —
один токен на и Claude/MCP, и desktop-клиент.

### Слой 3: API endpoints

**POST `/api/games/upload`** (Phase 1):
- Auth: bearer api_token
- Body: `{ match_id, parser_output (full JSON), parser_version, metadata? }`
- Логика:
  1. Извлечь summary fields (game_date, started_at, ended_at, duration_min, hero для user)
  2. Найти юзерского игрока в parser_output.players (по `profiles.steam_account_id`;
     если не задан или не нашли — kills/deaths/hero=null, **не падать**, вернуть warning в response)
  3. UPSERT в `games` по `(user_id, source, source_id)` через onConflict
  4. Возврат `{ ok: true, game_id, was_update, warnings? }`
- Лимит размера: parser_output ~300 KB; ставим body limit 5 MB на роуте
- Логирование ошибок friendly (try/catch, never stack trace)

**GET `/api/v1/games`** (Phase 3):
- v1Handler pattern (как у sessions): список с date range, summary fields only
- `?include=detail` — возвращает parser_output (тяжёлое)

**GET `/api/v1/games/:id`** (Phase 3):
- Полный объект с linked decisions

### Слой 4: UI (Next.js страницы)

- **`/games`** (Phase 1) — server component: список матчей с группировкой по неделям, summary cards
  (hero, KDA, длительность, win/loss, ссылка на /games/[id]). Фильтры: date range, win/loss, hero.
  Нет UI для upload — это работа Electron-клиента; вместо этого в `/settings` секция «Установить
  replay-uploader» со ссылкой и инструкцией.
- **`/games/[id]`** (Phase 1) — детальная страница:
  - GameHeader (hero, KDA, длительность, дата, win/loss badge)
  - GameSummary (GPM/XPM, networth, последние items)
  - GameTimeline (Phase 1: топ событий — kills/deaths timeline, teamfights, key item buys —
    отрисовываем подмножество parser_output, а не всё; Phase 8 — расширение)
  - LinkedDecisions (decisions с этой game_id; Phase 2)
  - LinkedTranscript (когда есть аудио; Phase 5–6)
  - RawDataAccordion (collapsed, full JSON для debug)
- **`/journal`** (Phase 2 правка) — в decisions-блоке dropdown «К какой игре?» с auto-suggest:
  ближайшая по started_at игра в пределах ±6 часов от session_date.
- **`/settings`** (Phase 1 правка) — секция «Replay Uploader (Windows)»:
  - Ссылка на установщик (Electron .exe в GitHub release)
  - Кнопка «Создать токен для replay-uploader» (переиспользуем существующий token-create flow)
  - Поле для steam_account_id с инструкцией (где найти на Steam)
  - Краткая инструкция: куда вставить токен, где Dota 2 replays папка
- **Nav** — добавить «Игры» в `src/app/layout.tsx` после «История»

### Слой 5: Electron desktop-клиент (Phase 4)

Адаптируем `/Users/resolut1on/ResoAI Lovable/resoai-dota-coach/tools/replay-uploader`:

**Что меняем:**
- Endpoint: вместо `https://api.resoai.com/replays/upload` → конфигурируемый
  `GAMERJOURNAL_API_URL` (default: production Vercel URL)
- Auth: вместо своего ключа → bearer `gj_*` token (вставляется в settings UI Electron-app)
- Upload payload: вместо raw .dem (multipart) → JSON с уже-распарсенным parser_output
- Парсер: bundled Go-binary `parser.exe` (Linux/Mac/Windows builds в release)

**Что переиспользуем без изменений:**
- `dota-integration.js` — поиск Dota 2, GSI cfg installer
- `file-watcher.js` — chokidar для папки replays
- `gsi-server.js` — для Phase 7 (auto-record)

**Дистрибуция:**
- Сборка Electron под Windows (electron-builder), Code-signing если есть сертификат
- GitHub release в новом репо `Resolut1onEDL/gamerjournal-replay-uploader` (отдельный репо чтобы
  не мешать Vercel-deploy GamerJournal)
- Auto-update через electron-updater позже (Phase 8)

**Тестирование на macOS dev:**
- В `tools/replay-parser/test-replays/` есть 4 готовых .dem с reference JSON
  (8582691771, 8591372106, 8591453147, 8692703463)
- Локально: `node scripts/test-upload.js path/to/8582691771_parsed.json` — отправляет существующий
  JSON на dev API, без необходимости запуска Electron (полезно для Phase 1 verification)

### Слой 6: MCP коуч (Phase 3)

Расширяем `src/app/api/mcp/route.ts`:

**Новые tools:**
- `get_games` — список игр за период с summary fields. Args: `from`, `to`, `did_win?`, `hero?`.
- `get_game_detail` — один матч с полным parser_output + linked decisions. Args: `game_id` или
  `match_id`.

**Расширения существующих tools:**
- `get_sessions` — в каждом decision добавить `game_id` (nullable)
- `get_summary` — добавить блок `games` (count, win_rate, top_heroes, avg_kda)

**Documentation для Claude (в tool descriptions):**
- Явно объяснить use case коуча: «Use `get_game_detail` when user asks about a specific match.
  Cross-reference with `get_sessions` decisions on same date for postgame reflection context.»

### Слой 7: Live sessions + Аудио (Phase 5)

**Миграция `add_live_sessions`:**

```sql
create type live_session_kind as enum ('dota','training','focus','other');
create table public.live_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind live_session_kind not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  audio_storage_path text,                      -- voice-recordings/<user>/<id>.webm
  audio_duration_sec int,
  audio_size_bytes int,
  transcript_text text,
  transcript_segments jsonb,                    -- [{start,end,text}]
  transcript_language text,
  transcript_status text default 'pending',     -- pending|done|failed|skipped
  transcript_error text,
  game_id uuid references public.games(id) on delete set null,
  training_id uuid references public.trainings(id) on delete set null,
  notes text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
create index live_sessions_user_started_idx on public.live_sessions (user_id, started_at desc);
alter table public.live_sessions enable row level security;
create policy live_sessions_all on public.live_sessions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create trigger live_sessions_updated_at before update on public.live_sessions
  for each row execute function public.set_updated_at();
```

**Web UI (Phase 5):**
- Sticky-bar `RecordingControl` в shared layout (виден на /journal, /games, /trainings):
  - Состояния: idle / recording / processing
  - Кнопка «Начать сессию» → диалог выбора kind (dota/training/focus) + permission prompt
  - Indicator «🔴 Recording 12:34» во время записи
  - Кнопка «Закончить» → upload audio в Supabase Storage → создать live_session row
- MediaRecorder API: codec `audio/webm;codecs=opus`, chunks по 30 сек (для recovery если
  крэшнется вкладка), final upload через server action или direct Supabase Storage upload
- Persist state в localStorage (started_at, kind) — выживание перезагрузки страницы

**Server action `saveLiveSession`** — создаёт row + триггерит транскрипцию в фоне.

### Слой 8: Транскрипция (Phase 6)

**POST `/api/transcripts/transcribe`:**
- Auth: server-side (cron-like) или admin-only — НЕ публичный
- Триггеры: вручную из UI (retry button) или авто после upload audio
- Логика:
  1. Скачать audio из Supabase Storage
  2. POST в OpenAI Whisper API (`/v1/audio/transcriptions`, model `whisper-1`,
     `response_format=verbose_json` для timestamps, `language=ru`)
  3. Сохранить `transcript_text`, `transcript_segments`, `transcript_language`,
     `transcript_status='done'`
  4. При ошибке — `transcript_status='failed'`, `transcript_error=<message>`
- ENV: `OPENAI_API_KEY` (новая переменная, добавить в `.env.example`)
- Лимит Whisper API: file ≤ 25 MB. Если больше → разбивать (см. Open Question #3)

**MCP `get_transcripts`** — list по period, фильтр по kind/game_id.

### Слой 9: GSI auto-record (Phase 7)

В Electron-клиенте поверх Phase 4 + Phase 5:
- GSI server (уже есть в `gsi-server.js`) принимает Dota state events
- Event `match started` → IPC в main process → start audio recording через Electron native API
  (микрофон через `getUserMedia({audio:true})`, не зависит от веб-вкладки)
- Event `match ended` → stop, upload .webm через bearer-token на наш `/api/audio/upload`
- Auto-link: ждём 5–10 мин, чтобы парсер обработал .dem с тем же match_id, потом PATCH
  `/api/live-sessions/:id` с `game_id` найденного game

## Каталог фаз (8 фаз, инкрементальная польза)

### Фаза 1 — Schema + games view (без аудио, без клиента)

**Цель:** на сервере есть таблица games, можно загрузить тестовый JSON через curl, посмотреть
матч на /games/[id]. Decisions ↔ game пока не связаны.

**Файлы:**
- Миграция `add_games` через `mcp__supabase__apply_migration`
- `src/lib/types.ts` — добавить `Game` type
- `src/lib/games.ts` — pure helpers: `extractGameSummary(parserOutput, userSteamId)`,
  `findUserPlayer(parserOutput, steamId)`. Pure функции, unit-testable.
- `src/app/api/games/upload/route.ts` — POST endpoint с auth + UPSERT
- `src/app/games/page.tsx` — server component: список с группировкой по неделям
- `src/app/games/[id]/page.tsx` — server component: детали
- `src/components/{GameSummaryCard,GameHeader,GameTimeline,GameRawData}.tsx`
- `src/app/layout.tsx` — добавить пункт «Игры» в nav
- `src/components/SettingsForm.tsx` — поле для steam_account_id

**Verification:**
- `curl -X POST $URL/api/games/upload -H "Authorization: Bearer $TOKEN" -d @8582691771_parsed.json`
  → 200 OK, в БД появился row
- `/games` показывает матч в списке
- `/games/<uuid>` рендерит summary, KDA, базовый timeline
- `npm run build` без TS-ошибок

### Фаза 2 — Decisions ↔ game

**Цель:** в /journal каждое decision можно привязать к конкретной игре, на /games/[id] видно
linked decisions.

**Файлы:**
- `src/components/SessionFormModular.tsx` — в блоке decision добавить `<select>` с играми за
  текущий день (auto-suggest: ближайшая по started_at)
- `src/app/journal/actions.ts` — `saveSession` принимает `game_id` для каждого decision
- `src/app/journal/page.tsx` — подгружать игры дня
- `src/lib/api-v1.ts` — `loadSessions` возвращает decisions с `game_id`
- `src/app/games/[id]/page.tsx` — добавить секцию `<LinkedDecisions decisions={...} />`
- `src/components/LinkedDecisions.tsx` — список decisions с phase/rating/situation

**Verification:**
- Открыть /journal на дату с games в БД → dropdown заполнен
- Сохранить decision с game_id → на /games/[id] эта decision показывается

### Фаза 3 — MCP-tools для коуча

**Цель:** Claude через MCP может запросить игры и связать с рефлексией.

**Файлы:**
- `src/lib/api-v1.ts` — `loadGames(ctx, filters?)`, `loadGameDetail(ctx, id)`. Расширить
  `loadSummary` блоком `games`.
- `src/app/api/mcp/route.ts` — добавить tools `get_games`, `get_game_detail`. Расширить
  description `get_sessions` про `game_id` в decisions. Расширить `get_summary` про блок games.
- `src/app/api/v1/games/route.ts`, `src/app/api/v1/games/[id]/route.ts` — REST для симметрии

**Verification:**
- В Claude.ai (с подключённым MCP gamer-journal): «Покажи мою последнюю игру» → вызов
  `get_games` → `get_game_detail` → ответ с KDA + linked decisions
- `curl /api/v1/games` возвращает массив

### Фаза 4 — Windows Electron-клиент

**Цель:** юзер ставит .exe на Windows, вставляет API-токен, клиент сам watchит папку replays
и шлёт парсённый JSON.

**Файлы (новый репо `Resolut1onEDL/gamerjournal-replay-uploader`):**
- Форк `resoai-dota-coach/tools/replay-uploader` как стартовая точка
- `src/uploader.js` — заменить endpoint и auth на наши
- `src/parser-runner.js` — wrap `parser.exe` через child_process, вернуть JSON
- `src/settings-ui.js` — UI для вставки токена и выбора папки replays
- `electron-builder.yml` — Windows build config
- `bin/parser.exe` — bundled Go-binary (собран из resoai-dota-coach/tools/replay-parser)
- README с инструкцией установки

**В GamerJournal:**
- `src/components/SettingsForm.tsx` — секция «Replay Uploader» с download link и инструкцией
- `.env.example` — задокументировать что endpoint ожидает

**Verification:**
- На Windows-машине: установить .exe, вставить токен, играть катку → через 5–10 мин после конца
  матча replay появляется в /games

### Фаза 5 — Live sessions + browser audio

**Цель:** в web-UI можно записать аудио для текущей сессии (тренировки/игры/фокуса).

**Файлы:**
- Миграция `add_live_sessions`
- Storage bucket `voice-recordings` (private, RLS by user)
- `src/lib/types.ts` — `LiveSession` type
- `src/components/RecordingControl.tsx` — sticky bar + MediaRecorder hook
- `src/lib/use-recorder.ts` — wrapper hook over MediaRecorder + localStorage persist
- `src/app/journal/actions.ts` — `saveLiveSession(input, audioBlob)` action: upload в Storage,
  insert row, return id
- `src/app/layout.tsx` — встроить `<RecordingControl />` (только для авторизованных)
- `src/app/sessions/[id]/page.tsx` — страница live session с audio player и местом для
  транскрипта (placeholder в этой фазе)

**Verification:**
- Нажать «Начать сессию» → permission prompt → recording → «Закончить» → row появилась с
  `audio_storage_path` и `transcript_status='pending'`
- Аудио проигрывается на странице

### Фаза 6 — Whisper-транскрипция

**Цель:** транскрипт автоматически появляется после конца записи.

**Файлы:**
- `src/app/api/transcripts/transcribe/route.ts` — POST с `live_session_id`, скачивает аудио,
  шлёт Whisper, обновляет row
- `src/app/journal/actions.ts` — `saveLiveSession` после успешного upload триггерит
  `fetch /api/transcripts/transcribe` (fire-and-forget) или server-side в том же handler
- `src/components/TranscriptView.tsx` — рендер transcript_text + segments (с кликабельными
  timestamps если есть audio player)
- `src/app/api/mcp/route.ts` — добавить tool `get_transcripts`
- `src/lib/api-v1.ts` — `loadTranscripts(ctx, filters?)`
- `.env.example` — `OPENAI_API_KEY`
- В UI live session — показать transcript когда `status='done'`, кнопка «Retry» если `failed`

**Verification:**
- Записать 30-сек тестовое аудио → через ~30 сек appears транскрипт
- В Claude через MCP: «Что я говорил вчера в записях?» → `get_transcripts` → ответ

### Фаза 7 — GSI auto-record

**Цель:** на Windows в момент старта Dota-игры автоматически начинается запись микрофона,
по концу — стопается, аплоадится, линкуется к game.

**Файлы (в Electron-репо):**
- `src/gsi-handler.js` — слушает события `match started/ended` от GSI
- `src/audio-recorder.js` — Electron-native запись через `getUserMedia({audio: true})`
- `src/auto-link.js` — после конца матча через 10 мин ищет game с тем же match_id, делает
  PATCH `/api/live-sessions/:id` с game_id

**В GamerJournal:**
- `src/app/api/live-sessions/[id]/link/route.ts` — PATCH endpoint с auth, обновляет game_id
- `src/app/api/audio/upload/route.ts` — POST endpoint для Electron-клиента (bearer auth,
  multipart, сохраняет в Storage + создаёт live_session row)

**Verification:**
- На Windows: запустить Dota → сыграть катку → закончить → live_session созадётся автоматически,
  через 10 мин linked к game

### Фаза 8 — Polish: correlation UX + coach docs

**Цель:** пользовательский UX склеить, документация для коуча.

**Файлы:**
- `src/app/games/[id]/page.tsx` — расширенный timeline с overlay decisions + transcript snippets
- `src/app/trends/page.tsx` — новые charts: win rate by hero, decision rating by hero, audio
  frequency
- `docs/coach-guide.md` (markdown в репо) — как настроить Claude.ai с MCP, какие промпты работают,
  примеры разборов
- `src/app/api/mcp/route.ts` — tool descriptions подкручены под coaching use cases (примеры в каждом)

## Критические файлы (по фазам)

**Phase 1:**
- `src/lib/types.ts` (extend)
- `src/lib/games.ts` (new)
- `src/app/api/games/upload/route.ts` (new)
- `src/app/games/page.tsx`, `src/app/games/[id]/page.tsx` (new)
- `src/components/{GameSummaryCard,GameHeader,GameTimeline,GameRawData}.tsx` (new)
- `src/app/layout.tsx` (extend nav)
- `src/components/SettingsForm.tsx` (steam_account_id field)

**Phase 2:**
- `src/components/SessionFormModular.tsx` (extend decisions block)
- `src/app/journal/actions.ts` (extend saveSession)
- `src/app/journal/page.tsx` (load games for date)
- `src/lib/api-v1.ts` (extend loadSessions)
- `src/components/LinkedDecisions.tsx` (new)

**Phase 3:**
- `src/lib/api-v1.ts` (loadGames, loadGameDetail)
- `src/app/api/mcp/route.ts` (new tools, extended descriptions)
- `src/app/api/v1/games/{route.ts,[id]/route.ts}` (new)

**Phase 4 (отдельный репо + правки в GJ):**
- Новый репо `Resolut1onEDL/gamerjournal-replay-uploader` (форк от resoai-dota-coach)
- `src/components/SettingsForm.tsx` (секция «Replay Uploader»)

**Phase 5:**
- Миграция `add_live_sessions`
- `src/lib/use-recorder.ts`, `src/components/RecordingControl.tsx` (new)
- `src/app/journal/actions.ts` (saveLiveSession)

**Phase 6:**
- `src/app/api/transcripts/transcribe/route.ts` (new)
- `src/components/TranscriptView.tsx` (new)
- `src/app/api/mcp/route.ts` (extend with get_transcripts)

**Phase 7:** Electron-репо + `src/app/api/live-sessions/[id]/link/route.ts`,
`src/app/api/audio/upload/route.ts`

**Phase 8:** правки `src/app/{games/[id],trends}/page.tsx`, новый `docs/coach-guide.md`

## Anti-риски

1. **Don't sync raw .dem to Vercel.** Файлы 50–100 MB через web upload — медленно, дорого,
   лимит size. Парсинг **строго** в Electron-клиенте, на сервер — только JSON. Если в Phase 1
   нужен dev-test без клиента — кладём готовые `_parsed.json` из `test-replays/` через curl,
   не реальные `.dem`.
2. **Schema bloat от parser_output.** parser_output 200–500 KB jsonb на запись. 1000 матчей =
   500 MB в БД. Пока окей (Supabase free tier до 500 MB; Pro 8 GB), но в Phase 8 добавить
   archive policy: parser_output старше 1 года → переносить в Storage как .json.gz.
3. **Hero matching ненадёжен.** Если у юзера steam_account_id не вшит в profiles — парсер не
   найдёт его игрока. Решение: в Phase 1 при первом upload — diagnostic warning в response,
   юзер вставляет steam_account_id в /settings вручную. Не падать, kills/deaths=null OK.
4. **Browser MediaRecorder теряет запись при закрытии вкладки.** Mitigation в Phase 5: chunks
   по 30 сек, persist state в localStorage. В Phase 7 — Electron берёт надёжный native flow.
5. **Whisper API key — secret, никогда не в client bundle.** Только server-side в
   `/api/transcripts/transcribe`. ENV не префиксован `NEXT_PUBLIC_`.
6. **Electron auto-update — не в MVP Phase 4.** Сначала ручная установка .exe, observability
   через manual report. Auto-update в Phase 8.
7. **Не делать /coach chat на сайте.** User явно сказал «через auth, не через api» — то есть
   через MCP в Claude.ai. Свой чат — отдельный API-key flow и второй мозг для развития.
   Не делаем без явного запроса.

## Verification (end-to-end после каждой фазы)

**Phase 1:** `curl POST /api/games/upload` с тестовым JSON → /games показывает → /games/[id]
рендерит → `npm run build` зелёный.

**Phase 2:** на /journal появляется dropdown «Игра», save → на /games/[id] виден linked decision.

**Phase 3:** в Claude (MCP-подключённом): «get_games за неделю» → массив; «get_game_detail
match=8582691771» → JSON; «get_sessions» → decisions с game_id.

**Phase 4:** на Windows-машине поставить .exe, вставить токен, сыграть тестовую игру → реплей
загружен через 5–10 мин без ручного действия.

**Phase 5:** на /journal записать 30-сек аудио → live_session row, audio в Storage, audio
проигрывается.

**Phase 6:** транскрипт `'done'` за <1 мин для 30-сек записи; в Claude `get_transcripts` отдаёт
текст.

**Phase 7:** на Windows запустить Dota → live_session созадётся автоматически по GSI; через
10 мин linked к game.

**Phase 8:** на /games/[id] timeline с decisions + transcript; /trends показывает win rate by
hero; coach-guide.md в репо.

## Открытые вопросы (для решения по ходу)

1. **steam_account_id в profiles.** В Phase 1 — диагностический warning. В Phase 4 — Electron
   может его detect (профиль Steam в реестре Windows) и предложить вставить.
2. **Replay backup в Storage.** Опционально в Phase 4: помимо JSON, сохранять оригинальный .dem
   в Storage. Pro: можно перепарсить с новой версией parser. Con: 50–100 MB × N матчей.
   Решение по требованию — в Phase 4 не делаем, добавим в Phase 8 если parser_version эволюционирует.
3. **Voice recording duration limit.** Whisper API лимит file size 25 MB (~25 мин Opus). Длинные
   игры (45–60 мин) → разбивать на chunks. Решение в Phase 6: если file > 20 MB → делить
   server-side (ffmpeg.wasm) или клиентом отправлять отдельные chunks.

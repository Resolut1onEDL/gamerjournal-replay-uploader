# GamerJournal Replay Uploader

Десктоп-агент для Windows/macOS/Linux, который:

1. Следит за папкой реплеев Dota 2 (chokidar).
2. Парсит свежий `.dem` локально через bundled Go-бинарник
   (dotabuff/manta, скомпилен из
   [`resoai-dota-coach/tools/replay-parser`](https://github.com/Resolut1onEDL/resoai-dota-coach/tree/main/tools/replay-parser)).
3. Отправляет получившийся JSON (~250 KB) на твой
   [GamerJournal](https://github.com/Resolut1onEDL/gamer-journal) — `/api/games/upload`.
4. Слушает Dota 2 GSI на `127.0.0.1:3000` (под Phase 7 — авто-запись микрофона
   во время игры).

Сервер никогда не работает с raw `.dem` (50–100 MB) — только с готовым JSON.
Это снимает serverless timeout как проблему и убирает 26 MB Go-бинарь из Vercel
deploy. Ровно та же `gj_*` API-токен авторизация, что и для Claude через MCP —
один токен на всё.

---

## Установка (Windows)

1. Скачай последний `.exe` из
   [Releases](https://github.com/Resolut1onEDL/gamerjournal-replay-uploader/releases)
   (собирается через GitHub Actions).
2. Запусти инсталлер. Приложение поселится в трее.
3. Открой окно (двойной клик по иконке в трее) и заполни:
   - **API URL**: твой GamerJournal (например `https://gamer-journal.vercel.app`).
   - **API Token**: создаётся в `Настройки → API tokens` твоего GamerJournal
     (формат `gj_...`).
   - **Папка Dota 2**: автоопределяется на типичных путях
     (`C:\Program Files (x86)\Steam\...\dota 2 beta`); если не нашлось — выбери
     вручную.
4. Нажми **Поставить GSI** — это положит `gamestate_integration_gamerjournal.cfg`
   в папку Dota, нужно для Phase 7 (auto-record).
5. **Тест соединения** — должно выдать «Соединение ОК».

После этого: каждая новая катка → через 5–10 минут (после того как Dota
скачает реплей) парсер прогоняет файл и аплоадит JSON. Видно в `/games`.

---

## CLI-режим (для разработки на macOS/Linux)

Если нет Windows-машины, можно прогнать загрузку через CLI без Electron:

```bash
GJ_API_TOKEN=gj_... GJ_API_URL=https://gamer-journal.vercel.app \
  node scripts/cli-test.js path/to/replay.dem
```

Или с уже-распарсенным JSON (например из
[`resoai-dota-coach/tools/replay-parser/test-replays/`](https://github.com/Resolut1onEDL/resoai-dota-coach/tree/main/tools/replay-parser/test-replays)):

```bash
GJ_API_TOKEN=gj_... node scripts/cli-test.js .../8582691771_parsed.json
```

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│ Windows machine (или mac/linux)                             │
│                                                              │
│  Dota 2 ──┬─ replays/<match_id>.dem  ──┐                    │
│            │                            │ chokidar           │
│            └─ GSI cfg ──> port 3000 ──┐ │                    │
│                                        │ ▼                    │
│                       gsi-server ◀─── main.js (Electron)     │
│                                        │ │                    │
│                                        │ ▼                    │
│                       parser-runner ──> bin/parser-<os>      │
│                                        │ (Go binary, manta)   │
│                                        ▼                      │
│                              uploader.js                      │
│                                        │                      │
└────────────────────────────────────────┼──────────────────────┘
                                          │ POST /api/games/upload
                                          │ Authorization: Bearer gj_*
                                          ▼
                       ┌──────────────────────────────────┐
                       │ GamerJournal (Vercel + Supabase) │
                       │                                  │
                       │ /games + /games/[id]             │
                       │ MCP get_games / get_game_detail  │
                       └──────────────────────────────────┘
```

---

## Сборка локально

Требуется Node 20+. Парсер уже лежит в `bin/parser-{darwin-arm64,linux-amd64,windows-amd64}.exe`
(скомпилен из Go-исходника, см. ниже).

```bash
npm install
npm run dev          # запуск Electron-приложения в dev-режиме
npm run build:win    # сборка Windows .exe (требует windows-runner или wine)
npm run build:mac    # сборка macOS .dmg
```

Релизы делаются автоматически через GitHub Actions при пуше тега `v*`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

---

## Пересборка парсера

Бинарь в `bin/` — это компиляция
`resoai-dota-coach/tools/replay-parser/main.go` под три платформы. Если нужно
обновить (новая версия manta или ручные правки):

```bash
cd resoai-dota-coach/tools/replay-parser
GOOS=darwin  GOARCH=arm64 go build -o parser-darwin-arm64       main.go
GOOS=linux   GOARCH=amd64 go build -o parser-linux-amd64        main.go
GOOS=windows GOARCH=amd64 go build -o parser-windows-amd64.exe  main.go
cp parser-* path/to/gamerjournal-replay-uploader/bin/
```

Размер каждого бинарника ~26 MB (статически слинкован, нет внешних зависимостей).
GitHub принимает ≤ 100 MB на файл, так что коммит трёх билдов в git — ок.

---

## Лицензия

MIT

# Agent Handoff (Mac → Windows)

> Этот документ нужен, чтобы Claude Code на Windows-машине продолжил работу
> над проектом GamerJournal с того места, где остановилась mac-сессия.
>
> **На Windows запусти Claude Code и скажи:**
> «Прочитай `AGENT-HANDOFF.md` и `AGENT-PLAN.md` в этом репо, затем продолжай
> Phase 4 verification на Windows.»

## Текущая дата

2026-04-26.

## Контекст

Идёт работа по плану из `AGENT-PLAN.md` — интеграция парсера Dota 2 реплеев,
аудио-журнала с микрофоном, и AI-коуча через MCP в существующий проект
`GamerJournal` (https://github.com/Resolut1onEDL/gamer-journal).

План: 8 фаз, инкрементальный value.

## Состояние фаз

| Фаза | Статус | Что сделано |
|------|--------|-------------|
| Phase 1 | ✅ done | Schema `games` + `decisions.game_id` + `profiles.steam_account_id`, `POST /api/games/upload` (bearer auth), pages `/games` + `/games/[id]`, components `GameHeader`/`GameSummaryCard`/`GameTimeline`/`GameRawData`, поле steam_account_id в SettingsForm, nav-пункт «Игры». E2E прошёл curl-тестом. |
| Phase 2 | ✅ done | `Decision.game_id` (FK nullable), `GameLite` type, dropdown «К какой игре?» в `DecisionsBlock` с auto-suggest (одна → она; несколько → самая свежая), `LinkedDecisions` компонент на `/games/[id]`, action `saveSession` сохраняет game_id. |
| Phase 3 | ✅ done | MCP tools `get_games` (filters did_win/hero) + `get_game_detail` (by uuid OR match_id), `get_summary` расширен games-блоком (count/wins/losses/win_rate/top_heroes), `get_sessions` description упоминает game_id, REST `/api/v1/games` + `/api/v1/games/[id]`. E2E через curl и MCP JSON-RPC прошёл. |
| Phase 4a (mac) | ✅ done | Создан репо `Resolut1onEDL/gamerjournal-replay-uploader`. Electron 28 + chokidar + bundled Go binary (manta). CLI smoke-test на mac прошёл (parse 7.8s, upload 1.7s). CI/CD GitHub Actions собирает Windows .exe. **Release v0.1.0 опубликован**. SettingsForm в GamerJournal обновлён со ссылкой на release. |
| **Phase 4b (Windows)** | ⏳ **в процессе — это твоя текущая задача** | Установить .exe на Windows, проверить end-to-end: парс реальной катки → запись в `/games`. |
| Phase 5 | pending | Live sessions + browser audio (миграция, Storage bucket, RecordingControl, MediaRecorder hook). |
| Phase 6 | pending | OpenAI Whisper transcription, MCP `get_transcripts`. |
| Phase 7 | pending | GSI auto-record в Electron (микрофон по match start/end). |
| Phase 8 | pending | Polish: timeline overlay decisions+transcript, charts, coach-guide.md. |

## Известные issues (для контекста)

1. **steam_account_id precision loss.** Go-парсер выдаёт `steamAccountId` как
   64-bit int (например `76561198046990903`), но при `JSON.parse` в Node.js
   теряются последние 3 цифры (становится `76561198046990900`, потому что
   Number.MAX_SAFE_INTEGER ≈ 9e15, а Steam64 ≈ 7.6e16). Это поломает
   hero-matching в `findUserPlayer` если юзер ввёл точный 64-bit ID.
   **Workaround в Phase 4b**: ввести *короткий* 32-bit Steam Account ID
   (последние 7-9 цифр; найти на steamid.io в поле «steamID3»). Тогда
   matching сработает, потому что вычитание неточного long из known offset
   даёт примерно правильный short.
   **Правильный fix (когда-то потом)**: пропатчить Go-парсер выдавать
   `steamAccountId` как короткий 32-bit (общепринятая практика Dota 2).

## Что должна сделать Windows-сессия (Phase 4b)

### Цель
Доказать что Electron-клиент работает end-to-end на Windows: установка → токен →
auto-watch папки → парсер → upload → запись появилась в `/games`.

### Шаги

1. **Скачать установщик**
   - URL: https://github.com/Resolut1onEDL/gamerjournal-replay-uploader/releases/latest
   - Файл: `GamerJournal Replay Uploader Setup 0.1.0.exe` (~80 MB)

2. **Установить**
   - SmartScreen может предупредить (бинарь не подписан) — «Подробнее» →
     «Выполнить в любом случае»
   - NSIS-установщик с выбором папки
   - После — иконка в трее

3. **Открыть и сконфигурировать**
   - Двойной клик по иконке в трее → окно
   - **API URL**: `https://gamer-journal.vercel.app` (или текущий продакшн URL —
     уточни у пользователя если другой)
   - **API Token**: попроси пользователя зайти в `gamer-journal.vercel.app/settings`,
     создать новый токен в секции «API tokens», скопировать `gj_*` значение и
     вставить в клиент. **Не сохраняй токен в коде/файлах.**
   - **Папка Dota 2**: должна автодетектиться. Если нет — выбрать вручную
     (типичный путь `C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta`)
   - **Steam Account ID** (в gamer-journal.vercel.app/settings) — попроси
     пользователя ввести короткий 32-bit ID (см. issue #1 выше про precision)

4. **Smoke tests**
   - Кнопка **«Тест соединения»** → ожидаем «Соединение ОК»
   - Кнопка **«Поставить GSI»** → ожидаем «GSI установлен ✓»
     (это создаст файл `<dota>/game/dota/cfg/gamestate_integration/gamestate_integration_gamerjournal.cfg`)

5. **Real game test**
   - Попроси пользователя сыграть катку (любого формата, можно AI bot match для
     скорости — закончится за 15-25 мин)
   - После завершения матча Dota скачивает реплей за ~5-10 мин
   - В логе клиента должны появиться строки:
     ```
     info Parsing 1234567890.dem
     info Parsed match_id=1234567890; uploading...
     info Uploaded match_id=1234567890 → game_id=...
     ```
   - В браузере открыть `gamer-journal.vercel.app/games` → новая запись
     должна быть в списке. Открыть детальную → проверить что hero, KDA, и т.д.
     заполнены.

### Возможные проблемы и fixes

| Проблема | Решение |
|----------|---------|
| Установщик не запускается, SmartScreen блокирует жёстко | Правый клик → «Свойства» → внизу «Разблокировать», или временно отключить SmartScreen |
| Парсер не находит бинарь | Проверь что в `<install>/resources/parser.exe` файл есть. Если нет — бага в `extraResources` config, см. `package.json` блок `win.extraResources`. Можешь руками положить `bin/parser-win-x64.exe` из репо туда. |
| 401 Invalid token | Токен неверный или удалён. Создай новый в `/settings`. |
| 401 missing Authorization | Токен пустой в клиенте. Перепроверь что сохранил. |
| Парсер молча падает | Спавн логи stderr. Возможно файл .dem заблокирован Dota (запиши после полного скачивания). chokidar ждёт `awaitWriteFinish: 5s`. |
| hero/KDA = null в записи | `steam_account_id` не задан в /settings или wrong формат. См. issue #1 выше. |
| Запись не появляется в /games | Проверь supabase MCP: `select * from public.games order by created_at desc limit 5;` — есть ли row? Если есть — bug в UI, если нет — bug в upload. |

### Если всё прошло гладко

Можно двигаться в **Phase 5** (live sessions + browser audio recording).
Все детали в `AGENT-PLAN.md` секция «Фаза 5».

## Где код

- **Основной проект (Next.js, Vercel)**: https://github.com/Resolut1onEDL/gamer-journal
  - На Windows можно склонить: `git clone https://github.com/Resolut1onEDL/gamer-journal C:\dev\gamer-journal`
  - Если planируешь редактировать его на Windows — ставь Node 20+, запускай `npm install` и `npx next dev` для локальной проверки
- **Этот репо (Electron-клиент)**: https://github.com/Resolut1onEDL/gamerjournal-replay-uploader
- **Supabase project ID**: `equvoiiaothyslhapwqi` — для MCP `mcp__supabase__*` команд
- **Production URL**: `https://gamer-journal.vercel.app` (уточни у пользователя если он сменил домен)

## Принципы работы (важно)

Из `~/.claude/CLAUDE.md` пользователя (применимо везде):

1. **Общайся по-русски.** Код/комменты/коммиты — на английском.
2. **Минимальный diff.** Не переписываем рабочее, патчим в месте.
3. **Никаких хардкодов динамических данных** (Steam ID, токены, и т.п. — спрашиваем юзера).
4. **Bugfix = regression test.** Новых багов не плодим.
5. **Ничего не коммитим без явного запроса юзера.**
6. **Push на main GamerJournal — только через explicit approval.** Деплой
   на Vercel автоматический через GitHub integration (или ручной через CLI).
7. **Для мерджа в gamerjournal-replay-uploader main и тегирования** — спрашивай
   юзера явно. Каждый push tag'a `v*` запускает CI и публикует release.

## Cleanup convention

Когда делаешь E2E тесты в БД:
- Используй временные `match_id` < 1000 или явный `source = 'phase4b_test'`
- После теста удаляй: `delete from games where source = 'phase4b_test'`
- Если создавал api-токен напрямую через SQL для теста — удаляй после
  (есть в логах prefix, легко найти)

---

Удачи. Пиши в чат если что-то непонятно — пользователь рядом.

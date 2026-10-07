# Полка — плагин для Claude Code и Codex

Плагин [Полки](https://polochka.app): подключает удалённый MCP-сервер `https://polochka.app/mcp` (вход через OAuth в браузере, токен не нужен) и ставит скиллы Полки. Агент сохраняет страницы, отчёты и прототипы на вашу полку и даёт ссылку, которую открывают без аккаунта.

**Claude Code**

```
claude plugin marketplace add artkruglov/polka-plugin && claude plugin install polka@polka
```

Затем в Claude Code: `/mcp` → `plugin:polka:polka` → Authenticate.

**Codex**

```
codex plugin marketplace add artkruglov/polka-plugin && codex plugin add polka@polka
```

Затем `codex mcp login polka`.

**Сессии агентов** (по желанию): плагин ставит хук `SessionEnd`, который отправляет закончившуюся сессию Claude Code на вашу полку, скрыв секреты ещё на компьютере. Он ничего не делает, пока вы не включите: `node scripts/polka-sessions.mjs login` (токен с правом «Сессии агентов») и `POLKA_SESSIONS=on` в окружении. Подробнее — [AGENT_SESSIONS](https://github.com/artkruglov/polka/blob/main/docs/specs/AGENT_SESSIONS.md).

**Без плагина** — только MCP-сервер: `claude mcp add --transport http --scope user polka https://polochka.app/mcp` или `codex mcp add polka --url https://polochka.app/mcp`. Скилл отдельно: `npx skills add artkruglov/polka-plugin`.

Версия 0.11.1. Этот репозиторий собирается из [artkruglov/polka](https://github.com/artkruglov/polka) командой `node scripts/plugin-repo.mjs`: правки вносятся там. Лицензия AGPL-3.0.

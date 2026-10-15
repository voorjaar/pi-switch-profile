---
name: pi-rpc-live-extension-test
description: Drive a real pi session with `pi --mode rpc` plus JSONL stdin to test extension commands; assert registration with get_commands and read UI output from extension_ui_request notify records.
type: workflow
---

Interactive pi needs a TTY, so the live test for `/switch` (`scripts/live-test.mjs`) spawns
`pi --mode rpc -e <absolute path to extension.ts>` and speaks JSONL:

- `{"id":"r1","type":"prompt","message":"/switch zen"}` → response `data.disposition === "handled"` for an
  extension command. Extension commands execute immediately, even while streaming.
- `{"type":"get_commands"}` → every registered slash command; assert `switch` is present **before and after**
  the reload the command triggers. That single check proves the extension survived its own profile.
- `{"type":"get_state"}` → proves the session booted.
- Extension `ctx.ui.notify()` arrives as `{"type":"extension_ui_request","method":"notify","message":…}`.
  `setWidget()`/`ctx.ui.custom()` do not exist in RPC mode, so guard widget use with `ctx.mode === "tui"`
  and fall back to chunked `notify` elsewhere.

Safety pattern for tests that mutate `~/.pi/agent/settings.json`: copy the file to a backup first, and
restore it **after** killing the pi process — pi's own `SettingsManager` writes on exit and would otherwise
re-apply its in-memory copy over the restore.

**Why.** Unit tests on pure logic pass while the real thing is broken in ways only a live session shows: the
first live run exposed a fresh-store base that was never captured (so `packages` collapsed to `[]`), a
subcommand parsed as a profile name, and the post-reload notification loss.

**How to apply.** Keep both layers: `npm test` for pure logic, `node scripts/live-test.mjs` for the reload
path. Expect pi startup with many packages installed to take tens of seconds; run it as a background task.

**Related** [[pi-reload-drops-stale-extension-ui-calls]], [[pi-extension-typecheck-without-node-modules]], [[pi-live-test-restore-extension-store]]

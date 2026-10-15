---
name: pi-live-test-restore-extension-store
description: A live extension test that runs real pi against the user's agent dir must back up the extension's own store file too, not just settings.json.
type: gotcha
---

`scripts/live-test.mjs` runs a real `pi --mode rpc` against `~/.pi/agent`, because that is the only way to see
what a profile switch really does (packages, theme, tools, registered commands after `ctx.reload()`). That
directory is the user's live configuration, so the test mutates it:

- it writes `settings.json` (backup + restore in `finally`),
- and, for a stateful extension, its own state file — here `~/.pi/agent/pi-switch-config.json`, which holds the
  base snapshot, profiles, active profile, and history.

Restoring only `settings.json` left test residue behind: a saved `snapshot` profile, a deleted seed `zen`
profile, and a `base` captured from test settings. A later real session then switches to a base the test
captured. Backing up and restoring the store file in the same `finally` block makes the run idempotent, which
is what lets the test assert destructive paths (`/switch delete zen` on the active profile) at all.

**Why.** Live tests are the only place reload, package resolution, and tool registration are observable; unit
tests cannot see them. So they have to run against the real agent dir, and any state the extension persists
there becomes test residue unless explicitly restored.

**How to apply.** When adding persistent state to an extension, add that file to the live test's backup list
at the same time, and put destructive subcommands under coverage only after the backup covers them.

**Related** [[pi-rpc-live-extension-test]], [[pi-settings-write-then-reload]]

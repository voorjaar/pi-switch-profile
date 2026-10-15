---
name: pi-settings-write-then-reload
description: Writing settings.json by hand then calling ctx.reload() is the correct way for an extension to change pi's configuration; reload re-reads settings, re-resolves packages, and applies the theme.
type: fact
---

`ExtensionCommandContext.reload()` runs `AgentSession.reload()`, which in pi 1.2.0 does, in order:
`session_shutdown(reason:"reload")` → `settingsManager.reload()` → `resourceLoader.reload()` (which calls
`packageManager.resolve()` again) → `_buildRuntime()` → `session_start(reason:"reload")`. Interactive mode
then calls `setRegisteredThemes(...)` and `themeController.applyFromSettings()`, so a `theme` value written
straight into `settings.json` takes effect after reload without calling `ctx.ui.setTheme()`.

`SettingsManager.persistScopedSettings()` re-reads the current file and merges **only the fields pi itself
modified**, so an extension that edits other keys of `settings.json` externally does not get clobbered.
Settings files are plain `JSON.parse` (no JSONC), and `FileSettingsStorage` guards writes with `proper-lockfile`
on `settings.json` itself.

**Why.** Extensions get `pi.getSettings()` (read-only) but no handle on the live `SettingsManager`, so the only
way to change `packages`/`extensions`/`skills`/`prompts`/`themes`/`theme`/`defaultModel`/`defaultTools` from an
extension is to write the file and reload. There is no `setDefaultTools` setter on `SettingsManager` either.

**How to apply.** Write with a read-modify-write of only the keys you own, preserving every other key
(`$schema`, `compaction`, …), and do the read+write inside one synchronous block so no queued pi write can
interleave. Write to a tmp file in the same directory and `rename()` it. Then `await ctx.reload()`.

**Related** [[pi-reload-drops-stale-extension-ui-calls]], [[pi-package-autoload-disable]], [[pi-profile-package-drift]]

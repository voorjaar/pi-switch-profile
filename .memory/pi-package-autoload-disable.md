---
name: pi-package-autoload-disable
description: Disabling a pi package without uninstalling it means {source, autoload:false}; global !patterns only filter auto-discovered and local resources, never package-provided ones.
type: fact
---

`settings.packages` accepts an object form `{ source, autoload, extensions, skills, prompts, themes }`.
With `autoload: false`, `DefaultPackageManager.collectPackageResources()` calls `applyPackageDeltaFilter`
with the entry's own patterns, so the package resolves (and installs if missing) but loads nothing.
That is the reversible way to turn a package off: the entry stays, re-enabling is instant, and nothing is
uninstalled.

Pattern semantics differ by resource origin:

- `settings.extensions` / `skills` / `prompts` / `themes` entries (`!glob`, `+path`, `-path`) are applied to
  **local** entries from those settings and to **auto-discovered** resources under `<agent-dir>/extensions`,
  `<agent-dir>/skills`, … and the project `.pi/` equivalents. Matching is against the path relative to that
  base dir, the basename, or the absolute path; for skills the `SKILL.md` parent dir is matched too.
- Resources that come from a **package** are filtered only by that package entry's own filter, never by the
  global `!patterns`.

So "zero skills, zero extensions" needs both halves: `packages: []`-style `autoload:false` entries for package
resources, and `["!extensions/**", "!skills/**", "!prompts/**", "!themes/**"]` plus `-builtin:mcp` and friends
for auto-discovered and built-in resources.

**Why.** Assuming a single mechanism silently leaves half the resources loaded — the failure is invisible
(resource count in the startup listing) rather than an error.

**How to apply.** When writing a profile that turns resources off, state both mechanisms in the profile and
verify with `pi list` / the startup resource listing.

**Related** [[pi-extension-self-preservation]], [[pi-settings-write-then-reload]]

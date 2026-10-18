# Changelog

All notable changes to pi-switch-profile are documented here.

## Unreleased

## 0.2.0

### Added

- Added `/switch install <target> [--only <profiles>] [--kind <kind>]`. pi's own `pi install` parses a fixed option
  set and rejects options an extension registers (`pi.registerFlag()` only reaches a running session), and pi has
  no profile concept at all, so profile targeting lives here: the package entry is written into `settings.json`
  (pi installs a missing `npm:`/`git:` source while resolving after the reload), and every profile is rewritten so
  only the named ones may load it - a baseline profile gains an `exclude` entry, a whitelist profile gains or
  loses the term, an exclude-only profile loses its exclusion, and a profile that starts from nothing gains a
  whitelist holding exactly the target. A bare target is resolved against the auto-discovered resources, an
  ambiguous one asks for `--kind`, and one that matches nothing is taken to be a package source.
  `/switch restore` undoes an install completely, which is why its undo record now also stores the profiles map.

- Added `exclude` to profiles: what to throw away per resource kind, for example
  `"exclude": { "extensions": ["review"], "skills": ["archive"] }`. On its own it means "everything except
  these", so `default` can keep everything but one extension; combined with a whitelist of the same kind it
  narrows that whitelist. `exclude.packages` is an alias for `disablePackages`, and a built-in is excluded by
  naming it (`mcp` or `builtin:mcp`).
- Added `revertSession: "start" | "end" | "off"` (default `"start"`), reported and changed with
  `/switch revert-session <start|end|off|status>`. It decides when the session returns to the default
  configuration (the `default` profile, or the base snapshot when it does not exist): `start` puts the settings
  back when a new session begins - which also covers a profile left behind by a killed session - `end` writes
  them back when the session closes, and `off` lets the last switch win. A start revert also re-applies the
  default profile's tools, model, and thinking level to the live session, and says so in a notice; an end revert
  stores its notice for the next session because the UI is being torn down. Nothing is written when the settings
  already match the default configuration or when no base snapshot exists yet. `/switch restore` undoes either. When a
  start revert changes packages, extensions, skills, prompts, or themes it reloads the session afterwards (sent to
  itself as an internal `/switch __revert-reload` command, because only a command context can reload), so the
  previous profile's resources actually go away instead of lingering until you type `/reload`.
- Added `/switch <profile>`: applies a configuration profile to `~/.pi/agent/settings.json` and runs pi's own
  reload, so packages, extensions, skills, prompt templates, themes, theme, model, thinking level, and default
  tools all change at once. Ships with seeded `zen` (no packages, no auto-discovered resources) and `default`
  (the base snapshot) profiles.
- Added `/switch list`, `/switch show <profile>` (resolved profile plus diff, changing nothing),
  `/switch save <profile>`, `/switch refresh`, `/switch restore` (undo the last switch),
  `/switch delete <profile>`, `/switch help`, and `/switch doctor`.
- Added `/switch doctor`: reports the live session (model, thinking level, active tools, configured tools) and
  whether `settings.json` still matches the active profile.
- Added a footer status showing the active profile.
- Added profile-name completion for `/switch` arguments.
- Added self-preservation: the profile never disables this extension's own package entry, so a strict profile
  such as `zen` cannot switch `/switch` off.
- Added a report of which profiles inherit from a profile deleted with `/switch delete`, and a warning that the
  active profile's settings stay applied after deletion.
- Added drift reporting: after a manual edit to `settings.json`, `/switch` and `/switch doctor` say the settings
  differ from the active profile instead of implying they match.
- Added a warning when a profile lists tools that no package registered in this session.
- Added bilingual documentation (`README.md`, `README.zh-CN.md`).

### Changed

- The footer status is shorter and colored: `[<profile>]` - brackets in the theme's accent color, the name in
  muted - instead of `profile: <profile>` in the terminal default white. pi renders extension status text verbatim,
  so the color is applied here from `ctx.ui.theme`. A profile that no longer resolves shows as
  `[<profile> (broken)]` in the warning color.
- The undo record no longer lives in the profile store. The settings before the last switch are written to
  `~/.pi/agent/pi-switch-undo.json` and `/switch restore` clears it, so `pi-switch-profile.json` holds only
  `base`, profiles, the active profile, and the revert option. The `history` array (up to 12 full settings
  snapshots) is dropped: its last entry is carried to the undo file on load.
- **Profile resource keys are whitelists now.** `extensions`, `skills`, `prompts`, and `themes` list what to
  keep - a substring (`novel-writer`) or a glob (`extensions/review.ts`) - and everything else is switched off,
  so a profile no longer needs `!extensions/**` or `-builtin:mcp` written by hand. A built-in is kept by naming
  it (`builtin:mcp`); resources a package provides follow the `packages` whitelist. A profile starts from nothing
  for the keys it does not declare, except `base` and a `default` with no resource overrides, which keep
  everything - so `/switch default` still turns everything back on. The settings written are still plain pi
  entries (`!kind/**` plus a `+path` per match). A profile written under the old filter semantics is migrated on
  load: its force-includes and plain entries become the whitelist, and a deny-only list such as the old `zen`
  becomes `[]`. `/switch save <profile>` now records the enabled resources as a whitelist.
- Renamed the package from `pi-switch-config` to `pi-switch-profile`, and the profile store with it:
  `~/.pi/agent/pi-switch-config.json` is renamed to `~/.pi/agent/pi-switch-profile.json` on load (the project
  file likewise). An existing `npm:pi-switch-config` entry in `settings.json` still loads this extension, and
  `/switch` keeps it enabled under the new name. A store written by the boolean `revertWhenSessionEnd` option is
  read as `revertSession: "end"` (`false` as `"off"`).
- Renamed the seeded no-override profile from `coder` to `default`. A store written by an earlier version is
  migrated on load, but only the seeded profile: a real profile you named `coder` is left alone, and so is a
  `default` you made yourself.

### Fixed

- Fixed a profile's `theme` being silently dropped when its provider was switched off. A theme a *package*
  provides (`terminal` from `pi-terminal-theme`, for example) only exists while that package loads, so a
  `packages` whitelist or `exclude.packages` that disabled the package left `theme` naming a theme pi could not
  find, and pi fell back to the system theme. The selected theme now outranks that policy: the package entry is
  kept as `autoload: false` with a single `+themes/<file>.json` force-include, which is pi's own way of loading
  one resource out of a disabled package, and the package stays off for everything else. A `light/dark` pair is
  kept on both halves, an explicit `exclude.themes` entry is honoured instead of overridden, and a theme nothing
  provides is reported by `/switch show`, `/switch list`, `/switch doctor`, and the switch summary. Local themes
  in `~/.pi/agent/themes/` were never at risk - pi reads that directory regardless of the `themes` filter - and
  `system`, `dark`, and `light` cannot be switched off at all.
- Fixed the live test suite (`node scripts/live-test.mjs`) reporting failures for configurations it did not
  create. Six checks assumed a pristine `settings.json` - "every package entry is a plain string" - so a `default`
  profile that deliberately keeps a package off (`exclude.packages`), or a `base` snapshot captured while another
  profile was active, made them fail with no product bug behind them. They now assert that nothing is disabled
  which the live `default` profile did not choose to disable, and compare the package set by source rather than by
  entry form.
- Fixed `/switch restore` re-activating a profile that had been deleted since the switch: the footer no longer
  names a profile that does not exist, and the report says the settings were restored from a since-deleted profile.
- Fixed profile switches being sticky: a managed key that neither the profile nor the base snapshot defines is
  now removed from `settings.json` instead of keeping the value an earlier profile wrote. `/switch default` now
  really clears the tool list `/switch zen` set, and `/switch restore` is a complete undo.
- Fixed an unparseable `settings.json` or profile store being overwritten without a copy: it is now saved as
  `<file>.corrupt.bak` before the rewrite.
- Fixed a first-run defect where an empty base snapshot made every profile write an empty package list.
- Fixed package drift: packages installed after the base snapshot are now carried over, and packages removed
  with `pi remove` are no longer written back (pi reinstalls an `npm:` source while resolving it).
- Fixed `/switch show <profile>` resolving the literal word `show` as a profile name.
- Fixed the switch summary never appearing: the report is now emitted before `ctx.reload()`, because UI calls
  from the previous extension runtime are dropped after a reload.
- Fixed tools removed by a profile staying active after the reload; the profile's tool list is now enforced on
  the live session.
- Fixed `/switch show` reporting no changes when compared against the current settings.
- Fixed the footer naming a profile that had been deleted while it was active.
- Fixed `/switch save` accepting a name that a subcommand shadows, which made the saved profile unreachable.

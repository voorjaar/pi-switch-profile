# Changelog

All notable changes to pi-switch-config are documented here.

## Unreleased

### Added

- Added `/switch <profile>`: applies a configuration profile to `~/.pi/agent/settings.json` and runs pi's own
  reload, so packages, extensions, skills, prompt templates, themes, theme, model, thinking level, and default
  tools all change at once. Ships with seeded `zen` (no packages, no auto-discovered resources) and `coder`
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

### Fixed

- Fixed profile switches being sticky: a managed key that neither the profile nor the base snapshot defines is
  now removed from `settings.json` instead of keeping the value an earlier profile wrote. `/switch coder` now
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

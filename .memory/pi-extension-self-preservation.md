---
name: pi-extension-self-preservation
description: A profile that empties settings.packages also removes the package providing /switch, so the extension must force-keep its own package entry enabled or it locks itself out.
type: gotcha
---

`/switch zen` sets `packages: []`. Because pi resolves resources from `settings.packages`, that also drops
`pi-switch-config` itself: after the reload there is no `/switch` left to switch back with, and recovery
means `pi config` or a hand edit of `settings.json`.

`pi-switch-config` avoids this in `applyPackagePolicy()`: every entry matched by `isSelfPackageSource()` is
returned untouched. Self-detection uses `import.meta.url` → nearest ancestor `package.json` as the package
root, then matches a settings entry either by the source string containing `pi-switch-config` (covers
`npm:pi-switch-config`, `git:…/pi-switch-config`, `./pi-switch-config`) or, for a local source, by resolving
it relative to the settings file's base dir (agent dir for user settings) and comparing with that root.

**Why.** Package identity is npm package name / git repo URL / resolved absolute path, so a `-path` or `+path`
override pattern cannot resurrect a package that is no longer in the list: `+path` only re-enables a resource
that is already a candidate.

**How to apply.** Any extension that can turn *all* packages off must keep its own entry. Do not "solve" this
by appending an absolute local entry for yourself alongside an existing `npm:` entry — different identities
load the same extension twice.

**Related** [[pi-package-autoload-disable]]

---
name: pi-profile-package-drift
description: A profile's package list must merge the base snapshot with the packages currently in settings.json, so newly installed packages are governed by profiles and removed ones are not resurrected.
type: decision
---

The first design made `settings.packages` a pure copy of `base.packages` filtered by the profile. Two drift
cases broke that:

1. A package installed after the base snapshot (`pi install`) was absent from `base`, so every profile wrote
   a package list without it — the package silently never loaded.
2. A package removed with `pi remove` was still in `base`, so the next switch wrote it back. For an `npm:`
   source that is worse than a missing package: `DefaultPackageManager.resolvePackageSources()` **installs
   missing npm sources during resolve**, so a switch would reinstall it.

`mergePackageSets(base, current)` now defines the known set: base order, entries no longer in `current`
dropped, `current`-only entries appended. Entry *form* prefers the `current` entry when the user authored a
resource filter (`extensions`/`skills`/`prompts`/`themes`), otherwise the base entry. `enabledForm()` then
strips `autoload: false` from the template, and `applyPackagePolicy()` alone decides enablement: whitelist
(`profile.packages`), blacklist (`profile.disablePackages`), or — when the profile declares neither — enable
everything in the known set.

**Why.** "Profile decides enablement, settings decide the set" keeps `/switch coder` meaning "everything on"
even after the user installed or removed packages, and keeps a switch from doing package management it was
never asked to do.

**How to apply.** When changing profile semantics, keep this split: the set comes from live settings, the
policy from the profile. Do not let a profile write a package list that settings.json never contained.

**Related** [[pi-package-autoload-disable]], [[pi-extension-self-preservation]]

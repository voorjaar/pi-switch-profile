---
name: pi-settings-managed-keys-must-be-cleared
description: Writing a profile into settings.json has to delete managed keys the new settings do not set; keeping them makes profiles sticky and turns restore into a partial undo.
type: gotcha
---

The first `writeManagedSettings()` skipped `undefined` values ("undefined means the profile does not manage
this key, so keep the file value") and never removed a managed key. It sounded lossless. It was not:

- `/switch zen` wrote `defaultTools: ["read","bash","edit","write"]`.
- `/switch coder` (no overrides, base had no `defaultTools`) left that list in place, so the profile switch
  silently kept half of the previous profile.
- `/switch restore` could not undo it either, because the key `zen` introduced was never removed.

A live RPC test caught it (`coder drops the zen tool list :: ["read","bash","edit","write"]`) — no unit test
did, because the unit tests only compared the values written, not the keys removed.

`buildProfileSettings()` now resolves each managed key as `profile value ?? base value`, and
`writeManagedSettings()` writes that value or **deletes** the key. `packages` is the exception: its *set* comes
from live settings merged with the base (see [[pi-profile-package-drift]]) because `pi install` / `pi remove`
change it out of band.

**Why.** A profile switch is only trustworthy if the resulting settings are exactly the profile over the base.
"Never delete" makes the effective configuration a union of every profile ever applied, which is the opposite
of switching.

**How to apply.** When a tool owns a subset of keys in a shared config file, treat that subset as exclusive:
write what you mean, delete what you do not. And when testing such a writer, assert on absent keys, not just
on present values.

**Related** [[pi-profile-package-drift]], [[pi-live-test-restore-extension-store]], [[pi-rpc-live-extension-test]]

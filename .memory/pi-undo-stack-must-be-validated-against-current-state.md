---
name: pi-undo-stack-must-be-validated-against-current-state
description: An undo entry records the past; applying it must be checked against what still exists now, otherwise restore resurrects references to deleted things.
type: lesson
---

`/switch restore` pops the last history entry and writes back the settings it recorded. The entry also stores
`fromProfile`, and the first implementation did `store.activeProfile = snapshot.fromProfile`. That is correct
for the simple case and wrong in this one:

1. `/switch zen` (history: fromProfile `zen`… actually `null` → then `/switch snapshot` recorded fromProfile `zen`)
2. `/switch delete zen`
3. `/switch restore` → settings restored correctly, but `activeProfile` became `zen`, a profile that no longer
   exists. The footer claimed it, and drift detection silently returned "no drift" because resolving the
   profile threw.

`restoreActiveProfile(fromProfile, profiles)` now returns the recorded profile only if it still exists, and the
report says "restored the settings of "zen", which has since been deleted".

**Why.** Undo state is a snapshot of a world that has since changed. The *content* of the snapshot (settings)
can be written back verbatim, but any *reference* it holds (a profile name, a file path, an id) has to be
re-validated against the present before it is surfaced to the user.

**How to apply.** When adding an undo/history stack over named entities, split each entry into data (safe to
replay) and references (must be checked). Also cover the multi-switch case in tests: a single `restore` undoes
one switch, so a test that switches twice must restore twice — an earlier live-test failure was exactly that
assumption, not a product bug.

**Related** [[pi-settings-managed-keys-must-be-cleared]], [[pi-live-test-restore-extension-store]]

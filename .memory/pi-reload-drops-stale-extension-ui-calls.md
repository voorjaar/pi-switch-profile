---
name: pi-reload-drops-stale-extension-ui-calls
description: Nothing after await ctx.reload() may reuse the old extension runtime; UI calls from the stale instance can be silently dropped, so report before reloading and rebuild state in session_start.
type: gotcha
---

`ctx.reload()` tears down the extension runtime (`session_shutdown(reason:"reload")`,
`oldRunner.invalidate()`, then a fresh load). The `await` returns into the **old** instance, so calls made
after it — `ctx.ui.notify()`, `ctx.ui.setStatus()`, `pi.setActiveTools()` — belong to an invalidated
extension. In the first live run of `/switch zen` the summary notification emitted after `ctx.reload()`
never reached the RPC client, while the identical notify emitted before the reload arrived.

**Why.** The docs state this ("code after `await ctx.reload()` must not reuse state from the old runtime")
but the failure mode is a missing message, not an exception, so it reads as "the command did nothing".

**How to apply.** Emit the human-readable summary *before* `ctx.reload()`. Anything that must run after the
reload belongs in the `session_start` handler with `event.reason === "reload"`, reading state from durable
places (the extension's own JSON file, or `pi.appendEntry()` + `ctx.sessionManager.getBranch()`), never from
closure variables. `ctx.ui.setStatus()` from `session_start` is fine.

**Related** [[pi-settings-write-then-reload]], [[pi-reload-only-adds-default-tools]]

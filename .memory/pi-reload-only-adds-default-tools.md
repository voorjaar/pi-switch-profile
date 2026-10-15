---
name: pi-reload-only-adds-default-tools
description: /reload only activates tools newly added to defaultTools; it never deactivates tools removed from the setting, so a smaller tool set must be enforced with setActiveTools on session_start(reason reload).
type: fact
---

`AgentSession.reload()` computes `addedDefaultTools = getDefaultTools().filter(name => !previousDefaultTools.has(name))`
and builds the new runtime with the currently active tools **plus** those additions. Tools that were active
and are no longer in `defaultTools` stay active, and tools the user disabled during the session stay disabled.
The settings doc says the same thing for `/reload`.

So writing `defaultTools: ["read","bash","edit","write"]` into `settings.json` and reloading does **not**
remove `websearch`, `obsidian`, `bg_run`, … from the live session — it only guarantees the four builtins are
there for the *next* session.

**Why.** A profile switch that narrows the tool set looks successful (the setting is written, the next
startup is correct) while the current session still carries every tool, which is exactly the case a "zen"
profile exists to avoid.

**How to apply.** In the `session_start` handler, when `event.reason === "reload"`, call
`pi.setActiveTools(profile.tools)` filtered to names present in `pi.getAllTools()` (unknown names are
ignored). Only do it on reload: on a fresh session pi already applies `defaultTools`, and re-applying on
every start fights the user's mid-session tool changes.

**Related** [[pi-reload-drops-stale-extension-ui-calls]], [[pi-settings-write-then-reload]]

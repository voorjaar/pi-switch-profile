---
name: pi-extension-api-vs-command-context
description: Tool and session introspection (getActiveTools, getAllTools, getSettings, setModel) lives on ExtensionAPI (`pi`), not on ExtensionContext or ExtensionCommandContext (`ctx`).
type: fact
---

`ctx` (`ExtensionContext`, and `ExtensionCommandContext` for command handlers) exposes `ui`, `cwd`, `model`,
`thinkingLevel`, `modelRegistry`, `hasUI`, `getContextInfo`, and command actions such as `getSystemPromptOptions`,
`waitForIdle`, `newSession`, `reload`.

Tool and configuration surface is on the `pi` object (`ExtensionAPI`, `dist/core/extensions/types.d.ts` ~L1186):
`getActiveTools()`, `getAllTools(): ToolInfo[]` (`name`, `exposure`, `sourceInfo`, …), `setActiveTools(names)`,
`refreshTools()`, `getSettings(): Settings`, `setModel(model)`, `getThinkingLevel()`, `setThinkingLevel(level)`.

So a `/switch doctor`-style diagnostic that reports "what this session actually has" must take `pi` as a
parameter; calling `ctx.getActiveTools()` is a compile error
(`Property 'getActiveTools' does not exist on type 'ExtensionCommandContext'`).

**Why.** Command handlers naturally receive `ctx` only, so the API surface is easy to miss until typechecking
fails inside a live test rather than in a quick read of the docs.

**How to apply.** When a command handler needs tools, settings, or model mutation, thread `pi` into the helper
function signature. `ToolInfo.sourceInfo` is the field to use when attributing a tool to the package that
registered it.

**Related** [[pi-rpc-live-extension-test]], [[pi-reload-only-adds-default-tools]]

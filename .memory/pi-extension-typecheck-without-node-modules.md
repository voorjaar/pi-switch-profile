---
name: pi-extension-typecheck-without-node-modules
description: Type-check a pi extension by mapping the host packages to the installed release's dist .d.ts files in tsconfig paths instead of installing them into the package.
type: workflow
---

pi 1.2.0 supplies `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`, and `typebox` to
extensions. `docs/packages.md` says to declare them in `peerDependencies` with `"*"` and **not** in
`dependencies`: a physical copy in the package's own `node_modules` can bypass pi's extension module mapping
in compiled ESM and create duplicate classes and registries, and pi warns when it sees that manifest shape.

That leaves `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` unresolvable for an editor
or `tsc`. This repo resolves it without installing anything:

```json
"typeRoots": ["/Users/raven/.pi/agent/install/releases/1.2.0/node_modules/@types"],
"types": ["node"],
"paths": {
  "@earendil-works/pi-coding-agent": ["…/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],
  "@earendil-works/pi-tui": ["…/node_modules/@earendil-works/pi-tui/dist/index.d.ts"]
}
```

with `module: nodenext`, `allowImportingTsExtensions: true`, `noEmit: true`.

The extension entry also keeps its pi import **type-only** so `node --experimental-strip-types selftest.ts`
can import `extensions/switch.ts` directly: type-only imports are erased, so the test needs no pi runtime.

**Why.** Without the mapping every pi type degrades to implicit `any` (and lens reports it as a blocker),
which hides real mistakes such as `WidgetPlacement` being `"aboveEditor"` and not `"above-editor"`.

**How to apply.** Prefer peerDependencies + tsconfig paths. Only add a devDependency on the host package if
type checking genuinely cannot be done otherwise, and never a runtime `dependency` on it.

**Related** [[pi-rpc-live-extension-test]]

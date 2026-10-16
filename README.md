# pi-switch-profile

**English** | [简体中文](README.zh-CN.md)

A [pi](https://pi.dev) extension that adds `/switch <profile>`: one command swaps a whole configuration profile — pi packages, extension/skill/prompt/theme paths, the theme, the default model, thinking level, and default tools — and then runs pi's own reload.

Use it to move between a stripped-down session and a fully equipped one without editing `settings.json` by hand.

## Features

- **One command, full swap.** `/switch zen` turns off skills, extensions, prompt templates, and custom themes; `/switch default` turns them back on.
- **Nothing is uninstalled.** Profiles overlay a captured *base* snapshot of `settings.json`. A disabled pi package becomes `{ "source": "...", "autoload": false }` instead of disappearing, so re-enabling it is instant.
- **Never locks itself out.** The extension keeps its own package enabled even in the strictest profile.
- **Undo.** Every switch records the settings it replaced; `/switch restore` puts them back.
- **Session-scoped switches.** `revertSession` puts the session back on the default configuration at session start (the default) or at session close, so a switch you only wanted for now does not leak into the next session.
- **Seeded profiles.** `zen` (zero skills, zero extensions) and `default` (everything from the base snapshot) are created on first use.
- **Visible state.** The footer shows the active profile, and `/switch` prints the resolved configuration and the exact changes. If you edit `settings.json` by hand afterwards, `/switch` and `/switch doctor` say so instead of pretending the profile is applied.
- **Autocomplete.** Profile names complete as command arguments.

## Installation

Install the package (it writes the package declaration to `~/.pi/agent/settings.json`):

```bash
pi install ./pi-switch-profile
```

Or try it once without installing anything:

```bash
pi -e ./extensions/switch.ts
```

If you edit `settings.json` by hand, run `/reload` afterwards.

## Usage

| Command | What it does |
| --- | --- |
| `/switch` | Show the active profile, the profile list, and the current configuration |
| `/switch <profile>` | Apply a profile, then reload extensions, skills, prompts, themes, and settings |
| `/switch list` | Same as `/switch` |
| `/switch show <profile>` | Show the resolved profile and the diff against the current configuration, changing nothing |
| `/switch save <profile>` | Capture the current configuration as a new profile |
| `/switch refresh` | Re-capture the base snapshot from `settings.json` (do this after installing a package by hand) |
| `/switch restore` | Undo the last switch |
| `/switch revert-session <start\|end\|off\|status>` | When the session returns to the default configuration (default: `start`) |
| `/switch delete <profile>` | Remove a profile |
| `/switch doctor` | Show what the live session actually has: model, thinking level, active and configured tools, and whether settings match the active profile |
| `/switch help` | List the subcommands |

Profiles are also slash-command arguments: type `/switch` with a trailing space and press Tab to list them.

## Profiles

Profiles live in `~/.pi/agent/pi-switch-profile.json`, with optional project profiles in `.pi/pi-switch-profile.json`:

```json
{
  "version": 1,
  "activeProfile": "zen",
  "revertSession": "start",
  "base": {
    "packages": ["npm:pi-lens", "npm:pi-web-access"],
    "theme": "github-dark-default",
    "defaultProvider": "strata",
    "defaultModel": "qwen3.8-flash-next",
    "defaultThinkingLevel": "medium"
  },
  "profiles": {
    "zen": {
      "description": "Zero skills, zero extensions",
      "packages": [],
      "extensions": ["!extensions/**", "-builtin:mcp", "-builtin:codemode", "-builtin:tool-search"],
      "skills": ["!skills/**"],
      "prompts": ["!prompts/**"],
      "themes": ["!themes/**"],
      "theme": "system",
      "thinkingLevel": "low",
      "tools": ["read", "bash", "edit", "write"]
    },
    "review": {
      "extends": "zen",
      "description": "Zen plus one review extension",
      "packages": ["pi-simplify"]
    }
  }
}
```

Each profile is an overlay on `base`. A profile only changes the keys it declares.

| Profile key | Settings key it writes | Meaning |
| --- | --- | --- |
| `packages` | `packages` | Whitelist of package sources to keep enabled (substring match, for example `pi-lens` matches `npm:pi-lens`). Everything else in `base` gets `autoload: false`. This extension is always kept. |
| `disablePackages` | `packages` | Blacklist of package sources to disable; all others stay as they are. |
| `extensions`, `skills`, `prompts`, `themes` | same | Replace the list. pi's `!pattern`, `+path`, and `-path` entries work, so `!skills/**` turns off auto-discovered resources. |
| `theme` | `theme` | Theme name, for example `system`, `dracula`, or a custom theme name. |
| `model` | `defaultProvider`, `defaultModel` | `provider/modelId` or a bare `modelId`. Applied to the live session after the reload as well. |
| `thinkingLevel` | `defaultThinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Also applied to the live session. |
| `tools` | `defaultTools` | The startup tool list. After a reload the profile's list is enforced on the live session too, so tools removed from the profile actually go away. |
| `extends` | — | Inherit another profile. `"base"` means the base snapshot. |

Store options, not per-profile: `revertSession` (`"start" | "end" | "off"`, default `"start"`) decides when the session
returns to the default configuration; see [Reverting to the default configuration](#reverting-to-the-default-configuration).

### Base, save, and refresh

`base` is the snapshot of `settings.json` that every profile overlays. Capture it while no profile is active:

- `/switch save my-setup` records the current configuration as a profile you can return to. Profile names must be typeable as `/switch <name>`, so `base` and the subcommand names (`list`, `show`, `save`, `delete`, `refresh`, `restore`, `revert-session`, `doctor`, `help`) are reserved.
- `/switch refresh` re-reads `settings.json` into `base`. Run it when you want the *enablement* snapshot to follow what `pi config` currently says.

### What a switch writes

A profile replaces the settings it manages. For each managed key the value comes from the profile, or from the
`base` snapshot when the profile does not define it, and if neither defines it the key is **removed** from
`settings.json`. That is what makes `/switch default` undo `/switch zen`: `default` defines nothing, and the base
snapshot had no `defaultTools`, so the tool list `zen` wrote is cleared instead of lingering. `/switch restore`
is the same rule applied to the exact settings recorded before the switch.

`packages` is the one key that follows live `settings.json` instead of the snapshot:

- A package you installed after the base snapshot is carried over, so `/switch default` enables it and `/switch zen` turns it off.
- A package you removed with `pi remove` is dropped, so switching never writes it back (pi would reinstall an `npm:` source during resolve).
- A profile with neither `packages` nor `disablePackages` enables every known package. `packages` is a whitelist, `disablePackages` a blacklist; both accept partial matches such as `pi-lens` or `npm:pi-lens`.
- This extension always keeps itself enabled. If a profile could switch itself off, there would be no way back except editing `settings.json`.

### Reverting to the default configuration

`revertSession` decides when a session goes back to the default configuration: the `default` profile when it exists
(so a `default` you gave overrides is what you return to), otherwise the `base` snapshot with every known package
enabled.

```bash
/switch revert-session start   # every new session starts on the default configuration (the default)
/switch revert-session end     # the session close writes the default configuration back
/switch revert-session off     # the last switch stays applied across sessions
/switch revert-session         # report which mode is in effect
```

`"start"` is the default because it also covers a session that could not clean up after itself: if pi is killed or
the machine sleeps with a profile applied, the next session drops it. `"end"` is for people who want the file to be
correct the moment the session closes.

- A start revert runs when the settings differ from the default configuration. It writes `settings.json`, records
  history (so `/switch restore` undoes it), and enforces the default profile's tools, model, and thinking level on
  the live session. Packages, extensions, skills, and prompts that profile loaded are already in this session - pi
  resolves them before an extension can act, and `session_start` has no reload handle - so the notice tells you to
  run `/reload` (or `/switch default`, which does reload).
- An end revert runs only on a real session close. `/reload`, `/new`, `/resume`, and `/fork` are not closes, so a
  profile you switched to stays applied through them. The UI is being torn down there, so the notice is stored and
  shown at the start of the next session instead.
- Nothing is written when the settings already are the default configuration, and nothing is written before a `base`
  snapshot exists, so a session in which you never switched leaves the file alone.
- pi writes back only the settings keys it changed itself, so a revert written at exit survives apart from a key pi
  changed during the session (for example `defaultModel` after `/model`). `/switch doctor` reports what is left.

### Scope

`/switch` writes the **user** settings file (`~/.pi/agent/settings.json`). If the project's `.pi/settings.json` declares `packages`, `extensions`, `skills`, `prompts`, or `themes`, those project values win and `/switch` warns you about it.

## Development

```bash
npm install                  # only for the scripts below (tsc); the extension itself needs no dependencies
npm test                     # pure-logic self-test (profile resolution, package policy, settings writes)
npm run test:live            # live smoke test: real pi in RPC mode, zen, tools after reload, save/restore/refresh
npm run check                # type-check
```

`selftest.ts` imports `extensions/switch.ts` directly with `node --experimental-strip-types`, so it needs no
pi runtime: the extension imports pi types only. `npm run check` resolves those types through `tsconfig.json`
`paths`, which point at an installed pi release (`~/.pi/agent/install/releases/<version>/node_modules/...`) —
pi supplies those packages to extensions, so they are `peerDependencies`, deliberately not `dependencies`.

`scripts/live-test.mjs` installs this package into a backed-up `~/.pi/agent/settings.json`, runs a real pi in
RPC mode, switches to `zen`, checks the file and the reloaded session (registered commands, active tools, tools
from disabled packages), exercises save/list/delete/refresh/restore, and finally puts the original settings and
the original profile store back.

## License

MIT — see [LICENSE](LICENSE).

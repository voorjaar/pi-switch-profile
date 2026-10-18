# pi-switch-profile

**English** | [简体中文](README.zh-CN.md)

A [pi](https://pi.dev) extension that adds `/switch <profile>`: one command swaps a whole configuration profile — pi packages, extension/skill/prompt/theme paths, the theme, the default model, thinking level, and default tools — and then runs pi's own reload.

Use it to move between a stripped-down session and a fully equipped one without editing `settings.json` by hand.

## Features

- **One command, full swap.** `/switch zen` turns off skills, extensions, prompt templates, and custom themes; `/switch default` turns them back on.
- **Whitelists, not exclusions.** A profile lists what to keep (`"skills": ["novel-writer"]`) and everything else is off - no `!extensions/**` patterns to write.
- **Nothing is uninstalled.** Profiles overlay a captured *base* snapshot of `settings.json`. A disabled pi package becomes `{ "source": "...", "autoload": false }` instead of disappearing, so re-enabling it is instant.
- **Never locks itself out.** The extension keeps its own package enabled even in the strictest profile.
- **Undo.** The settings a switch replaced are recorded in a separate one-entry file (`~/.pi/agent/pi-switch-undo.json`); `/switch restore` puts them back and clears it.
- **Session-scoped switches.** `revertSession` puts the session back on the default configuration at session start (the default) or at session close, so a switch you only wanted for now does not leak into the next session.
- **Seeded profiles.** `zen` (zero skills, zero extensions) and `default` (everything from the base snapshot) are created on first use.
- **Visible state.** The footer shows the active profile as `[<profile>]` in the theme's accent/muted colors, and `/switch` prints the resolved configuration and the exact changes. If you edit `settings.json` by hand afterwards, `/switch` and `/switch doctor` say so instead of pretending the profile is applied.
- **Autocomplete.** Profile names complete as command arguments.

## Installation

Install the published package (it writes the package declaration to `~/.pi/agent/settings.json`):

```bash
pi install npm:pi-switch-profile
```

Or try it once without installing anything:

```bash
pi -e ./extensions/switch.ts
```

If you would rather run from a clone of this repo, install the checkout directly.

```bash
pi install ./pi-switch-profile
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
| `/switch restore` | Undo the last switch (the record lives in `~/.pi/agent/pi-switch-undo.json`) |
| `/switch install <target> [--only <profiles>] [--kind <kind>]` | Add a package, or retarget a resource so only the named profiles may load it |
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
      "extensions": [],
      "skills": [],
      "prompts": [],
      "themes": [],
      "theme": "system",
      "thinkingLevel": "low",
      "tools": ["read", "bash", "edit", "write"]
    },
    "review": {
      "extends": "zen",
      "description": "Zen plus one review extension and one skill",
      "packages": ["pi-simplify"],
      "extensions": ["review", "builtin:mcp"],
      "skills": ["novel-writer"]
    }
  }
}
```

Each profile is an overlay on `base`. A profile only changes the keys it declares.

| Profile key | Settings key it writes | Meaning |
| --- | --- | --- |
| `packages` | `packages` | Whitelist of package sources to keep enabled (substring match, for example `pi-lens` matches `npm:pi-lens`). Everything else in `base` gets `autoload: false`. This extension is always kept. |
| `disablePackages` | `packages` | Blacklist of package sources to disable; all others stay as they are. |
| `exclude` | `packages`, `extensions`, `skills`, `prompts`, `themes` | What to throw away, per kind: `{ "extensions": ["review"], "skills": ["archive"] }`. Alone it means "everything except these"; with a whitelist of the same kind it narrows that whitelist. `exclude.packages` is an alias for `disablePackages`. |
| `extensions`, `skills`, `prompts`, `themes` | same | **Whitelist** of what to keep: a term is a substring (`review`, `novel-writer`) or a glob (`extensions/review.ts`, `skills/nov*`). Everything that matches nothing is disabled, so `[]` means "none" and you never write an exclusion pattern. See [Resource whitelists](#resource-whitelists). |
| `theme` | `theme` | Theme name, for example `system`, `dracula`, or a custom theme name, or a `light/dark` pair such as `terminal/terminal-tinted`. The selected theme is kept loadable even by a profile that switches its provider off - see [Theme availability](#theme-availability). |
| `model` | `defaultProvider`, `defaultModel` | `provider/modelId` or a bare `modelId`. Applied to the live session after the reload as well. |
| `thinkingLevel` | `defaultThinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Also applied to the live session. |
| `tools` | `defaultTools` | The startup tool list. After a reload the profile's list is enforced on the live session too, so tools removed from the profile actually go away. |
| `extends` | — | Inherit another profile. `"base"` means the base snapshot. |

Store options, not per-profile: `revertSession` (`"start" | "end" | "off"`, default `"start"`) decides when the session
returns to the default configuration; see [Reverting to the default configuration](#reverting-to-the-default-configuration).

### Resource whitelists

A profile starts from nothing. If it declares `extensions`, it keeps only the extensions its terms
match, and the skills, prompts, and themes it does not mention are switched off too - so a profile is
a list of what you want, not a list of what to exclude.

Two profiles are the exception because they mean "everything you have": `base`, and a `default` you
gave no resource overrides to. That is why `/switch default` still turns everything back on.

- Terms are matched against the resources pi auto-discovers: `~/.pi/agent/extensions|skills|prompts|themes`,
  `~/.agents/skills`, and the project's `.pi/` equivalents. A skill is matched by its directory name
  (`novel-writer`), a file by name or path.
- pi's own built-in extensions (`mcp`, `codemode`, `tool-search`, `llama.cpp`) are not under
  `extensions/**`, so a whitelist names them: `builtin:mcp` keeps it, leaving it out drops it.
- Resources a *package* provides follow the `packages` whitelist instead, because pi filters those with
  the package entry's own filter. To keep a package's extension, keep the package.
- The settings written are still plain pi entries (`!extensions/**` plus `+extensions/review.ts` for each
  match), so `settings.json` stays readable and editable by hand; `/switch` just generates them.
- `/switch save <name>` records the currently enabled resources as a whitelist, so a saved profile
  reproduces what you had.
- Profiles written by older versions (lists of `!pattern`, `+path`, `-path`) are migrated on load: the
  entries that were being kept become the whitelist, and a list that only denied things becomes `[]`.

#### Excluding one thing

To keep an extension out of `default` but on in one profile, give `default` an `exclude` list - it stays
"everything else", and the other profile whitelists what it wants:

```json
"default": { "exclude": { "extensions": ["review"] } },
"review":  { "packages": ["pi-simplify"], "extensions": ["review", "pi-lens"] }
```

`/switch default` then loads everything except `review`; `/switch review` loads only what it lists.

### Theme availability

`theme` and `themes` are not the same switch, and only one of them can actually lose a theme.

- A theme file in `~/.pi/agent/themes/<name>.json` is always available. pi's theme loader reads that
  directory directly and lists it in `/theme` whatever the `themes` filter says, so `themes: []` never
  breaks a local theme - it only hides it from the auto-discovered resource list.
- `system`, `dark`, and `light` are pi's own themes. No profile can switch them off.
- A theme a *package* provides (`terminal` from `pi-terminal-theme`, for example) exists only while that
  package loads. A `packages` whitelist or `exclude.packages` that turns the package off leaves `theme`
  naming something that no longer exists, and pi silently falls back to the system theme.

So the theme a profile selects outranks the policy that would drop it. When a profile turns off the
package that provides the selected theme, that entry is kept as `autoload: false` with a single
force-include - pi's own way of loading one resource out of a disabled package:

```json
{ "source": "npm:pi-terminal-theme", "autoload": false, "themes": ["+themes/terminal.json"] }
```

The package stays off for everything else. A `light/dark` pair is kept on both halves. What the profile says
outright wins: `exclude: { "themes": ["terminal"] }` is an explicit "not here" and is honoured instead of
overridden. A theme nothing provides - a typo, or a package that is not installed - is reported by
`/switch show`, `/switch list`, `/switch doctor`, and in the summary of the switch itself.

### Installing into one profile

pi's own `pi install` parses a fixed set of options (`-l`, `-a`, `-na`, `-h`, and `update`'s own), and rejects
anything an extension registers - `pi.registerFlag()` only reaches a running session. And pi has no notion of a
profile: a package lives in `settings.json` and nothing else. So the targeting happens here:

```bash
/switch install npm:pi-simplify --only review          # install it, let only "review" load it
/switch install pi-terminal-theme --only coding,notes  # retarget an already installed package
/switch install skills/novel-writer --only notes       # retarget a local skill
/switch install extensions/review.ts                   # no --only: every profile that keeps everything loads it
```

`<target>` is a package source (`npm:…`, `git:…`, `http(s):…`, or a path) or a resource name. A bare name is
matched against the auto-discovered resources (the agent dir, `~/.agents/skills`, the project `.pi/`): a name that
matches nothing is taken to be a package source, and a name that matches several kinds has to be narrowed with
`--kind extensions|skills|prompts|themes|packages`.

Each profile is rewritten in the style it already has, so installing never turns a "keep everything" profile into
a whitelist one:

- a baseline profile (`base`, an unoverridden `default`) only gains an `exclude` entry when it is not named;
- a whitelist profile named by `--only` gains the target, one that is not named loses it from its whitelist and
  gains an exclusion;
- a profile written as "everything except these" just loses the exclusion;
- a profile that starts from nothing gains a whitelist holding exactly the target.

The package entry is written into `settings.json`, and pi installs a missing `npm:` or `git:` source while
resolving after the reload. `/switch restore` undoes an install completely: the settings *and* the profiles map,
which is why the undo record for an install also stores the profiles.

### Base, save, and refresh

`base` is the snapshot of `settings.json` that every profile overlays. Capture it while no profile is active:

- `/switch save my-setup` records the current configuration as a profile you can return to. Profile names must be typeable as `/switch <name>`, so `base` and the subcommand names (`list`, `show`, `save`, `delete`, `refresh`, `restore`, `install`, `revert-session`, `doctor`, `help`) are reserved.
- `/switch refresh` re-reads `settings.json` into `base`. Run it when you want the *enablement* snapshot to follow what `pi config` currently says.

### What a switch writes

A profile replaces the settings it manages. For each managed key the value comes from the profile, or from the
`base` snapshot when the profile does not define it, and if neither defines it the key is **removed** from
`settings.json`. That is what makes `/switch default` undo `/switch zen`: `default` defines nothing, and the base
snapshot had no `defaultTools`, so the tool list `zen` wrote is cleared instead of lingering. `/switch restore`
is the same rule applied to the exact settings recorded before the last switch.

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
  the previous settings for `/switch restore`, and enforces the default profile's tools, model, and thinking level on
  the live session. If the change touches packages, extensions, skills, prompts, or themes - which pi resolved
  before the extension could act - it then reloads the session, so the previous profile's resources actually go
  away. A change only in theme, model, thinking level, or tools is applied in place with no reload.
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

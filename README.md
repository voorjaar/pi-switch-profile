# pi-switch-config

**English** | [简体中文](README.zh-CN.md)

A [pi](https://pi.dev) extension that adds `/switch <profile>`: one command swaps a whole configuration profile — pi packages, extension/skill/prompt/theme paths, the theme, the default model, thinking level, and default tools — and then runs pi's own reload.

Use it to move between a stripped-down session and a fully equipped one without editing `settings.json` by hand.

## Features

- **One command, full swap.** `/switch zen` turns off skills, extensions, prompt templates, and custom themes; `/switch coder` turns them back on.
- **Nothing is uninstalled.** Profiles overlay a captured *base* snapshot of `settings.json`. A disabled pi package becomes `{ "source": "...", "autoload": false }` instead of disappearing, so re-enabling it is instant.
- **Never locks itself out.** The extension keeps its own package enabled even in the strictest profile.
- **Undo.** Every switch records the settings it replaced; `/switch restore` puts them back.
- **Seeded profiles.** `zen` (zero skills, zero extensions) and `coder` (everything from the base snapshot) are created on first use.
- **Visible state.** The footer shows the active profile, and `/switch` prints the resolved configuration and the exact changes.
- **Autocomplete.** Profile names complete as command arguments.

## Installation

Install the package (it writes the package declaration to `~/.pi/agent/settings.json`):

```bash
pi install ./pi-switch-config
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
| `/switch delete <profile>` | Remove a profile |
| `/switch help` | List the subcommands |

Profiles are also slash-command arguments: type `/switch` with a trailing space and press Tab to list them.

## Profiles

Profiles live in `~/.pi/agent/pi-switch-config.json`, with optional project profiles in `.pi/pi-switch-config.json`:

```json
{
  "version": 1,
  "activeProfile": "zen",
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

### Base, save, and refresh

`base` is the snapshot of `settings.json` that every profile overlays. Capture it while no profile is active:

- `/switch save my-setup` records the current configuration as a profile you can return to.
- `/switch refresh` re-reads `settings.json` into `base`. Run it after you install or remove a package with `pi install`, `pi remove`, or `pi config`, otherwise a profile keeps re-applying the older package list.

### Scope

`/switch` writes the **user** settings file (`~/.pi/agent/settings.json`). If the project's `.pi/settings.json` declares `packages`, `extensions`, `skills`, `prompts`, or `themes`, those project values win and `/switch` warns you about it.

## Development

```bash
npm test                     # pure-logic self-test (profile resolution, package policy, settings writes)
node scripts/live-test.mjs   # live smoke test: real pi in RPC mode, /switch zen, /switch restore
```

`scripts/live-test.mjs` backs up `~/.pi/agent/settings.json`, switches to `zen`, checks the file, restores it, and puts the original settings back.

## License

MIT — see [LICENSE](LICENSE).

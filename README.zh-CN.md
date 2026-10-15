# pi-switch-config

[English](README.md) | **简体中文**

一个 [pi](https://pi.dev) 扩展，提供 `/switch <profile>` 命令：一条命令切换整套配置——pi 包、扩展/技能/提示模板/主题路径、主题、默认模型、思考强度、默认工具——然后自动执行 pi 自己的 reload。

用它在一个精简会话和一个全副武装的会话之间来回切换，而不必手动改 `settings.json`。

## 特性

- **一条命令，整体切换。** `/switch zen` 关闭技能、扩展、提示模板和自定义主题；`/switch coder` 再把它们打开。
- **不会卸载任何东西。** 每个配置档都叠加在一份捕获到的*基线*（base）快照之上。被禁用的 pi 包会变成 `{ "source": "...", "autoload": false }` 而不是消失，所以重新启用是瞬间的。
- **不会把自己锁死。** 即使是最严格的配置档，也会保留扩展自身所在的包。
- **可撤销。** 每次切换都会记录被替换的设置，`/switch restore` 原样恢复。
- **内置配置档。** 首次使用时自动创建 `zen`（零技能、零扩展）和 `coder`（基线快照的全部内容）。
- **状态可见。** 底栏显示当前生效的配置档，`/switch` 会打印解析后的配置与逐项变更。
- **自动补全。** 输入 `/switch ` 后按 Tab 会列出配置档名称。

## 安装

安装该包（会把包声明写入 `~/.pi/agent/settings.json`）：

```bash
pi install ./pi-switch-config
```

或者先临时试用，不做任何安装：

```bash
pi -e ./extensions/switch.ts
```

如果手动修改了 `settings.json`，之后请执行 `/reload`。

## 使用

| 命令 | 作用 |
| --- | --- |
| `/switch` | 显示当前配置档、配置档列表以及当前配置 |
| `/switch <profile>` | 应用某个配置档，然后重新加载扩展、技能、提示模板、主题和设置 |
| `/switch list` | 同 `/switch` |
| `/switch show <profile>` | 显示解析后的配置档以及与当前配置的差异，不做任何修改 |
| `/switch save <profile>` | 把当前配置捕获为一个新的配置档 |
| `/switch refresh` | 从 `settings.json` 重新捕获基线快照（手动安装某个包之后建议执行） |
| `/switch restore` | 撤销上一次切换 |
| `/switch delete <profile>` | 删除一个配置档 |
| `/switch help` | 列出全部子命令 |

配置档名称也是命令参数，输入 `/switch ` 后按 Tab 即可补全。

## 配置档

配置档保存在 `~/.pi/agent/pi-switch-config.json`，项目级的配置档可选放在 `.pi/pi-switch-config.json`：

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

每个配置档都是叠加在 `base` 之上的覆盖层，只有显式声明的键才会被改动。

| 配置档键 | 写入的设置键 | 含义 |
| --- | --- | --- |
| `packages` | `packages` | 保留启用的包来源白名单（子串匹配，例如 `pi-lens` 能匹配 `npm:pi-lens`）。`base` 中其余的包都会被设为 `autoload: false`。本扩展所在的包始终保留。 |
| `disablePackages` | `packages` | 要禁用的包来源黑名单，其余保持不变。 |
| `extensions`、`skills`、`prompts`、`themes` | 同名设置 | 替换整个列表。支持 pi 的 `!pattern`、`+path`、`-path` 写法，因此 `!skills/**` 可以关闭自动发现的资源。 |
| `theme` | `theme` | 主题名称，例如 `system`、`dracula`，或自定义主题名。 |
| `model` | `defaultProvider`、`defaultModel` | 写成 `provider/modelId`，或只写 `modelId`。reload 之后也会作用到当前会话。 |
| `thinkingLevel` | `defaultThinkingLevel` | 可取 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。同样会作用到当前会话。 |
| `tools` | `defaultTools` | 启动时的工具列表。reload 后该列表也会强制应用到当前会话，因此被移除的工具确实会消失。 |
| `extends` | — | 继承另一个配置档；`"base"` 表示基线快照。 |

### 基线、save 与 refresh

`base` 是每个配置档叠加其上的 `settings.json` 快照。请在没有配置档生效时捕获它：

- `/switch save my-setup` 把当前配置记录成一个可以返回的配置档。
- `/switch refresh` 重新读取 `settings.json` 并更新 `base`。在你用 `pi install`、`pi remove` 或 `pi config` 安装或移除某个包之后请执行一次，否则配置档会反复套用旧的包列表。

### 作用范围

`/switch` 写入的是**用户级**设置文件（`~/.pi/agent/settings.json`）。如果项目的 `.pi/settings.json` 声明了 `packages`、`extensions`、`skills`、`prompts` 或 `themes`，项目级的值优先级更高，`/switch` 会就此提醒你。

## 开发

```bash
npm test                     # 纯逻辑自检（配置档解析、包策略、设置写入）
node scripts/live-test.mjs   # 实跑冒烟测试：真实 pi 的 RPC 模式，/switch zen 与 /switch restore
```

`scripts/live-test.mjs` 会备份 `~/.pi/agent/settings.json`，切到 `zen`，检查文件内容，恢复设置，最后把原始配置写回。

## 许可证

MIT — 见 [LICENSE](LICENSE)。

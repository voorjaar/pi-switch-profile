# pi-switch-profile

[English](README.md) | **简体中文**

一个 [pi](https://pi.dev) 扩展，提供 `/switch <profile>` 命令：一条命令切换整套配置——pi 包、扩展/技能/提示模板/主题路径、主题、默认模型、思考强度、默认工具——然后自动执行 pi 自己的 reload。

用它在一个精简会话和一个全副武装的会话之间来回切换，而不必手动改 `settings.json`。

## 特性

- **一条命令，整体切换。** `/switch zen` 关闭技能、扩展、提示模板和自定义主题；`/switch default` 再把它们打开。
- **白名单，不是排除模式。** 配置档只写要保留的东西（`"skills": ["novel-writer"]`），其余全部关掉——不需要写 `!extensions/**` 这种模式。
- **不会卸载任何东西。** 每个配置档都叠加在一份捕获到的*基线*（base）快照之上。被禁用的 pi 包会变成 `{ "source": "...", "autoload": false }` 而不是消失，所以重新启用是瞬间的。
- **不会把自己锁死。** 即使是最严格的配置档，也会保留扩展自身所在的包。
- **可撤销。** 切换被替换掉的设置会记在一个单独的单条文件里（`~/.pi/agent/pi-switch-undo.json`），`/switch restore` 原样恢复并清掉它。
- **会话级切换。** `revertSession` 会在会话开始（默认）或会话结束时把会话换回默认配置，所以一时用的切换不会泄漏到下一个会话。
- **内置配置档。** 首次使用时自动创建 `zen`（零技能、零扩展）和 `default`（基线快照的全部内容）。
- **状态可见。** 底栏显示当前生效的配置档，`/switch` 会打印解析后的配置与逐项变更。如果你之后手动改过 `settings.json`，`/switch` 与 `/switch doctor` 会直接指出这一点，而不是假装配置档仍然生效。
- **自动补全。** 输入 `/switch ` 后按 Tab 会列出配置档名称。

## 安装

安装该包（会把包声明写入 `~/.pi/agent/settings.json`）：

```bash
pi install ./pi-switch-profile
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
| `/switch restore` | 撤销上一次切换（记录在 `~/.pi/agent/pi-switch-undo.json`） |
| `/switch install <目标> [--only <配置档>] [--kind <种类>]` | 装一个包，或把某个资源改成只有指定配置档能加载 |
| `/switch revert-session <start\|end\|off\|status>` | 会话何时回到默认配置（默认 `start`） |
| `/switch delete <profile>` | 删除一个配置档 |
| `/switch doctor` | 显示当前会话真实状态：模型、思考等级、激活与已配置的工具，以及设置是否与当前配置档一致 |
| `/switch help` | 列出全部子命令 |

配置档名称也是命令参数，输入 `/switch ` 后按 Tab 即可补全。

## 配置档

配置档保存在 `~/.pi/agent/pi-switch-profile.json`，项目级的配置档可选放在 `.pi/pi-switch-profile.json`：

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
      "description": "Zen plus one review extension",
      "packages": ["pi-simplify"],
      "extensions": ["review", "builtin:mcp"],
      "skills": ["novel-writer"]
    }
  }
}
```

每个配置档都是叠加在 `base` 之上的覆盖层，只有显式声明的键才会被改动。

| 配置档键 | 写入的设置键 | 含义 |
| --- | --- | --- |
| `packages` | `packages` | 保留启用的包来源白名单（子串匹配，例如 `pi-lens` 能匹配 `npm:pi-lens`）。`base` 中其余的包都会被设为 `autoload: false`。本扩展所在的包始终保留。 |
| `disablePackages` | `packages` | 要禁用的包来源黑名单，其余保持不变。 |
| `exclude` | `packages`、`extensions`、`skills`、`prompts`、`themes` | 要扔掉的东西，按资源类型分开：`{ "extensions": ["review"], "skills": ["archive"] }`。单独用就是“除了这些全都开”；跟同类型的白名单一起用就是在这个白名单里再剔掉。`exclude.packages` 是 `disablePackages` 的别名。 |
| `extensions`、`skills`、`prompts`、`themes` | 同名设置 | **白名单**：写你想保留的东西，一个词（`review`、`novel-writer`）或一个 glob（`extensions/review.ts`、`skills/nov*`）。匹配不到任何东西的就关掉，`[]` 就是“一个都不要”，所以你不需要写排除模式。见[资源白名单](#资源白名单)。 |
| `theme` | `theme` | 主题名称，例如 `system`、`dracula`，或自定义主题名；也可以写 `light/dark` 一对，例如 `terminal/terminal-tinted`。被选中的主题即使它的提供者被关掉也仍然可用——见[主题可用性](#主题可用性)。 |
| `model` | `defaultProvider`、`defaultModel` | 写成 `provider/modelId`，或只写 `modelId`。reload 之后也会作用到当前会话。 |
| `thinkingLevel` | `defaultThinkingLevel` | 可取 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。同样会作用到当前会话。 |
| `tools` | `defaultTools` | 启动时的工具列表。reload 后该列表也会强制应用到当前会话，因此被移除的工具确实会消失。 |
| `extends` | — | 继承另一个配置档；`"base"` 表示基线快照。 |

### 资源白名单

配置档从“空”开始。声明了 `extensions` 就只保留匹配得上的扩展，而没提到的 `skills`、`prompts`、`themes`
也一律关掉——所以配置档写的是你要什么，而不是要排除什么。

两个配置档是例外，因为它们的意思是“你有的全部”：`base`，以及没有声明任何资源覆盖项的 `default`。
这就是 `/switch default` 仍然会把所有东西打开的原因。

- 匹配的对象是 pi 会自动发现的资源：`~/.pi/agent/extensions|skills|prompts|themes`、`~/.agents/skills`，
  以及项目的 `.pi/` 对应目录。技能按目录名匹配（`novel-writer`），文件按名称或路径匹配。
- pi 自带的内置扩展（`mcp`、`codemode`、`tool-search`、`llama.cpp`）不在 `extensions/**` 下面，
  所以白名单要直接点名：写 `builtin:mcp` 就保留，不写就关掉。
- *包*提供的资源跟着 `packages` 白名单走，因为 pi 是用包自己的过滤器筛它们的。要保留某个包的扩展，
  就保留这个包。
- 写进设置的仍然是普通的 pi 条目（`!extensions/**` 加上每个匹配项的 `+extensions/review.ts`），
  所以 `settings.json` 依旧可读可手改，只是这些条目由 `/switch` 生成。
- `/switch save <名称>` 会把当前启用的资源记录成白名单，所以保存下来的配置档能复现当时的状态。
- 旧版本写的配置档（`!pattern`、`+path`、`-path` 列表）会在加载时迁移：原本被保留的项变成白名单，
  只有排除项的列表变成 `[]`。

#### 只排除一个东西

想让某个扩展不在 `default` 里、只在某个配置档里启用，就给 `default` 写 `exclude`——它仍然是“其余全开”，
另一个配置档则列出自己要的东西：

```json
"default": { "exclude": { "extensions": ["review"] } },
"review":  { "packages": ["pi-simplify"], "extensions": ["review", "pi-lens"] }
```

`/switch default` 会加载除 `review` 以外的全部；`/switch review` 只加载它列出的那些。

### 主题可用性

`theme` 和 `themes` 不是同一个开关，而且只有其中一个真的能把主题关掉。

- `~/.pi/agent/themes/<名称>.json` 里的主题始终可用。pi 的主题加载器会直接读这个目录，`/theme` 列表也无视
  `themes` 过滤器把它列出来，所以 `themes: []` 不会弄坏一个本地主题——它只是把这个资源从自动发现的资源列表里藏起来。
- `system`、`dark`、`light` 是 pi 自带的主题，任何配置档都关不掉。
- *包*提供的主题（比如 `pi-terminal-theme` 的 `terminal`）只在这个包加载时存在。`packages` 白名单或者
  `exclude.packages` 把包关掉之后，`theme` 就指向了一个不存在的东西，而 pi 会默默退回系统主题。

所以配置档选中的主题优先级高于会把它关掉的策略。当配置档关掉了提供所选主题的那个包时，这个条目会被保留成
`autoload: false` 加一条强制包含——这正是 pi 自己从一个被禁用的包里只加载一个资源的做法：

```json
{ "source": "npm:pi-terminal-theme", "autoload": false, "themes": ["+themes/terminal.json"] }
```

这个包其余的东西仍然是关着的。`light/dark` 一对会两半都保留。配置档明说的事情优先：`exclude: { "themes": ["terminal"] }`
是一句明确的“这里不要”，会被尊重而不是被覆盖。谁都提供不了的主题（写错了名字，或者包没装）会由
`/switch show`、`/switch list`、`/switch doctor` 以及切换本身的摘要报告出来。

### 只装到某个配置档

pi 自己的 `pi install` 只认一组固定的选项（`-l`、`-a`、`-na`、`-h`，以及 `update` 自己那几个），扩展注册的选项会被拒——`pi.registerFlag()` 只能被正在运行的会话读到。而 pi 本身没有“配置档”这个概念：一个包只存在于 `settings.json` 里。所以归属的判定只能在这里做：

```bash
/switch install npm:pi-simplify --only review          # 装它，并且只让 review 加载
/switch install pi-terminal-theme --only coding,notes  # 给已经装好的包改归属
/switch install skills/novel-writer --only notes       # 给本地技能改归属
/switch install extensions/review.ts                   # 不写 --only：凡是“全开”的配置档都会加载它
```

`<目标>` 是一个包来源（`npm:…`、`git:…`、`http(s):…` 或一个路径），或者一个资源名。裸着的名字会拿去跟自动发现的资源匹配（agent 目录、`~/.agents/skills`、项目的 `.pi/`）：一个都匹配不上就当它是包来源，匹配到多种种类时就必须用 `--kind extensions|skills|prompts|themes|packages` 说清楚是哪一种。

每个配置档都按它本来的写法改，所以安装不会把一个“全开”的配置档变成白名单档：

- 基线配置档（`base`，以及没有资源覆盖项的 `default`）不在 `--only` 里时只多一条 `exclude`；
- 有白名单的配置档被 `--only` 点名时白名单多一项，没被点名时从白名单里去掉并且多一条排除；
- 写成“除了这些全都开”的配置档只是少掉那条排除；
- 从空开始的配置档得到一个正好是目标的白名单。

包条目会写进 `settings.json`，缺少的 `npm:` 或 `git:` 来源在 reload 后的 resolve 过程中由 pi 装好。`/switch restore` 能完整撤销一次安装：设置和配置档映射都回到之前，这也是为什么安装的撤销记录里连配置档一起存。

### 基线、save 与 refresh

`base` 是每个配置档叠加其上的 `settings.json` 快照。请在没有配置档生效时捕获它：

- `/switch save my-setup` 把当前配置记录成一个可以返回的配置档。配置档名称必须能作为 `/switch <name>` 输入，因此 `base` 以及子命令名（`list`、`show`、`save`、`delete`、`refresh`、`restore`、`install`、`revert-session`、`doctor`、`help`）是保留的。
- `/switch refresh` 重新读取 `settings.json` 并更新 `base`。当你希望“启用状态”的快照跟随 `pi config` 的当前结果时执行一次。

### 切换时写入的是什么

配置档会替换它管理的那些设置项。每个受管理的键优先取配置档的值，配置档没定义时取 `base` 快照的值；如果两者都没定义，这个键会从 `settings.json` 中**删除**。这正是 `/switch default` 能撤销 `/switch zen` 的原因：`default` 什么都没定义，而基线快照里没有 `defaultTools`，所以 `zen` 写入的工具列表会被清除，而不是一直留着。`/switch restore` 同理，它写回的是上一次切换前记录的那份确切设置。

`packages` 是唯一跟随当前 `settings.json`（而不是快照）的键：

- 基线快照之后安装的包会被带过来，所以 `/switch default` 会启用它，`/switch zen` 会关掉它。
- 用 `pi remove` 移除的包会被丢弃，切换不会把它写回去（否则 pi 在解析 `npm:` 来源时会重新安装它）。
- 既没有 `packages` 也没有 `disablePackages` 的配置档会启用所有已知的包。`packages` 是白名单，`disablePackages` 是黑名单，两者都支持部分匹配，例如 `pi-lens` 或 `npm:pi-lens`。
- 本扩展始终把自己保持在启用状态。如果配置档能把自己关掉，就只能靠手动改 `settings.json` 才能回来了。

### 回到默认配置

`revertSession` 决定会话什么时候回到默认配置：有 `default` 配置档就用它（所以你自己加了覆盖项的 `default` 就是回去的地方），否则用 `base` 快照并启用所有已知的包。

```bash
/switch revert-session start   # 每个新会话都从默认配置开始（默认）
/switch revert-session end     # 会话结束时把默认配置写回
/switch revert-session off     # 最后一次切换一直保留
/switch revert-session         # 报告当前是哪一种
```

默认是 `start`，因为它能覆盖“会话来不及自己收尾”的情况：如果 pi 被 kill 或者电脑休眠时还挂着某个配置档，下一个会话会把它丢掉。`end` 适合希望会话一结束文件就立刻正确的人。

- 开始时的回退只在设置与默认配置不一致时执行。它会写 `settings.json`、为 `/switch restore` 记下之前的设置，并在当前会话里重新应用默认配置档的工具、模型和思考等级。如果改动涉及包、扩展、技能、提示词或主题（这些在扩展能行动之前就被 pi 解析完了），它还会接着 reload 会话，所以上一个配置档加载的资源会真的消失。只改主题、模型、思考等级或工具时不需要 reload，就地应用。
- 结束时的回退只在真正的会话关闭时执行。`/reload`、`/new`、`/resume`、`/fork` 都不是会话关闭，所以切过去的配置档会一直生效。那时 UI 正在拆掉，所以通知会被存下来，在下一个会话开始时显示。
- 如果设置本来就已经是默认配置，则什么都不写；基线快照还没建立时也不写，所以没有切换过的会话不会动这个文件。
- pi 只会写回它自己改过的设置项，所以退出时写入的回退基本保留，只有会话中 pi 自己改过的键会不一样（例如 `/model` 之后的 `defaultModel`）。剩下的差异可以用 `/switch doctor` 查看。

### 作用范围

`/switch` 写入的是**用户级**设置文件（`~/.pi/agent/settings.json`）。如果项目的 `.pi/settings.json` 声明了 `packages`、`extensions`、`skills`、`prompts` 或 `themes`，项目级的值优先级更高，`/switch` 会就此提醒你。

## 开发

```bash
npm install                  # 只为下面这几个脚本（tsc）；扩展本身不需要依赖
npm test                     # 纯逻辑自检（配置档解析、包策略、设置写入）
npm run test:live            # 实跑冒烟测试：真实 pi 的 RPC 模式，zen、reload 后的工具、save/restore/refresh
npm run check                # 类型检查
```

`selftest.ts` 用 `node --experimental-strip-types` 直接导入 `extensions/switch.ts`，因此不需要 pi 运行时：扩展只导入 pi 的类型。`npm run check` 通过 `tsconfig.json` 的 `paths` 解析这些类型，它们指向已安装的 pi 版本（`~/.pi/agent/install/releases/<version>/node_modules/...`）——pi 会把这些包提供给扩展，所以它们列在 `peerDependencies`，故意不写进 `dependencies`。

`scripts/live-test.mjs` 会把本包安装进已备份的 `~/.pi/agent/settings.json`，启动真实 pi（RPC 模式），切到 `zen`，检查文件与 reload 后的会话（注册的命令、激活的工具、被禁用包的工具是否消失），并跑一遍 save/list/delete/refresh/restore，最后把原始设置和原始配置档存储写回。

## 许可证

MIT — 见 [LICENSE](LICENSE)。

/**
 * pi-switch-config
 *
 * `/switch <profile>` swaps pi's resource configuration (pi packages, extension
 * paths, skill paths, prompt-template paths, theme paths, theme, default model,
 * thinking level, default tools) and then runs pi's own reload.
 *
 * Profiles live in `<agent-dir>/pi-switch-config.json` (plus optional
 * `.pi/pi-switch-config.json` for the project). Every profile is an overlay on
 * top of a captured `base` snapshot of the settings file, so switching is
 * reversible and never uninstalls anything: disabled packages become
 * `{ source, autoload: false }` entries instead of disappearing.
 *
 * This file imports pi types only, so it can be imported by the self-test
 * without loading the pi runtime.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface PackageFilter {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}
export type PackageSource = string | PackageFilter;

/** The settings keys this extension owns. Everything else in settings.json is untouched. */
export interface ManagedSettings {
  packages?: PackageSource[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  theme?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  defaultTools?: string[];
}

export interface Profile {
  description?: string;
  /** Another profile name to overlay on. "base" means the captured base snapshot. */
  extends?: string;
  /** Keep only these package sources enabled (substring match). The extension keeps itself enabled. */
  packages?: string[];
  /** Disable these package sources (substring match). */
  disablePackages?: string[];
  /** Replace the settings.extensions list. Supports pi's `!pattern`, `+path`, `-path` entries. */
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  theme?: string;
  /** "provider/modelId" or "modelId". */
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** settings.defaultTools list. Also enforced on the live session after reload. */
  tools?: string[];
}

export interface Snapshot {
  at: string;
  fromProfile: string | null;
  toProfile: string;
  settings: ManagedSettings;
}

export interface Store {
  version: number;
  base: ManagedSettings;
  activeProfile?: string;
  profiles: Record<string, Profile>;
  history: Snapshot[];
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

export const SELF_PACKAGE_NAME = "pi-switch-config";
export const STORE_FILE_NAME = "pi-switch-config.json";
export const SETTINGS_FILE_NAME = "settings.json";
export const PROJECT_DIR_NAME = ".pi";
const BASE_PROFILE_NAME = "base";
const MAX_HISTORY = 12;

export function getAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(expandTilde(fromEnv));
  return join(homedir(), ".pi", "agent");
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/** Package root that contains this extension file. */
export function selfPackageRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/* -------------------------------------------------------------------------- */
/* JSON helpers                                                                */
/* -------------------------------------------------------------------------- */

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write: tmp file in the same directory, then rename. */
function writeJsonFile(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basenameForTmp(path)}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function basenameForTmp(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name || "pi-switch-config";
}

/* -------------------------------------------------------------------------- */
/* Managed settings                                                            */
/* -------------------------------------------------------------------------- */

const MANAGED_KEYS = [
  "packages",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "theme",
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "defaultTools",
] as const;

export function captureManagedSettings(settingsFile: Record<string, unknown> | undefined): ManagedSettings {
  const managed: ManagedSettings = {};
  if (!settingsFile) return managed;
  for (const key of MANAGED_KEYS) {
    const value = settingsFile[key];
    if (value === undefined) continue;
    (managed as Record<string, unknown>)[key] = structuredClone(value);
  }
  return managed;
}

/**
 * Merge managed keys into settings.json without touching any other key.
 * Returns the managed values that were in the file before the write.
 */
export function writeManagedSettings(settingsPath: string, managed: ManagedSettings): ManagedSettings {
  const current = readJsonFile(settingsPath) ?? {};
  const previous = captureManagedSettings(current);
  const next: Record<string, unknown> = { ...current };
  for (const key of MANAGED_KEYS) {
    const value = (managed as Record<string, unknown>)[key];
    // undefined means "this profile does not manage this key": keep the file value.
    // Managed keys are never deleted, so switching profiles is lossless.
    if (value === undefined) continue;
    next[key] = value;
  }
  writeJsonFile(settingsPath, next);
  return previous;
}

export function packageSourceString(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

export function packageIsDisabled(entry: PackageSource): boolean {
  return typeof entry === "object" && entry.autoload === false;
}

/** Substring / exact / glob-lite match against a package source. */
export function packageSourceMatches(entry: PackageSource, pattern: string): boolean {
  const source = packageSourceString(entry);
  const needle = pattern.trim();
  if (!needle) return false;
  if (source === needle) return true;
  if (source.toLowerCase() === needle.toLowerCase()) return true;
  // Allow "pi-lens" to match "npm:pi-lens" or "git:github.com/org/pi-lens@v1".
  if (source.toLowerCase().includes(needle.toLowerCase())) return true;
  const bare = source.replace(/^(npm|git|https?):/, "").split("@")[0];
  if (bare === needle || bare.toLowerCase() === needle.toLowerCase()) return true;
  if (bare.toLowerCase().endsWith(`/${needle.toLowerCase()}`)) return true;
  return false;
}

export function isSelfPackageSource(entry: PackageSource, settingsBaseDir: string, packageRoot: string): boolean {
  const source = packageSourceString(entry);
  if (source.includes(SELF_PACKAGE_NAME)) return true;
  if (/^(npm|git|https?):/.test(source)) return false;
  const resolved = isAbsolute(source) ? resolve(source) : resolve(settingsBaseDir, expandTilde(source));
  return resolved === packageRoot || resolved.startsWith(`${packageRoot}/`);
}

export function applyPackagePolicy(
  basePackages: PackageSource[] | undefined,
  profile: Profile,
  options: { settingsBaseDir: string; packageRoot: string },
): PackageSource[] | undefined {
  const list = (basePackages ?? []).map((entry) => entry);
  if (profile.packages === undefined && profile.disablePackages === undefined) return basePackages;

  const keep = profile.packages;
  const drop = profile.disablePackages ?? [];

  return list.map((entry) => {
    if (isSelfPackageSource(entry, options.settingsBaseDir, options.packageRoot)) return entry;
    if (keep !== undefined && !keep.some((pattern) => packageSourceMatches(entry, pattern))) {
      return { source: packageSourceString(entry), autoload: false };
    }
    if (drop.some((pattern) => packageSourceMatches(entry, pattern))) {
      return { source: packageSourceString(entry), autoload: false };
    }
    return entry;
  });
}

export function parseModelSpec(spec: string): { provider?: string; modelId: string } {  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return { modelId: trimmed };
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

export function resolveProfile(
  name: string,
  profiles: Record<string, Profile>,
): { profile: Profile; chain: string[] } {
  const chain: string[] = [];
  const merged: ManagedSettings & Profile = {};
  const visiting = new Set<string>();

  const visit = (profileName: string, depth: number): void => {
    if (profileName === BASE_PROFILE_NAME) return;
    if (visiting.has(profileName)) throw new Error(`Profile extends cycle at "${profileName}"`);
    if (depth > 10) throw new Error(`Profile extends chain too deep at "${profileName}"`);
    const profile = profiles[profileName];
    if (!profile) throw new Error(`Unknown profile: ${profileName}`);
    visiting.add(profileName);
    // Parents first so the child overrides them.
    if (profile.extends !== undefined) visit(profile.extends, depth + 1);
    chain.push(profileName);
    Object.assign(merged, mergeProfileOverlay(merged, profile));
    visiting.delete(profileName);
  };

  visit(name, 0);
  return { profile: merged, chain };
}

function mergeProfileOverlay(target: ManagedSettings & Profile, profile: Profile): ManagedSettings & Profile {
  const out: ManagedSettings & Profile = { ...target };
  for (const key of ["extensions", "skills", "prompts", "themes", "theme", "model", "thinkingLevel", "tools", "packages", "disablePackages"] as const) {
    const value = profile[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function buildProfileSettings(
  base: ManagedSettings,
  profile: Profile,
  options: { settingsBaseDir: string; packageRoot: string },
): ManagedSettings {
  const next: ManagedSettings = {};
  next.packages = applyPackagePolicy(base.packages, profile, options);
  next.extensions = profile.extensions ?? base.extensions;
  next.skills = profile.skills ?? base.skills;
  next.prompts = profile.prompts ?? base.prompts;
  next.themes = profile.themes ?? base.themes;
  next.theme = profile.theme ?? base.theme;
  next.defaultThinkingLevel = profile.thinkingLevel ?? base.defaultThinkingLevel;
  next.defaultTools = profile.tools ?? base.defaultTools;

  if (profile.model === undefined) {
    next.defaultProvider = base.defaultProvider;
    next.defaultModel = base.defaultModel;
  } else {
    const spec = parseModelSpec(profile.model);
    next.defaultProvider = spec.provider ?? base.defaultProvider;
    next.defaultModel = spec.modelId;
  }
  return next;
}

/* -------------------------------------------------------------------------- */
/* Profile summaries                                                           */
/* -------------------------------------------------------------------------- */

function modelSpecFromSettings(settings: ManagedSettings): string | undefined {
  const modelId = settings.defaultModel;
  if (modelId === undefined) return undefined;
  if (settings.defaultProvider === undefined) return modelId;
  return `${settings.defaultProvider}/${modelId}`;
}

export function summarizeSettings(settings: ManagedSettings): string[] {
  const lines: string[] = [];
  const packages = settings.packages ?? [];
  const enabled = packages.filter((entry) => !packageIsDisabled(entry)).map(packageSourceString);
  const disabled = packages.filter(packageIsDisabled).map(packageSourceString);
  lines.push(`packages: ${enabled.length} enabled${disabled.length ? `, ${disabled.length} disabled` : ""}`);
  if (enabled.length > 0) lines.push(`  on: ${enabled.join(", ")}`);
  if (disabled.length > 0) lines.push(`  off: ${disabled.join(", ")}`);
  for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
    const value = settings[key];
    if (value === undefined) {
      lines.push(`${key}: (default discovery)`);
    } else if (value.length === 0) {
      lines.push(`${key}: []`);
    } else {
      lines.push(`${key}: ${value.join(", ")}`);
    }
  }
  lines.push(`theme: ${settings.theme ?? "(default)"}`);
  lines.push(`model: ${settings.defaultProvider ? `${settings.defaultProvider}/` : ""}${settings.defaultModel ?? "(default)"}`);
  lines.push(`thinking: ${settings.defaultThinkingLevel ?? "(default)"}`);
  lines.push(`tools: ${settings.defaultTools ? settings.defaultTools.join(", ") : "(default)"}`);
  return lines;
}

export function diffSettings(before: ManagedSettings, after: ManagedSettings): string[] {
  const changes: string[] = [];
  const beforePackages = before.packages ?? [];
  const afterPackages = after.packages ?? [];
  const beforeOn = new Set(beforePackages.filter((e) => !packageIsDisabled(e)).map(packageSourceString));
  const afterOn = new Set(afterPackages.filter((e) => !packageIsDisabled(e)).map(packageSourceString));
  for (const source of afterOn) if (!beforeOn.has(source)) changes.push(`package on: ${source}`);
  for (const source of beforeOn) if (!afterOn.has(source)) changes.push(`package off: ${source}`);
  for (const key of ["extensions", "skills", "prompts", "themes", "theme", "defaultProvider", "defaultModel", "defaultThinkingLevel", "defaultTools"] as const) {
    const a = (before as Record<string, unknown>)[key];
    const b = (after as Record<string, unknown>)[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    changes.push(`${key}: ${formatValue(a)} -> ${formatValue(b)}`);
  }
  return changes;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.map((v) => String(v)).join(", ")}]`;
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export function seedProfiles(): Record<string, Profile> {
  return {
    zen: {
      description: "Zero skills, zero extensions: pi packages off, auto-discovered resources off, built-in extras off",
      packages: [],
      extensions: ["!extensions/**", "-builtin:mcp", "-builtin:llama.cpp", "-builtin:codemode", "-builtin:tool-search"],
      skills: ["!skills/**"],
      prompts: ["!prompts/**"],
      themes: ["!themes/**"],
      theme: "system",
      thinkingLevel: "low",
      tools: ["read", "bash", "edit", "write"],
    },
    coder: {
      description: "Everything from the base snapshot (no overrides)",
    },
  };
}

export function storePath(agentDir: string, cwd: string): { global: string; project: string } {
  return {
    global: join(agentDir, STORE_FILE_NAME),
    project: join(cwd, PROJECT_DIR_NAME, STORE_FILE_NAME),
  };
}

export function loadStore(agentDir: string, cwd: string): Store {
  const paths = storePath(agentDir, cwd);
  const globalStore = readJsonFile(paths.global) as Store | undefined;
  const projectStore = readJsonFile(paths.project) as Store | undefined;

  const store: Store = {
    version: 1,
    base: (globalStore?.base as ManagedSettings | undefined) ?? {},
    activeProfile: globalStore?.activeProfile,
    profiles: {
      ...(globalStore === undefined ? seedProfiles() : (globalStore.profiles ?? {})),
      ...(projectStore?.profiles ?? {}),
    },
    history: Array.isArray(globalStore?.history) ? globalStore.history : [],
  };
  if (!store.profiles[BASE_PROFILE_NAME]) {
    store.profiles = { [BASE_PROFILE_NAME]: { description: "The captured base configuration" }, ...store.profiles };
  }
  return store;
}

export function saveStore(store: Store, agentDir: string): void {
  const path = join(agentDir, STORE_FILE_NAME);
  const existing = readJsonFile(path) ?? {};
  const next: Record<string, unknown> = {
    ...existing,
    version: 1,
    base: store.base,
    activeProfile: store.activeProfile,
    profiles: store.profiles,
    history: store.history.slice(-MAX_HISTORY),
  };
  writeJsonFile(path, next);
}

export function profileNames(store: Store): string[] {
  return Object.keys(store.profiles).sort((a, b) => {
    if (a === BASE_PROFILE_NAME) return -1;
    if (b === BASE_PROFILE_NAME) return 1;
    return a.localeCompare(b);
  });
}

/* -------------------------------------------------------------------------- */
/* Extension                                                                   */
/* -------------------------------------------------------------------------- */

const SUBCOMMANDS = ["list", "show", "save", "delete", "refresh", "restore", "help"] as const;

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const packageRoot = selfPackageRoot();

  pi.registerCommand("switch", {
    description: "Switch pi configuration profiles (packages, extensions, skills, themes) and reload",
    getArgumentCompletions: (argumentPrefix: string) => {
      const store = loadStore(agentDir, process.cwd());
      const names = [...profileNames(store), ...SUBCOMMANDS.filter((s) => s !== "list")];
      const prefix = (argumentPrefix ?? "").trim().toLowerCase();
      const items = names
        .filter((name) => name !== "help")
        .filter((name) => prefix.length === 0 || name.toLowerCase().startsWith(prefix))
        .map((name) => {
          const profile = store.profiles[name];
          const description = profile?.description ?? (SUBCOMMANDS.includes(name as (typeof SUBCOMMANDS)[number]) ? name : "");
          return { value: name, label: `${name}${description ? ` - ${description}` : ""}` };
        });
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        await handleSwitch(args, ctx, agentDir, packageRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/switch: ${message}`, "error");
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const store = loadStore(agentDir, ctx.cwd);
    const active = store.activeProfile;
    if (!active) {
      ctx.ui.setStatus("pi-switch-config", undefined);
      return;
    }
    let profile: Profile;
    try {
      profile = resolveProfile(active, store.profiles).profile;
    } catch {
      ctx.ui.setStatus("pi-switch-config", `profile ${active} (broken)`);
      return;
    }
    ctx.ui.setStatus("pi-switch-config", `profile: ${active}`);
    // Only re-apply after a reload triggered by /switch. On a fresh session pi
    // already applies defaultTools / defaultModel / defaultThinkingLevel itself.
    if (event.reason === "reload") applyRuntimeProfile(pi, ctx, profile);
  });
}

function applyRuntimeProfile(pi: ExtensionAPI, ctx: ExtensionContext, profile: Profile): void {
  if (profile.tools !== undefined) {
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const wanted = profile.tools.filter((name) => registered.has(name));
    pi.setActiveTools(wanted);
  }
  if (profile.thinkingLevel !== undefined) {
    pi.setThinkingLevel(profile.thinkingLevel);
  }
  if (profile.model !== undefined) {
    const spec = parseModelSpec(profile.model);
    const available = ctx.modelRegistry.getAvailable();
    let model = spec.provider ? ctx.modelRegistry.find(spec.provider, spec.modelId) : undefined;
    if (model === undefined) model = available.find((candidate) => candidate.id === spec.modelId);
    if (model) {
      const ok = pi.setModel(model);
      // setModel is async; fire and report failures through the next notify below.
      void Promise.resolve(ok).then((applied) => {
        if (!applied) ctx.ui.notify(`/switch: no credentials configured for ${spec.provider ?? ""}/${spec.modelId}`, "warning");
      });
    } else {
      ctx.ui.notify(`/switch: model not found: ${profile.model}`, "warning");
    }
  }
}

async function handleSwitch(
  args: string,
  ctx: ExtensionCommandContext,
  agentDir: string,
  packageRoot: string,
): Promise<void> {
  const tokens = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  const store = loadStore(agentDir, ctx.cwd);
  const settingsPath = join(agentDir, SETTINGS_FILE_NAME);
  const currentSettings = captureManagedSettings(readJsonFile(settingsPath));

  const sub = tokens[0];

  if (sub === "help") {
    ctx.ui.notify(
      [
        "/switch                    current profile and profile list",
        "/switch <profile>          apply a profile, then reload",
        "/switch list               profile list",
        "/switch show <profile>     resolved profile + diff, no change",
        "/switch save <profile>     capture the current settings as a profile",
        "/switch refresh            re-capture the base snapshot from settings.json",
        "/switch restore            undo the last switch",
        "/switch delete <profile>   remove a profile",
      ].join("\n"),
      "info",
    );
    return;
  }

  if (sub === undefined || sub === "list") {
    const names = profileNames(store);
    const lines = [
      `active profile: ${store.activeProfile ?? "(none)"}`,
      "",
      ...names.map((name) => {
        const description = store.profiles[name]?.description;
        return description ? `${name} - ${description}` : name;
      }),
      "",
      "Current configuration:",
      ...summarizeSettings(currentSettings),
    ];
    showLong(ctx, lines);
    return;
  }

  if (sub === "refresh") {
    store.base = currentSettings;
    if (store.activeProfile) {
      ctx.ui.notify(`/switch: base captured while profile "${store.activeProfile}" is active; switch back first for a clean base`, "warning");
    }
    saveStore(store, agentDir);
    ctx.ui.notify("/switch refresh: base snapshot updated from settings.json", "info");
    return;
  }

  if (sub === "restore") {
    const snapshot = store.history[store.history.length - 1];
    if (!snapshot) {
      ctx.ui.notify("/switch restore: nothing to restore", "warning");
      return;
    }
    store.history = store.history.slice(0, -1);
    const changes = diffSettings(currentSettings, snapshot.settings);
    writeManagedSettings(settingsPath, snapshot.settings);
    store.activeProfile = snapshot.fromProfile ?? undefined;
    saveStore(store, agentDir);
    await reloadWithSummary(ctx, `restored ${snapshot.fromProfile ?? "previous configuration"}`, changes);
    return;
  }

  if (sub === "save") {
    const name = tokens[1];
    if (!name) {
      ctx.ui.notify("/switch save <profile>: missing profile name", "error");
      return;
    }
    if (name === BASE_PROFILE_NAME) {
      ctx.ui.notify("/switch save: 'base' is reserved (use /switch refresh)", "error");
      return;
    }
    const enabledPackages = (currentSettings.packages ?? [])
      .filter((entry) => !packageIsDisabled(entry))
      .map(packageSourceString);
    const profile: Profile = {
      description: `Saved ${new Date().toISOString()}`,
      packages: enabledPackages,
      extensions: currentSettings.extensions,
      skills: currentSettings.skills,
      prompts: currentSettings.prompts,
      themes: currentSettings.themes,
      theme: currentSettings.theme,
      thinkingLevel: currentSettings.defaultThinkingLevel as Profile["thinkingLevel"],
      tools: currentSettings.defaultTools,
      model: modelSpecFromSettings(currentSettings),
    };
    store.profiles[name] = profile;
    saveStore(store, agentDir);
    ctx.ui.notify(`/switch save: saved profile "${name}" from the current settings`, "info");
    return;
  }

  if (sub === "delete") {
    const name = tokens[1];
    if (!name) {
      ctx.ui.notify("/switch delete <profile>: missing profile name", "error");
      return;
    }
    if (name === BASE_PROFILE_NAME) {
      ctx.ui.notify("/switch delete: 'base' cannot be deleted", "error");
      return;
    }
    if (!store.profiles[name]) {
      ctx.ui.notify(`/switch delete: unknown profile "${name}"`, "error");
      return;
    }
    delete store.profiles[name];
    if (store.activeProfile === name) store.activeProfile = undefined;
    saveStore(store, agentDir);
    ctx.ui.notify(`/switch delete: removed profile "${name}"`, "info");
    return;
  }

  const name = sub;
  let resolved: { profile: Profile; chain: string[] };
  try {
    resolved = resolveProfile(name, store.profiles);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const known = profileNames(store).join(", ");
    ctx.ui.notify(`/switch: ${message}. Known profiles: ${known}`, "error");
    return;
  }

  const nextSettings = buildProfileSettings(store.base, resolved.profile, {
    settingsBaseDir: agentDir,
    packageRoot,
  });
  const changes = diffSettings(currentSettings, nextSettings);

  if (sub === "show") {
    const lines = [
      `profile: ${resolved.chain.join(" + ") || BASE_PROFILE_NAME}`,
      resolved.profile.description ? resolved.profile.description : "",
      "",
      "Resolved configuration:",
      ...summarizeSettings(nextSettings),
      "",
      "Changes vs current:",
      ...(changes.length > 0 ? changes.map((change) => `  ${change}`) : ["  (none)"]),
    ].filter((line) => line !== "");
    showLong(ctx, lines);
    return;
  }

  // Guard: project-level settings can shadow the global values we are writing.
  const projectSettingsPath = join(ctx.cwd, PROJECT_DIR_NAME, SETTINGS_FILE_NAME);
  const projectSettings = captureManagedSettings(readJsonFile(projectSettingsPath));
  const shadowed = MANAGED_KEYS.filter(
    (key) => (projectSettings as Record<string, unknown>)[key] !== undefined && key !== "theme",
  );
  if (shadowed.length > 0) {
    ctx.ui.notify(`/switch: project .pi/settings.json overrides ${shadowed.join(", ")}; those values win`, "warning");
  }

  const previous = writeManagedSettings(settingsPath, nextSettings);
  store.history = [...store.history, {
    at: new Date().toISOString(),
    fromProfile: store.activeProfile ?? null,
    toProfile: name,
    settings: previous,
  }].slice(-MAX_HISTORY);
  store.activeProfile = name;
  saveStore(store, agentDir);

  await reloadWithSummary(ctx, `profile "${name}"`, changes);
}

async function reloadWithSummary(ctx: ExtensionCommandContext, label: string, changes: string[]): Promise<void> {
  if (ctx.isIdle() === false) {
    await ctx.waitForIdle();
  }
  // Nothing after reload() may reuse state from the previous extension runtime.
  await ctx.reload();
  ctx.ui.setStatus("pi-switch-config", `applied ${label}`);
  const summary = changes.length > 0 ? changes : ["(no settings changes)"];
  showLong(ctx, [`/switch: ${label}`, ...summary.map((change) => `  ${change}`)]);
}

/** Notifications are single-shot toasts; a widget is used for long output in the TUI. */
function showLong(ctx: ExtensionCommandContext, lines: string[]): void {
  if (ctx.mode === "tui" && lines.length > 6) {
    ctx.ui.setWidget("pi-switch-config", lines, { placement: "aboveEditor" });
    clearWidgetLater(ctx);
    ctx.ui.notify("/switch: details shown above the editor", "info");
    return;
  }
  // RPC/JSON/print modes have no widgets: send everything as chunked notifications.
  for (let index = 0; index < lines.length; index += 8) {
    ctx.ui.notify(lines.slice(index, index + 8).join("\n"), "info");
  }
}

const WIDGET_TTL_MS = 25_000;
let widgetTimer: ReturnType<typeof setTimeout> | undefined;

function clearWidgetLater(ctx: ExtensionCommandContext): void {
  if (widgetTimer !== undefined) clearTimeout(widgetTimer);
  widgetTimer = setTimeout(() => {
    widgetTimer = undefined;
    try {
      ctx.ui.setWidget("pi-switch-config", undefined);
    } catch {
      // Runtime may already be gone (reload/shutdown).
    }
  }, WIDGET_TTL_MS);
}

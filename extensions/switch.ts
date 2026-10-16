/**
 * pi-switch-profile
 *
 * `/switch <profile>` swaps pi's resource configuration (pi packages, extension
 * paths, skill paths, prompt-template paths, theme paths, theme, default model,
 * thinking level, default tools) and then runs pi's own reload.
 *
 * Profiles live in `<agent-dir>/pi-switch-profile.json` (plus optional
 * `.pi/pi-switch-profile.json` for the project). Every profile is an overlay on
 * top of a captured `base` snapshot of the settings file, so switching is
 * reversible and never uninstalls anything: disabled packages become
 * `{ source, autoload: false }` entries instead of disappearing.
 *
 * This file imports pi types only, so it can be imported by the self-test
 * without loading the pi runtime.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /** When the session should end on the default configuration. Defaults to "start". */
  revertSession?: RevertSessionMode;
  /** Set when a revert at session close actually changed settings; reported at the next session start. */
  revertedOnQuit?: RevertNotice;
}

export type RevertSessionMode = "start" | "end" | "off";

export interface RevertNotice {
  at: string;
  fromProfile: string | null;
  changes: string[];
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

export const SELF_PACKAGE_NAME = "pi-switch-profile";
/** The name this package had before it was renamed; still matched for self-detection. */
export const LEGACY_SELF_PACKAGE_NAMES = ["pi-switch-config"];
export const STORE_FILE_NAME = "pi-switch-profile.json";
/** Store file name written by older versions. */
export const LEGACY_STORE_FILE_NAME = "pi-switch-config.json";
export const SETTINGS_FILE_NAME = "settings.json";
export const PROJECT_DIR_NAME = ".pi";
const BASE_PROFILE_NAME = "base";
const DEFAULT_PROFILE_NAME = "default";
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

/**
 * A file we could not parse is about to be replaced. Keep the bytes: an unreadable
 * settings.json is still the user's file, and rewriting it over would lose it.
 */
function preserveUnparseable(path: string): void {
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return;
  } catch {
    // Not JSON: keep a copy before the write below replaces it.
  }
  try {
    copyFileSync(path, `${path}.corrupt.bak`);
  } catch {
    // A failed backup must not block the write.
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
  return name || "pi-switch-profile";
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
  preserveUnparseable(settingsPath);
  const current = readJsonFile(settingsPath) ?? {};
  const previous = captureManagedSettings(current);
  const next: Record<string, unknown> = { ...current };
  for (const key of MANAGED_KEYS) {
    const value = (managed as Record<string, unknown>)[key];
    // A managed key with no value is cleared: switching profiles has to be able to
    // remove what an earlier profile wrote, otherwise `restore` is not an undo and a
    // profile without an override keeps the previous profile's value forever.
    if (value === undefined) {
      delete next[key];
      continue;
    }
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
  // An install that still points at the old package name or checkout directory is the
  // same extension, and disabling it would take /switch with it.
  if (LEGACY_SELF_PACKAGE_NAMES.some((name) => source.includes(name))) return true;
  if (/^(npm|git|https?):/.test(source)) return false;
  const resolved = isAbsolute(source) ? resolve(source) : resolve(settingsBaseDir, expandTilde(source));
  return resolved === packageRoot || resolved.startsWith(`${packageRoot}/`);
}

/**
 * The known package set follows settings.json; a profile only decides which of
 * them are enabled.
 *
 * - An entry in base that is no longer in settings counts as removed and is dropped,
 *   so `pi remove` is not undone by the next switch.
 * - An entry in settings that base never saw (installed after the base snapshot) is
 *   carried over so profiles can enable or disable it too.
 * - A user-authored resource filter in settings is kept over the base form.
 */
export function mergePackageSets(
  base: PackageSource[] | undefined,
  current: PackageSource[] | undefined,
): PackageSource[] {
  const baseEntries = base ?? [];
  const currentEntries = current ?? [];
  const currentBySource = new Map<string, PackageSource>();
  for (const entry of currentEntries) currentBySource.set(packageSourceString(entry), entry);

  const merged: PackageSource[] = [];
  const seen = new Set<string>();
  for (const entry of baseEntries) {
    const source = packageSourceString(entry);
    if (seen.has(source)) continue;
    const currentEntry = currentBySource.get(source);
    if (currentEntry === undefined) continue;
    merged.push(hasResourceFilter(currentEntry) ? currentEntry : entry);
    seen.add(source);
  }
  for (const entry of currentEntries) {
    const source = packageSourceString(entry);
    if (seen.has(source)) continue;
    merged.push(entry);
    seen.add(source);
  }
  return merged;
}

function hasResourceFilter(entry: PackageSource): boolean {
  if (typeof entry !== "object") return false;
  return entry.extensions !== undefined || entry.skills !== undefined || entry.prompts !== undefined || entry.themes !== undefined;
}

/** Drop `autoload: false` so the profile policy alone decides enablement. */
function enabledForm(entry: PackageSource): PackageSource {
  if (typeof entry === "string") return entry;
  const filter: PackageFilter = {
    source: entry.source,
    ...(entry.extensions !== undefined ? { extensions: entry.extensions } : undefined),
    ...(entry.skills !== undefined ? { skills: entry.skills } : undefined),
    ...(entry.prompts !== undefined ? { prompts: entry.prompts } : undefined),
    ...(entry.themes !== undefined ? { themes: entry.themes } : undefined),
  };
  return filter.extensions === undefined && filter.skills === undefined && filter.prompts === undefined && filter.themes === undefined
    ? entry.source
    : filter;
}

export function applyPackagePolicy(
  templates: PackageSource[],
  profile: Profile,
  options: { settingsBaseDir: string; packageRoot: string },
): PackageSource[] {
  const keep = profile.packages;
  const drop = profile.disablePackages ?? [];
  const hasPolicy = keep !== undefined || drop.length > 0;

  return templates.map((entry) => {
    // This extension must survive even the strictest profile, or there is no way back.
    if (isSelfPackageSource(entry, options.settingsBaseDir, options.packageRoot)) return enabledForm(entry);
    if (hasPolicy === false) return enabledForm(entry);
    const whitelisted = keep === undefined || keep.some((pattern) => packageSourceMatches(entry, pattern));
    const blacklisted = drop.some((pattern) => packageSourceMatches(entry, pattern));
    if (whitelisted && !blacklisted) return enabledForm(entry);
    return { source: packageSourceString(entry), autoload: false };
  });
}

export function parseModelSpec(spec: string): { provider?: string; modelId: string } {
  const trimmed = spec.trim();
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
  currentSettings: ManagedSettings | undefined,
): ManagedSettings {
  const current = currentSettings ?? {};
  const next: ManagedSettings = {};
  next.packages = applyPackagePolicy(mergePackageSets(base.packages, current.packages), profile, options);
  // Precedence: profile > base snapshot. Packages are the exception (see
  // mergePackageSets) because pi install/remove change them out of band; every other
  // managed key comes from the profile or the snapshot, so a key neither defines is
  // cleared rather than left holding an earlier profile's value.
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

export function detectDrift(
  store: Store,
  currentSettings: ManagedSettings,
  options: { settingsBaseDir: string; packageRoot: string },
): { profile: string; changes: string[] } | undefined {
  if (store.activeProfile === undefined) return undefined;
  let resolved: { profile: Profile; chain: string[] };
  try {
    resolved = resolveProfile(store.activeProfile, store.profiles);
  } catch {
    return undefined;
  }
  const expected = buildProfileSettings(store.base, resolved.profile, options, currentSettings);
  const changes = diffSettings(currentSettings, expected);
  if (changes.length === 0) return undefined;
  return { profile: store.activeProfile, changes };
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
    [DEFAULT_PROFILE_NAME]: {
      description: "Everything from the base snapshot (no overrides)",
    },
  };
}

/**
 * Seeded profiles that were renamed. A store written by an older version keeps the old
 * name, so it is migrated on load - but only the seeded shape (a description and nothing
 * else), never a real profile the user built and happened to call `coder`.
 */
const LEGACY_SEED_PROFILES: Record<string, string> = { coder: DEFAULT_PROFILE_NAME };

export function migrateLegacyProfiles(profiles: Record<string, Profile>): {
  profiles: Record<string, Profile>;
  renamed: Array<{ from: string; to: string }>;
} {
  const out: Record<string, Profile> = { ...profiles };
  const renamed: Array<{ from: string; to: string }> = [];
  for (const [legacy, replacement] of Object.entries(LEGACY_SEED_PROFILES)) {
    const entry = out[legacy];
    if (entry === undefined) continue;
    if (out[replacement] !== undefined) continue;
    const overrides = Object.keys(entry).filter((key) => key !== "description");
    if (overrides.length > 0) continue;
    out[replacement] = entry;
    delete out[legacy];
    renamed.push({ from: legacy, to: replacement });
  }
  return { profiles: out, renamed };
}

export function storePath(agentDir: string, cwd: string): { global: string; project: string } {
  return {
    global: join(agentDir, STORE_FILE_NAME),
    project: join(cwd, PROJECT_DIR_NAME, STORE_FILE_NAME),
  };
}

/**
 * Rename the store file an older version wrote, so an existing base snapshot, profiles,
 * history, and revert options survive the package rename. When both names exist the new
 * file wins and the old one is left alone (nothing is deleted).
 */
export function migrateStoreFile(path: string, legacyPath: string): boolean {
  if (path === legacyPath) return false;
  if (existsSync(path) || !existsSync(legacyPath)) return false;
  try {
    renameSync(legacyPath, path);
    return true;
  } catch {
    return false;
  }
}

export function loadStore(agentDir: string, cwd: string): Store {
  const paths = storePath(agentDir, cwd);
  migrateStoreFile(paths.global, join(agentDir, LEGACY_STORE_FILE_NAME));
  migrateStoreFile(paths.project, join(cwd, PROJECT_DIR_NAME, LEGACY_STORE_FILE_NAME));
  const globalStore = readJsonFile(paths.global) as Store | undefined;
  const projectStore = readJsonFile(paths.project) as Store | undefined;

  const migrated = migrateLegacyProfiles({
    ...(globalStore === undefined ? seedProfiles() : (globalStore.profiles ?? {})),
    ...(projectStore?.profiles ?? {}),
  });
  const renamed = new Map(migrated.renamed.map(({ from, to }) => [from, to]));
  const recordedActive = globalStore?.activeProfile;

  const store: Store = {
    version: 1,
    base: (globalStore?.base as ManagedSettings | undefined) ?? {},
    // An active profile that the migration renamed has to follow it, or the footer and
    // drift detection would point at a profile that is no longer in the list.
    activeProfile: recordedActive !== undefined && renamed.has(recordedActive) ? renamed.get(recordedActive) : recordedActive,
    profiles: migrated.profiles,
    history: Array.isArray(globalStore?.history) ? globalStore.history : [],
    revertSession: parseRevertSessionMode(globalStore),
    revertedOnQuit: parseRevertNotice(globalStore?.revertedOnQuit),
  };
  if (!store.profiles[BASE_PROFILE_NAME]) {
    store.profiles = { [BASE_PROFILE_NAME]: { description: "The captured base configuration" }, ...store.profiles };
  }
  return store;
}

export function saveStore(store: Store, agentDir: string): void {
  const path = join(agentDir, STORE_FILE_NAME);
  preserveUnparseable(path);
  const existing = readJsonFile(path) ?? {};
  const next: Record<string, unknown> = {
    ...existing,
    version: 1,
    base: store.base,
    activeProfile: store.activeProfile,
    profiles: store.profiles,
    history: store.history.slice(-MAX_HISTORY),
    revertSession: store.revertSession,
    revertedOnQuit: store.revertedOnQuit,
  };
  writeJsonFile(path, next);
}

/**
 * A fresh store has no base yet: capture whatever settings.json holds right now,
 * because no profile has been applied on top of it.
 * Returns true when the base was captured.
 */
export function ensureBase(store: Store, currentSettings: ManagedSettings): boolean {
  if (Object.keys(store.base).length > 0) return false;
  store.base = currentSettings;
  return true;
}

export function profileNames(store: Store): string[] {
  return Object.keys(store.profiles).sort((a, b) => {
    if (a === BASE_PROFILE_NAME) return -1;
    if (b === BASE_PROFILE_NAME) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Profiles worth showing. `base` is the snapshot every profile overlays, not something
 * you pick from a list, so it stays out of the listing and the completion menu even
 * though `/switch base` still works.
 */
export function switchableProfileNames(store: Store): string[] {
  return profileNames(store).filter((name) => name !== BASE_PROFILE_NAME);
}

/** How an error should name the targets that would have worked. */
export function knownProfilesHint(store: Store): string {
  const named = switchableProfileNames(store);
  return [...named, `${BASE_PROFILE_NAME} (the base snapshot)`].join(", ");
}

/* -------------------------------------------------------------------------- */
/* Extension                                                                   */
/* -------------------------------------------------------------------------- */

const SUBCOMMANDS = ["list", "show", "save", "delete", "refresh", "restore", "revert-session", "doctor", "help"] as const;

/**
 * A profile name must be typeable as `/switch <name>`, so it may not collide with a
 * subcommand, and it may not be the reserved `base`.
 */
export function validateNewProfileName(name: string): string | undefined {
  if (name === BASE_PROFILE_NAME) return "'base' is reserved (use /switch refresh)";
  if ((SUBCOMMANDS as readonly string[]).includes(name)) return `"${name}" is a subcommand, so a profile with that name could never be switched to`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return `"${name}" is not a usable profile name (letters, digits, dot, dash, underscore, starting with a letter or digit)`;
  return undefined;
}

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const packageRoot = selfPackageRoot();

  pi.registerCommand("switch", {
    description: "Switch pi configuration profiles (packages, extensions, skills, themes) and reload",
    getArgumentCompletions: (argumentPrefix: string) => {
      const store = loadStore(agentDir, process.cwd());
      const names = [...switchableProfileNames(store), ...SUBCOMMANDS.filter((s) => s !== "list")];
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
        await handleSwitch(pi, args, ctx, agentDir, packageRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/switch: ${message}`, "error");
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    // revertSession "start": a profile that survived a killed session is put back before
    // this session does any work.
    if (event.reason === "startup") {
      try {
        const reverted = applySessionRevert(agentDir, packageRoot, ctx.cwd, "start");
        if (reverted !== undefined) {
          const restored = resolveProfile(reverted.profileLabel, loadStore(agentDir, ctx.cwd).profiles).profile;
          applyRuntimeProfile(pi, ctx, restored);
          ctx.ui.notify(
            `/switch: restored the default configuration at session start (was "${reverted.wasActive ?? "no profile"}"). Resources that profile loaded are still in this session; run /reload to drop them.`,
            "info",
          );
        }
      } catch {
        // A failed revert must not stop the session from starting.
      }
    }
    const store = loadStore(agentDir, ctx.cwd);
    // A revert happened when the previous session closed, where a notify could not be
    // seen. Say so here, where it can.
    const notice = store.revertedOnQuit;
    if (notice !== undefined) {
      store.revertedOnQuit = undefined;
      saveStore(store, agentDir);
      ctx.ui.notify(
        `/switch: reverted to profile "${store.activeProfile ?? "base"}" when the previous session closed (was "${notice.fromProfile ?? "no profile"}"). /switch restore undoes it.`,
        "info",
      );
    }
    const active = store.activeProfile;
    if (!active) {
      ctx.ui.setStatus("pi-switch-profile", undefined);
      return;
    }
    let profile: Profile;
    try {
      profile = resolveProfile(active, store.profiles).profile;
    } catch {
      ctx.ui.setStatus("pi-switch-profile", `profile ${active} (broken)`);
      return;
    }
    ctx.ui.setStatus("pi-switch-profile", `profile: ${active}`);
    // Only re-apply after a reload triggered by /switch. On a fresh session pi
    // already applies defaultTools / defaultModel / defaultThinkingLevel itself.
    if (event.reason === "reload") applyRuntimeProfile(pi, ctx, profile);
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason !== "quit") return;
    try {
      applySessionRevert(agentDir, packageRoot, ctx.cwd, "end");
    } catch {
      // A failed revert must not interfere with the session closing.
    }
  });
}

function applyRuntimeProfile(pi: ExtensionAPI, ctx: ExtensionContext, profile: Profile): void {
  if (profile.tools !== undefined) {
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const wanted = profile.tools.filter((name) => registered.has(name));
    const dropped = profile.tools.filter((name) => !registered.has(name));
    pi.setActiveTools(wanted);
    if (dropped.length > 0) {
      ctx.ui.notify(`/switch: tools not available in this session and left inactive: ${dropped.join(", ")}`, "warning");
    }
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

async function showProfile(
  store: Store,
  target: string | undefined,
  currentSettings: ManagedSettings,
  agentDir: string,
  packageRoot: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (target === undefined) {
    ctx.ui.notify("/switch show <profile>: missing profile name", "error");
    return;
  }
  let resolved: { profile: Profile; chain: string[] };
  try {
    resolved = resolveProfile(target, store.profiles);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`/switch show: ${message}. Known profiles: ${knownProfilesHint(store)}`, "error");
    return;
  }
  const nextSettings = buildProfileSettings(store.base, resolved.profile, { settingsBaseDir: agentDir, packageRoot }, currentSettings);
  const changes = diffSettings(currentSettings, nextSettings);
  const lines = [
    `profile: ${resolved.chain.join(" + ") || BASE_PROFILE_NAME}`,
    resolved.profile.description ?? "",
    "",
    "Resolved configuration:",
    ...summarizeSettings(nextSettings),
    "",
    "Changes vs current:",
    ...(changes.length > 0 ? changes.map((change) => `  ${change}`) : ["  (none)"]),
  ].filter((line) => line.length > 0);
  showLong(ctx, lines);
}

/** Everything a subcommand needs: the live session, the store, and the settings as they are now. */
interface SwitchEnv {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  agentDir: string;
  packageRoot: string;
  store: Store;
  settingsPath: string;
  currentSettings: ManagedSettings;
}

async function handleSwitch(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  agentDir: string,
  packageRoot: string,
): Promise<void> {
  const tokens = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  const store = loadStore(agentDir, ctx.cwd);
  const settingsPath = join(agentDir, SETTINGS_FILE_NAME);
  const currentSettings = captureManagedSettings(readJsonFile(settingsPath));

  // A fresh store has no base yet: capture whatever settings.json holds right now.
  if (ensureBase(store, currentSettings)) saveStore(store, agentDir);

  const env: SwitchEnv = { pi, ctx, agentDir, packageRoot, store, settingsPath, currentSettings };
  const sub = tokens[0];

  if (sub === undefined || sub === "list") return handleList(env);
  if (sub === "help") return handleHelp(env);
  if (sub === "doctor") return handleDoctor(env);
  if (sub === "refresh") return handleRefresh(env);
  if (sub === "revert-session") return handleRevertSession(env, tokens[1]);
  if (sub === "restore") return handleRestore(env);
  if (sub === "save") return handleSave(env, tokens[1]);
  if (sub === "delete") return handleDelete(env, tokens[1]);
  if (sub === "show") return showProfile(store, tokens[1], currentSettings, agentDir, packageRoot, ctx);
  return handleApply(env, sub);
}

function handleHelp(env: SwitchEnv): void {
  env.ctx.ui.notify(
    [
      "/switch                    current profile and profile list",
      "/switch <profile>          apply a profile, then reload",
      "/switch list               profile list",
      "/switch show <profile>     resolved profile + diff, no change",
      "/switch save <profile>     capture the current settings as a profile",
      "/switch refresh            re-capture the base snapshot from settings.json",
      "/switch restore            undo the last switch",
      "/switch delete <profile>   remove a profile",
      "/switch doctor             what this session actually has: model, tools, drift",
      "/switch revert-session <start|end|off>   revert to the default configuration at session start or close",
    ].join("\n"),
    "info",
  );
}

function handleList(env: SwitchEnv): void {
  const { ctx, store, currentSettings } = env;
  const lines = [
    `active profile: ${store.activeProfile ?? "(none)"}`,
    "",
    ...switchableProfileNames(store).map((name) => {
      const description = store.profiles[name]?.description;
      return description ? `${name} - ${description}` : name;
    }),
    "",
    "Current configuration:",
    ...summarizeSettings(currentSettings),
    "",
    `revert session: ${store.revertSession ?? "start"}`,
  ];
  const drift = detectDrift(store, currentSettings, { settingsBaseDir: env.agentDir, packageRoot: env.packageRoot });
  if (drift !== undefined) {
    lines.push(
      "",
      `Settings differ from profile "${drift.profile}" (edited by hand, or the base is stale):`,
      ...drift.changes.map((change) => `  ${change}`),
    );
  }
  showLong(ctx, lines);
}

function handleDoctor(env: SwitchEnv): void {
  const { pi, ctx, store, currentSettings } = env;
  const activeTools = pi.getActiveTools();
  const configuredTools = pi.getAllTools();
  const lines = [
    `active profile: ${store.activeProfile ?? "(none)"}`,
    `model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)"}`,
    `thinking: ${ctx.thinkingLevel ?? "(unset)"}`,
    `revert session: ${store.revertSession ?? "start"}`,
    "",
    `active tools (${activeTools.length}): ${activeTools.join(", ") || "(none)"}`,
    `configured tools (${configuredTools.length}): ${configuredTools.map((tool) => tool.name).join(", ") || "(none)"}`,
  ];
  const drift = detectDrift(store, currentSettings, { settingsBaseDir: env.agentDir, packageRoot: env.packageRoot });
  if (drift !== undefined) {
    lines.push("", `Settings differ from profile "${drift.profile}":`, ...drift.changes.map((change) => `  ${change}`));
  } else if (store.activeProfile !== undefined) {
    lines.push("", `Settings match profile "${store.activeProfile}".`);
  }
  showLong(ctx, lines);
}

function handleRefresh(env: SwitchEnv): void {
  const { ctx, store, currentSettings } = env;
  store.base = currentSettings;
  if (store.activeProfile !== undefined) {
    ctx.ui.notify(`/switch: base captured while profile "${store.activeProfile}" is active; switch back first for a clean base`, "warning");
  }
  saveStore(store, env.agentDir);
  ctx.ui.notify("/switch refresh: base snapshot updated from settings.json", "info");
}

/**
 * The profile a restore should re-activate. The profile recorded before the switch may
 * have been deleted since, and claiming it would put a nonexistent name in the footer.
 */
/* -------------------------------------------------------------------------- */
/* Session-end revert                                                          */
/* -------------------------------------------------------------------------- */

export function parseRevertNotice(value: unknown): RevertNotice | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string") return undefined;
  return {
    at: record.at,
    fromProfile: typeof record.fromProfile === "string" ? record.fromProfile : null,
    changes: Array.isArray(record.changes) ? record.changes.map((change) => String(change)) : [],
  };
}

/** How a revert should name the configuration it returns to. */
export function revertTargetProfile(store: Store): string {
  return store.profiles[DEFAULT_PROFILE_NAME] !== undefined ? DEFAULT_PROFILE_NAME : BASE_PROFILE_NAME;
}

/**
 * The one option that decides when a session returns to the default configuration, plus
 * the boolean it replaced: `revertWhenSessionEnd: true` means "end", `false` means "off".
 * A store that never set either gets "start".
 */
export function parseRevertSessionMode(store: Store | Record<string, unknown> | undefined): RevertSessionMode {
  const fields = store as { revertSession?: unknown; revertWhenSessionEnd?: unknown } | undefined;
  const value = fields?.revertSession;
  if (value === "start" || value === "end" || value === "off") return value;
  const legacy = fields?.revertWhenSessionEnd;
  if (legacy === true) return "end";
  if (legacy === false) return "off";
  return "start";
}

/**
 * "The default configuration": the default profile when it exists (so a default the user
 * gave overrides is honoured), otherwise the base snapshot with every currently known
 * package enabled.
 */
export function defaultConfiguration(
  store: Store,
  currentSettings: ManagedSettings,
  options: { settingsBaseDir: string; packageRoot: string },
): ManagedSettings {
  const profile = store.profiles[DEFAULT_PROFILE_NAME] !== undefined ? resolveProfile(DEFAULT_PROFILE_NAME, store.profiles).profile : {};
  return buildProfileSettings(store.base, profile, options, currentSettings);
}

/**
 * What the settings should become at the revert point, or undefined when there is nothing
 * to do: the mode is off, the mode is not this point, or the settings already are the
 * default configuration.
 */
export function planSessionRevert(
  store: Store,
  currentSettings: ManagedSettings,
  options: { settingsBaseDir: string; packageRoot: string },
  point: "start" | "end",
): { settings: ManagedSettings; changes: string[]; profileLabel: string } | undefined {
  const mode = store.revertSession ?? "start";
  if (mode === "off" || mode !== point) return undefined;
  // No base captured yet: there is no "default configuration" to go back to, and writing
  // an empty one would strip settings the extension never captured.
  if (Object.keys(store.base).length === 0) return undefined;
  const settings = defaultConfiguration(store, currentSettings, options);
  const changes = diffSettings(currentSettings, settings);
  if (changes.length === 0) return undefined;
  return { settings, changes, profileLabel: revertTargetProfile(store) };
}

function describeRevertMode(mode: RevertSessionMode, store: Store): string {
  const target = revertTargetProfile(store) === DEFAULT_PROFILE_NAME ? "the default profile" : "the base snapshot";
  if (mode === "start") return `a new session starts on ${target}, so a profile left behind by a killed session is dropped`;
  if (mode === "end") return `closing the session writes ${target} back`;
  return "the last switch stays applied across sessions";
}

function handleRevertSession(env: SwitchEnv, value: string | undefined): void {
  const { ctx, store } = env;
  if (value === "start" || value === "end" || value === "off") {
    if (store.revertSession === value) {
      ctx.ui.notify(`/switch revert-session: already ${value} (${describeRevertMode(value, store)})`, "info");
      return;
    }
    store.revertSession = value;
    saveStore(store, env.agentDir);
    ctx.ui.notify(`/switch revert-session: ${value} - ${describeRevertMode(value, store)}`, "info");
    return;
  }
  if (value === undefined || value === "status") {
    const mode = store.revertSession ?? "start";
    ctx.ui.notify(`/switch revert-session: ${mode} (${describeRevertMode(mode, store)})`, "info");
    return;
  }
  ctx.ui.notify('/switch revert-session <start|end|off|status>: unknown value', "error");
}

/**
 * Write the default configuration back at the configured revert point. "end" runs from
 * session_shutdown with reason "quit" only (a reload or a session switch is not a session
 * close, and a killed process never reaches it); "start" runs from session_start with
 * reason "startup".
 */
function applySessionRevert(
  agentDir: string,
  packageRoot: string,
  cwd: string,
  point: "start" | "end",
): { wasActive: string | null; profileLabel: string; changes: string[] } | undefined {
  const store = loadStore(agentDir, cwd);
  const settingsPath = join(agentDir, SETTINGS_FILE_NAME);
  const currentSettings = captureManagedSettings(readJsonFile(settingsPath));
  const plan = planSessionRevert(store, currentSettings, { settingsBaseDir: agentDir, packageRoot }, point);
  if (plan === undefined) return undefined;

  const at = new Date().toISOString();
  const wasActive = store.activeProfile ?? null;
  const previous = writeManagedSettings(settingsPath, plan.settings);
  store.history = [...store.history, { at, fromProfile: wasActive, toProfile: plan.profileLabel, settings: previous }].slice(-MAX_HISTORY);
  store.activeProfile = plan.profileLabel;
  // Only a revert at session close needs a notice for later: at session start the session
  // that has to hear about it is already here.
  if (point === "end") store.revertedOnQuit = { at, fromProfile: wasActive, changes: plan.changes.slice(0, 12) };
  saveStore(store, agentDir);
  return { wasActive, profileLabel: plan.profileLabel, changes: plan.changes };
}

export function restoreActiveProfile(fromProfile: string | null | undefined, profiles: Record<string, Profile>): string | undefined {
  if (fromProfile === null || fromProfile === undefined) return undefined;
  return profiles[fromProfile] !== undefined ? fromProfile : undefined;
}

async function handleRestore(env: SwitchEnv): Promise<void> {
  const { ctx, store, settingsPath, currentSettings } = env;
  const snapshot = store.history[store.history.length - 1];
  if (!snapshot) {
    ctx.ui.notify("/switch restore: nothing to restore", "warning");
    return;
  }
  store.history = store.history.slice(0, -1);
  const changes = diffSettings(currentSettings, snapshot.settings);
  writeManagedSettings(settingsPath, snapshot.settings);
  const backTo = restoreActiveProfile(snapshot.fromProfile, store.profiles);
  store.activeProfile = backTo;
  saveStore(store, env.agentDir);
  const label = snapshot.fromProfile === null || snapshot.fromProfile === undefined
    ? "previous configuration"
    : backTo !== undefined
      ? snapshot.fromProfile
      : `the settings of "${snapshot.fromProfile}", which has since been deleted`;
  await reloadWithSummary(ctx, `restored ${label}`, changes);
}

function handleSave(env: SwitchEnv, name: string | undefined): void {
  const { ctx, store, currentSettings } = env;
  if (!name) {
    ctx.ui.notify("/switch save <profile>: missing profile name", "error");
    return;
  }
  const invalid = validateNewProfileName(name);
  if (invalid !== undefined) {
    ctx.ui.notify(`/switch save: ${invalid}`, "error");
    return;
  }
  const overwriting = store.profiles[name] !== undefined;
  store.profiles[name] = profileFromSettings(currentSettings);
  saveStore(store, env.agentDir);
  ctx.ui.notify(
    overwriting
      ? `/switch save: overwrote profile "${name}" with the current settings`
      : `/switch save: saved profile "${name}" from the current settings`,
    "info",
  );
}

export function profileFromSettings(currentSettings: ManagedSettings): Profile {
  const enabledPackages = (currentSettings.packages ?? [])
    .filter((entry) => !packageIsDisabled(entry))
    .map(packageSourceString);
  return {
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
}

/** Profiles that inherit from `name`; deleting the parent leaves them broken. */
export function profilesExtending(profiles: Record<string, Profile>, name: string): string[] {
  return Object.keys(profiles)
    .filter((profileName) => profiles[profileName]?.extends === name)
    .sort();
}

function handleDelete(env: SwitchEnv, name: string | undefined): void {
  const { ctx, store } = env;
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
  const wasActive = store.activeProfile === name;
  const children = profilesExtending(store.profiles, name);
  delete store.profiles[name];
  // The active profile no longer exists; do not claim it in the footer.
  if (wasActive) store.activeProfile = undefined;
  saveStore(store, env.agentDir);
  const inherited = children.length > 0 ? `; profiles extending it: ${children.join(", ")}` : "";
  if (wasActive) {
    // Deleting does not reload, so clear the footer that still names the removed profile.
    ctx.ui.setStatus("pi-switch-profile", undefined);
    ctx.ui.notify(`/switch delete: removed profile "${name}"${inherited}; it was the active one, so its settings stay applied until you switch to another profile`, "warning");
    return;
  }
  ctx.ui.notify(`/switch delete: removed profile "${name}"${inherited}`, "info");
}

async function handleApply(env: SwitchEnv, name: string): Promise<void> {
  const { ctx, store, settingsPath, currentSettings } = env;
  let resolved: { profile: Profile; chain: string[] };
  try {
    resolved = resolveProfile(name, store.profiles);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const known = knownProfilesHint(store);
    ctx.ui.notify(`/switch: ${message}. Known profiles: ${known}`, "error");
    return;
  }

  const nextSettings = buildProfileSettings(store.base, resolved.profile, {
    settingsBaseDir: env.agentDir,
    packageRoot: env.packageRoot,
  }, currentSettings);
  const changes = diffSettings(currentSettings, nextSettings);
  if (store.revertSession !== "off") {
    // Worth saying on every switch: the profile is only good for this session.
    changes.push(`(revert session is "${store.revertSession ?? "start"}": this switch is undone at session ${store.revertSession === "end" ? "close" : "start"})`);
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
  saveStore(store, env.agentDir);

  await reloadWithSummary(ctx, `profile "${name}"`, changes);
}

async function reloadWithSummary(ctx: ExtensionCommandContext, label: string, changes: string[]): Promise<void> {
  // Report before reloading: nothing after ctx.reload() may reuse the old runtime,
  // and UI calls from a stale extension instance can be dropped.
  const summary = changes.length > 0 ? changes : ["(no settings changes)"];
  showLong(ctx, [`/switch: ${label}`, ...summary.map((change) => `  ${change}`)]);
  if (ctx.isIdle() === false) {
    await ctx.waitForIdle();
  }
  await ctx.reload();
}

/** Notifications are single-shot toasts; a widget is used for long output in the TUI. */
function showLong(ctx: ExtensionCommandContext, lines: string[]): void {
  if (ctx.mode === "tui" && lines.length > 6) {
    ctx.ui.setWidget("pi-switch-profile", lines, { placement: "aboveEditor" });
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
      ctx.ui.setWidget("pi-switch-profile", undefined);
    } catch {
      // Runtime may already be gone (reload/shutdown).
    }
  }, WIDGET_TTL_MS);
}

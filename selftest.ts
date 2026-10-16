/**
 * Self-test for the pure logic of extensions/switch.ts.
 * Run with: npm test  (node --experimental-strip-types selftest.ts)
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPackagePolicy,
  buildProfileSettings,
  captureManagedSettings,
  defaultConfiguration,
  diffSettings,
  detectDrift,
  ensureBase,
  isSelfPackageSource,
  LEGACY_STORE_FILE_NAME,
  mergePackageSets,
  loadStore,
  migrateLegacyProfiles,
  migrateStoreFile,
  parseRevertNotice,
  parseRevertSessionMode,
  planSessionRevert,
  revertTargetProfile,
  type ManagedSettings,
  type PackageSource,
  type Profile,
  packageIsDisabled,
  packageSourceString,
  packageSourceMatches,
  parseModelSpec,
  profileFromSettings,
  profilesExtending,
  restoreActiveProfile,
  profileNames,
  resolveProfile,
  saveStore,
  STORE_FILE_NAME,
  type Store,
  validateNewProfileName,
  revertNeedsReload,
  REVERT_RELOAD_SUB,
  seedProfiles,
  SELF_PACKAGE_NAME,
  summarizeSettings,
  writeManagedSettings,
} from "./extensions/switch.ts";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`FAIL: ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    check(`unreadable JSON at ${path}`, false, error instanceof Error ? error.message : String(error));
    return {};
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-switch-profile-test-"));
}

/* ---------------- package matching ---------------- */

eq("parse model with provider", parseModelSpec("strata/qwen3.8-flash-next"), {
  provider: "strata",
  modelId: "qwen3.8-flash-next",
});
eq("parse model without provider", parseModelSpec("gpt-5"), { modelId: "gpt-5" });

check("bare name matches npm source", packageSourceMatches("npm:pi-lens", "pi-lens"));
check("bare name matches git source", packageSourceMatches("git:github.com/acme/pi-lens@v1", "pi-lens"));
check("exact source matches", packageSourceMatches("npm:pi-lens@1.2.3", "npm:pi-lens@1.2.3"));
check("unrelated source does not match", !packageSourceMatches("npm:pi-web-access", "pi-lens"));
check("empty pattern matches nothing", !packageSourceMatches("npm:pi-lens", "  "));

/* ---------------- self detection ---------------- */

const agentDir = tempDir();
const packageRoot = join(agentDir, "npm", "node_modules", SELF_PACKAGE_NAME);
check("npm source of self is self", isSelfPackageSource("npm:pi-switch-profile", agentDir, packageRoot));
check("local relative source of self is self", isSelfPackageSource("../projects/pi-switch-profile", agentDir, join(agentDir, "..", "projects", "pi-switch-profile")));
check("local absolute source of self is self", isSelfPackageSource(packageRoot, agentDir, packageRoot));
check("other package is not self", !isSelfPackageSource("npm:pi-lens", agentDir, packageRoot));
check("a checkout under the old package name is still self", isSelfPackageSource("../projects/pi-switch-config", agentDir, join(agentDir, "..", "projects", "pi-switch-config")));
check("an npm install under the old package name is still self", isSelfPackageSource("npm:pi-switch-config", agentDir, packageRoot));

/* ---------------- store file rename ---------------- */

const migrateHome = tempDir();
writeFileSync(join(migrateHome, LEGACY_STORE_FILE_NAME), JSON.stringify({
  version: 1,
  base: { theme: "dracula" },
  activeProfile: "zen",
  profiles: { zen: { theme: "system" } },
  history: [],
  revertSession: "off",
}), "utf8");
const migratedLoaded = loadStore(migrateHome, tempDir());
check(
  "the legacy store file is renamed on load",
  !existsSync(join(migrateHome, LEGACY_STORE_FILE_NAME)) && existsSync(join(migrateHome, STORE_FILE_NAME)),
  { legacy: existsSync(join(migrateHome, LEGACY_STORE_FILE_NAME)), current: existsSync(join(migrateHome, STORE_FILE_NAME)) },
);
check(
  "the renamed store keeps its base, profiles, active profile, and options",
  migratedLoaded.base.theme === "dracula" && migratedLoaded.activeProfile === "zen" && migratedLoaded.profiles.zen !== undefined && migratedLoaded.revertSession === "off",
  migratedLoaded,
);

const bothHome = tempDir();
writeFileSync(join(bothHome, STORE_FILE_NAME), JSON.stringify({ version: 1, base: { theme: "solarized" }, profiles: {}, history: [] }), "utf8");
writeFileSync(join(bothHome, LEGACY_STORE_FILE_NAME), JSON.stringify({ version: 1, base: { theme: "old" }, profiles: {}, history: [] }), "utf8");
const bothLoaded = loadStore(bothHome, tempDir());
check(
  "the new store file wins and the old one is left alone",
  bothLoaded.base.theme === "solarized" && existsSync(join(bothHome, LEGACY_STORE_FILE_NAME)),
  bothLoaded.base,
);

const projectMigDir = tempDir();
mkdirSync(join(projectMigDir, ".pi"), { recursive: true });
writeFileSync(join(projectMigDir, ".pi", LEGACY_STORE_FILE_NAME), JSON.stringify({ version: 1, profiles: { projectOnly: { theme: "nord" } }, history: [] }), "utf8");
const projectMigrated = loadStore(tempDir(), projectMigDir);
check(
  "the project store file is migrated too",
  existsSync(join(projectMigDir, ".pi", STORE_FILE_NAME)) && !existsSync(join(projectMigDir, ".pi", LEGACY_STORE_FILE_NAME)) && projectMigrated.profiles.projectOnly !== undefined,
);
check("migrateStoreFile does nothing without a legacy file", migrateStoreFile(join(tempDir(), "a.json"), join(tempDir(), "b.json")) === false);

/* ---------------- package policy ---------------- */

const basePackages = ["npm:pi-lens", "npm:pi-web-access", "git:github.com/S1M0N38/pi-skill-creator", "npm:pi-switch-profile"];

function policy(profile: Profile, packages: PackageSource[]): PackageSource[] {
  const result = applyPackagePolicy(packages, profile, { settingsBaseDir: agentDir, packageRoot });
  if (result === undefined) throw new Error("applyPackagePolicy returned undefined");
  return result;
}

function shape(entries: PackageSource[]): unknown[] {
  return entries.map((entry) => (typeof entry === "string" ? entry : { source: entry.source, autoload: entry.autoload }));
}

function asPackages(value: unknown): PackageSource[] {
  return Array.isArray(value) ? (value as PackageSource[]) : [];
}

eq(
  "whitelist keeps self and matches only",
  shape(policy({ packages: ["pi-lens"] }, basePackages)),
  ["npm:pi-lens", { source: "npm:pi-web-access", autoload: false }, { source: "git:github.com/S1M0N38/pi-skill-creator", autoload: false }, "npm:pi-switch-profile"],
);

eq(
  "blacklist disables matches and keeps self",
  shape(policy({ disablePackages: ["web-access"] }, basePackages)),
  ["npm:pi-lens", { source: "npm:pi-web-access", autoload: false }, "git:github.com/S1M0N38/pi-skill-creator", "npm:pi-switch-profile"],
);

check(
  "empty whitelist disables everything but self",
  JSON.stringify(policy({ packages: [] }, basePackages).filter((entry) => typeof entry === "string")) === JSON.stringify(["npm:pi-switch-profile"]),
  policy({ packages: [] }, basePackages),
);

eq("no package policy enables every known package", policy({}, basePackages), basePackages);

eq(
  "no package policy re-enables entries disabled by an earlier profile",
  policy({}, ["npm:pi-lens", { source: "npm:pi-web-access", autoload: false }]),
  ["npm:pi-lens", "npm:pi-web-access"],
);

check(
  "enabling keeps a user resource filter",
  JSON.stringify(policy({}, [{ source: "npm:pi-lens", skills: ["skills/*"], autoload: false }])) === JSON.stringify([{ source: "npm:pi-lens", skills: ["skills/*"] }]),
  policy({}, [{ source: "npm:pi-lens", skills: ["skills/*"], autoload: false }]),
);

/* ---------------- package set merging ---------------- */

eq(
  "packages installed after the base snapshot are carried over",
  mergePackageSets(["npm:pi-lens"], ["npm:pi-lens", "npm:pi-newcomer"]),
  ["npm:pi-lens", "npm:pi-newcomer"],
);

eq(
  "packages removed from settings are dropped",
  mergePackageSets(["npm:pi-lens", "npm:pi-gone"], ["npm:pi-lens"]),
  ["npm:pi-lens"],
);

check(
  "a settings filter wins over the base form",
  JSON.stringify(mergePackageSets(["npm:pi-lens"], [{ source: "npm:pi-lens", skills: ["skills/*"] }])) === JSON.stringify([{ source: "npm:pi-lens", skills: ["skills/*"] }]),
  mergePackageSets(["npm:pi-lens"], [{ source: "npm:pi-lens", skills: ["skills/*"] }]),
);

check(
  "a base filter wins when settings only has the bare source",
  JSON.stringify(mergePackageSets([{ source: "npm:pi-lens", skills: ["skills/*"] }], ["npm:pi-lens"])) === JSON.stringify([{ source: "npm:pi-lens", skills: ["skills/*"] }]),
  mergePackageSets([{ source: "npm:pi-lens", skills: ["skills/*"] }], ["npm:pi-lens"]),
);

check(
  "merging does not duplicate an entry present in both",
  mergePackageSets(["npm:pi-lens", "npm:pi-lens"], ["npm:pi-lens"]).length === 1,
  mergePackageSets(["npm:pi-lens", "npm:pi-lens"], ["npm:pi-lens"]),
);

const filtered = policy({ disablePackages: ["pi-lens"] }, [{ source: "npm:pi-lens", skills: ["skills/*"] }]);
const firstEntry = filtered[0];
check(
  "disabling drops the user's own filters",
  typeof firstEntry === "object" && firstEntry.autoload === false && firstEntry.skills === undefined,
  filtered,
);
check("packageIsDisabled reads autoload", packageIsDisabled({ source: "npm:x", autoload: false }) && !packageIsDisabled("npm:x"));

/* ---------------- profile resolution ---------------- */

const profiles = {
  ...seedProfiles(),
  parent: { description: "parent", theme: "dracula", skills: ["!skills/**"] },
  child: { extends: "parent", theme: "system", tools: ["read"] },
  loopA: { extends: "loopB" },
  loopB: { extends: "loopA" },
};

const zen = resolveProfile("zen", profiles).profile;
check("zen disables packages", zen.packages !== undefined && zen.packages.length === 0);
check("zen disables auto-discovered skills", zen.skills?.includes("!skills/**") === true);
check("zen disables built-in extras", zen.extensions?.includes("-builtin:mcp") === true);

const child = resolveProfile("child", profiles).profile;
eq("extends merges parent", { theme: child.theme, skills: child.skills, tools: child.tools }, {
  theme: "system",
  skills: ["!skills/**"],
  tools: ["read"],
});

eq("resolveProfile reports chain", resolveProfile("child", profiles).chain, ["parent", "child"]);
eq("base resolves to nothing", resolveProfile("base", profiles).chain, []);

let threw = "";
try {
  resolveProfile("missing", profiles);
} catch (error) {
  threw = error instanceof Error ? error.message : String(error);
}
check("unknown profile throws", threw.includes("Unknown profile"), threw);

threw = "";
try {
  resolveProfile("loopA", profiles);
} catch (error) {
  threw = error instanceof Error ? error.message : String(error);
}
check("extends cycle throws", threw.includes("cycle"), threw);

check(
  "deleting a parent names the profiles left broken",
  JSON.stringify(profilesExtending(profiles, "parent")) === JSON.stringify(["child"]),
  profilesExtending(profiles, "parent"),
);
check("a profile with nothing inheriting from it reports none", profilesExtending(profiles, "zen").length === 0);

/* ---------------- restore target ---------------- */

check("restore does not re-activate a profile deleted since the switch", restoreActiveProfile("zen", { default: {} }) === undefined);
check("restore re-activates a profile that still exists", restoreActiveProfile("default", { default: {}, zen: {} }) === "default");
check("a switch with no previous profile restores to no profile", restoreActiveProfile(null, { default: {} }) === undefined);

/* ---------------- settings build ---------------- */

const base: ManagedSettings = {
  packages: basePackages,
  extensions: ["+~/extra/thing.ts"],
  skills: [],
  theme: "github-dark-default",
  defaultProvider: "strata",
  defaultModel: "qwen3.8-flash-next",
  defaultThinkingLevel: "medium",
};

const zenSettings = buildProfileSettings(base, resolveProfile("zen", profiles).profile, { settingsBaseDir: agentDir, packageRoot }, base);
check("zen keeps self enabled", (zenSettings.packages ?? []).some((entry) => !packageIsDisabled(entry) && packageSourceMatches(entry, "pi-switch-profile")));
eq("zen theme", zenSettings.theme, "system");
eq("zen thinking", zenSettings.defaultThinkingLevel, "low");
eq("zen tools", zenSettings.defaultTools, ["read", "bash", "edit", "write"]);
eq("zen keeps base model", { provider: zenSettings.defaultProvider, model: zenSettings.defaultModel }, { provider: "strata", model: "qwen3.8-flash-next" });
check("zen clears prompts", zenSettings.prompts?.includes("!prompts/**") === true, zenSettings.prompts);

const modelProfile = buildProfileSettings(base, { model: "anthropic/claude-sonnet-4-5" }, { settingsBaseDir: agentDir, packageRoot }, base);
eq("profile model overrides provider and model", { provider: modelProfile.defaultProvider, model: modelProfile.defaultModel }, {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
});

const noop = buildProfileSettings(base, {}, { settingsBaseDir: agentDir, packageRoot }, base);
eq("empty profile equals base", [noop.packages, noop.extensions, noop.skills, noop.prompts, noop.themes, noop.theme, noop.defaultProvider, noop.defaultModel, noop.defaultThinkingLevel, noop.defaultTools], [base.packages, base.extensions, base.skills, base.prompts, base.themes, base.theme, base.defaultProvider, base.defaultModel, base.defaultThinkingLevel, base.defaultTools]);

/* ---------------- newly installed and removed packages ---------------- */

const driftedCurrent: PackageSource[] = ["npm:pi-lens", "npm:pi-brand-new", "npm:pi-switch-profile"];
const zenDrifted = buildProfileSettings(base, resolveProfile("zen", profiles).profile, { settingsBaseDir: agentDir, packageRoot }, { ...base, packages: driftedCurrent });
check("zen disables a package installed after the snapshot", (zenDrifted.packages ?? []).some((entry) => packageIsDisabled(entry) && packageSourceMatches(entry, "pi-brand-new")), zenDrifted.packages);
check("zen still keeps itself enabled", (zenDrifted.packages ?? []).some((entry) => !packageIsDisabled(entry) && packageSourceMatches(entry, "pi-switch-profile")), zenDrifted.packages);

const defaultDrifted = buildProfileSettings(base, resolveProfile("default", profiles).profile, { settingsBaseDir: agentDir, packageRoot }, { ...base, packages: driftedCurrent });
check("default re-enables everything currently known", (defaultDrifted.packages ?? []).every((entry) => !packageIsDisabled(entry)), defaultDrifted.packages);
check("default does not resurrect a removed package", (defaultDrifted.packages ?? []).some((entry) => packageSourceMatches(entry, "pi-web-access")) === false, defaultDrifted.packages);

/* ---------------- diff + summary ---------------- */

const changes = diffSettings(base, zenSettings);
check("diff reports package disabled", changes.some((c) => c === "package off: npm:pi-lens"), changes);
check("diff reports theme change", changes.some((c) => c.startsWith("theme: ")), changes);
check("diff keeps self out of changes", !changes.some((c) => c.includes("pi-switch-profile")), changes);
eq("diff of identical settings", diffSettings(base, base), []);
check("summary mentions packages", summarizeSettings(zenSettings).some((line) => line.startsWith("packages:")), summarizeSettings(zenSettings));

/* ---------------- settings file write ---------------- */

const settingsDir = tempDir();
const settingsPath = join(settingsDir, "settings.json");
writeFileSync(settingsPath, `${JSON.stringify({
  $schema: "https://pi.dev/schemas/settings.schema.json",
  defaultProvider: "strata",
  defaultModel: "qwen3.8-flash-next",
  compaction: { enabled: true, reserveTokens: 81920 },
  theme: "github-dark-default",
  packages: basePackages,
  hideThinkingBlock: false,
}, null, 2)}\n`, "utf8");

const previous = writeManagedSettings(settingsPath, zenSettings);
const written = readJson(settingsPath);
const compaction = written.compaction as { reserveTokens?: number } | undefined;
check("unmanaged keys preserved", compaction?.reserveTokens === 81920 && written.$schema !== undefined && written.hideThinkingBlock === false, written);
eq("packages written with self enabled", asPackages(written.packages).filter((entry) => typeof entry === "string"), ["npm:pi-switch-profile"]);
eq("theme written", written.theme, "system");
eq("previous snapshot returned for undo", previous.packages, basePackages);

const restored = writeManagedSettings(settingsPath, previous);
const again = readJson(settingsPath);
eq("undo restores packages", asPackages(again.packages), basePackages);
eq("undo restores theme", again.theme, "github-dark-default");
eq("undo returns the zen snapshot", restored.theme, "system");
check("undo removes a tool list the earlier profile wrote", (again as Record<string, unknown>).defaultTools === undefined, again);

const defaultAfterZen = buildProfileSettings(base, resolveProfile("default", profiles).profile, { settingsBaseDir: agentDir, packageRoot }, zenSettings);
check(
  "a profile with no overrides clears what an earlier profile wrote",
  defaultAfterZen.defaultTools === undefined && defaultAfterZen.theme === "github-dark-default" && defaultAfterZen.defaultThinkingLevel === "medium",
  defaultAfterZen,
);

const noBaseValue = buildProfileSettings(
  { packages: ["npm:pi-switch-profile"] },
  {},
  { settingsBaseDir: agentDir, packageRoot },
  { packages: ["npm:pi-switch-profile"], defaultTools: ["read"], theme: "solarized" },
);
check(
  "a key neither the profile nor the base defines is left unset",
  noBaseValue.defaultTools === undefined && noBaseValue.theme === undefined,
  noBaseValue,
);

eq("captureManagedSettings ignores unmanaged keys", Object.keys(captureManagedSettings({ theme: "x", compaction: { enabled: true } })), ["theme"]);

/* ---------------- store ---------------- */

const storeHome = tempDir();
const projectDir = tempDir();
mkdirSync(join(projectDir, ".pi"), { recursive: true });

const emptyStore = loadStore(storeHome, projectDir);
check("base profile always exists", emptyStore.profiles.base !== undefined);
check("zen seeded", emptyStore.profiles.zen !== undefined);
check("default seeded", emptyStore.profiles.default !== undefined && emptyStore.profiles.coder === undefined);

check("ensureBase captures settings on a fresh store", ensureBase(emptyStore, base) === true && JSON.stringify(emptyStore.base) === JSON.stringify(base), emptyStore.base);
check("ensureBase keeps an existing base", ensureBase(emptyStore, { theme: "other" }) === false && emptyStore.base.theme === base.theme, emptyStore.base);
saveStore(emptyStore, storeHome);

const store = loadStore(storeHome, projectDir);
check("a captured base survives a reload", JSON.stringify(store.base) === JSON.stringify(base), store.base);
store.activeProfile = "zen";
store.history = [{ at: new Date().toISOString(), fromProfile: null, toProfile: "zen", settings: base }];
saveStore(store, storeHome);

const reloaded = loadStore(storeHome, projectDir);
eq("store round-trips active profile", reloaded.activeProfile, "zen");
eq("store round-trips history", reloaded.history.length, 1);
eq("profile names sorted with base first", profileNames(reloaded)[0], "base");

/* ---------------- drift detection ---------------- */

const driftOptions = { settingsBaseDir: agentDir, packageRoot };
const zenResolved = resolveProfile("zen", reloaded.profiles).profile;
const matching = buildProfileSettings(base, zenResolved, driftOptions, base);
check(
  "no drift when settings match the active profile",
  detectDrift(reloaded, matching, driftOptions) === undefined,
  detectDrift(reloaded, matching, driftOptions),
);

const handEdited: ManagedSettings = { ...matching, theme: "solarized" };
const drift = detectDrift(reloaded, handEdited, driftOptions);
check(
  "drift reported after a hand edit",
  drift !== undefined && drift.profile === "zen" && drift.changes.some((change) => change.includes("theme")),
  drift,
);

check(
  "no drift check without an active profile",
  detectDrift({ ...reloaded, activeProfile: undefined }, handEdited, driftOptions) === undefined,
);

/* ---------------- profile names ---------------- */

check("subcommand names cannot be profiles", ["list", "show", "save", "delete", "refresh", "restore", "doctor", "help"].every((name) => validateNewProfileName(name) !== undefined));
check("base is reserved for the snapshot", validateNewProfileName("base") !== undefined);
check("ordinary names are usable", validateNewProfileName("my-setup") === undefined && validateNewProfileName("dev.2") === undefined && validateNewProfileName("coder_x") === undefined);
check("path-like and empty names are rejected", validateNewProfileName("../evil") !== undefined && validateNewProfileName("") !== undefined && validateNewProfileName("-x") !== undefined);
check("the internal reload subcommand cannot be a profile name", validateNewProfileName(REVERT_RELOAD_SUB) !== undefined);

check("a revert that changes resources needs a reload", revertNeedsReload(["package off: npm:pi-lens"]) && revertNeedsReload(["package on: npm:x"]) && revertNeedsReload(["skills: [] -> ['!skills/**']"]) && revertNeedsReload(["extensions: x -> y", "theme: a -> b"]));
check("a revert that only changes runtime settings does not", revertNeedsReload(["theme: system -> github-dark-default"]) === false && revertNeedsReload(["defaultTools: [...] -> undefined"]) === false && revertNeedsReload(["defaultModel: a -> b", "defaultThinkingLevel: low -> medium"]) === false && revertNeedsReload([]) === false);

/* ---------------- corrupt store ---------------- */

const corruptHome = tempDir();
writeFileSync(join(corruptHome, "pi-switch-profile.json"), "{ not json", "utf8");
const corruptStore = loadStore(corruptHome, tempDir());
check("a corrupt store falls back to seed profiles instead of throwing", corruptStore.profiles.base !== undefined && corruptStore.profiles.zen !== undefined, Object.keys(corruptStore.profiles));
check("a corrupt store keeps no active profile or history", corruptStore.activeProfile === undefined && corruptStore.history.length === 0, corruptStore);

/* ---------------- legacy seed rename: coder -> default ---------------- */

const legacyHome = tempDir();
writeFileSync(join(legacyHome, "pi-switch-profile.json"), JSON.stringify({
  version: 1,
  base: { theme: "github-dark-default" },
  activeProfile: "coder",
  profiles: { base: { description: "base" }, zen: { theme: "system" }, coder: { description: "Everything from the base snapshot (no overrides)" } },
  history: [],
}), "utf8");
const migratedStore = loadStore(legacyHome, tempDir());
check("the legacy seed profile is renamed on load", migratedStore.profiles.default !== undefined && migratedStore.profiles.coder === undefined, Object.keys(migratedStore.profiles));
check("the active profile follows the rename", migratedStore.activeProfile === "default", migratedStore.activeProfile);

const customHome = tempDir();
writeFileSync(join(customHome, "pi-switch-profile.json"), JSON.stringify({
  version: 1,
  base: {},
  profiles: { coder: { description: "mine", theme: "dracula" } },
  history: [],
}), "utf8");
const customStore = loadStore(customHome, tempDir());
check("a real profile the user named coder is left alone", customStore.profiles.coder?.theme === "dracula" && customStore.profiles.default === undefined, customStore.profiles);

const clashHome = tempDir();
writeFileSync(join(clashHome, "pi-switch-profile.json"), JSON.stringify({
  version: 1,
  base: {},
  profiles: { coder: { description: "Everything from the base snapshot (no overrides)" }, default: { theme: "solarized" } },
  history: [],
}), "utf8");
const clashStore = loadStore(clashHome, tempDir());
check("the rename never overwrites a profile the user already made", clashStore.profiles.default?.theme === "solarized" && clashStore.profiles.coder !== undefined, clashStore.profiles);

check(
  "migration reports what it renamed",
  JSON.stringify(migrateLegacyProfiles({ coder: { description: "x" } }).renamed) === JSON.stringify([{ from: "coder", to: "default" }]),
  migrateLegacyProfiles({ coder: { description: "x" } }).renamed,
);

/* ---------------- revert session ---------------- */

const revertOptions = { settingsBaseDir: agentDir, packageRoot };
const revertStore: Store = {
  version: 1,
  base,
  activeProfile: "zen",
  profiles: { ...seedProfiles() },
  history: [],
  revertSession: "end",
};
const zenCurrent: ManagedSettings = { ...zenSettings };

const revertPlan = planSessionRevert(revertStore, zenCurrent, revertOptions, "end");
check(
  "revert at session close restores the base configuration",
  revertPlan?.settings.theme === base.theme && revertPlan?.settings.defaultThinkingLevel === base.defaultThinkingLevel && revertPlan?.settings.defaultTools === undefined,
  revertPlan?.settings,
);
check("revert re-enables every known package", (revertPlan?.settings.packages ?? []).every((entry: PackageSource) => !packageIsDisabled(entry)), revertPlan?.settings.packages);
check("revert reports the changes it will make", (revertPlan?.changes ?? []).length > 0, revertPlan?.changes);
eq("revert names the default profile", revertPlan?.profileLabel, "default");

check("revert does nothing when the mode is off", planSessionRevert({ ...revertStore, revertSession: "off" }, zenCurrent, revertOptions, "end") === undefined);
check("an end revert does not fire at session start", planSessionRevert(revertStore, zenCurrent, revertOptions, "start") === undefined);
check("a start revert does not fire at session close", planSessionRevert({ ...revertStore, revertSession: "start" }, zenCurrent, revertOptions, "end") === undefined);
check("a start revert fires at session start", planSessionRevert({ ...revertStore, revertSession: "start" }, zenCurrent, revertOptions, "start") !== undefined);
check("revert does nothing when the settings already are the default", planSessionRevert(revertStore, defaultConfiguration(revertStore, zenCurrent, revertOptions), revertOptions, "end") === undefined);
check("no revert before a base snapshot exists", planSessionRevert({ ...revertStore, base: {} }, zenCurrent, revertOptions, "start") === undefined && planSessionRevert({ ...revertStore, base: {} }, zenCurrent, revertOptions, "end") === undefined);
eq("revert honours a default profile the user gave overrides", planSessionRevert({ ...revertStore, profiles: { ...revertStore.profiles, default: { theme: "dracula" } } }, zenCurrent, revertOptions, "end")?.settings.theme, "dracula");
eq("revert falls back to the base snapshot without a default profile", planSessionRevert({ ...revertStore, profiles: { zen: {} } }, zenCurrent, revertOptions, "end")?.profileLabel, "base");
eq("target label without a default profile", revertTargetProfile({ ...revertStore, profiles: { zen: {} } }), "base");

const revertHome = tempDir();
saveStore(revertStore, revertHome);
const revertReloaded = loadStore(revertHome, tempDir());
check("revertSession persists", revertReloaded.revertSession === "end", revertReloaded.revertSession);
check("no revert notice is invented", revertReloaded.revertedOnQuit === undefined, revertReloaded.revertedOnQuit);

const noticeStore: Store = { ...revertStore, revertedOnQuit: { at: "2026-01-01T00:00:00.000Z", fromProfile: "zen", changes: ["theme: system"] } };
saveStore(noticeStore, revertHome);
const noticeReloaded = loadStore(revertHome, tempDir());
check(
  "a pending revert notice survives to the next session",
  noticeReloaded.revertedOnQuit?.fromProfile === "zen" && noticeReloaded.revertedOnQuit?.at === "2026-01-01T00:00:00.000Z",
  noticeReloaded.revertedOnQuit,
);
check("a malformed revert notice is dropped", parseRevertNotice({ fromProfile: "zen" }) === undefined && parseRevertNotice("zen") === undefined && parseRevertNotice(undefined) === undefined);

check("revertSession defaults to start", loadStore(tempDir(), tempDir()).revertSession === "start", loadStore(tempDir(), tempDir()).revertSession);
check("an unset store is planned for a start revert", planSessionRevert({ ...revertStore, revertSession: undefined }, zenCurrent, revertOptions, "start") !== undefined);
eq("legacy revertWhenSessionEnd true becomes end", parseRevertSessionMode({ revertWhenSessionEnd: true }), "end");
eq("legacy revertWhenSessionEnd false becomes off", parseRevertSessionMode({ revertWhenSessionEnd: false }), "off");
eq("a valid revertSession wins over the legacy boolean", parseRevertSessionMode({ revertSession: "start", revertWhenSessionEnd: true }), "start");
eq("an invalid revertSession falls back to the default", parseRevertSessionMode({ revertSession: "sometimes" }), "start");
eq("an empty store defaults to start", parseRevertSessionMode(undefined), "start");

const legacyModeHome = tempDir();
writeFileSync(join(legacyModeHome, STORE_FILE_NAME), JSON.stringify({ version: 1, base: {}, profiles: {}, history: [], revertWhenSessionEnd: true }), "utf8");
check("a store written by the boolean version is read as end", loadStore(legacyModeHome, tempDir()).revertSession === "end", loadStore(legacyModeHome, tempDir()).revertSession);

const modeHome = tempDir();
saveStore({ ...revertStore, revertSession: "off" }, modeHome);
check("an explicit off is remembered", loadStore(modeHome, tempDir()).revertSession === "off", loadStore(modeHome, tempDir()).revertSession);

/* ---------------- unparseable files are kept, not overwritten ---------------- */

const corruptDir = tempDir();
const corruptSettingsPath = join(corruptDir, "settings.json");
writeFileSync(corruptSettingsPath, "{ oops", "utf8");
writeManagedSettings(corruptSettingsPath, { theme: "system" });
const rewrittenCorrupt = readJson(corruptSettingsPath);
check(
  "an unparseable settings.json is copied aside before being rewritten",
  readFileSync(`${corruptSettingsPath}.corrupt.bak`, "utf8") === "{ oops" && rewrittenCorrupt.theme === "system",
  rewrittenCorrupt,
);

const corruptStoreHome = tempDir();
const corruptStoreFile = join(corruptStoreHome, "pi-switch-profile.json");
writeFileSync(corruptStoreFile, JSON.stringify(["not", "an", "object"]), "utf8");
saveStore(loadStore(corruptStoreHome, tempDir()), corruptStoreHome);
check("an array-shaped store is copied aside too", readFileSync(`${corruptStoreFile}.corrupt.bak`, "utf8").includes("not") === true);

const goodHome = tempDir();
const goodSettings = join(goodHome, "settings.json");
writeFileSync(goodSettings, JSON.stringify({ theme: "ok" }), "utf8");
writeManagedSettings(goodSettings, { theme: "system" });
check("a parseable file is never copied aside", existsSync(`${goodSettings}.corrupt.bak`) === false);

/* ---------------- save round trip ---------------- */

const saved = profileFromSettings({
  packages: ["npm:pi-lens", { source: "npm:pi-off", autoload: false }, "npm:pi-switch-profile"],
  theme: "solarized",
  defaultTools: ["read"],
  defaultThinkingLevel: "high",
  defaultProvider: "strata",
  defaultModel: "qwen3.8-flash-next",
});
check(
  "save records only enabled packages",
  JSON.stringify(saved.packages) === JSON.stringify(["npm:pi-lens", "npm:pi-switch-profile"]),
  saved.packages,
);
check(
  "save records theme, tools, and thinking level",
  JSON.stringify({ theme: saved.theme, tools: saved.tools, thinkingLevel: saved.thinkingLevel }) === JSON.stringify({ theme: "solarized", tools: ["read"], thinkingLevel: "high" }),
  saved,
);
check("save records the model as a profile spec", saved.model === "strata/qwen3.8-flash-next", saved.model);

const savedApplied = buildProfileSettings(base, saved, driftOptions, base);
check(
  "a saved profile re-enables exactly what was enabled when it was saved",
  JSON.stringify((savedApplied.packages ?? []).filter((entry) => !packageIsDisabled(entry)).map(packageSourceString)) === JSON.stringify(["npm:pi-lens", "npm:pi-switch-profile"]),
  savedApplied.packages,
);

writeFileSync(join(projectDir, ".pi", "pi-switch-profile.json"), JSON.stringify({ profiles: { projectOnly: { theme: "solarized" } } }), "utf8");
const merged = loadStore(storeHome, projectDir);
check("project profiles merge", merged.profiles.projectOnly?.theme === "solarized", merged.profiles.projectOnly);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}

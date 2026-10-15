/**
 * Self-test for the pure logic of extensions/switch.ts.
 * Run with: npm test  (node --experimental-strip-types selftest.ts)
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPackagePolicy,
  buildProfileSettings,
  captureManagedSettings,
  diffSettings,
  ensureBase,
  isSelfPackageSource,
  mergePackageSets,
  loadStore,
  type ManagedSettings,
  type PackageSource,
  type Profile,
  packageIsDisabled,
  packageSourceMatches,
  parseModelSpec,
  profileNames,
  resolveProfile,
  saveStore,
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
  return mkdtempSync(join(tmpdir(), "pi-switch-config-test-"));
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
check("npm source of self is self", isSelfPackageSource("npm:pi-switch-config", agentDir, packageRoot));
check("local relative source of self is self", isSelfPackageSource("../projects/pi-switch-config", agentDir, join(agentDir, "..", "projects", "pi-switch-config")));
check("local absolute source of self is self", isSelfPackageSource(packageRoot, agentDir, packageRoot));
check("other package is not self", !isSelfPackageSource("npm:pi-lens", agentDir, packageRoot));

/* ---------------- package policy ---------------- */

const basePackages = ["npm:pi-lens", "npm:pi-web-access", "git:github.com/S1M0N38/pi-skill-creator", "npm:pi-switch-config"];

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
  ["npm:pi-lens", { source: "npm:pi-web-access", autoload: false }, { source: "git:github.com/S1M0N38/pi-skill-creator", autoload: false }, "npm:pi-switch-config"],
);

eq(
  "blacklist disables matches and keeps self",
  shape(policy({ disablePackages: ["web-access"] }, basePackages)),
  ["npm:pi-lens", { source: "npm:pi-web-access", autoload: false }, "git:github.com/S1M0N38/pi-skill-creator", "npm:pi-switch-config"],
);

check(
  "empty whitelist disables everything but self",
  JSON.stringify(policy({ packages: [] }, basePackages).filter((entry) => typeof entry === "string")) === JSON.stringify(["npm:pi-switch-config"]),
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

const zenSettings = buildProfileSettings(base, resolveProfile("zen", profiles).profile, { settingsBaseDir: agentDir, packageRoot }, base.packages);
check("zen keeps self enabled", (zenSettings.packages ?? []).some((entry) => !packageIsDisabled(entry) && packageSourceMatches(entry, "pi-switch-config")));
eq("zen theme", zenSettings.theme, "system");
eq("zen thinking", zenSettings.defaultThinkingLevel, "low");
eq("zen tools", zenSettings.defaultTools, ["read", "bash", "edit", "write"]);
eq("zen keeps base model", { provider: zenSettings.defaultProvider, model: zenSettings.defaultModel }, { provider: "strata", model: "qwen3.8-flash-next" });
check("zen clears prompts", zenSettings.prompts?.includes("!prompts/**") === true, zenSettings.prompts);

const modelProfile = buildProfileSettings(base, { model: "anthropic/claude-sonnet-4-5" }, { settingsBaseDir: agentDir, packageRoot }, base.packages);
eq("profile model overrides provider and model", { provider: modelProfile.defaultProvider, model: modelProfile.defaultModel }, {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
});

const noop = buildProfileSettings(base, {}, { settingsBaseDir: agentDir, packageRoot }, base.packages);
eq("empty profile equals base", [noop.packages, noop.extensions, noop.skills, noop.prompts, noop.themes, noop.theme, noop.defaultProvider, noop.defaultModel, noop.defaultThinkingLevel, noop.defaultTools], [base.packages, base.extensions, base.skills, base.prompts, base.themes, base.theme, base.defaultProvider, base.defaultModel, base.defaultThinkingLevel, base.defaultTools]);

/* ---------------- newly installed and removed packages ---------------- */

const driftedCurrent: PackageSource[] = ["npm:pi-lens", "npm:pi-brand-new", "npm:pi-switch-config"];
const zenDrifted = buildProfileSettings(base, resolveProfile("zen", profiles).profile, { settingsBaseDir: agentDir, packageRoot }, driftedCurrent);
check("zen disables a package installed after the snapshot", (zenDrifted.packages ?? []).some((entry) => packageIsDisabled(entry) && packageSourceMatches(entry, "pi-brand-new")), zenDrifted.packages);
check("zen still keeps itself enabled", (zenDrifted.packages ?? []).some((entry) => !packageIsDisabled(entry) && packageSourceMatches(entry, "pi-switch-config")), zenDrifted.packages);

const coderDrifted = buildProfileSettings(base, resolveProfile("coder", profiles).profile, { settingsBaseDir: agentDir, packageRoot }, driftedCurrent);
check("coder re-enables everything currently known", (coderDrifted.packages ?? []).every((entry) => !packageIsDisabled(entry)), coderDrifted.packages);
check("coder does not resurrect a removed package", (coderDrifted.packages ?? []).some((entry) => packageSourceMatches(entry, "pi-web-access")) === false, coderDrifted.packages);

/* ---------------- diff + summary ---------------- */

const changes = diffSettings(base, zenSettings);
check("diff reports package disabled", changes.some((c) => c === "package off: npm:pi-lens"), changes);
check("diff reports theme change", changes.some((c) => c.startsWith("theme: ")), changes);
check("diff keeps self out of changes", !changes.some((c) => c.includes("pi-switch-config")), changes);
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
eq("packages written with self enabled", asPackages(written.packages).filter((entry) => typeof entry === "string"), ["npm:pi-switch-config"]);
eq("theme written", written.theme, "system");
eq("previous snapshot returned for undo", previous.packages, basePackages);

const restored = writeManagedSettings(settingsPath, previous);
const again = readJson(settingsPath);
eq("undo restores packages", asPackages(again.packages), basePackages);
eq("undo restores theme", again.theme, "github-dark-default");
eq("undo returns the zen snapshot", restored.theme, "system");

eq("captureManagedSettings ignores unmanaged keys", Object.keys(captureManagedSettings({ theme: "x", compaction: { enabled: true } })), ["theme"]);

/* ---------------- store ---------------- */

const storeHome = tempDir();
const projectDir = tempDir();
mkdirSync(join(projectDir, ".pi"), { recursive: true });

const emptyStore = loadStore(storeHome, projectDir);
check("base profile always exists", emptyStore.profiles.base !== undefined);
check("zen seeded", emptyStore.profiles.zen !== undefined);

check("ensureBase captures settings on a fresh store", ensureBase(emptyStore, base) === true && JSON.stringify(emptyStore.base) === JSON.stringify(base), emptyStore.base);
check("ensureBase keeps an existing base", ensureBase(emptyStore, { theme: "other" }) === false && emptyStore.base.theme === base.theme, emptyStore.base);

const store = loadStore(storeHome, projectDir);
store.activeProfile = "zen";
store.history = [{ at: new Date().toISOString(), fromProfile: null, toProfile: "zen", settings: base }];
saveStore(store, storeHome);

const reloaded = loadStore(storeHome, projectDir);
eq("store round-trips active profile", reloaded.activeProfile, "zen");
eq("store round-trips history", reloaded.history.length, 1);
eq("profile names sorted with base first", profileNames(reloaded)[0], "base");

writeFileSync(join(projectDir, ".pi", "pi-switch-config.json"), JSON.stringify({ profiles: { projectOnly: { theme: "solarized" } } }), "utf8");
const merged = loadStore(storeHome, projectDir);
check("project profiles merge", merged.profiles.projectOnly?.theme === "solarized", merged.profiles.projectOnly);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}

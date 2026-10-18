/**
 * Live smoke test: starts a real `pi --mode rpc` session with this extension,
 * runs /switch list, /switch zen, /switch restore, and checks settings.json.
 *
 * The real settings.json is backed up before the run and restored afterwards,
 * and the pi process is killed before the restore so pi cannot write it again.
 *
 * Run with: node scripts/live-test.mjs
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(repoRoot, "extensions", "switch.ts");
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const settingsPath = join(agentDir, "settings.json");
const backupPath = join(agentDir, "settings.json.live-test.bak");
const profileStorePaths = [
  join(agentDir, "pi-switch-profile.json"),
  join(agentDir, "pi-switch-config.json"),
];
// The single undo record lives in its own file and a run that switches/restores rewrites it.
const undoPath = join(agentDir, "pi-switch-undo.json");
const storePaths = [...profileStorePaths, undoPath];
const storeBackupPaths = storePaths.map((path) => `${path}.live-test.bak`);

const results = [];
const notifications = [];
const statusUpdates = [];
let pendingId = 0;
const waiters = new Map();

function log(message) {
  process.stderr.write(`[live-test] ${message}\n`);
}

function check(label, ok, detail) {
  results.push({ label, ok });
  log(`${ok ? "PASS" : "FAIL"}: ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    log(`cannot read settings.json: ${error.message}`);
    return {};
  }
}

let activeChild = null;

function zip2(a, b) {
  return a.map((value, index) => [value, b[index]]);
}

function readStore() {
  for (const path of profileStorePaths) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // try the next candidate name
    }
  }
  return {};
}

/** A package entry's source string, whichever form settings.json used for it. */
function packageSourceOf(entry) {
  return String(typeof entry === "string" ? entry : entry?.source ?? "");
}

/** `autoload: false` is how a profile writes "this package is off". */
function isDisabledEntry(entry) {
  return typeof entry === "object" && entry !== null && entry.autoload === false;
}

/**
 * The live store is the user's own, so "every package enabled" cannot mean "every entry is a plain
 * string": a `default` profile that deliberately keeps a package off (its own `exclude.packages`) is
 * intended state, and a profile policy may rewrite an entry's *form* while keeping the same source.
 * Assertions about enablement therefore name what is unexpectedly off instead of demanding an
 * identical list.
 */
function deliberateExclusions() {
  const profile = readStore().profiles?.default ?? {};
  return [...(profile.disablePackages ?? []), ...(profile.exclude?.packages ?? [])].map((term) => String(term).toLowerCase());
}

function unexpectedlyDisabled(settings, expected = []) {
  const allowed = deliberateExclusions().concat(expected.map((term) => String(term).toLowerCase()));
  return (settings.packages ?? [])
    .filter(isDisabledEntry)
    .map(packageSourceOf)
    .filter((source) => !allowed.some((term) => source.includes(term)));
}

/**
 * settings.json can name this same checkout more than once - a relative entry and an absolute one are
 * different package sources - and self-preservation keeps every one of them enabled. Resolve the
 * source rather than matching a name.
 */
function resolvesToRepoRoot(source) {
  if (source.startsWith("npm:") || source.startsWith("git:")) return false;
  return resolve(isAbsolute(source) ? source : join(agentDir, source)) === repoRoot;
}

/** pi's install root for a package source, mirroring DefaultPackageManager. */
function packageInstallRoot(source) {
  const stripRef = (value) => {
    const at = value.lastIndexOf("@");
    return at > 0 ? value.slice(0, at) : value;
  };
  if (source.startsWith("npm:")) return join(agentDir, "npm", "node_modules", stripRef(source.slice(4)));
  if (source.startsWith("git:")) return join(agentDir, "git", stripRef(source.slice(4)));
  return resolve(isAbsolute(source) ? source : join(agentDir, source));
}

/**
 * The theme checks need a package that really ships themes. Find one among what is installed
 * instead of assuming a particular package is there, and skip a theme a local
 * `<agentDir>/themes/<name>.json` would shadow.
 */
function themeFixture() {
  for (const entry of readSettings().packages ?? []) {
    const source = packageSourceOf(entry);
    const themesDir = join(packageInstallRoot(source), "themes");
    if (!existsSync(themesDir)) continue;
    for (const file of readdirSync(themesDir)) {
      if (!file.endsWith(".json")) continue;
      let name;
      try {
        name = JSON.parse(readFileSync(join(themesDir, file), "utf8")).name;
      } catch {
        continue;
      }
      if (typeof name !== "string" || name.length === 0) continue;
      if (["system", "dark", "light"].includes(name)) continue;
      if (existsSync(join(agentDir, "themes", `${name}.json`))) continue;
      return { source, file, theme: name };
    }
  }
  return undefined;
}

/**
 * A run that was interrupted leaves its own fingerprints in the live agent dir: the probe extension
 * file, `!extensions/zzz-switch-live.ts` in settings.json, that term in every profile's exclude list,
 * and the profiles the run wrote. Clean them before taking the backup, so the run starts from a sane
 * configuration and restores one - otherwise the residue fails the next run (the probe is denied
 * before the install check) and stays in the user's configuration forever.
 */
const PROBE_FILE_NAME = "zzz-switch-live.ts";
const TEST_PROFILE_NAMES = ["keep", "no-web", "theme-only", "snapshot", "last", "doctor"];

function cleanTestResidue() {
  const probePath = join(agentDir, "extensions", PROBE_FILE_NAME);
  if (existsSync(probePath)) {
    try {
      if (readFileSync(probePath, "utf8").includes("pi-switch-profile live test probe")) unlinkSync(probePath);
    } catch {
      // Not ours to remove.
    }
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    let changed = false;
    for (const kind of ["extensions", "skills", "prompts", "themes"]) {
      const list = settings[kind];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((entry) => !String(entry).includes(PROBE_FILE_NAME));
      if (kept.length !== list.length) {
        settings[kind] = kept;
        changed = true;
      }
    }
    if (changed) writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch {
    // settings.json is re-read below; an unparseable file is not this step's problem.
  }

  for (const path of profileStorePaths) {
    if (!existsSync(path)) continue;
    let store;
    try {
      store = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    let changed = false;
    for (const name of TEST_PROFILE_NAMES) {
      if (store.profiles?.[name] !== undefined) {
        delete store.profiles[name];
        changed = true;
      }
    }
    for (const profile of Object.values(store.profiles ?? {})) {
      for (const kind of ["extensions", "skills", "prompts", "themes", "packages"]) {
        const list = profile.exclude?.[kind];
        if (!Array.isArray(list)) continue;
        const kept = list.filter((term) => !String(term).includes(PROBE_FILE_NAME));
        if (kept.length === list.length) continue;
        changed = true;
        if (kept.length > 0) profile.exclude[kind] = kept;
        else delete profile.exclude[kind];
      }
      if (profile.exclude !== undefined && Object.keys(profile.exclude).length === 0) delete profile.exclude;
      if (Array.isArray(profile.extensions) && profile.extensions.every((term) => String(term).includes(PROBE_FILE_NAME))) {
        delete profile.extensions;
        changed = true;
      }
    }
    if (store.activeProfile !== undefined && store.profiles?.[store.activeProfile] === undefined) delete store.activeProfile;
    if (changed) writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
}

function readUndo() {
  try {
    return JSON.parse(readFileSync(undoPath, "utf8"));
  } catch {
    return undefined;
  }
}

function listUndoFiles() {
  return [undoPath, join(agentDir, "pi-switch-undo.json.live-test.bak")].filter((path) => existsSync(path));
}

/** Wire a pi rpc child into the shared notification/waiter state; resolves on exit. */
function attachSession(child) {
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) handleLine(line);
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[pi] ${chunk}`));
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
}

const ESC = String.fromCharCode(27);
const ANSI_CODES = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const SGR_TRUECOLOR = new RegExp(`${ESC}\\[38;2;`);

function handleLine(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (record.type === "extension_ui_request" && record.method === "notify") {
    notifications.push(String(record.message ?? ""));
  }
  if (record.type === "extension_ui_request" && record.method === "setStatus") {
    statusUpdates.push({ key: String(record.statusKey ?? ""), text: String(record.statusText ?? "") });
  }
  if (record.id && waiters.has(record.id)) {
    const settle = waiters.get(record.id);
    waiters.delete(record.id);
    settle(record);
  }
}

async function main() {
  if (!existsSync(extensionPath)) throw new Error(`missing extension entry: ${extensionPath}`);
  if (!existsSync(settingsPath)) throw new Error(`no settings.json at ${settingsPath}`);
  cleanTestResidue();
  copyFileSync(settingsPath, backupPath);
  // The extension keeps its own store next to settings.json; back up both the current and
  // the pre-rename name so a run that triggers the file migration still restores the real
  // agent dir exactly as it was.
  for (const [path, backup] of zip2(storePaths, storeBackupPaths)) {
    if (existsSync(path)) copyFileSync(path, backup);
    else if (existsSync(backup)) unlinkSync(backup);
  }
  const before = readSettings();
  // Install this package the way a user would, so the run exercises the real
  // path: the extension is loaded from settings.packages, and "zen" has to keep
  // that entry enabled or /switch would disappear after the reload. If settings.json
  // already names this checkout - under any source form - do not add a second entry,
  // or every count in the run is off by one.
  const beforePackages = before.packages ?? [];
  const alreadyInstalled = beforePackages.some((entry) => resolvesToRepoRoot(packageSourceOf(entry)));
  const installed = { ...before, packages: alreadyInstalled ? [...beforePackages] : [...beforePackages, repoRoot] };
  writeFileSync(settingsPath, `${JSON.stringify(installed, null, 2)}\n`, "utf8");
  // revertSession defaults to "start", and a start revert would rewrite the run's own
  // baseline before the first command. Turn it off for the first session and re-arm it
  // explicitly where the test wants it.
  for (const path of storePaths) {
    if (!existsSync(path)) continue;
    let storeFile;
    try {
      storeFile = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    storeFile.revertSession = "off";
    delete storeFile.revertWhenSessionEnd;
    delete storeFile.revertedOnQuit;
    writeFileSync(path, `${JSON.stringify(storeFile, null, 2)}\n`, "utf8");
  }
  log(`backed up settings.json and installed ${repoRoot} (${installed.packages.length} packages)`);

  // A real auto-discovered extension, so /switch install can target it and its registered
  // command can prove the reload actually applied the exclusion.
  const probeExtPath = join(agentDir, "extensions", "zzz-switch-live.ts");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const probeExisted = existsSync(probeExtPath);
  writeFileSync(
    probeExtPath,
    "export default function (pi) {\n  pi.registerCommand(\"zzz-switch-live\", { description: \"pi-switch-profile live test probe\", handler: async () => {} });\n}\n",
    "utf8",
  );

  activeChild = spawn("pi", ["--mode", "rpc"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const firstChild = activeChild;
  const firstExit = attachSession(activeChild);
  let secondChild = null;
  let thirdChild = null;

  function send(command, timeoutMs = 90_000) {
    const id = `req-${++pendingId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`timeout waiting for ${JSON.stringify(command)}`));
      }, timeoutMs);
      waiters.set(id, (record) => {
        clearTimeout(timer);
        resolve(record);
      });
      activeChild.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  async function runSlash(message, timeoutMs = 90_000) {
    const response = await send({ type: "prompt", message }, timeoutMs);
    if (!response.success) throw new Error(`${message} rejected: ${response.error}`);
    log(`${message} -> ${response.data?.disposition ?? "?"}`);
    return response;
  }

  /**
   * Long reports are sent as several notifications, so a doctor report has to be read as
   * everything the doctor call produced, not as its first chunk.
   */
  async function runDoctor(label) {
    const startIndex = notifications.length;
    await runSlash("/switch doctor");
    await waitFor(() => notifications.slice(startIndex).some((text) => text.includes("active tools")), 60_000, label);
    return notifications.slice(startIndex).join("\n");
  }

  function lastNotification(matcher) {
    for (let index = notifications.length - 1; index >= 0; index -= 1) {
      if (matcher(notifications[index])) return notifications[index];
    }
    return undefined;
  }

  try {
    const state = await send({ type: "get_state" }, 120_000);
    check("rpc session started", state.success === true);

    const commands = await send({ type: "get_commands" }, 60_000);
    const names = (commands.data?.commands ?? []).map((command) => command.name);
    check("/switch registered", names.includes("/switch") || names.includes("switch"), names.join(", "));

    await runSlash("/switch list");
    check("/switch list notified", lastNotification((text) => text.includes("active profile")) !== undefined);

    await runSlash("/switch show zen");
    check("/switch show zen notified", lastNotification((text) => text.includes("Resolved configuration")) !== undefined, notifications.slice(-2).join(" | "));

    await runSlash("/switch zen");
    const applied = await waitFor(
      () => lastNotification((text) => text.includes('profile "zen"')) !== undefined,
      120_000,
      "switch zen summary notification",
    );
    check("/switch zen reported changes", applied, notifications.slice(-2).join(" | "));

    // The footer is a setStatus call, which rpc mode forwards as statusText. pi renders the status
    // row verbatim, so the brackets, the name, and the theme color all have to be in that string.
    const footerStatus = statusUpdates.filter((entry) => entry.key === "pi-switch-profile").slice(-1)[0];
    const plainFooter = footerStatus === undefined ? undefined : footerStatus.text.replace(ANSI_CODES, "");
    check(
      "the footer brackets the profile name and colors it",
      plainFooter === "[zen]" && SGR_TRUECOLOR.test(footerStatus.text),
      JSON.stringify(footerStatus),
    );

    const after = readSettings();
    const enabled = (after.packages ?? []).filter((entry) => !isDisabledEntry(entry));
    const disabled = (after.packages ?? []).filter(isDisabledEntry);
    check(
      "zen disabled the other packages",
      enabled.length + disabled.length === (after.packages ?? []).length
        && disabled.length > 0
        && enabled.every((entry) => resolvesToRepoRoot(packageSourceOf(entry))),
      `${enabled.length} enabled / ${disabled.length} disabled of ${(after.packages ?? []).length}: ${enabled.map(packageSourceOf).join(", ")}`,
    );
    check("zen kept its own package enabled", enabled.some((entry) => resolvesToRepoRoot(packageSourceOf(entry))), enabled.map(packageSourceOf).join(", "));
    check("zen set theme system", after.theme === "system", after.theme);
    check("zen kept unmanaged settings", after.compaction !== undefined && after.defaultModel === before.defaultModel);
    check("zen set defaultTools", JSON.stringify(after.defaultTools) === JSON.stringify(["read", "bash", "edit", "write"]), JSON.stringify(after.defaultTools));

    // The reload replaces the extension runtime: /switch must still be registered.
    const commandsAfter = await send({ type: "get_commands" }, 120_000);
    const namesAfter = (commandsAfter.data?.commands ?? []).map((command) => command.name);
    check("/switch survived the zen reload", namesAfter.includes("switch"), `${namesAfter.length} commands`);

    await runSlash("/switch list");
    check("/switch list works after reload", lastNotification((text) => text.includes("active profile")) !== undefined, notifications.slice(-2).join(" | "));

    await runSlash("/switch show default");
    check("/switch show works after reload", lastNotification((text) => text.includes("Resolved configuration")) !== undefined, notifications.slice(-2).join(" | "));

    const listText = lastNotification((text) => text.includes("active profile")) ?? "";
    check("no false drift warning after switching a profile", !listText.includes("Settings differ from profile"), listText.slice(-300));

    // doctor reports what the reloaded session really has: the profile's tools, and
    // none of the tools from packages the profile disabled.
    const doctorText = await runDoctor("doctor report");
    const activeMatch = doctorText.match(/active tools \((\d+)\):([^\n]*)/);
    const activeTools = activeMatch ? activeMatch[2].split(",").map((name) => name.trim()).filter(Boolean) : [];
    check(
      "zen tool profile is active in the reloaded session",
      activeTools.length === 4 && ["read", "bash", "edit", "write"].every((name) => activeTools.includes(name)),
      doctorText.split("\n").filter((line) => line.includes("tools")).join(" | "),
    );
    check(
      "tools from disabled packages are gone",
      !/ast_grep_search|ast_grep_replace|browser_navigate|lens_diagnostic_mark/.test(doctorText),
      doctorText.match(/configured tools[^\n]*/)?.[0] ?? doctorText,
    );
    check("doctor confirms settings match the active profile", doctorText.includes('Settings match profile "zen"'), doctorText.slice(-200));

    // save / list / delete round trip, and a profile name that would be unreachable.
    await runSlash("/switch save snapshot");
    check("save reports the new profile", lastNotification((text) => text.includes('saved profile "snapshot"')) !== undefined, notifications.slice(-2).join(" | "));
    await runSlash("/switch list");
    check("saved profile appears in the list", (lastNotification((text) => text.includes("active profile")) ?? "").includes("snapshot"), notifications.slice(-1)[0]);
    await runSlash("/switch nosuchprofile");
    check(
      "an unknown profile reports an error naming the known ones",
      lastNotification((text) => text.includes("Unknown profile") && text.includes("Known profiles")) !== undefined,
      notifications.slice(-1)[0],
    );

    await runSlash("/switch save doctor");
    check("save rejects a name shadowed by a subcommand", lastNotification((text) => text.includes("is a subcommand")) !== undefined, notifications.slice(-1)[0]);
    // Make the saved profile the active one, so deleting it demonstrates the warning that
    // the deleted profile's settings stay applied. (zen has to survive for the revert test.)
    await runSlash("/switch snapshot");
    await waitFor(() => lastNotification((text) => text.includes('profile "snapshot"')) !== undefined, 120_000, "switch to the saved profile");
    await runSlash("/switch delete snapshot");
    check("delete reports the removal", lastNotification((text) => text.includes('removed profile "snapshot"')) !== undefined, notifications.slice(-2).join(" | "));
    check(
      "deleting the active profile warns that its settings stay applied",
      lastNotification((text) => text.includes("it was the active one")) !== undefined,
      notifications.slice(-1)[0],
    );

    // Only the last switch is undoable now: the record lives in its own single-entry file.
    await runSlash("/switch restore");
    await waitFor(
      () => lastNotification((text) => text.includes("restored")) !== undefined,
      120_000,
      "restore of the switch to the saved profile",
    );
    const backToZen = readSettings();
    check(
      "one restore undoes exactly the switch to the saved profile",
      backToZen.theme === "system" && JSON.stringify(backToZen.defaultTools) === JSON.stringify(["read", "bash", "edit", "write"]),
      { theme: backToZen.theme, defaultTools: backToZen.defaultTools },
    );
    check(
      "the undo record is consumed by the restore",
      !existsSync(join(agentDir, "pi-switch-undo.json")),
      listUndoFiles(),
    );

    await runSlash("/switch restore");
    await waitFor(
      () => lastNotification((text) => text.includes("nothing to restore")) !== undefined,
      60_000,
      "second restore reports nothing left",
    );
    check(
      "a second restore does not reach further back",
      readSettings().theme === "system",
      readSettings().theme,
    );

    // Switching to the base snapshot is what puts the captured configuration back.
    await runSlash("/switch base");
    await waitFor(
      () => lastNotification((text) => text.includes('profile "base"')) !== undefined,
      120_000,
      "switch base summary notification",
    );
    const restored = readSettings();
    // The package *set* is what comes back; a profile policy decides each entry's form (plain string
    // vs `autoload: false`), so the run compares sources rather than the exact JSON it started with.
    check(
      "base puts the captured settings back",
      (restored.packages ?? []).length === (installed.packages ?? []).length
        && JSON.stringify((restored.packages ?? []).map(packageSourceOf).sort()) === JSON.stringify((installed.packages ?? []).map(packageSourceOf).sort()),
      (restored.packages ?? []).map(packageSourceOf),
    );
    check("base restores the theme", restored.theme === before.theme, restored.theme);

    await runSlash("/switch refresh");
    check("refresh reports a new base snapshot", lastNotification((text) => text.includes("base snapshot updated")) !== undefined, notifications.slice(-1)[0]);
    const storeFile = JSON.parse(readFileSync(storePaths[0], "utf8"));
    check("refresh persisted the base", JSON.stringify(storeFile.base?.theme) === JSON.stringify(restored.theme), storeFile.base?.theme);
    check(
      "the profile store keeps no history array",
      storeFile.history === undefined,
      Object.keys(storeFile),
    );

    // The main happy path after a reload: switch forward again, not just back.
    await runSlash("/switch default");
    const backOn = await waitFor(
      () => lastNotification((text) => text.includes('profile "default"')) !== undefined,
      120_000,
      "switch default summary notification",
    );
    check("switching to default after a reload reports changes", backOn, notifications.slice(-2).join(" | "));

    const afterDefault = readSettings();
    check(
      "default re-enables every known package",
      (afterDefault.packages ?? []).length === (installed.packages ?? []).length && unexpectedlyDisabled(afterDefault).length === 0,
      JSON.stringify(afterDefault.packages ?? []).slice(0, 300),
    );
    check("default drops the zen tool list", afterDefault.defaultTools === undefined, JSON.stringify(afterDefault.defaultTools));
    check("default restores the base theme", afterDefault.theme === before.theme, afterDefault.theme);

    const commandsDefault = await send({ type: "get_commands" }, 120_000);
    const defaultNames = (commandsDefault.data?.commands ?? []).map((command) => command.name);
    check("/switch survives the second reload", defaultNames.includes("switch"), `${defaultNames.length} commands`);

    const defaultDoctor = await runDoctor("doctor report after default");
    check(
      "tools from re-enabled packages are configured again",
      /ast_grep_search|lens_diagnostic_mark|browser_navigate|web_search/.test(defaultDoctor),
      defaultDoctor.match(/configured tools[^\n]*/)?.[0] ?? defaultDoctor,
    );

    // A hand-written profile that uses `exclude`: everything except one package.
    const storeOnDisk = JSON.parse(readFileSync(profileStorePaths[0], "utf8"));
    storeOnDisk.profiles = {
      ...(storeOnDisk.profiles ?? {}),
      "no-web": { description: "everything except pi-web-access", exclude: { packages: ["pi-web-access"] } },
    };
    writeFileSync(profileStorePaths[0], JSON.stringify(storeOnDisk), "utf8");
    const packagesBeforeExclude = (readSettings().packages ?? []).length;
    await runSlash("/switch no-web");
    await waitFor(
      () => lastNotification((text) => text.includes('profile "no-web"')) !== undefined,
      120_000,
      "switch no-web summary notification",
    );
    const afterExclude = readSettings();
    const excludedPackages = (afterExclude.packages ?? [])
      .filter((entry) => typeof entry === "object" && entry !== null && entry.autoload === false)
      .map((entry) => String(entry.source));
    check(
      "exclude disables only the named package",
      excludedPackages.length === 1 && excludedPackages[0].includes("pi-web-access"),
      JSON.stringify(excludedPackages),
    );
    check(
      "exclude keeps every other package enabled",
      (afterExclude.packages ?? []).length === packagesBeforeExclude,
      `${(afterExclude.packages ?? []).length} entries, was ${packagesBeforeExclude}`,
    );

    /*
     * /switch install: make one resource loadable only in named profiles. The probe extension
     * is a real auto-discovered resource, so its registered command proves the reload applied
     * the exclusion, and /switch restore has to put both the settings and the profiles back.
     */
    await runSlash("/switch default");
    await waitFor(
      () => lastNotification((text) => text.includes('profile "default"')) !== undefined,
      120_000,
      "switch default before the install checks",
    );
    const commandNames = async () => {
      const response = await send({ type: "get_commands" }, 120_000);
      return (response.data?.commands ?? []).map((command) => command.name);
    };
    const namesBeforeInstall = await commandNames();
    check("the probe extension is loaded before the install check", namesBeforeInstall.includes("zzz-switch-live"), namesBeforeInstall.length);

    const storeForInstall = readStore();
    storeForInstall.profiles = { ...(storeForInstall.profiles ?? {}), keep: { description: "starts from nothing", extensions: [] } };
    writeFileSync(profileStorePaths[0], JSON.stringify(storeForInstall), "utf8");

    await runSlash("/switch install extensions/zzz-switch-live.ts --only keep");
    await waitFor(
      () => lastNotification((text) => text.includes("install extensions/zzz-switch-live.ts")) !== undefined,
      120_000,
      "install summary notification",
    );
    const storeAfterInstall = readStore();
    check(
      "install put the resource in the named profile's whitelist",
      JSON.stringify(storeAfterInstall.profiles?.keep?.extensions) === JSON.stringify(["extensions/zzz-switch-live.ts"]),
      storeAfterInstall.profiles?.keep,
    );
    check(
      "install excluded the resource from the other profiles",
      ["base", "default", "zen"].every((name) => (storeAfterInstall.profiles?.[name]?.exclude?.extensions ?? []).length > 0),
      Object.entries(storeAfterInstall.profiles ?? {}).map(([name, profile]) => `${name}=${JSON.stringify(profile?.exclude?.extensions ?? [])}`),
    );
    const settingsAfterInstall = readSettings().extensions ?? [];
    check(
      "the active profile denies exactly that resource and nothing else",
      settingsAfterInstall.includes("!extensions/zzz-switch-live.ts") && !settingsAfterInstall.includes("!extensions/**"),
      JSON.stringify(settingsAfterInstall),
    );
    const namesAfterInstall = await commandNames();
    check("the excluded extension stops responding after the reload", !namesAfterInstall.includes("zzz-switch-live"), namesAfterInstall.length);
    check("/switch survives the install reload", namesAfterInstall.includes("switch"), namesAfterInstall.length);

    await runSlash("/switch restore");
    await waitFor(() => lastNotification((text) => text.includes("restored")) !== undefined, 120_000, "restore after the install");
    const storeAfterRestore = readStore();
    check(
      "restore puts the profiles map back as it was",
      JSON.stringify(storeAfterRestore.profiles?.keep?.extensions) === JSON.stringify([])
        && (storeAfterRestore.profiles?.default?.exclude?.extensions ?? []).length === 0,
      { keep: storeAfterRestore.profiles?.keep, default: storeAfterRestore.profiles?.default },
    );
    const namesAfterRestore = await commandNames();
    check("the resource is loadable again after restore", namesAfterRestore.includes("zzz-switch-live"), namesAfterRestore.length);

    const fixture = themeFixture();
    if (fixture === undefined) {
      check("a package that provides themes is installed for the theme checks", false, "no installed package has a themes/ directory");
    } else {
      await runSlash(`/switch install ${fixture.source} --only keep`);
      await waitFor(
        () => lastNotification((text) => text.includes(`install ${fixture.source}`)) !== undefined,
        120_000,
        "package install summary notification",
      );
      const disabledPackages = (readSettings().packages ?? []).filter(isDisabledEntry).map(packageSourceOf);
      check(
        "install --only disables the package for every other profile",
        disabledPackages.includes(fixture.source) && unexpectedlyDisabled(readSettings(), [fixture.source]).length === 0,
        JSON.stringify(disabledPackages),
      );
      const storeAfterPackage = readStore();
      check(
        "the named profile keeps the package without gaining a whitelist",
        (storeAfterPackage.profiles?.keep?.exclude?.packages ?? []).length === 0
          && storeAfterPackage.profiles?.keep?.packages === undefined,
        storeAfterPackage.profiles?.keep,
      );
      await runSlash("/switch restore");
      await waitFor(() => lastNotification((text) => text.includes("restored")) !== undefined, 120_000, "restore after the package install");
      check(
        "restore re-enables the package",
        (readSettings().packages ?? []).some((entry) => !isDisabledEntry(entry) && packageSourceOf(entry) === fixture.source)
          && unexpectedlyDisabled(readSettings()).length === 0,
        (readSettings().packages ?? []).filter(isDisabledEntry).map(packageSourceOf),
      );

      // The theme a profile selects outranks the policy that would switch its provider off.
      const themeStore = readStore();
      themeStore.profiles = {
        ...(themeStore.profiles ?? {}),
        "theme-only": { description: "packages off, package theme kept", packages: [], theme: fixture.theme },
      };
      writeFileSync(storePaths[0], `${JSON.stringify(themeStore, null, 2)}\n`, "utf8");
      await runSlash("/switch theme-only");
      await waitFor(() => lastNotification((text) => text.includes('profile "theme-only"')) !== undefined, 120_000, "theme-only switch summary");
      const themeEntry = (readSettings().packages ?? []).find((entry) => packageSourceOf(entry) === fixture.source);
      check(
        "a profile that turns packages off keeps the package that provides its theme, for that theme only",
        themeEntry !== undefined && isDisabledEntry(themeEntry) && JSON.stringify(themeEntry.themes) === JSON.stringify([`+themes/${fixture.file}`]),
        JSON.stringify(themeEntry),
      );
      check("the theme the profile selected is the one written", readSettings().theme === fixture.theme, readSettings().theme);
      const themeReport = notifications.slice(-12).join("\n");
      check(
        "the switch summary says which package the theme kept",
        themeReport.includes(fixture.source) && themeReport.includes("kept for that theme only"),
        themeReport.slice(-300),
      );
      const themeCommands = await commandNames();
      check("/switch survives the theme keep reload", themeCommands.includes("switch"), themeCommands.length);

      await runSlash("/switch default");
      await waitFor(() => lastNotification((text) => text.includes('profile "default"')) !== undefined, 120_000, "back to default after theme-only");
      check(
        "a profile that enables the package takes the theme force-include back off",
        (readSettings().packages ?? []).some((entry) => !isDisabledEntry(entry) && packageSourceOf(entry) === fixture.source),
        (readSettings().packages ?? []).find((entry) => packageSourceOf(entry) === fixture.source),
      );
    }

    await runSlash("/switch install zzz-switch-live");
    check(
      "install without --only explains that nothing needed changing",
      lastNotification((text) => text.includes("already loaded by every profile")) !== undefined,
      notifications.slice(-1)[0],
    );
    await runSlash("/switch install npm:definitely-not-installed --only nosuchprofile");
    check("install rejects an unknown profile", lastNotification((text) => text.includes("unknown profile")) !== undefined, notifications.slice(-1)[0]);
    check(
      "a rejected install wrote no package entry",
      (readSettings().packages ?? []).every((entry) => !String(typeof entry === "string" ? entry : entry?.source).includes("definitely-not-installed")),
      JSON.stringify(readSettings().packages ?? []).slice(0, 200),
    );

    // A profile created by /switch save must be switchable, and restore must undo exactly one switch.
    await runSlash("/switch save last");
    check("save reports the second saved profile", lastNotification((text) => text.includes('saved profile "last"')) !== undefined, notifications.slice(-1)[0]);

    const beforeSavedSwitch = readSettings();
    const profileBeforeSavedSwitch = readStore().activeProfile;
    await runSlash("/switch last");
    const appliedSaved = await waitFor(
      () => lastNotification((text) => text.includes('profile "last"')) !== undefined,
      120_000,
      "switch last summary notification",
    );
    check("a saved profile can be switched to", appliedSaved, notifications.slice(-2).join(" | "));

    await runSlash("/switch restore");
    await waitFor(() => lastNotification((text) => text.includes("restored")) !== undefined, 120_000, "restore after the saved profile");
    const backAfterSaved = readSettings();
    check(
      "restore undoes exactly the last switch",
      JSON.stringify(backAfterSaved.theme) === JSON.stringify(beforeSavedSwitch.theme)
        && JSON.stringify(backAfterSaved.packages) === JSON.stringify(beforeSavedSwitch.packages)
        && JSON.stringify(backAfterSaved.defaultTools) === JSON.stringify(beforeSavedSwitch.defaultTools),
      { theme: backAfterSaved.theme, packages: (backAfterSaved.packages ?? []).length, defaultTools: backAfterSaved.defaultTools },
    );
    const doctorAfterRestore = await runDoctor("doctor report after restore");
    check(
      "restore re-activates the profile it returns to",
      doctorAfterRestore.includes(`Settings match profile "${profileBeforeSavedSwitch}"`),
      doctorAfterRestore.slice(-200),
    );
    // revertSession "end": a clean session close puts the default configuration back.
    await runSlash("/switch revert-session");
    check("revert-session reports its state", lastNotification((text) => text.includes("revert-session:")) !== undefined, notifications.slice(-1)[0]);

    await runSlash("/switch zen");
    await waitFor(() => lastNotification((text) => text.includes('profile "zen"')) !== undefined, 120_000, "zen before the revert test");
    check("zen is applied before the revert test", readSettings().theme === "system", readSettings().theme);

    await runSlash("/switch revert-session end");
    check("revert-session end confirmed", lastNotification((text) => text.includes("revert-session: end")) !== undefined, notifications.slice(-1)[0]);

    // Closing stdin makes rpc mode dispose the session, which is session_shutdown with
    // reason "quit" - the only place the revert runs.
    activeChild.stdin.end();
    const first = await waitForPromise(firstExit, 120_000);
    check("pi shut down cleanly when stdin closed", first !== undefined && first.code === 0, JSON.stringify(first));

    const afterQuit = readSettings();
    check(
      "closing the session reverted to the default configuration",
      afterQuit.theme === before.theme
        && (afterQuit.packages ?? []).length === (installed.packages ?? []).length
        && unexpectedlyDisabled(afterQuit).length === 0
        && afterQuit.defaultTools === undefined,
      { theme: afterQuit.theme, defaultTools: afterQuit.defaultTools, packages: (afterQuit.packages ?? []).length },
    );

    const storeAfterQuit = readStore();
    check("the revert mode persisted across the session", storeAfterQuit.revertSession === "end", storeAfterQuit.revertSession);
    check("the revert set the active profile to default", storeAfterQuit.activeProfile === "default", storeAfterQuit.activeProfile);
    check("the revert recorded a notice for the next session", storeAfterQuit.revertedOnQuit?.fromProfile === "zen", storeAfterQuit.revertedOnQuit);
    check(
      "the revert recorded an undo record for /switch restore",
      readUndo()?.toProfile === "default",
      readUndo(),
    );

    // The revert happens while the UI is tearing down, so the notice has to arrive in the
    // session after it.
    secondChild = spawn("pi", ["--mode", "rpc"], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
    const secondExit = attachSession(secondChild);
    activeChild = secondChild;
    await send({ type: "get_state" }, 150_000);
    const noticed = await waitFor(() => lastNotification((text) => text.includes("when the previous session closed")) !== undefined, 60_000, "revert notice at session start");
    check("the next session reports the revert", noticed, notifications.slice(-2).join(" | "));
    check("the revert notice is cleared after being shown", readStore().revertedOnQuit === undefined, readStore().revertedOnQuit);

    // revertSession "start": settings left on a profile by a session that could not revert
    // itself are put back when the next session starts.
    await runSlash("/switch revert-session start");
    check("revert-session start confirmed", lastNotification((text) => text.includes("revert-session: start")) !== undefined, notifications.slice(-1)[0]);

    const currentPackages = readSettings().packages ?? [];
    const firstSource = typeof currentPackages[0] === "string" ? currentPackages[0] : currentPackages[0]?.source;
    const stale = {
      ...readSettings(),
      theme: "system",
      defaultTools: ["read", "bash"],
      // A disabled package is the part a live session cannot undo without a reload.
      packages: currentPackages.map((entry, index) => (index === 0 ? { source: firstSource, autoload: false } : entry)),
    };
    writeFileSync(settingsPath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");

    secondChild.stdin.end();
    const second = await waitForPromise(secondExit, 90_000);
    check("second session shut down cleanly", second !== undefined && second.code === 0, JSON.stringify(second));
    check(
      "a start-mode session leaves the settings alone at close",
      readSettings().theme === "system" && JSON.stringify(readSettings().defaultTools) === JSON.stringify(["read", "bash"]),
      { theme: readSettings().theme, defaultTools: readSettings().defaultTools },
    );

    thirdChild = spawn("pi", ["--mode", "rpc"], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
    const thirdExit = attachSession(thirdChild);
    activeChild = thirdChild;
    await send({ type: "get_state" }, 150_000);
    const restoredAtStart = await waitFor(
      () => lastNotification((text) => text.includes("restored the default configuration at session start")) !== undefined,
      60_000,
      "start revert notification",
    );
    check("a new session reverts settings left on a profile", restoredAtStart, notifications.slice(-2).join(" | "));
    const afterStart = readSettings();
    check(
      "the start revert put the default configuration back",
      afterStart.theme === before.theme
        && afterStart.defaultTools === undefined
        && unexpectedlyDisabled(afterStart).length === 0,
      { theme: afterStart.theme, defaultTools: afterStart.defaultTools, packages: (afterStart.packages ?? []).length },
    );
    check("the start revert recorded the profile it returned to", readStore().activeProfile === "default", readStore().activeProfile);
    check("the start revert left no notice for a later session", readStore().revertedOnQuit === undefined, readStore().revertedOnQuit);

    // The stale settings had a disabled package, so the revert has to reload the session
    // for it to actually take effect.
    const reloading = await waitFor(
      () => lastNotification((text) => text.includes("reloading so the previous profile")) !== undefined,
      60_000,
      "automatic reload after the start revert",
    );
    check("the start revert reloads the session", reloading, notifications.slice(-3).join(" | "));

    const commandsAfterRevert = await send({ type: "get_commands" }, 120_000);
    const revertNames = (commandsAfterRevert.data?.commands ?? []).map((command) => command.name);
    check("/switch survives the automatic reload", revertNames.includes("switch"), `${revertNames.length} commands`);

    const revertDoctor = await runDoctor("doctor report after the start revert");
    check(
      "the session really is on the default configuration after the start revert",
      revertDoctor.includes('Settings match profile "default"') && /ast_grep_search|lens_diagnostic_mark|browser_navigate|web_search/.test(revertDoctor),
      { match: revertDoctor.includes('Settings match profile "default"'), tools: revertDoctor.match(/configured tools[^\n]*/)?.[0] ?? revertDoctor.slice(-200) },
    );

    thirdChild.stdin.end();
    const third = await waitForPromise(thirdExit, 90_000);
    check("third session shut down cleanly", third !== undefined && third.code === 0, JSON.stringify(third));
    check(
      "a session with nothing to revert leaves the settings alone",
      readSettings().theme === before.theme && readStore().revertedOnQuit === undefined,
      { theme: readSettings().theme },
    );
  } finally {
    for (const session of [firstChild, secondChild, thirdChild]) {
      if (session === null) continue;
      try {
        session.stdin.end();
      } catch {}
      session.kill("SIGTERM");
    }
    if (existsSync(backupPath)) {
      copyFileSync(backupPath, settingsPath);
      unlinkSync(backupPath);
      log("restored the original settings.json");
    }
    for (const [path, backup] of zip2(storePaths, storeBackupPaths)) {
      if (existsSync(backup)) {
        copyFileSync(backup, path);
        unlinkSync(backup);
      } else if (existsSync(path)) {
        // Created by this run (for example the rename from the pre-rename store name).
        unlinkSync(path);
      }
    }
    log("restored the original profile store");
    if (!probeExisted && existsSync(probeExtPath)) unlinkSync(probeExtPath);
  }

  const failures = results.filter((result) => !result.ok);
  log(`${results.length - failures.length}/${results.length} live checks passed`);
  if (failures.length > 0) process.exit(1);
}

function waitForPromise(promise, timeoutMs) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs))]);
}

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        log(`timeout waiting for ${label}`);
        resolve(false);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

main().catch((error) => {
  log(`ERROR: ${error.message}`);
  process.exit(1);
});

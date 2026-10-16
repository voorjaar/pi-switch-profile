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
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(repoRoot, "extensions", "switch.ts");
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const settingsPath = join(agentDir, "settings.json");
const backupPath = join(agentDir, "settings.json.live-test.bak");
const storePaths = [join(agentDir, "pi-switch-profile.json"), join(agentDir, "pi-switch-config.json")];
const storeBackupPaths = storePaths.map((path) => `${path}.live-test.bak`);

const results = [];
const notifications = [];
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
  for (const path of storePaths) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // try the next candidate name
    }
  }
  return {};
}

/** Wire a pi rpc child into the shared notification/waiter state; resolves on exit. */
function attachSession(child) {
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      handleLine(line);
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[pi] ${chunk}`));
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
}

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
  if (record.id && waiters.has(record.id)) {
    const settle = waiters.get(record.id);
    waiters.delete(record.id);
    settle(record);
  }
}

async function main() {
  if (!existsSync(extensionPath)) throw new Error(`missing extension entry: ${extensionPath}`);
  if (!existsSync(settingsPath)) throw new Error(`no settings.json at ${settingsPath}`);
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
  // that entry enabled or /switch would disappear after the reload.
  const installed = { ...before, packages: [...(before.packages ?? []), repoRoot] };
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

    const after = readSettings();
    const total = (installed.packages ?? []).length;
    const enabled = (after.packages ?? []).filter((entry) => typeof entry === "string");
    const disabled = (after.packages ?? []).filter((entry) => entry && entry.autoload === false);
    check("zen disabled the other packages", enabled.length + disabled.length === total && disabled.length > 0, `${enabled.length} enabled / ${disabled.length} disabled of ${total}`);
    check("zen kept its own package enabled", enabled.some((entry) => String(entry).includes("pi-switch")), enabled.join(", "));
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

    // Two switches are in the history now (zen, then snapshot) and one restore undoes one.
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

    await runSlash("/switch restore");
    await waitFor(
      () => lastNotification((text) => text.includes("restored")) !== undefined,
      120_000,
      "restore summary notification",
    );
    const restored = readSettings();
    check("restore put packages back", JSON.stringify(restored.packages) === JSON.stringify(installed.packages));
    check("restore put theme back", restored.theme === before.theme, restored.theme);

    await runSlash("/switch refresh");
    check("refresh reports a new base snapshot", lastNotification((text) => text.includes("base snapshot updated")) !== undefined, notifications.slice(-1)[0]);
    const storeFile = JSON.parse(readFileSync(storePaths[0], "utf8"));
    check("refresh persisted the base", JSON.stringify(storeFile.base?.theme) === JSON.stringify(restored.theme), storeFile.base?.theme);

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
      (afterDefault.packages ?? []).length === (installed.packages ?? []).length && (afterDefault.packages ?? []).every((entry) => typeof entry === "string"),
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

    // A profile created by /switch save must be switchable, and restore must undo exactly one switch.
    await runSlash("/switch save last");
    check("save reports the second saved profile", lastNotification((text) => text.includes('saved profile "last"')) !== undefined, notifications.slice(-1)[0]);

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
      JSON.stringify(backAfterSaved.theme) === JSON.stringify(afterDefault.theme)
        && JSON.stringify(backAfterSaved.packages) === JSON.stringify(afterDefault.packages)
        && JSON.stringify(backAfterSaved.defaultTools) === JSON.stringify(afterDefault.defaultTools),
      { theme: backAfterSaved.theme, packages: (backAfterSaved.packages ?? []).length, defaultTools: backAfterSaved.defaultTools },
    );
    const doctorAfterRestore = await runDoctor("doctor report after restore");
    check(
      "restore re-activates the profile it returns to",
      doctorAfterRestore.includes('Settings match profile "default"'),
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
        && (afterQuit.packages ?? []).every((entry) => typeof entry === "string")
        && afterQuit.defaultTools === undefined,
      { theme: afterQuit.theme, defaultTools: afterQuit.defaultTools, packages: (afterQuit.packages ?? []).length },
    );

    const storeAfterQuit = readStore();
    check("the revert mode persisted across the session", storeAfterQuit.revertSession === "end", storeAfterQuit.revertSession);
    check("the revert set the active profile to default", storeAfterQuit.activeProfile === "default", storeAfterQuit.activeProfile);
    check("the revert recorded a notice for the next session", storeAfterQuit.revertedOnQuit?.fromProfile === "zen", storeAfterQuit.revertedOnQuit);
    check("the revert is undoable from history", (storeAfterQuit.history ?? []).slice(-1)[0]?.toProfile === "default", (storeAfterQuit.history ?? []).slice(-1)[0]);

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
        && (afterStart.packages ?? []).every((entry) => typeof entry === "string"),
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

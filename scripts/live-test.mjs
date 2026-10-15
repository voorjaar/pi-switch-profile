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

async function main() {
  if (!existsSync(extensionPath)) throw new Error(`missing extension entry: ${extensionPath}`);
  if (!existsSync(settingsPath)) throw new Error(`no settings.json at ${settingsPath}`);
  copyFileSync(settingsPath, backupPath);
  const before = readSettings();
  // Install this package the way a user would, so the run exercises the real
  // path: the extension is loaded from settings.packages, and "zen" has to keep
  // that entry enabled or /switch would disappear after the reload.
  const installed = { ...before, packages: [...(before.packages ?? []), repoRoot] };
  writeFileSync(settingsPath, `${JSON.stringify(installed, null, 2)}\n`, "utf8");
  log(`backed up settings.json and installed ${repoRoot} (${installed.packages.length} packages)`);

  const child = spawn("pi", ["--mode", "rpc"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

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
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  async function runSlash(message, timeoutMs = 90_000) {
    const response = await send({ type: "prompt", message }, timeoutMs);
    if (!response.success) throw new Error(`${message} rejected: ${response.error}`);
    log(`${message} -> ${response.data?.disposition ?? "?"}`);
    return response;
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
    check("zen kept pi-switch-config enabled", enabled.some((entry) => String(entry).includes("pi-switch-config")), enabled.join(", "));
    check("zen set theme system", after.theme === "system", after.theme);
    check("zen kept unmanaged settings", after.compaction !== undefined && after.defaultModel === before.defaultModel);
    check("zen set defaultTools", JSON.stringify(after.defaultTools) === JSON.stringify(["read", "bash", "edit", "write"]), JSON.stringify(after.defaultTools));

    // The reload replaces the extension runtime: /switch must still be registered.
    const commandsAfter = await send({ type: "get_commands" }, 120_000);
    const namesAfter = (commandsAfter.data?.commands ?? []).map((command) => command.name);
    check("/switch survived the zen reload", namesAfter.includes("switch"), `${namesAfter.length} commands`);

    await runSlash("/switch list");
    check("/switch list works after reload", lastNotification((text) => text.includes("active profile")) !== undefined, notifications.slice(-2).join(" | "));

    await runSlash("/switch show coder");
    check("/switch show works after reload", lastNotification((text) => text.includes("Resolved configuration")) !== undefined, notifications.slice(-2).join(" | "));

    const listText = lastNotification((text) => text.includes("active profile")) ?? "";
    check("no false drift warning after switching a profile", !listText.includes("Settings differ from profile"), listText.slice(-300));

    // doctor reports what the reloaded session really has: the profile's tools, and
    // none of the tools from packages the profile disabled.
    await runSlash("/switch doctor");
    await waitFor(() => lastNotification((text) => text.includes("active tools")) !== undefined, 60_000, "doctor report");
    const doctorText = lastNotification((text) => text.includes("active tools")) ?? "";
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

    await runSlash("/switch restore");
    await waitFor(
      () => lastNotification((text) => text.includes("restored")) !== undefined,
      120_000,
      "restore summary notification",
    );
    const restored = readSettings();
    check("restore put packages back", JSON.stringify(restored.packages) === JSON.stringify(installed.packages));
    check("restore put theme back", restored.theme === before.theme, restored.theme);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    if (existsSync(backupPath)) {
      copyFileSync(backupPath, settingsPath);
      unlinkSync(backupPath);
      log("restored the original settings.json");
    }
  }

  const failures = results.filter((result) => !result.ok);
  log(`${results.length - failures.length}/${results.length} live checks passed`);
  if (failures.length > 0) process.exit(1);
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

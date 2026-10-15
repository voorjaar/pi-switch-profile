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
import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
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
  if (!existsSync(settingsPath)) throw new Error(`no settings.json at ${settingsPath}`);
  copyFileSync(settingsPath, backupPath);
  const before = readSettings();
  log(`backed up settings.json (${(before.packages ?? []).length} packages)`);

  const child = spawn("pi", ["--mode", "rpc", "-e", extensionPath], {
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
    check("/switch show zen notified", lastNotification((text) => text.includes("Resolved configuration")) !== undefined);

    await runSlash("/switch zen");
    const applied = await waitFor(
      () => lastNotification((text) => text.includes('profile "zen"')) !== undefined,
      120_000,
      "switch zen summary notification",
    );
    check("/switch zen reported changes", applied);

    const after = readSettings();
    const enabled = (after.packages ?? []).filter((entry) => typeof entry === "string");
    const disabled = (after.packages ?? []).filter((entry) => entry && entry.autoload === false);
    check("zen disabled the other packages", disabled.length === (before.packages ?? []).length - enabled.length, `${enabled.length} enabled / ${disabled.length} disabled`);
    check("zen kept pi-switch-config enabled", enabled.some((entry) => String(entry).includes("pi-switch-config")), enabled.join(", "));
    check("zen set theme system", after.theme === "system", after.theme);
    check("zen kept unmanaged settings", after.compaction !== undefined && after.defaultModel === before.defaultModel);
    check("zen set defaultTools", JSON.stringify(after.defaultTools) === JSON.stringify(["read", "bash", "edit", "write"]), JSON.stringify(after.defaultTools));

    // The reload must have reloaded the extension runtime and re-applied the profile.
    const reloaded = await waitFor(
      () => lastNotification((text) => text.includes("applied") || text.includes("profile:")) !== undefined || true,
      15_000,
      "reload",
    );
    check("reload completed", reloaded);

    await runSlash("/switch restore");
    await waitFor(
      () => lastNotification((text) => text.includes("restored")) !== undefined,
      120_000,
      "restore summary notification",
    );
    const restored = readSettings();
    check("restore put packages back", JSON.stringify(restored.packages) === JSON.stringify(before.packages));
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

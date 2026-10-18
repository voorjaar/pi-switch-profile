/**
 * Verify the published package copy is what a real session loads.
 *
 * No -e flag: settings.json alone has to provide the extension, so this proves an
 * `npm:pi-switch-profile` install works without the local checkout being listed.
 */
import { spawn } from "node:child_process";

const child = spawn("pi", ["--mode", "rpc"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });

const notifications = [];
const statusUpdates = [];
const waiters = new Map();
let pendingId = 0;

child.stdout.on("data", (chunk) => {
	for (const line of chunk.toString().split("\n")) {
		const text = line.trim();
		if (!text) continue;
		let record;
		try {
			record = JSON.parse(text);
		} catch {
			continue;
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
});
child.stderr.on("data", () => {});

function send(command, timeoutMs = 120_000) {
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

const results = [];
const check = (name, ok, detail = "") => {
	results.push(ok);
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` :: ${detail}` : ""}`);
};

try {
	const state = await send({ type: "get_state" }, 180_000);
	check("rpc session started from settings alone", state.success === true);

	const commands = await send({ type: "get_commands" }, 60_000);
	const names = (commands.data?.commands ?? []).map((command) => command.name);
	check("/switch registered", names.includes("/switch") || names.includes("switch"), names.join(", "));

	const before = notifications.length;
	const list = await send({ type: "prompt", message: "/switch list" });
	check("/switch list handled", list.data?.disposition === "handled", String(list.data?.disposition));
	const report = notifications.slice(before).join("\n");
	check("/switch list reports profiles", /active profile/.test(report), report.replace(/\n/g, " | ").slice(0, 200));

	// setStatus keys are per-extension; pi-lens also writes a status row, and every colored row
	// contains "[" inside its ANSI escape, so select by key and strip the escapes before matching.
	const status = statusUpdates.find((entry) => entry.key.includes("switch"));
	const plain = (status?.text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
	check(
		"footer label is [profile] in theme colors",
		/\[[^\]]*\]/.test(plain) && /\u001b\[38;2;/.test(status?.text ?? ""),
		JSON.stringify({ key: status?.key ?? null, plain }),
	);

	child.stdin.end();
	await new Promise((resolve) => child.on("exit", resolve));
} catch (error) {
	check("verification completed without error", false, String(error?.message ?? error));
	child.kill("SIGKILL");
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} installed-package checks passed`);
process.exit(failed ? 1 : 0);

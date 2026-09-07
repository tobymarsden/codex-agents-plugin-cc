import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { saveSessionId, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MONITOR_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "job-completion-monitor.mjs");
const POLL_INTERVAL_MS = 2000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Starts the monitor and collects the notification lines it prints. */
async function startMonitor(workspace, { args = [], spawnCwd = workspace } = {}) {
  const child = spawn(process.execPath, [MONITOR_SCRIPT, ...args], { cwd: spawnCwd, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    lines.push(...parts);
  });
  const exited = new Promise((resolve) => child.once("close", (code) => resolve(code)));

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  // Let the monitor take its startup snapshot of already-finished jobs before the test
  // drives any transition.
  await sleep(500);
  return { child, lines, exited };
}

/** Resolves to the monitor's exit code, or to "still running" if it never finishes. */
function waitForExit(exited, timeoutMs = 20000) {
  return Promise.race([exited, sleep(timeoutMs).then(() => "still running")]);
}

async function waitForLines(lines, count, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (lines.length < count && Date.now() < deadline) {
    await sleep(50);
  }
  return lines;
}

function finishedJob(patch) {
  const completedAt = new Date();
  return {
    startedAt: new Date(completedAt.getTime() - 183000).toISOString(),
    completedAt: completedAt.toISOString(),
    ...patch
  };
}

test("the monitor announces jobs that finish, and never the ones already finished at startup", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, finishedJob({ id: "task-old", status: "completed", summary: "work from an earlier session" }));
  upsertJob(workspace, { id: "task-new", status: "running", summary: "" });
  upsertJob(workspace, { id: "task-stopped", status: "running", summary: "" });

  const { child, lines } = await startMonitor(workspace);
  try {
    upsertJob(
      workspace,
      finishedJob({
        id: "task-new",
        status: "completed",
        summary: "fixed the flaky integration test by pinning the fake clock in the harness"
      })
    );
    upsertJob(workspace, finishedJob({ id: "task-stopped", status: "cancelled" }));

    await waitForLines(lines, 2);
    // Both finish inside one poll, and the index orders jobs by last update, so compare
    // the set of lines rather than their order.
    assert.deepEqual([...lines].sort(), [
      "Codex job task-new completed in 3m 3s: fixed the flaky integration test by pinning the fake cloc... — read it with TaskOutput.",
      "Codex job task-stopped cancelled after 3m 3s — read it with TaskOutput."
    ]);
  } finally {
    child.kill();
  }
});

test("the monitor scopes announcements to this session and reports why a job failed", async () => {
  const workspace = makeTempDir();
  saveSessionId(workspace, "session-a");
  upsertJob(workspace, { id: "task-mine", status: "running", sessionId: "session-a" });
  upsertJob(workspace, { id: "task-theirs", status: "running", sessionId: "session-b" });

  const { child, lines } = await startMonitor(workspace);
  try {
    upsertJob(
      workspace,
      finishedJob({ id: "task-theirs", status: "completed", sessionId: "session-b", summary: "another session's job" })
    );
    upsertJob(
      workspace,
      finishedJob({
        id: "task-mine",
        status: "failed",
        sessionId: "session-a",
        errorMessage: "codex exited with code 1"
      })
    );

    await waitForLines(lines, 1);
    // Both transitions land in the same poll, so once one line arrives the other job has
    // already been considered and skipped; wait one more poll before asserting nothing else.
    await sleep(POLL_INTERVAL_MS + 500);
    assert.deepEqual(lines, [
      "Codex job task-mine failed after 3m 3s: codex exited with code 1 — read it with TaskOutput."
    ]);
  } finally {
    child.kill();
  }
});

test("the monitor survives a missing state file and keeps running", async () => {
  const workspace = makeTempDir();

  const { child, lines } = await startMonitor(workspace);
  try {
    await sleep(POLL_INTERVAL_MS);
    assert.equal(child.exitCode, null);
    assert.deepEqual(lines, []);

    upsertJob(workspace, finishedJob({ id: "task-first", status: "completed", summary: "first job of the session" }));
    await waitForLines(lines, 1);
    assert.deepEqual(lines, [
      "Codex job task-first completed in 3m 3s: first job of the session — read it with TaskOutput."
    ]);
  } finally {
    child.kill();
  }
});

test("the monitor given --job announces only that job and then exits", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-watched", status: "running" });
  upsertJob(workspace, { id: "task-other", status: "running" });

  const { child, lines, exited } = await startMonitor(workspace, { args: ["--job", "task-watched"] });
  try {
    upsertJob(workspace, finishedJob({ id: "task-other", status: "completed", summary: "a job nobody armed a watch for" }));
    upsertJob(
      workspace,
      finishedJob({ id: "task-watched", status: "completed", summary: "the job the caller is waiting on" })
    );

    assert.equal(await waitForExit(exited), 0);
    assert.deepEqual(lines, [
      "Codex job task-watched completed in 3m 3s: the job the caller is waiting on — read it with TaskOutput."
    ]);
  } finally {
    child.kill();
  }
});

test("the monitor given --cwd watches that workspace rather than the one it runs in", async () => {
  const watched = makeTempDir();
  const elsewhere = makeTempDir();
  // The same job id lives in both workspaces, so the summary in the line says which
  // state directory the monitor actually read.
  upsertJob(watched, { id: "task-shared-id", status: "running" });
  upsertJob(elsewhere, { id: "task-shared-id", status: "running" });

  const { child, lines, exited } = await startMonitor(watched, {
    args: ["--cwd", watched, "--job", "task-shared-id"],
    spawnCwd: elsewhere
  });
  try {
    upsertJob(
      elsewhere,
      finishedJob({ id: "task-shared-id", status: "completed", summary: "the job in the process's own directory" })
    );
    upsertJob(
      watched,
      finishedJob({ id: "task-shared-id", status: "completed", summary: "the job in the watched workspace" })
    );

    assert.equal(await waitForExit(exited), 0);
    assert.deepEqual(lines, [
      "Codex job task-shared-id completed in 3m 3s: the job in the watched workspace — read it with TaskOutput."
    ]);
  } finally {
    child.kill();
  }
});

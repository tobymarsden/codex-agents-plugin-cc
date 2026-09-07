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
async function startMonitor(workspace) {
  const child = spawn(process.execPath, [MONITOR_SCRIPT], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    lines.push(...parts);
  });

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  // Let the monitor take its startup snapshot of already-finished jobs before the test
  // drives any transition.
  await sleep(500);
  return { child, lines };
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

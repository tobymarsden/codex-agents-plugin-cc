import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { listJobs, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState } from "../plugins/codex/scripts/lib/state.mjs";
import { resolveJobEventsFile } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

const STATE_MODULE_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../plugins/codex/scripts/lib/state.mjs")
).href;

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const eventsFile = resolveJobEventsFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(eventsFile, `{"n":1,"type":"message","text":"${jobId}"}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      eventsFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const prunedEventsFile = resolveJobEventsFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const retainedEventsFile = resolveJobEventsFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);
  assert.equal(fs.existsSync(retainedEventsFile), true);
  assert.equal(fs.existsSync(prunedLogFile), false);
  assert.equal(fs.existsSync(prunedEventsFile), false);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`, `${jobId}.events.jsonl`])
      .sort()
  );
});

test("upsertJob keeps every entry when concurrent processes write the same state file", async () => {
  const workspace = makeTempDir();
  const writerCount = 4;
  const jobsPerWriter = 8;
  const script = `
    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
    const { CODEX_TEST_WORKSPACE, CODEX_TEST_WRITER, CODEX_TEST_JOBS } = process.env;
    for (let index = 1; index <= Number(CODEX_TEST_JOBS); index += 1) {
      upsertJob(CODEX_TEST_WORKSPACE, { id: \`p\${CODEX_TEST_WRITER}-\${index}\`, status: "running" });
    }
  `;

  const exitCodes = await Promise.all(
    Array.from({ length: writerCount }, (_, writer) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "ignore", "inherit"],
        env: {
          ...process.env,
          CODEX_TEST_WORKSPACE: workspace,
          CODEX_TEST_WRITER: String(writer + 1),
          CODEX_TEST_JOBS: String(jobsPerWriter)
        }
      });
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      });
    })
  );

  assert.deepEqual(exitCodes, Array.from({ length: writerCount }, () => 0));

  const expectedIds = Array.from({ length: writerCount }, (_, writer) =>
    Array.from({ length: jobsPerWriter }, (_, index) => `p${writer + 1}-${index + 1}`)
  ).flat();

  assert.deepEqual(listJobs(workspace).map((job) => job.id).sort(), expectedIds.sort());
});

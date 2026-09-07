import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveSessionFile, resolveStateDir, saveSessionId, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const MCP_SERVER = path.join(PLUGIN_ROOT, "scripts", "agents-mcp-server.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const MONITOR_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "job-completion-monitor.mjs");

function startServer(repo, binDir, envOverrides = {}) {
  const env = buildEnv(binDir);
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CODEX_COMPANION_SESSION_ID;
  Object.assign(env, envOverrides);

  const child = spawn(process.execPath, [MCP_SERVER], { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    async close() {
      child.stdin.end();
      await new Promise((resolve) => child.on("close", resolve));
    }
  };
}

async function callTool(server, name, args = {}) {
  const message = await server.request("tools/call", { name, arguments: args });
  return { text: message.result.content[0].text, isError: message.result.isError === true };
}

function commitFixtureRepo(repo) {
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
}

function readJobs(repo) {
  const statePath = path.join(resolveStateDir(repo), "state.json");
  return JSON.parse(fs.readFileSync(statePath, "utf8")).jobs;
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function endSession(repo, binDir, sessionId = null) {
  const env = buildEnv(binDir);
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CODEX_COMPANION_SESSION_ID;
  return run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, ...(sessionId ? { session_id: sessionId } : {}) })
  });
}

test("agents MCP server speaks the protocol and lists exactly the five parity tools", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  commitFixtureRepo(repo);

  const server = startServer(repo, binDir);
  try {
    const initialized = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tests", version: "0" }
    });
    assert.equal(initialized.result.protocolVersion, "2025-06-18");
    assert.deepEqual(initialized.result.capabilities, { tools: {} });
    server.notify("notifications/initialized", {});

    const listed = await server.request("tools/list", {});
    const tools = listed.result.tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["Agent", "SendMessage", "TaskOutput", "TaskStop", "ListAgents"]
    );
    assert.deepEqual(
      tools.map((tool) => tool.inputSchema.required),
      [["prompt"], ["to", "message"], ["task_id"], ["task_id"], []]
    );
    for (const tool of tools) {
      assert.ok(tool.inputSchema.properties.cwd, `${tool.name} is missing cwd`);
    }

    const unknown = await server.request("foo/bar", {});
    assert.equal(unknown.error.code, -32601);
  } finally {
    await server.close();
  }
});

test("agents MCP tools drive a Codex job from launch through steer, resume, list, and stop", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  commitFixtureRepo(repo);
  saveSessionId(repo, "session-mcp-test");

  const server = startServer(repo, binDir);
  try {
    await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

    const launched = await callTool(server, "Agent", {
      prompt: "investigate the flaky worker timeout",
      run_in_background: true
    });
    assert.equal(launched.isError, false, launched.text);
    const startedMatch = launched.text.match(/Started Codex job (task-[a-z0-9-]+)/);
    assert.ok(startedMatch, launched.text);
    const taskId = startedMatch[1];
    // No cwd was passed, so the Monitor command names only the job. This server has no
    // CLAUDE_PLUGIN_DATA, so the command carries no assignment either.
    assert.match(launched.text, new RegExp(`command: node "${MONITOR_SCRIPT}" --job ${taskId}\\n`));
    assert.doesNotMatch(launched.text, /CLAUDE_PLUGIN_DATA/);

    // The MCP server has no session env of its own; it reads session.json written by SessionStart.
    assert.equal(readJobs(repo).find((job) => job.id === taskId).sessionId, "session-mcp-test");

    await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === taskId);
      return job?.status === "running" && job.threadId && job.turnId ? job : null;
    });

    const peeked = await callTool(server, "TaskOutput", { task_id: taskId, block: false });
    assert.equal(peeked.isError, false, peeked.text);
    assert.match(peeked.text, /running/);
    assert.match(peeked.text, /Thread: active, accepts input/);

    const steered = await callTool(server, "SendMessage", { to: taskId, message: "change course" });
    assert.equal(steered.isError, false, steered.text);
    assert.ok(steered.text.startsWith("Steered job"), steered.text);

    const waited = await callTool(server, "TaskOutput", { task_id: taskId, block: true, timeout: 15000, tail: 40 });
    assert.equal(waited.isError, false, waited.text);
    assert.match(waited.text, /completed/);
    assert.match(waited.text, /Steered: change course/);

    const resumed = await callTool(server, "SendMessage", { to: taskId, message: "now summarize what changed" });
    assert.equal(resumed.isError, false, resumed.text);
    const resumedMatch = resumed.text.match(/Resumed job \S+ as (task-[a-z0-9-]+)/);
    assert.ok(resumedMatch, resumed.text);
    const resumedId = resumedMatch[1];
    assert.equal(readJobs(repo).find((job) => job.id === resumedId).parentJobId, taskId);

    const resumedOutput = await callTool(server, "TaskOutput", { task_id: resumedId, block: true, timeout: 20000 });
    assert.equal(resumedOutput.isError, false, resumedOutput.text);
    assert.match(resumedOutput.text, /completed/);

    const listed = await callTool(server, "ListAgents");
    assert.equal(listed.isError, false, listed.text);
    assert.match(listed.text, new RegExp(resumedId));
    // TaskOutput on the parent id resolves forward; the listing says the same thing.
    assert.match(listed.text, new RegExp(`^${taskId}\\b.* → continued as ${resumedId}$`, "m"));

    const relaunched = await callTool(server, "Agent", {
      prompt: "trace the retry policy",
      run_in_background: true
    });
    const stopId = relaunched.text.match(/Started Codex job (task-[a-z0-9-]+)/)[1];
    await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === stopId);
      return job?.status === "running" && job.turnId ? job : null;
    });

    const stopped = await callTool(server, "TaskStop", { task_id: stopId });
    assert.equal(stopped.isError, false, stopped.text);
    assert.match(stopped.text, /cancelled/i);
  } finally {
    await server.close();
  }

  const cleanup = endSession(repo, binDir, "session-mcp-test");
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(fs.existsSync(resolveSessionFile(repo)), false);
});

test("SendMessage keeps one job id across resumes and leaves a linear chain", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  commitFixtureRepo(repo);

  const server = startServer(repo, binDir);
  try {
    await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

    const launched = await callTool(server, "Agent", {
      prompt: "investigate the flaky worker timeout",
      run_in_background: true
    });
    const taskId = launched.text.match(/Started Codex job (task-[a-z0-9-]+)/)[1];
    await waitFor(() => readJobs(repo).find((job) => job.id === taskId && job.status === "completed"));

    const firstResume = await callTool(server, "SendMessage", { to: taskId, message: "now summarize what changed" });
    assert.equal(firstResume.isError, false, firstResume.text);
    assert.match(firstResume.text, new RegExp(`Use TaskOutput ${taskId} to read it`));
    const childId = firstResume.text.match(/as (task-[a-z0-9-]+)/)[1];
    await waitFor(() => readJobs(repo).find((job) => job.id === childId && job.status === "completed"));

    // The caller still holds the original id; the second message must land on the newest turn.
    const secondResume = await callTool(server, "SendMessage", { to: taskId, message: "and once more" });
    assert.equal(secondResume.isError, false, secondResume.text);
    assert.match(secondResume.text, new RegExp(`Resumed job ${childId}, the latest turn of ${taskId}`));
    const grandchildId = secondResume.text.match(/as (task-[a-z0-9-]+)/)[1];
    await waitFor(() => readJobs(repo).find((job) => job.id === grandchildId && job.status === "completed"));

    const jobs = readJobs(repo);
    assert.equal(jobs.find((job) => job.id === grandchildId).parentJobId, childId);
    for (const job of jobs) {
      const children = jobs.filter((candidate) => candidate.parentJobId === job.id);
      assert.ok(children.length <= 1, `job ${job.id} has ${children.length} children: the chain forked`);
    }

    const followed = await callTool(server, "TaskOutput", { task_id: taskId, block: false });
    assert.equal(followed.isError, false, followed.text);
    assert.match(followed.text, new RegExp(`^Job ${taskId} continued as ${grandchildId}`));
  } finally {
    await server.close();
  }

  const cleanup = endSession(repo, binDir);
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("TaskOutput includes the log only when tail is given, and reads it forward on later calls", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  commitFixtureRepo(repo);

  const server = startServer(repo, binDir);
  try {
    await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

    const launched = await callTool(server, "Agent", {
      prompt: "investigate the flaky worker timeout",
      run_in_background: true
    });
    const taskId = launched.text.match(/Started Codex job (task-[a-z0-9-]+)/)[1];
    const job = await waitFor(() => {
      const candidate = readJobs(repo).find((entry) => entry.id === taskId);
      return candidate?.status === "running" && candidate.turnId ? candidate : null;
    });

    const appendLines = (label, count) => {
      const lines = Array.from({ length: count }, (_, index) => `[log] ${label} line ${index}`);
      fs.appendFileSync(job.logFile, `${lines.join("\n")}\n`);
    };

    appendLines("batch-one", 60);
    const bare = await callTool(server, "TaskOutput", { task_id: taskId, block: false });
    assert.equal(bare.isError, false, bare.text);
    assert.doesNotMatch(bare.text, /batch-one/);
    assert.doesNotMatch(bare.text, /\[log lines/);
    assert.match(bare.text, /^Log: \d+ lines at .+ \(use tail to include them\)$/m);

    const first = await callTool(server, "TaskOutput", { task_id: taskId, block: false, tail: 40 });
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, /batch-one line 59/);
    const readSoFar = Number(first.text.match(/\[log lines \d+-\d+ of (\d+)\]/)[1]);

    appendLines("batch-two", 3);
    const second = await callTool(server, "TaskOutput", { task_id: taskId, block: false, tail: 40 });
    assert.equal(second.isError, false, second.text);
    assert.doesNotMatch(second.text, /batch-one/);
    assert.match(second.text, /batch-two line 2/);
    assert.match(second.text, new RegExp(`\\[log lines ${readSoFar + 1}-`));

    const stopped = await callTool(server, "TaskStop", { task_id: taskId });
    assert.equal(stopped.isError, false, stopped.text);
  } finally {
    await server.close();
  }

  const cleanup = endSession(repo, binDir);
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("TaskOutput returns the numbered trace and one full step on request", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-trace");
  commitFixtureRepo(repo);

  const server = startServer(repo, binDir);
  try {
    await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

    const launched = await callTool(server, "Agent", {
      prompt: "make the retry policy explicit",
      run_in_background: true
    });
    const taskId = launched.text.match(/Started Codex job (task-[a-z0-9-]+)/)[1];
    await waitFor(() => readJobs(repo).find((job) => job.id === taskId && job.status === "completed"));

    const traced = await callTool(server, "TaskOutput", { task_id: taskId, block: false, trace: true });
    assert.equal(traced.isError, false, traced.text);
    assert.match(traced.text, /^1\. message /m);
    assert.match(traced.text, /^2\. command {5}npm run lint .+ \(exit 0, 1\.2s, 13 lines out\)$/m);
    assert.match(traced.text, /^ {15}fail 2$/m);
    assert.match(traced.text, /^3\. fileChange {2}src\/retry\.js \(update \+1-1\), src\/retry\.test\.js \(add \+1\)$/m);
    assert.match(traced.text, /^5\. tool {8}docs\/search \(completed\)$/m);
    assert.doesNotMatch(traced.text, /building module alpha/);

    const stepped = await callTool(server, "TaskOutput", { task_id: taskId, block: false, step: 2 });
    assert.equal(stepped.isError, false, stepped.text);
    assert.match(stepped.text, /^Step 2: command at /m);
    assert.match(stepped.text, /^Status: completed, exit 0, 1\.2s$/m);
    assert.match(stepped.text, /^lint: 0 warnings$/m);
    assert.match(stepped.text, /^not ok 3 - csv parses quoted fields$/m);

    const outOfRange = await callTool(server, "TaskOutput", { task_id: taskId, block: false, step: 99 });
    assert.equal(outOfRange.isError, true, outOfRange.text);
    assert.match(outOfRange.text, /valid steps are 1-6/);
  } finally {
    await server.close();
  }

  const cleanup = endSession(repo, binDir);
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("agents MCP tools report refusals and unknown jobs as tool errors", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  commitFixtureRepo(repo);
  upsertJob(repo, { id: "task-queued-test", status: "queued", jobClass: "task", title: "Codex Task" });

  const server = startServer(repo, binDir);
  try {
    await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

    const queued = await callTool(server, "SendMessage", { to: "task-queued-test", message: "change course" });
    assert.equal(queued.isError, true, queued.text);
    assert.match(queued.text, /has not started/);

    const missing = await callTool(server, "TaskOutput", { task_id: "task-nope" });
    assert.equal(missing.isError, true, missing.text);
    assert.match(missing.text, /No job found/);
  } finally {
    await server.close();
  }
});

test("the Agent tool runs a job in the cwd it is given and prints the Monitor recipe", async () => {
  const repo = makeTempDir();
  const otherRepo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  commitFixtureRepo(repo);
  commitFixtureRepo(otherRepo);

  const server = startServer(repo, binDir);
  try {
    await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

    const launched = await callTool(server, "Agent", {
      prompt: "investigate the flaky worker timeout",
      run_in_background: true,
      cwd: otherRepo
    });
    assert.equal(launched.isError, false, launched.text);
    const taskId = launched.text.match(/Started Codex job (task-[a-z0-9-]+)/)[1];
    // The Monitor tool is the notification path that works in every client, so it is named
    // first and the command it needs is spelled out, cwd included.
    assert.ok(
      launched.text.indexOf("Monitor tool") < launched.text.indexOf("background Bash call"),
      launched.text
    );
    assert.match(
      launched.text,
      new RegExp(
        `command: node "${MONITOR_SCRIPT}" --job ${taskId} --cwd "${otherRepo}"\\n  description: Codex job ${taskId}`
      )
    );

    // The job belongs to the other workspace's state dir, not the server's own.
    assert.ok(readJobs(otherRepo).some((job) => job.id === taskId));
    assert.equal(fs.existsSync(path.join(resolveStateDir(repo), "state.json")), false);

    await waitFor(() => readJobs(otherRepo).find((job) => job.id === taskId && job.status === "completed"));

    // ListAgents and TaskOutput share one token formatter, so a large count reads the same
    // way in both: `282.5k`, never a raw 282452.
    upsertJob(otherRepo, {
      id: "task-heavy",
      status: "completed",
      phase: "done",
      jobClass: "task",
      title: "Codex Task",
      summary: "An earlier, heavier run",
      tokenUsage: { totalTokens: 282452 }
    });

    const listed = await callTool(server, "ListAgents", { cwd: otherRepo });
    assert.equal(listed.isError, false, listed.text);
    // Neither model nor effort was named, so the job ran on the plugin's default model.
    assert.match(listed.text, /gpt-6-astra/);
    assert.match(listed.text, /1280tok/);
    assert.match(listed.text, /282\.5ktok/);

    const missingCwd = await callTool(server, "Agent", {
      prompt: "should not run",
      cwd: path.join(otherRepo, "no-such-directory")
    });
    assert.equal(missingCwd.isError, true, missingCwd.text);
    assert.match(missingCwd.text, /no-such-directory is not an existing directory/);
  } finally {
    await server.close();
  }

  const cleanup = endSession(otherRepo, binDir);
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("the Agent tool runs a foreground Codex task and returns its result", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  commitFixtureRepo(repo);

  const server = startServer(repo, binDir);
  try {
    await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

    const result = await callTool(server, "Agent", { prompt: "explain the failing test" });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Handled the requested task/);
  } finally {
    await server.close();
  }

  const cleanup = endSession(repo, binDir);
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("the Monitor command pins the state directory the server itself writes to", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const stateDir = makeTempDir();
  installFakeCodex(binDir);
  commitFixtureRepo(repo);

  // The state directory is derived from CLAUDE_PLUGIN_DATA. A watch that inherits a
  // different value reads a different directory and never fires, silently, so the printed
  // command carries this server's value rather than trusting the shell it lands in.
  const server = startServer(repo, binDir, { CLAUDE_PLUGIN_DATA: stateDir });
  try {
    await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

    const launched = await callTool(server, "Agent", {
      prompt: "investigate the flaky worker timeout",
      run_in_background: true
    });
    assert.equal(launched.isError, false, launched.text);
    const taskId = launched.text.match(/Started Codex job (task-[a-z0-9-]+)/)[1];
    assert.match(
      launched.text,
      new RegExp(`command: CLAUDE_PLUGIN_DATA="${stateDir}" node "${MONITOR_SCRIPT}" --job ${taskId}\\n`)
    );

    // And the pinned directory is the one the job actually landed in.
    process.env.CLAUDE_PLUGIN_DATA = stateDir;
    let resolved;
    try {
      resolved = resolveStateDir(repo);
    } finally {
      delete process.env.CLAUDE_PLUGIN_DATA;
    }
    assert.equal(resolved.startsWith(stateDir), true, resolved);
    const jobs = JSON.parse(fs.readFileSync(path.join(resolved, "state.json"), "utf8")).jobs;
    assert.ok(jobs.some((job) => job.id === taskId));
  } finally {
    await server.close();
  }
});

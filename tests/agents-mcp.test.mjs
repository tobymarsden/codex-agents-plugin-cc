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

function startServer(repo, binDir) {
  const env = buildEnv(binDir);
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CODEX_COMPANION_SESSION_ID;

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

function endSession(repo, binDir) {
  const env = buildEnv(binDir);
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CODEX_COMPANION_SESSION_ID;
  return run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
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

    const waited = await callTool(server, "TaskOutput", { task_id: taskId, block: true, timeout: 15000 });
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
    assert.match(listed.text, new RegExp(taskId));
    assert.match(listed.text, new RegExp(resumedId));

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

  const cleanup = endSession(repo, binDir);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(fs.existsSync(resolveSessionFile(repo)), false);
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

test("the Agent tool runs a job in the cwd it is given and prints the wake-up command", async () => {
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
    assert.match(launched.text, new RegExp(`--wait 3600000 --cwd ${otherRepo}$`));

    // The job belongs to the other workspace's state dir, not the server's own.
    assert.ok(readJobs(otherRepo).some((job) => job.id === taskId));
    assert.equal(fs.existsSync(path.join(resolveStateDir(repo), "state.json")), false);

    await waitFor(() => readJobs(otherRepo).find((job) => job.id === taskId && job.status === "completed"));

    const listed = await callTool(server, "ListAgents", { cwd: otherRepo });
    assert.equal(listed.isError, false, listed.text);
    assert.match(listed.text, /gpt-test/);
    assert.match(listed.text, /1280tok/);

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

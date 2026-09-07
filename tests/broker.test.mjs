import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { ensureBrokerSession, isExistingBrokerAlive, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
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

async function startBroker() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const session = await ensureBrokerSession(repo, { env, timeoutMs: 10000 });
  assert.ok(session, "shared broker did not start");
  return { repo, binDir, env, session, fakeStatePath: path.join(binDir, "fake-codex-state.json") };
}

function collectNotifications(client) {
  const received = [];
  client.setNotificationHandler((message) => {
    received.push(message);
  });
  return received;
}

function findItem(notifications, threadId, type) {
  return notifications.find(
    (message) => message.method === "item/completed" && message.params.threadId === threadId && message.params.item.type === type
  );
}

function sawTurnCompleted(notifications, threadId) {
  return notifications.some((message) => message.method === "turn/completed" && message.params.threadId === threadId);
}

async function startSlowTurn(client, repo) {
  const started = await client.request("thread/start", { cwd: repo });
  const threadId = started.thread.id;
  const turn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "count to twelve slowly" }]
  });
  return { threadId, turnId: turn.turn.id };
}

test("broker fans notifications out to subscribers and answers live reads", async () => {
  const { repo, session } = await startBroker();

  const clients = [];
  try {
    const starter = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
    clients.push(starter);
    const starterEvents = collectNotifications(starter);
    const { threadId } = await startSlowTurn(starter, repo);

    const observer = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
    clients.push(observer);
    const observerEvents = collectNotifications(observer);
    assert.deepEqual(await observer.request("broker/subscribe", { threadId }), {});

    const activeRead = await observer.request("thread/read", { threadId });
    assert.equal(activeRead.thread.status.type, "active");
    assert.equal(activeRead.thread.canAcceptDirectInput, true);

    await waitFor(() => sawTurnCompleted(observerEvents, threadId) && sawTurnCompleted(starterEvents, threadId));
    assert.ok(findItem(observerEvents, threadId, "agentMessage"));
    assert.ok(findItem(starterEvents, threadId, "agentMessage"));

    const idleRead = await observer.request("thread/read", { threadId });
    assert.equal(idleRead.thread.status.type, "idle");

    assert.deepEqual(await observer.request("broker/unsubscribe", { threadId }), {});
  } finally {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    await sendBrokerShutdown(session.endpoint);
  }
});

test("broker admits a steer from a second socket mid-stream", async () => {
  const { repo, session, fakeStatePath } = await startBroker();

  const clients = [];
  try {
    const starter = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
    clients.push(starter);
    const starterEvents = collectNotifications(starter);
    const { threadId, turnId } = await startSlowTurn(starter, repo);

    const steerer = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
    clients.push(steerer);
    const steererEvents = collectNotifications(steerer);
    await steerer.request("broker/subscribe", { threadId });

    const steered = await steerer.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: "change course" }]
    });
    assert.equal(steered.turnId, turnId);

    await assert.rejects(
      steerer.request("turn/steer", {
        threadId,
        expectedTurnId: "turn_does_not_exist",
        input: [{ type: "text", text: "too late" }]
      }),
      (error) => {
        assert.equal(error.rpcCode, -32000);
        assert.match(error.message, /turn_does_not_exist is not the active turn/);
        return true;
      }
    );

    await waitFor(() => sawTurnCompleted(steererEvents, threadId) && sawTurnCompleted(starterEvents, threadId));
    assert.equal(findItem(starterEvents, threadId, "agentMessage").params.item.text, "Steered: change course");
    assert.equal(findItem(steererEvents, threadId, "agentMessage").params.item.text, "Steered: change course");

    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.deepEqual(fakeState.lastSteer, { threadId, turnId, text: "change course" });
  } finally {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    await sendBrokerShutdown(session.endpoint);
  }
});

test("broker forwards turn/start on an active thread instead of refusing it", async () => {
  const { repo, session } = await startBroker();

  const clients = [];
  try {
    const starter = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
    clients.push(starter);
    const { threadId, turnId } = await startSlowTurn(starter, repo);

    const latecomer = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
    clients.push(latecomer);
    const joined = await latecomer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "join the running turn" }]
    });

    assert.equal(joined.turn.id, turnId);
    assert.equal(joined.turn.status, "inProgress");
  } finally {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    await sendBrokerShutdown(session.endpoint);
  }
});

test("a live broker that is slow to accept is kept instead of replaced", async () => {
  const sessionDir = makeTempDir();
  const socketPath = path.join(sessionDir, "broker.sock");
  const existing = { endpoint: `unix:${socketPath}`, pid: process.pid };

  const server = net.createServer(() => {});
  const listening = new Promise((resolve) => {
    setTimeout(() => server.listen(socketPath, resolve), 500);
  });

  try {
    assert.equal(await isExistingBrokerAlive({ ...existing, pid: null }), false);
    assert.equal(await isExistingBrokerAlive(existing, { timeoutMs: 3000 }), true);
  } finally {
    await listening;
    await new Promise((resolve) => server.close(resolve));
  }
});

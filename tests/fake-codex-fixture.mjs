import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeCodex(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const INTERRUPTIBLE = BEHAVIOR.startsWith("interruptible-slow-task");
	const PARENT_OWNED = BEHAVIOR === "interruptible-slow-task-parent-owned";
	const interruptibleTurns = new Map();

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null, lastSteer: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function activeTurn(threadId) {
  for (const entry of interruptibleTurns.values()) {
    if (entry.threadId === threadId) {
      return entry;
    }
  }
  return null;
}

function recordSteer(state, entry, text) {
  entry.steerText = text;
  state.lastSteer = { threadId: entry.threadId, turnId: entry.turnId, text };
  saveState(state);
}

function inputText(input) {
  return (input || []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
}

function importLedgerPath() {
  return path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

// One notification per turn: "last" is this turn's own usage, "total" is the thread's
// running sum, so a second turn on the same thread proves the per-job delta.
const TURN_TOKEN_USAGE = { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 80, reasoningOutputTokens: 40, totalTokens: 1280, cacheWriteInputTokens: 0 };

// What a turn has already spent partway through, before any turn/completed lands.
const MIDTURN_TOKEN_USAGE = { inputTokens: 900, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 930, cacheWriteInputTokens: 0 };

function emitTokenUsage(threadId, turnId) {
  const state = loadState();
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    return;
  }
  thread.completedTurns = (thread.completedTurns || 0) + 1;
  saveState(state);
  const total = {};
  for (const key of Object.keys(TURN_TOKEN_USAGE)) {
    total[key] = TURN_TOKEN_USAGE[key] * thread.completedTurns;
  }
  send({
    method: "thread/tokenUsage/updated",
    params: { threadId, turnId, tokenUsage: { last: TURN_TOKEN_USAGE, total, modelContextWindow: 272000 } }
  });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.pauseMs) {
      // Real elapsed time between the two notifications, so the reader can measure it.
      sleepSync(entry.pauseMs);
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  emitTokenUsage(threadId, turnId);
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

// Longer than the 96 characters the human log shortens a command to, so a test can show the
// trace keeping it whole where the log does not.
const TRACE_COMMAND = "npm run lint -- --max-warnings 0 && npm test -- --runInBand --reporters=default && echo 'trace fixture command finished'";

// A runner's summary block sits in the last lines of its output, and one of those lines is
// far longer than the width the trace shows.
const TRACE_COMMAND_OUTPUT = [
  // A real runner buries its summary under a noisy preamble; the trace's tail budget is
  // what keeps the summary and drops this.
  "  building module alpha ................................. ok",
  "  building module bravo ................................. ok",
  "  building module charlie ............................... ok",
  "  building module delta ................................. ok",
  "  building module echo .................................. ok",
  "> npm run lint",
  "lint: 0 warnings",
  "",
  "> npm test",
  "not ok 3 - csv parses quoted fields",
  "tests 12",
  "pass 10",
  "fail 2",
  "failing tests: " + "tests/csv.test.mjs:41 ".repeat(8)
].join("\\n");

function traceItems(turnId, cwd, payload) {
  const command = {
    type: "commandExecution",
    id: "cmd_" + turnId,
    command: TRACE_COMMAND,
    cwd,
    source: "agent",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null
  };
  const silent = { ...command, id: "cmd_silent_" + turnId, command: "git status --porcelain" };
  return [
    {
      completed: { type: "reasoning", id: "reasoning_empty_" + turnId, summary: [], content: [] }
    },
    {
      completed: { type: "agentMessage", id: "msg_plan_" + turnId, text: "Planning the change.\\nFirst lint, then edit.", phase: "analysis" }
    },
    {
      started: command,
      completed: {
        ...command,
        status: "completed",
        aggregatedOutput: TRACE_COMMAND_OUTPUT,
        exitCode: 0,
        durationMs: 1234
      }
    },
    {
      completed: {
        type: "fileChange",
        id: "chg_" + turnId,
        status: "completed",
        changes: [
          { path: cwd + "/src/retry.js", kind: { type: "update", move_path: null }, diff: "@@ -1,2 +1,2 @@\\n-const attempts = 1;\\n+const attempts = 3;" },
          { path: cwd + "/src/retry.test.js", kind: { type: "add" }, diff: "@@ -0,0 +1,1 @@\\n+test('retries three times', () => {});" }
        ]
      }
    },
    {
      // No output, and a duration the server reports as zero: the reader measures its own.
      pauseMs: 40,
      started: silent,
      completed: { ...silent, status: "completed", aggregatedOutput: "", exitCode: 0, durationMs: 0 }
    },
    {
      completed: {
        type: "mcpToolCall",
        id: "mcp_" + turnId,
        server: "docs",
        tool: "search",
        status: "completed",
        arguments: { query: "retry policy", limit: 3 },
        result: { hits: ["docs/retry.md"] },
        error: null,
        durationMs: 0
      }
    },
    {
      completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
    }
  ];
}

// Well past the 100000 characters the event store keeps, and the line that decides the run
// is the last one: a cap that kept the head would report this import as clean.
const LONG_COMMAND_OUTPUT = (function () {
  const lines = [];
  for (let index = 1; index <= 4000; index += 1) {
    lines.push("record " + index + " processed " + "-".repeat(40));
  }
  lines.push("DONE: 4000 records, 0 errors");
  return lines.join("\\n");
})();

// A create and a delete arrive as the file's contents, not a unified diff. The bullet list
// is the trap: those lines start with "-" without being removals.
const NOTES_FILE_CONTENT = [
  "# Notes",
  "",
  "- capture the failing case",
  "- add the regression test",
  "- update the runbook",
  "",
  "Owner: platform",
  "Status: draft"
].join("\\n");

const STALE_FILE_CONTENT = ["const stale = true;", "module.exports = stale;"].join("\\n");

function rawPayloadItems(turnId, cwd, payload) {
  const importCommand = {
    type: "commandExecution",
    id: "cmd_import_" + turnId,
    command: "node scripts/import.js",
    cwd,
    source: "agent",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null
  };
  const oneLine = { ...importCommand, id: "cmd_head_" + turnId, command: "git rev-parse --short HEAD" };
  return [
    {
      started: importCommand,
      completed: { ...importCommand, status: "completed", aggregatedOutput: LONG_COMMAND_OUTPUT, exitCode: 0, durationMs: 115 }
    },
    {
      started: oneLine,
      completed: { ...oneLine, status: "completed", aggregatedOutput: "9f2c1ab", exitCode: 0, durationMs: 12 }
    },
    {
      completed: {
        type: "fileChange",
        id: "chg_" + turnId,
        status: "completed",
        changes: [
          { path: cwd + "/NOTES.md", kind: { type: "add" }, diff: NOTES_FILE_CONTENT },
          { path: cwd + "/src/stale.js", kind: { type: "delete" }, diff: STALE_FILE_CONTENT }
        ]
      }
    },
    {
      completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
    }
  ];
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
saveState(bootState);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "initialized":
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        state.lastThreadStart = { threadId: thread.id, sandbox: message.params.sandbox ?? null };
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-test", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: message.params.effort ?? "medium" } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        state.lastThreadStart = { threadId: thread.id, sandbox: message.params.sandbox ?? null };
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-test", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: message.params.effort ?? "medium" } });
        break;
      }

      case "externalAgentConfig/import": {
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        if (BEHAVIOR === "external-import-fails") {
          send({ id: message.id, result: {} });
          send({ method: "externalAgentConfig/import/completed", params: {} });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        const sourcePath = fs.realpathSync(session.path);
        const contents = fs.readFileSync(sourcePath, "utf8");
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages };
          record = {
            source_path: sourcePath,
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveState(state);
          saveImportLedger(ledger);
        }
        send({ id: message.id, result: {} });
        send({ method: "externalAgentConfig/import/completed", params: {} });
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = inputText(message.params.input);
        const inFlight = activeTurn(thread.id);
        if (inFlight) {
          recordSteer(state, inFlight, prompt);
          send({ id: message.id, result: { turn: buildTurn(inFlight.turnId) } });
          break;
        }
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          prompt
	        };
	        saveState(state);
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state"));

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        if (BEHAVIOR === "turn-error-json") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "error",
            params: {
              threadId: thread.id,
              turnId,
              error: {
                message: JSON.stringify(
                  {
                    error: {
                      message: "Reasoning effort 'minimal' is not supported by model gpt-5.6-sol.",
                      type: "invalid_request_error",
                      code: "unsupported_value"
                    }
                  },
                  null,
                  2
                )
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "failed") } });
          break;
        }

        const scriptedItems =
          BEHAVIOR === "with-trace"
            ? traceItems(turnId, thread.cwd, payload)
            : BEHAVIOR === "with-raw-payloads"
              ? rawPayloadItems(turnId, thread.cwd, payload)
              : null;

        const items = scriptedItems ?? [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

	        if (INTERRUPTIBLE) {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          send({
	            method: "thread/tokenUsage/updated",
	            params: { threadId: thread.id, turnId, tokenUsage: { last: MIDTURN_TOKEN_USAGE, total: MIDTURN_TOKEN_USAGE, modelContextWindow: 272000 } }
	          });
	          const pending = { turnId, threadId: thread.id, steerText: null, timer: null };
	          pending.timer = setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            const finalItems = pending.steerText === null
	              ? items
	              : [{ completed: { type: "agentMessage", id: "msg_" + turnId, text: "Steered: " + pending.steerText, phase: "final_answer" } }];
	            for (const entry of finalItems) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
	            }
	            emitTokenUsage(pending.threadId, turnId);
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          interruptibleTurns.set(turnId, pending);
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/steer": {
	        const thread = ensureThread(state, message.params.threadId);
	        if (PARENT_OWNED) {
	          throw new Error("parent-owned subagent rejects direct steering");
	        }
	        const inFlight = activeTurn(thread.id);
	        if (!inFlight || inFlight.turnId !== message.params.expectedTurnId) {
	          throw new Error("expectedTurnId " + message.params.expectedTurnId + " is not the active turn");
	        }
	        recordSteer(state, inFlight, inputText(message.params.input));
	        send({ id: message.id, result: { turnId: inFlight.turnId } });
	        break;
	      }

	      case "thread/read": {
	        const thread = ensureThread(state, message.params.threadId);
	        const status = activeTurn(thread.id) ? { type: "active", activeFlags: [] } : { type: "idle" };
	        send({ id: message.id, result: { thread: { ...buildThread(thread), status, canAcceptDirectInput: !PARENT_OWNED } } });
	        break;
	      }

	      case "turn/interrupt": {
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}

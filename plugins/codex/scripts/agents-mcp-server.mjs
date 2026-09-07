#!/usr/bin/env node
// MCP servers receive only the static env from .mcp.json, so the Claude session id is read
// from the state dir's session.json, which the SessionStart hook writes, on every tool call.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { formatTokenCount } from "./lib/render.mjs";
import { loadSessionId } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const MONITOR_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "job-completion-monitor.mjs");
const PLUGIN_MANIFEST = path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
const SERVER_NAME = "codex-agents";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_OUTPUT_TIMEOUT_MS = 1800000;
const SUMMARY_LIMIT = 60;
const LOG_TRAILER = /\[log lines \d+-\d+ of (\d+)\]/;

// Job id -> log lines already handed to this session, so each TaskOutput reads forward.
const logCursors = new Map();

function pluginVersion() {
  return JSON.parse(fs.readFileSync(PLUGIN_MANIFEST, "utf8")).version;
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function runCompanion(args) {
  const sessionId = loadSessionId(process.cwd());
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMPANION_SCRIPT, ...args], {
      cwd: process.cwd(),
      env: sessionId ? { ...process.env, [SESSION_ID_ENV]: sessionId } : process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: 1, stdout: "", stderr: `${error.message}\n` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function cliText(args) {
  const result = await runCompanion(args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `codex-companion ${args[0]} exited with code ${result.code}.`);
  }
  return result.stdout;
}

async function cliJson(args) {
  return JSON.parse(await cliText(args));
}

function requireString(args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function shorten(text, limit) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

/** The newest job of a resume chain, so a listed parent names where its work went on. */
function newestDescendant(jobs, jobId) {
  let latest = null;
  let currentId = jobId;
  // The chain is linear and finite; the bound keeps a malformed store from spinning.
  for (let step = 0; step < jobs.length; step += 1) {
    const child = jobs.find((job) => job.parentJobId === currentId);
    if (!child) {
      break;
    }
    latest = child.id;
    currentId = child.id;
  }
  return latest;
}

const CWD_SCHEMA = { type: "string", description: "Workspace directory for the job; defaults to the server's working directory." };

/** Returns the `--cwd <dir>` flags every CLI call in a tool run must carry, or []. */
function cwdFlags(args) {
  if (args?.cwd === undefined || args.cwd === null || args.cwd === "") {
    return [];
  }
  const resolved = path.resolve(process.cwd(), String(args.cwd));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`cwd ${resolved} is not an existing directory.`);
  }
  return ["--cwd", resolved];
}

const TOOLS = [
  {
    name: "Agent",
    description:
      "Run a Codex task in this workspace. Returns the result, or with run_in_background a job id to use with TaskOutput, SendMessage, and TaskStop, plus a ready-to-arm Monitor command that announces the job when it finishes. cwd sets the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What Codex should do." },
        run_in_background: { type: "boolean", description: "Return a job id immediately instead of waiting." },
        write: { type: "boolean", description: "Give Codex full write access with no sandbox." },
        model: { type: "string", description: "Codex model to use; omit to use the plugin's default." },
        effort: { type: "string", description: "low, medium, high, xhigh, or max; defaults to high." },
        resume: { type: "string", description: "Job id whose Codex thread this task continues." },
        cwd: CWD_SCHEMA
      },
      required: ["prompt"]
    },
    async run(args) {
      const prompt = requireString(args, "prompt");
      const workspace = cwdFlags(args);
      const flags = [...workspace];
      if (args.run_in_background) {
        flags.push("--background");
      }
      if (args.write) {
        flags.push("--write");
      }
      if (args.model) {
        flags.push("--model", String(args.model));
      }
      if (args.effort) {
        flags.push("--effort", String(args.effort));
      }
      if (args.resume) {
        flags.push("--job", String(args.resume));
      }

      if (!args.run_in_background) {
        return cliText(["task", ...flags, prompt]);
      }

      const payload = await cliJson(["task", ...flags, "--json", prompt]);
      // An MCP tool cannot push into the Claude session, so hand the caller a command it
      // can arm itself. The state directory comes from CLAUDE_PLUGIN_DATA, so pin this
      // server's value into the command: a watch that reads a different directory never
      // fires, and says nothing about why.
      const stateDir = process.env.CLAUDE_PLUGIN_DATA;
      const watchCommand =
        (stateDir ? `CLAUDE_PLUGIN_DATA=${JSON.stringify(stateDir)} ` : "") +
        `node ${JSON.stringify(MONITOR_SCRIPT)} --job ${payload.jobId}` +
        (workspace.length > 0 ? ` --cwd ${JSON.stringify(workspace[1])}` : "");
      return (
        `Started Codex job ${payload.jobId}. Read it with TaskOutput.\n` +
        "To be notified when it finishes, watch it with the Monitor tool:\n" +
        `  command: ${watchCommand}\n` +
        `  description: Codex job ${payload.jobId}\n` +
        "Or run that same command under a background Bash call."
      );
    }
  },
  {
    name: "SendMessage",
    description:
      "Send a message to a Codex job. A running job is steered mid-turn; a finished job is resumed with its context as a new job.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Job id to send the message to." },
        message: { type: "string", description: "Text to deliver to the job." },
        summary: { type: "string", description: "Accepted for parity with the native tool; unused." },
        cwd: CWD_SCHEMA
      },
      required: ["to", "message"]
    },
    async run(args) {
      const to = requireString(args, "to");
      const message = requireString(args, "message");
      const workspace = cwdFlags(args);
      // `output` follows the resume chain, so a job id keeps reaching its newest turn.
      const { job } = await cliJson(["output", to, ...workspace, "--json", "--tail", "0"]);
      const target = job.id;
      const via = target === to ? "" : `, the latest turn of ${to}`;

      if (job.status === "running") {
        const steered = await cliJson(["steer", target, ...workspace, "--json", message]);
        return `Steered job ${target}${via} (turn ${steered.turnId}).`;
      }

      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        const resumed = await cliJson(["task", "--background", "--job", target, ...workspace, "--json", message]);
        return (
          `Resumed job ${target}${via} as ${resumed.jobId} (same Codex thread). ` +
          `Use TaskOutput ${to} to read it.`
        );
      }

      throw new Error(`Job ${target} has not started its Codex turn yet; try again in a moment.`);
    }
  },
  {
    name: "TaskOutput",
    description:
      "Read a Codex job at one of three levels: the final result and metadata by default, a numbered trace of every action with trace, or the whole record behind one numbered line with step. block waits until it finishes or timeout. tail includes that many lines of the job's log on request; the log's path is reported either way. For a completion notification instead of polling, arm the Monitor command that Agent printed with the Monitor tool, or run it under a background Bash call.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Job id to read." },
        block: { type: "boolean", description: "Wait for the job to finish; defaults to true." },
        timeout: { type: "number", description: "Milliseconds to wait when blocking; defaults to 1800000." },
        tail: {
          type: "number",
          description: "Log lines of Codex's reasoning and commands to include; omit for the result only."
        },
        trace: { type: "boolean", description: "Return a numbered trace of what Codex did, one line per action." },
        step: { type: "number", description: "Return the full record for one numbered line of the trace." },
        cwd: CWD_SCHEMA
      },
      required: ["task_id"]
    },
    async run(args) {
      const taskId = requireString(args, "task_id");
      const workspace = cwdFlags(args);
      const cursor = logCursors.get(taskId);
      const command = [
        "output",
        taskId,
        ...workspace,
        ...(cursor === undefined ? [] : ["--since", String(cursor)]),
        ...(args.tail == null ? [] : ["--tail", String(args.tail)]),
        ...(args.trace ? ["--trace"] : []),
        ...(args.step == null ? [] : ["--step", String(args.step)])
      ];
      if (args.block !== false) {
        command.push("--wait", String(args.timeout ?? DEFAULT_OUTPUT_TIMEOUT_MS));
      }

      const text = await cliText(command);
      const trailer = LOG_TRAILER.exec(text);
      if (trailer) {
        logCursors.set(taskId, Number(trailer[1]));
      }
      return text;
    }
  },
  {
    name: "TaskStop",
    description: "Stop a running Codex job.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Job id to stop." },
        cwd: CWD_SCHEMA
      },
      required: ["task_id"]
    },
    async run(args) {
      return cliText(["cancel", requireString(args, "task_id"), ...cwdFlags(args)]);
    }
  },
  {
    name: "ListAgents",
    description: "List this session's Codex jobs with status, phase, elapsed time, and whether each accepts input.",
    inputSchema: {
      type: "object",
      properties: { cwd: CWD_SCHEMA },
      required: []
    },
    async run(args) {
      const workspace = cwdFlags(args);
      const report = await cliJson(["status", "--all", ...workspace, "--json"]);
      const jobs = [...report.running, ...(report.latestFinished ? [report.latestFinished] : []), ...report.recent];
      if (jobs.length === 0) {
        return "No Codex jobs in this session.";
      }

      const active = new Set(report.running.map((job) => job.id));
      const lines = [];
      for (const job of jobs) {
        const timing = job.duration ?? job.elapsed ?? "-";
        let line = `${job.id}  ${job.status}/${job.phase}  ${timing}  ${shorten(job.summary, SUMMARY_LIMIT)}`;
        if (job.model) {
          line += `  ${job.model}`;
        }
        if (job.tokenUsage?.totalTokens != null) {
          line += `  ${formatTokenCount(job.tokenUsage.totalTokens)}tok`;
        }
        if (active.has(job.id)) {
          const { thread } = await cliJson(["output", job.id, ...workspace, "--json", "--tail", "0"]);
          if (thread) {
            line += `  thread:${thread.status?.type ?? "unknown"}${thread.canAcceptDirectInput ? ",accepts-input" : ""}`;
          }
        }
        // TaskOutput resolves a job id forward through its resume chain; the listing says so.
        const continued = newestDescendant(jobs, job.id);
        if (continued) {
          line += ` → continued as ${continued}`;
        }
        lines.push(line);
      }
      return lines.join("\n");
    }
  }
];

async function callTool(params) {
  const tool = TOOLS.find((candidate) => candidate.name === params?.name);
  if (!tool) {
    throw new Error(`Unknown tool: ${params?.name}`);
  }
  return tool.run(params.arguments ?? {});
}

async function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: pluginVersion() }
        }
      });
      return;
    case "ping":
      send({ id: message.id, result: {} });
      return;
    case "tools/list":
      send({
        id: message.id,
        result: {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
        }
      });
      return;
    case "tools/call":
      try {
        const text = await callTool(message.params);
        send({ id: message.id, result: { content: [{ type: "text", text }] } });
      } catch (error) {
        send({
          id: message.id,
          result: {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true
          }
        });
      }
      return;
    default:
      send({ id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`codex-agents: ignoring unparsable line: ${error.message}\n`);
    return;
  }

  if (message.id === undefined) {
    return;
  }

  handleRequest(message).catch((error) => {
    send({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  });
});

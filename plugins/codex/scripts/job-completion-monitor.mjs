#!/usr/bin/env node
// Monitor command: one stdout line per Codex job that reaches a terminal state while this
// session is running. It only reads the state this plugin writes, and never runs anything
// from a job record. Jobs already finished when the monitor starts are history, and are
// never announced — unless --job names one, which the caller asked about by id.
//
//   --cwd <dir>  watch that workspace's jobs instead of the process's working directory
//   --job <id>   announce only that job, then exit 0; without it the monitor keeps running

import path from "node:path";
import process from "node:process";

import { listJobs, loadSessionId } from "./lib/state.mjs";

const POLL_INTERVAL_MS = 2000;
const DETAIL_LIMIT = 60;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function parseOptions(argv) {
  const options = { workspace: process.cwd(), job: null };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--cwd" && value) {
      options.workspace = path.resolve(process.cwd(), value);
    } else if (flag === "--job" && value) {
      options.job = value;
    } else {
      throw new Error(`Usage: job-completion-monitor.mjs [--cwd <dir>] [--job <id>] (got ${flag})`);
    }
  }
  return options;
}

let options;
try {
  options = parseOptions(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const workspace = options.workspace;

function shorten(text) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.length <= DETAIL_LIMIT ? normalized : `${normalized.slice(0, DETAIL_LIMIT - 3)}...`;
}

function formatDuration(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt ?? "");
  const end = Date.parse(job.completedAt ?? job.updatedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.round((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function describe(job) {
  const duration = formatDuration(job);
  const timing = duration ? (job.status === "completed" ? ` in ${duration}` : ` after ${duration}`) : "";
  const detail = shorten(job.status === "failed" ? (job.errorMessage ?? job.summary) : job.summary);
  return `Codex job ${job.id} ${job.status}${timing}${detail ? `: ${detail}` : ""} — read it with TaskOutput.`;
}

function readTerminalJobs() {
  // A concurrent writer is normal here: the CLI renames the index into place under a lock,
  // so a read that loses the race is retried on the next poll rather than crashing.
  try {
    return listJobs(workspace).filter((job) => TERMINAL_STATUSES.has(job.status));
  } catch {
    return null;
  }
}

// A named job is the caller's whole reason for the watch, so it is announced even if it
// finished before the monitor started. Otherwise the session's earlier jobs are history.
const announced = new Set(options.job ? [] : (readTerminalJobs() ?? []).map((job) => job.id));

function poll() {
  const jobs = readTerminalJobs();
  if (!jobs) {
    return;
  }

  let sessionId = null;
  try {
    sessionId = loadSessionId(workspace);
  } catch {
    return;
  }

  for (const job of jobs) {
    if (announced.has(job.id) || (options.job && job.id !== options.job)) {
      continue;
    }
    announced.add(job.id);
    // A named job is its own scope; otherwise announce only this session's jobs.
    if (options.job || !sessionId || job.sessionId === sessionId) {
      process.stdout.write(`${describe(job)}\n`);
    }
    if (options.job) {
      // Nothing left to watch: dropping the timer lets the process flush and exit 0.
      clearInterval(timer);
      return;
    }
  }
}

const timer = setInterval(poll, POLL_INTERVAL_MS);
poll();

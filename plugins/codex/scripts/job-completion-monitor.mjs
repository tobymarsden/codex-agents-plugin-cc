#!/usr/bin/env node
// Plugin monitor: one stdout line per Codex job that reaches a terminal state while this
// session is running. It only reads the state this plugin writes, and never runs anything
// from a job record. Jobs already finished when the monitor starts are never announced.

import process from "node:process";

import { listJobs, loadSessionId } from "./lib/state.mjs";

const POLL_INTERVAL_MS = 2000;
const DETAIL_LIMIT = 60;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const workspace = process.cwd();

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

const announced = new Set((readTerminalJobs() ?? []).map((job) => job.id));

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
    if (announced.has(job.id)) {
      continue;
    }
    announced.add(job.id);
    if (!sessionId || job.sessionId === sessionId) {
      process.stdout.write(`${describe(job)}\n`);
    }
  }
}

setInterval(poll, POLL_INTERVAL_MS);

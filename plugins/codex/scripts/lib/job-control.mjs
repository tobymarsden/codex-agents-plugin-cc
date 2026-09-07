import fs from "node:fs";

import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { getSessionRuntimeStatus, readAppServerThread } from "./codex.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { readJobEvents, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
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

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

/**
 * Follows a job forward through the resume chain (`parentJobId`) and returns the newest
 * job in it, so one job id keeps reading the latest turn of the same Codex thread.
 */
export function resolveLatestInChain(jobs, jobId) {
  const visited = new Set([jobId]);
  let latest = jobs.find((job) => job.id === jobId) ?? null;
  let currentId = jobId;

  for (;;) {
    const children = sortJobsNewestFirst(jobs.filter((job) => job.parentJobId === currentId && !visited.has(job.id)));
    if (children.length === 0) {
      return latest;
    }
    latest = children[0];
    currentId = latest.id;
    visited.add(currentId);
  }
}

export function resolveJobReference(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  return { workspaceRoot, job: matchJobReference(jobs, reference) };
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

function isFinalJobStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

const FINAL_OUTPUT_LOG_LINE = /^\[[^\]]+\] Final output$/;

/** Returns `{ lines, logStart, logTotal }`: the tail of the log after skipping `since` lines. */
function readJobLogTail(logFile, maxLines, since = 0) {
  if (!logFile || !fs.existsSync(logFile)) {
    return { lines: [], logStart: 1, logTotal: 0, logSince: since };
  }

  const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/);

  // The trailing "Final output" block repeats the stored result, which callers render
  // separately, so drop it (and the blank line the block starts with) before tailing.
  const finalOutputIndex = lines.findIndex((line) => FINAL_OUTPUT_LOG_LINE.test(line));
  if (finalOutputIndex >= 0) {
    lines.length = finalOutputIndex > 0 && lines[finalOutputIndex - 1] === "" ? finalOutputIndex - 1 : finalOutputIndex;
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const logTotal = lines.length;
  // `slice(-0)` keeps everything, so a zero tail has to short-circuit.
  const shown = maxLines > 0 ? lines.slice(since).slice(-maxLines) : [];
  return { lines: shown, logStart: logTotal - shown.length + 1, logTotal, logSince: since };
}

function readJobResultText(storedJob) {
  if (typeof storedJob?.result?.rawOutput === "string") {
    return storedJob.result.rawOutput;
  }
  if (typeof storedJob?.rendered === "string") {
    return storedJob.rendered;
  }
  return storedJob?.errorMessage ?? null;
}

function selectTraceStep(job, records, step) {
  const record = records.find((entry) => entry.n === step);
  if (record) {
    return record;
  }
  const range = records.length === 0 ? "none were recorded" : `valid steps are 1-${records.length}`;
  throw Object.assign(new Error(`Step ${step} is out of range for job ${job.id}; ${range}.`), {
    code: "CODEX_TRACE_STEP_RANGE"
  });
}

export async function buildOutputSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  const latest = resolveLatestInChain(jobs, selected.id);
  const continuedFrom = latest.id === selected.id ? null : selected.id;
  const job = enrichJob(latest);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const runtimeThread =
    threadId && loadBrokerSession(workspaceRoot) ? await readAppServerThread(workspaceRoot, threadId) : null;

  // A reader cursor belongs to the log it was measured against, so it does not carry
  // across a resume: the descendant's log is a different, shorter file.
  // The trail is opt-in: without `--tail` the reader gets the result and the log's path.
  // A trace or a step is read instead of the log, not alongside it.
  const wantsTrace = Boolean(options.trace) || options.step != null;
  const log = readJobLogTail(job.logFile, wantsTrace ? 0 : (options.tail ?? 0), continuedFrom ? 0 : (options.since ?? 0));
  const records = wantsTrace ? readJobEvents(job.eventsFile) : [];

  return {
    workspaceRoot,
    job,
    ...(continuedFrom ? { continuedFrom } : {}),
    trace: options.trace ? records : null,
    step: options.step == null ? null : selectTraceStep(job, records, options.step),
    log: log.lines,
    logStart: log.logStart,
    logTotal: log.logTotal,
    logSince: log.logSince,
    logFile: job.logFile ?? null,
    result: isFinalJobStatus(job.status) ? readJobResultText(storedJob) : null,
    thread: runtimeThread
      ? {
          status: runtimeThread.status,
          canAcceptDirectInput: runtimeThread.canAcceptDirectInput ?? null
        }
      : null
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}

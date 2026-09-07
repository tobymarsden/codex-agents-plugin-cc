# Changelog

## 2.0.0

Breaking: the plugin narrows to one job, letting a Claude session drive Codex agents the way it drives native subagents.

- The `/codex:status`, `/codex:result` and `/codex:cancel` commands are removed; `ListAgents`, `TaskOutput` and `TaskStop` do the same work from the session
- The declared background monitor is removed. It never started in the desktop app, and alongside the per-job Monitor command it would have announced the same job twice. `Agent` hands the caller a self-terminating Monitor command instead, with the state directory pinned into it so it cannot silently watch the wrong place
- Tasks default to `gpt-6-astra` at `high` effort; naming a model or an effort still wins. Accepted efforts are `low`, `medium`, `high`, `xhigh` and `max`, which is what the models actually take: the old list offered `none` and `minimal`, which `gpt-6-astra` rejects, and omitted `max`, which it accepts
- The `codex-cli-runtime` and `codex-result-handling` skills merge into one `codex-agents` skill
- Command output is recorded from its end rather than its beginning, so a long log that fails on its last line no longer reads as a clean run, and the trace states the true line count and how much was kept
- A newly added file reports its real size instead of counting content lines that happen to start with a hyphen
- The effort a job reports is the effort the turn requested, not the thread's default
- A failed job carries a real reason rather than the first brace of an error blob
- Author: Toby Marsden

## 1.6.0

- The plugin ships a background monitor, so an installed plugin notifies the session itself when a Codex job finishes, with no command to run. Monitors are experimental: they start only in interactive CLI sessions and do not load for a project-scope plugin, so the `output --wait` recipe remains the fallback
- A command's trace line carries its outcome, not just its exit code: the output's size, then a bounded tail of its own trailing lines, so a run reporting `pass 0, fail 1` can no longer read as a success
- `fileChange` trace lines say what happened to each file: `src/csv.js (add +120)`, `README.md (update +3-1)`
- Durations are measured here when the server reports none, instead of showing a misleading zero
- Token usage is recorded as it arrives, so a cancelled job still reports what it spent
- `ListAgents` formats token counts like `TaskOutput`, and marks a job that has been continued with the id that now reads it
- `TaskStop` speaks in the same voice as the other tools and no longer names a slash command the caller does not have
- The rescue subagent is deleted; `/codex:rescue` calls the `Agent` tool from the main thread, which costs nothing extra and removes a hop

## 1.5.0

- Every job now writes a structured event store beside its log, one JSON record per completed action, carrying the full command, the changed paths and their diffs, tool arguments and results, and the agent's messages
- `output --trace` (`TaskOutput`'s `trace`) prints a numbered line per action: the full command, the edited paths, the messages in full
- `output --step <n>` (`TaskOutput`'s `step`) prints the whole record behind one of those lines, including a command's output and an edit's diffs
- A pruned job's event store is deleted with its log

## 1.4.1

- Messages that reach a tool caller name the action rather than CLI syntax: the log pointer says `use tail`, and the two refusals that an `Agent` or `SendMessage` call can hit name both routes

## 1.4.0

- `TaskOutput` and `output` return the result and its metadata, not the job's log: Codex's reasoning and commands stay on disk and the read reports the log's path, mirroring how a native subagent hands its parent a report and keeps its transcript in a file
- The trail is one flag away: `TaskOutput`'s new `tail`, or `output --tail <n>`, includes that many log lines and still reads forward on repeat calls

## 1.3.0

- `TaskOutput`'s blocking wait defaults to thirty minutes instead of four, so one call usually covers a job instead of a poll loop
- Repeat `TaskOutput` reads are incremental: each call in a session resumes where the last stopped, and `output` gains `--since <n>` with a `[log lines a-b of N]` trailer
- One job id addresses a whole conversation: `output` and `SendMessage` follow the `parentJobId` resume chain to the newest turn, and `output` reports `continued as` when it moved
- The rescue wrapper no longer attaches the two skills; it forwards the user's text as-is and carries its own rules

## 1.2.0

- Every job records model and per-turn token usage, shown by `output`, `result`, `status --json`, `TaskOutput`, and `ListAgents`
- All five `agents` MCP tools accept `cwd`
- `output` no longer repeats the final answer
- `Agent` prints the background Bash wake-up command
- The prompting skill is renamed to `codex-prompting`, made model-agnostic, and adds brief-as-file guidance
- `codex-cli-runtime` is reframed around the MCP tools
- The rescue wrapper is de-emphasised in favour of direct MCP tool use
- Model examples are updated, and the Spark alias is documented by reference to `MODEL_ALIASES`
- A job whose app-server connection dies fails with `CODEX_CONNECTION_LOST` instead of staying `running` forever
- `SessionEnd` leaves the shared broker running while another Claude session in the workspace has active jobs, and only removes the session id file it owns
- A live broker gets the full readiness timeout before being replaced, so a busy broker is not torn down under its jobs

## 1.1.0

- The shared app-server broker multiplexes across sockets: any process can read or steer a running thread, requests are serialized per thread instead of globally, and the busy error and its direct-server fallback are gone, so one process holds one copy of each thread
- Concurrent jobs no longer lose index updates: the shared state file is written under an advisory lock through a temp-file rename
- `task --job <job-id>` resumes that job's Codex thread as a new job linked by `parentJobId`, and `steer <job-id> <text>` adds input to a job's running turn
- Write-capable runs changed from the `workspace-write` sandbox to `danger-full-access`: `--write` now gives Codex full access with no sandbox
- `output <job-id> [--wait <ms>]` returns a job's state, log tail, live thread status, and final output, either as a peek or as a wait for completion
- A plugin-bundled MCP server named `agents` exposes `Agent`, `SendMessage`, `TaskOutput`, `TaskStop`, and `ListAgents` over those subcommands, surfacing as `mcp__plugin_codex_agents__<Tool>`
- The `SessionStart` hook writes the Claude session id into the workspace state dir, and `SessionEnd` removes it, so the MCP server can keep job records session-scoped

## 1.0.0

- Initial version of the Codex plugin for Claude Code

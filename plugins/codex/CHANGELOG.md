# Changelog

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

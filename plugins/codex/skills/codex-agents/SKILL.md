---
name: codex-agents
description: "How a Claude session drives Codex agents and relays their output"
user-invocable: false
---

# Codex agents

## The agents MCP tools

The `agents` MCP server is the primary way for a Claude main thread to drive Codex.

- `Agent(prompt, run_in_background?, write?, model?, effort?, resume?, cwd?)`: starts a task; `resume` continues a job's Codex thread.
- `SendMessage(to, message, summary?, cwd?)`: steers a running job at its next step, or resumes a finished job as a new job on the same thread, linked by `parentJobId`. Keep using the first job id: both tools follow the resume chain to the newest turn.
- `TaskOutput(task_id, block?, timeout?, tail?, trace?, step?, cwd?)`: reads status, live thread state, recent log, model and tokens, and the final result; blocking defaults to true and waits thirty minutes. Repeat reads are incremental, so a second call shows only what happened since the first.
- `TaskStop(task_id, cwd?)`: cancels a running job.
- `ListAgents(cwd?)`: lists session jobs with status, phase, elapsed time, input availability, model, and `<n>tok`.

`cwd` sets the workspace. Supply it on every tool call when a job must read or write in a specific workspace so later calls use that workspace too.
`write: true` gives Codex full access with no sandbox (`danger-full-access`); approval policy is always `never`.
Leave `model` unset to take the plugin's default. `effort` accepts `low`, `medium`, `high`, `xhigh`, and `max`, and defaults to `high`.

For a background task, `Agent` returns this exact recipe:

```text
Started Codex job <id>. Read it with TaskOutput.
To be notified when it finishes, watch it with the Monitor tool:
  command: [CLAUDE_PLUGIN_DATA="<dir>" ]node "<absolute path>/job-completion-monitor.mjs" --job <id> [--cwd "<dir>"]
  description: Codex job <id>
Or run that same command under a background Bash call.
```

Arm it: an MCP tool cannot push into the Claude session, so no notification arrives unless the session asks for one. Pass the printed command to the Monitor tool (it announces that one job and exits), or run it under a background Bash call. Run it verbatim: the `CLAUDE_PLUGIN_DATA=` prefix, when present, pins the state directory the job actually writes to, and without it the watch can read a different directory and never fire. The same command with `--cwd <dir>` and no `--job` watches every job in a workspace for the whole session.
Finished jobs report `Model: <model> (<effort>)  Tokens: <total> total, <in> in (<cached> cached), <out> out (<reasoning> reasoning)`; `TaskOutput` preserves it and `ListAgents` shows the model and total tokens. Token usage covers that job's own turn, not the whole thread.

## The CLI underneath

- `task [flags] [prompt]`: starts a task, optionally in the background, with write access, model/effort selection, or a resumed thread.
- `steer <job-id> [--prompt-file <path>] [text]`: adds input to a running turn.
- `output <job-id> [--wait <ms>] [--tail <n>] [--trace|--step <n>]`: reads current or final job output and can wait for completion.
- `status [job-id] [--all]`: lists or inspects jobs.
- `result [job-id]`: reads a finished job's stored result.
- `cancel [job-id]`: cancels an active job.

The MCP tools call these `codex-companion.mjs` subcommands. Scripts and hooks may call them directly with `--cwd <dir>` and `--json`.

## Environment

Codex runs shell commands in its own login shell (`zsh -lc`). Its `PATH` and tool versions can differ from the Claude session's, so pin or measure required versions inside the workspace.

## How `/codex:rescue` routes

- The command runs inline on the main thread and makes exactly one `Agent` call, or one `SendMessage` call when the request steers a job that is already running. There is no rescue subagent.
- Strip the flags (`--background`, `--wait`, `--resume`, `--fresh`, `--job`, `--model`, and `--effort`) from the request and map them onto tool parameters: `--background` to `run_in_background: true`, `--resume` and `--job <id>` to `resume: <job id>`, `--fresh` to no `resume`, and `--model`/`--effort` to `model`/`effort`.
- Pass `write: true` by default unless the user asks for read-only work; leave model and effort unset unless requested.
- The remaining task text is the `prompt`, unreshaped: return the tool output verbatim, and never inspect the repository or perform follow-up work.
- If the tool call fails or Codex cannot be invoked, report that failure and stop instead of answering the request from Claude.

## Relaying what came back

- Preserve Codex's verdict, summary, findings, and next-steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as reported.
- Preserve evidence boundaries. If Codex marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- The same rules apply to text returned by `TaskOutput` and by the `output` and `result` subcommands; when relaying a result, keep its `Model:`/`Tokens:` line so the reader knows what ran and what it cost.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Codex made edits, say so explicitly and list the touched files when they are reported.
- For `/codex:rescue`, do not turn a failed or incomplete Codex run into a Claude-side implementation attempt. Report the failure and stop.
- For `/codex:rescue`, if Codex was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the output is malformed or the Codex run failed, include the most actionable stderr lines and stop there instead of guessing.
- If setup or authentication is required, direct the user to `/codex:setup` and do not improvise alternate auth flows.

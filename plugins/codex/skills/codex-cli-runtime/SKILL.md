---
name: codex-cli-runtime
description: "How Claude Code drives Codex: the agents MCP tools for the main thread, the codex-companion CLI underneath, and the forwarding rules for the rescue wrapper"
user-invocable: false
---

# Codex runtime

## The agents MCP tools

The `agents` MCP server is the primary way for a Claude main thread to drive Codex.

- `Agent(prompt, run_in_background?, write?, model?, effort?, resume?, cwd?)`: starts a task; `resume` continues a job's Codex thread.
- `SendMessage(to, message, summary?, cwd?)`: steers a running job at its next step, or resumes a finished job as a new job on the same thread, linked by `parentJobId`. Keep using the first job id: both tools follow the resume chain to the newest turn.
- `TaskOutput(task_id, block?, timeout?, cwd?)`: reads status, live thread state, recent log, model and tokens, and the final result; blocking defaults to true and waits thirty minutes. Repeat reads are incremental, so a second call shows only what happened since the first.
- `TaskStop(task_id, cwd?)`: cancels a running job.
- `ListAgents(cwd?)`: lists session jobs with status, phase, elapsed time, input availability, model, and `<n>tok`.

`cwd` sets the workspace. Supply it on every tool call when a job must read or write in a specific workspace so later calls use that workspace too.
`write: true` gives Codex full access with no sandbox (`danger-full-access`); approval policy is always `never`.

For a background task, `Agent` returns this exact recipe:

```text
Started Codex job <id>. Read it with TaskOutput. To be woken when it finishes instead of polling, run this under a background Bash call:
node "<absolute path>/codex-companion.mjs" output <id> --wait 3600000 [--cwd <dir>]
```

Run that command under a background Bash call to receive a completion notification; an MCP tool cannot push into the Claude session.
Finished jobs report `Model: <model> (<effort>)  Tokens: <total> total, <in> in (<cached> cached), <out> out (<reasoning> reasoning)`; `TaskOutput` preserves it and `ListAgents` shows the model and total tokens. Token usage covers that job's own turn, not the whole thread.

## The CLI underneath

- `task [flags] [prompt]`: starts a task, optionally in the background, with write access, model/effort selection, or a resumed thread.
- `steer <job-id> [--prompt-file <path>] [text]`: adds input to a running turn.
- `output <job-id> [--wait <ms>] [--tail <n>]`: reads current or final job output and can wait for completion.
- `status [job-id] [--all]`: lists or inspects jobs.
- `result [job-id]`: reads a finished job's stored result.
- `cancel [job-id]`: cancels an active job.

The MCP tools call these `codex-companion.mjs` subcommands. Scripts and hooks may call them directly with `--cwd <dir>` and `--json`.

## Environment

Codex runs shell commands in its own login shell (`zsh -lc`). Its `PATH` and tool versions can differ from the Claude session's, so pin or measure required versions inside the workspace.

## Rules for the rescue wrapper

- Make exactly one Bash call to `task`, or to `steer` for a running job.
- Strip routing flags (`--background`, `--wait`, `--resume`, `--fresh`, and `--job`) from the prompt and translate them to the corresponding CLI controls.
- Add `--write` by default unless the user asks for read-only work; leave model and effort unset unless requested.
- Preserve the remaining task text, return stdout verbatim, and never inspect the repository or perform follow-up work.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`; `task` and `steer` are the only entry points.
- `--effort` accepted values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- If the Bash call fails or Codex cannot be invoked, return nothing.

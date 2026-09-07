---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to Codex
argument-hint: "[--background|--wait] [--resume|--fresh|--job <id>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, mcp__plugin_codex_agents__Agent, mcp__plugin_codex_agents__SendMessage
---

Call the plugin's own `mcp__plugin_codex_agents__Agent` tool from this thread, with the user's request as `prompt`.
There is no rescue subagent: do not spawn one, and do not call `Skill(codex:rescue)` (that re-enters this command and hangs the session). The command runs inline so the MCP tools stay in scope.
The final user-visible response must be Codex's output verbatim.

Raw user request:

$ARGUMENTS

Execution mode:

- If the request includes `--background`, call the tool with `run_in_background: true`.
- If the request includes `--wait`, call the tool with `run_in_background: false`.
- If neither flag is present, default to `run_in_background: false`.
- `--background` and `--wait` are execution flags for Claude Code. Do not put them in `prompt`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Pass them as the `model` and `effort` parameters, and do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- If the request includes `--job <id>`, do not ask whether to continue. The user already named the job to continue.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, pass the helper's `candidate.id` as `resume`.
- If the user chooses a new thread, leave `resume` unset.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- Make exactly one `mcp__plugin_codex_agents__Agent` call and return its output as-is.
- If the user is redirecting, steering, or adding instructions to a Codex job that is currently running and names it (a job id, or "the running task" when only one is running), that single call is `mcp__plugin_codex_agents__SendMessage` with `to` set to that job id instead.
- Return the tool output verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of your own.
- Leave `effort` unset unless the user explicitly asks for a specific reasoning effort. Its accepted values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- Leave `model` unset unless the user explicitly asks for one. `spark` maps to the current Codex Spark model (the alias lives in `MODEL_ALIASES` in `codex-companion.mjs`).
- `--resume` and `--job <id>` both become `resume: <job id>`, which continues that job's Codex thread. `--fresh` means leave `resume` unset.
- Pass `write: true` by default unless the user explicitly asks for read-only work, review, diagnosis, or research without edits. `write: true` gives Codex full access with no sandbox.
- Preserve the user's task text as-is in `prompt` apart from stripping the flags above. Do not reshape it into a better prompt, reason through the problem yourself, or draft a solution.
- If the tool call fails or Codex cannot be invoked, report that failure and stop. Do not answer the request yourself.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.

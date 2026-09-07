# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `Agent`, `SendMessage`, `TaskOutput`, `TaskStop`, and `ListAgents` MCP tools let a Claude session drive Codex like a subagent
- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add tobymarsden/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@tobymarsden-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

For direct control from a Claude session, use the `agents` MCP tools below; `/codex:rescue` is the slash-command route.

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, `--fresh`, and `--job <id>`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --job task-abc123 apply the top fix
/codex:rescue --model gpt-5.5 --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- `spark` maps to the current Codex Spark model (the alias lives in `MODEL_ALIASES` in `codex-companion.mjs`)
- follow-up rescue requests can continue the latest Codex task in the repo
- rescue runs add `--write` by default unless you ask for read-only work, and `--write` gives Codex full access with no sandbox

### Codex as a subagent: the `agents` MCP tools

The plugin registers an MCP server named `agents`, so Claude Code sees `mcp__plugin_codex_agents__Agent`, `mcp__plugin_codex_agents__SendMessage`, `mcp__plugin_codex_agents__TaskOutput`, `mcp__plugin_codex_agents__TaskStop`, and `mcp__plugin_codex_agents__ListAgents`: the same verbs as the native subagent tools, one namespace over. Each one is a job id away from the slash commands above. Every tool accepts optional `cwd`; pass it on every call when work belongs to a specific workspace so the job and later lookups stay in that workspace.

| Tool | Parameters | What it does |
|---|---|---|
| `Agent` | `prompt`, `run_in_background`, `write`, `model`, `effort`, `resume`, `cwd` | Runs a Codex task. With `run_in_background` it returns a job id instead of the result; `resume` takes a job id whose Codex thread the task continues |
| `SendMessage` | `to`, `message`, `summary`, `cwd` | Delivers a message to the job named by `to` |
| `TaskOutput` | `task_id`, `block`, `timeout`, `cwd` | Reads a job's output |
| `TaskStop` | `task_id`, `cwd` | Cancels a running job |
| `ListAgents` | `cwd` | Lists this session's jobs with status, phase, elapsed time, and whether each accepts input |

`SendMessage` branches on the job. On a running job it steers the current turn mid-flight: the text joins the turn already in progress, and Codex sees it at its next step. On a finished job it resumes the same Codex thread as a new job, linked to the old one by `parentJobId`, and returns the new job id so the thread's context carries over. The job id you were given first stays valid: `SendMessage` and `TaskOutput` follow the resume chain to the newest turn, so one handle addresses the whole conversation and `TaskOutput` says `continued as` when it has moved.

`TaskOutput` with `block` waits for the job to finish or for `timeout` to elapse, and defaults to thirty minutes, so a long job usually needs one call rather than a poll loop. Without `block` it returns the job's current state, a tail of its log, and the live thread status. Repeat reads are incremental: each call within a session picks up where the last one stopped, and the `[log lines a-b of N]` trailer says how far it got.

Every finished job includes `Model: <model> (<effort>)  Tokens: <total> total, <in> in (<cached> cached), <out> out (<reasoning> reasoning)` in `TaskOutput`; the token figure covers that job's turn, not the whole thread. `ListAgents` appends the model and `<n>tok`.

Jobs are scoped to the Claude session, so `ListAgents` and the job ids you get back cover the work this session started.

For a background job, `Agent` prints:

```text
Started Codex job <id>. Read it with TaskOutput. To be woken when it finishes instead of polling, run this under a background Bash call:
node "<absolute path>/codex-companion.mjs" output <id> --wait 3600000 [--cwd <dir>]
```

Run that command under a background `Bash` call to receive a completion notification; an MCP tool cannot push into the session.

Codex runs shell commands in its own login shell (`zsh -lc`), so its `PATH` and tool versions can differ from the Claude session's. Pin or measure a required tool version inside the workspace.

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### Steering a running job

Two `codex-companion` subcommands address a job by the id `/codex:status` shows:

```bash
steer <job-id> <text>
output <job-id> --wait <ms>
```

`steer` adds the text to the job's running turn, which Codex picks up at its next step.
`output --wait` blocks until the job finishes or the timeout elapses, then prints its state, log tail, and final output.

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example, to set a model and `high` effort for a specific project, add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "<model-slug>"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

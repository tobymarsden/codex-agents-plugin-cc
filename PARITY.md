# Codex plugin ↔ native subagent parity

Working notes, 2026-09-07. What `openai/codex-plugin-cc` (v1.0.6, `db52e28`)
would need so that driving Codex from Claude Code feels like driving a
native Claude subagent: spawn, watch live, steer mid-turn, resume with
context, stop, list. Facts below are from the plugin source, the installed
Codex CLI 0.153.4's generated app-server schema, and `openai/codex`
`codex-rs/app-server` at `5ecb3af`.

## 1. What native subagents give the main thread

| Native tool | Contract |
|---|---|
| `Agent` | spawn with a prompt; `run_in_background`; returns an agent id; completion arrives as a task notification |
| `SendMessage` | `{to, message, summary}` — deliver a message to a spawned agent, running or finished; the agent continues with its context intact |
| `TaskOutput` | `{task_id, block, timeout}` — current output of a running or finished task; `block:false` is a non-blocking peek, `block:true` waits up to `timeout` |
| `TaskStop` | `{task_id}` — terminate |
| `ListAgents` | enumerate addressable agents by name |

## 2. What the plugin gives today

| Capability | Plugin today | Where |
|---|---|---|
| Spawn | `task [--background] [--write] [--model] [--effort] <prompt>`; the `codex-rescue` agent is a one-shot Bash forwarder | `codex-companion.mjs` `task`, `agents/codex-rescue.md` |
| Watch live | `status [job-id]` — the last 4 progress lines of the job log; `result` refuses until the job finishes | `job-control.mjs` `readJobProgressPreview`, `resolveResultJob` |
| Steer mid-turn | **none** — `task --resume-last` refuses while a task is queued or running ("Task … is still running. Use /codex:status before continuing it.") | `codex-companion.mjs:341-343` |
| Resume with context | `task --resume-last` — continues the *newest* thread whose name carries the task prefix; no addressing by thread id or job id | `codex.mjs` `findLatestTaskThread` |
| Stop | `cancel [job-id]` → `turn/interrupt` | `interruptAppServerTurn` |
| List | `status --all` (jobs, not threads) | `buildStatusSnapshot` |

Every job record already persists `threadId` and `turnId` as progress
events arrive (`tracked-jobs.mjs` `createJobProgressUpdater`), and every
job writes a timestamped log at
`<state-dir>/jobs/<job-id>.log`. So the raw material for watch and
address-by-id exists; it is not exposed.

## 3. What the Codex app-server can already do (0.153.4)

The plugin's own `app-server-protocol.d.ts` types five methods. The
installed server exposes what parity needs:

| Method | Semantics (from `app-server/README.md`) | Plugin uses it? |
|---|---|---|
| `turn/steer` | add user input to an in-flight turn without starting a new turn; params `{threadId, input, expectedTurnId}`; returns the accepting `turnId`; fails if `expectedTurnId` is not the active turn; review and compaction turns reject it | no |
| `turn/interrupt` | cancel by `(threadId, turnId)`; turn ends `interrupted` | yes (`cancel`) |
| `thread/read` | stored thread by id without resuming; `status` ∈ `notLoaded / idle / active{activeFlags} / systemError`; `canAcceptDirectInput` says whether `turn/start` and `turn/steer` are accepted | no |
| `thread/turns/list`, `thread/items/list` | page a thread's history without resuming it | no |
| `thread/loaded/list` | thread ids loaded in the server process | no |
| `thread/resume` | load a stored thread and continue it | yes (`--resume-last`) |
| `thread/fork` | branch a thread | no |
| `thread/queue/changed` | notification: the thread's queued-input list changed | no |
| `thread/status/changed` | notification | no |

So mid-turn steering, live reads, and addressed resumes are all
**substrate-supported**. The gaps are in the plugin, not in Codex.

## 4. The three structural obstacles in the plugin

These are what a parity build actually has to change; the tools are the
easy part.

### 4a. The broker is single-tenant

`app-server-broker.mjs` multiplexes one `codex app-server` behind a Unix
socket, but it admits **one active request socket and one active stream
socket**. Any other socket's request gets `Shared Codex broker is busy`
— the sole exception is `turn/interrupt` from a second socket during an
active stream. Notifications are routed to that one active socket only.

Consequence: while a task turn is streaming, no second process can send
`turn/steer` or `thread/read`, and no second process can observe the
stream.

### 4b. The busy fallback splits threads across processes

`withAppServer` (`codex.mjs:613`) catches the broker's busy error and
**retries against a freshly spawned direct `codex app-server`**. A second
concurrent task therefore runs in a different server process from the
first. A later `thread/resume` of the first thread from the second
process would load a second in-memory copy off the rollout while the
first is still live — two writers on one thread. This is the defect a
steer tool would trip first; it has to go before steering is safe.

### 4c. Resume is by "newest named thread", not by handle

`--resume-last` picks `thread/list`'s newest thread whose name starts
with the task prefix. There is no `--thread <id>` or `--job <id>`, and
the job id → thread id mapping, though persisted, is not an input
anywhere. Parity needs a stable handle the caller received at spawn and
can hand back.

## 5. Design: a handle, a multiplexing broker, and five tools

### 5a. The handle

The spawn returns a **job id** (already exists: `job_…`). It stays the
one address for everything after — the job record carries
`threadId`, `turnId`, `status`, `logFile`, `sessionId`. Thread ids stay
internal; `codex resume <threadId>` is still printed for the TUI.

### 5b. The broker becomes a real multiplexer

Replace the single-active-socket rule with **per-thread ownership plus
fan-out**:

- Any socket may send any request. Requests carrying a `threadId` are
  serialized per thread (a small queue per thread id), never globally.
  `turn/start` on a thread with an active turn is refused with the
  server's own error, not the broker's.
- Notifications carrying a `threadId` are delivered to every socket that
  has **subscribed** to that thread (`broker/subscribe {threadId}`,
  `broker/unsubscribe`), plus the socket that started the turn. Thread-
  less notifications go to all.
- The busy fallback in `withAppServer` is deleted. If the broker is
  unreachable the client starts a direct server as today; if it is
  reachable it is the only server. One process, one copy of each thread.
- `turn/steer` and `turn/interrupt` are always admitted from any socket.

This is ~150 lines in `app-server-broker.mjs` and the removal of the
retry branch in `codex.mjs`. It is the load-bearing change; everything in
5c is thin over it.

### 5c. The tools, shadowing the native names

Named so the main thread reads them as the Codex twin of what it already
knows. (Delivery mechanism in § 6.)

| Tool | Params | Does |
|---|---|---|
| `CodexAgent` | `prompt`, `run_in_background?`, `write?`, `model?`, `effort?`, `resume?` (job id) | = `task`. Foreground returns the rendered result; background returns `{job_id}` immediately. With `resume`, `thread/resume` on that job's thread and `turn/start` |
| `CodexSendMessage` | `to` (job id), `message`, `summary?` | If the job's turn is active and `thread/read.canAcceptDirectInput`: `turn/steer {threadId, expectedTurnId: turnId, input}` → returns the accepting turn id. If the job is finished: `thread/resume` + `turn/start` on the same thread as a **new job** whose record links `parentJobId` — the caller gets a fresh job id, the thread keeps its context. If the turn is a review or compaction: typed refusal |
| `CodexTaskOutput` | `task_id` (job id), `block` (default true), `timeout` (ms) | `block:false` → the job record + the log tail (bounded, newest-last) + `thread/read.status`. `block:true` → subscribe to the thread on the broker and return when `turn/completed` arrives or `timeout` elapses, then the same snapshot plus the final message if done |
| `CodexTaskStop` | `task_id` | = `cancel`: `turn/interrupt`; then mark the job `cancelled` |
| `CodexListAgents` | — | jobs for this session (queued, running, finished) with job id, phase, elapsed, thread status from `thread/read`, and whether it accepts input |

`expectedTurnId` is the safety on steer: the broker holds the live turn
id in the job record (the progress updater already writes it), and a
steer that races a turn boundary fails typed instead of landing on the
wrong turn.

### 5d. What the steer *means* to Codex

`turn/steer` appends user input to the running turn's model-visible
history; the model sees it at its next sampling step, exactly as a
steer to a Claude subagent does. Nothing is queued for "after"; a message
to a finished job goes through resume instead, which is why
`CodexSendMessage` branches on the thread's status rather than making the
caller choose.

### 5e. The rescue agent

`agents/codex-rescue.md` today forbids its wrapper from `status`,
`result`, or `cancel` and mandates exactly one Bash call. With the tools
above the wrapper can be retired, or reduced to a prompt-shaping
front for `CodexAgent`; the main thread talks to the tools directly and
keeps the supervision.

## 6. Delivery mechanism

From the Claude Code plugin docs (plugins.md, mcp.md, hooks.md):

- A plugin ships tools by bundling an **MCP server**: a `.mcp.json` at
  the plugin root with `mcpServers: { <server>: { type: "stdio",
  command: "${CLAUDE_PLUGIN_ROOT}/…" } }`. The server is a stdio process
  started per session; its tools are available to the main thread and to
  subagents.
- Tool names are prefixed, never bare: `mcp__plugin_<plugin>_<server>__<tool>`.
  **A plugin cannot override or shadow a built-in name** (`Agent`,
  `SendMessage`, …); the prefix exists to prevent exactly that. So the
  closest honest shadow is a server named `agents` exposing tools named
  `Agent`, `SendMessage`, `TaskOutput`, `TaskStop`, `ListAgents`, which
  surface as `mcp__plugin_codex_agents__SendMessage` and so on — the same
  verb vocabulary, one namespace over. That is what § 5c's names should
  be read as (`CodexSendMessage` = `mcp__plugin_codex_agents__SendMessage`).
- No deferred loading for MCP tools: five small tool schemas load at
  session start. Keep the schemas short.
- MCP server processes receive only the static `env` from `.mcp.json`.
  The session id is **not** passed to them, while the plugin's existing
  `SessionStart` hook does receive it (`session_id` on stdin) and exports
  `CODEX_COMPANION_SESSION_ID` into the shell via `CLAUDE_ENV_FILE`. The
  MCP server therefore cannot rely on that variable. Two options, pick
  one: (a) the hook writes the session id into the broker session file
  (`loadBrokerSession(cwd)` already exists and is cwd-keyed) and the
  server reads it there at each call; (b) `ListAgents`/`TaskOutput` take
  an optional `session` filter and default to all jobs in the workspace.
  (a) keeps today's per-session scoping and is the recommendation.
- The MCP server is a thin adapter: each tool is one call into the
  existing `codex-companion.mjs` subcommands (§ 7 steps 2–3), so the
  slash commands and the MCP tools stay one implementation.
- `SubagentStart`/`SubagentStop` hooks exist and carry `agent_id` and
  `agent_type`; not needed for parity, but a Codex job could mirror a
  Claude subagent's lifecycle into them later.

### 6a. Evidence that steering works on the installed server

Probe run 2026-09-07 against a direct `codex app-server` (0.153.4) with
the plugin's own `CodexAppServerClient`: a turn told to count 1–12 with
a `sleep 2` between numbers; nine seconds in, `turn/steer
{threadId, expectedTurnId, input: "stop counting and reply 'steer
received at <n>'"}`. Result: steer returned the same `turnId`,
`thread/read` reported `status: active` and `canAcceptDirectInput: true`,
and the turn completed with the agent's final message **"steer received
at 1"** after one `sleep 2`. The model saw the steer mid-turn and obeyed
it. Script: `steer-probe.mjs` beside this file.

## 7. Build order

1. Broker multiplexing (5b) + delete the busy fallback. Tests: two
   sockets, one streaming, the other reads `thread/read` and receives
   fan-out; steer admitted mid-stream. Fake-codex fixture gains
   `turn/steer` and `thread/read`.
2. Job handle plumbing: `task --job <id>` resume by job id; a
   `steer <job-id> <text>` subcommand on `codex-companion.mjs` using
   `expectedTurnId` from the record. Rescue-agent guidance updated.
3. `output <job-id> [--wait <ms>]` subcommand: the non-blocking snapshot,
   then the blocking form over broker subscription.
4. The tool surface (§ 6) over the four subcommands, with the native
   names.
5. `CodexListAgents` and the `parentJobId` link for resumed jobs.

Each step is independently shippable and testable with the existing
`node --test` harness and `fake-codex-fixture.mjs`.

## 6b. Probe addenda, 2026-09-07 (branch `parity/subagent-tools`)

Two live probes against a direct `codex app-server` 0.153.4 before step 1:

- `steer-probe.mjs` re-run: steer accepted (same `turnId`), `thread/read`
  → `status.type: "active"`, `canAcceptDirectInput: true`, final message
  "steer received at 2". **`canAcceptDirectInput` is not in the generated
  JSON schema** (`Thread` has no such property); it is emitted at runtime
  as an experimental-client field. The plugin reads it, never types it.
- `turn/start` on a thread with an active turn is **not refused**. The
  server returned the *active* turn (same id, `status: inProgress`) and the
  input joined that turn: the model answered the second prompt ("second
  done") inside the first turn. § 5b's line "refused with the server's own
  error" is wrong for 0.153.4; the broker simply forwards, and whatever
  the server does is the behaviour. The fixture mirrors the observed
  fold-in, not a refusal.
- `thread/queue/changed` was not emitted in either probe;
  `thread/status/changed` (`active` → `idle`) was. The fixture models only
  what was observed, so step 1 does not add `thread/queue/changed`.
- `tokens-probe.mjs` (step 4 prep): one thread, two turns, five
  `thread/tokenUsage/updated` notifications. Turn 1 (three `echo`s) gave
  `last.totalTokens` 28999 / 29081 / 29163 / 29193 with `total.totalTokens`
  28999 / 58080 / 87243 / 116436; turn 2 ("reply: again") gave one more,
  `last` 34670 and `total` 151106. So **`last` is the single most recent
  model request**, and **`total` is a running sum of every `last` on the
  thread, carried across turns** (116436 + 34670 = 151106 exactly). A job's
  own usage is therefore the sum of the `last` breakdowns seen during its
  turn, which equals `total`'s delta over the turn; the raw `total` would
  over-report a resumed job by the whole thread's prior history.
  `thread/start` returned `model: "gpt-5.6-sol"`, `reasoningEffort: "high"`
  at the response top level (also mirrored on `response.thread`).
- Notification routing rule chosen for the broker: a notification carrying
  `params.threadId` goes to that thread's subscribers plus the socket that
  started its turn; a notification with no owner for its thread id, or no
  thread id at all (`thread/started`), goes to every socket. Clients already
  filter by thread (`captureTurn`'s `belongsToTurn`), so Codex-spawned
  subagent threads keep reaching their parent's starter without the broker
  parsing `collabAgentToolCall` items.

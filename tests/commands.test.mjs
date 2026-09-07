import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("rescue drives the agents MCP tool from the main thread instead of a subagent", () => {
  const rescue = read("commands/rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  // The rescue subagent is retired: each forwarded call spent tens of thousands of
  // subagent tokens to make one Bash call, so the command now calls the plugin's own
  // MCP tool directly. Nothing may point at the deleted agent.
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "agents")), false);
  assert.doesNotMatch(rescue, /subagent_type|codex:codex-rescue/);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(
    rescue,
    /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*mcp__plugin_codex_agents__Agent,\s*mcp__plugin_codex_agents__SendMessage/
  );
  assert.match(rescue, /Call the plugin's own `mcp__plugin_codex_agents__Agent` tool from this thread, with the user's request as `prompt`/i);
  assert.match(rescue, /There is no rescue subagent: do not spawn one/i);
  // Regression for #234: `Skill(codex:rescue)` re-enters this command and hangs the session.
  assert.match(rescue, /do not call `Skill\(codex:rescue\)`/i);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /If the request includes `--background`, call the tool with `run_in_background: true`/i);
  assert.match(rescue, /If the request includes `--wait`, call the tool with `run_in_background: false`/i);
  assert.match(rescue, /If neither flag is present, default to `run_in_background: false`/i);
  assert.match(rescue, /Do not put them in `prompt`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /Pass them as the `model` and `effort` parameters/i);
  assert.match(rescue, /Leave `effort` unset unless the user explicitly asks for a specific reasoning effort/i);
  assert.match(rescue, /accepted values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`/i);
  assert.match(rescue, /`spark` maps to the current Codex Spark model/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, pass the helper's `candidate\.id` as `resume`/i);
  assert.match(rescue, /If the user chooses a new thread, leave `resume` unset/i);
  assert.match(rescue, /`--resume` and `--job <id>` both become `resume: <job id>`/i);
  assert.match(rescue, /Make exactly one `mcp__plugin_codex_agents__Agent` call/i);
  assert.match(rescue, /that single call is `mcp__plugin_codex_agents__SendMessage` with `to` set to that job id/i);
  assert.match(rescue, /Pass `write: true` by default unless the user explicitly asks for read-only work/i);
  assert.match(rescue, /Return the tool output verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /Preserve the user's task text as-is in `prompt`/i);
  assert.match(rescue, /If the tool call fails or Codex cannot be invoked, report that failure and stop/i);
  assert.match(runtimeSkill, /## The agents MCP tools/);
  assert.match(runtimeSkill, /## How `\/codex:rescue` routes/);
  assert.doesNotMatch(runtimeSkill, /rescue wrapper|codex:codex-rescue/);
  assert.match(runtimeSkill, /makes exactly one `Agent` call, or one `SendMessage` call when the request steers a job that is already running/i);
  assert.match(runtimeSkill, /There is no rescue subagent/i);
  assert.match(
    runtimeSkill,
    /Strip the flags \(`--background`, `--wait`, `--resume`, `--fresh`, `--job`, `--model`, and `--effort`\)/i
  );
  assert.match(runtimeSkill, /`--background` to `run_in_background: true`/i);
  assert.match(runtimeSkill, /`--resume` and `--job <id>` to `resume: <job id>`/i);
  assert.match(runtimeSkill, /Pass `write: true` by default unless the user asks for read-only work/i);
  assert.match(runtimeSkill, /leave model and effort unset unless requested/i);
  assert.match(runtimeSkill, /`effort` accepted values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`/i);
  assert.match(runtimeSkill, /never inspect the repository or perform follow-up work/i);
  assert.match(runtimeSkill, /If the tool call fails or Codex cannot be invoked, report that failure and stop/i);
  assert.doesNotMatch(runtimeSkill, /gpt-5\.3-codex-spark|gpt-5-4-prompting/);
  assert.match(readme, /if you do not pass `--model` or `--effort`, Codex chooses its own defaults/i);
  assert.match(readme, /--model gpt-5\.5 --effort medium/i);
  assert.match(readme, /`spark` maps to the current Codex Spark model/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /### `\/codex:setup`/);
  assert.match(readme, /### `\/codex:review`/);
  assert.match(readme, /### `\/codex:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/codex:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/codex:rescue`/);
  assert.match(readme, /### `\/codex:transfer`/);
  assert.match(readme, /### `\/codex:status`/);
  assert.match(readme, /### `\/codex:result`/);
  assert.match(readme, /### `\/codex:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/codex-prompting/SKILL.md");
  const promptRecipes = read("skills/codex-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /`task \[flags\] \[prompt\]`/);
  assert.match(runtimeSkill, /`steer <job-id>/);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptingSkill, /`\/codex:rescue`/);
  assert.match(promptRecipes, /In `\/codex:rescue`, run diagnosis and fix-oriented recipes in write mode by default/i);
  for (const source of [promptingSkill, promptRecipes, read("skills/codex-result-handling/SKILL.md")]) {
    assert.doesNotMatch(source, /codex:codex-rescue/);
  }
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("the plugin declares a job-completion monitor Claude Code can start", () => {
  const monitors = JSON.parse(read(path.join("monitors", "monitors.json")));

  assert.equal(Array.isArray(monitors), true);
  assert.equal(monitors.length, 1);
  const [monitor] = monitors;
  assert.equal(monitor.name, "codex-jobs");
  assert.equal(monitor.description, "Codex job completions");
  assert.equal(monitor.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/job-completion-monitor.mjs"');
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "scripts", "job-completion-monitor.mjs")), true);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});

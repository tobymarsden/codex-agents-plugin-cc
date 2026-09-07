import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { after } from "node:test";

import { clearBrokerSession, loadBrokerSession, sendBrokerShutdown, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const tempDirs = [];

// Every temp workspace a test file creates may have started a shared broker (and its
// codex app-server) that nothing else stops; shut them down when the file finishes.
after(async () => {
  for (const dir of tempDirs) {
    const session = loadBrokerSession(dir);
    if (!session) {
      continue;
    }
    await sendBrokerShutdown(session.endpoint);
    teardownBrokerSession({ ...session, killProcess: terminateProcessTree });
    clearBrokerSession(dir);
  }
});

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

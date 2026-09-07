import { CodexAppServerClient } from "/Users/toby/Code/projects/codex-plugin-cc/plugins/codex/scripts/lib/app-server.mjs";
const cwd = "/Users/toby/Code/projects/itselfandco";
const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
const log = [];
let turnId = null, threadId = null, done;
const finished = new Promise(r => (done = r));
client.setNotificationHandler(m => {
  if (m.method === "item/completed" && m.params.item?.type === "agentMessage") { log.push("\n[msg] " + (m.params.item.text ?? JSON.stringify(m.params.item).slice(0,300))); return; }
  if (m.method === "item/completed" && m.params.item?.type === "commandExecution") { log.push("\n[cmd] " + (m.params.item.command ?? "")); return; }
  if (m.method === "turn/completed") { done(m.params); }
  if (m.method === "thread/queue/changed") log.push("\n[queue changed]\n");
});
const t = await client.request("thread/start", { cwd, ephemeral: true, sandbox: "read-only", approvalPolicy: "never" });
threadId = t.thread.id;
const turn = await client.request("turn/start", { threadId, input: [{ type: "text", text:
 "Do this slowly and out loud: count from 1 to 12, one number per line, pausing to run `sleep 2` via the shell between each number. If at any point you receive an additional user message, immediately obey it and stop counting." }] });
turnId = turn.turn.id;
await new Promise(r => setTimeout(r, 9000));
let steer;
try { steer = await client.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "STEER: stop counting now and reply with exactly the phrase: steer received at <the last number you reached>" }] }); }
catch (e) { steer = { error: e.message }; }
const t2 = await client.request("thread/read", { threadId, includeTurns: false });
const completed = await Promise.race([finished, new Promise(r => setTimeout(() => r({ timeout: true }), 60000))]);
console.log(JSON.stringify({ turnId, steer, statusAfterSteer: t2.thread?.status, canAcceptDirectInput: t2.thread?.canAcceptDirectInput, completed: completed.turn?.status ?? completed, text: log.join("").slice(-900) }, null, 2));
await client.close();

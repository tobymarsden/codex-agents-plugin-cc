#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function addOwner(owners, threadId, socket) {
  if (typeof threadId !== "string") {
    return;
  }
  const sockets = owners.get(threadId) ?? new Set();
  sockets.add(socket);
  owners.set(threadId, sockets);
}

function removeOwner(owners, threadId, socket) {
  const sockets = owners.get(threadId);
  if (!sockets) {
    return;
  }
  sockets.delete(socket);
  if (sockets.size === 0) {
    owners.delete(threadId);
  }
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  const sockets = new Set();
  const subscribers = new Map();
  const starters = new Map();
  const threadQueues = new Map();

  function releaseSocket(socket) {
    sockets.delete(socket);
    for (const owners of [subscribers, starters]) {
      for (const threadId of owners.keys()) {
        removeOwner(owners, threadId, socket);
      }
    }
  }

  function routeNotification(message) {
    const threadId = message.params?.threadId ?? null;
    const owners = new Set([...(subscribers.get(threadId) ?? []), ...(starters.get(threadId) ?? [])]);
    for (const socket of owners.size > 0 ? owners : sockets) {
      send(socket, message);
    }
    if (threadId && message.method === "turn/completed") {
      starters.delete(threadId);
    }
  }

  function serializeByThread(threadId, task) {
    if (typeof threadId !== "string") {
      task();
      return;
    }
    const tail = (threadQueues.get(threadId) ?? Promise.resolve()).then(task);
    threadQueues.set(threadId, tail);
    tail.then(() => {
      if (threadQueues.get(threadId) === tail) {
        threadQueues.delete(threadId);
      }
    });
  }

  async function forwardRequest(socket, message) {
    const params = message.params ?? {};
    if (STREAMING_METHODS.has(message.method)) {
      addOwner(starters, params.threadId, socket);
    }
    try {
      const result = await appClient.request(message.method, params);
      if (message.method === "review/start") {
        addOwner(starters, result?.reviewThreadId, socket);
      }
      send(socket, { id: message.id, result });
    } catch (error) {
      send(socket, {
        id: message.id,
        error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
      });
    }
  }

  async function shutdown(server) {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        if (message.method === "broker/subscribe" || message.method === "broker/unsubscribe") {
          const update = message.method === "broker/subscribe" ? addOwner : removeOwner;
          update(subscribers, message.params?.threadId, socket);
          send(socket, { id: message.id, result: {} });
          continue;
        }

        serializeByThread(message.params?.threadId, () => forwardRequest(socket, message));
      }
    });

    socket.on("close", () => {
      releaseSocket(socket);
    });

    socket.on("error", () => {
      releaseSocket(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

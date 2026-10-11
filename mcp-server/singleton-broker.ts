import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { ExtensionMessage, ServerMessage } from "@browser-control-mcp/common";

import { BROKER_COMMANDS, getBrokerCommand } from "./broker-commands";

export const BROKER_PROTOCOL_VERSION = 1;

// How long to wait for broker and WebSocket connections to shut down
// cleanly before the remaining sockets are dropped, so a stuck peer
// cannot hang the shutdown.
export const SOCKET_CLOSE_TIMEOUT_MS = 1000;

export interface BrokerIdentity {
  id: string;
  port: number;
  secretHash: string;
}

export interface BrokerInfo {
  pid: number;
  identity: BrokerIdentity;
  socketPath: string;
  token: string;
  protocolVersion: number;
}

interface BrokerRequest {
  id: string;
  protocolVersion: number;
  token: string;
  operation: "ping" | "request";
  message?: unknown;
}

interface BrokerResponse {
  id: string;
  ok: boolean;
  result?: ExtensionMessage | "pong";
  error?: string;
}

export function createBrokerIdentity(options: {
  port: number;
  extensionSecret: string;
}): BrokerIdentity {
  const secretHash = crypto
    .createHash("sha256")
    .update(options.extensionSecret)
    .digest("hex")
    .slice(0, 16);
  return {
    id: `${options.port}-${secretHash}`,
    port: options.port,
    secretHash,
  };
}

export function getBrokerDirectory(): string {
  // Fall back to ~/.cache for both unset and empty XDG_CACHE_HOME (empty is not
  // nullish), so the broker state always lives in an absolute per-user location
  // and never relative to the server process's working directory.
  const cacheDirectory =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheDirectory, "browser-control-mcp");
}

export function getBrokerInfoPath(identity: BrokerIdentity): string {
  return path.join(getBrokerDirectory(), `leader-${identity.id}.json`);
}

export function getBrokerSocketPath(identity: BrokerIdentity): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\browser-control-mcp-${identity.id}`;
  }
  return path.join(getBrokerDirectory(), `leader-${identity.id}.sock`);
}

export function createBrokerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function writeBrokerInfo(info: BrokerInfo): void {
  ensureBrokerDirectory();
  const infoPath = getBrokerInfoPath(info.identity);
  fs.writeFileSync(infoPath, JSON.stringify(info), { mode: 0o600 });
  fs.chmodSync(infoPath, 0o600);
}

export function readBrokerInfo(identity: BrokerIdentity): BrokerInfo | null {
  try {
    const info = JSON.parse(
      fs.readFileSync(getBrokerInfoPath(identity), "utf8")
    ) as BrokerInfo;
    if (
      info.protocolVersion !== BROKER_PROTOCOL_VERSION ||
      info.identity?.id !== identity.id ||
      info.identity.port !== identity.port ||
      info.identity.secretHash !== identity.secretHash ||
      !Number.isInteger(info.pid) ||
      typeof info.socketPath !== "string" ||
      typeof info.token !== "string"
    ) {
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

export function clearBrokerInfo(expected: BrokerInfo): void {
  const current = readBrokerInfo(expected.identity);
  if (current && current.token !== expected.token) {
    return;
  }
  try {
    fs.unlinkSync(getBrokerInfoPath(expected.identity));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function removeBrokerSocket(socketPath: string): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function createBrokerServer(options: {
  socketPath: string;
  token: string;
  handleMessage: (message: ServerMessage) => Promise<ExtensionMessage>;
}) {
  let server: net.Server | null = null;
  // The open broker connections, so close() can drop the ones a stuck
  // peer is holding open.
  const openSockets = new Set<net.Socket>();

  return {
    async start(): Promise<void> {
      ensureBrokerDirectory();

      server = net.createServer((socket) => {
        openSockets.add(socket);
        socket.on("close", () => {
          openSockets.delete(socket);
        });
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk.toString();
          if (!data.endsWith("\n")) {
            return;
          }

          let request: BrokerRequest;
          try {
            request = JSON.parse(data) as BrokerRequest;
          } catch (error) {
            respond(socket, {
              id: "unknown",
              ok: false,
              error: `Invalid broker request: ${toErrorMessage(error)}`,
            });
            return;
          }

          if (request.protocolVersion !== BROKER_PROTOCOL_VERSION) {
            respond(socket, {
              id: request.id,
              ok: false,
              error: "Unsupported broker protocol version",
            });
            return;
          }
          if (request.token !== options.token) {
            respond(socket, {
              id: request.id,
              ok: false,
              error: "Unauthorized broker request",
            });
            return;
          }
          if (request.operation === "ping") {
            respond(socket, { id: request.id, ok: true, result: "pong" });
            return;
          }
          if (request.operation !== "request" || !request.message) {
            respond(socket, {
              id: request.id,
              ok: false,
              error: "Unsupported broker request",
            });
            return;
          }
          if (!isAllowedBrokerCommand(request.message)) {
            respond(socket, {
              id: request.id,
              ok: false,
              error: `Unsupported broker command: ${getCommand(request.message)}`,
            });
            return;
          }
          if (!isBrokerMessage(request.message)) {
            respond(socket, {
              id: request.id,
              ok: false,
              error: "Invalid broker message",
            });
            return;
          }

          options
            .handleMessage(request.message)
            .then((result) => respond(socket, { id: request.id, ok: true, result }))
            .catch((error) =>
              respond(socket, {
                id: request.id,
                ok: false,
                error: toErrorMessage(error),
              })
            );
        });
      });

      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(options.socketPath, resolve);
      });
    },

    async close(): Promise<void> {
      if (!server?.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          // Stuck connections would keep the server open; drop them so
          // the pending close completes.
          for (const socket of openSockets) {
            socket.destroy();
          }
        }, SOCKET_CLOSE_TIMEOUT_MS);
        server?.close((error) => {
          clearTimeout(timer);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      if (process.platform !== "win32") {
        try {
          fs.unlinkSync(options.socketPath);
        } catch {
          // The socket may already be gone.
        }
      }
    },
  };
}

function ensureBrokerDirectory(): void {
  fs.mkdirSync(getBrokerDirectory(), { recursive: true, mode: 0o700 });
  fs.chmodSync(getBrokerDirectory(), 0o700);
}

function getCommand(message: unknown): unknown {
  return typeof message === "object" && message !== null
    ? (message as Record<string, unknown>).cmd
    : undefined;
}

function isAllowedBrokerCommand(message: unknown): boolean {
  return getBrokerCommand(message) !== undefined;
}

function isBrokerMessage(message: unknown): message is ServerMessage {
  const command = getBrokerCommand(message);
  if (command === undefined) {
    return false;
  }
  return BROKER_COMMANDS[command].validate(message as Record<string, unknown>);
}

export async function pingBroker(options: {
  socketPath: string;
  token: string;
  timeoutMs: number;
}): Promise<boolean> {
  try {
    return await sendBrokerRequest({ ...options, operation: "ping" }) === "pong";
  } catch {
    return false;
  }
}

export async function forwardToBroker(options: {
  socketPath: string;
  token: string;
  message: ServerMessage;
  timeoutMs: number;
}): Promise<ExtensionMessage> {
  return await sendBrokerRequest({
    ...options,
    operation: "request",
    message: options.message,
  }) as ExtensionMessage;
}

function respond(socket: net.Socket, response: BrokerResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sendBrokerRequest(options: {
  socketPath: string;
  token: string;
  operation: BrokerRequest["operation"];
  message?: ServerMessage;
  timeoutMs: number;
}): Promise<BrokerResponse["result"]> {
  const socket = net.createConnection(options.socketPath);
  const request: BrokerRequest = {
    id: crypto.randomUUID(),
    protocolVersion: BROKER_PROTOCOL_VERSION,
    token: options.token,
    operation: options.operation,
    message: options.message,
  };

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Broker request timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    let data = "";

    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => {
      clearTimeout(timeout);
      try {
        const response = JSON.parse(data) as BrokerResponse;
        if (response.ok) {
          resolve(response.result);
        } else {
          reject(new Error(response.error ?? "Unknown broker error"));
        }
      } catch (error) {
        reject(error);
      }
    });
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

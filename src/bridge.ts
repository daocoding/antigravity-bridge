#!/usr/bin/env bun
/**
 * Antigravity CLI Push Bridge
 * 
 * Subscribes to WuKongIM messages and pushes them into the Antigravity CLI
 * via ConnectRPC Dynamic Session Discovery (DSD).
 *
 * Required env:
 *   AGENT_UID              — WK uid this bridge subscribes as (default: "AgyBridge")
 *   WUKONG_API_URL         — WK REST API base (default: http://localhost:5001)
 *   WUKONG_WS_URL          — WK WebSocket URL (default: ws://localhost:5200)
 *   SIDECAR_URL            — WK sidecar for identity lookup (default: http://localhost:5400)
 *   AGENT_TOKEN            — opaque WK token; if absent, provisioned via POST /user/token
 *
 * Platform: Bun (ESM). Uses Bun's built-in WebSocket global.
 */

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { discoverLS, LSClient } from "./ls-client.js";
import { SessionDiscovery } from "./discovery.js";

// ============ Lifecycle log ============
const LIFE_LOG_FILE = process.env.LIFE_LOG_FILE ?? `/tmp/antigravity-bridge-lifecycle.log`;

function life(msg: string): void {
  try {
    appendFileSync(LIFE_LOG_FILE, `${new Date().toISOString()} [pid=${process.pid}] ${msg}\n`);
  } catch { /* best-effort */ }
}

life("BOOT");
process.on("exit", (code) => { life(`EXIT code=${code}`); releaseSingleton(); });
process.on("SIGTERM", () => { life("SIGTERM"); process.exit(0); });
process.on("SIGINT", () => { life("SIGINT"); process.exit(0); });

// ============ Config ============

const AGENT_UID = process.env.AGENT_UID ?? "AgyBridge";
const WK_API = process.env.WUKONG_API_URL ?? "http://localhost:5001";
const WK_WS = process.env.WUKONG_WS_URL ?? "ws://localhost:5200";
const SIDECAR_URL = process.env.SIDECAR_URL ?? "http://localhost:5400";
const ENV_TOKEN = process.env.AGENT_TOKEN ?? "";
const DEVICE_ID = `antigravity-bridge-${AGENT_UID}`;
const STATE_DIR = process.env.STATE_DIR ?? joinPath(homedir(), ".aios-mcp-state");

console.error(`[antigravity-bridge] starting uid=${AGENT_UID}`);

// ============ Singleton guard ============

const PIDFILE = `/tmp/antigravity-bridge-${AGENT_UID}.pid`;

function acquireSingleton(): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(PIDFILE, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o644);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      life(`SINGLETON acquired pidfile=${PIDFILE} pid=${process.pid}`);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      let owner: number;
      try { owner = parseInt(readFileSync(PIDFILE, "utf8").trim(), 10); } catch { owner = NaN; }
      if (!Number.isFinite(owner) || owner === process.pid) {
        try { unlinkSync(PIDFILE); } catch { /* ignore */ }
        continue;
      }
      try {
        process.kill(owner, 0);
        console.error(`[antigravity-bridge] another instance for uid=${AGENT_UID} is already running as pid ${owner}; exiting`);
        life(`SINGLETON blocked by pid=${owner} uid=${AGENT_UID}, exiting`);
        process.exit(0);
      } catch {
        life(`SINGLETON stale pidfile owner=${owner} (not alive), removing`);
        try { unlinkSync(PIDFILE); } catch { /* ignore */ }
        continue;
      }
    }
  }
  throw new Error(`antigravity-bridge: failed to acquire singleton pidfile ${PIDFILE} after 3 attempts`);
}

function releaseSingleton(): void {
  try {
    if (existsSync(PIDFILE)) {
      const owner = readFileSync(PIDFILE, "utf8").trim();
      if (owner === String(process.pid)) unlinkSync(PIDFILE);
    }
  } catch { /* best-effort */ }
}

// ============ State (message dedup) ============

interface BridgeState {
  last_message_seq_by_channel: Record<string, number>;
}

const STATE_FILE = joinPath(STATE_DIR, `${AGENT_UID}-state.json`);
const state: BridgeState = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { last_message_seq_by_channel: {} };

function saveState(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function bumpCapturedSeq(channelKey: string, seq: number): void {
  state.last_message_seq_by_channel[channelKey] = seq;
  saveState();
}

// ============ Token provisioning ============

function genToken(length = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) result += chars[bytes[i] % chars.length];
  return result;
}

async function provisionAgentToken(): Promise<string> {
  if (ENV_TOKEN) return ENV_TOKEN;
  const token = genToken();
  const url = `${WK_API.replace(/\/+$/, "")}/user/token`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: AGENT_UID, token, device_id: DEVICE_ID }),
    });
    if (res.ok) { life(`TOKEN_PROVISIONED`); return token; }
    const text = await res.text();
    life(`TOKEN_PROV_FAIL status=${res.status} body=${text.slice(0, 200)}`);
    console.error(`[antigravity-bridge] token provision failed: ${res.status} ${text.slice(0, 200)}`);
    return token; // best-effort: try with generated token anyway
  } catch (err) {
    life(`TOKEN_PROV_ERR ${(err as Error).message}`);
    return token;
  }
}

// ============ Antigravity bridge logic ============

const discovery = new SessionDiscovery({ agentUid: AGENT_UID, stateDir: STATE_DIR });

let lsClient: LSClient | null = null;

async function getClient(): Promise<LSClient | null> {
  // Re-check DSD on every call — follows the active session across restarts
  discovery.discoverActiveSession();
  if (lsClient) return lsClient;
  const conn = await discoverLS(process.env.WORKSPACE_HINT ?? "");
  if (!conn) return null;
  lsClient = new LSClient(conn.port);
  life(`AGY_CONNECTED port=${conn.port}`);
  return lsClient;
}

async function dispatchToAgy(message: { from_uid: string; channel_id: string; channel_type: number; content: string }): Promise<void> {
  const ls = await getClient();
  if (!ls) {
    life(`DISPATCH_SKIP no_ls_client`);
    return;
  }
  const primaryId = discovery.getPrimaryId();
  let targetId: string;
  if (primaryId) {
    targetId = primaryId;
    life(`ROUTING_TO_PRIMARY id=${targetId}`);
  } else {
    const { cascadeId } = await ls.startCascade();
    targetId = cascadeId;
    life(`ROUTING_TO_NEW_CASCADE id=${targetId}`);
  }
  const prompt = `[aiOS Inbound] From: ${message.from_uid}\n\n${message.content}`;
  await ls.sendMessage(targetId, prompt);
  life(`DISPATCH_OK targetId=${targetId} len=${message.content.length}`);
}

// ============ WK subscription engine ============

interface WkRecvParams {
  messageId: string;
  messageSeq: number;
  timestamp: number;
  fromUid: string;
  channelId: string;
  channelType: number;
  payload: string; // base64
}

class WukongLink {
  private ws: WebSocket | null = null;
  private token = "";
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;
  private pendingId = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private recvChain: Promise<void> = Promise.resolve();
  private outstandingPings: Map<string, number> = new Map();
  private static readonly PONG_TIMEOUT_MS = 60_000;

  async start(): Promise<void> {
    this.token = await provisionAgentToken();
    await this.connect();
  }

  private async connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(WK_WS);
      this.ws = ws;
      ws.onopen = () => {
        life(`WS_OPEN ${WK_WS}`);
        this.reconnectDelayMs = 1000;
        this.outstandingPings.clear();
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "connect",
          id: String(++this.pendingId),
          params: {
            version: 4,
            uid: AGENT_UID,
            token: this.token,
            deviceFlag: 0,
            deviceId: DEVICE_ID,
            clientTimestamp: Date.now(),
          },
        }));
        resolve();
      };
      ws.onerror = (e) => {
        console.error("[antigravity-bridge] ws error:", e);
        life(`WS_ERROR ${String((e as ErrorEvent).message ?? "")}`);
      };
      ws.onmessage = (e) => this.onMessage(e.data as string);
      ws.onclose = () => {
        life(`WS_CLOSE (retry in ${this.reconnectDelayMs}ms)`);
        this.ws = null;
        this.connected = false;
        this.outstandingPings.clear();
        this.stopPingLoop();
        this.scheduleReconnect();
      };
    });
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (!this.ws || !this.connected) return;
      const now = Date.now();
      let oldestStale: number | null = null;
      for (const ts of this.outstandingPings.values()) {
        if (now - ts > WukongLink.PONG_TIMEOUT_MS) {
          if (oldestStale === null || ts < oldestStale) oldestStale = ts;
        }
      }
      if (oldestStale !== null) {
        const ageMs = now - oldestStale;
        life(`WS_ZOMBIE oldest_unpongged_ping_age_ms=${ageMs} — forcing close`);
        try { this.ws.close(); } catch { /* ignore */ }
        return;
      }
      const pingId = `ping-${++this.pendingId}`;
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: pingId }));
        this.outstandingPings.set(pingId, now);
      } catch (err) {
        life(`PING_SEND_FAIL ${String(err)}`);
      }
    }, 90_000);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
  }

  private onMessage(raw: string): void {
    let msg: { method?: string; result?: unknown; error?: unknown; params?: unknown; id?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.method && msg.result !== undefined) {
      this.connected = true;
      life(`CONNACK ${JSON.stringify(msg.result).slice(0, 200)}`);
      this.startPingLoop();
      return;
    }
    if (msg.method === "recv") {
      this.enqueueRecv(msg.params as WkRecvParams);
      return;
    }
    if (msg.method === "ping") {
      this.ws?.send(JSON.stringify({ jsonrpc: "2.0", method: "pong", id: msg.id ?? "" }));
      return;
    }
    if (msg.method === "pong") {
      if (msg.id) this.outstandingPings.delete(msg.id);
      return;
    }
    if (msg.error) {
      console.error("[antigravity-bridge] jsonrpc error:", msg.error);
      life(`JSONRPC_ERROR ${JSON.stringify(msg.error)}`);
    }
  }

  private enqueueRecv(p: WkRecvParams): void {
    const next = this.recvChain.then(() => this.handleRecv(p));
    this.recvChain = next.catch((err) => {
      life(`RECV_HANDLE_ERR ${(err as Error).message}`);
      console.error("[antigravity-bridge] recv handler error:", err);
    });
  }

  private async handleRecv(p: WkRecvParams): Promise<void> {
    const channelKey = `${p.channelType}:${p.channelId}`;
    const prev = state.last_message_seq_by_channel[channelKey] ?? 0;
    if (p.messageSeq <= prev) {
      this.ackRecv(p.messageId, p.messageSeq);
      return;
    }
    // Skip own messages
    if (p.fromUid === AGENT_UID) {
      bumpCapturedSeq(channelKey, p.messageSeq);
      this.ackRecv(p.messageId, p.messageSeq);
      return;
    }

    // Decode base64 payload
    let content = "";
    try {
      const decoded = Buffer.from(p.payload, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      if (typeof parsed === "object" && parsed !== null && "content" in parsed) {
        content = String((parsed as { content: unknown }).content ?? "");
      } else {
        content = decoded;
      }
    } catch {
      try { content = Buffer.from(p.payload, "base64").toString("utf-8"); } catch { content = "[binary]"; }
    }

    life(`RECV from=${p.fromUid} seq=${p.messageSeq} content="${content.slice(0, 80)}"`);

    // Dispatch to Antigravity
    try {
      await dispatchToAgy({
        from_uid: p.fromUid,
        channel_id: p.channelId,
        channel_type: p.channelType,
        content,
      });
    } catch (err) {
      life(`DISPATCH_ERR ${(err as Error).message}`);
      console.error("[antigravity-bridge] dispatch error:", err);
    }

    bumpCapturedSeq(channelKey, p.messageSeq);
    this.ackRecv(p.messageId, p.messageSeq);
  }

  private ackRecv(messageId: string, messageSeq: number): void {
    this.ws?.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "recvack",
      params: { messageId, messageSeq },
    }));
  }
}

// ============ Bootstrap ============

acquireSingleton();

// Start the engine
acquireSingleton();
life("BRIDGE_STARTING");
const link = new WukongLink();
await link.start();
life("BRIDGE_STARTED");
console.error(`[antigravity-bridge] running uid=${AGENT_UID}`);

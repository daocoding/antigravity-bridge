#!/usr/bin/env bun
// Antigravity 2.0 CLI push bridge.
//
// WuKongIM inbound messages wake a live `agy` CLI session by creating/reusing
// background cascades through the CLI's localhost ConnectRPC endpoint.

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { discoverLS, LSClient, life } from "./ls-client.js";

life("BRIDGE_BOOT");
process.on("exit", (code) => {
  life(`BRIDGE_EXIT code=${code}`);
  releaseSingleton();
});
process.on("SIGTERM", () => {
  life("BRIDGE_SIGTERM");
  process.exit(0);
});
process.on("SIGINT", () => {
  life("BRIDGE_SIGINT");
  process.exit(0);
});

const AGENT_UID = process.env.APEX_AGENT_UID ?? process.env.AGENT_UID ?? "AgyBridge";
const WK_API =
  process.env.APEX_WUKONG_API_URL ??
  process.env.WUKONG_API_URL ??
  "http://localhost:5001";
const WK_WS =
  process.env.APEX_WUKONG_WS_URL ??
  process.env.WUKONG_WS_URL ??
  "ws://localhost:5200";
const SIDECAR_URL =
  process.env.APEX_SIDECAR_URL ??
  process.env.SIDECAR_URL ??
  "http://localhost:5400";
const ENV_TOKEN = process.env.APEX_AGENT_TOKEN ?? "";
const PROXY_URL = process.env.WK_PROXY_URL;
const PROXY_TOKEN = process.env.WK_PROXY_TOKEN;
const WORKSPACE_HINT =
  process.env.AGY_WORKSPACE ?? process.env.AIOS_WORKSPACE ?? "";
const WAKE_ON_ALL = process.env.AGY_WAKE_ON_ALL === "1";
const DIRECT_MCP_FALLBACK = process.env.AGY_DIRECT_MCP_FALLBACK !== "0";
const STATE_DIR = joinPath(homedir(), ".aios-mcp-state");
const PIDFILE = `/tmp/antigravity-cli-bridge-${AGENT_UID}.pid`;
const STATE_FILE = joinPath(STATE_DIR, `${AGENT_UID}-antigravity2-state.json`);
const CASCADE_POOL_FILE = joinPath(
  STATE_DIR,
  `${AGENT_UID}-antigravity2-cascades.json`,
);
const WAKE_FILTER_FILE =
  process.env.AGY_WAKE_FILTER_FILE ??
  joinPath(STATE_DIR, `${AGENT_UID}-antigravity2-wake-filter.json`);
const DIRECT_MCP_FILE = joinPath(
  STATE_DIR,
  `${AGENT_UID}-antigravity2-direct-mcp.json`,
);

let AGY_PRIMARY_CASCADE_ID = process.env.AGY_PRIMARY_CASCADE_ID;
const PRIMARY_ID_FILE = joinPath(STATE_DIR, `${AGENT_UID}-current-session.id`);
const DEVICE_ID = `antigravity-cli-bridge-${AGENT_UID}`;

function acquireSingleton(): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(
        PIDFILE,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o644,
      );
      writeSync(fd, String(process.pid));
      closeSync(fd);
      life(`SINGLETON acquired pidfile=${PIDFILE}`);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let owner = NaN;
      try {
        owner = parseInt(readFileSync(PIDFILE, "utf8").trim(), 10);
      } catch {}
      if (Number.isFinite(owner)) {
        try {
          process.kill(owner, 0);
          console.error(
            `[ag-bridge] another bridge for ${AGENT_UID} is already running as pid ${owner}`,
          );
          process.exit(0);
        } catch {}
      }
      try {
        unlinkSync(PIDFILE);
      } catch {}
    }
  }
  throw new Error(`failed to acquire ${PIDFILE}`);
}

function releaseSingleton(): void {
  try {
    const owner = parseInt(readFileSync(PIDFILE, "utf8").trim(), 10);
    if (owner === process.pid) unlinkSync(PIDFILE);
  } catch {}
}

acquireSingleton();

type CapturedState = { last_message_seq_by_channel: Record<string, number> };

function loadJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    life(`JSON_LOAD_FAIL path=${path} err=${String(err)}`);
  }
  return fallback;
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

const captured = loadJson<CapturedState>(STATE_FILE, {
  last_message_seq_by_channel: {},
});
let saveCapturedTimer: ReturnType<typeof setTimeout> | null = null;

function bumpCapturedSeq(channelKey: string, seq: number): void {
  const prev = captured.last_message_seq_by_channel[channelKey] ?? 0;
  if (seq <= prev) return;
  captured.last_message_seq_by_channel[channelKey] = seq;
  if (saveCapturedTimer) clearTimeout(saveCapturedTimer);
  saveCapturedTimer = setTimeout(() => {
    try {
      saveJson(STATE_FILE, captured);
      life(`STATE_SAVE channels=${Object.keys(captured.last_message_seq_by_channel).length}`);
    } catch (err) {
      life(`STATE_SAVE_FAIL ${String(err)}`);
    }
  }, 500);
}

type CascadePool = Record<string, string>;
const cascadePool = loadJson<CascadePool>(CASCADE_POOL_FILE, {});

type DirectMcpState = { sent_call_keys: Record<string, number> };
const directMcpState = loadJson<DirectMcpState>(DIRECT_MCP_FILE, {
  sent_call_keys: {},
});

function saveCascadePool(): void {
  try {
    saveJson(CASCADE_POOL_FILE, cascadePool);
  } catch (err) {
    life(`CASCADE_POOL_SAVE_FAIL ${String(err)}`);
  }
}

function saveDirectMcpState(): void {
  try {
    saveJson(DIRECT_MCP_FILE, directMcpState);
  } catch (err) {
    life(`DIRECT_MCP_STATE_SAVE_FAIL ${String(err)}`);
  }
}

let lsClient: LSClient | null = null;
let lsLastDiscovery = 0;

function resolvePrimaryCascadeId(): string {
  try {
    let id = "";
    
    // 1. Try to find the most recently modified session folder inside the Antigravity brain directory
    const brainDir = joinPath(homedir(), ".gemini", "antigravity-cli", "brain");
    if (existsSync(brainDir)) {
      const dirs = readdirSync(brainDir)
        .filter((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name))
        .map((name) => {
          const p = joinPath(brainDir, name);
          return { name, mtime: statSync(p).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      
      if (dirs.length > 0 && dirs[0]) {
        id = dirs[0].name;
      }
    }

    // 2. If no folder is found, or if we failed to list the brain directory, fall back to the state file
    if (!id && existsSync(PRIMARY_ID_FILE)) {
      id = readFileSync(PRIMARY_ID_FILE, "utf8").trim();
    }

    // 3. If we discovered/resolved a valid ID and it's different, write it to PRIMARY_ID_FILE and update the memory variable
    if (id) {
      if (id !== AGY_PRIMARY_CASCADE_ID) {
        AGY_PRIMARY_CASCADE_ID = id;
        life(`PRIMARY_CASCADE_UPDATED id=${id}`);
      }
      
      // Keep state file synchronized with our discovery
      try {
        let storedId = "";
        if (existsSync(PRIMARY_ID_FILE)) {
          storedId = readFileSync(PRIMARY_ID_FILE, "utf8").trim();
        }
        if (storedId !== id) {
          writeFileSync(PRIMARY_ID_FILE, id);
          life(`PRIMARY_ID_FILE updated with id=${id}`);
        }
      } catch (err) {
        life(`PRIMARY_ID_FILE_WRITE_FAIL ${String(err)}`);
      }
    }
    return id;
  } catch (err) {
    life(`PRIMARY_CASCADE_DISCOVERY_FAIL ${String(err)}`);
    return AGY_PRIMARY_CASCADE_ID ?? "";
  }
}

async function getLSClient(): Promise<LSClient | null> {
  if (lsClient && Date.now() - lsLastDiscovery < 60_000) return lsClient;
  const conn = await discoverLS(WORKSPACE_HINT);
  if (!conn) {
    life("AGY_UNAVAILABLE no live agy ConnectRPC port found");
    lsClient = null;
    return null;
  }
  lsClient = new LSClient(conn.port);
  lsLastDiscovery = Date.now();
  life(`AGY_CONNECTED port=${conn.port} pid=${conn.pid} workspace=${conn.workspaceId}`);

  resolvePrimaryCascadeId();

  return lsClient;
}

async function getWarmCascade(
  ls: LSClient,
  channelKey: string,
): Promise<{ cascadeId: string; isWarm: boolean }> {
  const existing = cascadePool[channelKey];
  if (existing) {
    try {
      if (AGY_PRIMARY_CASCADE_ID && existing === AGY_PRIMARY_CASCADE_ID) {
        // If it's the primary/terminal session, keep trying for a while or return it even if busy.
        // The agy CLI will queue the message if it's currently running.
        return { cascadeId: existing, isWarm: true };
      }
      const status = await ls.getStatus(existing);
      if (status.status === "CASCADE_RUN_STATUS_IDLE") {
        return { cascadeId: existing, isWarm: true };
      }
      if (status.status === "CASCADE_RUN_STATUS_RUNNING") {
        await new Promise((r) => setTimeout(r, 5000));
        const retry = await ls.getStatus(existing);
        if (retry.status === "CASCADE_RUN_STATUS_IDLE") {
          return { cascadeId: existing, isWarm: true };
        }
      }
    } catch (err) {
      life(`CASCADE_STALE key=${channelKey} id=${existing} err=${String(err)}`);
    }
    if (!AGY_PRIMARY_CASCADE_ID || existing !== AGY_PRIMARY_CASCADE_ID) {
      delete cascadePool[channelKey];
    }
  }

  const { cascadeId } = await ls.startCascade();
  cascadePool[channelKey] = cascadeId;
  saveCascadePool();
  life(`CASCADE_NEW key=${channelKey} id=${cascadeId}`);
  return { cascadeId, isWarm: false };
}

function genToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

async function provisionAgentToken(): Promise<string> {
  if (ENV_TOKEN) return ENV_TOKEN;
  const token = genToken();
  const res = await fetch(`${WK_API}/user/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uid: AGENT_UID,
      token,
      device_flag: 0,
      device_level: 1,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`wk /user/token failed: ${res.status} ${body}`);
  }
  return token;
}

async function syncRecentMessages(
  channelId: string,
  channelType: number,
  limit = 25,
): Promise<SyncedWkMessage[]> {
  const res = await fetch(`${WK_API}/channel/messagesync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      login_uid: AGENT_UID,
      channel_id: channelId,
      channel_type: channelType,
      start_message_seq: 0,
      end_message_seq: 0,
      limit,
      pull_mode: 1,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`messagesync failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { messages?: SyncedWkMessage[] };
  return data.messages ?? [];
}

type WkRecvParams = {
  messageId: string;
  messageSeq: number;
  timestamp: number;
  fromUid: string;
  channelId: string;
  channelType: number;
  payload: string;
};

type ReceivedMessage = {
  from_uid: string;
  channel_id: string;
  channel_type: number;
  message_id: string;
  message_seq: number;
  ts: number;
  content: string;
  payload_kind: string;
};

type SyncedWkMessage = {
  from_uid: string;
  channel_id?: string;
  channel_type?: number;
  message_id?: string | number;
  message_seq: number;
  timestamp: number;
  payload: string;
};

type WakeFilterConfig = {
  wake_on_all?: boolean;
  dm_wakes?: boolean;
  require_mention?: boolean;
  mentions?: string[];
  contains?: string[];
  regex?: string[];
  ignored_from_uids?: string[];
  ignored_payload_kinds?: string[];
};

type WakeFilter = Required<WakeFilterConfig>;

const DEFAULT_WAKE_FILTER: WakeFilter = {
  wake_on_all: true,
  dm_wakes: true,
  require_mention: false,
  mentions: [AGENT_UID],
  contains: [],
  regex: [],
  ignored_from_uids: [AGENT_UID],
  ignored_payload_kinds: [],
};

let wakeFilterCache: {
  mtimeMs: number;
  filter: WakeFilter;
} | null = null;

function ensureWakeFilterFile(): void {
  if (existsSync(WAKE_FILTER_FILE)) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      WAKE_FILTER_FILE,
      JSON.stringify(DEFAULT_WAKE_FILTER, null, 2),
    );
    life(`WAKE_FILTER_CREATED path=${WAKE_FILTER_FILE}`);
  } catch (err) {
    life(`WAKE_FILTER_CREATE_FAIL ${String(err)}`);
  }
}

function loadWakeFilter(): WakeFilter {
  ensureWakeFilterFile();
  try {
    const stat = Bun.file(WAKE_FILTER_FILE);
    const mtimeMs = stat.lastModified;
    if (wakeFilterCache && wakeFilterCache.mtimeMs === mtimeMs) {
      return wakeFilterCache.filter;
    }
    const parsed = JSON.parse(readFileSync(WAKE_FILTER_FILE, "utf8")) as WakeFilterConfig;
    const filter: WakeFilter = {
      ...DEFAULT_WAKE_FILTER,
      ...parsed,
      mentions: Array.isArray(parsed.mentions)
        ? parsed.mentions
        : DEFAULT_WAKE_FILTER.mentions,
      contains: Array.isArray(parsed.contains) ? parsed.contains : [],
      regex: Array.isArray(parsed.regex) ? parsed.regex : [],
      ignored_from_uids: Array.isArray(parsed.ignored_from_uids)
        ? parsed.ignored_from_uids
        : DEFAULT_WAKE_FILTER.ignored_from_uids,
      ignored_payload_kinds: Array.isArray(parsed.ignored_payload_kinds)
        ? parsed.ignored_payload_kinds
        : [],
    };
    wakeFilterCache = { mtimeMs, filter };
    life(`WAKE_FILTER_LOADED path=${WAKE_FILTER_FILE}`);
    return filter;
  } catch (err) {
    life(`WAKE_FILTER_LOAD_FAIL ${String(err)}`);
    return wakeFilterCache?.filter ?? DEFAULT_WAKE_FILTER;
  }
}

function decodePayload(payload: string): { content: string; kind: string } {
  try {
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if ("content" in obj) {
        return {
          content: String(obj.content ?? ""),
          kind: String(obj.kind ?? "user_message"),
        };
      }
    }
    return { content: decoded, kind: "raw" };
  } catch {
    try {
      return {
        content: Buffer.from(payload, "base64").toString("utf-8"),
        kind: "raw",
      };
    } catch {
      return { content: "[binary]", kind: "binary" };
    }
  }
}

function shouldWake(message: ReceivedMessage): boolean {
  const filter = loadWakeFilter();
  const fromUid = message.from_uid.toLowerCase();
  if (filter.ignored_from_uids.some((uid) => uid.toLowerCase() === fromUid)) {
    return false;
  }
  if (filter.ignored_payload_kinds.includes(message.payload_kind)) {
    return false;
  }
  if (message.channel_type === 1 && filter.dm_wakes) return true;
  if (filter.wake_on_all) return true;

  const lower = normalizeForWake(message.content);
  for (const mention of filter.mentions) {
    const normalized = normalizeForWake(mention);
    if (lower.includes(`@${normalized}`)) return true;
    if (!filter.require_mention && lower.includes(normalized)) return true;
  }
  for (const term of filter.contains) {
    if (lower.includes(normalizeForWake(term))) return true;
  }
  for (const pattern of filter.regex) {
    try {
      if (new RegExp(pattern, "iu").test(message.content)) return true;
    } catch (err) {
      life(`WAKE_FILTER_BAD_REGEX pattern=${pattern} err=${String(err)}`);
    }
  }
  return false;
}

function normalizeForWake(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function replyTarget(message: ReceivedMessage): { toUid: string; channelType: number } {
  if (message.channel_type === 1) {
    return { toUid: message.from_uid, channelType: 1 };
  }
  return { toUid: message.channel_id, channelType: message.channel_type };
}

function encodePayload(content: string): string {
  return Buffer.from(
    JSON.stringify({
      type: 1,
      v: 1,
      kind: "agent_message",
      agent: AGENT_UID,
      content,
    }),
    "utf-8",
  ).toString("base64");
}

async function sendWkMessageDirect(
  toUid: string,
  channelType: number,
  content: string,
): Promise<void> {
  const payloadB64 = encodePayload(content);
  const useProxy = Boolean(PROXY_URL && PROXY_TOKEN);
  let res: Response;
  if (useProxy) {
    res = await fetch(PROXY_URL!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PROXY_TOKEN}`,
        "User-Agent": `antigravity-cli-bridge/${AGENT_UID}`,
      },
      body: JSON.stringify({
        destination_id: toUid,
        destination_type: channelType === 1 ? "person" : "group",
        payload_b64: payloadB64,
      }),
    });
  } else {
    res = await fetch(`${WK_API}/message/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_uid: AGENT_UID,
        channel_id: toUid,
        channel_type: channelType,
        payload: payloadB64,
        red_dot: 1,
        header: { red_dot: 1, no_persist: 0, sync_once: 0 },
      }),
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`direct send failed: ${res.status} ${body}`);
  }
  life(
    `DIRECT_MCP_SENT channel=${channelType}:${toUid} via=${useProxy ? "proxy" : "kernel"} len=${content.length}`,
  );
}

type WaitingMcpSend = {
  callKey: string;
  toUid: string;
  channelType: number;
  content: string;
};

function parseJsonRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return null;
}

function findWaitingMcpSend(
  cascadeId: string,
  steps: Array<Record<string, any>>,
): WaitingMcpSend | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.type !== "CORTEX_STEP_TYPE_MCP_TOOL") continue;
    if (step.status !== "CORTEX_STEP_STATUS_WAITING") continue;
    const mcpTool = step.mcpTool;
    if (mcpTool?.serverName !== "Gödel-Antigravity-aios-mcp") continue;
    if (mcpTool?.toolCall?.name !== "wk_send_message") continue;

    const args = parseJsonRecord(mcpTool.toolCall.argumentsJson);
    if (!args) continue;
    const toUid = String(args.to_uid ?? "").trim();
    const channelType = Number(args.channel_type ?? 2);
    const content = String(args.content ?? args.message ?? "");
    if (!toUid || !content) continue;

    const sourceInfo = step.metadata?.sourceTrajectoryStepInfo;
    const executionId = step.metadata?.executionId;
    const stepIndex = sourceInfo?.stepIndex ?? i;
    const trajectoryId = sourceInfo?.trajectoryId ?? "unknown";
    const callKey = String(executionId ?? `${cascadeId}:${trajectoryId}:${stepIndex}`);
    return { callKey, toUid, channelType, content };
  }
  return null;
}

function hasWaitingEmptyMcpLookup(steps: Array<Record<string, any>>): boolean {
  return steps.some((step) => {
    if (step.type !== "CORTEX_STEP_TYPE_MCP_TOOL") return false;
    if (step.status !== "CORTEX_STEP_STATUS_WAITING") return false;
    if (step.mcpTool?.serverName !== "Gödel-Antigravity-aios-mcp") return false;
    if (step.mcpTool?.toolCall?.name !== "wk_send_message") return false;
    const args = parseJsonRecord(step.mcpTool.toolCall.argumentsJson);
    if (!args || Object.keys(args).length > 0) return false;
    const toolSummary = String(step.metadata?.toolSummary ?? "");
    const toolAction = String(step.metadata?.toolAction ?? "");
    return /schema/i.test(`${toolSummary} ${toolAction}`);
  });
}

async function monitorCascadeForDirectMcp(
  ls: LSClient,
  cascadeId: string,
  channelKey: string,
  messageSeq: number,
): Promise<void> {
  if (!DIRECT_MCP_FALLBACK) return;
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const trajectory = await ls.getTrajectory(cascadeId);
    const waitingSend = findWaitingMcpSend(
      cascadeId,
      trajectory.steps as Array<Record<string, any>>,
    );
    if (waitingSend) {
      if (!directMcpState.sent_call_keys[waitingSend.callKey]) {
        await sendWkMessageDirect(
          waitingSend.toUid,
          waitingSend.channelType,
          waitingSend.content,
        );
        directMcpState.sent_call_keys[waitingSend.callKey] = Date.now();
        saveDirectMcpState();
        life(
          `DIRECT_MCP_FALLBACK cascade=${cascadeId} channel=${channelKey} seq=${messageSeq} call=${waitingSend.callKey}`,
        );
      }
      try {
        await ls.resolveOutstandingSteps(cascadeId);
        life(`CASCADE_RESOLVED_AFTER_DIRECT cascade=${cascadeId}`);
      } catch (err) {
        life(`CASCADE_RESOLVE_AFTER_DIRECT_FAIL cascade=${cascadeId} ${String(err)}`);
      }
      if (cascadePool[channelKey] === cascadeId) {
        delete cascadePool[channelKey];
        saveCascadePool();
      }
      return;
    }
    if (hasWaitingEmptyMcpLookup(trajectory.steps as Array<Record<string, any>>)) {
      try {
        await ls.resolveOutstandingSteps(cascadeId);
      } catch (err) {
        life(`CASCADE_EMPTY_SCHEMA_RESOLVE_FAIL cascade=${cascadeId} ${String(err)}`);
      }
      if (cascadePool[channelKey] === cascadeId) {
        delete cascadePool[channelKey];
        saveCascadePool();
      }
      life(`CASCADE_EMPTY_SCHEMA_STALL cascade=${cascadeId} channel=${channelKey} seq=${messageSeq}`);
      return;
    }
    if (trajectory.status === "CASCADE_RUN_STATUS_IDLE") return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  life(`DIRECT_MCP_MONITOR_TIMEOUT cascade=${cascadeId} channel=${channelKey} seq=${messageSeq}`);
}

function buildPrompt(message: ReceivedMessage, isWarm: boolean): string {
  const target = replyTarget(message);
  return [
    `[aiOS/WuKong wake -> Antigravity 2.0 CLI]`,
    `Agent: ${AGENT_UID}`,
    `Mode: ${isWarm ? "warm cascade follow-up" : "new cascade"}`,
    `From: ${message.from_uid}`,
    `Channel: ${message.channel_type}:${message.channel_id}`,
    `Message seq: ${message.message_seq}`,
    `Timestamp: ${new Date(message.ts * 1000).toISOString()}`,
    "",
    "Inbound message:",
    message.content,
    "",
    "Reply contract:",
    `- If a reply is appropriate, call wk_send_message exactly once with: {"to_uid":"${target.toUid}","channel_type":${target.channelType},"content":"<your reply>"}.`,
    "- Do not call wk_send_message with empty arguments and do not use it to inspect the schema.",
    "- The required argument name is content, not message.",
    "- Your visible chat transcript is not delivered to aiOS; only wk_send_message reaches the room/person.",
    "- Keep the reply concise unless the sender asks for detail.",
    "- Do not edit files or run shell commands unless the inbound message explicitly asks for development work.",
  ].join("\n");
}

async function handleWake(message: ReceivedMessage): Promise<void> {
  const ls = await getLSClient();
  if (!ls) return;

  const channelKey = `${message.channel_type}:${message.channel_id}`;
  
  // Resolve current active session dynamically
  resolvePrimaryCascadeId();

  // GLOBAL PUSH: Always use primary session if available
  let cascadeId: string;
  let isWarm: boolean;
  
  if (AGY_PRIMARY_CASCADE_ID) {
    cascadeId = AGY_PRIMARY_CASCADE_ID;
    isWarm = true;
  } else {
    const res = await getWarmCascade(ls, channelKey);
    cascadeId = res.cascadeId;
    isWarm = res.isWarm;
  }

  const prompt = buildPrompt(message, isWarm);
  await ls.sendMessage(cascadeId, prompt);
  life(
    `WAKE_INJECTED cascade=${cascadeId} warm=${isWarm} channel=${channelKey} seq=${message.message_seq} mode=${AGY_PRIMARY_CASCADE_ID ? "GLOBAL" : "ROOM"}`
  );
  void monitorCascadeForDirectMcp(ls, cascadeId, channelKey, message.message_seq).catch((err) => {
    life(`DIRECT_MCP_MONITOR_FAIL cascade=${cascadeId} ${String(err)}`);
  });
}

async function processReceivedMessage(
  message: ReceivedMessage,
  channelKey: string,
  source: "recv" | "catchup",
): Promise<void> {
  life(
    `${source === "catchup" ? "CATCHUP_RECV" : "RECV"} from=${message.from_uid} channel=${channelKey} seq=${message.message_seq} content="${message.content.slice(0, 100)}"`,
  );

  if (shouldWake(message)) {
    try {
      await handleWake(message);
    } catch (err) {
      life(`WAKE_FAIL ${String(err)}`);
    }
  } else {
    life(`WAKE_SKIP channel=${channelKey} seq=${message.message_seq}`);
  }
}

async function catchUpCapturedChannels(): Promise<void> {
  const channelKeys = Object.keys(captured.last_message_seq_by_channel);
  for (const channelKey of channelKeys) {
    const [channelTypeRaw, channelId] = channelKey.split(":", 2);
    const channelType = Number(channelTypeRaw);
    const prev = captured.last_message_seq_by_channel[channelKey] ?? 0;
    if (!channelId || !Number.isFinite(channelType)) continue;
    try {
      const messages = (await syncRecentMessages(channelId, channelType, 25))
        .filter((m) => m.message_seq > prev)
        .sort((a, b) => a.message_seq - b.message_seq);
      for (const raw of messages) {
        const decoded = decodePayload(raw.payload);
        const message: ReceivedMessage = {
          from_uid: raw.from_uid,
          channel_id: channelId,
          channel_type: channelType,
          message_id: String(raw.message_id ?? ""),
          message_seq: raw.message_seq,
          ts: raw.timestamp,
          content: decoded.content,
          payload_kind: decoded.kind,
        };
        await processReceivedMessage(message, channelKey, "catchup");
        bumpCapturedSeq(channelKey, raw.message_seq);
      }
    } catch (err) {
      life(`CATCHUP_FAIL channel=${channelKey} ${String(err)}`);
    }
  }
}

class WukongLink {
  private ws: WebSocket | null = null;
  private token = "";
  private pendingId = 0;
  private connected = false;
  private reconnectDelayMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

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
        ws.send(
          JSON.stringify({
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
          }),
        );
        resolve();
      };
      ws.onerror = (event) => {
        life(`WS_ERROR ${String((event as ErrorEvent).message ?? "")}`);
      };
      ws.onmessage = (event) => this.onMessage(String(event.data));
      ws.onclose = () => {
        life(`WS_CLOSE retry_ms=${this.reconnectDelayMs}`);
        this.ws = null;
        this.connected = false;
        this.scheduleReconnect();
      };
    });
  }

  private onMessage(raw: string): void {
    let msg: {
      method?: string;
      result?: unknown;
      error?: unknown;
      params?: unknown;
      id?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg.method && msg.result !== undefined) {
      this.connected = true;
      life(`CONNACK ${JSON.stringify(msg.result).slice(0, 200)}`);
      this.startKeepAliveLoop();
      return;
    }
    if (msg.method === "recv") {
      void this.handleRecv(msg.params as WkRecvParams);
      return;
    }
    if (msg.method === "ping") {
      this.ws?.send(
        JSON.stringify({ jsonrpc: "2.0", method: "pong", id: msg.id ?? "" }),
      );
      return;
    }
    if (msg.method === "pong") return;
    if (msg.error) life(`JSONRPC_ERROR ${JSON.stringify(msg.error)}`);
  }

  private async handleRecv(p: WkRecvParams): Promise<void> {
    const channelKey = `${p.channelType}:${p.channelId}`;
    const prev = captured.last_message_seq_by_channel[channelKey] ?? 0;
    if (p.messageSeq <= prev) {
      this.ackRecv(p.messageId, p.messageSeq);
      return;
    }

    const decoded = decodePayload(p.payload);
    const message: ReceivedMessage = {
      from_uid: p.fromUid,
      channel_id: p.channelId,
      channel_type: p.channelType,
      message_id: p.messageId,
      message_seq: p.messageSeq,
      ts: p.timestamp,
      content: decoded.content,
      payload_kind: decoded.kind,
    };

    await processReceivedMessage(message, channelKey, "recv");

    bumpCapturedSeq(channelKey, p.messageSeq);
    this.ackRecv(p.messageId, p.messageSeq);
  }

  private ackRecv(messageId: string, messageSeq: number): void {
    this.ws?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "recvack",
        params: { messageId, messageSeq },
      }),
    );
  }

  private startKeepAliveLoop(): void {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => {
      if (!this.ws || !this.connected) return;
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "ping",
          id: `ping-${++this.pendingId}`,
        }),
      );
    }, 60_000);
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
}

async function subscribeDefaultRooms(): Promise<void> {
  const rooms = (process.env.AGY_SUBSCRIBE_ROOMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const room of rooms) {
    try {
      const res = await fetch(
        `${SIDECAR_URL}/api/rooms/${encodeURIComponent(room)}/subscribe?agent=${encodeURIComponent(AGENT_UID)}`,
        { method: "POST", headers: { "User-Agent": `antigravity-cli-bridge/${AGENT_UID}` } },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        life(`SUBSCRIBE_FAIL room=${room} status=${res.status} ${body}`);
      } else {
        life(`SUBSCRIBED room=${room}`);
      }
    } catch (err) {
      life(`SUBSCRIBE_FAIL room=${room} err=${String(err)}`);
    }
  }
}

async function main(): Promise<void> {
  life(
    `CONFIG agent=${AGENT_UID} wk_api=${WK_API} wk_ws=${WK_WS} workspace_hint=${WORKSPACE_HINT || "(any)"} wake_filter=${WAKE_FILTER_FILE}`,
  );
  loadWakeFilter();
  await getLSClient();
  await subscribeDefaultRooms();
  await catchUpCapturedChannels();
  await new WukongLink().start();
  life("BRIDGE_READY");
}

main().catch((err) => {
  appendFileSync(
    "/tmp/aios-antigravity-bridge.log",
    `${new Date().toISOString()} [pid=${process.pid}] FATAL ${err.stack ?? err}\n`,
  );
  process.exit(1);
});

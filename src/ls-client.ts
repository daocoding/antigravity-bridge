/**
 * Antigravity 2.0 CLI Client — Discovery + ConnectRPC.
 *
 * Discovers the live `agy` process for a workspace, finds its localhost HTTP
 * ConnectRPC port, then provides typed cascade methods.
 *
 * @module ls-client
 */

import { execSync } from "node:child_process";

// ============ Lifecycle log (shared with bridge) ============

const LIFE_LOG = process.env.LIFE_LOG_FILE ?? "/tmp/antigravity-bridge-discovery.log";
export function life(msg: string): void {
  try {
    const { appendFileSync } = require("node:fs");
    appendFileSync(
      LIFE_LOG,
      `${new Date().toISOString()} [pid=${process.pid}] ${msg}\n`,
    );
  } catch {}
}

// ============ Types ============

export interface LSConnection {
  port: number;
  pid: number;
  workspaceId: string;
}

export interface CascadeResult {
  cascadeId: string;
}

export interface TrajectoryStatus {
  status: string;
  numTotalSteps: number;
}

export interface TrajectoryStep {
  type: string;
  plannerResponse?: {
    rawText?: string;
    text?: string;
    thinking?: string;
    toolCalls?: Array<{ toolName?: string; [k: string]: unknown }>;
    stopReason?: string;
    messageId?: string;
    [k: string]: unknown;
  };
  userInput?: {
    userResponse?: string;
    items?: Array<{ text: string }>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// ============ Discovery ============

/**
 * Discover the Antigravity 2.0 CLI backend for a workspace.
 */
export async function discoverLS(
  workspaceHint?: string,
): Promise<LSConnection | null> {
  try {
    const psOutput = execSync(
      "ps -eo pid,comm,args 2>/dev/null | grep -E '(^|/| )agy( |$)' | grep -v grep",
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    if (!psOutput) return null;

    const candidates: Array<{ pid: number; cwd: string }> = [];
    for (const line of psOutput.split("\n")) {
      const pid = parseInt(line.trim().split(/\s+/)[0]!, 10);
      if (!Number.isFinite(pid)) continue;
      const cwd = readProcessCwd(pid);
      if (workspaceHint && cwd && !cwd.includes(workspaceHint)) {
        continue;
      }
      candidates.push({ pid, cwd });
    }
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
      const ports = listListeningPorts(candidate.pid);
      life(`AGY_PORTS pid=${candidate.pid} cwd=${candidate.cwd} ports=${ports.join(",")}`);
      for (const port of ports) {
        const ok = await probePort(port);
        if (ok) {
          life(`AGY_READY port=${port} pid=${candidate.pid} cwd=${candidate.cwd}`);
          return {
            port,
            pid: candidate.pid,
            workspaceId: candidate.cwd,
          };
        }
      }
    }
  } catch (err) {
    life(`AGY_DISCOVER_FAIL ${String(err)}`);
  }
  return null;
}

function readProcessCwd(pid: number): string {
  try {
    const out = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, {
      encoding: "utf8",
      timeout: 3000,
    });
    const match = out.match(/^n(.+)$/m);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

function listListeningPorts(pid: number): number[] {
  try {
    const lsofOutput = execSync(
      `lsof -nP -a -p ${pid} -iTCP -sTCP:LISTEN 2>/dev/null`,
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    const ports: number[] = [];
    for (const line of lsofOutput.split("\n")) {
      const m = line.match(/127\.0\.0\.1:(\d+)/);
      if (!m) continue;
      const port = parseInt(m[1]!, 10);
      if (Number.isFinite(port) && !ports.includes(port)) ports.push(port);
    }
    return ports;
  } catch {
    return [];
  }
}

function probePort(port: number): Promise<boolean> {
  const http = require("node:http");
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": 2,
        },
        timeout: 2000,
      },
      (res: { statusCode?: number }) => {
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.write("{}");
    req.end();
  });
}

// ============ RPC Client ============

export class LSClient {
  constructor(private readonly port: number) {}

  /**
   * Create a new cascade (background conversation).
   */
  async startCascade(): Promise<CascadeResult> {
    const source = Number(process.env.AGY_CASCADE_SOURCE ?? "1");
    const resp = await this.rpc("StartCascade", { source });
    return { cascadeId: resp.cascadeId };
  }

  async getDefaultModel(): Promise<string> {
    const explicit = process.env.AGY_MODEL;
    if (explicit) return explicit;

    const status = await this.rpc("GetUserStatus", {});
    const model =
      status.userStatus?.cascadeModelConfigData?.defaultOverrideModelConfig
        ?.modelOrAlias?.model;
    if (typeof model === "string" && model.length > 0) return model;

    return "MODEL_PLACEHOLDER_M84";
  }

  /**
   * Send a message to a cascade, triggering an AI turn.
   *
   * IMPORTANT: cascadeConfig with plannerConfig is required to trigger
   * the AI to actually respond. Without it, the message lands in the
   * trajectory but no planner response is generated.
   */
  async sendMessage(
    cascadeId: string,
    text: string,
    model?: string,
  ): Promise<void> {
    const selectedModel = model ?? await this.getDefaultModel();
    await this.rpc("SendUserCascadeMessage", {
      cascadeId,
      items: [{ text }],
      cascadeConfig: {
        plannerConfig: {
          requestedModel: { model: selectedModel },
          conversational: {},
        },
      },
    });
  }

  /**
   * Get the trajectory status (step count, running/idle).
   */
  async getStatus(cascadeId: string): Promise<TrajectoryStatus> {
    const resp = await this.rpc("GetCascadeTrajectory", { cascadeId });
    return {
      status: resp.status ?? "unknown",
      numTotalSteps: resp.numTotalSteps ?? 0,
    };
  }

  /**
   * Get the full trajectory with all steps.
   */
  async getTrajectory(
    cascadeId: string,
  ): Promise<{ status: string; steps: TrajectoryStep[] }> {
    const resp = await this.rpc("GetCascadeTrajectory", { cascadeId });
    return {
      status: resp.status ?? "unknown",
      steps: resp.trajectory?.steps ?? [],
    };
  }

  async resolveOutstandingSteps(cascadeId: string): Promise<void> {
    await this.rpc("ResolveOutstandingSteps", { cascadeId });
  }

  /**
   * Wait for a cascade to finish (poll-based).
   * Returns the final status and step count.
   */
  async waitForCompletion(
    cascadeId: string,
    timeoutMs: number = 120_000,
    pollIntervalMs: number = 3000,
  ): Promise<TrajectoryStatus> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.getStatus(cascadeId);
      if (status.status === "CASCADE_RUN_STATUS_IDLE") {
        return status;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return this.getStatus(cascadeId);
  }

  /**
   * Extract the agent's final text response from a completed trajectory.
   * Scans planner responses from the end, looking for text content.
   */
  async extractResponse(cascadeId: string): Promise<string | null> {
    const { steps } = await this.getTrajectory(cascadeId);
    // Walk backwards to find the last planner response with text
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]!;
      if (step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
        const pr = step.plannerResponse;
        if (!pr) continue;
        if (typeof pr.response === "string") return pr.response;
        if (typeof pr.modifiedResponse === "string") return pr.modifiedResponse;
        // Check for text content (rawText, text, or in tool calls)
        if (pr.rawText) return pr.rawText;
        if (pr.text) return pr.text;
        // Check for a "finish" tool call that might contain the summary
        if (pr.toolCalls) {
          for (const tc of pr.toolCalls) {
            if (tc.toolName === "finish" || tc.toolName === "notifyUser") {
              // The finish/notifyUser tool often contains the response text
              const args = tc.arguments ?? tc.args;
              if (typeof args === "string") return args;
              if (args && typeof args === "object") {
                return (args as Record<string, unknown>).text as string ??
                  (args as Record<string, unknown>).message as string ??
                  (args as Record<string, unknown>).summary as string ??
                  null;
              }
            }
          }
        }
      }
    }
    return null;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private rpc(method: string, payload: unknown): Promise<Record<string, any>> {
    const http = require("node:http");
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: `/exa.language_server_pb.LanguageServerService/${method}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 30_000,
        },
        (res: { statusCode?: number; on: Function }) => {
          let data = "";
          res.on("data", (chunk: string) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve({});
              }
            } else {
              reject(
                new Error(
                  `LS ${method}: ${res.statusCode} — ${data.substring(0, 200)}`,
                ),
              );
            }
          });
        },
      );
      req.on("error", (err: Error) => reject(err));
      req.write(body);
      req.end();
    });
  }
}

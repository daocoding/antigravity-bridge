import { existsSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { homedir } from "node:os";

/**
 * Advanced Session Management: Dynamic Session Discovery (DSD)
 * 
 * Allows a foreground CLI session (like Antigravity) to 'announce' its active 
 * session ID to a shared state file. The bridge monitors this file and 
 * automatically routes all inbound messages to the active foreground session 
 * instead of spawning background cascades.
 */

export interface DiscoveryConfig {
  agentUid: string;
  stateDir?: string;
  primaryIdFile?: string;
}

export class SessionDiscovery {
  private primaryIdFile: string;
  private currentPrimaryId: string | undefined;

  constructor(config: DiscoveryConfig) {
    const stateDir = config.stateDir ?? joinPath(homedir(), ".aios-mcp-state");
    this.primaryIdFile = config.primaryIdFile ?? joinPath(stateDir, `${config.agentUid}-current-session.id`);
    this.currentPrimaryId = process.env.AGY_PRIMARY_CASCADE_ID;
  }

  /**
   * Discovers the currently active session ID from the announcement file.
   */
  public discoverActiveSession(): string | undefined {
    try {
      if (existsSync(this.primaryIdFile)) {
        const id = readFileSync(this.primaryIdFile, "utf8").trim();
        if (id && id !== this.currentPrimaryId) {
          this.currentPrimaryId = id;
          return id;
        }
      }
    } catch (err) {
      // Silent fail for discovery
    }
    return this.currentPrimaryId;
  }

  public getPrimaryId(): string | undefined {
    return this.currentPrimaryId;
  }
}

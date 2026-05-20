import { Bot } from "grammy";
import { LSClient, discoverLS, life } from "../../src/ls-client.js";
import { SessionDiscovery } from "../../src/discovery.js";
import { join as joinPath } from "node:path";
import { homedir } from "node:os";

/**
 * Antigravity Telegram Sample Bridge
 * 
 * Demonstrates how to bridge Telegram messages into Antigravity 
 * using the Dynamic Session Discovery (DSD) pattern.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AGENT_UID = process.env.AGENT_UID ?? "TelegramBridge";
const STATE_DIR = process.env.STATE_DIR ?? joinPath(homedir(), ".aios-mcp-state");

if (!BOT_TOKEN) {
  console.error("Please set TELEGRAM_BOT_TOKEN environment variable");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const discovery = new SessionDiscovery({ agentUid: AGENT_UID, stateDir: STATE_DIR });

let lsClient: LSClient | null = null;

async function getClient() {
  discovery.discoverActiveSession();
  if (lsClient) return lsClient;
  const conn = await discoverLS("");
  if (!conn) return null;
  lsClient = new LSClient(conn.port);
  return lsClient;
}

bot.on("message", async (ctx) => {
  const text = ctx.message.text || ctx.message.caption || "";
  const chatId = ctx.chat.id;
  const from = ctx.from?.first_name || "Unknown";

  life(`INBOUND_TELEGRAM chat=${chatId} from=${from}`);

  const ls = await getClient();
  if (!ls) {
    await ctx.reply("Antigravity is currently unavailable.");
    return;
  }

  // Routing Logic: Use primary session if discovered, else start new cascade
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

  const prompt = `[Telegram | ${from}] ${text}`;
  await ls.sendMessage(targetId, prompt);
  
  // Note: For a production bridge, you would implement an MCP tool 
  // in Antigravity to send the reply back to the Telegram chat.
  await ctx.reply("Message received by Antigravity.");
});

console.log("Telegram bridge starting...");
bot.start();

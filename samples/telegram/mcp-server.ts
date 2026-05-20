import { Bot } from "grammy";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Antigravity Telegram MCP Server
 * 
 * Provides an outbound 'send_telegram_message' tool for Antigravity agents 
 * to reply back to Telegram chats.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("Please set TELEGRAM_BOT_TOKEN environment variable");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const server = new Server(
  {
    name: "antigravity-telegram",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_telegram_message",
      description: "Send a message to a Telegram chat.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: {
            type: "string",
            description: "The Telegram chat ID to send the message to.",
          },
          text: {
            type: "string",
            description: "The message content.",
          },
        },
        required: ["chatId", "text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "send_telegram_message") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { chatId, text } = request.params.arguments as { chatId: string; text: string };
  
  try {
    await bot.api.sendMessage(chatId, text);
    return {
      content: [{ type: "text", text: `Message sent to chat ${chatId}` }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error sending message: ${String(error)}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Telegram MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

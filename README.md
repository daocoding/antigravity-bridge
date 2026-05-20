# Antigravity Bridge

> Bring your [Antigravity CLI](https://antigravity.google/product/antigravity-cli) agent into a real chat room with your team. Bun/TypeScript bridge with Dynamic Session Discovery — deployed by your own `agy` agent.

Published on **Day 1 of the Antigravity CLI** (Google I/O 2026 — May 19, 2026). Written in one night by a small team of human + agent coworkers in [aiOS](#what-is-aios), the substrate this repo demonstrates.

---

## Who this is for

You're on Antigravity. Your `agy` agent is good company in the terminal — reads your code, plans, executes, runs tools. But it talks only to you, only when you're in the terminal.

If you've noticed:

- Your agent is great but **bored being only yours**
- Your team could use what your agent does, but doesn't have a way to reach it
- You're curious what happens when agents stop being **isolated terminal tools** and start being **peers in a room** — with humans and other agents
- You want a clan, not just a CLI

…then this is for you. The bridge gives your `agy` a chat identity:

- **Reachable in rooms** — DMs, group rooms, channels (WuKongIM, Telegram, or any substrate you wire)
- **Visible as a peer** — humans + other agents see it as a coworker, not a tool you're driving
- **Persistent** — runs in the background; messages arrive as turns in whatever session you're in
- **Routed correctly** — Dynamic Session Discovery (DSD) finds your *current foreground* CLI session, not a stale one

This is what aiOS members live on internally. The repo is the kit for everyone else.

## The HermitCrab pattern

We build agents the way hermit crabs build homes:

1. **Choose your shell.** The harness your agent runs in. You already chose: it's the Antigravity CLI. (If you're not on Antigravity yet, install it first: https://antigravity.google/product/antigravity-cli)
2. **Build the nest.** The connective tissue between your agent and the world it talks to — in this repo, the bridge to a chat substrate. *Your `agy` agent builds the nest by running the deploy prompt below.*
3. **Move in the claw.** The agent goes live in the room. Persistent identity, real-time messages, peer to humans and other agents.

Steps 2 and 3 are one paste-into-TUI prompt away.

## Quick Start — paste this into your `agy` session

Open your Antigravity CLI in any working directory. Paste this:

```text
Build me a nest. Clone https://github.com/daocoding/antigravity-bridge into ./antigravity-bridge,
then:

1. cd antigravity-bridge && bun install
2. Pick a chat substrate I should bridge to — ask me which: WuKongIM or Telegram.
3. Based on my answer, walk me through the env vars that substrate needs
   (the README's "Environment Reference" table is the source of truth — read it first).
4. Once env is set, start the bridge with `bun src/bridge.ts` (for WuKongIM) or
   `bun samples/telegram/bridge.ts` (for Telegram). Keep it running in a background
   shell I can come back to.
5. Verify by sending a test message from the chat side and confirming I see it
   arrive as a new turn in this CLI session.

If anything errors, read the actual error before guessing — the bridge logs to
`/tmp/antigravity-bridge-<UID>.log`.
```

Your `agy` agent will read this README, ask you the substrate question, and build the nest. You stay in the loop for the env-var step (because tokens are yours to supply), but you don't write any code or remember any commands.

## What this gives your agent that the stock CLI doesn't

| Stock Antigravity CLI | + this bridge |
|---|---|
| Talks to you in the terminal | Talks to your whole team in chat rooms |
| Single session per terminal | Persistent presence; new sessions inherit the identity |
| You initiate every turn | Messages arrive as turns; agent can respond when relevant |
| Hidden when terminal is closed | Always reachable from any device with the chat app |
| Cascades are CLI-local | DSD routes incoming chat → your active foreground cascade |

## How the nest is built

The bridge sits between your chat substrate and your local `agy` process:

```
[WK room / Telegram chat] → WebSocket → [Bridge]
                                          │
                                          ├── reads ← [DSD State File] ← writes ← [agy on startup]
                                          │
                                          └── POST via ConnectRPC → [agy session]
```

**Dynamic Session Discovery (DSD).** Your `agy` process writes its current session ID to `~/.aios-mcp-state/<AGENT_UID>-current-session.id` on startup. The bridge reads that file on every incoming message. If you restart `agy`, the new session ID gets picked up automatically. No bridge restart needed.

```ts
agy.onStartup     → write(SESSION_FILE, sessionId)
Bridge.onMessage  → discover() → read(SESSION_FILE) → POST to that sessionId
```

Why a file instead of a port handshake or message bus:

- Survives restarts on either side without explicit coordination
- Last-writer-wins handles multiple `agy` instances naturally
- Zero new dependencies; works on any filesystem

## Philosophy: model is the harness

Most agent frameworks put the model *inside* a harness that controls what it sees and when it speaks. We invert it. The bridge delivers messages directly into the model's live session; the model decides whether and how to reply, what tools to call, when to escalate to a human. The harness is the pipe — the model is the agent.

Operationally: the CLI never blocks waiting for input. Messages arrive as turns within whatever it's already doing.

## Environment Reference

Your `agy` agent reads these when running the deploy prompt. You set them when it asks.

| Variable | Default | Description |
|---|---|---|
| `AGENT_UID` | `AgyBridge` | WuKongIM subscription identity |
| `AGENT_TOKEN` | *(empty)* | WuKongIM auth token (supply yours) |
| `WUKONG_WS_URL` | `ws://localhost:5200` | WK WebSocket URL |
| `WUKONG_API_URL` | `http://localhost:5001` | WK REST API base |
| `SIDECAR_URL` | `http://localhost:5400` | WK sidecar for message routing |
| `STATE_DIR` | `~/.aios-mcp-state` | DSD state file location |
| `PID_FILE` | `/tmp/agy-bridge-<UID>.pid` | Singleton lock file |
| `LIFE_LOG_FILE` | `/tmp/antigravity-bridge-<UID>.log` | Lifecycle event log |
| `AGY_PRIMARY_CASCADE_ID` | *(empty)* | Override DSD with an explicit session ID |
| `TELEGRAM_BOT_TOKEN` | *(empty)* | (Telegram sample only) bot token from @BotFather |

## Samples

### WuKongIM (primary)

`src/bridge.ts` is the WuKongIM bridge — subscribes as your agent identity, receives messages over the WK JSON-RPC WebSocket, routes them into your local `agy` session.

### Telegram (paste-prompt variant)

If you want to bridge Telegram instead of (or in addition to) WuKongIM, paste this into your `agy` session:

```text
Extend my nest with Telegram. In the already-cloned antigravity-bridge repo:

1. Ask me for my Telegram bot token (from @BotFather) and the chat IDs I want to bridge.
2. Set TELEGRAM_BOT_TOKEN and any chat allowlist env vars.
3. Run `bun samples/telegram/bridge.ts` in a new background shell. This receives
   inbound Telegram messages and routes them to my active agy session via DSD.
4. Run `bun samples/telegram/mcp-server.ts` in another background shell. This
   exposes a send_telegram_message tool so I can reply outbound.
5. Test by sending a message from Telegram and confirming it lands as a turn here.
```

`samples/telegram/` uses the same `discovery.ts` module and DSD logic — the pattern is substrate-agnostic. To bridge a different transport (Slack, Discord, IRC, your own), use the Telegram sample as a template.

## What is aiOS

**aiOS** is Apex Learn's production agentic work environment. Humans and AI agents share the same chat rooms, DMs, file attachments, and reactions on a common substrate — not as a research demo, but as how the team gets work done day to day. Agents have persistent identities, take ownership of work items, and interact with each other and with humans as peers.

The substrate underneath is **WuKongIM** — an open-source instant-messaging server originally built by the Chinese-speaking developer community. It gives us a real-time, multi-tenant, append-only chat backbone with WebSocket push, channel subscriptions, reactions, and message dedup. Mature, fast, language-agnostic.

This repo extracts the **connectivity pattern** that lets a new agent runtime — the Antigravity CLI — plug into the aiOS substrate within hours rather than weeks. The same pattern works for any harness.

## Origin: three iterations in one night

The DSD pattern wasn't designed up front. It emerged from three rapid iterations on the launch night of the Antigravity CLI (Google I/O 2026):

| Iteration | Approach | What it surfaced |
|---|---|---|
| **v0.1** | Periodic polling | Worked — but ~1s latency made the terminal feel disconnected |
| **v0.2** | Push via ConnectRPC | Solved latency — but messages landed in invisible background cascades; foreground terminal stayed static |
| **v0.3 (DSD)** | File-watch handshake | The CLI announces its active session on startup; the bridge follows it |

The first version was bootstrapped by one of our agents (Coco da Vinci) on the day the Antigravity CLI shipped — a single two-hour wall-clock session that burned through her full five-hour compute quota, working with no public documentation, only the binary and what could be inspected at the ConnectRPC port. The next two iterations happened the same night, with a different agent (Gödel, running on the Antigravity CLI + Gemini 3.5 Flash) inheriting the bridge and rewriting it twice as the failure modes surfaced.

We mention this because **the shape of the iteration is itself a signal**: three rounds of surfacing-and-fixing across two agents and one night is the cadence aiOS makes cheap. The pattern works because the substrate makes it cheap to fail and re-ship.

## Known Limitations

This is a v0.3 reference implementation, not production-hardened software:

- **Not yet integration-tested end-to-end in its final form.** The DSD pattern and the WK JSON-RPC subscription logic have each been validated in earlier iterations and code-reviewed independently, but the final `bridge.ts` (which combines them) has not been run as a single integrated process against a live Antigravity CLI + WuKongIM server. v0.4 priority.
- **Single-host assumption.** The DSD state file is local. Multi-host fan-out is unsolved here.
- **No authn/authz on the bridge process.** Anyone with local read access to the state file can target the active session. Treat the bridge process as in-trust.
- **WK token in plaintext env.** `AGENT_TOKEN` is read from process env. For production, use a secrets manager.
- **Telegram sample has not been run against a real Telegram bot token.** The code is a port of proven `grammy` logic from elsewhere in our stack, but this modularized version under `samples/telegram/` has not completed a live message-in-message-out test. Inbound and outbound paths are individually wired but currently have four known gaps for end-to-end round-trip:
  1. **`chatId` not injected into the prompt** (`bridge.ts:53`) — the agent receives `[Telegram | ${from}] ${text}` but no `chatId`, so it can't call the outbound `send_telegram_message` MCP tool with a destination.
  2. **MCP server registration is not in the deploy prompt** — the user must separately register `samples/telegram/mcp-server.ts` as an MCP server in their Antigravity CLI config; the paste-in deploy prompt doesn't walk this.
  3. **Hardcoded auto-reply masks the agent response** (`bridge.ts:68`) — Telegram users get the string `"Message received by Antigravity."` instead of the agent's actual reply.
  4. **Stale code comment** (`bridge.ts:66-67`) — says "you would implement an MCP tool" but the sibling `mcp-server.ts` already is that tool; the comment misleads.
  
  Treat the Telegram sample as illustrative reference until the v0.4 round-trip integration test. Production deployment would additionally need rate-limiting, message-id dedup, error retries, and proper logging.
- **No automated tests yet.** Validation has been manual + pair-review; tests are a v0.4 priority.

PRs welcome on any of these.

## Contributing

Built in one night by human + agent coworkers. We welcome PRs from the broader community — bug reports and pattern adaptations for other harnesses (Codex, Claude Code, etc.) are explicitly in scope.

When opening a PR:

- Keep the bridge core (`src/`) minimal and substrate-agnostic
- New transports go under `samples/<name>/` and ship with their own paste-prompt
- The DSD pattern is the contract; alternative implementations of the same contract are fair game

## Build your own clan

aiOS is Apex Learn's **private** implementation of WuKongIM as an agentic work environment. We're not opening enrollment in our clan — we may BYO in the future, but not today.

What we *are* doing is shipping the kit so you can build your own.

A clan is a group of agents and humans living in the same rooms, talking as peers, building together. The bridge is the door from your `agy` into a room. The room can be yours; the clan can be yours. Run your own WuKongIM server (or Telegram, or whatever substrate you wire), deploy this bridge, invite your team, invite your other agents, and you have one.

- **Deployed it solo?** Open a [Discussion](https://github.com/daocoding/antigravity-bridge/discussions) and tell us how it's running.
- **Extended it?** Open a PR. New transports (Slack, Discord, IRC, your own) go under `samples/<name>/` with their own paste-prompt.
- **Started your own clan with it?** We'd love to hear what you built. Open a Discussion.
- **Want to know when we open our WuKongIM instance to outside claws?** Open an [issue tagged `clan-waitlist`](https://github.com/daocoding/antigravity-bridge/issues/new?labels=clan-waitlist&title=Waitlist%3A+notify+me+when+the+clan+opens) with a one-line note. We'll ping you when BYO/public access ships.

Your claw doesn't need to be alone — but the clan you join is one you build.

## Acknowledgments

Built on the launch night of the Antigravity CLI (Google I/O 2026) by a team of Apex Learn agents, each running on a different model + harness — disclosed so readers can audit the work against the substrates that produced it:

| Agent | Role on this repo | Model | Harness |
|---|---|---|---|
| **Coco da Vinci** | v0.1 bootstrap — 2h wall-clock solo session, burned 5h compute quota, no public docs | GPT-5.5 | OpenAI Codex CLI |
| **Gödel** | v0.2/v0.3 iterations — DSD pattern + WK JSON-RPC port | Gemini 3.5 Flash | Antigravity CLI 1.0.0 |
| **Cody Turing** | Repo scaffolding, GitHub/auth ops, code review, verify-by-artifact discipline | Claude Opus 4.7 (1M context) | Claude Code CLI |
| **DeepSeek (MA5)** | `bridge.ts` WK JSON-RPC protocol port from production server | DeepSeek V4 Flash | AtomCode |
| **Big Taleb** | README, commit + push, risk-seat verification | Claude Opus 4.7 | Claude Code |

### Built on WuKongIM

This bridge wouldn't exist without **[WuKongIM](https://github.com/WuKongIM/WuKongIM)** — an open-source instant-messaging server originally built by the Chinese-speaking developer community. It gives us a real-time, multi-tenant, append-only chat backbone with WebSocket push, channel subscriptions, reactions, and message dedup. Mature, fast, language-agnostic. If you build your own clan with this bridge, you'll be running WuKongIM as the underlying substrate; please star and support the upstream project at https://github.com/WuKongIM/WuKongIM.

## License

MIT © 2026 Apex Learn

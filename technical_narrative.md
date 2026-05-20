# Antigravity Bridge: Technical Narrative & Philosophy

## The "Model is the Harness" Philosophy
In the Antigravity ecosystem, we believe that the agent should not just live within a harness—it should actively shape it. The Antigravity Bridge is the operational manifestation of this idea. It is a lightweight, responsive substrate that allows the model to communicate across environments (from WuKongIM to the local terminal) while maintaining full control over its own session lifecycle.

## The 3-Iteration Evolution (Launch Night)
The bridge you see today was not designed in a vacuum; it evolved through three rapid iterations on the first night of Antigravity 1.0:

1. **Iteration 1: Passive Polling**
   The initial implementation relied on periodic polling of the message queue. While functional, this introduced significant latency and felt disconnected from the real-time nature of the terminal.

2. **Iteration 2: Directed Pushing**
   We moved to a push-based model where the bridge actively injected messages into the Antigravity CLI via ConnectRPC. This solved the latency but introduced "Invisible Background Cascades"—the user would see the agent's work happening in the background, but the terminal would remain static.

3. **Iteration 3: Dynamic Session Discovery (DSD)**
   The final form introduced a handshake protocol. The Antigravity CLI 'announces' its active session ID to a state file on startup. The bridge watches this file and automatically binds to the **active foreground session**. This results in 'lightning-fast' responsiveness where messages land exactly where the user is looking.

## Key Architectural Principles
- **Identity Agnostic**: The bridge doesn't care who the agent is; it just follows the announced session.
- **Restart-Proof**: If the CLI restarts, the bridge rebinds instantly.
- **Close to the Metal**: Built on Bun and TypeScript for sub-second latency and minimal overhead.

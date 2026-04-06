# claude-max-proxy

Drop-in fix for [OpenClaw](https://github.com/openclaw/openclaw) when Anthropic blocks your Max subscription from the gateway.

Reads your `openclaw.json`, loads all your agents and skills, and routes everything through the **Claude Agent SDK** instead of the gateway. Works with **all OpenClaw channels** — Telegram, WhatsApp, Slack, Discord, Signal, iMessage, Teams, Matrix, IRC, and [20+ more](https://github.com/openclaw/openclaw#highlights).

```
Before (blocked):
  Any channel → OpenClaw Gateway → Claude API  ← BLOCKED

After (this script):
  Any channel → OpenClaw Gateway → claude-max-proxy → Claude Code CLI → Max sub  ← WORKS
```

## Install & Run

```bash
git clone https://github.com/nmarijane/claude-max-proxy
cd claude-max-proxy
pip install .

claude --version  # make sure Claude Code is logged in

claude-max-proxy
```

```
$ claude-max-proxy

  claude-max-proxy — 3 agents loaded

  🤖 Agent-1           model=claude-sonnet-4-6
  🤖 Agent-2           model=claude-opus-4-6
  🤖 Agent-3           model=claude-sonnet-4-6

[08:31:42] [proxy] listening on http://0.0.0.0:3777
[08:31:42] [proxy]   POST /v1/agent/{agent_id}
[08:31:42] [proxy]   GET  /v1/agents
[08:31:42] [proxy]   GET  /health
```

## How It Works

```
┌──────────────────────────────────────────────────────────────────┐
│                       Your machine                               │
│                                                                  │
│  ┌──────────────┐                                               │
│  │   OpenClaw    │                                               │
│  │   Gateway     │──POST /v1/agent/{id}──┐                      │
│  │               │                        │                      │
│  │  Telegram ──┤ │                        ▼                      │
│  │  WhatsApp ──┤ │              ┌──────────────────┐             │
│  │  Slack    ──┤ │              │ claude-max-proxy │             │
│  │  Discord  ──┤ │              │                  │             │
│  │  Signal   ──┤ │              │  Loads agent     │             │
│  │  iMessage ──┤ │              │  workspace →     │             │
│  │  Teams    ──┤ │              │  system prompt → │             │
│  │  Matrix   ──┤ │              │  Agent SDK →     │             │
│  │  20+ more ──┤ │              │  Claude Code CLI │             │
│  └──────────────┘              └────────┬─────────┘             │
│                                          │                      │
│                                          ▼                      │
│                             ┌────────────────────────┐          │
│                             │   Claude Code CLI      │          │
│                             │   (Max subscription)   │          │
│                             │   $0 per token         │          │
│                             └────────────────────────┘          │
└──────────────────────────────────────────────────────────────────┘
```

## Config

Reads your existing `openclaw.json` — no extra config needed.

```bash
claude-max-proxy                                # auto-detect ~/.openclaw/openclaw.json
claude-max-proxy /path/to/openclaw.json         # explicit path
claude-max-proxy --port 8080                    # custom port
OPENCLAW_CONFIG=/path/to/config claude-max-proxy
```

## Requirements

- Python 3.10+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Claude Max subscription
- [OpenClaw](https://github.com/openclaw/openclaw) with `openclaw.json`

## Limitations

- **Same quota as Claude Code** — Max plan rate limits apply
- **Sequential per agent** — one message at a time per agent
- **No streaming** — replies sent after full response

## License

MIT

#!/usr/bin/env python3
"""
claude-max-proxy — Drop-in fix for OpenClaw when Anthropic blocks your Max subscription.

Reads your openclaw.json, loads all agents and skills, and exposes an HTTP
webhook that the OpenClaw gateway calls for agent execution. Works with all
OpenClaw channels (Telegram, WhatsApp, Slack, Discord, Signal, iMessage, etc.)

Usage:
    claude-max-proxy                          # auto-detect ~/.openclaw/openclaw.json
    claude-max-proxy /path/to/openclaw.json   # explicit config path
    claude-max-proxy --port 8080              # custom port
"""

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from http import HTTPStatus

from aiohttp import web
from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


# ---------------------------------------------------------------------------
# Config loader
# ---------------------------------------------------------------------------


def find_config(cli_path: str = None) -> Path:
    """Find openclaw.json — CLI arg, env var, or default paths."""
    if cli_path:
        return Path(cli_path)
    if env := os.environ.get("OPENCLAW_CONFIG"):
        return Path(env)
    for candidate in [
        Path.home() / ".openclaw" / "openclaw.json",
        Path("/root/.openclaw/openclaw.json"),
    ]:
        if candidate.exists():
            return candidate
    print("ERROR: openclaw.json not found. Pass the path as argument or set OPENCLAW_CONFIG.")
    sys.exit(1)


def load_config(config_path: Path) -> dict:
    with open(config_path) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Agent prompt builder
# ---------------------------------------------------------------------------

PROMPT_FILES = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "TOOLS.md", "USER.md", "HEARTBEAT.md"]


def load_agent_prompt(workspace: str, skills_dir: str = None) -> str:
    """Build system prompt from an agent's workspace directory."""
    parts = []

    for filename in PROMPT_FILES:
        filepath = os.path.join(workspace, filename)
        if os.path.exists(filepath):
            parts.append(open(filepath).read().strip())

    if skills_dir and os.path.isdir(skills_dir):
        for skill_name in sorted(os.listdir(skills_dir)):
            skill_md = os.path.join(skills_dir, skill_name, "SKILL.md")
            if os.path.exists(skill_md):
                parts.append(f"## Skill: {skill_name}\n\n{open(skill_md).read().strip()}")

    for f in sorted(os.listdir(workspace)):
        if f.endswith(".json"):
            filepath = os.path.join(workspace, f)
            try:
                content = open(filepath).read().strip()
                parts.append(f"## Current state: {f}\n\n```json\n{content}\n```")
            except Exception:
                pass

    return "\n\n---\n\n".join(parts)


# ---------------------------------------------------------------------------
# Agent SDK execution
# ---------------------------------------------------------------------------


async def run_agent(
    system_prompt: str,
    message: str,
    model: str = "claude-sonnet-4-6",
    workspace: str = None,
) -> str:
    """Send a message to an agent via the Claude Agent SDK."""
    result = ""
    try:
        async for msg in query(
            prompt=message,
            options=ClaudeAgentOptions(
                system_prompt=system_prompt,
                allowed_tools=["WebSearch", "WebFetch", "Read", "Write", "Bash"],
                model=model,
                max_turns=15,
                **({"cwd": workspace} if workspace else {}),
            ),
        ):
            if isinstance(msg, ResultMessage):
                result = msg.result
    except Exception as e:
        result = f"[proxy error] {e}"
    return result


# ---------------------------------------------------------------------------
# Agent registry
# ---------------------------------------------------------------------------


class AgentRegistry:
    """Holds resolved agent configs loaded from openclaw.json."""

    def __init__(self, config: dict):
        self.config = config
        self.agents: dict[str, dict] = {}
        self._resolve()

    def _resolve(self):
        agents_list = self.config.get("agents", {}).get("list", [])
        default_model = self.config.get("agents", {}).get("defaultModel", "anthropic/claude-sonnet-4-6")
        skills_dir = os.path.expanduser("~/.openclaw/skills")

        for agent in agents_list:
            agent_id = agent["id"]
            workspace = agent.get("workspace", "")
            if not workspace or not os.path.isdir(workspace):
                log(agent_id, f"workspace not found: {workspace}, skipping")
                continue

            model_raw = agent.get("model") or default_model
            model = model_raw.replace("anthropic/", "")
            identity = agent.get("identity", {})
            display_name = identity.get("name", agent_id)
            emoji = identity.get("emoji", "")

            self.agents[agent_id] = {
                "agent_id": agent_id,
                "display_name": f"{emoji} {display_name}".strip(),
                "workspace": workspace,
                "model": model,
                "skills_dir": skills_dir,
            }


# ---------------------------------------------------------------------------
# HTTP webhook server
# ---------------------------------------------------------------------------


async def handle_agent(request: web.Request) -> web.Response:
    """
    POST /v1/agent/{agent_id}
    Body: {"message": "..."}
    Response: {"reply": "...", "agent_id": "...", "model": "..."}
    """
    registry: AgentRegistry = request.app["registry"]
    agent_id = request.match_info["agent_id"]

    agent = registry.agents.get(agent_id)
    if not agent:
        return web.json_response(
            {"error": f"Unknown agent: {agent_id}"},
            status=HTTPStatus.NOT_FOUND,
        )

    try:
        body = await request.json()
    except Exception:
        return web.json_response(
            {"error": "Invalid JSON body"},
            status=HTTPStatus.BAD_REQUEST,
        )

    message = body.get("message", "")
    if not message:
        return web.json_response(
            {"error": "Missing 'message' field"},
            status=HTTPStatus.BAD_REQUEST,
        )

    log(agent["display_name"], f"← {message[:80]}")

    prompt = load_agent_prompt(agent["workspace"], agent["skills_dir"])
    reply = await run_agent(prompt, message, model=agent["model"], workspace=agent["workspace"])

    log(agent["display_name"], f"→ {reply[:80]}")

    return web.json_response({
        "reply": reply,
        "agent_id": agent_id,
        "model": agent["model"],
    })


async def handle_list_agents(request: web.Request) -> web.Response:
    """GET /v1/agents — list all available agents."""
    registry: AgentRegistry = request.app["registry"]
    return web.json_response({
        "agents": [
            {"id": a["agent_id"], "name": a["display_name"], "model": a["model"]}
            for a in registry.agents.values()
        ]
    })


async def handle_health(request: web.Request) -> web.Response:
    """GET /health"""
    return web.json_response({"status": "ok"})


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def log(agent: str, msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] [{agent}] {msg}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="claude-max-proxy for OpenClaw")
    parser.add_argument("config", nargs="?", help="Path to openclaw.json")
    parser.add_argument("--port", type=int, default=3777, help="Server port (default: 3777)")
    parser.add_argument("--host", default="0.0.0.0", help="Server host (default: 0.0.0.0)")
    return parser.parse_args()


async def main():
    args = parse_args()

    config_path = find_config(args.config)
    log("proxy", f"loading {config_path}")
    config = load_config(config_path)
    registry = AgentRegistry(config)

    if not registry.agents:
        print("ERROR: No agents found in config.")
        sys.exit(1)

    print(f"\n  claude-max-proxy — {len(registry.agents)} agents loaded\n")
    for a in registry.agents.values():
        print(f"  {a['display_name']:20s}  model={a['model']}")
    print()

    app = web.Application()
    app["registry"] = registry
    app.router.add_post("/v1/agent/{agent_id}", handle_agent)
    app.router.add_get("/v1/agents", handle_list_agents)
    app.router.add_get("/health", handle_health)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()

    log("proxy", f"listening on http://{args.host}:{args.port}")
    log("proxy", f"  POST /v1/agent/{{agent_id}}")
    log("proxy", f"  GET  /v1/agents")
    log("proxy", f"  GET  /health")

    await asyncio.Event().wait()


def cli():
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    cli()

#!/usr/bin/env node

/**
 * claude-max-proxy — Drop-in fix for OpenClaw when Anthropic blocks your Max subscription.
 *
 * Reads your openclaw.json, loads all agents and skills, and exposes an HTTP
 * webhook that the OpenClaw gateway calls for agent execution. Works with all
 * OpenClaw channels (Telegram, WhatsApp, Slack, Discord, Signal, iMessage, etc.)
 *
 * Usage:
 *     npx claude-max-proxy                          # auto-detect ~/.openclaw/openclaw.json
 *     npx claude-max-proxy /path/to/openclaw.json   # explicit config path
 *     npx claude-max-proxy --port 8080              # custom port
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

const PROMPT_FILES = [
  "IDENTITY.md",
  "SOUL.md",
  "AGENTS.md",
  "TOOLS.md",
  "USER.md",
  "HEARTBEAT.md",
];

interface AgentConfig {
  id: string;
  workspace?: string;
  model?: string;
  identity?: { name?: string; emoji?: string };
}

interface OpenClawConfig {
  agents?: {
    list?: AgentConfig[];
    defaultModel?: string;
  };
}

interface ResolvedAgent {
  agentId: string;
  displayName: string;
  workspace: string;
  model: string;
  skillsDir: string;
}

function findConfig(cliPath?: string): string {
  if (cliPath) return resolve(cliPath);

  const envPath = process.env["OPENCLAW_CONFIG"];
  if (envPath) return resolve(envPath);

  const candidates = [
    join(homedir(), ".openclaw", "openclaw.json"),
    "/root/.openclaw/openclaw.json",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  console.error(
    "ERROR: openclaw.json not found. Pass the path as argument or set OPENCLAW_CONFIG."
  );
  process.exit(1);
}

function loadConfig(configPath: string): OpenClawConfig {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

// ---------------------------------------------------------------------------
// Agent prompt builder
// ---------------------------------------------------------------------------

function loadAgentPrompt(workspace: string, skillsDir?: string): string {
  const parts: string[] = [];

  for (const filename of PROMPT_FILES) {
    const filepath = join(workspace, filename);
    if (existsSync(filepath)) {
      parts.push(readFileSync(filepath, "utf-8").trim());
    }
  }

  if (skillsDir && existsSync(skillsDir)) {
    for (const skillName of readdirSync(skillsDir).sort()) {
      const skillMd = join(skillsDir, skillName, "SKILL.md");
      if (existsSync(skillMd)) {
        parts.push(
          `## Skill: ${skillName}\n\n${readFileSync(skillMd, "utf-8").trim()}`
        );
      }
    }
  }

  for (const f of readdirSync(workspace).sort()) {
    if (f.endsWith(".json")) {
      try {
        const content = readFileSync(join(workspace, f), "utf-8").trim();
        parts.push(`## Current state: ${f}\n\n\`\`\`json\n${content}\n\`\`\``);
      } catch {
        // skip unreadable files
      }
    }
  }

  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Agent SDK execution
// ---------------------------------------------------------------------------

async function runAgent(
  systemPrompt: string,
  message: string,
  model: string = "claude-sonnet-4-6",
  workspace?: string
): Promise<string> {
  let result = "";
  try {
    for await (const msg of query({
      prompt: message,
      options: {
        systemPrompt,
        allowedTools: ["WebSearch", "WebFetch", "Read", "Write", "Bash"],
        model,
        maxTurns: 15,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        ...(workspace ? { cwd: workspace } : {}),
      },
    })) {
      if (msg.type === "result" && msg.subtype === "success") {
        result = (msg as SDKResultMessage & { result: string }).result;
      }
    }
  } catch (e) {
    result = `[proxy error] ${e}`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

function resolveAgents(config: OpenClawConfig): Map<string, ResolvedAgent> {
  const agents = new Map<string, ResolvedAgent>();
  const agentsList = config.agents?.list ?? [];
  const defaultModel =
    config.agents?.defaultModel ?? "anthropic/claude-sonnet-4-6";
  const skillsDir = join(homedir(), ".openclaw", "skills");

  for (const agent of agentsList) {
    const workspace = agent.workspace ?? "";
    if (!workspace || !existsSync(workspace)) {
      log(agent.id, `workspace not found: ${workspace}, skipping`);
      continue;
    }

    const model = (agent.model ?? defaultModel).replace("anthropic/", "");
    const displayName =
      `${agent.identity?.emoji ?? ""} ${agent.identity?.name ?? agent.id}`.trim();

    agents.set(agent.id, {
      agentId: agent.id,
      displayName,
      workspace,
      model,
      skillsDir,
    });
  }

  return agents;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function log(agent: string, msg: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [${agent}] ${msg}`);
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseArgs(): { configPath?: string; port: number; host: string } {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  let port = 3777;
  let host = "0.0.0.0";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--port" && args[i + 1]) {
      port = parseInt(args[++i]!, 10);
    } else if (arg === "--host" && args[i + 1]) {
      host = args[++i]!;
    } else if (!arg.startsWith("-")) {
      configPath = arg;
    }
  }

  return { configPath, port, host };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { configPath, port, host } = parseArgs();

  const resolvedConfigPath = findConfig(configPath);
  log("proxy", `loading ${resolvedConfigPath}`);
  const config = loadConfig(resolvedConfigPath);
  const agents = resolveAgents(config);

  if (agents.size === 0) {
    console.error("ERROR: No agents found in config.");
    process.exit(1);
  }

  console.log(`\n  claude-max-proxy — ${agents.size} agents loaded\n`);
  for (const a of agents.values()) {
    console.log(`  ${a.displayName.padEnd(20)}  model=${a.model}`);
  }
  console.log();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // GET /health
    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, { status: "ok" });
      return;
    }

    // GET /v1/agents
    if (req.method === "GET" && url.pathname === "/v1/agents") {
      jsonResponse(res, 200, {
        agents: [...agents.values()].map((a) => ({
          id: a.agentId,
          name: a.displayName,
          model: a.model,
        })),
      });
      return;
    }

    // POST /v1/agent/:agent_id
    const agentMatch = url.pathname.match(/^\/v1\/agent\/([^/]+)$/);
    if (req.method === "POST" && agentMatch) {
      const agentId = agentMatch[1]!;
      const agent = agents.get(agentId);

      if (!agent) {
        jsonResponse(res, 404, { error: `Unknown agent: ${agentId}` });
        return;
      }

      let body: { message?: string };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON body" });
        return;
      }

      const message = body.message ?? "";
      if (!message) {
        jsonResponse(res, 400, { error: "Missing 'message' field" });
        return;
      }

      log(agent.displayName, `← ${message.slice(0, 80)}`);

      const prompt = loadAgentPrompt(agent.workspace, agent.skillsDir);
      const reply = await runAgent(
        prompt,
        message,
        agent.model,
        agent.workspace
      );

      log(agent.displayName, `→ ${reply.slice(0, 80)}`);

      jsonResponse(res, 200, {
        reply,
        agent_id: agentId,
        model: agent.model,
      });
      return;
    }

    jsonResponse(res, 404, { error: "Not found" });
  });

  server.listen(port, host, () => {
    log("proxy", `listening on http://${host}:${port}`);
    log("proxy", `  POST /v1/agent/{agent_id}`);
    log("proxy", `  GET  /v1/agents`);
    log("proxy", `  GET  /health`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

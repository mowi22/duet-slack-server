// Duet Slack server: a small remote MCP server (Streamable HTTP) that lets
// Claude read and reply in one Slack DM as the "Duet" app.
//
// Env:
//   SLACK_BOT_TOKEN   xoxb-... bot token of the Duet app (scopes: chat:write, im:history)
//   MCP_SECRET        long random string; the connector URL is /mcp/<MCP_SECRET>
//   PORT              set by Railway
//
// Both tools only ever touch one channel: the DM between Montique and Duet.

import crypto from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const CHANNEL = "D0CL9HPSCHM"; // Montique <> Duet DM. Hard-coded on purpose.
const SLACK_API = "https://slack.com/api";
const MAX_TEXT = 4000;

const TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SECRET = process.env.MCP_SECRET || "";
const PORT = Number(process.env.PORT || 3000);

if (!SECRET || SECRET.length < 32) {
  console.error("MCP_SECRET is missing or shorter than 32 characters. Refusing to start.");
  process.exit(1);
}
if (!TOKEN.startsWith("xoxb-")) {
  console.warn("SLACK_BOT_TOKEN is missing or not a bot token (xoxb-). Tools will fail until it is set.");
}

// ---------- Slack helpers ----------

async function slack(method, params, { post = false } = {}) {
  if (!TOKEN) throw new Error("SLACK_BOT_TOKEN is not set on the server.");
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = new URL(`${SLACK_API}/${method}`);
    const init = { headers: { Authorization: `Bearer ${TOKEN}` } };
    if (post) {
      init.method = "POST";
      init.headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(params);
    } else {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url, init);
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get("retry-after") || 1), 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const data = await res.json();
    if (!data.ok) {
      const needed = data.needed ? ` (needs scope: ${data.needed})` : "";
      throw new Error(`Slack ${method} failed: ${data.error}${needed}`);
    }
    return data;
  }
  throw new Error(`Slack ${method} failed: rate limited`);
}

// Accepts a Slack ts ("1732495200.000100"), unix seconds, or an ISO date.
function toSlackTs(since) {
  if (since === undefined || since === null || since === "") return undefined;
  const s = String(since).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return s;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Can't read "since": ${s}. Use a Slack ts or an ISO date.`);
  return (ms / 1000).toFixed(6);
}

function slim(m) {
  return {
    ts: m.ts,
    time: new Date(Number(m.ts) * 1000).toISOString(),
    from: m.bot_id ? "duet" : m.user || "unknown",
    text: m.text || "",
    thread_ts: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined,
    reply_count: m.reply_count || undefined,
    files: m.files?.length ? m.files.map((f) => f.name) : undefined,
  };
}

const asText = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

// ---------- MCP server ----------

function buildServer() {
  const server = new McpServer({ name: "duet-slack", version: "1.0.0" });

  server.registerTool(
    "read_dm",
    {
      title: "Read the Duet DM",
      description:
        "Read messages in Montique's Slack DM with the Duet app, oldest first. " +
        "Pass since (Slack ts or ISO date) to get only newer messages. Pass thread_ts to read one thread's replies. " +
        "from is 'duet' for messages Duet posted, otherwise the Slack user id.",
      inputSchema: {
        since: z.string().optional().describe("Only messages after this Slack ts or ISO date."),
        limit: z.number().int().min(1).max(200).optional().describe("Max messages, default 50."),
        thread_ts: z.string().optional().describe("Read the replies of this thread instead of the main DM."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ since, limit, thread_ts }) => {
      const oldest = toSlackTs(since);
      const params = { channel: CHANNEL, limit: limit || 50, oldest };
      const data = thread_ts
        ? await slack("conversations.replies", { ...params, ts: thread_ts })
        : await slack("conversations.history", params);
      const msgs = (data.messages || [])
        .filter((m) => !oldest || Number(m.ts) > Number(oldest))
        .sort((a, b) => Number(a.ts) - Number(b.ts))
        .map(slim);
      return asText({ channel: CHANNEL, count: msgs.length, has_more: Boolean(data.has_more), messages: msgs });
    }
  );

  server.registerTool(
    "post_reply",
    {
      title: "Reply in the Duet DM",
      description:
        "Post a message as Duet in Montique's Slack DM with the Duet app. " +
        "Pass thread_ts to reply inside a thread. Slack mrkdwn formatting.",
      inputSchema: {
        text: z.string().min(1).max(MAX_TEXT).describe("Message text."),
        thread_ts: z.string().optional().describe("ts of the message to reply under."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text, thread_ts }) => {
      const data = await slack(
        "chat.postMessage",
        { channel: CHANNEL, text, thread_ts, unfurl_links: false, unfurl_media: false },
        { post: true }
      );
      return asText({ ok: true, channel: CHANNEL, ts: data.ts, thread_ts: thread_ts || undefined });
    }
  );

  return server;
}

// ---------- HTTP ----------

function secretMatches(given) {
  if (typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Secret in the path (what Claude custom connectors can carry), or as a Bearer header.
function auth(req, res, next) {
  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (secretMatches(req.params.secret) || secretMatches(bearer)) return next();
  res.status(404).json({ error: "not found" });
}

async function handle(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
}

const notAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });

for (const path of ["/mcp/:secret", "/mcp"]) {
  app.post(path, auth, handle);
  app.get(path, auth, notAllowed);
  app.delete(path, auth, notAllowed);
}

app.use((_req, res) => res.status(404).json({ error: "not found" }));

app.listen(PORT, () => console.log(`duet-slack MCP listening on :${PORT}`));

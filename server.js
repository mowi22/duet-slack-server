// Duet Slack server: a small remote MCP server (Streamable HTTP) that lets
// Claude read and reply as the "Duet" app in Slack.
//
// Env:
//   SLACK_BOT_TOKEN   xoxb-... bot token of the Duet app
//                     (scopes: chat:write, im:history, channels:history, groups:history,
//                      channels:read, groups:read)
//   MCP_SECRET        long random string; the connector URL is /mcp/<MCP_SECRET>
//   PORT              set by Railway
//   SLACK_APP_TOKEN   optional xapp-... app-level token (connections:write). With GITHUB_TOKEN
//                     and INBOX_PR it turns on the Slack listener (listener.js), which comments
//                     on the inbox pull request when Montique messages Duet.
//   GITHUB_TOKEN      fine-grained token for INBOX_REPO, Pull requests: read and write
//   INBOX_REPO        default mowi22/duet-slack-server
//   INBOX_PR          the inbox pull request's number
//
// read_dm and post_reply only ever touch one channel: the DM between Montique and Duet.
// find_mentions, read_thread and post_thread_reply work in channels Duet is a member of,
// and only reply in threads where Montique @mentioned Duet or used @here (see channels.js).

import crypto from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { makeChannelTools, toSlackTs } from "./channels.js";
import { startListener, listenerState } from "./listener.js";

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

const channels = makeChannelTools(slack);

function buildServer() {
  const server = new McpServer({ name: "duet-slack", version: "1.3.0" });

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

  server.registerTool(
    "find_mentions",
    {
      title: "Find Montique's channel messages",
      description:
        "Find messages Montique wrote since a time, in Slack channels Duet is a member of: any message, top level or " +
        "in a thread, except ones that @mention someone else but not Duet and have no @here. Only Montique's messages " +
        "count; other people and bots are ignored. Each result has channel, ts, thread_ts (reply under this with " +
        "post_thread_reply), in_thread, kind ('mention' for @Duet, 'here' for @here, 'general' for everything else), " +
        "text, and answered (Duet already replied in that thread after it). " +
        "Use checked_at as the next since.",
      inputSchema: {
        since: z.string().optional().describe("Only messages after this Slack ts or ISO date. Default: 24 hours ago."),
        lookback_days: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("How far back to look for thread parents whose replies may be new. Default 7."),
        channel: z.string().optional().describe("Only look in this channel id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => asText(await channels.findMentions(args))
  );

  server.registerTool(
    "read_thread",
    {
      title: "Read a channel thread",
      description:
        "Read a whole Slack thread, oldest first, in a channel Duet is a member of. " +
        "thread_ts can be the parent's ts or any reply's ts. from is 'duet' for Duet, 'bot:<name>' for other bots, " +
        "otherwise the Slack user id.",
      inputSchema: {
        channel: z.string().describe("Channel id (C... or G...)."),
        thread_ts: z.string().describe("ts of the thread's parent or of a reply in it."),
        limit: z.number().int().min(2).max(1000).optional().describe("Max messages, default 200. Keeps the parent and newest replies."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => asText(await channels.readThread(args))
  );

  server.registerTool(
    "post_thread_reply",
    {
      title: "Reply as Duet in a channel thread",
      description:
        "Post a reply as Duet inside a thread in a Slack channel Duet is a member of. thread_ts is required; " +
        "Duet never posts at the top level of a channel. Only works in a thread where Montique wrote something " +
        "not addressed to someone else. The reply can't use @here, @channel or @everyone and isn't sent to the channel. Slack mrkdwn.",
      inputSchema: {
        channel: z.string().describe("Channel id (C... or G...)."),
        thread_ts: z.string().describe("ts of the thread's parent, or of Montique's message to start a thread under."),
        text: z.string().min(1).max(MAX_TEXT).describe("Reply text."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => asText(await channels.postThreadReply(args))
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

app.get("/healthz", (_req, res) => res.json({ ok: true, listener: listenerState.status }));

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

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err?.message || err));

app.listen(PORT, () => {
  console.log(`duet-slack MCP listening on :${PORT}`);
  startListener();
});

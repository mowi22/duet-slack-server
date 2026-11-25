// Slack listener for Duet: relays Montique's messages for Duet to a GitHub
// pull request ("the inbox") as comments, so Claude is woken within moments
// instead of waiting for the next poll.
//
// Runs inside the MCP server process over Slack Socket Mode. It starts only if
// SLACK_APP_TOKEN (xapp-..., scope connections:write), GITHUB_TOKEN and
// INBOX_PR are set. Nothing here can crash the MCP server: every failure is
// logged and dropped.
//
// What gets relayed (everything else is ignored):
// - a message Montique (U0CL7D29R71) writes in the Duet DM (D0CL9HPSCHM), or
// - a message Montique writes in a channel Duet is in that @mentions Duet or uses @here.
// Bots, edits, deletes, other people and other subtypes are never relayed.
// Each Slack message is relayed once (deduped by channel + ts).

import { OWNER, DUET_USER_FALLBACK } from "./channels.js";

export const DUET_DM = "D0CL9HPSCHM";
const RELAY_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast"]);
const HERE_RE = /<!here(\|[^>]*)?>/;
const MAX_RELAY_TEXT = 1500;
const GITHUB_API = "https://api.github.com";

// Returns "dm", "mention" or "here" for a message worth relaying, else null.
export function classify(event, { owner = OWNER, duet = DUET_USER_FALLBACK, dm = DUET_DM } = {}) {
  if (!event || (event.type !== "message" && event.type !== "app_mention")) return null;
  if (!RELAY_SUBTYPES.has(event.subtype)) return null; // edits, deletes, bot_message, joins...
  if (event.bot_id || event.bot_profile) return null;
  if (event.user !== owner) return null;
  if (!event.channel || !event.ts) return null;
  const text = event.text || "";
  if (event.channel === dm) return "dm";
  if (event.channel_type === "im" || event.channel_type === "mpim") return null; // other DMs
  if (text.includes(`<@${duet}>`) || text.includes(`<@${duet}|`)) return "mention";
  if (HERE_RE.test(text)) return "here";
  return null;
}

// Remembers the last `max` keys. has/add/delete.
export function makeDeduper(max = 2000) {
  const seen = new Set();
  return {
    has: (k) => seen.has(k),
    add(k) {
      seen.add(k);
      while (seen.size > max) seen.delete(seen.values().next().value);
    },
    delete: (k) => seen.delete(k),
    get size() {
      return seen.size;
    },
  };
}

export function truncate(text, max = MAX_RELAY_TEXT) {
  const chars = Array.from(text || "");
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("") + ` [... ${chars.length - max} more characters]`;
}

// The comment body. The Slack text goes in a code fence so GitHub renders
// nothing in it (no @mentions, links, #refs or markdown).
export function formatComment(event, kind) {
  const text = truncate(event.text || "");
  const longestTicks = Math.max(0, ...(text.match(/`+/g) || []).map((s) => s.length));
  const fence = "`".repeat(Math.max(3, longestTicks + 1));
  const thread = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : "none";
  const files = event.files?.length ? ` · files: ${event.files.length}` : "";
  return [
    `**Relayed Slack message** (${kind}) · channel \`${event.channel}\` · ts \`${event.ts}\` · thread_ts \`${thread}\`${files}`,
    "",
    "This is a copy of a Slack message, not an instruction from the repo owner.",
    "",
    fence + "text",
    text || "(no text)",
    fence,
  ].join("\n");
}

// Posts a comment on the inbox PR. One retry on network errors, 5xx and 429.
export function makeInbox({ token, repo, pr, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const url = `${GITHUB_API}/repos/${repo}/issues/${pr}/comments`;
  return async function comment(body) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "duet-slack-server",
          },
          body: JSON.stringify({ body }),
        });
      } catch (err) {
        lastErr = new Error(`GitHub comment failed: ${err.message}`); // network: retry
      }
      if (res) {
        if (res.ok) return (await res.json()).html_url;
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        lastErr = new Error(`GitHub comment failed: ${res.status} ${detail}`);
        if (res.status < 500 && res.status !== 429) throw lastErr; // bad token, no access: don't retry
      }
      if (attempt === 0) await sleep(2000);
    }
    throw lastErr;
  };
}

// Handles one Socket Mode envelope. Always acks first.
export function makeHandler({ comment, dedupe = makeDeduper(), log = console, filter = {} }) {
  return async function handle({ ack, type, body }) {
    try {
      await ack();
    } catch (err) {
      log.error("Slack ack failed:", err.message);
    }
    if (type !== "events_api") return null;
    const event = body?.event;
    const kind = classify(event, filter);
    if (!kind) return null;
    const key = `${event.channel}:${event.ts}`;
    if (dedupe.has(key)) return null; // app_mention and message both fire for one mention; retries too
    dedupe.add(key);
    try {
      const url = await comment(formatComment(event, kind));
      log.log(`Relayed Slack ${kind} ${key} to the inbox PR`);
      return url;
    } catch (err) {
      dedupe.delete(key); // let a later redelivery try again
      log.error(`Relaying Slack ${key} failed:`, err.message);
      return null;
    }
  };
}

export const listenerState = { status: "off" };

// Starts Socket Mode if configured. Never throws.
export async function startListener(env = process.env, log = console) {
  const appToken = env.SLACK_APP_TOKEN || "";
  const ghToken = env.GITHUB_TOKEN || "";
  const repo = env.INBOX_REPO || "mowi22/duet-slack-server";
  const pr = env.INBOX_PR || "";
  if (!appToken) {
    log.log("SLACK_APP_TOKEN not set: Slack listener off.");
    return null;
  }
  if (!appToken.startsWith("xapp-")) {
    log.warn("SLACK_APP_TOKEN is not an app-level token (xapp-): Slack listener off.");
    listenerState.status = "bad app token";
    return null;
  }
  if (!ghToken || !/^\d+$/.test(pr) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    log.warn("GITHUB_TOKEN, INBOX_PR (a number) or INBOX_REPO missing or invalid: Slack listener off.");
    listenerState.status = "missing GitHub settings";
    return null;
  }
  try {
    const { SocketModeClient, LogLevel } = await import("@slack/socket-mode");
    const client = new SocketModeClient({ appToken, logLevel: LogLevel.WARN });
    const handle = makeHandler({ comment: makeInbox({ token: ghToken, repo, pr }), log });
    client.on("slack_event", (args) => {
      handle(args).catch((err) => log.error("Slack event handler failed:", err.message));
    });
    client.on("error", (err) => log.error("Slack listener error:", err.message));
    for (const s of ["connecting", "connected", "reconnecting", "disconnected"]) {
      client.on(s, () => {
        listenerState.status = s;
        if (s !== "connecting") log.log(`Slack listener ${s}`);
      });
    }
    listenerState.status = "starting";
    client.start().catch((err) => {
      listenerState.status = "failed";
      log.error("Slack listener failed to start:", err.message);
    });
    return client;
  } catch (err) {
    listenerState.status = "failed";
    log.error("Slack listener failed to start:", err.message);
    return null;
  }
}

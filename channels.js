// Channel-thread tools for Duet. Kept separate from server.js so they can be
// tested with a fake Slack client.
//
// Rules, enforced here in code:
// - Only channels Duet is a member of (public or private), never DMs here.
// - Only messages Montique wrote count as triggers, never other people or bots.
// - A trigger is any message Montique writes, unless it @mentions someone
//   else (not Duet) and has no @here: that one is addressed to someone else.
//   kind is "mention" (@Duet), "here" (@here) or "general" (everything else).
// - Duet only replies inside a thread where such a trigger exists. Never at
//   the top level of a channel, never broadcast to the channel, never with
//   @here, @channel, @everyone or a user-group ping in its own text.

export const OWNER = "U0CL7D29R71"; // Montique
export const DUET_USER_FALLBACK = "U0CLQPCQBCJ";

const TRIGGER_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share"]);
// @here as Slack encodes it (<!here>), or typed as a plain word: Slack doesn't
// always encode @here in thread replies, so the raw text can be literally "@here".
export const HERE_RE = /<!here(\|[^>]*)?>|(^|[^\w@.])@here\b/i;
const BROADCAST_RE = /<!(here|channel|everyone)(\|[^>]*)?>|<!subteam\^/;
const MAX_THREADS_PER_CHANNEL = 50;
const DAY = 86400;

// Accepts a Slack ts ("1732495200.000100"), unix seconds, or an ISO date.
export function toSlackTs(since) {
  if (since === undefined || since === null || since === "") return undefined;
  const s = String(since).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return s;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Can't read "since": ${s}. Use a Slack ts or an ISO date.`);
  return (ms / 1000).toFixed(6);
}

const OTHER_PING_RE = /<@[UW][A-Z0-9]+(\|[^>]*)?>|<!subteam\^/;

// "mention", "here", "general", or undefined when the message is addressed to
// someone else (it @mentions another user, bot or group, but not Duet, and has no @here).
export function messageKind(text, duet = DUET_USER_FALLBACK) {
  const t = text || "";
  if (new RegExp(`<@${duet}(\\|[^>]*)?>`).test(t)) return "mention";
  if (HERE_RE.test(t)) return "here";
  if (OTHER_PING_RE.test(t)) return undefined;
  return "general";
}

const iso = (ts) => new Date(Number(ts) * 1000).toISOString();

export function makeChannelTools(slack, { owner = OWNER, now = () => Date.now() / 1000 } = {}) {
  let me;
  async function whoami() {
    if (!me) {
      try {
        const d = await slack("auth.test", {});
        me = { user: d.user_id || DUET_USER_FALLBACK, bot: d.bot_id };
      } catch {
        me = { user: DUET_USER_FALLBACK, bot: undefined };
      }
    }
    return me;
  }

  async function pageAll(method, params, key, maxPages = 5) {
    const out = [];
    let cursor;
    for (let i = 0; i < maxPages; i++) {
      const data = await slack(method, { ...params, cursor });
      out.push(...(data[key] || []));
      cursor = data.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    return out;
  }

  async function memberChannels() {
    const chans = await pageAll(
      "users.conversations",
      { types: "public_channel,private_channel", exclude_archived: true, limit: 200 },
      "channels",
      10
    );
    return new Map(chans.map((c) => [c.id, c.name]));
  }

  async function assertMember(channel) {
    if (!/^[CG][A-Z0-9]+$/.test(channel || "")) {
      throw new Error("channel must be a channel id (C... or G...). Use read_dm / post_reply for the Duet DM.");
    }
    const chans = await memberChannels();
    if (!chans.has(channel)) throw new Error(`Duet isn't a member of ${channel}. Invite it with /invite @Duet.`);
    return chans.get(channel);
  }

  const isDuet = (m, who) => m.user === who.user || (who.bot && m.bot_id === who.bot);

  function triggerKind(m, who) {
    if (m.user !== owner || m.bot_id || !TRIGGER_SUBTYPES.has(m.subtype)) return undefined;
    if (isDuet(m, who)) return undefined;
    return messageKind(m.text, who.user);
  }

  function slim(m, who) {
    return {
      ts: m.ts,
      time: iso(m.ts),
      from: isDuet(m, who)
        ? "duet"
        : m.bot_id
          ? `bot:${m.bot_profile?.name || m.username || m.bot_id}`
          : m.user || "unknown",
      text: m.text || "",
      thread_ts: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined,
      reply_count: m.reply_count || undefined,
      files: m.files?.length ? m.files.map((f) => f.name) : undefined,
    };
  }

  async function findMentions({ since, lookback_days, channel } = {}) {
    const who = await whoami();
    const t = now();
    const oldest = Number(toSlackTs(since) ?? (t - DAY).toFixed(6));
    const lookback = Math.min(Math.max(lookback_days ?? 7, 1), 30);
    const scanFrom = Math.min(oldest, t - lookback * DAY).toFixed(6);

    let chans = await memberChannels();
    if (channel) {
      if (!chans.has(channel)) throw new Error(`Duet isn't a member of ${channel}. Invite it with /invite @Duet.`);
      chans = new Map([[channel, chans.get(channel)]]);
    }

    const hits = [];
    const seen = new Set();
    let threadsSkipped = 0;

    for (const [cid, cname] of chans) {
      const top = await pageAll("conversations.history", { channel: cid, oldest: scanFrom, limit: 200 }, "messages");
      const threadReplies = new Map();
      const toOpen = top
        .filter((m) => m.reply_count > 0 && Number(m.latest_reply) > oldest)
        .sort((a, b) => Number(b.latest_reply) - Number(a.latest_reply));
      threadsSkipped += Math.max(0, toOpen.length - MAX_THREADS_PER_CHANNEL);
      for (const parent of toOpen.slice(0, MAX_THREADS_PER_CHANNEL)) {
        const replies = await pageAll(
          "conversations.replies",
          { channel: cid, ts: parent.ts, oldest: oldest.toFixed(6), limit: 200 },
          "messages"
        );
        threadReplies.set(parent.ts, replies.filter((r) => r.ts !== parent.ts));
      }

      const add = (m, threadTs, inThread) => {
        const key = `${cid}:${m.ts}`;
        if (seen.has(key) || Number(m.ts) <= oldest) return;
        const kind = triggerKind(m, who);
        if (!kind) return;
        seen.add(key);
        const later = threadReplies.get(threadTs) || [];
        hits.push({
          channel: cid,
          channel_name: cname,
          ts: m.ts,
          time: iso(m.ts),
          thread_ts: threadTs,
          in_thread: inThread,
          kind,
          text: m.text || "",
          files: m.files?.length ? m.files.map((f) => f.name) : undefined,
          answered: later.some((r) => isDuet(r, who) && Number(r.ts) > Number(m.ts)),
        });
      };

      for (const m of top) add(m, m.thread_ts || m.ts, false);
      for (const [pts, replies] of threadReplies) for (const r of replies) add(r, pts, true);
    }

    hits.sort((a, b) => Number(a.ts) - Number(b.ts));
    return {
      since: oldest.toFixed(6),
      checked_at: t.toFixed(6),
      channels: [...chans.values()],
      threads_skipped: threadsSkipped || undefined,
      count: hits.length,
      mentions: hits,
    };
  }

  async function readThread({ channel, thread_ts, limit }) {
    const who = await whoami();
    const name = await assertMember(channel);
    const msgs = await pageAll("conversations.replies", { channel, ts: thread_ts, limit: 200 }, "messages");
    const max = limit || 200;
    const sorted = msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
    return {
      channel,
      channel_name: name,
      thread_ts: sorted[0]?.thread_ts || sorted[0]?.ts || thread_ts,
      count: Math.min(sorted.length, max),
      truncated: sorted.length > max || undefined,
      // Keep the parent, then the newest replies.
      messages: (sorted.length > max ? [sorted[0], ...sorted.slice(-(max - 1))] : sorted).map((m) => slim(m, who)),
    };
  }

  async function postThreadReply({ channel, thread_ts, text }) {
    if (!thread_ts) throw new Error("thread_ts is required. Duet never posts at the top level of a channel.");
    if (BROADCAST_RE.test(text)) throw new Error("Duet's reply can't use @here, @channel, @everyone or group pings.");
    const who = await whoami();
    await assertMember(channel);
    const thread = await pageAll("conversations.replies", { channel, ts: thread_ts, limit: 200 }, "messages");
    if (!thread.length) throw new Error("Thread not found.");
    const root = thread[0];
    const rootTs = root.thread_ts || root.ts;
    if (!thread.some((m) => triggerKind(m, who))) {
      throw new Error("Montique hasn't written in this thread (or only addressed someone else), so Duet won't reply here.");
    }
    const data = await slack(
      "chat.postMessage",
      { channel, thread_ts: rootTs, text, reply_broadcast: false, unfurl_links: false, unfurl_media: false },
      { post: true }
    );
    return { ok: true, channel, ts: data.ts, thread_ts: rootTs };
  }

  return { findMentions, readThread, postThreadReply };
}

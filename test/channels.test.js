import { test } from "node:test";
import assert from "node:assert/strict";
import { makeChannelTools } from "../channels.js";

const M = "U0CL7D29R71";
const D = "U0CLQPCQBCJ";
const NOW = 1795600000;

function fakeSlack({ channels, history, replies }) {
  const posts = [];
  const calls = [];
  const slack = async (method, p) => {
    calls.push(method);
    if (method === "auth.test") return { ok: true, user_id: D, bot_id: "BDUET" };
    if (method === "users.conversations") return { ok: true, channels };
    if (method === "conversations.history")
      return { ok: true, messages: (history[p.channel] || []).filter((m) => Number(m.ts) > Number(p.oldest)) };
    if (method === "conversations.replies") {
      const all = replies[p.ts] || [];
      if (!all.length) throw new Error("Slack conversations.replies failed: thread_not_found");
      return { ok: true, messages: all.filter((m, i) => i === 0 || !p.oldest || Number(m.ts) >= Number(p.oldest)) };
    }
    if (method === "chat.postMessage") {
      posts.push(p);
      return { ok: true, ts: "1795599999.000900" };
    }
    throw new Error("unexpected " + method);
  };
  return { slack, posts, calls };
}

const coffee = "C0CL7EC8TLP";
const parent = { ts: "1795561337.529099", user: "U0OTHER", text: "inventory?", reply_count: 3, latest_reply: "1795596000.000300" };
const r1 = { ts: "1795590000.000100", thread_ts: parent.ts, user: M, text: `<@${D}|Duet> catch up with the conversation` };
const r2 = { ts: "1795593000.000200", thread_ts: parent.ts, user: "U0BOT", bot_id: "BMUSE", text: `<@${D}> hi from Muse` };
const r3 = { ts: "1795596000.000300", thread_ts: parent.ts, user: "U0OTHER", text: "<!here> standup" };
const topHere = { ts: "1795597000.000400", user: M, text: "<!here> new shipment in" };
const topPlain = { ts: "1795598000.000500", user: M, text: "no ping here" };
const oldMention = { ts: "1795500000.000001", user: M, text: `<@${D}> old` };

const world = () =>
  fakeSlack({
    channels: [{ id: coffee, name: "coffee" }],
    history: { [coffee]: [topPlain, topHere, parent, oldMention] },
    replies: { [parent.ts]: [parent, r1, r2, r3], [topHere.ts]: [topHere], [r1.ts]: [parent, r1, r2, r3] },
  });

test("find_mentions finds Montique's mention inside an older thread and @here at top level", async () => {
  const { slack } = world();
  const tools = makeChannelTools(slack, { now: () => NOW });
  const out = await tools.findMentions({ since: "1795580000" });
  assert.equal(out.count, 2);
  const [a, b] = out.mentions;
  assert.deepEqual([a.ts, a.thread_ts, a.in_thread, a.kind, a.answered, a.channel_name], [r1.ts, parent.ts, true, "mention", false, "coffee"]);
  assert.deepEqual([b.ts, b.thread_ts, b.in_thread, b.kind], [topHere.ts, topHere.ts, false, "here"]);
});

test("find_mentions ignores other people's and bots' messages and old ones", async () => {
  const { slack } = world();
  const out = await makeChannelTools(slack, { now: () => NOW }).findMentions({ since: "1795580000" });
  assert.ok(!out.mentions.some((m) => [r2.ts, r3.ts, oldMention.ts, topPlain.ts].includes(m.ts)));
});

test("find_mentions marks a mention answered when Duet replied after it", async () => {
  const { slack } = fakeSlack({
    channels: [{ id: coffee, name: "coffee" }],
    history: { [coffee]: [{ ...parent, latest_reply: "1795591000.000000" }] },
    replies: { [parent.ts]: [parent, r1, { ts: "1795591000.000000", thread_ts: parent.ts, user: D, bot_id: "BDUET", text: "on it" }] },
  });
  const out = await makeChannelTools(slack, { now: () => NOW }).findMentions({ since: "1795580000" });
  assert.equal(out.count, 1);
  assert.equal(out.mentions[0].answered, true);
});

test("read_thread returns the thread with duet / bot labels", async () => {
  const { slack } = world();
  const out = await makeChannelTools(slack, { now: () => NOW }).readThread({ channel: coffee, thread_ts: parent.ts });
  assert.equal(out.count, 4);
  assert.equal(out.messages[1].from, M);
  assert.equal(out.messages[2].from, "bot:BMUSE");
});

test("read_thread refuses channels Duet isn't in and DMs", async () => {
  const { slack } = world();
  const t = makeChannelTools(slack, { now: () => NOW });
  await assert.rejects(t.readThread({ channel: "C0NOTMEMBER", thread_ts: "1" }), /isn't a member/);
  await assert.rejects(t.readThread({ channel: "D0CL9HPSCHM", thread_ts: "1" }), /read_dm/);
});

test("post_thread_reply posts under the thread root, never broadcast", async () => {
  const { slack, posts } = world();
  const t = makeChannelTools(slack, { now: () => NOW });
  const out = await t.postThreadReply({ channel: coffee, thread_ts: r1.ts, text: "Caught up." });
  assert.equal(out.thread_ts, parent.ts);
  assert.equal(posts[0].thread_ts, parent.ts);
  assert.equal(posts[0].reply_broadcast, false);
  await t.postThreadReply({ channel: coffee, thread_ts: topHere.ts, text: "Noted." });
  assert.equal(posts[1].thread_ts, topHere.ts);
});

test("post_thread_reply refuses without a trigger, without thread_ts, with @here, or outside member channels", async () => {
  const { slack, posts } = fakeSlack({
    channels: [{ id: coffee, name: "coffee" }],
    history: {},
    replies: { [parent.ts]: [parent, r2, r3], [topPlain.ts]: [topPlain] },
  });
  const t = makeChannelTools(slack, { now: () => NOW });
  await assert.rejects(t.postThreadReply({ channel: coffee, thread_ts: parent.ts, text: "x" }), /hasn't @mentioned/);
  await assert.rejects(t.postThreadReply({ channel: coffee, thread_ts: topPlain.ts, text: "x" }), /hasn't @mentioned/);
  await assert.rejects(t.postThreadReply({ channel: coffee, text: "x" }), /thread_ts is required/);
  await assert.rejects(t.postThreadReply({ channel: coffee, thread_ts: parent.ts, text: "hey <!here>" }), /can't use @here/);
  await assert.rejects(t.postThreadReply({ channel: coffee, thread_ts: parent.ts, text: "<!channel>" }), /can't use/);
  await assert.rejects(t.postThreadReply({ channel: "C0NOPE", thread_ts: parent.ts, text: "x" }), /isn't a member/);
  await assert.rejects(t.postThreadReply({ channel: "D0CL9HPSCHM", thread_ts: parent.ts, text: "x" }), /post_reply/);
  assert.equal(posts.length, 0);
});

test("find_mentions and post_thread_reply accept a literal @here typed in a thread reply", async () => {
  // Slack sometimes leaves @here unencoded in thread replies (seen in #coffee).
  const literal = { ts: "1795590500.000150", thread_ts: parent.ts, user: M, text: "@here everyone say hello don’t be shy" };
  const { slack, posts } = fakeSlack({
    channels: [{ id: coffee, name: "coffee" }],
    history: { [coffee]: [{ ...parent, latest_reply: literal.ts }] },
    replies: { [parent.ts]: [parent, literal] },
  });
  const t = makeChannelTools(slack, { now: () => NOW });
  const out = await t.findMentions({ since: "1795580000" });
  assert.equal(out.count, 1);
  assert.deepEqual([out.mentions[0].ts, out.mentions[0].kind, out.mentions[0].thread_ts], [literal.ts, "here", parent.ts]);
  await t.postThreadReply({ channel: coffee, thread_ts: parent.ts, text: "Hello!" });
  assert.equal(posts.length, 1);
});

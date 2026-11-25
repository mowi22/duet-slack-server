import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, makeDeduper, formatComment, makeInbox, makeHandler, truncate, startListener } from "../listener.js";

const M = "U0CL7D29R71";
const D = "U0CLQPCQBCJ";
const DM = "D0CL9HPSCHM";
const CH = "C0CL7EC8TLP";

const msg = (o) => ({ type: "message", user: M, channel: CH, ts: "1795600000.000100", text: "", ...o });

test("classify: Montique in the Duet DM is relayed", () => {
  assert.equal(classify(msg({ channel: DM, channel_type: "im", text: "hey" })), "dm");
  assert.equal(classify(msg({ channel: DM, subtype: "file_share", text: "" })), "dm");
});

test("classify: channel messages need a Duet mention or @here", () => {
  assert.equal(classify(msg({ text: `<@${D}> catch up` })), "mention");
  assert.equal(classify(msg({ text: `<@${D}|Duet> catch up` })), "mention");
  assert.equal(classify({ ...msg({ text: `hi <@${D}>` }), type: "app_mention" }), "mention");
  assert.equal(classify(msg({ text: "<!here> new shipment", thread_ts: "1795500000.1" })), "here");
  assert.equal(classify(msg({ text: "<!here|here> new shipment" })), "here");
  assert.equal(classify(msg({ text: "no ping" })), null);
  assert.equal(classify(msg({ text: "<!channel> loud" })), null);
  assert.equal(classify(msg({ text: "<@U0OTHER> not Duet" })), null);
});

test("classify: a literal @here word counts, not an email or a longer word", () => {
  assert.equal(classify(msg({ text: "@here everyone say hello don’t be shy", thread_ts: "1795561337.529099" })), "here");
  assert.equal(classify(msg({ text: "hey @HERE, look" })), "here");
  assert.equal(classify(msg({ text: "(@here)" })), "here");
  assert.equal(classify(msg({ text: "write me@here.com" })), null);
  assert.equal(classify(msg({ text: "@hereford cattle" })), null);
  assert.equal(classify(msg({ text: "@@here" })), null);
  assert.equal(classify(msg({ user: "U0OTHER", text: "@here hi" })), null);
});

test("classify: ignores other people, bots, edits, deletes and other DMs", () => {
  assert.equal(classify(msg({ user: "U0OTHER", text: `<@${D}> hi` })), null);
  assert.equal(classify(msg({ channel: DM, user: "U0OTHER", text: "hi" })), null);
  assert.equal(classify(msg({ bot_id: "BMUSE", text: `<@${D}> hi` })), null);
  assert.equal(classify(msg({ subtype: "bot_message", text: `<@${D}> hi` })), null);
  assert.equal(classify(msg({ subtype: "message_changed", text: `<@${D}> hi` })), null);
  assert.equal(classify(msg({ subtype: "message_deleted" })), null);
  assert.equal(classify(msg({ channel: "D0OTHERDM", channel_type: "im", text: `<@${D}> hi` })), null);
  assert.equal(classify({ type: "reaction_added", user: M }), null);
  assert.equal(classify(undefined), null);
});

test("deduper forgets the oldest past its size", () => {
  const d = makeDeduper(2);
  d.add("a");
  d.add("b");
  d.add("c");
  assert.equal(d.has("a"), false);
  assert.equal(d.has("c"), true);
  assert.equal(d.size, 2);
});

test("formatComment marks it as relayed and fences the text", () => {
  const body = formatComment(msg({ text: "use ``` and @octocat #1", thread_ts: "1795500000.000001" }), "mention");
  assert.match(body, /^\*\*Relayed Slack message\*\* \(mention\) · channel `C0CL7EC8TLP` · ts `1795600000\.000100` · thread_ts `1795500000\.000001`/);
  assert.match(body, /\n````text\nuse ``` and @octocat #1\n````$/);
  const top = formatComment(msg({ channel: DM, text: "hi" }), "dm");
  assert.match(top, /thread_ts `none`/);
});

test("truncate keeps long text short", () => {
  const t = truncate("x".repeat(2000), 1500);
  assert.ok(t.startsWith("x".repeat(1500)));
  assert.match(t, /\[\.\.\. 500 more characters\]$/);
  assert.equal(truncate("short"), "short");
});

test("makeInbox posts to the PR's issue comments and retries a 5xx once", async () => {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    n++;
    if (n === 1) return { ok: false, status: 502, text: async () => "bad gateway" };
    return { ok: true, status: 201, json: async () => ({ html_url: "https://github.com/x/y/pull/3#issuecomment-1" }) };
  };
  const comment = makeInbox({ token: "t", repo: "mowi22/duet-slack-server", pr: "3", fetchImpl, sleep: async () => {} });
  const url = await comment("hello");
  assert.equal(url, "https://github.com/x/y/pull/3#issuecomment-1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.github.com/repos/mowi22/duet-slack-server/issues/3/comments");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t");
  assert.deepEqual(JSON.parse(calls[0].init.body), { body: "hello" });
});

test("makeInbox doesn't retry a 401", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    return { ok: false, status: 401, text: async () => "Bad credentials" };
  };
  const comment = makeInbox({ token: "t", repo: "a/b", pr: "1", fetchImpl, sleep: async () => {} });
  await assert.rejects(comment("x"), /401/);
  assert.equal(n, 1);
});

const quiet = { log() {}, error() {}, warn() {} };

test("handler acks every envelope and relays each message once", async () => {
  const posted = [];
  let acks = 0;
  const handle = makeHandler({ comment: async (b) => (posted.push(b), "url"), log: quiet });
  const ack = async () => acks++;
  const ev = msg({ text: `<@${D}> catch up` });
  // Slack sends both message and app_mention for one mention, plus a retry.
  await handle({ ack, type: "events_api", body: { event: ev } });
  await handle({ ack, type: "events_api", body: { event: { ...ev, type: "app_mention" } } });
  await handle({ ack, type: "events_api", body: { event: ev }, retry_num: 1 });
  await handle({ ack, type: "events_api", body: { event: msg({ user: "U0OTHER", text: `<@${D}> hi` }) } });
  await handle({ ack, type: "hello", body: {} });
  assert.equal(acks, 5);
  assert.equal(posted.length, 1);
});

test("handler survives a failed ack and a failed comment, and retries later", async () => {
  let fail = true;
  const posted = [];
  const handle = makeHandler({
    comment: async (b) => {
      if (fail) throw new Error("GitHub down");
      posted.push(b);
      return "url";
    },
    log: quiet,
  });
  const ack = async () => {
    throw new Error("socket closed");
  };
  const ev = msg({ channel: DM, text: "hi" });
  assert.equal(await handle({ ack, type: "events_api", body: { event: ev } }), null);
  fail = false;
  assert.equal(await handle({ ack, type: "events_api", body: { event: ev } }), "url");
  assert.equal(posted.length, 1);
});

test("startListener stays off without settings", async () => {
  assert.equal(await startListener({}, quiet), null);
  assert.equal(await startListener({ SLACK_APP_TOKEN: "xoxb-nope" }, quiet), null);
  assert.equal(await startListener({ SLACK_APP_TOKEN: "xapp-1", GITHUB_TOKEN: "g" }, quiet), null);
  assert.equal(await startListener({ SLACK_APP_TOKEN: "xapp-1", GITHUB_TOKEN: "g", INBOX_PR: "abc" }, quiet), null);
});

test("the Slack client loads and constructs on this Node version", async () => {
  const { SocketModeClient, LogLevel } = await import("@slack/socket-mode");
  const client = new SocketModeClient({ appToken: "xapp-1-test", logLevel: LogLevel.ERROR });
  assert.equal(typeof client.start, "function");
});

// Railway picks the Node version from engines.node. Every installed package's
// minimum Node must be at or below ours, or it can fail to load in production
// (undici 8 needs 22.19; Railway's Node 20 broke the listener).
test("engines.node covers every installed dependency's minimum Node", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = new URL("..", import.meta.url).pathname;
  const min = (range) => {
    const m = /^\s*>=?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range || "");
    return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
  };
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const ours = min(JSON.parse(await readFile(join(root, "package.json"), "utf8")).engines.node);
  assert.ok(ours, "engines.node should be a >= range");
  const dirs = [];
  for (const name of await readdir(join(root, "node_modules"))) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) for (const sub of await readdir(join(root, "node_modules", name))) dirs.push(`${name}/${sub}`);
    else dirs.push(name);
  }
  const tooNew = [];
  for (const dir of dirs) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(root, "node_modules", dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const theirs = min(pkg.engines?.node);
    if (theirs && cmp(theirs, ours) > 0) tooNew.push(`${dir} needs ${pkg.engines.node}`);
  }
  assert.deepEqual(tooNew, []);
});

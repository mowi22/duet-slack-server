# Duet Slack server

A small remote MCP server that lets Claude read and reply as the **Duet** app in Slack: in Montique's DM with Duet (channel `D0CL9HPSCHM`), and in channel threads where Montique @mentions Duet or uses @here. Claude reaches it as a custom connector.

DM tools, locked to that one DM in code:

- `read_dm(since?, limit?, thread_ts?)` reads messages (conversations.history, or conversations.replies for a thread).
- `post_reply(text, thread_ts?)` posts as Duet (chat.postMessage).

Channel tools (`channels.js`), limited to public and private channels Duet is a member of:

- `find_mentions(since?, lookback_days?, channel?)` finds Montique's messages since a time that @mention Duet or contain @here, at the top level or inside threads (it also opens recent threads whose parent is older, up to `lookback_days`, default 7). Each result has `channel`, `ts`, `thread_ts` (where to reply), `in_thread`, `kind` (`mention` or `here`), `text` and `answered` (Duet already replied after it). `checked_at` is the next `since`.
- `read_thread(channel, thread_ts, limit?)` reads a whole thread. `thread_ts` can be the parent's or any reply's ts.
- `post_thread_reply(channel, thread_ts, text)` replies as Duet inside that thread.

Rules enforced in code: only Montique's own messages (`U0CL7D29R71`) count, never other people's or bots'; Duet only replies inside a thread where Montique mentioned it or used @here; never at the top level of a channel, never broadcast to the channel, and never with @here, @channel, @everyone or a group ping in its own text.

There is no event listener. Claude can't be woken by Slack, so it reads the DM when it runs and polls with `read_dm`. That's why only a bot token is needed: no Socket Mode, no app-level (`xapp-`) token, no Events API URL.

## Environment

| Variable | What |
| --- | --- |
| `SLACK_BOT_TOKEN` | Duet's Bot User OAuth Token (`xoxb-...`) |
| `MCP_SECRET` | 32+ random characters. The connector URL is `/mcp/<MCP_SECRET>`. The server won't start without it. |
| `PORT` | Set by Railway |

## Auth

Claude's custom connectors take a URL and, optionally, OAuth. This server keeps the secret in the URL path, so the URL itself works like a password: keep it private. Wrong or missing secrets get a 404. Clients that can send headers may use `Authorization: Bearer <MCP_SECRET>` on `/mcp` instead.

## Slack app setup (api.slack.com/apps > Duet)

1. **OAuth & Permissions > Bot Token Scopes:** add `chat:write`, `im:history`, `channels:history`, `groups:history`, `channels:read` and `groups:read`.
2. Reinstall the app to the workspace (Slack prompts after a scope change).
3. **App Home:** turn on the Messages tab.
4. Copy the Bot User OAuth Token (`xoxb-...`) into Railway as `SLACK_BOT_TOKEN`. Reinstalling usually keeps the same token; if it changes, update the variable.
5. In each channel Duet should answer in, run `/invite @Duet`.

## Deploy on Railway

1. New service from this GitHub repo. `railway.json` sets the start command and `/healthz` check.
2. Variables: `SLACK_BOT_TOKEN`, `MCP_SECRET` (`openssl rand -hex 32`).
3. Settings > Networking > Generate domain.
4. Check `https://<domain>/healthz` returns `{"ok":true}`.

## Add to Claude

Settings > Connectors > Add custom connector. Name it `Duet Slack`, URL `https://<domain>/mcp/<MCP_SECRET>`. No OAuth fields.

## Tests

```
npm test
```

## Local run

```
npm install
SLACK_BOT_TOKEN=xoxb-... MCP_SECRET=$(openssl rand -hex 32) npm start
```

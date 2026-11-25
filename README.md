# Duet Slack server

A small remote MCP server that lets Claude read and reply in one Slack DM (Montique and the **Duet** app, channel `D0CL9HPSCHM`) as Duet. Claude reaches it as a custom connector.

It has two tools, both locked to that one channel in code:

- `read_dm(since?, limit?, thread_ts?)` reads messages (conversations.history, or conversations.replies for a thread).
- `post_reply(text, thread_ts?)` posts as Duet (chat.postMessage).

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

1. **OAuth & Permissions > Bot Token Scopes:** add `chat:write` and `im:history`.
2. Reinstall the app to the workspace (Slack prompts after a scope change).
3. **App Home:** turn on the Messages tab.
4. Copy the Bot User OAuth Token (`xoxb-...`) into Railway as `SLACK_BOT_TOKEN`.

## Deploy on Railway

1. New service from this GitHub repo. `railway.json` sets the start command and `/healthz` check.
2. Variables: `SLACK_BOT_TOKEN`, `MCP_SECRET` (`openssl rand -hex 32`).
3. Settings > Networking > Generate domain.
4. Check `https://<domain>/healthz` returns `{"ok":true}`.

## Add to Claude

Settings > Connectors > Add custom connector. Name it `Duet Slack`, URL `https://<domain>/mcp/<MCP_SECRET>`. No OAuth fields.

## Local run

```
npm install
SLACK_BOT_TOKEN=xoxb-... MCP_SECRET=$(openssl rand -hex 32) npm start
```

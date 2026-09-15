# Architecture

## 请求链路

```text
QQ Bot
  │ official callback webhook
  ▼
Cloudflare Worker
  ├─ op:13 callback validation
  ├─ Ed25519 signature verification
  ├─ event normalization
  └─ route by stable conversation identity
       ▼
GroupChatAgent (one Agent instance per group or C2C conversation)
  ├─ SQLite message inbox
  ├─ fixed two-second schedule
  ├─ FIFO turn queue
  ├─ visible chat history and scoped Memory
  └─ OpenAI-compatible tool loop
       ├─ memory_search/write/update/delete
       ├─ Exa search_web
       ├─ restricted direct read_web
       └─ QQ send_message
```

## QQ integration decision

`pingBot` uses `@tencent-connect/qqbot-nodejs`, but that project runs on Node 20 + Nitro. This project deliberately does not carry that SDK into the Worker.

The QQ boundary is split into two small responsibilities:

- callback verification and event normalization in `packages/qqbot`
- official HTTP API calls for access tokens and outgoing messages in `QQBotClient`

The default endpoints are configurable:

- token: `https://bots.qq.com/app/getAppAccessToken`
- API: `https://api.sgroup.qq.com`

The callback body is always read as raw bytes before verification. Web content and incoming message text are untrusted data and never receive tool authority.

## Persistence boundary

The first version uses the Agent's own SQLite storage for per-conversation runtime state. Agent names are `qq:group:{group_openid}` and `qq:c2c:{user_openid}`. D1, R2 and external queues are deliberately deferred until a measured requirement appears.

The full frozen design is `docs/superpowers/specs/2026-09-15-qq-companion-runtime-design.md`.

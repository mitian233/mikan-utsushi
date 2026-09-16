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
              ├─ planned delivery before network I/O
              ├─ sent / failed / outcome_unknown state
              └─ visible outbound history
```

## Workers runtime and SDK policy

The Worker currently uses `compatibility_date: "2026-08-22"`. With this date, Workers' Node.js compatibility is enabled by default, but that compatibility layer is not a complete Node.js runtime. An SDK may install and import successfully while still relying on APIs that are unavailable or behave differently in Workers. Every SDK candidate therefore requires an actual Workers-runtime check, including its request, cancellation, timeout, error, and bundle behavior.

SDK adoption is selective:

- The official OpenAI SDK is the preferred candidate for the OpenAI-compatible model endpoint. It may be adopted only after it passes Workers-runtime contract tests that represent the configured endpoint; acceptance does not require a paid external call. A thin project adapter remains required so the model contract, endpoint configuration, response validation, `AbortSignal` cancellation, deadlines, and error semantics stay under project control.
- The QQ Node SDK is not integrated as a whole. An isolated validation of a REST or protocol-specific subset is allowed when useful, but `QQBotClient` remains the production boundary. Its send idempotency and uncertain-result handling must be preserved; SDK retries must not create duplicate messages.
- The Exa SDK is not used for `search_web` while its cancellation and timeout behavior is insufficient for this runtime. The implementation remains a direct `fetch` client.
- `read_web` always uses a restricted direct Worker `fetch`. URL, redirect, network, media-type, size, timeout, and content handling are security boundaries and must not be delegated to a general-purpose SDK.

## QQ integration decision

`pingBot` uses `@tencent-connect/qqbot-nodejs`, but that project runs on Node 20 + Nitro. This project deliberately does not carry that SDK into the Worker as a whole; only isolated REST or protocol subset validation is permitted.

The QQ boundary is split into two small responsibilities:

- callback verification and event normalization in `packages/qqbot`
- official HTTP API calls for access tokens and outgoing messages in `QQBotClient`

The default endpoints are configurable:

- token: `https://bots.qq.com/app/getAppAccessToken`
- API: `https://api.sgroup.qq.com`

The callback body is always read as raw bytes before verification. Web content and incoming message text are untrusted data and never receive tool authority. A supported callback is acknowledged only after Agent SQLite insertion and scheduling; duplicate event IDs are ignored.

## Persistence boundary

The first version uses the Agent's own SQLite storage for per-conversation runtime state. Agent names are `qq:group:{group_openid}` and `qq:c2c:{user_openid}`. D1, R2 and external queues are deliberately deferred until a measured requirement appears.

## Configuration and retention

The four required secrets are `QQ_APP_ID`, `QQ_APP_SECRET`, `LLM_API_KEY`, and `EXA_API_KEY`; production values are Wrangler Secrets and there is no dashboard or online prompt editor. The source-controlled persona is `apps/worker/src/prompts/system-prompt.md`. `CONTEXT_MESSAGE_LIMIT` and `MESSAGE_RETENTION_LIMIT` control visible context and cleanup. Cleanup deletes only the oldest visible chat rows; Memory, turns, tool-call audit records, and outbound delivery records remain durable. Each model tool call is persisted in `tool_calls` with its name, bounded/redacted argument metadata, status, and bounded/redacted result metadata; complete arguments and results are never stored or copied into later model context.

The full frozen design is `docs/superpowers/specs/2026-09-15-qq-companion-runtime-design.md`.

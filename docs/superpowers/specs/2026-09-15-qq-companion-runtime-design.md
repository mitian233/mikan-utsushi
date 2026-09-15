# QQ Companion Runtime Design

**Status:** Frozen on 2026-09-15

## 1. Purpose

This document defines the first runnable version of `mikan-utsushi`: a QQ group and direct-message companion hosted on Cloudflare Workers and Cloudflare Agents.

The product is not a Plastic Wan port and is not a general-purpose agent platform. It is one deployable QQ bot whose behavior is primarily defined by a source-controlled system prompt. The runtime supplies durable conversation state, model tool use, memory, web search, read-only web access, image input, and QQ message delivery.

The implementation optimizes for a small, understandable system that can run end to end before adding product controls or broader provider support.

## 2. Goals

The MVP must:

- receive and verify QQ webhook callbacks;
- support QQ group messages and C2C direct messages;
- durably store a supported message before acknowledging it;
- merge messages arriving within a fixed two-second window;
- execute only one model turn at a time for each Agent instance;
- call an OpenAI-compatible Chat Completions endpoint chosen through environment variables;
- support `tools` and `tool_calls` until the model ends the turn;
- let the model send zero, one, or multiple plain-text QQ messages;
- understand QQ image URLs when vision is enabled;
- keep explicit, per-conversation long-term memories;
- search with Exa and read public webpages through a self-hosted read-only fetcher;
- retain only a configurable number of visible chat messages;
- recover from transient failures without duplicating known-successful QQ sends.

## 3. Non-goals

The MVP does not include:

- a management dashboard or configuration UI;
- runtime prompt editing;
- multiple QQ applications in one deployment;
- identity linking across groups or between group and C2C OpenIDs;
- OpenAI Responses API, Anthropic Messages API, or provider-specific protocols;
- an OpenAI or Exa SDK;
- CLI, shell, code execution, filesystem access, browser automation, login, forms, or non-read-only web actions;
- vector search, embeddings, a vector database, or automatic memory summarization;
- D1, R2, Workers Queues, a VPS, Redis, or Postgres;
- outbound images, audio, video, files, or QQ Markdown templates;
- PDF parsing, dynamic browser rendering, or authenticated webpage reading.

## 4. Runtime identity and isolation

One stable QQ conversation maps to one Cloudflare Agent instance.

```text
group: qq:group:{group_openid}
c2c:   qq:c2c:{user_openid}
```

`QQ_APP_ID` is not part of the Agent name because the MVP hosts one QQ bot deployment.

For a group event:

- conversation identity comes from `d.group_openid`;
- member identity comes from `d.author.member_openid`.

For a C2C event:

- conversation and user identity come from `d.author.user_openid`.

OpenIDs are opaque. The runtime must not assume that a group `member_openid` and a C2C `user_openid` identify the same person. Every Agent has its own embedded SQLite database, so messages, turns, memories, and delivery state do not cross conversation boundaries.

## 5. Component architecture

```text
QQ webhook
  -> Worker signature verification and event normalization
  -> GroupChatAgent.receiveMessage()
  -> Agent SQLite inbox and event deduplication
  -> fixed two-second schedule
  -> immutable turn batch
  -> Agent FIFO queue
  -> OpenAI-compatible tool loop
       -> memory_* tools -> Agent SQLite
       -> search_web    -> Exa Search API
       -> read_web      -> restricted Worker fetch
       -> send_message  -> QQ HTTP API
  -> visible chat history and turn result
```

Package responsibilities:

- `apps/worker`: HTTP entry point, environment validation, Agent lifecycle, SQLite schema, batching, retries, tool execution, prompt assembly, and integration tests.
- `packages/contracts`: shared normalized message, model message, tool, turn, and delivery types.
- `packages/qqbot`: QQ payload parsing, callback signatures, token acquisition, and plain-text delivery.
- `packages/model-provider`: direct OpenAI-compatible Chat Completions client and protocol validation.
- `packages/web-tools`: Exa search, safe URL policy, limited fetch, redirect handling, and text extraction.

## 6. Configuration

Required secrets:

```text
QQ_APP_ID
QQ_APP_SECRET
LLM_API_KEY
EXA_API_KEY
```

Required non-secret model settings:

```text
LLM_CHAT_COMPLETIONS_URL
LLM_MODEL
```

Optional settings and defaults:

```text
QQ_API_BASE=https://api.sgroup.qq.com
QQ_TOKEN_URL=https://bots.qq.com/app/getAppAccessToken
VISION_ENABLED=true
CONTEXT_MESSAGE_LIMIT=50
MESSAGE_RETENTION_LIMIT=5000
```

`LLM_CHAT_COMPLETIONS_URL` is the complete request URL. The runtime must not append `/v1` or `/chat/completions`.

`CONTEXT_MESSAGE_LIMIT` and `MESSAGE_RETENTION_LIMIT` must be positive integers, and retention must not be less than the context limit. Invalid or missing required values produce a configuration error before a supported message is accepted for processing. Secrets must never be included in prompts, stored messages, tool results, or ordinary logs.

The default development example may use DeepSeek:

```text
LLM_CHAT_COMPLETIONS_URL=https://api.deepseek.com/chat/completions
LLM_MODEL=deepseek-chat
```

Any endpoint is allowed if it implements the required OpenAI-compatible Chat Completions shape, including function calling.

## 7. Source-controlled prompt

The system prompt lives at:

```text
apps/worker/src/prompts/system-prompt.md
```

Wrangler imports `**/*.md` through a `Text` module rule. TypeScript receives a local `declare module "*.md"` declaration. The prompt is bundled at build time; the Worker never reads from a runtime filesystem.

The Markdown file controls persona, language, conversational behavior, and guidance such as avoiding unnecessary multi-message replies. Users edit the source and redeploy.

Enforced boundaries remain outside the prompt: webhook authentication, allowed tool implementations, secret handling, timeouts, URL policy, response size limits, and delivery retry rules are code-level guarantees.

## 8. Webhook contract

The Worker exposes:

```text
GET  /health
POST /webhooks/qq
```

QQ callback validation (`op = 13`) is handled before dispatch signature verification and returns the QQ validation signature response.

For dispatch callbacks:

1. Read the exact raw request bytes.
2. Parse JSON and validate the envelope.
3. Require and verify QQ Ed25519 signature headers.
4. Normalize supported group and C2C message events.
5. Select the Agent name from the normalized conversation identity.
6. Call `receiveMessage` and wait for durable insertion and scheduling.
7. Return QQ callback ACK.

HTTP behavior:

| Situation | Response |
|---|---:|
| Empty, malformed, or structurally invalid payload | `400` |
| Missing or invalid signature | `401` |
| Valid but unsupported event | QQ ACK with `200` |
| Duplicate event | QQ ACK with `200` |
| Message persisted and processing scheduled | QQ ACK with `200` |
| Agent persistence or scheduling failed | `503` |

The webhook must not wait for batching, model calls, tools, or QQ message delivery.

## 9. Normalized message contract

```ts
interface ChatMessage {
  platform: "qq";
  eventId: string;
  messageId: string;
  chatId: string;
  chatKind: "group" | "c2c";
  userId: string;
  username?: string;
  text?: string;
  images: Array<{ url: string; fileId?: string }>;
  replyToMessageId?: string;
  timestamp: number;
}
```

`eventId` uses the QQ event envelope ID, falling back to message ID only when the envelope does not provide one. Supported events with neither text nor images are acknowledged but not inserted as chat messages.

The normalizer stores QQ-provided attachment URLs. The MVP does not download, base64-encode, or copy images to R2.

## 10. Durable ingestion and batching

`receiveMessage` performs one durable transaction-equivalent sequence inside the Agent:

1. Create the schema if needed.
2. `INSERT OR IGNORE` the inbound message by unique `event_id`.
3. If the insert was ignored, return `{ accepted: true, duplicate: true }` without scheduling another batch.
4. If no flush is scheduled for the current pending set, persist the scheduled marker and call `schedule(2, "flushPending", {})`.
5. Return only after insertion and schedule creation have completed.

The two-second window is fixed from the first pending message. Later messages join the pending set but do not cancel or move the schedule.

`flushPending`:

1. clears the flush marker;
2. snapshots all currently pending message IDs in insertion order;
3. creates one immutable `turns` row;
4. records the membership in `turn_messages`;
5. changes those message rows from `pending` to `batched`;
6. queues `runTurn` with the turn ID;
7. if messages arrived after the snapshot, ensures another two-second flush is scheduled.

The Agent SDK queue provides FIFO execution for `runTurn`. Messages arriving during a running turn remain pending and are assigned to a later turn.

## 11. SQLite model

Each Agent database contains these tables.

### `messages`

Stores only chat-visible inbound and outbound content.

```text
id INTEGER PRIMARY KEY AUTOINCREMENT
event_id TEXT UNIQUE                  -- inbound only
message_id TEXT                       -- QQ ID when known
direction TEXT NOT NULL               -- inbound | outbound
chat_kind TEXT NOT NULL               -- group | c2c
user_id TEXT                          -- inbound sender
username TEXT
text TEXT
images_json TEXT NOT NULL
reply_to_message_id TEXT
status TEXT NOT NULL                  -- pending | batched | visible | failed
created_at INTEGER NOT NULL
turn_id TEXT
```

### `turns`

```text
id TEXT PRIMARY KEY
status TEXT NOT NULL                  -- queued | running | retry_wait | completed | failed
attempt_count INTEGER NOT NULL
first_message_at INTEGER NOT NULL
started_at INTEGER
completed_at INTEGER
has_sent INTEGER NOT NULL DEFAULT 0
last_error TEXT
created_at INTEGER NOT NULL
```

### `turn_messages`

```text
turn_id TEXT NOT NULL
message_id INTEGER NOT NULL
position INTEGER NOT NULL
PRIMARY KEY (turn_id, message_id)
```

### `tool_calls`

```text
turn_id TEXT NOT NULL
id TEXT NOT NULL                       -- provider tool_call.id within the turn
name TEXT NOT NULL
arguments_json TEXT NOT NULL
result_json TEXT
status TEXT NOT NULL                  -- running | completed | failed
created_at INTEGER NOT NULL
completed_at INTEGER
PRIMARY KEY (turn_id, id)
```

### `outbound_deliveries`

```text
id TEXT PRIMARY KEY
turn_id TEXT NOT NULL
tool_call_id TEXT NOT NULL
content TEXT NOT NULL
reply_to_message_id TEXT
status TEXT NOT NULL                  -- planned | sent | failed | outcome_unknown
platform_message_id TEXT
attempt_count INTEGER NOT NULL
last_error TEXT
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
UNIQUE (turn_id, tool_call_id)
```

### `memories`

```text
id TEXT PRIMARY KEY
scope TEXT NOT NULL                   -- group | user:{QQ OpenID}
content TEXT NOT NULL
source_message_id TEXT
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
last_used_at INTEGER
```

Indexes cover message status/order, turn status, memory scope/update time, and memory scope/content lookup.

## 12. Visible context

The model receives only:

- the bundled system prompt;
- up to `CONTEXT_MESSAGE_LIMIT` recent visible inbound and outbound messages for this Agent;
- all inbound messages in the current turn, in original order;
- current-turn assistant tool-call messages and tool results.

Historical tool calls, retries, errors, internal states, and old tool results are never copied into later model turns. Long-term memory is not automatically injected; the model calls `memory_search` when it needs remembered information.

After a completed turn, the runtime deletes the oldest visible chat rows beyond `MESSAGE_RETENTION_LIMIT`. Memory rows, turn audit rows, and delivery records are unaffected by chat retention in the MVP.

## 13. OpenAI-compatible model loop

The model client sends `POST` to the exact configured URL with:

```http
Authorization: Bearer <LLM_API_KEY>
Content-Type: application/json
```

The request contains `model`, `messages`, and the runtime's function definitions in `tools`. It does not use provider-specific fields.

When `VISION_ENABLED=true`, each current inbound image becomes an OpenAI-compatible content part:

```json
{
  "type": "image_url",
  "image_url": { "url": "https://..." }
}
```

When vision is disabled, image metadata remains stored but no image part is sent. The configured model is responsible for supporting and accessing image URLs.

Loop behavior:

1. Start a 120-second turn deadline covering all model and tool calls.
2. Request a completion.
3. Validate that exactly one usable assistant choice exists.
4. If the assistant returns tool calls, append the assistant message, execute calls in listed order, append one tool result per call, and request another completion.
5. If no tool calls are returned, finish the turn.

There is no tool-call-count limit. The model ends the turn by returning no more tool calls. Plain assistant `content` is not sent to QQ automatically; only `send_message` has an external messaging effect.

## 14. Runtime tools

### `send_message`

```ts
send_message({ content: string, reply_to_message_id?: string })
```

Sends plain text to the current Agent conversation. The model may invoke it multiple times, but the system prompt asks it to avoid unnecessary fragmentation except when the conversation naturally requires separate messages, such as a character-chain game.

The target conversation is never supplied by the model. The runtime derives it from Agent identity, preventing cross-conversation sends.

### Memory tools

```ts
memory_search({ query?: string, scope?: "group" | "user" })
memory_write({ content: string, scope: "group" | "user", source_message_id?: string })
memory_update({ id: string, content: string })
memory_delete({ id: string })
```

For `scope: "user"`, the runtime resolves the current inbound speaker to `user:{QQ OpenID}`. A model-supplied user ID is never accepted.

`memory_search` uses escaped SQLite `LIKE` matching within the selected scope. An empty query returns recently updated memories. The runtime performs no automatic memory writes.

### `search_web`

```ts
search_web({ query: string })
```

Uses direct `fetch` to `POST https://api.exa.ai/search` with `x-api-key: EXA_API_KEY`, `type: "auto"`, and `numResults: 5`. It returns a compact array containing title, URL, and optional highlight/snippet text. It does not use Exa to read a selected webpage.

### `read_web`

```ts
read_web({ url: string })
```

Reads one absolute `http` or `https` URL with these limits:

- GET only;
- no URL credentials, cookies, authorization headers, or QQ/model credentials;
- reject localhost, internal suffixes, metadata hosts, and private, loopback, link-local, multicast, unspecified, or reserved literal IPv4/IPv6 addresses;
- apply destination validation before the first request and every redirect;
- follow at most three redirects manually;
- abort after 15 seconds total;
- stop after 2 MB of response bytes;
- accept HTML, text, Markdown, JSON, and XML media types only;
- extract useful text with Worker `HTMLRewriter`, preferring document content and removing scripts, styles, templates, SVG, and navigation noise;
- normalize whitespace and truncate the final result to 30,000 characters.

DNS resolution checks should be isolated behind an injectable resolver so the runtime can reject DNS answers containing non-public addresses where the Cloudflare environment exposes reliable resolution. Host and redirect validation remains mandatory regardless of resolver availability.

Search results and webpage content are wrapped as untrusted tool output. Text inside them cannot alter system instructions, obtain secrets, expand tool authority, or cause non-read-only web requests.

## 15. QQ delivery semantics

`QQBotClient` sends plain text to:

```text
group: POST /v2/groups/{group_openid}/messages
c2c:   POST /v2/users/{user_openid}/messages
```

`reply_to_message_id`, when supplied, becomes QQ `msg_id`. The client returns a normalized result containing the QQ message ID when the platform provides one.

Before sending, `send_message` inserts an `outbound_deliveries` row with `planned` status. Outcomes are handled as follows:

- successful QQ response: mark `sent`, insert the outbound visible message, and set `turns.has_sent=1`;
- explicit non-success response: mark `failed`; the same delivery may retry under the QQ client policy;
- timeout or transport result where platform acceptance is unknown: mark `outcome_unknown` and do not resend automatically.

Once a turn has a successful or unknown-outcome send, a later model/tool failure does not restart the whole turn. This prevents known or potentially accepted messages from being emitted again.

## 16. Retry and completion behavior

A failure before the first external send may retry the turn up to three times after 5, 30, and 120 seconds. A retry schedule records the next attempt durably and requeues the existing immutable turn; it does not create another batch.

Each attempt receives a fresh 120-second deadline. Completed tool-call records are retained for diagnosis, but retries before any send start a fresh model transcript from the visible context and immutable inbound turn messages.

After all retries fail, the turn is marked `failed` and its inbound message rows remain retained. The runtime does not manufacture a user-facing apology unless the model successfully calls `send_message` in a later turn.

Successful completion means the model returned no further tool calls, regardless of whether it sent a QQ message. The turn becomes `completed`, inbound rows become `visible`, and retention cleanup runs.

## 17. Logging and observability

Structured logs may include:

- event ID, turn ID, Agent identity hash, and event type;
- ingestion, batching, queueing, turn, model, tool, and QQ delivery durations;
- attempt counts and normalized error categories;
- model token usage when provided;
- delivery state, excluding message content.

Logs must not include secrets, raw authorization headers, complete model prompts, complete webpage bodies, or private message text by default.

`GET /health` reports service availability and non-secret configuration validity. It does not call QQ, Exa, or the model endpoint.

## 18. Test strategy

Tests use Vitest and Cloudflare's Workers test pool.

Required test groups:

- QQ callback validation and Ed25519 fixtures;
- group/C2C identity, text, image, and reply normalization;
- duplicate webhook ACK and durable deduplication;
- fixed two-second batching and messages arriving during a running turn;
- FIFO turn execution and retry scheduling;
- environment defaults and invalid configuration;
- exact Chat Completions payloads, tool-call transcripts, image gating, and 120-second cancellation;
- memory scope isolation and keyword escaping;
- Exa request shape and compact result mapping;
- URL, IP, redirect, media type, size, timeout, extraction, and prompt-injection handling for `read_web`;
- QQ successful, explicit-failure, and unknown-outcome delivery states;
- visible-context filtering and message retention;
- one end-to-end group flow and one end-to-end C2C flow with all external HTTP calls mocked.

No acceptance test requires real credentials, Cloudflare deployment, or paid external API calls.

## 19. MVP acceptance criteria

The MVP is accepted when:

1. A valid group or C2C webhook is acknowledged only after durable insertion.
2. Invalid signatures are rejected and unsupported valid events are safely acknowledged.
3. Duplicate event IDs cannot create duplicate turns or sends.
4. Messages in the fixed two-second window form one immutable turn.
5. Messages arriving during a turn are processed by a later turn.
6. Each Agent processes its turns in FIFO order and remains isolated from other Agents.
7. A configurable OpenAI-compatible endpoint can complete a multi-step tool loop.
8. Only `send_message` causes QQ output, and multiple calls are supported.
9. Vision-enabled turns contain QQ image URLs; vision-disabled turns do not.
10. Memory tools preserve group and current-group-member isolation.
11. Exa search and restricted direct webpage reading work through mocked contract tests.
12. Retry behavior does not repeat known-successful or unknown-outcome sends.
13. Historical model context contains only visible messages, while retention settings are enforced.
14. Type checking, unit tests, Worker integration tests, and a production Worker build succeed.

## 20. Deferred decisions

The following require real usage evidence before design:

- management UI and remote prompt editing;
- multiple QQ apps in one deployment;
- cross-group identity or shared memory;
- richer outbound media;
- dynamic browser rendering and PDF extraction;
- other model protocols;
- vector memory, summarization, and semantic retrieval;
- R2-backed image persistence;
- product-level trigger policies or forced reply behavior.

## 21. Implementation sequence

1. Pin dependencies, generate Worker types, and add a deterministic test harness.
2. Finalize configuration, prompt import, contracts, and QQ normalization.
3. Implement durable ingestion, fixed batching, FIFO turns, and retries.
4. Implement the OpenAI-compatible model client and vision-aware tool loop.
5. Implement Memory, Exa search, and direct webpage reading.
6. Connect tool execution to QQ delivery with durable outcome records.
7. Add context retention, end-to-end tests, and operator documentation.

The detailed task breakdown is maintained in `docs/superpowers/plans/2026-09-15-qq-companion-runtime.md`.

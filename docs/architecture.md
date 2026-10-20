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
  ├─ qq_events tombstones + qq_messages inbox and immutable batches
  ├─ fixed two-second schedule + FIFO qq_turns
  ├─ qq_attempts: absolute deadline, budget and visible-input snapshot
  └─ Pi Harness: generation / tool task / submission checkpoints
       ├─ project Chat Completions provider adapter
       ├─ memory_* + transactional qq_effect_receipts
       ├─ Exa search_web + restricted direct read_web
       └─ send_message(send|silent), the only normal terminal decision
              ├─ qq_deliveries turn-level barrier before network I/O
              ├─ sent / failed / outcome_unknown / silent
              └─ unique visible outbound history
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

Each stable Agent owns one SQLite database under `qq:group:{group_openid}` or `qq:c2c:{user_openid}`. Initialization supports both a fresh database and the pre-Pi application's unversioned SQLite schema. The existing Worker, class, binding and namespace stay in place. D1, R2 and external queues remain outside the architecture.

Pi Durable, Pi AI and Chord are pinned to `0.99.2`; Agents is pinned to `0.23.0`. These SDK paths are exercised in workerd. The installed Pi version uses synchronous SQLite transactions: `DurableSqliteDatabase` consumes cursors synchronously and wraps each storage commit in `transactionSync`, rejects async transaction callbacks, and closes only its SDK handle. Research against the later 1.0.0 source does not define this adapter's API.

Each business attempt has an isolated Pi conversation. Conversation creation and `app.qq-attempt-link` are committed together; recovery reacquires a submission through the stable `qq-turn:{turnId}:attempt:{attempt}` request ID. Pi owns execution position. The business tables own FIFO, retry times, immutable input and terminal outcome; fibers keep execution alive and alarms reconcile persisted work. Initialization arranges recovery without waiting for a whole model run.

The default budget is six logical generation tasks and a persisted 120-second deadline. Restarting a generation preserves its identity and remaining time. Provider and Pi automatic retries and compaction are disabled. Business failures retry after 5/30/120 seconds. Ordinary model text continues through `onYield`; only a single send/silent call terminates normally, and mixed terminal rounds execute no effects.

Memory writes and replay receipts commit together. QQ planned/sent/unknown/silent barriers are keyed by business turn, so a changed task or call ID cannot create a new send allowance. Recovery converts an abandoned plan to unknown; it never retries a successful or uncertain send.

Legacy import runs inside the constructor's synchronous storage transaction, before lifecycle recovery or RPC. UUID turns receive integer IDs in the original FIFO order, with durable `qq_legacy_turn_ids` mappings. Message IDs and their AUTOINCREMENT watermark, existing event IDs, scoped Memory and bounded audit metadata survive. Opted-in old debug traces move to `qq_legacy_turn_debug`; legacy ledger metadata remains in `qq_legacy_deliveries`. Retained-away chat is not resurrected. Multiple historical outputs use additional settled historical turns to satisfy the new one-output-per-delivery constraint.

Queued/pending work continues. Retry budgets survive; startup imports the persisted SDK retry deadline and cancels old callbacks through the public scheduler API. A missing schedule uses the old start time plus its maximum attempt duration and retry delay. Old running work has no Pi checkpoint and fails with `legacy_interrupted`, unless a terminal send/silent record already permits settlement. Sent, unknown and abandoned planned sends remain barriers. Migration creates no fictitious Pi attempts, conversations or tasks; legacy barrier task IDs are local positive surrogates derived from their migrated turn IDs. Original tables and obsolete application KV markers are removed only on successful commit; structural, identity or mixed-source errors roll back. Deployment and restore constraints are in [deployment.md](deployment.md).

## Code Mode

Code Mode is an optional `codemode` tool on the QQ Agent. The model submits one JavaScript script; the host runs it through `RemoteCodemodeSandbox` in the separate Worker `mikan-utsushi-codemode-sandbox`. The host binding is `CODEMODE_SANDBOX` with `class_name` `CodemodeSandbox` and `script_name` `mikan-utsushi-codemode-sandbox`. Each execution calls `getByName` with a new random id, so the sandbox name does not contain a chat id and VM state is not reused. The sandbox Worker answers ordinary HTTP with 404, holds no business secrets, and does not read or write the Agent database. Only that Worker imports the Cloudflare WASM entry; Wrangler bundles the WASM at build time.

A script may call `memory_search` and `conversation_search` by those bare names, plus MCP tools configured as `read` or `write`. MCP tools are exposed as `mcp__<server>__<tool>`. Discovery, the allow list and JSON Schema validation all run before a call is admitted, so a rejected argument never creates a `qq_codemode_calls` row or an `outcome_unknown` write barrier; only a call that reached the provider can leave an unknown outcome. Each execution owns its MCP sessions and closes them when the script ends, so a helper still running after the script returns cannot outlive the turn. `memory_write`, `send_message`, and tools marked `hidden` are not available inside the script. `send_message` remains a separate host tool and is still the only QQ output. MCP endpoints must be `https` URLs without userinfo; the production fetch path checks the URL and does not follow redirects. `MCP_SERVERS` is the server map. `MCP_CREDENTIALS` supplies per-server headers and is a secret.

Limits, from `packages/contracts/src/codemode.ts`: source, parameter, and output 32 KiB; tool result 128 KiB; QuickJS memory 16 MiB; interrupt budget 10,000; 16 business calls; 2 calls in flight; 16 helper calls; 30-second script deadline, also capped by the attempt deadline. An oversized script result is `output_limit`.

An aborted script is recorded and then thrown, so Pi leaves that tool task uncommitted and resumes it as interrupted instead of running the script again. A write whose response is dropped stays `outcome_unknown`. Another write on the same turn is rejected with `write_barrier`. Recovery does not retry the remote call, roll it back, or claim exactly-once delivery. Design and plan: [QuickJS Code Mode design](superpowers/specs/2026-10-20-quickjs-do-codemode-design.md), [implementation plan](superpowers/plans/2026-10-20-quickjs-do-codemode.md).

## Configuration and retention

The four required secrets are `QQ_APP_ID`, `QQ_APP_SECRET`, `LLM_API_KEY`, and `EXA_API_KEY`; production values are Wrangler Secrets. The source-controlled persona is `apps/worker/src/prompts/system-prompt.md`. `CONTEXT_MESSAGE_LIMIT` controls visible context; `MESSAGE_RETENTION_LIMIT` cleanup runs every tenth settled turn. Event tombstones, Memory, business metadata, delivery barriers and `qq_tool_audit` bounded/redacted summaries remain durable. Unknown, invalid and blocked tool calls also retain failed audit metadata without their raw names or bodies.

An active attempt requires its private snapshot, Pi transcript and replay results. After the business turn is terminal, the host aborts remaining work, retires its link and closes the Harness; the fixed-version adapter atomically removes that attempt's execution records and clears snapshots, receipt results and delivery body. It preserves global ID allocation and rejects live/referenced work. Explicit `TURN_DEBUG_ENABLED=true` records raw model requests/responses and structured turn errors in `qq_turn_debug`; these records remain separate and are never ordinary logs or subsequent context.

The current data contract is [Pi Durable database design](superpowers/specs/2026-10-03-pi-durable-database-design.md); implementation and acceptance are tracked in [the migration plan](superpowers/plans/2026-10-03-pi-durable-runtime-migration.md).

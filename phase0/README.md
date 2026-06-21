# Phase 0 — LiteLLM `/v1/messages` spike

**Goal:** before writing any control-plane code, de-risk the single biggest assumption behind the
"embed LiteLLM as the data plane" decision — that LiteLLM faithfully proxies the **Anthropic
`/v1/messages`** format (which the hara CLI speaks) with **streaming + tool calls**, against an
**OpenAI-compatible** upstream (DashScope/Qwen/GLM compatible-mode).

## Result — ✅ PASS

```
✓ streaming text   — text="Hello from the mock upstream."
✓ streaming tool   — tool=get_weather input={"location":"San Francisco"}
PHASE-0 PASS: /v1/messages survives streaming + tool calls end-to-end.
```

Validated against a local OpenAI-compatible mock upstream (no real provider key burned).

## ⚠️ Critical finding — `use_chat_completions_url_for_anthropic_messages`

LiteLLM 1.89 routes `/v1/messages` for **`openai/`-provider** models to the OpenAI **Responses API**
(`/v1/responses`) by default. OpenAI-compatible upstreams (DashScope/Qwen/GLM compatible-mode) **only
expose `/chat/completions`, not `/v1/responses`** — so the default 404s against them.

The fix (already in [`litellm/config.yaml`](../litellm/config.yaml)) is mandatory for our upstreams:

```yaml
litellm_settings:
  use_chat_completions_url_for_anthropic_messages: true
```

This is a **production** setting, not a mock workaround.

## Run it

### Mock leg (no key, deterministic) — what CI/repro uses
```bash
bash phase0/run-spike.sh            # defaults to model=glm-mock
```

### Real leg (real upstream) — run yourself with a NON-coding-plan key
```bash
cp .env.example .env
# edit .env:
#   UPSTREAM_API_KEY=<a regular pay-as-you-go DashScope key — NOT an sk-sp- coding-plan key>
#   UPSTREAM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
#   UPSTREAM_MODEL / the model id in litellm/config.yaml's glm-5 entry
bash phase0/run-spike.sh glm-5
```
> The coding-plan key (`sk-sp-…`) is for coding tools only — never feed it to a gateway/backend like
> LiteLLM. Use a regular DashScope API key for the gateway.
>
> The real-leg tool assertion depends on the live model choosing to call the tool for
> "what's the weather in SF" — normally it does, but unlike the mock it isn't 100% deterministic.

## What's here
- `mock-upstream.mjs` — minimal OpenAI-compatible `/v1/chat/completions` mock (streams text or a tool call).
- `test-messages.mjs` — sends Anthropic `/v1/messages` (streaming) through LiteLLM, asserts text + tool round-trips.
- `run-spike.sh` — boots the mock + LiteLLM (via `uvx`, no Docker), waits for readiness, runs the test, tears down.

No Docker required (uses `uvx --python 3.12 --from 'litellm[proxy]' litellm`). Docker path lands in Phase 1.

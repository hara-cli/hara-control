// Phase-0 mock upstream: a minimal OpenAI-compatible /v1/chat/completions server.
// LiteLLM treats this as the "openai/glm-mock" provider. It lets us exercise the
// full Anthropic /v1/messages -> OpenAI translation (streaming + tool calls)
// WITHOUT burning any real provider key.
//
// Behavior:
//   - if the request carries `tools` AND the last user message mentions "weather",
//     it streams an OpenAI tool_call (function get_weather) — proving tool calls survive.
//   - otherwise it streams a short text completion — proving plain text + streaming survive.
import http from "node:http";

const PORT = Number(process.env.MOCK_UPSTREAM_PORT) || 8899;

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch {
        resolve({});
      }
    });
  });

const wantsTool = (body) => {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string"
    ? lastUser.content
    : JSON.stringify(lastUser?.content ?? "");
  return hasTools && /weather/i.test(text);
};

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

const server = http.createServer(async (req, res) => {
  if (!req.url.endsWith("/chat/completions") || req.method !== "POST") {
    res.writeHead(404).end("not found");
    return;
  }
  const body = await readBody(req);
  const streaming = body.stream === true;
  const model = body.model || "glm-mock";
  const id = "chatcmpl-mock-1";
  const base = { id, object: "chat.completion.chunk", created: 0, model };

  if (!streaming) {
    // non-streaming path (kept simple)
    const message = wantsTool(body)
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_mock_1", type: "function", function: { name: "get_weather", arguments: '{"location":"San Francisco"}' } }] }
      : { role: "assistant", content: "Hello from the mock upstream." };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id,
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message, finish_reason: wantsTool(body) ? "tool_calls" : "stop" }],
      // Real OpenAI-compatible providers report usage on non-streaming completions. Supplying it in
      // the mock keeps LiteLLM's spend ledger deterministic instead of depending on a tokenizer
      // fallback for the deliberately synthetic model names used by this E2E.
      usage: {
        prompt_tokens: 1,
        completion_tokens: 6,
        total_tokens: 7,
      },
    }));
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });

  if (wantsTool(body)) {
    sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] });
    for (const piece of ['{"location":', '"San Francisco"}']) {
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }] });
    }
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    for (const piece of ["Hello", " from", " the", " mock", " upstream."]) {
      sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    }
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(PORT, () => console.log(`[mock-upstream] OpenAI-compatible mock on http://localhost:${PORT}/v1`));

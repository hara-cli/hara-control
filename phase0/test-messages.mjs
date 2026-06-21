// Phase-0 verification: send Anthropic-format /v1/messages requests (streaming)
// through LiteLLM and assert the round-trip survives — this is the #1 risk for the
// "embed LiteLLM" decision. Two scenarios: plain streaming text, and a tool call.
//
// Exit 0 = both pass. Non-zero = a leg failed (prints why).
const LITELLM = `http://localhost:${process.env.LITELLM_PORT || 4000}`;
const KEY = process.env.LITELLM_MASTER_KEY || "sk-hara-master-dev-change-me";
const MODEL = process.argv[2] || "glm-mock"; // pass "glm-5" to hit the real upstream

async function streamMessages(payload) {
  const res = await fetch(`${LITELLM}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 256, stream: true, ...payload }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);

  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const block of blocks) {
      let ev = null, data = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (data && data !== "[DONE]") {
        try { events.push({ ev, ...JSON.parse(data) }); } catch { /* skip */ }
      }
    }
  }
  return events;
}

const ok = (c, m) => { if (!c) throw new Error(`assertion failed: ${m}`); };

async function testText() {
  const ev = await streamMessages({ messages: [{ role: "user", content: "Say hello." }] });
  ok(ev.some((e) => e.type === "message_start"), "saw message_start");
  const text = ev.filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
    .map((e) => e.delta.text).join("");
  ok(text.length > 0, `accumulated streamed text (got: ${JSON.stringify(text)})`);
  ok(ev.some((e) => e.type === "message_stop"), "saw message_stop");
  return `text="${text}"`;
}

async function testTool() {
  const ev = await streamMessages({
    tools: [{ name: "get_weather", description: "Get the weather for a location",
      input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } }],
    messages: [{ role: "user", content: "What's the weather in San Francisco?" }],
  });
  const start = ev.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
  ok(start, "saw a tool_use content block");
  ok(start.content_block.name === "get_weather", `tool name is get_weather (got ${start.content_block?.name})`);
  const json = ev.filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
    .map((e) => e.delta.partial_json).join("");
  const parsed = JSON.parse(json || "{}");
  ok(parsed.location, `tool input has a location (got: ${json})`);
  const md = ev.find((e) => e.type === "message_delta");
  ok(md?.delta?.stop_reason === "tool_use", `stop_reason is tool_use (got ${md?.delta?.stop_reason})`);
  return `tool=get_weather input=${json}`;
}

(async () => {
  console.log(`[test] model=${MODEL} -> ${LITELLM}/v1/messages`);
  try {
    console.log(`  ✓ streaming text   — ${await testText()}`);
    console.log(`  ✓ streaming tool   — ${await testTool()}`);
    console.log("\nPHASE-0 PASS: /v1/messages survives streaming + tool calls end-to-end.");
    process.exit(0);
  } catch (e) {
    console.error(`\nPHASE-0 FAIL: ${e.message}`);
    process.exit(1);
  }
})();

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const productionNginx = readFileSync(
  resolve("deploy/nanhara-tech/nginx-gw.nanhara.tech.conf"),
  "utf8",
);
const exampleNginx = readFileSync(resolve("deploy/examples/nginx-control-plane.conf"), "utf8");
const exampleCaddy = readFileSync(resolve("deploy/examples/Caddyfile"), "utf8");

const dataPlanePaths = ["chat", "messages", "models", "responses"];

test("production nginx sends all supported inference protocols to LiteLLM", () => {
  for (const path of dataPlanePaths) {
    const route = new RegExp(
      `location \\/v1\\/${path} \\{[\\s\\S]*?proxy_pass http:\\/\\/127\\.0\\.0\\.1:4000;[\\s\\S]*?\\}`,
    );
    assert.match(productionNginx, route, `/v1/${path} must terminate at LiteLLM`);
  }
  assert.ok(
    productionNginx.indexOf("location /v1/responses")
      < productionNginx.indexOf("location /v1/ {"),
    "the Codex Responses route must precede the control-plane fallback",
  );
});

test("self-host examples keep Responses and Messages on the metered data plane", () => {
  for (const path of dataPlanePaths) {
    assert.match(exampleNginx, new RegExp(`location \\/v1\\/${path}`));
    assert.match(exampleCaddy, new RegExp(`\\/v1\\/${path}`));
  }
});

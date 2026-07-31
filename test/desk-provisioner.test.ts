import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  DeskProvisioner,
  parseDeskProvisioning,
} from "../src/enroll/desk-provisioner";

test("Desk provisioning config is optional and rejects unsafe or credential-bearing URLs", () => {
  assert.equal(parseDeskProvisioning(undefined).size, 0);
  assert.throws(
    () => parseDeskProvisioning(JSON.stringify({
      org: { url: "http://desk.example.test", enrollKey: "secret" },
    })),
    /HTTPS origins/,
  );
  assert.throws(
    () => parseDeskProvisioning(JSON.stringify({
      org: { url: "https://user:secret@desk.example.test", enrollKey: "secret" },
    })),
    /HTTPS origins/,
  );
});

test("one Control enrollment can mint a separately scoped Desk binding", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(raw) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        agentId: "desk-member-a1",
        owner: "member@example.test",
        token: "desk-device-bearer",
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.HARA_DESK_PROVISIONING_JSON;
  process.env.HARA_DESK_PROVISIONING_JSON = JSON.stringify({
    "org-a": {
      url: `http://127.0.0.1:${address.port}`,
      enrollKey: "server-held-enrollment-secret",
    },
  });
  try {
    const provisioner = new DeskProvisioner();
    const result = await provisioner.provision({
      orgId: "org-a",
      owner: "member@example.test",
      deviceName: "member-mac",
    });
    assert.deepEqual(result, {
      url: `http://127.0.0.1:${address.port}`,
      agent_id: "desk-member-a1",
      owner: "member@example.test",
      token: "desk-device-bearer",
    });
    assert.equal(requestBody?.enrollKey, "server-held-enrollment-secret");
    assert.equal(requestBody?.owner, "member@example.test");
    assert.equal(requestBody?.client, "hara-control-enrollment");
  } finally {
    server.close();
    if (previous === undefined) delete process.env.HARA_DESK_PROVISIONING_JSON;
    else process.env.HARA_DESK_PROVISIONING_JSON = previous;
  }
});

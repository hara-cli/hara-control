import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  DeskProvisioner,
  parseDeskProvisioning,
} from "../src/enroll/desk-provisioner";
import type { TenantServiceBindingsService } from "../src/service-bindings/service-bindings.service";

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

test("an explicit inactive managed Desk binding always shadows legacy environment provisioning", async () => {
  const previous = process.env.HARA_DESK_PROVISIONING_JSON;
  process.env.HARA_DESK_PROVISIONING_JSON = JSON.stringify({
    org: { url: "https://legacy.example.invalid", enrollKey: "legacy-secret" },
  });
  try {
    for (const explicitState of ["PENDING_VERIFICATION", "DEGRADED", "DISABLED"]) {
      let resolutions = 0;
      const bindings = {
        deskProvisioningResolution: async () => {
          resolutions += 1;
          return { managedConfigured: true };
        },
        deskRevocationResolution: async () => {
          resolutions += 1;
          return { managedConfigured: true };
        },
      } as unknown as TenantServiceBindingsService;
      const provisioner = new DeskProvisioner(bindings);
      const result = await provisioner.provision({
        orgId: "org",
        owner: "member@example.test",
        deviceName: `member-mac-${explicitState}`,
        installationId: `device-${explicitState}`,
        platform: "darwin",
        version: "0.173.0",
        clientKind: "openai.codex",
      });
      assert.equal(result, undefined, `${explicitState} must not fall back to legacy config`);
      await assert.rejects(
        provisioner.revokeInstallation({
          orgId: "org",
          owner: "member@example.test",
          installationId: `device-${explicitState}`,
          expectedUrl: "https://legacy.example.invalid",
        }),
        /credential is unavailable/,
      );
      assert.equal(resolutions, 2);
    }
  } finally {
    if (previous === undefined) delete process.env.HARA_DESK_PROVISIONING_JSON;
    else process.env.HARA_DESK_PROVISIONING_JSON = previous;
  }
});

test("a degraded managed Desk binding still revokes its exact provisioned installation", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ revoked: true, alreadyRevoked: false }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const bindings = {
    deskRevocationResolution: async (orgId: string, expectedOrigin: string) => {
      assert.equal(orgId, "org-degraded");
      assert.equal(expectedOrigin, url);
      return {
        managedConfigured: true,
        target: { url, enrollKey: Buffer.from("degraded-control-only-secret") },
      };
    },
  } as unknown as TenantServiceBindingsService;
  try {
    const provisioner = new DeskProvisioner(bindings);
    assert.equal(await provisioner.revokeInstallation({
      orgId: "org-degraded",
      owner: "member@example.test",
      installationId: "device-degraded",
      expectedUrl: url,
    }), true);
    assert.deepEqual(requests, [{
      enrollKey: "degraded-control-only-secret",
      owner: "member@example.test",
      realmId: "org-degraded",
      installationId: "device-degraded",
    }]);
  } finally {
    server.close();
  }
});

test("one Control enrollment can mint a separately scoped Desk binding", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const requestBody = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ url: request.url ?? "", body: requestBody });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url === "/provisioning/installations/revoke"
        ? JSON.stringify({ revoked: true, alreadyRevoked: false })
        : JSON.stringify({
          agentId: "desk-member-a1",
          owner: "member@example.test",
          token: "desk-device-bearer",
          credentialGeneration: 1,
          realmId: "org-a",
          provisioningId: requestBody.provisioningId,
          protocolVersion: 1,
          client: "nanhara.hara-desktop",
          device: {
            installationId: "device-installation-a",
            revoked: false,
          },
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
      installationId: "device-installation-a",
      platform: "darwin",
      version: "0.1.160",
      clientKind: "nanhara.hara-desktop",
    });
    assert.deepEqual(result, {
      url: `http://127.0.0.1:${address.port}`,
      agent_id: "desk-member-a1",
      owner: "member@example.test",
      token: "desk-device-bearer",
      credential_generation: 1,
    });
    assert.equal(requests[0].body.enrollKey, "server-held-enrollment-secret");
    assert.equal(requests[0].body.owner, "member@example.test");
    assert.equal(requests[0].body.realmId, "org-a");
    assert.equal(requests[0].body.client, "nanhara.hara-desktop");
    assert.equal(requests[0].body.installationId, "device-installation-a");
    assert.equal(requests[0].body.deviceName, "member-mac");
    assert.equal(requests[0].body.platform, "darwin");
    assert.equal(requests[0].body.version, "0.1.160");
    assert.match(String(requests[0].body.provisioningId), /^control_[a-f0-9]{64}$/);
    assert.deepEqual(requests[0].body.capabilities, [
      "tasks",
      "comments",
      "organization-workbench",
      "session-lease",
    ]);
    assert.equal(await provisioner.revokeInstallation({
      orgId: "org-a",
      owner: "member@example.test",
      installationId: "device-installation-a",
      expectedUrl: `http://127.0.0.1:${address.port}`,
    }), true);
    assert.equal(requests[1].url, "/provisioning/installations/revoke");
    assert.deepEqual(requests[1].body, {
      enrollKey: "server-held-enrollment-secret",
      owner: "member@example.test",
      realmId: "org-a",
      installationId: "device-installation-a",
    });
  } finally {
    server.close();
    if (previous === undefined) delete process.env.HARA_DESK_PROVISIONING_JSON;
    else process.env.HARA_DESK_PROVISIONING_JSON = previous;
  }
});

test("Control rejects an old Desk that does not echo realm and provisioning identity", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push(request.url ?? "");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url === "/provisioning/installations/revoke"
        ? JSON.stringify({ revoked: true, alreadyRevoked: false })
        : JSON.stringify({
          agentId: "legacy-desk-agent",
          owner: body.owner,
          token: "legacy-looking-token",
          credentialGeneration: 1,
          client: body.client,
          device: {
            installationId: body.installationId,
            revoked: false,
          },
          // Deliberately omit realmId, provisioningId, and protocolVersion: this is the old protocol.
        }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.HARA_DESK_PROVISIONING_JSON;
  process.env.HARA_DESK_PROVISIONING_JSON = JSON.stringify({
    "org-legacy": {
      url: `http://127.0.0.1:${address.port}`,
      enrollKey: "server-held-enrollment-secret",
    },
  });
  try {
    const provisioner = new DeskProvisioner();
    await assert.rejects(
      provisioner.provisionForEnrollment({
        orgId: "org-legacy",
        owner: "member@example.test",
        deviceName: "member-mac",
        installationId: "device-legacy",
        platform: "darwin",
        version: "0.173.0",
        clientKind: "nanhara.hara-desktop",
      }),
      /remote installation was rolled back/,
    );
    assert.deepEqual(requests, ["/register", "/provisioning/installations/revoke"]);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.HARA_DESK_PROVISIONING_JSON;
    else process.env.HARA_DESK_PROVISIONING_JSON = previous;
  }
});

test("initial enrollment rejects mismatched Desk identity and compensates the exact installation", async () => {
  const requests: string[] = [];
  let cleanupPrepared = false;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(request.url ?? "");
      assert.equal(cleanupPrepared, true, "cleanup provenance is durable before /register arrives");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url === "/provisioning/installations/revoke"
        ? JSON.stringify({ revoked: true, alreadyRevoked: false })
        : JSON.stringify({
            agentId: "wrong-agent",
            owner: "another-member@example.test",
            token: "untrusted-token",
            client: "nanhara.hara-desktop",
            device: { installationId: "device-a", revoked: false },
          }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.HARA_DESK_PROVISIONING_JSON;
  process.env.HARA_DESK_PROVISIONING_JSON = JSON.stringify({
    org: { url: `http://127.0.0.1:${address.port}`, enrollKey: "control-only" },
  });
  try {
    const provisioner = new DeskProvisioner();
    await assert.rejects(provisioner.provisionForEnrollment(
      {
        orgId: "org",
        owner: "member@example.test",
        deviceName: "member-mac",
        installationId: "device-a",
        platform: "darwin",
        version: "0.1.160",
        clientKind: "nanhara.hara-desktop",
      },
      {
        onPrepared: async () => { cleanupPrepared = true; },
      },
    ), /remote installation was rolled back/);
    assert.deepEqual(requests, ["/register", "/provisioning/installations/revoke"]);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.HARA_DESK_PROVISIONING_JSON;
    else process.env.HARA_DESK_PROVISIONING_JSON = previous;
  }
});

test("a failed cleanup-provenance write prevents any remote Desk registration", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.HARA_DESK_PROVISIONING_JSON;
  process.env.HARA_DESK_PROVISIONING_JSON = JSON.stringify({
    org: { url: `http://127.0.0.1:${address.port}`, enrollKey: "control-only" },
  });
  try {
    const provisioner = new DeskProvisioner();
    await assert.rejects(
      provisioner.provisionForEnrollment(
        {
          orgId: "org",
          owner: "member@example.test",
          deviceName: "member-mac",
          installationId: "device-a",
          platform: "darwin",
          version: "0.1.160",
          clientKind: "nanhara.hara-desktop",
        },
        { onPrepared: async () => { throw new Error("database unavailable"); } },
      ),
      /database unavailable/,
    );
    assert.equal(requests, 0);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.HARA_DESK_PROVISIONING_JSON;
    else process.env.HARA_DESK_PROVISIONING_JSON = previous;
  }
});

test("secondary Agent provisioning failures never revoke the installation", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not-json");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.HARA_DESK_PROVISIONING_JSON;
  process.env.HARA_DESK_PROVISIONING_JSON = JSON.stringify({
    org: { url: `http://127.0.0.1:${address.port}`, enrollKey: "control-only" },
  });
  try {
    const provisioner = new DeskProvisioner();
    await assert.rejects(provisioner.provision({
      orgId: "org",
      owner: "member@example.test",
      deviceName: "member-mac",
      installationId: "device-a",
      platform: "darwin",
      version: "0.173.0",
      clientKind: "openai.codex",
      instanceId: "work",
    }), /retry the same client and instance/);
    assert.deepEqual(requests, ["/register"], "existing Hara and other Agent identities are untouched");
  } finally {
    server.close();
    if (previous === undefined) delete process.env.HARA_DESK_PROVISIONING_JSON;
    else process.env.HARA_DESK_PROVISIONING_JSON = previous;
  }
});

test("administrative Desk revocation fails closed when the installation is missing", async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ revoked: false, alreadyRevoked: false }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.HARA_DESK_PROVISIONING_JSON;
  process.env.HARA_DESK_PROVISIONING_JSON = JSON.stringify({
    org: { url: `http://127.0.0.1:${address.port}`, enrollKey: "control-only" },
  });
  try {
    const provisioner = new DeskProvisioner();
    await assert.rejects(provisioner.revokeInstallation({
      orgId: "org",
      owner: "member@example.test",
      installationId: "missing-device",
    }), /did not find the installation/);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.HARA_DESK_PROVISIONING_JSON;
    else process.env.HARA_DESK_PROVISIONING_JSON = previous;
  }
});

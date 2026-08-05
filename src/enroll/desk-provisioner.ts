import { Injectable, Optional } from "@nestjs/common";
import { safeFetch } from "../security/ssrf";
import { TenantServiceBindingsService } from "../service-bindings/service-bindings.service";

interface DeskProvisioningTarget {
  url: string;
  enrollKey: string;
}

export interface ProvisionedDeskBinding {
  url: string;
  agent_id: string;
  owner: string;
  token: string;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DESK_TOKEN_BYTES = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function deskOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw new Error("HARA_DESK_PROVISIONING_JSON contains an invalid Desk URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("HARA_DESK_PROVISIONING_JSON contains an invalid Desk URL");
  }
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
    || parsed.username
    || parsed.password
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("HARA_DESK_PROVISIONING_JSON Desk URLs must be HTTPS origins");
  }
  return parsed.origin;
}

/** Parse an operator-owned secret mapping without ever returning it from an API.
 *
 * Shape:
 * {"<organization-id>":{"url":"https://desk.example.com","enrollKey":"..."}}
 */
export function parseDeskProvisioning(
  raw: string | undefined,
): Map<string, DeskProvisioningTarget> {
  const targets = new Map<string, DeskProvisioningTarget>();
  if (!raw?.trim()) return targets;
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("HARA_DESK_PROVISIONING_JSON is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HARA_DESK_PROVISIONING_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("HARA_DESK_PROVISIONING_JSON must be an organization map");
  }
  for (const [orgId, value] of Object.entries(parsed)) {
    if (
      !orgId
      || orgId.length > 128
      || CONTROL_CHARACTERS.test(orgId)
      || !value
      || typeof value !== "object"
      || Array.isArray(value)
    ) {
      throw new Error("HARA_DESK_PROVISIONING_JSON contains an invalid organization entry");
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.enrollKey !== "string"
      || !entry.enrollKey
      || entry.enrollKey.length > 4096
      || CONTROL_CHARACTERS.test(entry.enrollKey)
    ) {
      throw new Error("HARA_DESK_PROVISIONING_JSON contains an invalid enrollment secret");
    }
    targets.set(orgId, {
      url: deskOrigin(entry.url),
      enrollKey: entry.enrollKey,
    });
  }
  return targets;
}

function boundedIdentity(value: unknown, field: string, maxLength = 256): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maxLength
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`Hara Desk returned an invalid ${field}`);
  }
  return value;
}

@Injectable()
export class DeskProvisioner {
  private readonly targets = parseDeskProvisioning(
    process.env.HARA_DESK_PROVISIONING_JSON,
  );

  constructor(
    @Optional()
    private readonly serviceBindings?: TenantServiceBindingsService,
  ) {}

  configured(orgId: string): boolean {
    return this.targets.has(orgId);
  }

  /** Exchange the server-held Desk enrollment secret for a separate per-device bearer.
   * The user still enters only the Hara Control one-time code. */
  async provision(input: {
    orgId: string;
    owner: string;
    deviceName: string;
  }): Promise<ProvisionedDeskBinding | undefined> {
    const managedTarget = await this.serviceBindings?.deskProvisioningTarget(
      input.orgId,
    );
    const legacyTarget = this.targets.get(input.orgId);
    const target = managedTarget ?? legacyTarget;
    if (!target) return undefined;
    const owner = boundedIdentity(input.owner, "Desk owner");
    const deviceName = boundedIdentity(input.deviceName, "Desk device name");
    const managedSecret = managedTarget?.enrollKey;
    let response: Response;
    try {
      response = await safeFetch(
        `${target.url}/register`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enrollKey: managedSecret
              ? managedSecret.toString("utf8")
              : legacyTarget!.enrollKey,
            owner,
            name: deviceName,
            client: "hara-control-enrollment",
          }),
          signal: AbortSignal.timeout(10_000),
        },
        {
          // Desk registration must never follow a redirect carrying its enrollment secret.
          allowHosts: new Set([new URL(target.url).hostname.toLowerCase()]),
          blockPrivateWhenOpen: false,
          maxRedirects: 0,
        },
      );
    } finally {
      // Database-managed credentials are decrypted into an owned Buffer for this one request only.
      managedSecret?.fill(0);
    }
    if (!response.ok) {
      throw new Error(`Hara Desk provisioning failed with HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("Hara Desk provisioning response is too large");
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("Hara Desk provisioning response is too large");
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error("Hara Desk provisioning response is invalid");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Hara Desk provisioning response is invalid");
    }
    const record = body as Record<string, unknown>;
    const token = boundedIdentity(record.token, "Desk token", MAX_DESK_TOKEN_BYTES);
    if (Buffer.byteLength(token, "utf8") > MAX_DESK_TOKEN_BYTES) {
      throw new Error("Hara Desk returned an invalid Desk token");
    }
    return {
      url: target.url,
      agent_id: boundedIdentity(record.agentId, "Desk agent identity"),
      owner: boundedIdentity(record.owner, "Desk owner"),
      token,
    };
  }
}

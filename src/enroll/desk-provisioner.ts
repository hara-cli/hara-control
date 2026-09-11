import { Injectable, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
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
  credential_generation: number;
}

export interface DeskProvisioningReceipt {
  binding: ProvisionedDeskBinding;
  /** Revoke this exact installation on the exact captured origin using the captured credential. */
  compensate: () => Promise<void>;
  /** Forget the captured credential after the caller commits its local enrollment state. */
  release: () => void;
}

export interface DeskProvisioningInput {
  orgId: string;
  owner: string;
  deviceName: string;
  installationId: string;
  platform: string;
  version: string;
  clientKind: string;
  instanceId?: string;
  agentName?: string;
  expectedUrl?: string;
}

export class DeskProvisioningFailure extends Error {
  constructor(
    public readonly compensationConfirmed: boolean,
    public readonly targetUrl: string,
  ) {
    super(compensationConfirmed
      ? "Hara Desk provisioning failed; the remote installation was rolled back"
      : "Hara Desk provisioning failed and remote rollback could not be confirmed");
    this.name = "DeskProvisioningFailure";
  }
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
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !normalized
    || normalized.length > maxLength
    || CONTROL_CHARACTERS.test(normalized)
  ) {
    throw new Error(`Hara Desk returned an invalid ${field}`);
  }
  return normalized;
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

  private async revokeAtTarget(
    target: { url: string },
    secret: Buffer,
    input: { orgId: string; owner: string; installationId: string },
    options: { allowMissing?: boolean } = {},
  ): Promise<void> {
    const response = await safeFetch(
      `${target.url}/provisioning/installations/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrollKey: secret.toString("utf8"),
          owner: input.owner,
          realmId: input.orgId,
          installationId: input.installationId,
        }),
        signal: AbortSignal.timeout(10_000),
      },
      {
        allowHosts: new Set([new URL(target.url).hostname.toLowerCase()]),
        blockPrivateWhenOpen: false,
        maxRedirects: 0,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Hara Desk installation revocation failed with HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Hara Desk revocation response is too large");
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("Hara Desk revocation response is too large");
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error("Hara Desk revocation response is invalid");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Hara Desk revocation response is invalid");
    }
    const record = body as Record<string, unknown>;
    if (typeof record.revoked !== "boolean" || typeof record.alreadyRevoked !== "boolean") {
      throw new Error("Hara Desk revocation response is invalid");
    }
    if (!record.revoked && !options.allowMissing) {
      throw new Error("Hara Desk did not find the installation to revoke");
    }
  }

  /** Exchange the server-held Desk enrollment secret for a separate per-device bearer.
   * The user still enters only the Hara Control one-time code. */
  async provisionForEnrollment(
    input: DeskProvisioningInput,
    options: {
      compensateInstallationOnUncertainFailure?: boolean;
      /** Initial Control enrollment only: reserve the Device under the binding-mutation lock. */
      controlReservation?: { deviceId: string; preparedAt: Date };
      /** Observe a completed reservation before the first remote registration byte is sent. */
      onPrepared?: (target: { url: string }) => Promise<void>;
    } = {},
  ): Promise<DeskProvisioningReceipt | undefined> {
    const legacyTarget = this.targets.get(input.orgId);
    const owner = boundedIdentity(input.owner, "Desk owner");
    const deviceName = boundedIdentity(input.deviceName, "Desk device name");
    const installationId = boundedIdentity(input.installationId, "Desk installation identity", 160);
    const platform = boundedIdentity(input.platform || "unknown", "Desk platform", 40);
    const version = boundedIdentity(input.version || "unknown", "Desk client version", 40);
    const clientKind = boundedIdentity(input.clientKind, "Desk client kind", 80);
    const instanceId = boundedIdentity(input.instanceId || "default", "Desk Agent instance", 80);
    if (instanceId !== instanceId.toLowerCase()) {
      throw new Error("Desk Agent instance must use a canonical lowercase identifier");
    }
    const agentName = boundedIdentity(input.agentName || deviceName, "Desk Agent name", 120);
    const expectedUrl = input.expectedUrl ? deskOrigin(input.expectedUrl) : undefined;
    let managedConfigured = false;
    let managedTarget: { url: string; enrollKey: Buffer } | undefined;
    let reservationPrepared = false;
    if (options.controlReservation && this.serviceBindings) {
      const reservation = await this.serviceBindings.reserveDeskProvisioning({
        orgId: input.orgId,
        deviceId: options.controlReservation.deviceId,
        owner,
        preparedAt: options.controlReservation.preparedAt,
        legacyOrigin: legacyTarget?.url,
      });
      managedConfigured = reservation.managedConfigured;
      managedTarget = reservation.target;
      reservationPrepared = reservation.prepared;
    } else if (this.serviceBindings) {
      const resolution = await this.serviceBindings.deskProvisioningResolution(input.orgId);
      managedConfigured = resolution.managedConfigured;
      managedTarget = resolution.target;
    }
    // Any explicit managed row shadows the compatibility env mapping, regardless of row status.
    const target = managedConfigured ? managedTarget : managedTarget ?? legacyTarget;
    if (!target) return undefined;
    if (expectedUrl && expectedUrl !== target.url) {
      managedTarget?.enrollKey.fill(0);
      throw new Error("Hara Desk provisioning target no longer matches the enrolled installation");
    }
    const provisioningId = `control_${createHash("sha256")
      .update(JSON.stringify([input.orgId, installationId, clientKind, instanceId]))
      .digest("hex")}`;
    const secret = managedTarget?.enrollKey
      ?? Buffer.from(legacyTarget!.enrollKey, "utf8");
    let handedOff = false;
    let remoteAttempted = false;
    try {
      // The Control reservation (when requested) is committed under the same lock used by binding
      // mutation. This observer remains before safeFetch so callers/tests can prove no network side
      // effect starts until cleanup provenance is durable.
      if (options.controlReservation && this.serviceBindings && !reservationPrepared) {
        throw new Error("Hara Desk provisioning reservation was not prepared");
      }
      await options.onPrepared?.({ url: target.url });
      remoteAttempted = true;
      const response = await safeFetch(
        `${target.url}/register`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enrollKey: secret.toString("utf8"),
            owner,
            realmId: input.orgId,
            name: agentName,
            client: clientKind,
            provisioningId,
            installationId,
            deviceName,
            platform,
            version,
            capabilities: ["tasks", "comments", "organization-workbench", "session-lease"],
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
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Desk rejected the registration request");
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Desk returned an oversized registration response");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error("Desk returned an oversized registration response");
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new Error("Desk returned an invalid registration response");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Desk returned an invalid registration response");
      }
      const record = body as Record<string, unknown>;
      if (
        record.realmId !== input.orgId
        || record.provisioningId !== provisioningId
        || record.protocolVersion !== 1
      ) {
        throw new Error("Desk did not prove the requested organization provisioning identity");
      }
      const returnedOwner = boundedIdentity(record.owner, "Desk owner");
      if (returnedOwner !== owner) {
        throw new Error("Desk returned a different owner than Control authenticated");
      }
      const returnedClient = boundedIdentity(record.client, "Desk client kind", 80);
      if (returnedClient !== clientKind) {
        throw new Error("Desk returned a different client than Control requested");
      }
      if (!record.device || typeof record.device !== "object" || Array.isArray(record.device)) {
        throw new Error("Desk did not bind the Agent to the Control installation");
      }
      const returnedDevice = record.device as Record<string, unknown>;
      if (
        boundedIdentity(returnedDevice.installationId, "Desk installation identity", 160)
          !== installationId
        || returnedDevice.revoked !== false
      ) {
        throw new Error("Desk returned a different or revoked Control installation");
      }
      const token = boundedIdentity(record.token, "Desk token", MAX_DESK_TOKEN_BYTES);
      if (Buffer.byteLength(token, "utf8") > MAX_DESK_TOKEN_BYTES) {
        throw new Error("Hara Desk returned an invalid Desk token");
      }
      const credentialGeneration = record.credentialGeneration;
      if (
        typeof credentialGeneration !== "number"
        || !Number.isSafeInteger(credentialGeneration)
        || credentialGeneration < 1
      ) {
        throw new Error("Hara Desk returned an invalid credential generation");
      }
      const binding: ProvisionedDeskBinding = {
        url: target.url,
        agent_id: boundedIdentity(record.agentId, "Desk agent identity"),
        owner: returnedOwner,
        token,
        credential_generation: credentialGeneration,
      };
      let active = true;
      const release = () => {
        if (!active) return;
        active = false;
        secret.fill(0);
      };
      const receipt: DeskProvisioningReceipt = {
        binding,
        release,
        compensate: async () => {
          if (!active) return;
          try {
            await this.revokeAtTarget(target, secret, { orgId: input.orgId, owner, installationId });
          } finally {
            release();
          }
        },
      };
      handedOff = true;
      return receipt;
    } catch (error) {
      if (!remoteAttempted) throw error;
      if (options.compensateInstallationOnUncertainFailure === false) {
        // A secondary Claude Code/Codex registration is deterministic by client+instance. An
        // uncertain response is safely retried and must never revoke the installation's existing
        // Hara/other-Agent credentials.
        throw new Error("Hara Desk Agent provisioning failed; retry the same client and instance");
      }
      let compensationConfirmed = false;
      try {
        await this.revokeAtTarget(
          target,
          secret,
          { orgId: input.orgId, owner, installationId },
          // The registration response may have been lost before Desk committed anything. A
          // confirmed missing installation is safe only for this initial-enrollment compensation.
          { allowMissing: true },
        );
        compensationConfirmed = true;
      } catch {
        // The caller must keep its device/code claim when the original Desk cannot confirm rollback.
      }
      throw new DeskProvisioningFailure(compensationConfirmed, target.url);
    } finally {
      if (!handedOff) secret.fill(0);
    }
  }

  async provision(input: DeskProvisioningInput): Promise<ProvisionedDeskBinding | undefined> {
    const receipt = await this.provisionForEnrollment(input, {
      compensateInstallationOnUncertainFailure: false,
    });
    if (!receipt) return undefined;
    receipt.release();
    return receipt.binding;
  }

  /** Idempotently revoke every Desk Agent/Session attached to one Control installation. The shared
   * enrollment credential never leaves Control; Desk derives the owner from it before matching the
   * stable installation identity. */
  async revokeInstallation(input: {
    orgId: string;
    owner: string;
    installationId: string;
    expectedUrl?: string;
    /** Only cleanup of an inconclusive initial registration may treat a missing installation as success. */
    allowMissing?: boolean;
  }): Promise<boolean> {
    const legacyTarget = this.targets.get(input.orgId);
    const resolution = input.expectedUrl
      ? await this.serviceBindings?.deskRevocationResolution(input.orgId, input.expectedUrl)
      : await this.serviceBindings?.deskProvisioningResolution(input.orgId);
    const managedTarget = resolution?.target;
    const target = resolution?.managedConfigured
      ? managedTarget
      : managedTarget ?? legacyTarget;
    if (!target) {
      if (input.expectedUrl) {
        throw new Error("Hara Desk revocation credential is unavailable for this enrolled installation");
      }
      return false;
    }
    if (input.expectedUrl && deskOrigin(input.expectedUrl) !== target.url) {
      managedTarget?.enrollKey.fill(0);
      throw new Error("Hara Desk revocation target no longer matches the enrolled installation");
    }
    const owner = boundedIdentity(input.owner, "Desk owner");
    const installationId = boundedIdentity(
      input.installationId,
      "Desk installation identity",
      160,
    );
    const secret = managedTarget?.enrollKey
      ?? Buffer.from(legacyTarget!.enrollKey, "utf8");
    try {
      await this.revokeAtTarget(
        target,
        secret,
        { orgId: input.orgId, owner, installationId },
        { allowMissing: input.allowMissing === true },
      );
    } finally {
      secret.fill(0);
    }
    return true;
  }
}

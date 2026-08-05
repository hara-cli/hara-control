import { randomUUID } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  TenantServiceBinding,
  TenantServiceKind,
  TenantServiceMode,
  TenantServiceRegion,
  TenantServiceStatus,
} from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { AuthedUser } from "../common/admin-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { safeFetch } from "../security/ssrf";
import { SecretsService } from "../security/secrets.service";
import { UpsertTenantServiceBindingDto } from "./dto";

const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const MAX_JWKS_RESPONSE_BYTES = 256 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SAFE_AUDIENCE = /^[A-Za-z0-9._:/-]{1,160}$/;

export type PublicTenantServiceBinding = Readonly<{
  id: string;
  orgId: string;
  service: TenantServiceKind;
  mode: TenantServiceMode;
  accountRegion: TenantServiceRegion;
  apiOrigin: string;
  issuer: string | null;
  jwksUri: string | null;
  audience: string | null;
  status: TenantServiceStatus;
  capabilitiesVersion: number;
  configVersion: number;
  credentialConfigured: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type EnrollmentServiceBinding = Readonly<{
  tenant_id: string;
  service: TenantServiceKind;
  mode: TenantServiceMode;
  account_region: TenantServiceRegion;
  api_origin: string;
  issuer?: string;
  jwks_uri?: string;
  audience?: string;
  status: "ACTIVE";
  capabilities_version: number;
  config_version: number;
}>;

export type DeskProvisioningTarget = Readonly<{
  url: string;
  enrollKey: Buffer;
}>;

function serviceKind(value: string): TenantServiceKind {
  if (!Object.values(TenantServiceKind).includes(value as TenantServiceKind)) {
    throw new BadRequestException("unknown organization service");
  }
  return value as TenantServiceKind;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "[::1]"
    || normalized === "::1";
}

function normalizeUrl(
  value: string | undefined,
  field: string,
  originOnly: boolean,
): string | null {
  if (value === undefined || value.trim() === "") return null;
  if (value.length > 2048 || CONTROL_CHARACTERS.test(value)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new BadRequestException(`${field} must be an absolute URL`);
  }
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname)))
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (originOnly && parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new BadRequestException(
      `${field} must use HTTPS and must not contain credentials, query, or fragment data`,
    );
  }
  return originOnly
    ? parsed.origin
    : parsed.toString().replace(/\/$/, "");
}

function normalizeAudience(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  if (value !== value.trim() || !SAFE_AUDIENCE.test(value)) {
    throw new BadRequestException("audience is invalid");
  }
  return value;
}

function actorType(actor: AuthedUser): string {
  return actor.viaSharedKey ? "shared-admin-key" : "admin-user";
}

function publicBinding(row: TenantServiceBinding): PublicTenantServiceBinding {
  return Object.freeze({
    id: row.id,
    orgId: row.orgId,
    service: row.service,
    mode: row.mode,
    accountRegion: row.accountRegion,
    apiOrigin: row.apiOrigin,
    issuer: row.issuer,
    jwksUri: row.jwksUri,
    audience: row.audience,
    status: row.status,
    capabilitiesVersion: row.capabilitiesVersion,
    configVersion: row.configVersion,
    credentialConfigured: row.credentialRef !== null,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function healthPath(service: TenantServiceKind): string {
  return service === TenantServiceKind.DESK_TASKS
    || service === TenantServiceKind.EXTENSION_CATALOG
    ? "/health"
    : "/health/ready";
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status and size bounds are authoritative. Never surface upstream body errors.
  }
}

@Injectable()
export class TenantServiceBindingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly audit: AuditService,
  ) {}

  parseService(value: string): TenantServiceKind {
    return serviceKind(value);
  }

  async list(orgId: string): Promise<PublicTenantServiceBinding[]> {
    await this.requireOrganization(orgId);
    const rows = await this.prisma.tenantServiceBinding.findMany({
      where: { orgId },
      orderBy: { service: "asc" },
    });
    return rows.map(publicBinding);
  }

  async upsert(
    orgId: string,
    rawService: string,
    input: UpsertTenantServiceBindingDto,
    actor: AuthedUser,
  ): Promise<PublicTenantServiceBinding> {
    await this.requireOrganization(orgId);
    const service = serviceKind(rawService);
    const apiOrigin = normalizeUrl(input.apiOrigin, "apiOrigin", true);
    if (!apiOrigin) throw new BadRequestException("apiOrigin is required");
    const issuer = normalizeUrl(input.issuer, "issuer", false);
    const jwksUri = normalizeUrl(input.jwksUri, "jwksUri", false);
    const audience = normalizeAudience(input.audience);
    if (
      service === TenantServiceKind.COLLAB
      && (!issuer || !jwksUri || !audience)
    ) {
      throw new BadRequestException(
        "COLLAB requires issuer, jwksUri, and audience",
      );
    }
    const credential = input.credential;
    if (
      credential !== undefined
      && (
        credential.length === 0
        || credential.length > 4096
        || credential !== credential.trim()
        || CONTROL_CHARACTERS.test(credential)
      )
    ) {
      throw new BadRequestException(
        "credential must be 1 to 4096 printable non-padding characters",
      );
    }
    if (
      credential !== undefined
      && service !== TenantServiceKind.DESK_TASKS
    ) {
      throw new BadRequestException(
        "only DESK_TASKS accepts an enrollment credential",
      );
    }

    const existing = await this.prisma.tenantServiceBinding.findUnique({
      where: { orgId_service: { orgId, service } },
    });
    let nextCredentialRef = existing?.credentialRef ?? null;
    let newlyStoredCredentialRef: string | null = null;
    if (credential !== undefined) {
      newlyStoredCredentialRef = `tenant-service.${service}.${randomUUID()}`;
      await this.secrets.put(orgId, newlyStoredCredentialRef, credential);
      nextCredentialRef = newlyStoredCredentialRef;
    }

    let row: TenantServiceBinding;
    try {
      row = await this.prisma.tenantServiceBinding.upsert({
        where: { orgId_service: { orgId, service } },
        create: {
          orgId,
          service,
          mode: input.mode,
          accountRegion: input.accountRegion,
          apiOrigin,
          issuer,
          jwksUri,
          audience,
          credentialRef: nextCredentialRef,
          status: TenantServiceStatus.PENDING_VERIFICATION,
          capabilitiesVersion: input.capabilitiesVersion ?? 1,
          configVersion: 1,
          verifiedAt: null,
        },
        update: {
          mode: input.mode,
          accountRegion: input.accountRegion,
          apiOrigin,
          issuer,
          jwksUri,
          audience,
          credentialRef: nextCredentialRef,
          status: TenantServiceStatus.PENDING_VERIFICATION,
          capabilitiesVersion: input.capabilitiesVersion ?? existing?.capabilitiesVersion ?? 1,
          configVersion: { increment: 1 },
          verifiedAt: null,
        },
      });
    } catch (error) {
      if (newlyStoredCredentialRef) {
        await this.secrets.remove(orgId, newlyStoredCredentialRef).catch(() => undefined);
      }
      throw error;
    }

    if (
      newlyStoredCredentialRef
      && existing?.credentialRef
      && existing.credentialRef !== newlyStoredCredentialRef
    ) {
      await this.secrets.remove(orgId, existing.credentialRef).catch(() => undefined);
    }
    await this.audit.log(
      orgId,
      "tenant-service.configure",
      actorType(actor),
      actor.id,
      {
        service,
        mode: input.mode,
        accountRegion: input.accountRegion,
        status: TenantServiceStatus.PENDING_VERIFICATION,
        credentialReplaced: newlyStoredCredentialRef !== null,
        configVersion: row.configVersion,
      },
    );
    return publicBinding(row);
  }

  async verify(
    orgId: string,
    rawService: string,
    actor: AuthedUser,
  ): Promise<PublicTenantServiceBinding> {
    const service = serviceKind(rawService);
    const row = await this.find(orgId, service);
    try {
      if (
        service === TenantServiceKind.DESK_TASKS
        && !row.credentialRef
      ) {
        throw new BadRequestException(
          "DESK_TASKS requires an encrypted enrollment credential",
        );
      }
      if (service === TenantServiceKind.DESK_TASKS) {
        let credential: Buffer | null = null;
        try {
          credential = await this.secrets.get(orgId, row.credentialRef!);
          if (!credential || credential.length < 1 || credential.length > 4096) {
            throw new Error("credential unavailable");
          }
        } catch {
          throw new BadGatewayException(
            "Hara Desk enrollment credential is not readable",
          );
        } finally {
          credential?.fill(0);
        }
      }
      await this.verifyHealth(row);
      if (row.jwksUri) await this.verifyJwks(row.jwksUri);
    } catch (error) {
      const degraded = await this.prisma.tenantServiceBinding.update({
        where: { id: row.id },
        data: {
          status: TenantServiceStatus.DEGRADED,
          verifiedAt: null,
        },
      });
      await this.audit.log(
        orgId,
        "tenant-service.verify-failed",
        actorType(actor),
        actor.id,
        {
          service,
          status: TenantServiceStatus.DEGRADED,
          configVersion: degraded.configVersion,
        },
      );
      throw error;
    }

    const verified = await this.prisma.tenantServiceBinding.update({
      where: { id: row.id },
      data: {
        status: TenantServiceStatus.ACTIVE,
        verifiedAt: new Date(),
      },
    });
    await this.audit.log(
      orgId,
      "tenant-service.verify",
      actorType(actor),
      actor.id,
      {
        service,
        status: TenantServiceStatus.ACTIVE,
        configVersion: verified.configVersion,
      },
    );
    return publicBinding(verified);
  }

  async disable(
    orgId: string,
    rawService: string,
    actor: AuthedUser,
  ): Promise<PublicTenantServiceBinding> {
    const service = serviceKind(rawService);
    const row = await this.find(orgId, service);
    const disabled = await this.prisma.tenantServiceBinding.update({
      where: { id: row.id },
      data: {
        status: TenantServiceStatus.DISABLED,
        configVersion: { increment: 1 },
        verifiedAt: null,
      },
    });
    await this.audit.log(
      orgId,
      "tenant-service.disable",
      actorType(actor),
      actor.id,
      {
        service,
        status: TenantServiceStatus.DISABLED,
        configVersion: disabled.configVersion,
      },
    );
    return publicBinding(disabled);
  }

  async activeForEnrollment(
    orgId: string,
  ): Promise<EnrollmentServiceBinding[]> {
    const rows = await this.prisma.tenantServiceBinding.findMany({
      where: { orgId, status: TenantServiceStatus.ACTIVE },
      orderBy: { service: "asc" },
    });
    return rows.map((row) => Object.freeze({
      tenant_id: row.orgId,
      service: row.service,
      mode: row.mode,
      account_region: row.accountRegion,
      api_origin: row.apiOrigin,
      ...(row.issuer ? { issuer: row.issuer } : {}),
      ...(row.jwksUri ? { jwks_uri: row.jwksUri } : {}),
      ...(row.audience ? { audience: row.audience } : {}),
      status: "ACTIVE" as const,
      capabilities_version: row.capabilitiesVersion,
      config_version: row.configVersion,
    }));
  }

  async deskProvisioningTarget(
    orgId: string,
  ): Promise<DeskProvisioningTarget | undefined> {
    const row = await this.prisma.tenantServiceBinding.findUnique({
      where: {
        orgId_service: {
          orgId,
          service: TenantServiceKind.DESK_TASKS,
        },
      },
    });
    if (
      !row
      || row.status !== TenantServiceStatus.ACTIVE
      || !row.credentialRef
    ) return undefined;
    const enrollKey = await this.secrets.get(orgId, row.credentialRef);
    if (!enrollKey || enrollKey.length < 1 || enrollKey.length > 4096) {
      enrollKey?.fill(0);
      throw new Error("active Hara Desk binding has no readable enrollment credential");
    }
    return Object.freeze({
      url: row.apiOrigin,
      enrollKey,
    });
  }

  private async requireOrganization(orgId: string): Promise<void> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true },
    });
    if (!organization) throw new NotFoundException("organization not found");
  }

  private async find(
    orgId: string,
    service: TenantServiceKind,
  ): Promise<TenantServiceBinding> {
    const row = await this.prisma.tenantServiceBinding.findUnique({
      where: { orgId_service: { orgId, service } },
    });
    if (!row) throw new NotFoundException("organization service not found");
    return row;
  }

  private async probe(url: string, maximumBytes: number): Promise<Response> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new BadRequestException("organization service URL is invalid");
    }
    let response: Response;
    try {
      response = await safeFetch(
        target.toString(),
        {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        },
        {
          allowHosts: new Set([target.hostname.toLowerCase()]),
          blockPrivateWhenOpen: false,
          maxRedirects: 0,
        },
      );
    } catch {
      throw new BadGatewayException(
        "organization service readiness check failed",
      );
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maximumBytes) {
      await cancelBody(response);
      throw new BadGatewayException(
        "organization service response is too large",
      );
    }
    return response;
  }

  private async readJson(
    response: Response,
    maximumBytes: number,
    errorMessage: string,
  ): Promise<Record<string, unknown>> {
    let value: unknown;
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maximumBytes) {
        throw new Error("response too large");
      }
      value = JSON.parse(text);
    } catch {
      throw new BadGatewayException(errorMessage);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadGatewayException(errorMessage);
    }
    return value as Record<string, unknown>;
  }

  private async verifyHealth(row: TenantServiceBinding): Promise<void> {
    const response = await this.probe(
      `${row.apiOrigin}${healthPath(row.service)}`,
      MAX_HEALTH_RESPONSE_BYTES,
    );
    if (!response.ok) {
      await cancelBody(response);
      throw new BadGatewayException(
        "organization service readiness check failed",
      );
    }
    const body = await this.readJson(
      response,
      MAX_HEALTH_RESPONSE_BYTES,
      "organization service readiness check failed",
    );
    const valid = row.service === TenantServiceKind.DESK_TASKS
      ? body.ok === true
      : row.service === TenantServiceKind.COLLAB
        ? body.status === "ready" && body.service === "hara-collab"
        : body.status === "ok" || body.status === "ready" || body.ok === true;
    if (!valid) {
      throw new BadGatewayException(
        "organization service readiness check failed",
      );
    }
  }

  private async verifyJwks(url: string): Promise<void> {
    const response = await this.probe(url, MAX_JWKS_RESPONSE_BYTES);
    if (!response.ok) {
      await cancelBody(response);
      throw new BadGatewayException("organization service JWKS check failed");
    }
    const body = await this.readJson(
      response,
      MAX_JWKS_RESPONSE_BYTES,
      "organization service JWKS check failed",
    );
    if (
      !Array.isArray(body.keys)
      || body.keys.length < 1
      || body.keys.length > 20
      || body.keys.some((key) =>
        !key
        || typeof key !== "object"
        || Array.isArray(key)
        || "d" in key)
    ) {
      throw new BadGatewayException("organization service JWKS check failed");
    }
  }
}

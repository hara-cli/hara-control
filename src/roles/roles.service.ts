import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementService } from "../license/license.service";
import { sha256 } from "../common/crypto";
import { assertTokenUsable } from "../security/token-discipline";
import type { AuthedUser } from "../common/admin-auth.guard";

/** Governance policy carried at org / team / assignment levels and merged (org < team < assignment). */
export type Policy = {
  modelAllow?: string[];
  modelDeny?: string[];
  toolDeny?: string[];
  requireApprovalForWrites?: boolean;
  budget?: number | Record<string, unknown>;
};

function normalizedStringList(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new BadRequestException(`${key} must be an array of at most 128 strings`);
  }
  const values = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 256 || /[\u0000-\u001f\u007f]/.test(entry)) {
      throw new BadRequestException(`${key} contains an invalid value`);
    }
    return entry.trim();
  });
  return [...new Set(values)].sort();
}

function normalizedBudget(value: unknown, depth = 0): number | Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new BadRequestException("budget values must be finite non-negative numbers");
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || depth >= 4) {
    throw new BadRequestException("budget must contain bounded numeric limits");
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new BadRequestException("budget has too many dimensions");
  const out: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) throw new BadRequestException("budget contains an invalid key");
    out[key] = normalizedBudget(child, depth + 1);
  }
  return out;
}

/** Stored policy is untrusted JSON too. Normalize every write and every bundle resolution so a malformed
 * record fails closed with a controlled 4xx instead of throwing an incidental `.forEach` TypeError. */
export function normalizePolicy(value: unknown): Policy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("policy must be an object");
  }
  const input = value as Record<string, unknown>;
  const supported = new Set(["modelAllow", "modelDeny", "toolDeny", "requireApprovalForWrites", "budget"]);
  const unknown = Object.keys(input).filter((key) => !supported.has(key));
  if (unknown.length) {
    throw new BadRequestException(`policy contains unsupported field '${unknown[0]}'`);
  }
  if (input.requireApprovalForWrites !== undefined && typeof input.requireApprovalForWrites !== "boolean") {
    throw new BadRequestException("requireApprovalForWrites must be a boolean");
  }
  return {
    ...(input.modelDeny !== undefined ? { modelDeny: normalizedStringList(input.modelDeny, "modelDeny") } : {}),
    ...(input.modelAllow !== undefined ? { modelAllow: normalizedStringList(input.modelAllow, "modelAllow") } : {}),
    ...(input.toolDeny !== undefined ? { toolDeny: normalizedStringList(input.toolDeny, "toolDeny") } : {}),
    ...(input.requireApprovalForWrites === true ? { requireApprovalForWrites: true } : {}),
    ...(input.budget !== undefined ? { budget: normalizedBudget(input.budget) } : {}),
  };
}

function restrictiveBudget(current: Policy["budget"], next: Policy["budget"]): Policy["budget"] {
  if (next === undefined) return current;
  if (current === undefined) return next;
  if (typeof current === "number" && typeof next === "number") return Math.min(current, next);
  if (
    current && next
    && typeof current === "object" && !Array.isArray(current)
    && typeof next === "object" && !Array.isArray(next)
  ) {
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(next)) {
      merged[key] = restrictiveBudget(merged[key] as Policy["budget"], value as Policy["budget"]);
    }
    return merged;
  }
  // Incompatible lower-level shapes never replace a valid upper-level limit.
  return current;
}

/** Merge governance policies monotonically: denials only accumulate and allow-lists only narrow. */
export function mergePolicy(...layers: (Policy | undefined | null)[]): Policy {
  const modelDeny = new Set<string>();
  const toolDeny = new Set<string>();
  let modelAllow: Set<string> | undefined;
  let requireApprovalForWrites = false;
  let budget: Policy["budget"];
  for (const raw of layers) {
    if (!raw) continue;
    const p = normalizePolicy(raw);
    (p.modelDeny ?? []).forEach((m) => modelDeny.add(m));
    (p.toolDeny ?? []).forEach((t) => toolDeny.add(t));
    if (Array.isArray(p.modelAllow)) {
      const layerAllow = new Set(p.modelAllow);
      modelAllow = modelAllow === undefined
        ? layerAllow
        : new Set([...modelAllow].filter((model) => layerAllow.has(model)));
    }
    if (p.requireApprovalForWrites) requireApprovalForWrites = true;
    budget = restrictiveBudget(budget, p.budget);
  }
  const out: Policy = {};
  if (modelDeny.size) out.modelDeny = [...modelDeny].sort();
  if (toolDeny.size) out.toolDeny = [...toolDeny].sort();
  if (modelAllow !== undefined) out.modelAllow = [...modelAllow].sort();
  if (requireApprovalForWrites) out.requireApprovalForWrites = true;
  if (budget !== undefined) out.budget = budget;
  return out;
}

export type RoleInput = {
  key: string;
  description?: string;
  owns?: string[];
  rejects?: string[];
  model?: string | null;
  allowTools?: string[];
  denyTools?: string[];
  system?: string;
};

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlement: EntitlementService,
  ) {}

  private auditActor(actor: AuthedUser): { type: string; id: string } {
    return {
      type: actor.viaSharedKey ? "shared-key" : "admin",
      id: actor.id,
    };
  }

  async roleOrgId(id: string): Promise<string> {
    const resource = await this.prisma.role.findUnique({ where: { id }, select: { orgId: true } });
    if (!resource) throw new NotFoundException("role not found");
    return resource.orgId;
  }

  async teamOrgId(id: string): Promise<string> {
    const resource = await this.prisma.team.findUnique({ where: { id }, select: { orgId: true } });
    if (!resource) throw new NotFoundException("team not found");
    return resource.orgId;
  }

  async assignmentOrgId(id: string): Promise<string> {
    const resource = await this.prisma.digitalEmployee.findUnique({ where: { id }, select: { orgId: true } });
    if (!resource) throw new NotFoundException("assignment not found");
    return resource.orgId;
  }

  async deviceOrgId(id: string): Promise<string> {
    const resource = await this.prisma.device.findUnique({ where: { id }, select: { orgId: true } });
    if (!resource) throw new NotFoundException("device not found");
    return resource.orgId;
  }

  // ── roles (digital-employee templates) ──────────────────────────────────
  async createRole(orgId: string, input: RoleInput, actor: AuthedUser) {
    this.entitlement.assert("agent-org"); // B3 is a licensed feature
    const auditActor = this.auditActor(actor);
    return this.audit.transact("role.create", auditActor.type, auditActor.id, async (tx) => {
      const role = await tx.role.create({
        data: {
          orgId,
          key: input.key,
          description: input.description ?? "",
          owns: input.owns ?? [],
          rejects: input.rejects ?? [],
          model: input.model ?? null,
          allowTools: input.allowTools ?? [],
          denyTools: input.denyTools ?? [],
          system: input.system ?? "",
        },
      });
      return { result: role, orgId, payload: { resourceId: role.id, key: role.key } };
    });
  }

  listRoles(orgId: string) {
    return this.prisma.role.findMany({ where: { orgId, archivedAt: null }, orderBy: { key: "asc" } });
  }

  async updateRole(id: string, input: Partial<RoleInput>, actor: AuthedUser) {
    const data: Prisma.RoleUpdateInput = { version: { increment: 1 } };
    if (input.description !== undefined) data.description = input.description;
    if (input.owns !== undefined) data.owns = input.owns;
    if (input.rejects !== undefined) data.rejects = input.rejects;
    if (input.model !== undefined) data.model = input.model;
    if (input.allowTools !== undefined) data.allowTools = input.allowTools;
    if (input.denyTools !== undefined) data.denyTools = input.denyTools;
    if (input.system !== undefined) data.system = input.system;
    const auditActor = this.auditActor(actor);
    return this.audit.transact("role.update", auditActor.type, auditActor.id, async (tx) => {
      const role = await tx.role.update({ where: { id }, data });
      return {
        result: role,
        orgId: role.orgId,
        payload: { resourceId: role.id, version: role.version },
      };
    });
  }

  async archiveRole(id: string, actor: AuthedUser) {
    const auditActor = this.auditActor(actor);
    return this.audit.transact("role.archive", auditActor.type, auditActor.id, async (tx) => {
      const role = await tx.role.update({ where: { id }, data: { archivedAt: new Date() } });
      return { result: { archived: true }, orgId: role.orgId, payload: { resourceId: role.id } };
    });
  }

  // ── persons / teams ──────────────────────────────────────────────────────
  async createPerson(orgId: string, email: string, name: string | undefined, actor: AuthedUser) {
    const auditActor = this.auditActor(actor);
    return this.audit.transact("person.create", auditActor.type, auditActor.id, async (tx) => {
      const person = await tx.person.create({ data: { orgId, email, name: name ?? "" } });
      return { result: person, orgId, payload: { resourceId: person.id } };
    });
  }

  async createTeam(orgId: string, name: string, actor: AuthedUser) {
    const auditActor = this.auditActor(actor);
    return this.audit.transact("team.create", auditActor.type, auditActor.id, async (tx) => {
      const team = await tx.team.create({ data: { orgId, name } });
      return { result: team, orgId, payload: { resourceId: team.id } };
    });
  }

  async addTeamMember(teamId: string, personId: string, actor: AuthedUser) {
    const auditActor = this.auditActor(actor);
    return this.audit.transact("team.member.add", auditActor.type, auditActor.id, async (tx) => {
      const [team, person] = await Promise.all([
        tx.team.findUnique({ where: { id: teamId }, select: { orgId: true } }),
        tx.person.findUnique({ where: { id: personId }, select: { orgId: true } }),
      ]);
      if (!team) throw new NotFoundException("team not found");
      if (!person) throw new NotFoundException("person not found");
      if (team.orgId !== person.orgId) throw new BadRequestException("person and team must belong to the same organization");
      await tx.personTeam.upsert({
        where: { personId_teamId: { personId, teamId } },
        create: { orgId: team.orgId, personId, teamId },
        update: {},
      });
      return {
        result: { ok: true },
        orgId: team.orgId,
        payload: { resourceId: teamId, personId },
      };
    });
  }

  async setTeamPolicy(teamId: string, policy: Policy, actor: AuthedUser) {
    const normalized = normalizePolicy(policy);
    const auditActor = this.auditActor(actor);
    return this.audit.transact("team.policy", auditActor.type, auditActor.id, async (tx) => {
      const team = await tx.team.update({ where: { id: teamId }, data: { policy: normalized as Prisma.InputJsonValue } });
      return { result: team, orgId: team.orgId, payload: { resourceId: teamId } };
    });
  }

  // ── assignments (= 角色分配 / digital employees) ──────────────────────────
  async createAssignment(
    orgId: string,
    roleId: string,
    opts: { personId?: string; teamId?: string; name?: string },
    actor: AuthedUser,
  ) {
    if (!opts.personId && !opts.teamId) {
      throw new BadRequestException("assignment requires a personId or teamId");
    }
    const auditActor = this.auditActor(actor);
    return this.audit.transact("assignment.create", auditActor.type, auditActor.id, async (tx) => {
      const [role, person, team] = await Promise.all([
        tx.role.findUnique({ where: { id: roleId }, select: { orgId: true } }),
        opts.personId
          ? tx.person.findUnique({ where: { id: opts.personId }, select: { orgId: true } })
          : Promise.resolve(null),
        opts.teamId
          ? tx.team.findUnique({ where: { id: opts.teamId }, select: { orgId: true } })
          : Promise.resolve(null),
      ]);
      if (!role) throw new NotFoundException("role not found");
      if (opts.personId && !person) throw new NotFoundException("person not found");
      if (opts.teamId && !team) throw new NotFoundException("team not found");
      if (
        role.orgId !== orgId
        || (person && person.orgId !== orgId)
        || (team && team.orgId !== orgId)
      ) {
        throw new BadRequestException("role, person, team, and assignment must belong to the same organization");
      }
      const de = await tx.digitalEmployee.create({
        data: { orgId, roleId, personId: opts.personId ?? null, teamId: opts.teamId ?? null, name: opts.name ?? "" },
      });
      return {
        result: de,
        orgId,
        payload: { resourceId: de.id, roleId, personId: opts.personId, teamId: opts.teamId },
      };
    });
  }

  async deleteAssignment(id: string, actor: AuthedUser) {
    const auditActor = this.auditActor(actor);
    return this.audit.transact("assignment.delete", auditActor.type, auditActor.id, async (tx) => {
      const de = await tx.digitalEmployee.delete({ where: { id } });
      return { result: { deleted: true }, orgId: de.orgId, payload: { resourceId: id } };
    });
  }

  async updateAssignment(id: string, data: { status?: string; policy?: Policy }, actor: AuthedUser) {
    const policy = data.policy === undefined ? undefined : normalizePolicy(data.policy);
    const auditActor = this.auditActor(actor);
    return this.audit.transact("assignment.update", auditActor.type, auditActor.id, async (tx) => {
      const de = await tx.digitalEmployee.update({
        where: { id },
        data: { ...(data.status ? { status: data.status } : {}), ...(policy ? { policy: policy as Prisma.InputJsonValue } : {}) },
      });
      return {
        result: de,
        orgId: de.orgId,
        payload: { resourceId: id, status: de.status },
      };
    });
  }

  async setOrgPolicy(orgId: string, policy: Policy, actor: AuthedUser) {
    const normalized = normalizePolicy(policy);
    const auditActor = this.auditActor(actor);
    return this.audit.transact("org.policy", auditActor.type, auditActor.id, async (tx) => {
      const org = await tx.organization.update({ where: { id: orgId }, data: { policy: normalized as Prisma.InputJsonValue } });
      return { result: { policy: org.policy }, orgId, payload: { resourceId: orgId } };
    });
  }

  // ── views ─────────────────────────────────────────────────────────────────
  async listDigitalEmployees(orgId: string) {
    const des = await this.prisma.digitalEmployee.findMany({
      where: { orgId },
      include: { role: true, person: true, team: true },
      orderBy: { createdAt: "desc" },
    });
    return des.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      role: d.role.key,
      person: d.person?.email ?? null,
      team: d.team?.name ?? null,
    }));
  }

  // ── resolver (core): the RoleBundle a device should run ────────────────────
  async resolveBundleForDevice(deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: { person: { include: { teams: true } }, org: true },
    });
    if (!device) throw new NotFoundException("device not found");
    const orgPolicy = (device.org.policy ?? {}) as Policy;

    if (!device.personId || !device.person) {
      return { version: 0, org_policy: mergePolicy(orgPolicy), roles: [] as BundleRole[] };
    }
    if (device.person.orgId !== device.orgId) {
      throw new UnauthorizedException("device organization binding is invalid");
    }
    const teamIds = device.person.teams.map((m) => m.teamId);
    const [assignments, teams] = await Promise.all([
      this.prisma.digitalEmployee.findMany({
        where: { orgId: device.orgId, status: "active", OR: [{ personId: device.personId }, { teamId: { in: teamIds } }] },
        include: {
          role: true,
          person: { select: { orgId: true } },
          team: { select: { orgId: true } },
        },
      }),
      teamIds.length
        ? this.prisma.team.findMany({ where: { id: { in: teamIds }, orgId: device.orgId } })
        : Promise.resolve([]),
    ]);
    if (teams.length !== new Set(teamIds).size) {
      throw new UnauthorizedException("team organization binding is invalid");
    }
    if (assignments.some((assignment) => (
      assignment.role.orgId !== device.orgId
      || (assignment.person && assignment.person.orgId !== device.orgId)
      || (assignment.team && assignment.team.orgId !== device.orgId)
    ))) {
      throw new UnauthorizedException("Agent assignment organization binding is invalid");
    }
    const applicableAssignments = assignments.filter((assignment) => !assignment.role.archivedAt);
    const mergedPolicy = mergePolicy(
      orgPolicy,
      ...teams.map((team) => (team.policy ?? {}) as Policy),
      ...applicableAssignments.map((assignment) => (assignment.policy ?? {}) as Policy),
    );

    const byId = new Map<string, (typeof assignments)[number]["role"]>();
    for (const a of applicableAssignments) byId.set(a.role.id, a.role);
    const roles = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));

    // Deterministic bundle identity: every effective policy or role-version change must invalidate the
    // device cache, including assignment-level deny-all rules that do not edit the Role itself.
    const version = Number.parseInt(sha256(JSON.stringify({
      policy: mergedPolicy,
      roles: roles.map((role) => ({ id: role.id, version: role.version })),
    })).slice(0, 8), 16);

    return {
      version,
      org_policy: mergedPolicy,
      roles: roles.map<BundleRole>((r) => ({
        name: r.key,
        description: r.description,
        owns: r.owns,
        rejects: r.rejects,
        model: r.model ?? undefined,
        allow_tools: r.allowTools,
        deny_tools: r.denyTools,
        system: r.system,
      })),
    };
  }

  /** Device-facing: resolve the bundle from a bearer device token (sha256 → DeviceToken → device). */
  async bundleForBearer(bearer: string | undefined) {
    if (!bearer) throw new UnauthorizedException("missing token");
    const dt = await this.prisma.deviceToken.findUnique({ where: { tokenHash: sha256(bearer) } });
    await assertTokenUsable(dt); // revocation + short-TTL expiry + spend-cap hook
    return this.resolveBundleForDevice(dt!.deviceId);
  }
}

export type BundleRole = {
  name: string;
  description: string;
  owns: string[];
  rejects: string[];
  model?: string;
  allow_tools: string[];
  deny_tools: string[];
  system: string;
};

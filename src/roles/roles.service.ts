import { Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementService } from "../license/license.service";
import { sha256 } from "../common/crypto";

/** Governance policy carried at org / team / assignment levels and merged (org < team < assignment). */
export type Policy = {
  modelAllow?: string[];
  modelDeny?: string[];
  toolDeny?: string[];
  requireApprovalForWrites?: boolean;
  budget?: Record<string, unknown>;
};

/** Merge governance policies. Deny-lists union, the approval flag OR-s, allow-list = last non-empty wins. */
export function mergePolicy(...layers: (Policy | undefined | null)[]): Policy {
  const modelDeny = new Set<string>();
  const toolDeny = new Set<string>();
  let modelAllow: string[] | undefined;
  let requireApprovalForWrites = false;
  let budget: Record<string, unknown> | undefined;
  for (const p of layers) {
    if (!p) continue;
    (p.modelDeny ?? []).forEach((m) => modelDeny.add(m));
    (p.toolDeny ?? []).forEach((t) => toolDeny.add(t));
    if (p.modelAllow?.length) modelAllow = p.modelAllow;
    if (p.requireApprovalForWrites) requireApprovalForWrites = true;
    if (p.budget) budget = { ...(budget ?? {}), ...p.budget };
  }
  const out: Policy = {};
  if (modelDeny.size) out.modelDeny = [...modelDeny];
  if (toolDeny.size) out.toolDeny = [...toolDeny];
  if (modelAllow) out.modelAllow = modelAllow;
  if (requireApprovalForWrites) out.requireApprovalForWrites = true;
  if (budget) out.budget = budget;
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

  // ── roles (digital-employee templates) ──────────────────────────────────
  async createRole(orgId: string, input: RoleInput) {
    this.entitlement.assert("agent-org"); // B3 is a licensed feature
    const role = await this.prisma.role.create({
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
    await this.audit.log(orgId, "role.create", "admin", role.id, { key: role.key });
    return role;
  }

  listRoles(orgId: string) {
    return this.prisma.role.findMany({ where: { orgId, archivedAt: null }, orderBy: { key: "asc" } });
  }

  async updateRole(id: string, input: Partial<RoleInput>) {
    const data: Prisma.RoleUpdateInput = { version: { increment: 1 } };
    if (input.description !== undefined) data.description = input.description;
    if (input.owns !== undefined) data.owns = input.owns;
    if (input.rejects !== undefined) data.rejects = input.rejects;
    if (input.model !== undefined) data.model = input.model;
    if (input.allowTools !== undefined) data.allowTools = input.allowTools;
    if (input.denyTools !== undefined) data.denyTools = input.denyTools;
    if (input.system !== undefined) data.system = input.system;
    const role = await this.prisma.role.update({ where: { id }, data });
    await this.audit.log(role.orgId, "role.update", "admin", role.id, { version: role.version });
    return role;
  }

  async archiveRole(id: string) {
    const role = await this.prisma.role.update({ where: { id }, data: { archivedAt: new Date() } });
    await this.audit.log(role.orgId, "role.archive", "admin", role.id);
    return { archived: true };
  }

  // ── persons / teams ──────────────────────────────────────────────────────
  createPerson(orgId: string, email: string, name = "") {
    return this.prisma.person.create({ data: { orgId, email, name } });
  }

  createTeam(orgId: string, name: string) {
    return this.prisma.team.create({ data: { orgId, name } });
  }

  async addTeamMember(teamId: string, personId: string) {
    await this.prisma.personTeam.upsert({
      where: { personId_teamId: { personId, teamId } },
      create: { personId, teamId },
      update: {},
    });
    return { ok: true };
  }

  async setTeamPolicy(teamId: string, policy: Policy) {
    const team = await this.prisma.team.update({ where: { id: teamId }, data: { policy: policy as Prisma.InputJsonValue } });
    await this.audit.log(team.orgId, "team.policy", "admin", teamId);
    return team;
  }

  // ── assignments (= 角色分配 / digital employees) ──────────────────────────
  async createAssignment(orgId: string, roleId: string, opts: { personId?: string; teamId?: string; name?: string }) {
    const de = await this.prisma.digitalEmployee.create({
      data: { orgId, roleId, personId: opts.personId ?? null, teamId: opts.teamId ?? null, name: opts.name ?? "" },
    });
    await this.audit.log(orgId, "assignment.create", "admin", de.id, { roleId, personId: opts.personId, teamId: opts.teamId });
    return de;
  }

  async deleteAssignment(id: string) {
    const de = await this.prisma.digitalEmployee.delete({ where: { id } });
    await this.audit.log(de.orgId, "assignment.delete", "admin", id);
    return { deleted: true };
  }

  async updateAssignment(id: string, data: { status?: string; policy?: Policy }) {
    const de = await this.prisma.digitalEmployee.update({
      where: { id },
      data: { ...(data.status ? { status: data.status } : {}), ...(data.policy ? { policy: data.policy as Prisma.InputJsonValue } : {}) },
    });
    await this.audit.log(de.orgId, "assignment.update", "admin", id, { status: de.status });
    return de;
  }

  async setOrgPolicy(orgId: string, policy: Policy) {
    const org = await this.prisma.organization.update({ where: { id: orgId }, data: { policy: policy as Prisma.InputJsonValue } });
    await this.audit.log(orgId, "org.policy", "admin", orgId);
    return { policy: org.policy };
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
      return { version: 0, org_policy: orgPolicy, roles: [] as BundleRole[] };
    }
    const teamIds = device.person.teams.map((m) => m.teamId);
    const [assignments, teams] = await Promise.all([
      this.prisma.digitalEmployee.findMany({
        where: { orgId: device.orgId, status: "active", OR: [{ personId: device.personId }, { teamId: { in: teamIds } }] },
        include: { role: true },
      }),
      teamIds.length ? this.prisma.team.findMany({ where: { id: { in: teamIds } } }) : Promise.resolve([]),
    ]);
    const mergedPolicy = mergePolicy(orgPolicy, ...teams.map((t) => (t.policy ?? {}) as Policy));

    const byId = new Map<string, (typeof assignments)[number]["role"]>();
    for (const a of assignments) if (a.role && !a.role.archivedAt) byId.set(a.role.id, a.role);
    const roles = [...byId.values()];

    // heuristic watermark: changes when an assigned role is edited (version++) or assignments change.
    const version = roles.reduce((s, r) => s + r.version, 0) + roles.length * 131 + (mergedPolicy.requireApprovalForWrites ? 1 : 0);

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
    if (!dt || dt.revokedAt) throw new UnauthorizedException("revoked or unknown token");
    return this.resolveBundleForDevice(dt.deviceId);
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

import { Injectable } from "@nestjs/common";
import type { Organization } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Hierarchy + downward-inheritance helpers over the self-referential `Organization` tree
 * (集团 GROUP → 公司 COMPANY → 部门 DEPARTMENT → 组 TEAM).
 *
 * Single-company mode = one COMPANY root (parentId null) with DEPARTMENT children. A group is the
 * same tree with a GROUP root above the COMPANY nodes — no schema change, just more rows. This
 * intentionally does NOT do SaaS tenant isolation; it's a clean hierarchy with inheritance.
 *
 * The selection core (`selectInherited`) is a PURE function over an already-walked ancestor array, so
 * it's unit-testable without a database. The DB-touching helpers (ancestors/descendants/resolveInherited)
 * just feed it.
 */

/** Max tree depth we'll walk before declaring the structure pathological (also a cycle backstop). */
export const MAX_ORG_DEPTH = 64;

/**
 * PURE downward-inheritance selection. `chain` is a LEAF-FIRST ancestor list — index 0 is the node
 * itself, the last element is the root (the order `ancestors()` returns). `pick` extracts the value of
 * interest from a node; the FIRST defined (non-undefined, non-null) value wins. That's downward
 * inheritance: a node's own value overrides its parent's, which overrides the grandparent's, … up to
 * the root. Returns undefined if no ancestor defines it.
 */
export function selectInherited<N, T>(chain: N[], pick: (node: N) => T | undefined | null): T | undefined {
  for (const node of chain) {
    const v = pick(node);
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

@Injectable()
export class OrgTreeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Walk parentId upward and return the ancestor chain LEAF-FIRST: [self, parent, …, root].
   * Throws on a cycle (a node reachable from itself) or a chain longer than MAX_ORG_DEPTH.
   * Throws if the starting node doesn't exist.
   */
  async ancestors(orgId: string): Promise<Organization[]> {
    const chain: Organization[] = [];
    const seen = new Set<string>();
    let currentId: string | null = orgId;

    while (currentId) {
      if (seen.has(currentId)) {
        throw new Error(`org hierarchy cycle detected at "${currentId}" (a node cannot be its own ancestor)`);
      }
      if (chain.length >= MAX_ORG_DEPTH) {
        throw new Error(`org hierarchy too deep (> ${MAX_ORG_DEPTH}) starting at "${orgId}" — likely a cycle`);
      }
      seen.add(currentId);
      const node: Organization | null = await this.prisma.organization.findUnique({ where: { id: currentId } });
      if (!node) {
        // The very first lookup missing = bad input; a missing parent mid-walk = dangling FK (stop cleanly).
        if (chain.length === 0) throw new Error(`org "${orgId}" not found`);
        break;
      }
      chain.push(node);
      currentId = node.parentId;
    }
    return chain;
  }

  /**
   * All node ids in the subtree rooted at `orgId`, INCLUDING `orgId` itself (BFS, cycle-guarded).
   * Use for "this company + all its departments/teams" scoping. Order is breadth-first from the root.
   */
  async descendants(orgId: string): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [orgId];

    while (queue.length) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue; // cycle / diamond guard — never revisit
      seen.add(id);
      out.push(id);
      if (out.length > MAX_ORG_DEPTH * MAX_ORG_DEPTH) {
        throw new Error(`org subtree under "${orgId}" too large — likely a cycle`);
      }
      const kids = await this.prisma.organization.findMany({ where: { parentId: id }, select: { id: true } });
      for (const k of kids) if (!seen.has(k.id)) queue.push(k.id);
    }
    return out;
  }

  /**
   * Resolve a single inherited value for `orgId`: walk its ancestors leaf-first and return the
   * nearest defined value (the node's own value beats an inherited one). Thin DB wrapper over the
   * pure `selectInherited`. Returns undefined if no ancestor defines it.
   *
   * Example — nearest non-empty model deny-list policy:
   *   resolveInherited(deptId, (o) => (o.policy as any)?.modelDeny)
   */
  async resolveInherited<T>(orgId: string, pick: (node: Organization) => T | undefined | null): Promise<T | undefined> {
    const chain = await this.ancestors(orgId);
    return selectInherited(chain, pick);
  }
}

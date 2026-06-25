# Org-unit hierarchy (集团 → 公司 → 部门 → 组)

**Decision (operator, 2026-06-26):** hara-control runs in **single-company mode** — it is **not** a
SaaS multi-tenant product. But the data model is **flexible to extend** to a group/conglomerate later.
A company has departments; a group has companies. So we bake a flexible multi-level hierarchy in now and
**do not** build SaaS tenant-isolation.

> This **replaces** the old "Phase 3 multi-tenant SaaS" direction (many orgs on one managed deployment).
> The Postgres RLS scaffolding in `HARDENING.md §A` stays as defense-in-depth, but the product is no
> longer steering toward multi-tenant SaaS — it's one company with an internal hierarchy.

## The model

`Organization` is now a **typed, self-referential tree**. Each row is one org *unit*:

| Field      | Meaning                                                                      |
| ---------- | --------------------------------------------------------------------------- |
| `type`     | `OrgUnitType` enum: `GROUP` (集团) / `COMPANY` (公司) / `DEPARTMENT` (部门) / `TEAM` (组). Default `COMPANY`. |
| `parentId` | `String?` — self-FK. `null` = a root unit; set = a child unit.               |
| `parent` / `children` | Prisma self-relation `"OrgTree"`.                                |

Nothing was renamed or removed — every existing relation (`devices`, `roles`, `teams`, `persons`,
`assets`, `workSessions`, …) is untouched. The change is purely additive.

### Single-company mode (today)

One `COMPANY` node with `parentId = null` (a root), and `DEPARTMENT` children under it. Optionally
`TEAM` units under departments. No `GROUP` node exists.

```
南荒科技 (COMPANY, parent=null)   ← root
 ├─ 工程部 (DEPARTMENT)
 │   └─ 平台组 (TEAM)
 └─ 财务部 (DEPARTMENT)
```

Every **pre-existing** `Organization` row becomes a `COMPANY` root automatically (the column DEFAULT),
so old data and the old `POST /admin/orgs {name}` contract keep working with zero changes.

### Group / conglomerate mode (future, no schema change)

Insert a `GROUP` root and point the `COMPANY` rows' `parentId` at it. The same tree, more rows:

```
南荒集团 (GROUP, parent=null)   ← root
 ├─ 南荒科技 (COMPANY)
 │   ├─ 工程部 (DEPARTMENT) → 平台组 (TEAM)
 │   └─ 财务部 (DEPARTMENT)
 └─ 另一家子公司 (COMPANY)
     └─ …
```

Type nesting is **advisory, not hard-enforced** — we validate a parent *exists* but don't reject odd
orderings, keeping the model flexible.

## API — `OrgTreeService` (`src/org/org-tree.service.ts`)

- **`ancestors(orgId) → Organization[]`** — walks `parentId` upward; returns **leaf-first**
  `[self, parent, …, root]`. Throws if the start node is missing, on a detected cycle, or past
  `MAX_ORG_DEPTH`.
- **`descendants(orgId) → string[]`** — BFS of the subtree, **including `orgId` itself**. Use for
  "this company **+ all** its departments/teams". Cycle/diamond-guarded.
- **`resolveInherited<T>(orgId, pick) → T | undefined`** — downward inheritance: walks ancestors
  leaf-first and returns the **nearest defined** value. A node's own value beats an inherited one; a
  department inherits its company's (then group's) setting unless it overrides. `undefined`/`null` from
  `pick` = "not defined here, keep walking up".
- **`selectInherited(chain, pick)`** — the **PURE** core of `resolveInherited` over an already-walked
  leaf-first array. No DB; unit-tested directly (`test/org-tree.test.ts`).

**Inheritance direction:** values flow **DOWN** the tree. The resolution *walks up* from the leaf and
takes the first defined value, which is the same thing: a child sees its own setting, else its parent's,
… up to the root. Falsy-but-defined values (`0`, `""`, `false`) count as defined and win.

**Cycle safety:** `ancestors` tracks visited ids and throws on revisit (a node can't be its own
ancestor); `descendants` skips already-seen ids so a malformed cycle can't loop forever. There's also a
depth cap (`MAX_ORG_DEPTH = 64`) as a backstop.

### Admin surface

- `POST /admin/orgs` — body `{ name, type?, parentId? }`. Omitting `type`/`parentId` = a standalone
  `COMPANY` root (unchanged contract). `parentId` is validated to exist (`400` otherwise).
- `GET /admin/orgs/:id/ancestors` — the leaf→root chain.
- `GET /admin/orgs/:id/subtree` — all unit ids in the subtree (incl. self).
- CLI: `org create <name> [--type T] [--parent id]` and `org tree <orgId>` (`cli/admin.ts`).

## Migration

`prisma/migrations/20260626010000_org_hierarchy/migration.sql` — additive + idempotent:

- `CREATE TYPE "OrgUnitType"` guarded by a `DO $$ … IF NOT EXISTS (pg_type) … $$` block.
- `ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "type" … DEFAULT 'COMPANY'` and
  `… ADD COLUMN IF NOT EXISTS "parentId" TEXT`.
- `CREATE INDEX IF NOT EXISTS "Organization_parentId_idx"`.
- Self-FK `Organization_parentId_fkey` (nullable, `ON DELETE SET NULL` — deleting a parent promotes its
  children to roots instead of cascading subtrees away), guarded via `pg_constraint` for re-runnability.

## Intentionally left for later

- **Folding the standalone `Team` model into the tree as `TEAM`-type units.** `Team` stays as-is for
  now (it carries `PersonTeam` membership, `Asset.teamId`, and `DigitalEmployee.teamId`); migrating it
  is a separate, larger change. The `TEAM` enum value exists so the tree is ready for it.
- **RLS over the hierarchy.** Current RLS policies are flat per-`orgId` (exact match). Subtree-aware
  visibility (a group admin sees all child companies' rows) would need policies that test membership in
  `descendants(current_org)` — out of scope here, and moot while single-company.
- **Hard type-nesting enforcement** (e.g. a `TEAM` must sit under a `DEPARTMENT`). Left advisory on
  purpose to keep the model flexible.

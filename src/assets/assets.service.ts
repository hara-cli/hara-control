import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AssetKind, AssetScope } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementService } from "../license/license.service";
import { EmbeddingService } from "../embed/embedding.service";
import { sha256 } from "../common/crypto";
import { redactSecrets, scanForInjection } from "./guard";

// Recall precedence among server-side scopes (the device merges its local project scope on top).
// More-local wins: personal > team = org > public.
const SCOPE_TIER: Record<AssetScope, number> = { PERSONAL: 3, TEAM: 2, ORG: 2, PUBLIC: 1 };

export type ContributeInput = {
  kind: AssetKind;
  scope: AssetScope;
  teamId?: string;
  slug: string;
  title?: string;
  summary?: string;
  lang?: string;
  tags?: string[];
  body: string;
};

@Injectable()
export class AssetsService {
  private readonly log = new Logger(AssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlement: EntitlementService,
    private readonly embedding: EmbeddingService,
  ) {}

  private async deviceFromBearer(bearer?: string) {
    if (!bearer) throw new UnauthorizedException("missing token");
    const dt = await this.prisma.deviceToken.findUnique({ where: { tokenHash: sha256(bearer) }, include: { device: true } });
    if (!dt || dt.revokedAt) throw new UnauthorizedException("revoked or unknown token");
    return dt.device;
  }

  private searchTextFor(title: string, summary: string | null, tags: string[], lang: string | null, body: string): string {
    return [title, summary ?? "", tags.join(" "), lang ?? "", body].join("\n").toLowerCase();
  }

  // ── device: contribute (capture → guard → IN_REVIEW; NEVER auto-publishes) ──────────────
  async contribute(bearer: string | undefined, input: ContributeInput) {
    this.entitlement.assert("code-assets");
    const device = await this.deviceFromBearer(bearer);
    const orgId = device.orgId;

    const scan = scanForInjection(input.body);
    if (!scan.ok) throw new BadRequestException(`blocked (cannot redact): ${scan.hits.join(", ")}`);
    const { text: body, redactions } = redactSecrets(input.body);
    const tags = input.tags ?? [];
    const title = input.title ?? input.slug;

    // dedup: one (orgId,scope,teamId,kind,slug) → new version on the existing asset, not a fork
    const existing = await this.prisma.asset.findFirst({
      where: { orgId, scope: input.scope, teamId: input.teamId ?? null, kind: input.kind, slug: input.slug },
    });
    const summary = input.summary ?? null;
    const asset = existing
      ? await this.prisma.asset.update({ where: { id: existing.id }, data: { lifecycle: "IN_REVIEW", title, summary, lang: input.lang ?? null, tags } })
      : await this.prisma.asset.create({
          data: {
            orgId, scope: input.scope, teamId: input.teamId ?? null, kind: input.kind, slug: input.slug,
            title, summary, lang: input.lang ?? null, tags, lifecycle: "IN_REVIEW", origin: "AUTHORED", ownerDeviceId: device.id,
          },
        });
    const version = await this.prisma.assetVersion.create({
      data: { assetId: asset.id, body, contentHash: sha256(body), redactions, createdByDeviceId: device.id },
    });
    await this.audit.log(orgId, "asset.contribute", "device", device.id, { assetId: asset.id, scope: input.scope, kind: input.kind, slug: input.slug, redactions });
    return { asset_id: asset.id, version_id: version.id, state: asset.lifecycle, redactions };
  }

  // ── device: manifest / get / search (published only, org-scoped) ────────────────────────
  async manifest(bearer: string | undefined, opts: { scope?: AssetScope; kind?: AssetKind; since?: string }) {
    const device = await this.deviceFromBearer(bearer);
    const assets = await this.prisma.asset.findMany({
      where: {
        orgId: device.orgId, lifecycle: "PUBLISHED",
        ...(opts.scope ? { scope: opts.scope } : {}),
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.since ? { updatedAt: { gt: new Date(opts.since) } } : {}),
      },
      include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
    });
    return assets.map((a) => ({
      id: a.id, kind: a.kind, scope: a.scope, slug: a.slug, team_id: a.teamId,
      content_hash: a.versions[0]?.contentHash ?? "", updated_at: a.updatedAt,
    }));
  }

  async getAsset(bearer: string | undefined, id: string) {
    const device = await this.deviceFromBearer(bearer);
    const asset = await this.prisma.asset.findFirst({
      where: { id, orgId: device.orgId, lifecycle: "PUBLISHED" },
      include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!asset?.versions[0]) throw new NotFoundException("asset not found or not published");
    return { id: asset.id, kind: asset.kind, scope: asset.scope, slug: asset.slug, body: asset.versions[0].body, content_hash: asset.versions[0].contentHash };
  }

  /** Hybrid search: lexical word-match ⊕ vector ANN (pgvector, when an embedder is configured),
   *  fused by Reciprocal Rank Fusion and weighted by scope tier. Degrades to pure lexical (the
   *  zero-dep floor) when embeddings are off. */
  async search(bearer: string | undefined, opts: { query: string; kind?: AssetKind; limit?: number }) {
    const device = await this.deviceFromBearer(bearer);
    const orgId = device.orgId;
    const words = opts.query.toLowerCase().split(/\s+/).filter(Boolean);

    const candidates = await this.prisma.asset.findMany({
      where: { orgId, lifecycle: "PUBLISHED", ...(opts.kind ? { kind: opts.kind } : {}) },
      take: 500,
    });
    const byId = new Map(candidates.map((a) => [a.id, a]));

    const lexRanked = candidates
      .map((a) => ({ id: a.id, score: words.filter((w) => a.searchText.includes(w)).length }))
      .filter((s) => s.score > 0)
      .sort((x, y) => y.score - x.score || byId.get(x.id)!.slug.length - byId.get(y.id)!.slug.length)
      .map((s) => s.id);

    let vecRanked: string[] = [];
    if (this.embedding.enabled()) {
      try {
        const qvec = await this.embedding.embedOne(opts.query);
        if (qvec) {
          const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT a.id FROM "Asset" a
               JOIN LATERAL (SELECT embedding, "embedModel" FROM "AssetVersion"
                             WHERE "assetId" = a.id ORDER BY "createdAt" DESC LIMIT 1) v ON true
              WHERE a."orgId" = $1 AND a.lifecycle = 'PUBLISHED'
                AND v.embedding IS NOT NULL AND v."embedModel" = $2
              ORDER BY v.embedding <=> $3::vector ASC LIMIT 50`,
            orgId, this.embedding.modelId(), EmbeddingService.toVectorLiteral(qvec),
          );
          vecRanked = rows.map((r) => r.id).filter((id) => byId.has(id));
        }
      } catch (e) {
        this.log.warn(`vector search failed, lexical only: ${(e as Error).message}`);
      }
    }

    // RRF fuse the two ranked lists, then weight by scope tier (more-local wins).
    const fused = new Map<string, number>();
    const fuse = (ids: string[]) => ids.forEach((id, i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + i)));
    fuse(lexRanked);
    fuse(vecRanked);

    return [...fused.entries()]
      .map(([id, rrf]) => ({ a: byId.get(id)!, score: rrf * (SCOPE_TIER[byId.get(id)!.scope] || 1) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, opts.limit ?? 10)
      .map(({ a, score }) => ({ id: a.id, kind: a.kind, scope: a.scope, slug: a.slug, title: a.title, score }));
  }

  /** Embed an asset version's haystack at publish (best-effort; lexical still works if it fails). */
  private async embedOnPublish(versionId: string, haystack: string): Promise<void> {
    if (!this.embedding.enabled()) return;
    try {
      const vec = await this.embedding.embedOne(haystack);
      if (!vec) return;
      await this.prisma.$executeRawUnsafe(
        `UPDATE "AssetVersion" SET embedding = $1::vector, "embedModel" = $2, "embedDim" = $3 WHERE id = $4`,
        EmbeddingService.toVectorLiteral(vec), this.embedding.modelId(), vec.length, versionId,
      );
    } catch (e) {
      this.log.warn(`embed-on-publish failed (lexical search still works): ${(e as Error).message}`);
    }
  }

  // ── admin: review / promote / deprecate (egress + lifecycle governance) ─────────────────
  async review(assetId: string, decision: "approve" | "reject") {
    this.entitlement.assert("code-assets");
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId }, include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } } });
    if (!asset) throw new NotFoundException("asset not found");
    if (decision === "reject") {
      await this.prisma.asset.update({ where: { id: assetId }, data: { lifecycle: "DRAFT" } });
      await this.audit.log(asset.orgId, "asset.review", "admin", assetId, { decision });
      return { lifecycle: "DRAFT" };
    }
    const body = asset.versions[0]?.body ?? "";
    const haystack = this.searchTextFor(asset.title, asset.summary, asset.tags, asset.lang, body);
    await this.prisma.asset.update({
      where: { id: assetId },
      data: { lifecycle: "PUBLISHED", searchText: haystack },
    });
    if (asset.versions[0]) await this.embedOnPublish(asset.versions[0].id, haystack);
    await this.audit.log(asset.orgId, "asset.review", "admin", assetId, { decision });
    return { lifecycle: "PUBLISHED" };
  }

  /** Copy-forward an asset up the scope ladder (re-guarded), landing IN_REVIEW with a provenance link. */
  async promote(assetId: string, toScope: AssetScope, toTeamId?: string) {
    this.entitlement.assert("code-assets");
    const src = await this.prisma.asset.findUnique({ where: { id: assetId }, include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } } });
    if (!src?.versions[0]) throw new NotFoundException("asset/version not found");
    const scan = scanForInjection(src.versions[0].body);
    if (!scan.ok) throw new BadRequestException(`blocked on promote: ${scan.hits.join(", ")}`);
    const { text: redacted, redactions } = redactSecrets(src.versions[0].body);
    const promoted = await this.prisma.asset.create({
      data: {
        orgId: src.orgId, scope: toScope, teamId: toTeamId ?? null, kind: src.kind, slug: src.slug,
        title: src.title, lang: src.lang, tags: src.tags, lifecycle: "IN_REVIEW", origin: "PROMOTED", promotedFromId: src.id,
      },
    });
    await this.prisma.assetVersion.create({ data: { assetId: promoted.id, body: redacted, contentHash: sha256(redacted), redactions } });
    await this.audit.log(src.orgId, "asset.promote", "admin", promoted.id, { from: assetId, fromScope: src.scope, toScope });
    return { asset_id: promoted.id, state: "in_review" };
  }

  async deprecate(assetId: string, supersededById?: string) {
    this.entitlement.assert("code-assets");
    const asset = await this.prisma.asset.update({ where: { id: assetId }, data: { lifecycle: "DEPRECATED", supersededById: supersededById ?? null } });
    await this.audit.log(asset.orgId, "asset.deprecate", "admin", assetId, { supersededById });
    return { lifecycle: "DEPRECATED" };
  }
}

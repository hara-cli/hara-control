import assert from "node:assert/strict";
import test from "node:test";
import { ConflictException } from "@nestjs/common";
import { AssetKind, AssetScope } from "@prisma/client";

import { AssetsService } from "../src/assets/assets.service";
import type { AuditService } from "../src/audit/audit.service";
import type { EmbeddingService } from "../src/embed/embedding.service";
import type { EntitlementService } from "../src/license/license.service";
import type { PrismaService } from "../src/prisma/prisma.service";

const noAudit = {
  log: async () => undefined,
} as unknown as AuditService;
const licensed = {
  assert: () => undefined,
} as unknown as EntitlementService;
const noEmbedding = {
  enabled: () => false,
} as unknown as EmbeddingService;

test("contribution changes lifecycle and appends its immutable version atomically", async () => {
  let inTransaction = false;
  const prisma = {
    deviceToken: {
      findUnique: async () => ({
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        device: { id: "device_1", orgId: "organization_1" },
      }),
    },
    $transaction: async (
      work: (transaction: object) => Promise<unknown>,
    ) => {
      inTransaction = true;
      try {
        return await work({
          asset: {
            findFirst: async () => null,
            create: async () => ({
              id: "asset_1",
              lifecycle: "IN_REVIEW",
            }),
          },
          assetVersion: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              assert.equal(inTransaction, true);
              assert.deepEqual(data.requiredCapabilities, ["file.read"]);
              assert.deepEqual(data.grantedCapabilities, []);
              return { id: "version_1" };
            },
          },
        });
      } finally {
        inTransaction = false;
      }
    },
  } as unknown as PrismaService;
  const service = new AssetsService(
    prisma,
    noAudit,
    licensed,
    noEmbedding,
  );

  const result = await service.contribute("synthetic-device-token", {
    kind: AssetKind.SKILL,
    scope: AssetScope.ORG,
    slug: "safe-reader",
    body: "Read an approved file.",
    requiredCapabilities: ["file.read"],
  });

  assert.deepEqual(result, {
    asset_id: "asset_1",
    version_id: "version_1",
    state: "IN_REVIEW",
    redactions: [],
  });
  assert.equal(inTransaction, false);
});

test("review grants are version-bound and reject a concurrent lifecycle change", async () => {
  const updatedAt = new Date("2026-08-01T12:00:00.000Z");
  let publishCount = 1;
  let reviewedCount = 1;
  const prisma = {
    asset: {
      findUnique: async () => ({
        id: "asset_1",
        orgId: "organization_1",
        lifecycle: "IN_REVIEW",
        kind: AssetKind.SKILL,
        title: "Safe reader",
        summary: null,
        tags: [],
        lang: null,
        updatedAt,
        versions: [{
          id: "version_1",
          body: "Read an approved file.",
          requiredCapabilities: ["file.read"],
        }],
      }),
    },
    $transaction: async (
      work: (transaction: object) => Promise<unknown>,
    ) => work({
      asset: {
        updateMany: async ({ where }: { where: Record<string, unknown> }) => {
          assert.equal(where.updatedAt, updatedAt);
          return { count: publishCount };
        },
      },
      assetVersion: {
        updateMany: async ({
          data,
          where,
        }: {
          data: Record<string, unknown>;
          where: Record<string, unknown>;
        }) => {
          assert.equal(where.id, "version_1");
          assert.equal(where.reviewedAt, null);
          assert.deepEqual(data.grantedCapabilities, ["file.read"]);
          return { count: reviewedCount };
        },
      },
    }),
  } as unknown as PrismaService;
  const service = new AssetsService(
    prisma,
    noAudit,
    licensed,
    noEmbedding,
  );

  assert.deepEqual(
    await service.review("asset_1", "approve", ["file.read"]),
    { lifecycle: "PUBLISHED" },
  );

  publishCount = 0;
  reviewedCount = 1;
  await assert.rejects(
    () => service.review("asset_1", "approve", ["file.read"]),
    ConflictException,
  );
});

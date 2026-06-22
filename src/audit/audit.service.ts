import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/** Append-only audit trail. payload is JSONB — queryable in Postgres. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(orgId: string, action: string, actorType: string, actorId = "", payload: Record<string, unknown> = {}) {
    await this.prisma.auditLog.create({
      data: { orgId, action, actorType, actorId, payload: payload as Prisma.InputJsonValue },
    });
  }
}

import { Body, Controller, Get, Headers, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { WorkService } from "./work.service";
import { AdminKeyGuard } from "../common/admin-key.guard";
import { IngestDto } from "./dto";

const bearer = (h?: string): string | undefined => (h?.startsWith("Bearer ") ? h.slice(7) : undefined);

// Device-facing: batched work-session ingest (device-token bearer). 202 = accepted.
@Controller("v1")
export class WorkDeviceController {
  constructor(private readonly work: WorkService) {}

  @Post("events")
  @HttpCode(202)
  ingest(@Headers("authorization") auth: string | undefined, @Body() dto: IngestDto) {
    return this.work.ingest(bearer(auth), dto.sessions);
  }
}

// Operator-facing compliance view (admin-key gated; Phase-2b → RBAC).
@Controller("admin/work")
@UseGuards(AdminKeyGuard)
export class WorkAdminController {
  constructor(private readonly work: WorkService) {}

  @Get()
  list(@Query("orgId") orgId: string, @Query("personId") personId?: string, @Query("limit") limit?: string) {
    return this.work.list(orgId, { personId, limit: limit ? Number(limit) : undefined });
  }
}

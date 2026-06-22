import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AssetKind, AssetScope } from "@prisma/client";
import { AssetsService } from "./assets.service";
import { AdminKeyGuard } from "../common/admin-key.guard";
import { ContributeDto, DeprecateDto, PromoteDto, ReviewDto, SearchDto } from "./dto";

const bearer = (h?: string): string | undefined => (h?.startsWith("Bearer ") ? h.slice(7) : undefined);

// Device-facing org code-asset endpoints (device-token bearer). Static routes are declared before
// the `:id` param route so they take precedence.
@Controller("v1/assets")
export class AssetsDeviceController {
  constructor(private readonly assets: AssetsService) {}

  @Get("manifest")
  manifest(@Headers("authorization") auth: string | undefined, @Query("scope") scope?: AssetScope, @Query("kind") kind?: AssetKind, @Query("since") since?: string) {
    return this.assets.manifest(bearer(auth), { scope, kind, since });
  }

  @Post("search")
  search(@Headers("authorization") auth: string | undefined, @Body() dto: SearchDto) {
    return this.assets.search(bearer(auth), dto);
  }

  @Post("contribute")
  contribute(@Headers("authorization") auth: string | undefined, @Body() dto: ContributeDto) {
    return this.assets.contribute(bearer(auth), dto);
  }

  @Get(":id")
  getAsset(@Headers("authorization") auth: string | undefined, @Param("id") id: string) {
    return this.assets.getAsset(bearer(auth), id);
  }
}

// Operator-facing review / promotion / lifecycle (admin-key gated; Phase-2b → RBAC).
@Controller("admin/assets")
@UseGuards(AdminKeyGuard)
export class AssetsAdminController {
  constructor(private readonly assets: AssetsService) {}

  @Post(":id/review")
  review(@Param("id") id: string, @Body() dto: ReviewDto) {
    return this.assets.review(id, dto.decision);
  }

  @Post(":id/promote")
  promote(@Param("id") id: string, @Body() dto: PromoteDto) {
    return this.assets.promote(id, dto.toScope, dto.toTeamId);
  }

  @Post(":id/deprecate")
  deprecate(@Param("id") id: string, @Body() dto: DeprecateDto) {
    return this.assets.deprecate(id, dto.supersededById);
  }
}

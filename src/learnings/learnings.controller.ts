import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  AdminAuthGuard,
  assertAdminOrgAccess,
  type AuthedUser,
} from "../common/admin-auth.guard";
import {
  ReviewLearningCandidateDto,
  SubmitLearningCandidateDto,
} from "./dto";
import { LearningsService } from "./learnings.service";

const bearer = (authorization?: string): string | undefined =>
  authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;

@Controller("v1")
export class LearningsDeviceController {
  constructor(private readonly learnings: LearningsService) {}

  @Post("learnings/candidates")
  submit(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: SubmitLearningCandidateDto,
  ) {
    return this.learnings.submit(bearer(authorization), body);
  }

  @Get("learnings")
  bundle(@Headers("authorization") authorization?: string) {
    return this.learnings.bundle(bearer(authorization));
  }
}

@Controller("admin")
@UseGuards(AdminAuthGuard)
export class LearningsAdminController {
  constructor(private readonly learnings: LearningsService) {}

  @Get("learnings")
  list(
    @Req() request: { user?: AuthedUser },
    @Query("orgId") orgId: string,
    @Query("status") status?: string,
  ) {
    assertAdminOrgAccess(request.user!, orgId);
    return this.learnings.list(orgId, status);
  }

  @Post("learnings/:id/review")
  async review(
    @Req() request: { user?: AuthedUser },
    @Param("id") id: string,
    @Body() body: ReviewLearningCandidateDto,
  ) {
    const orgId = await this.learnings.candidateOrgId(id);
    assertAdminOrgAccess(request.user!, orgId);
    return this.learnings.review(id, body, request.user!);
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AdminRole } from "@prisma/client";
import { AdminAuthGuard, Roles, type AuthedUser } from "../common/admin-auth.guard";
import {
  ClaimedFeedbackTicketUpdateDto,
  IntakeFeedbackTicketDto,
  UpdateFeedbackTicketDto,
} from "./dto";
import { FeedbackIntakeGuard } from "./feedback-intake.guard";
import { FeedbackTicketsService } from "./feedback-tickets.service";

@Controller("v1/internal/feedback-tickets")
@UseGuards(FeedbackIntakeGuard)
export class InternalFeedbackTicketsController {
  constructor(private readonly tickets: FeedbackTicketsService) {}

  @Post("intake")
  intake(@Body() dto: IntakeFeedbackTicketDto) {
    return this.tickets.intake(dto);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() dto: ClaimedFeedbackTicketUpdateDto,
  ) {
    return this.tickets.updateClaimed(id, dto);
  }
}

@Controller("admin/feedback-tickets")
@UseGuards(AdminAuthGuard)
@Roles(AdminRole.SUPERADMIN)
export class AdminFeedbackTicketsController {
  constructor(private readonly tickets: FeedbackTicketsService) {}

  @Get()
  list(
    @Query("status") status?: string,
    @Query("kind") kind?: string,
    @Query("priority") priority?: string,
    @Query("limit") limit?: string,
  ) {
    return this.tickets.list({ status, kind, priority, limit: Number(limit || 100) });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.tickets.get(id);
  }

  @Patch(":id")
  update(
    @Req() req: { user?: AuthedUser },
    @Param("id") id: string,
    @Body() dto: UpdateFeedbackTicketDto,
  ) {
    return this.tickets.update(id, dto, req.user!);
  }
}

import { Module } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { FeedbackIntakeGuard } from "./feedback-intake.guard";
import {
  AdminFeedbackTicketsController,
  InternalFeedbackTicketsController,
} from "./feedback-tickets.controller";
import { FeedbackTicketsService } from "./feedback-tickets.service";

@Module({
  imports: [PrismaModule],
  controllers: [InternalFeedbackTicketsController, AdminFeedbackTicketsController],
  providers: [FeedbackTicketsService, FeedbackIntakeGuard, AdminAuthGuard],
})
export class FeedbackTicketsModule {}

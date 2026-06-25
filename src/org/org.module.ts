import { Module } from "@nestjs/common";
import { OrgTreeService } from "./org-tree.service";

// Hierarchy helpers over the self-referential Organization tree. PrismaModule is global, so we only
// need to provide + export the service for other modules (Admin) to inject.
@Module({ providers: [OrgTreeService], exports: [OrgTreeService] })
export class OrgModule {}

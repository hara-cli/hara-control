import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Run `fn` inside a tenant-scoped transaction: sets the `app.current_org` session var (LOCAL to the
   * transaction) so Postgres RLS policies (USING orgId = current_setting('app.current_org')) isolate
   * rows to this org on the SAME connection. This is the saas multi-tenant enforcement primitive.
   */
  async withOrg<T>(orgId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, true)`;
      return fn(tx);
    });
  }
}

import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  live() {
    return this.health.live();
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.health.ready();
    if (result.status !== "ok") res.status(503);
    return result;
  }
}

import { Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { EnrollService } from "./enroll.service";
import { EnrollDto, HeartbeatDto } from "../protocol/dto";

const bearer = (h?: string): string | undefined => (h?.startsWith("Bearer ") ? h.slice(7) : undefined);

// The device-facing endpoints the hara CLI calls (see src/org-fleet/enroll.ts). Public (code-gated),
// not behind the admin guard.
@Controller("v1")
export class EnrollController {
  constructor(private readonly enroll: EnrollService) {}

  @Post("enroll")
  enrollDevice(@Body() dto: EnrollDto) {
    return this.enroll.enroll(dto.code, dto.device);
  }

  @Post("heartbeat")
  @HttpCode(200)
  async heartbeat(@Headers("authorization") auth: string | undefined, @Body() dto: HeartbeatDto) {
    return this.enroll.heartbeat(bearer(auth), dto);
  }
}

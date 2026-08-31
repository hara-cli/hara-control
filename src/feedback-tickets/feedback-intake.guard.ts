import { timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { loadFeedbackIntakeKey } from "../config/feedback-intake";

function secureEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

/** Purpose-scoped authentication for the feedback monitor. Never accept the broad admin key here. */
@Injectable()
export class FeedbackIntakeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = loadFeedbackIntakeKey();
    if (!expected) {
      throw new UnauthorizedException("feedback intake is not configured");
    }
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const raw = request.headers["x-hara-feedback-key"];
    const actual = Array.isArray(raw) ? raw[0] : raw;
    if (!actual || !secureEquals(actual, expected)) {
      throw new UnauthorizedException("invalid feedback intake credential");
    }
    return true;
  }
}

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DesktopCrashAlertState, DesktopCrashReportStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthedUser } from "../common/admin-auth.guard";
import { sanitizeControlText } from "../common/redact";
import type {
  SubmitDesktopCrashReportDto,
  UpdateDesktopCrashReportDto,
} from "./dto";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const FINGERPRINT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_GLOBAL_PER_HOUR = 1_000;
const MAX_PER_FINGERPRINT_PER_DAY = 12;
export function sanitizeCrashText(value: string, max: number): string {
  return sanitizeControlText(value, max);
}

@Injectable()
export class CrashReportsService {
  private globalSubmissions: number[] = [];
  private readonly fingerprintSubmissions = new Map<string, number[]>();
  private lastRateLimitCleanup = 0;
  private lastRetentionCleanup = 0;

  constructor(private readonly prisma: PrismaService) {}

  private enforceRateLimit(fingerprint: string, now: number): void {
    this.globalSubmissions = this.globalSubmissions.filter((at) => now - at < GLOBAL_WINDOW_MS);
    if (this.globalSubmissions.length >= MAX_GLOBAL_PER_HOUR) {
      throw new HttpException("crash report intake is temporarily busy", HttpStatus.TOO_MANY_REQUESTS);
    }
    const recent = (this.fingerprintSubmissions.get(fingerprint) ?? [])
      .filter((at) => now - at < FINGERPRINT_WINDOW_MS);
    if (recent.length >= MAX_PER_FINGERPRINT_PER_DAY) {
      throw new HttpException("this crash was already reported", HttpStatus.TOO_MANY_REQUESTS);
    }
    this.globalSubmissions.push(now);
    recent.push(now);
    this.fingerprintSubmissions.set(fingerprint, recent);
    if (now - this.lastRateLimitCleanup >= GLOBAL_WINDOW_MS) {
      for (const [key, entries] of this.fingerprintSubmissions) {
        const active = entries.filter((at) => now - at < FINGERPRINT_WINDOW_MS);
        if (active.length) this.fingerprintSubmissions.set(key, active);
        else this.fingerprintSubmissions.delete(key);
      }
      this.lastRateLimitCleanup = now;
    }
  }

  async submit(dto: SubmitDesktopCrashReportDto) {
    const now = Date.now();
    const occurredAt = new Date(dto.occurredAt);
    if (
      !Number.isFinite(occurredAt.getTime())
      || occurredAt.getTime() < now - RETENTION_MS
      || occurredAt.getTime() > now + MAX_CLOCK_SKEW_MS
    ) {
      throw new BadRequestException("crash occurrence time is outside the accepted window");
    }
    this.enforceRateLimit(dto.fingerprint, now);
    const summary = sanitizeCrashText(dto.summary, 500) || "Hara Desktop did not close normally";
    const userDescription = sanitizeCrashText(dto.userDescription ?? "", 1200);
    const context = dto.context.map((entry) => sanitizeCrashText(entry, 80)).filter(Boolean);
    const report = await this.prisma.desktopCrashReport.upsert({
      where: {
        fingerprint_appVersion_platform_arch_kind: {
          fingerprint: dto.fingerprint,
          appVersion: dto.appVersion,
          platform: dto.platform,
          arch: dto.arch,
          kind: dto.kind,
        },
      },
      create: {
        reportVersion: dto.reportVersion,
        consentVersion: dto.consentVersion,
        appVersion: dto.appVersion,
        engineVersion: dto.engineVersion ?? "",
        platform: dto.platform,
        arch: dto.arch,
        kind: dto.kind,
        fingerprint: dto.fingerprint,
        summary,
        userDescription,
        context,
        lastOccurredAt: occurredAt,
      },
      update: {
        occurrenceCount: { increment: 1 },
        engineVersion: dto.engineVersion ?? "",
        summary,
        ...(userDescription ? { userDescription } : {}),
        context,
        lastOccurredAt: occurredAt,
      },
      select: { id: true, status: true, occurrenceCount: true },
    });
    if (report.status === DesktopCrashReportStatus.RESOLVED) {
      await this.prisma.desktopCrashReport.updateMany({
        where: { id: report.id, status: DesktopCrashReportStatus.RESOLVED },
        data: {
          status: DesktopCrashReportStatus.NEW,
          alertState: DesktopCrashAlertState.PENDING,
          alertGeneration: { increment: 1 },
          alertAttempts: 0,
          alertNextAttemptAt: new Date(),
          alertClaimedAt: null,
          alertDeliveredAt: null,
          alertLastError: "",
          reviewNote: "",
          reviewedBy: "",
          reviewedAt: null,
        },
      });
    }
    if (now - this.lastRetentionCleanup >= GLOBAL_WINDOW_MS) {
      this.lastRetentionCleanup = now;
      void this.prisma.desktopCrashReport.deleteMany({
        where: { lastOccurredAt: { lt: new Date(now - RETENTION_MS) } },
      }).catch(() => undefined);
    }
    return {
      reportId: report.id,
      status: "received" as const,
      occurrenceCount: report.occurrenceCount,
    };
  }

  list(status?: string, limit = 100) {
    if (status && !Object.values(DesktopCrashReportStatus).includes(status as DesktopCrashReportStatus)) {
      throw new BadRequestException("invalid crash report status");
    }
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(200, Math.trunc(limit)))
      : 100;
    return this.prisma.desktopCrashReport.findMany({
      where: status ? { status: status as DesktopCrashReportStatus } : undefined,
      orderBy: { lastOccurredAt: "desc" },
      take: boundedLimit,
    });
  }

  async get(id: string) {
    const report = await this.prisma.desktopCrashReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException("crash report not found");
    return report;
  }

  async retryAlert(id: string) {
    const existing = await this.prisma.desktopCrashReport.findUnique({
      where: { id },
      select: { id: true, alertState: true },
    });
    if (!existing) throw new NotFoundException("crash report not found");
    if (existing.alertState !== DesktopCrashAlertState.FAILED) {
      throw new BadRequestException("only a failed crash alert can be retried manually");
    }
    return this.prisma.desktopCrashReport.update({
      where: { id },
      data: {
        alertState: DesktopCrashAlertState.PENDING,
        alertAttempts: 0,
        alertNextAttemptAt: new Date(),
        alertClaimedAt: null,
        alertLastError: "",
      },
    });
  }

  async update(id: string, dto: UpdateDesktopCrashReportDto, actor: AuthedUser) {
    const existing = await this.prisma.desktopCrashReport.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException("crash report not found");
    return this.prisma.desktopCrashReport.update({
      where: { id },
      data: {
        status: dto.status,
        reviewNote: sanitizeCrashText(dto.note ?? "", 1000),
        reviewedBy: actor.email || actor.id,
        reviewedAt: new Date(),
      },
    });
  }
}

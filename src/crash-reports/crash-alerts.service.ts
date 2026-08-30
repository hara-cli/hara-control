import { createHash } from "node:crypto";
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DesktopCrashAlertState, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const FEISHU_ORIGIN = "https://open.feishu.cn";
const POLL_INTERVAL_MS = 15_000;
const CLAIM_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 60 * 60_000;

const APP_ID_PATTERN = /^cli_[A-Za-z0-9]+$/u;
const CHAT_ID_PATTERN = /^oc_[A-Za-z0-9]+$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9]+$/u;

export interface CrashAlertView {
  id: string;
  appVersion: string;
  engineVersion: string;
  platform: string;
  arch: string;
  kind: string;
  occurrenceCount: number;
  alertGeneration: number;
}

export interface CrashAlertSender {
  send(report: CrashAlertView): Promise<void>;
}

interface FeishuCrashAlertConfig {
  appId: string;
  appSecret: string;
  chatId: string;
  mentionOpenId: string;
}

interface FeishuApiResult {
  code?: number;
  tenant_access_token?: string;
  expire?: number;
}

function configuredValue(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] ?? "").trim();
}

export function loadCrashAlertConfig(
  env: NodeJS.ProcessEnv = process.env,
): FeishuCrashAlertConfig | null {
  const config = {
    appId: configuredValue(env, "HARA_CRASH_FEISHU_APP_ID"),
    appSecret: configuredValue(env, "HARA_CRASH_FEISHU_APP_SECRET"),
    chatId: configuredValue(env, "HARA_CRASH_FEISHU_CHAT_ID"),
    mentionOpenId: configuredValue(env, "HARA_CRASH_FEISHU_MENTION_OPEN_ID"),
  };
  const values = Object.values(config);
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value)) {
    throw new Error("Hara crash alerts require all four HARA_CRASH_FEISHU_* settings");
  }
  if (!APP_ID_PATTERN.test(config.appId)) {
    throw new Error("HARA_CRASH_FEISHU_APP_ID is invalid");
  }
  if (config.appSecret.length < 20) {
    throw new Error("HARA_CRASH_FEISHU_APP_SECRET is invalid");
  }
  if (!CHAT_ID_PATTERN.test(config.chatId)) {
    throw new Error("HARA_CRASH_FEISHU_CHAT_ID is invalid");
  }
  if (!OPEN_ID_PATTERN.test(config.mentionOpenId)) {
    throw new Error("HARA_CRASH_FEISHU_MENTION_OPEN_ID is invalid");
  }
  return config;
}

function safeField(value: string, fallback: string): string {
  const normalized = value.replace(/[^0-9A-Za-z._/-]/gu, "").slice(0, 64);
  return normalized || fallback;
}

export function buildCrashAlertText(
  report: CrashAlertView,
  mentionOpenId: string,
): string {
  if (!OPEN_ID_PATTERN.test(mentionOpenId)) {
    throw new Error("invalid Feishu mention target");
  }
  const engine = report.engineVersion ? safeField(report.engineVersion, "unknown") : "unknown";
  return [
    `<at user_id="${mentionOpenId}">南荒bot</at>`,
    "【Hara Crash Intake · 自动告警】",
    `报告 ID：${safeField(report.id, "unknown")}`,
    `版本：Desktop ${safeField(report.appVersion, "unknown")} · Engine ${engine}`,
    `环境：${safeField(report.platform, "unknown")}/${safeField(report.arch, "unknown")}`,
    `类型：${safeField(report.kind, "unknown")}`,
    `发生次数：${Math.max(1, Math.trunc(report.occurrenceCount))}`,
    "完整诊断信息已脱敏保存在 Hara Control；本消息不含用户描述、会话、文件内容、路径或凭据。",
    "请按报告 ID 从受保护的管理员接口读取详情，并先回复确认后再处理。",
  ].join("\n");
}

export function crashAlertUuid(reportId: string, generation: number): string {
  const hex = createHash("sha256")
    .update(`${reportId}:${Math.max(1, Math.trunc(generation))}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export class FeishuCrashAlertSender implements CrashAlertSender {
  private token = "";
  private tokenExpiresAt = 0;

  constructor(
    private readonly config: FeishuCrashAlertConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async requestJson(
    path: string,
    body: Record<string, unknown>,
    token?: string,
  ): Promise<FeishuApiResult> {
    const response = await this.request(`${FEISHU_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let result: FeishuApiResult = {};
    try {
      result = await response.json() as FeishuApiResult;
    } catch {
      throw new Error(`Feishu request failed (HTTP ${response.status}, invalid JSON)`);
    }
    if (!response.ok || result.code !== 0) {
      throw new Error(`Feishu request failed (HTTP ${response.status}, code ${result.code ?? "unknown"})`);
    }
    return result;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.tokenExpiresAt > Date.now() + 60_000) return this.token;
    const result = await this.requestJson(
      "/open-apis/auth/v3/tenant_access_token/internal",
      { app_id: this.config.appId, app_secret: this.config.appSecret },
    );
    const token = String(result.tenant_access_token ?? "");
    if (!token) throw new Error("Feishu authentication succeeded without a tenant token");
    this.token = token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(result.expire) || 7200) * 1000;
    return token;
  }

  async send(report: CrashAlertView): Promise<void> {
    const text = buildCrashAlertText(report, this.config.mentionOpenId);
    await this.requestJson(
      "/open-apis/im/v1/messages?receive_id_type=chat_id",
      {
        receive_id: this.config.chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
        uuid: crashAlertUuid(report.id, report.alertGeneration),
      },
      await this.accessToken(),
    );
  }
}

function safeDeliveryError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown delivery failure";
  return error.message
    .replace(/Bearer\s+\S+/giu, "Bearer ***")
    .replace(/(?:app[_-]?secret|token|authorization)\s*[:=]\s*\S+/giu, "credential=***")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300) || "unknown delivery failure";
}

@Injectable()
export class CrashReportAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CrashReportAlertsService.name);
  private sender: CrashAlertSender | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    const config = loadCrashAlertConfig();
    if (!config) {
      this.log.log("crash alert delivery disabled; reports remain queued in Control");
      return;
    }
    this.sender = new FeishuCrashAlertSender(config);
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running || !this.sender) return;
    this.running = true;
    try {
      while (await this.processOne(this.sender)) {
        // Drain the bounded queue before sleeping; each row is atomically claimed.
      }
    } catch (error) {
      this.log.warn(`crash alert worker paused: ${safeDeliveryError(error)}`);
    } finally {
      this.running = false;
    }
  }

  async processOne(sender: CrashAlertSender, now = new Date()): Promise<boolean> {
    const staleClaim = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
    const ready: Prisma.DesktopCrashReportWhereInput = {
      alertAttempts: { lt: MAX_ATTEMPTS },
      OR: [
        {
          alertState: DesktopCrashAlertState.PENDING,
          alertNextAttemptAt: { lte: now },
        },
        {
          alertState: DesktopCrashAlertState.SENDING,
          alertClaimedAt: { lte: staleClaim },
        },
      ],
    };
    const candidate = await this.prisma.desktopCrashReport.findFirst({
      where: ready,
      select: { id: true, alertAttempts: true },
      orderBy: { alertNextAttemptAt: "asc" },
    });
    if (!candidate) return false;

    const claimed = await this.prisma.desktopCrashReport.updateMany({
      where: { id: candidate.id, ...ready },
      data: {
        alertState: DesktopCrashAlertState.SENDING,
        alertAttempts: { increment: 1 },
        alertClaimedAt: now,
      },
    });
    if (claimed.count !== 1) return true;

    const report = await this.prisma.desktopCrashReport.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        appVersion: true,
        engineVersion: true,
        platform: true,
        arch: true,
        kind: true,
        occurrenceCount: true,
        alertGeneration: true,
        alertAttempts: true,
      },
    });
    if (!report) return true;

    try {
      await sender.send(report);
      await this.prisma.desktopCrashReport.updateMany({
        where: {
          id: report.id,
          alertState: DesktopCrashAlertState.SENDING,
          alertClaimedAt: now,
        },
        data: {
          alertState: DesktopCrashAlertState.SENT,
          alertDeliveredAt: new Date(),
          alertClaimedAt: null,
          alertLastError: "",
        },
      });
    } catch (error) {
      const terminal = report.alertAttempts >= MAX_ATTEMPTS;
      const backoff = Math.min(MAX_BACKOFF_MS, 30_000 * (2 ** Math.max(0, report.alertAttempts - 1)));
      await this.prisma.desktopCrashReport.updateMany({
        where: {
          id: report.id,
          alertState: DesktopCrashAlertState.SENDING,
          alertClaimedAt: now,
        },
        data: {
          alertState: terminal ? DesktopCrashAlertState.FAILED : DesktopCrashAlertState.PENDING,
          alertNextAttemptAt: new Date(now.getTime() + backoff),
          alertClaimedAt: null,
          alertLastError: safeDeliveryError(error),
        },
      });
    }
    return true;
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, HttpException, NotFoundException } from "@nestjs/common";
import { AdminRole, DesktopCrashAlertState } from "@prisma/client";
import type { PrismaService } from "../src/prisma/prisma.service";
import { CrashReportsService, sanitizeCrashText } from "../src/crash-reports/crash-reports.service";
import {
  buildCrashAlertText,
  crashAlertUuid,
  CrashReportAlertsService,
  FeishuCrashAlertSender,
  loadCrashAlertConfig,
  type CrashAlertSender,
} from "../src/crash-reports/crash-alerts.service";
import type { SubmitDesktopCrashReportDto } from "../src/crash-reports/dto";

function validReport(fingerprint = "a".repeat(64)): SubmitDesktopCrashReportDto {
  return {
    reportVersion: 1,
    consentVersion: 1,
    appVersion: "0.1.126",
    engineVersion: "0.157.0",
    platform: "windows",
    arch: "x86_64",
    kind: "renderer_exception",
    fingerprint,
    occurredAt: "2026-08-30T15:45:00.000Z",
    summary: "TypeError reached the Hara renderer recovery boundary",
    userDescription: "Clicked New session",
    context: ["App", "SessionList"],
  };
}

function fakePrisma() {
  let row: Record<string, unknown> | null = null;
  let lastDeleteWhere: unknown;
  let lastListArgs: unknown;
  const desktopCrashReport = {
    upsert: async (args: {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      if (row) {
        row = {
          ...row,
          ...args.update,
          occurrenceCount: Number(row.occurrenceCount) + 1,
        };
      } else {
        row = {
          id: "crash_1",
          status: "NEW",
          alertState: "PENDING",
          alertGeneration: 1,
          alertAttempts: 0,
          alertNextAttemptAt: new Date(0),
          alertClaimedAt: null,
          alertDeliveredAt: null,
          alertLastError: "",
          occurrenceCount: 1,
          ...args.create,
        };
      }
      return {
        id: row.id,
        status: row.status,
        occurrenceCount: row.occurrenceCount,
      };
    },
    deleteMany: async ({ where }: { where: unknown }) => {
      lastDeleteWhere = where;
      return { count: 0 };
    },
    updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
      if (row && row.id === where.id && row.status === where.status) {
        const next = { ...data };
        if (data.alertGeneration && typeof data.alertGeneration === "object") {
          row.alertGeneration = Number(row.alertGeneration) + 1;
          delete next.alertGeneration;
        }
        row = { ...row, ...next };
        return { count: 1 };
      }
      return { count: 0 };
    },
    findMany: async (args: unknown) => {
      lastListArgs = args;
      return row ? [row] : [];
    },
    findUnique: async () => row ? { ...row } : null,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      row = { ...(row ?? {}), ...data };
      return row;
    },
  };
  return {
    prisma: { desktopCrashReport } as unknown as PrismaService,
    row: () => row,
    setRow: (value: Record<string, unknown> | null) => { row = value; },
    lastDeleteWhere: () => lastDeleteWhere,
    lastListArgs: () => lastListArgs,
  };
}

test("crash intake redacts credentials and local paths before persistence", async () => {
  const fake = fakePrisma();
  const service = new CrashReportsService(fake.prisma);
  const report = validReport();
  report.userDescription = [
    "api_key=sk-supersecret123456",
    "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "/Users/alice/work/customer/ledger.db",
    "C:\\Users\\Alice\\work\\customer.txt",
  ].join(" ");
  report.context = ["App", "token=forbiddenvalue"];

  const beforeSubmit = Date.now();
  const receipt = await service.submit(report);
  const persisted = fake.row();
  const serialized = JSON.stringify(persisted);

  assert.deepEqual(receipt, { reportId: "crash_1", status: "received", occurrenceCount: 1 });
  assert.doesNotMatch(serialized, /supersecret|eyJhbGci|alice|forbiddenvalue/i);
  assert.match(serialized, /credential=\*\*\*|<secret>/);
  assert.match(serialized, /<local-path>/);
  const deleteWhere = fake.lastDeleteWhere() as { lastOccurredAt: { lt: Date } };
  const retentionCutoff = deleteWhere.lastOccurredAt.lt.getTime();
  assert.ok(retentionCutoff >= beforeSubmit - 90 * 24 * 60 * 60 * 1000);
  assert.ok(retentionCutoff <= Date.now() - 90 * 24 * 60 * 60 * 1000);
});

test("crash intake deduplicates matching builds and bounds repeated submissions", async () => {
  const fake = fakePrisma();
  const service = new CrashReportsService(fake.prisma);
  const report = validReport("b".repeat(64));

  const first = await service.submit(report);
  const second = await service.submit(report);
  assert.equal(first.occurrenceCount, 1);
  assert.equal(second.occurrenceCount, 2);

  for (let index = 0; index < 10; index += 1) await service.submit(report);
  await assert.rejects(() => service.submit(report), (error: unknown) => {
    assert.ok(error instanceof HttpException);
    assert.equal(error.getStatus(), 429);
    return true;
  });
});

test("crash intake rejects stale or future-dated reports before persistence", async () => {
  const fake = fakePrisma();
  const service = new CrashReportsService(fake.prisma);
  const stale = validReport("1".repeat(64));
  stale.occurredAt = "2020-01-01T00:00:00.000Z";
  await assert.rejects(() => service.submit(stale), BadRequestException);

  const future = validReport("2".repeat(64));
  future.occurredAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await assert.rejects(() => service.submit(future), BadRequestException);
  assert.equal(fake.row(), null);
});

test("ordinary duplicates do not requeue a delivered alert, but a resolved recurrence does", async () => {
  const fake = fakePrisma();
  const service = new CrashReportsService(fake.prisma);
  const report = validReport("c".repeat(64));

  await service.submit(report);
  Object.assign(fake.row()!, {
    status: "REVIEWING",
    alertState: "SENT",
    alertAttempts: 1,
    alertDeliveredAt: new Date("2026-08-30T16:00:00.000Z"),
  });
  await service.submit(report);
  assert.equal(fake.row()!.alertState, "SENT");

  Object.assign(fake.row()!, { status: "RESOLVED" });
  await service.submit(report);
  assert.equal(fake.row()!.status, "NEW");
  assert.equal(fake.row()!.alertState, "PENDING");
  assert.equal(fake.row()!.alertGeneration, 2);
  assert.equal(fake.row()!.alertAttempts, 0);
  assert.equal(fake.row()!.alertDeliveredAt, null);
});

test("admin crash listing rejects unknown state and normalizes invalid limits", async () => {
  const fake = fakePrisma();
  const service = new CrashReportsService(fake.prisma);

  assert.throws(() => service.list("BROKEN"), BadRequestException);
  await service.list(undefined, Number.NaN);
  assert.deepEqual(fake.lastListArgs(), {
    where: undefined,
    orderBy: { lastOccurredAt: "desc" },
    take: 100,
  });
});

test("admin review fails closed for an unknown crash report", async () => {
  const fake = fakePrisma();
  const service = new CrashReportsService(fake.prisma);
  await assert.rejects(
    () => service.update("missing", { status: "REVIEWING" }, {
      id: "operator_1",
      email: "operator@example.test",
      role: AdminRole.SUPERADMIN,
    }),
    NotFoundException,
  );
});

test("admin can read one report and manually requeue only a failed alert", async () => {
  const fake = fakePrisma();
  const service = new CrashReportsService(fake.prisma);
  await service.submit(validReport("d".repeat(64)));

  assert.equal((await service.get("crash_1")).id, "crash_1");
  Object.assign(fake.row()!, {
    alertState: DesktopCrashAlertState.FAILED,
    alertAttempts: 8,
    alertLastError: "delivery failed",
  });
  const retried = await service.retryAlert("crash_1");
  assert.equal(retried.alertState, DesktopCrashAlertState.PENDING);
  assert.equal(retried.alertAttempts, 0);
  assert.equal(retried.alertLastError, "");
  await assert.rejects(() => service.retryAlert("crash_1"), BadRequestException);
});

test("standalone crash sanitizer removes common secret forms", () => {
  const safe = sanitizeCrashText(
    "github_pat-abcdefghijklmnopqrstuvwxyz token=topsecret /home/bob/private/file.txt",
    500,
  );
  assert.doesNotMatch(safe, /abcdefghijklmnopqrstuvwxyz|topsecret|bob/);
});

test("Feishu alert text contains only allow-listed routing metadata", () => {
  const report = validReport();
  const alert = buildCrashAlertText({
    id: "crash_123",
    appVersion: report.appVersion,
    engineVersion: report.engineVersion ?? "",
    platform: report.platform,
    arch: report.arch,
    kind: report.kind,
    occurrenceCount: 3,
    alertGeneration: 1,
  }, "ou_32b2bd011e81f02315e58c707949fbb5");

  assert.match(alert, /Hara Crash Intake/);
  assert.match(alert, /crash_123/);
  assert.match(alert, /发生次数：3/);
  assert.doesNotMatch(alert, /Clicked New session|userDescription|fingerprint/i);
});

test("crash alert environment config is all-or-none and validates Feishu ids", () => {
  assert.equal(loadCrashAlertConfig({}), null);
  assert.throws(() => loadCrashAlertConfig({
    HARA_CRASH_FEISHU_APP_ID: "cli_valid123",
  }), /all four/);
  assert.doesNotThrow(() => loadCrashAlertConfig({
    HARA_CRASH_FEISHU_APP_ID: "cli_valid123",
    HARA_CRASH_FEISHU_APP_SECRET: "a".repeat(32),
    HARA_CRASH_FEISHU_CHAT_ID: "oc_17590648f393135cde6a6b9cd6f1c710",
    HARA_CRASH_FEISHU_MENTION_OPEN_ID: "ou_32b2bd011e81f02315e58c707949fbb5",
  }));
});

test("crash alert UUID is stable within one delivery generation and changes on recurrence", () => {
  const first = crashAlertUuid("crash_12345678", 1);
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(first, crashAlertUuid("crash_12345678", 1));
  assert.notEqual(first, crashAlertUuid("crash_12345678", 2));
});

test("Feishu sender authenticates once and sends only the sanitized alert envelope", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("tenant_access_token")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-safe", expire: 7200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ code: 0, data: { message_id: "om_safe" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const sender = new FeishuCrashAlertSender({
    appId: "cli_valid123",
    appSecret: "s".repeat(32),
    chatId: "oc_17590648f393135cde6a6b9cd6f1c710",
    mentionOpenId: "ou_32b2bd011e81f02315e58c707949fbb5",
  }, request);
  const view = {
    id: "crash_12345678",
    appVersion: "0.1.126",
    engineVersion: "0.157.0",
    platform: "macos",
    arch: "arm64",
    kind: "renderer_exception",
    occurrenceCount: 1,
    alertGeneration: 1,
  };

  await sender.send(view);
  await sender.send(view);
  assert.equal(calls.filter((call) => call.url.includes("tenant_access_token")).length, 1);
  const sends = calls.filter((call) => call.url.includes("/im/v1/messages"));
  assert.equal(sends.length, 2);
  assert.equal((sends[0].init?.headers as Record<string, string>).Authorization, "Bearer tenant-safe");
  const body = JSON.stringify(JSON.parse(String(sends[0].init?.body)));
  assert.match(body, /crash_12345678/);
  assert.match(body, /南荒bot/);
  assert.match(body, /"uuid":"[a-f0-9-]{36}"/);
  assert.doesNotMatch(body, /userDescription|fingerprint|appSecret/i);
});

function alertPrisma() {
  const now = new Date("2026-08-31T00:00:00.000Z");
  const row: Record<string, unknown> = {
    id: "crash_alert_1",
    appVersion: "0.1.126",
    engineVersion: "0.157.0",
    platform: "macos",
    arch: "arm64",
    kind: "renderer_exception",
    occurrenceCount: 1,
    alertGeneration: 1,
    alertState: DesktopCrashAlertState.PENDING,
    alertAttempts: 0,
    alertNextAttemptAt: new Date(0),
    alertClaimedAt: null,
    alertDeliveredAt: null,
    alertLastError: "",
  };
  const desktopCrashReport = {
    findFirst: async () => row.alertState === DesktopCrashAlertState.PENDING ? {
      id: row.id,
      alertAttempts: row.alertAttempts,
    } : null,
    updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      const next = { ...data };
      if (data.alertAttempts && typeof data.alertAttempts === "object") {
        row.alertAttempts = Number(row.alertAttempts) + 1;
        delete next.alertAttempts;
      }
      Object.assign(row, next);
      return { count: 1 };
    },
    findUnique: async () => ({ ...row }),
  };
  return {
    now,
    row,
    prisma: { desktopCrashReport } as unknown as PrismaService,
  };
}

test("crash alert worker atomically delivers one queued report", async () => {
  const fake = alertPrisma();
  const sent: unknown[] = [];
  const sender: CrashAlertSender = { send: async (report) => { sent.push(report); } };
  const worker = new CrashReportAlertsService(fake.prisma);

  assert.equal(await worker.processOne(sender, fake.now), true);
  assert.equal(sent.length, 1);
  assert.equal(fake.row.alertState, DesktopCrashAlertState.SENT);
  assert.equal(fake.row.alertAttempts, 1);
  assert.equal(fake.row.alertLastError, "");
  assert.equal(await worker.processOne(sender, fake.now), false);
});

test("crash alert worker redacts errors and leaves failed delivery queued for retry", async () => {
  const fake = alertPrisma();
  const sender: CrashAlertSender = {
    send: async () => { throw new Error("token=supersecret transport unavailable"); },
  };
  const worker = new CrashReportAlertsService(fake.prisma);

  assert.equal(await worker.processOne(sender, fake.now), true);
  assert.equal(fake.row.alertState, DesktopCrashAlertState.PENDING);
  assert.match(String(fake.row.alertLastError), /credential=\*\*\*/);
  assert.doesNotMatch(String(fake.row.alertLastError), /supersecret/);
  assert.ok((fake.row.alertNextAttemptAt as Date).getTime() > fake.now.getTime());
});

# Hara feedback ticket workflow

Hara Control is the source of truth for product feedback. Feishu remains the canonical human intake
and status channel, but it is not used as a database or a distributed lock.

## Lifecycle

Every ticket receives a monotonic display number (`HARA-000001`) and moves through the following
reviewable lifecycle:

1. `RECEIVED` — Control accepted and deduplicated the source event.
2. `ACKNOWLEDGED` — the original Feishu thread has an honest receipt reply.
3. `IN_PROGRESS` — an operator or Codex worker owns the diagnosis.
4. `WAITING_RELEASE` — implementation completed, but no public release is claimed yet.
5. `WAITING_VERIFICATION` — an effective version and focused verification steps are recorded.
6. `CLOSED` — the reporter or operator confirmed the result.

`BLOCKED` and `REJECTED` are explicit side states. A blocked transition requires a reason. A ticket
cannot enter `WAITING_VERIFICATION` or `CLOSED` without both a fix version and verification steps.
Every update appends an immutable timeline event.

## Duplicate prevention

The monitor uses four complementary boundaries:

- Control has a unique key on `(source, sourceRef)`; a Feishu message ID can create only one ticket.
- Intake grants a time-bounded processing lease. A competing monitor receives the existing ticket but
  no claim token, so it does not reply or start a worker.
- Before sending an acknowledgment, the monitor checks the original Feishu thread for any existing
  `【Codex · Hara 反馈处理】` reply. If a foreground Codex session replied first, the monitor records the
  acknowledgment but does not start a second worker or add another bot message. If its own durable
  `ackInFlight` marker predates that reply, it resumes the already-owned job after a crash.
- The local monitor also uses one process lock and owner-only queue records.

If Control is temporarily unreachable, the monitor keeps the existing deterministic local ticket ID
and thread reconciliation instead of silently dropping feedback. Once Control is configured, its
number is authoritative; legacy `HARA-FB-*` / `HARA-CR-*` values are compatibility fallbacks only.

## Authentication and privacy

`POST /v1/internal/feedback-tickets/intake` and the claimed update endpoint accept only
`x-hara-feedback-key`. This purpose-scoped secret must be at least 32 characters and must not equal an
admin, JWT, gateway, KMS, provider, or Feishu credential. The endpoint never accepts the broad Control
admin key.

Both Control and the local monitor read the same credential from separate owner-only (`0600`) regular
files. PM2 and LaunchAgent store only file paths; neither receives the value in its serialized
environment. The credential never enters process arguments, logs, git, or Feishu. External fields pass through
the same credential/path redactor used by crash intake before persistence.

## Operator console

SUPERADMIN users see **Tickets / 工单** in `/console/`. The inbox filters by state, kind, and priority;
the detail view records assignee, release version, verification steps, notes, and the complete timeline.
The console is available in English, Simplified Chinese, and Traditional Chinese.

## Monitor installation

The repository-managed monitor is `scripts/hara-feishu-monitor.py`. Install it with:

```bash
bash scripts/install-hara-feishu-monitor.sh \
  --control-url https://gw.nanhara.tech \
  --key-file "$HOME/.codex/automations/hara-feishu-monitor/credentials/control-feedback.key"
```

The installer preserves queue/history/log data, copies only the executable, records only the non-secret
URL and key-file path in the existing LaunchAgent, runs the monitor self-test, and restarts the job.
Create the credential file separately with mode `0600`; never pass the credential value as an argument.

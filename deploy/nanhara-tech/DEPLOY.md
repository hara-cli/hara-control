# gw.nanhara.tech — hara-control deploy on the `ai` box

This began as a staging gateway. Before treating it as formal service, use the production preflight,
pinned LiteLLM runtime, encrypted provider-key copy and readiness checks described below.

**Target:** `ai` = `112.124.201.107` (Aliyun, root). Has docker+compose, nginx, certbot. DNS for
`nanhara.tech` is on alidns (same as nanhara.com) and `api.nanhara.tech` already points at `ai`.

> **⚠️ UPDATE 2026-06-23 — what actually worked (use `deploy-ai-rds.sh`, not the docker path below):**
> - **CN can't reach Docker Hub** from `ai`, and the box's configured mirrors are dead → the dockerized
>   Postgres path failed. We pivoted to **Aliyun RDS PostgreSQL** (`pgm-…pg.rds.aliyuncs.com`, db `hara_db`,
>   VPC-intranet, pgvector available) + a **dockerless** deploy (`deploy-ai-rds.sh`: `npm ci`→build→
>   `prisma migrate deploy`→safe LiteLLM schema diff/push→pm2). Hara migrations are applied through
>   Prisma; LiteLLM's isolated schema is compared with the pinned 1.92.0 datamodel, destructive plans
>   are refused, and runtime auto-mutation is disabled. Nest runs under pm2 on
>   `127.0.0.1:4100`. Use
>   the npmmirror registry + `PRISMA_ENGINES_MIRROR` on the box.
> - **`ai` is the LIVE prod backend box** (pm2 runs `yimatrix-api`, `nanyiapp-api`, …). Keep everything
>   localhost-bound. It's an **oneinstack/LNMP** nginx with a `default_server reuseport` + `vhost/*.conf`;
>   a `conf.d` `server_name` block did **not** win Host-routing for `api.nanhara.tech` (it hit the yimatrix
>   default). **Public exposure is unsolved** — for now validate over an **SSH tunnel**
>   (`ssh -fNL 14100:127.0.0.1:4100 ai` → enroll to `http://localhost:14100`). Clean public options:
>   a dedicated `listen <port>` server + open that port in the Aliyun security group, or sort the vhost
>   precedence. R1 (enroll→token→fleet `online:true`→`/v1/roles`) **validated via the tunnel** on 2026-06-23.

## Roll out in 3 rounds (escalating, zero key first)
- **R1 — control plane only** (`GATEWAY_ADAPTER=mock`): enroll → device token → `/v1/roles` (validates the
  0.70 org-role push-down) → heartbeat → fleet. No LLM, no key. **Do this first.**
- **R2 — data-plane plumbing** (`litellm` + the Phase-0 mock upstream): real chat laptop→gw→LiteLLM→mock. Still no real key.
- **R3 — real model**: pinned `litellm` + a regular DeepSeek pay-as-you-go key. Devices receive
  revocable virtual keys; the provider key remains server-side.

---

## 1. Prereqs (verify on `ai`)
```bash
ssh ai 'docker --version && docker compose version && node -v && nginx -v && certbot --version'
```
Node must be ≥20. Free ports needed: 4100 (Nest), 5433 (PG), 4000 (LiteLLM, R2+) — all free as of 2026-06-23.
⚠️ Box has ~4.8 GiB RAM free and runs jenkins/php — keep this lean; everything binds to 127.0.0.1.

## 2. DNS (one-time, alidns)
Add an A record `gw.nanhara.tech → 112.124.201.107` (TTL 600) in the Aliyun DNS console for `nanhara.tech`.
Verify: `dig +short gw.nanhara.tech` → `112.124.201.107`. (Or reuse the existing `api.nanhara.tech`.)

## 3. TLS cert (one-time, certbot)
```bash
ssh ai 'certbot certonly --nginx -d gw.nanhara.tech --non-interactive --agree-tos -m ops@nanhara.tech'
# → /etc/letsencrypt/live/gw.nanhara.tech/{fullchain,privkey}.pem  (auto-renews)
```

## 4. Deploy the control plane
```bash
# 4a. sync code laptop → ai (excludes node_modules/.git/local PG data)
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude postgres-data --exclude .env \
  ~/work/projects/hara/hara-control/  ai:/opt/hara-control/

# 4b. configure without printing generated security values
ssh ai 'cd /opt/hara-control && cp -n deploy/nanhara-tech/.env.prod.example .env \
        && node scripts/bootstrap-production-security.mjs .env /etc/hara-control/kms-master.key'
# Add the DeepSeek pay-as-you-go key directly on the host, then keep `.env` at 0600. Do not paste
# credentials into tickets, chat, shell history, CI variables with public logs, or this document.

# 4c. bring it up against Aliyun RDS (idempotent: preflight → build → migrate → pinned data plane → pm2)
ssh ai 'cd /opt/hara-control && bash deploy/nanhara-tech/deploy-ai-rds.sh'

# 4d. nginx site (cert now exists → hardened conf validates)
ssh ai 'cp /opt/hara-control/deploy/nanhara-tech/nginx-gw.nanhara.tech.conf /etc/nginx/conf.d/ \
        && nginx -t && systemctl reload nginx'
```
Smoke: `curl -fsS http://127.0.0.1:4100/health/ready` on the host must return 200 before traffic
promotion. `/health/live` only proves the Nest process exists; it is not a readiness substitute.
The deploy also fails if PM2 serializes protected `.env` values instead of keeping only the env-loader
wrapper and owner-only file path in its process definition.
The canonical production data-plane process is `hara-litellm`; do not rename it during an upgrade,
because exact replacement is part of removing the previous runtime environment.

## 5. Issue a token to your laptop
Admin API is localhost-locked → reach the console over an SSH tunnel. Bootstrap a real SUPERADMIN,
enable TOTP, then use its short-lived JWT; do not extract the shared admin key into a laptop shell:
```bash
ssh -fN -L 4100:127.0.0.1:4100 ai
open http://localhost:4100/console/
```
Create the org and one-time enroll code in the console. The code is intentionally short-lived and
single-use.
On the laptop:
```bash
hara enroll https://gw.nanhara.tech --code "$CODE"   # → device token in ~/.hara/org.json (0600)
hara enroll --status                                  # enrolled · provider=hara-gateway
```
Now `hara` routes through the gateway; the real key (R3) never leaves the box. R1 also pulls the org-role
bundle into `~/.hara/org-roles/` (the 0.70 feature) — verify with `hara roles`.

## 6. Verify the loop
- **R1:** use the console Fleet view and confirm the enrolled device becomes `online`.
- **R2/R3:** set `GATEWAY_ADAPTER=litellm`, re-run the deployment, require `/health/ready`=200, test
  both the encrypted and active DeepSeek credential in Security, then verify a normal Hara request.

## 7. Security caveats (recap)
- Use only a provider key whose terms permit server/gateway use.
- PG (5433) + LiteLLM (4000) bound to 127.0.0.1 (prod overlay); `/admin/*` locked to localhost (tunnel).
- `.env` and the KMS keyfile are owner-only regular files; symlinks and group/other access fail deploy.
- Admin/JWT/LiteLLM/provider/KMS values are distinct. Deployment imports the active provider key into
  envelope-encrypted storage without displaying it, blanks the one-time env value, and starts
  LiteLLM through the version-aware secret supervisor.
- Back up the database and KMS root together. Either one without the other is intentionally
  insufficient to recover encrypted provider credentials.
- Control and LiteLLM use the same RDS instance only with explicit isolated schemas:
  `DATABASE_URL?...schema=public` and `LITELLM_DATABASE_URL?...schema=litellm`.
- LiteLLM is pinned to 1.92.0 with its exact Python Prisma runtime and rebuilt into a
  requirements-fingerprinted virtualenv; mutable `main-stable` and dependency-drift reuse are forbidden.
- The deploy explicitly synchronizes the isolated LiteLLM schema without `--accept-data-loss`, rechecks
  zero drift, and starts the proxy with `DISABLE_SCHEMA_UPDATE=true`. `/health/ready` then exercises the
  read-only key-management API, not only process liveliness.

## 8. Teardown
```bash
ssh ai 'cd /opt/hara-control && pm2 delete hara-control; \
        docker compose -f docker-compose.yml -f deploy/nanhara-tech/docker-compose.prod.yml down -v; \
        rm -f /etc/nginx/conf.d/gw.nanhara.tech.conf && nginx -t && systemctl reload nginx'
```

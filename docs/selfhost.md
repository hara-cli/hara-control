# Self-hosting hara-control

> Apache-2.0 — run the control plane on your own infra; your upstream provider keys
> never leave it. This guide is for an operator deploying to a server they own.
> For a laptop try, see "Run Phase 1 locally" in the README.
>
> Covers the four things you need: **① environment ② install ③ domain ④ the first admin.**

---

## How it fits together (read first)

```
hara CLI (a dev's laptop)                your server
  provider = hara-gateway     ┌──────────────────────────────────────────┐
  holds a device token        │  hara-control (NestJS)  :4100  ← control  │
        │  enroll/heartbeat/roles ──────────────────────────────────────► │   plane
        │                     │  LiteLLM        :4000          ← data plane│
        └─ chat ──────────────────────────────────────────────────────►  │   (holds the
                              │            │                               │    real key)
                              └────────────┼───────────────────────────────┘
                                           ▼   PostgreSQL (shared)
                              cloud / self-hosted upstream models
```

Key facts that shape the deploy:
- The **device token a dev gets *is* a LiteLLM virtual key** (scoped, revocable). Chat goes
  **device → LiteLLM directly**; control traffic (enroll/heartbeat/roles) goes to hara-control.
  Your reverse proxy therefore routes **`/v1/chat*` → LiteLLM** and the rest of `/v1/*` → hara-control.
- The **real upstream key lives only in LiteLLM** (env/vault). Devices never see it.
- hara-control + LiteLLM **share one Postgres** but in **separate schemas** (see ③/pitfalls — getting
  this wrong can drop tables).

---

## ① Environment requirements

| Need | Minimum | Notes |
|---|---|---|
| OS | Linux x86_64/arm64 | Ubuntu 22.04 / Debian 12 / Aliyun Linux all fine |
| Node.js | **≥ 20** (LTS) | for hara-control |
| PostgreSQL | **≥ 15 with `pgvector`** | `CREATE EXTENSION vector;` (needs a privileged role — RDS: `rds_superuser`) |
| Python | **3.10+** | only for the LiteLLM data plane |
| RAM | **2 GiB min** (4 GiB comfortable) | Nest ~256M + PG ~512M + LiteLLM ~400M |
| Disk | 10 GiB | |
| Reverse proxy | **nginx** or **Caddy** | TLS + path routing (examples in `deploy/examples/`) |
| Process mgr | **systemd** / pm2 / docker | pick one |
| Domain | optional | not needed for LAN/SSH-tunnel eval; needed once off-LAN devices enroll |

**Ports** (bind all to `127.0.0.1`, expose only 443 via the proxy):
`4100` hara-control · `4000` LiteLLM · `5432/5433` Postgres · `443/80` public.

You can run **all-in-Docker** (simplest, if you can reach Docker Hub) or **dockerless**
(Node + an external/managed Postgres — what we run in practice; see install).

---

## ② Install (production)

```bash
git clone <repo> hara-control && cd hara-control
cp .env.example .env          # then edit — see "minimum .env" below
```

### Database
**Docker path:** `docker compose up -d postgres` (ships `pgvector/pgvector:pg16` — zero setup).
**External/managed PG:** ensure pgvector first (one-time, privileged user):
```bash
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

### Control plane (hara-control)
```bash
npm ci
npm run build
npx prisma migrate deploy        # NOT `migrate dev` (dev generates new migrations)
node dist/main.js                # or run under systemd/pm2 — see deploy/examples/
```
Smoke: `curl -s localhost:4100/v1/roles` → `401` (it's up; needs a token).

> CN networks: set `npm_config_registry=https://registry.npmmirror.com` and
> `PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma` for `npm ci` /
> prisma. (Docker Hub is often unreachable from CN → use the dockerless PG path.)

### Data plane (LiteLLM) — the part with sharp edges
LiteLLM is a Python sidecar. Install it isolated, then **generate its Prisma client** (it
needs one even in mock mode):
```bash
python3 -m venv .litellm-venv
.litellm-venv/bin/pip install "litellm[proxy]" prisma     # [proxy] does NOT pull prisma — add it
# generate LiteLLM's client (PATH must include the venv bin, or it errors prisma-client-py: not found)
PATH=".litellm-venv/bin:$PATH" PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma \
  .litellm-venv/bin/python -m prisma generate \
  --schema=.litellm-venv/lib/python3.10/site-packages/litellm/proxy/schema.prisma
```
Run it (bound to localhost). **Give LiteLLM its own Postgres schema** so it never touches
hara-control's tables:
```bash
DATABASE_URL="${DATABASE_URL}?schema=litellm" \
  .litellm-venv/bin/litellm --config litellm/config.yaml --host 127.0.0.1 --port 4000
```
Edit `litellm/config.yaml` to point a model at your upstream (see the `glm-5`/`qwen-plus`
example there). **⚠️ Never put a coding-plan / restricted key here** — only a regular
pay-as-you-go provider key (a gateway proxying a coding-plan key gets the key banned).

> Want to validate the control loop before wiring a real model? Set `GATEWAY_ADAPTER=mock`
> — enroll/fleet/roles work with no LLM and no key. Then switch to `litellm` for real chat.

### Minimum `.env`
```env
DATABASE_URL=postgresql://hara:<pw>@127.0.0.1:5432/hara_control?schema=public
HARA_CONTROL_ADMIN_KEY=<openssl rand -hex 24>     # the v1 "super-user" — see ④
HARA_JWT_SECRET=<openssl rand -hex 32>            # when the auth module lands (AUTH_SPEC.md)
PORT=4100
HOST=127.0.0.1                                    # proxy fronts the public side
GATEWAY_ADAPTER=litellm                           # or `mock` to start
LITELLM_URL=http://127.0.0.1:4000
LITELLM_MASTER_KEY=<openssl rand -hex 32>
UPSTREAM_BASE_URL=https://your-provider/compatible-mode/v1
UPSTREAM_API_KEY=<regular pay-as-you-go key — NEVER a coding-plan key>
HARA_SSRF_BLOCK_PRIVATE=1                          # recommended for multi-host
```

---

## ③ Configure a domain

1. **DNS:** A record `cp.example.com → <server IP>` (verify `dig +short cp.example.com`).
2. **Reverse proxy** — must split control vs chat (device token authenticates at *both*):
   - `/v1/chat*`, `/v1/messages`, `/v1/models` → **LiteLLM** `127.0.0.1:4000`
   - other `/v1/*` (enroll/heartbeat/roles) → **hara-control** `127.0.0.1:4100`
   - `/admin/*` → hara-control **locked to localhost / your IP** (never public)
   - copy `deploy/examples/nginx-control-plane.conf` (nginx) or `deploy/examples/Caddyfile` (auto-TLS).
3. **TLS:** Caddy auto-issues; nginx → `certbot certonly --webroot ...`.
4. **Tell devices:** they enroll/login against `https://cp.example.com`; the enroll code's
   `base_url` should be `https://cp.example.com/v1` (chat then routes to LiteLLM via the proxy).

**Admin exposure — pick one** (`/admin` must not be open to the internet):
| Posture | When |
|---|---|
| localhost-only + SSH tunnel | most paranoid — admin from your laptop via `ssh -L 4100:127.0.0.1:4100` |
| IP allow-list (`allow <office IP>; deny all;`) | small team, static IPs |
| public | only if you treat `HARA_CONTROL_ADMIN_KEY` like an SSH root key |

---

## ④ The first admin / "super-user"

**Today (v1):** there is **no login/user system yet** — the control plane uses a single
shared **admin key**. Whoever holds `HARA_CONTROL_ADMIN_KEY` is effectively root. Treat it
like an SSH root key.

```bash
# on the server, one-time
openssl rand -hex 24            # generate a strong key
# put it in .env as HARA_CONTROL_ADMIN_KEY, restart the service
```
Use it from your laptop (keep `/admin` behind localhost/VPN):
```bash
export HARA_CONTROL_URL=https://cp.example.com HARA_CONTROL_ADMIN_KEY=<key>
npx tsx cli/admin.ts org create "Acme Corp"
npx tsx cli/admin.ts enroll <orgId>      # prints a `hara enroll …` line for a developer
```
**Rotating:** change the env var + restart; old key 401s immediately (single secret, no grace window).

**Coming (see [`AUTH_SPEC.md`](./AUTH_SPEC.md)):** real accounts + login + RBAC land in this
open repo — then this section becomes `npm run create-superadmin` + `/auth/login`, and the
shared key stays as a back-compat fallback. **2FA is intentionally not built in** — MFA is
delegated to your IdP via SSO (enterprise).

---

## Security defaults

- `/admin/*` is **never** public (see ③).
- The **real upstream key lives only in LiteLLM** — devices hold a scoped, revocable token.
- `HARA_SSRF_BLOCK_PRIVATE=1` on multi-host deploys (blocks SSRF into your private net).
- Device tokens have a TTL (`HARA_DEVICE_TOKEN_TTL_MINUTES`, default 7d) + server-side revocation.
- Multi-tenant RLS exists but isn't `FORCE`d — **single-org-per-DB is the supported posture today**.
- At-rest KMS supports the `local` provider only; see `HARDENING.md`.
- After install, **change `HARA_CONTROL_ADMIN_KEY` off the `.env.example` placeholder.**

---

## Pitfalls (we actually hit these)

- **pgvector missing** → `prisma migrate deploy` fails creating vector columns. Run
  `CREATE EXTENSION vector;` first (privileged user).
- **`migrate dev` in prod** generates migrations — use **`migrate deploy`**.
- **LiteLLM crashes `module 'prisma' has no attribute 'errors'`** → `litellm[proxy]` doesn't
  install `prisma`; `pip install prisma` then `prisma generate` (PATH must include the venv bin).
- **LiteLLM dropping hara-control's tables** → never `prisma db push` LiteLLM's schema against
  the shared DB on the `public` schema; give LiteLLM **`?schema=litellm`** (isolated).
- **LiteLLM auto-loads `.env` from its CWD** → run it from a known dir / set its env explicitly,
  or it picks up an unexpected `DATABASE_URL`.
- **CN networks** → use npmmirror for npm + `PRISMA_ENGINES_MIRROR`; prefer the dockerless PG path
  (Docker Hub often unreachable).

---

## Update / backup / uninstall

```bash
git pull && npm ci && npm run build && npx prisma migrate deploy && systemctl restart hara-control
```
- **Backup:** `pg_dump` the DB + back up `.env` (holds the admin + upstream keys) out-of-band.
  If you set `HARA_KMS_MASTER_KEY`, back it up separately — losing it loses anything encrypted.
- **Uninstall:** stop the services; `docker compose down -v` (destroys data); remove the dir.

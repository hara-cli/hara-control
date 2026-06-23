# gw.nanhara.tech — TEST control-plane deploy on the `ai` box

A disposable staging gateway to dogfood the **distributed** B-end loop: laptop `hara` ↔ remote
`hara-control` over real TLS/DNS — the path localhost e2e can't exercise. Separate `.tech` test domain
keeps it off the production `nanhara.com` (ICP'd) site.

**Target:** `ai` = `112.124.201.107` (Aliyun, root). Has docker+compose, nginx, certbot. DNS for
`nanhara.tech` is on alidns (same as nanhara.com) and `api.nanhara.tech` already points at `ai`.

## Roll out in 3 rounds (escalating, zero key first)
- **R1 — control plane only** (`GATEWAY_ADAPTER=mock`): enroll → device token → `/v1/roles` (validates the
  0.70 org-role push-down) → heartbeat → fleet. No LLM, no key. **Do this first.**
- **R2 — data-plane plumbing** (`litellm` + the Phase-0 mock upstream): real chat laptop→gw→LiteLLM→mock. Still no real key.
- **R3 — real model**: `litellm` + a **regular** DashScope key (⚠️ never `sk-sp-`). Real glm-5/qwen traffic.

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
  ~/work/projects/ai/hara-control/  ai:/opt/hara-control/

# 4b. configure
ssh ai 'cd /opt/hara-control && cp -n deploy/nanhara-tech/.env.prod.example .env \
        && sed -i "s/__SET_A_STRONG_RANDOM__/$(openssl rand -hex 24)/" .env'
#   (R1 leaves GATEWAY_ADAPTER=mock; for R2/R3 edit .env to litellm + keys)

# 4c. bring it up (idempotent: data plane → build → migrate → pm2)
ssh ai 'cd /opt/hara-control && bash deploy/nanhara-tech/deploy-ai.sh'

# 4d. nginx site (cert now exists → hardened conf validates)
ssh ai 'cp /opt/hara-control/deploy/nanhara-tech/nginx-gw.nanhara.tech.conf /etc/nginx/conf.d/ \
        && nginx -t && systemctl reload nginx'
```
Smoke: `curl -s https://gw.nanhara.tech/v1/roles` → 401 (needs a device token) = the path is live.

## 5. Issue a token to your laptop
Admin API is localhost-locked → reach it over an SSH tunnel:
```bash
ssh -fN -L 4100:127.0.0.1:4100 ai                       # tunnel admin to localhost
K=$(ssh ai 'grep ^HARA_CONTROL_ADMIN_KEY /opt/hara-control/.env | cut -d= -f2')
ORG=$(curl -s -XPOST localhost:4100/admin/orgs -H "x-admin-key: $K" \
      -H 'content-type: application/json' -d '{"name":"nanhara-test"}' | jq -r .id)
CODE=$(curl -s -XPOST localhost:4100/admin/enroll-codes -H "x-admin-key: $K" \
      -H 'content-type: application/json' -d "{\"orgId\":\"$ORG\"}" | jq -r .code)
echo "enroll code: $CODE"
```
On the laptop:
```bash
hara enroll https://gw.nanhara.tech --code "$CODE"   # → device token in ~/.hara/org.json (0600)
hara enroll --status                                  # enrolled · provider=hara-gateway
```
Now `hara` routes through the gateway; the real key (R3) never leaves the box. R1 also pulls the org-role
bundle into `~/.hara/org-roles/` (the 0.70 feature) — verify with `hara roles`.

## 6. Verify the loop
- **R1:** `curl -s "localhost:4100/admin/fleet?orgId=$ORG" -H "x-admin-key: $K" | jq` → your device, `online`.
- **R2/R3:** edit `.env` (`GATEWAY_ADAPTER=litellm` + keys), re-run `deploy-ai.sh`, then a normal `hara -p "hi"`
  on the laptop should round-trip through the gateway.

## 7. Security caveats (recap)
- **Never** put a `sk-sp-` coding-plan key in `UPSTREAM_API_KEY` — gateway use gets it banned. Regular DashScope key only.
- PG (5433) + LiteLLM (4000) bound to 127.0.0.1 (prod overlay); `/admin/*` locked to localhost (tunnel).
- It's a TEST: disposable DB, no real customer data, strong random admin key.

## 8. Teardown
```bash
ssh ai 'cd /opt/hara-control && pm2 delete hara-control; \
        docker compose -f docker-compose.yml -f deploy/nanhara-tech/docker-compose.prod.yml down -v; \
        rm -f /etc/nginx/conf.d/gw.nanhara.tech.conf && nginx -t && systemctl reload nginx'
```

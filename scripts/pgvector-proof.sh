#!/usr/bin/env bash
# Proves pgvector works end-to-end through the exact hybrid-search query shape (LATERAL latest-version
# join + `<=>` cosine ANN). Side-effect-free: runs in a rolled-back transaction. Requires the
# add_asset_embedding migration applied (pgvector extension + AssetVersion.embedding column).
# Run from repo root:  bash scripts/pgvector-proof.sh
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=/tmp/hc-pgvector-proof.txt
docker compose exec -T postgres psql -U hara -d hara_control -v ON_ERROR_STOP=1 -At >"$OUT" 2>&1 <<'SQL'
BEGIN;
INSERT INTO "Organization"(id,name,policy,"createdAt") VALUES ('33333333-3333-3333-3333-333333333333','pgv','{}',now());
INSERT INTO "Asset"(id,"orgId",scope,kind,lifecycle,"trustTier",origin,slug,title,tags,"searchText","createdAt","updatedAt") VALUES
 ('pgv-near','33333333-3333-3333-3333-333333333333','ORG','SNIPPET','PUBLISHED','ORG','AUTHORED','near','near','{}','near',now(),now()),
 ('pgv-far','33333333-3333-3333-3333-333333333333','ORG','SNIPPET','PUBLISHED','ORG','AUTHORED','far','far','{}','far',now(),now());
INSERT INTO "AssetVersion"(id,"assetId",body,"contentHash",redactions,"createdAt",embedding,"embedModel","embedDim") VALUES
 ('pgv-v1','pgv-near','near body','h1','{}',now(),'[1,0,0]','test',3),
 ('pgv-v2','pgv-far','far body','h2','{}',now(),'[0,1,0]','test',3);
SELECT a.slug FROM "Asset" a
  JOIN LATERAL (SELECT embedding,"embedModel" FROM "AssetVersion" WHERE "assetId"=a.id ORDER BY "createdAt" DESC LIMIT 1) v ON true
 WHERE a."orgId"='33333333-3333-3333-3333-333333333333' AND a.lifecycle='PUBLISHED'
   AND v.embedding IS NOT NULL AND v."embedModel"='test'
 ORDER BY v.embedding <=> '[0.9,0.1,0]' ASC;
ROLLBACK;
SQL
cat "$OUT"
# query vector [0.9,0.1,0] is nearest to 'near' ([1,0,0]) → it must rank first
if [ "$(grep -E '^(near|far)$' "$OUT" | head -1)" = "near" ]; then
  echo "PGVECTOR PROOF PASS: cosine ANN ranks the nearer asset first via the hybrid query shape"
else
  echo "PGVECTOR PROOF FAIL"; exit 1
fi

#!/bin/sh
# 仅在一次性、--network none 的 Linux 验收容器中运行。
set -eu
cd /input
sha256sum --check SHA256SUMS > /tmp/integrity.log
mkdir -p /tmp/negative/artifacts
cd /tmp/negative
grep 'artifacts/dsh-ops-dsh-sims-agent-' /input/SHA256SUMS > check.sha256
if sha256sum --check check.sha256 >/tmp/missing.log 2>&1; then exit 21; fi
cp /input/artifacts/dsh-ops-dsh-sims-agent-0.1.2.tgz artifacts/
printf x >> artifacts/dsh-ops-dsh-sims-agent-0.1.2.tgz
if sha256sum --check check.sha256 >/tmp/corrupt.log 2>&1; then exit 22; fi
printf 'missing/corrupt original artifact: rejected before installation\n'
mkdir -p /tmp/sims-new-home/artifacts /tmp/sims-new-home/tools
cd /tmp/sims-new-home
cp /input/artifacts/*.tgz artifacts/
tar -xf /input/store.tar
tar -xzf artifacts/pnpm-10.32.1.tgz -C tools
for section in runtime profile; do
  target="$section"
  if [ "$section" = profile ]; then
    target=home/profiles/web
    mkdir -p home/profiles/artifacts
    cp artifacts/*.tgz home/profiles/artifacts/
  fi
  mkdir -p "$target"
  cp "/input/$section/package.json" "/input/$section/pnpm-lock.yaml" "/input/$section/pnpm-workspace.yaml" "$target/"
  cd "$target"
  node /tmp/sims-new-home/tools/package/bin/pnpm.cjs install --offline --frozen-lockfile --prod --store-dir /tmp/sims-new-home/store
  cd /tmp/sims-new-home
done
cp /input/verify-offline.mjs .
node verify-offline.mjs

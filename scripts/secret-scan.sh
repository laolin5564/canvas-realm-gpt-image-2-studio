#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v grep >/dev/null 2>&1; then
  echo "secret scan requires grep" >&2
  exit 1
fi

EXCLUDES=(
  --exclude-dir=.git
  --exclude-dir=.next
  --exclude-dir=node_modules
  --exclude-dir=data
  --exclude-dir=backups
  --exclude=bun.lock
  # tests/fixtures/origin-tls：origin-fetch 测试用的自签证书，不是真实凭据。
  --exclude-dir=origin-tls
  --exclude='*.png'
  --exclude='*.jpg'
  --exclude='*.jpeg'
  --exclude='*.webp'
  --exclude='*.gif'
  --exclude='*.db'
  --exclude='*.db-shm'
  --exclude='*.db-wal'
)

PATTERN='(sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|gh[pousr]_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----)'

matches="$(grep -RInE "${EXCLUDES[@]}" "$PATTERN" . || true)"

if [[ -n "$matches" ]]; then
  echo "Potential secrets found:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "secret scan passed"

#!/usr/bin/env bash
# Stage a minimal Lambda code bundle: just the src/ modules and a bare
# package.json (type: module). No node_modules are needed at runtime —
#   * global fetch is built into the Node 20/22 runtime (undici is only
#     imported when HTTPS_PROXY is set, which never happens in Lambda), and
#   * @aws-sdk/client-s3 is provided by the Lambda Node.js runtime.
# SAM zips this staged directory (see template.yaml CodeUri: build/lambda/).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$HERE/build/lambda"

rm -rf "$OUT"
mkdir -p "$OUT/src"
cp "$ROOT"/src/*.js "$OUT/src/"

# Bare package.json so the runtime treats the .js files as ES modules.
cat > "$OUT/package.json" <<'JSON'
{
  "name": "power-tracker-lambda",
  "version": "1.0.0",
  "type": "module"
}
JSON

echo "Staged Lambda bundle at $OUT"
ls -1 "$OUT/src"

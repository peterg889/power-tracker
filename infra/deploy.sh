#!/usr/bin/env bash
# One-command deploy of the outage ETR tracker to AWS.
#
# Prereqs (run with YOUR AWS credentials configured):
#   - AWS CLI v2 + AWS SAM CLI installed
#   - `aws configure` (or SSO / env vars) pointing at the target account
#
# Usage:
#   ./infra/deploy.sh                 # deploy/update everything
#   STACK=my-outages ./infra/deploy.sh
#   ALERT_EMAIL=you@example.com ./infra/deploy.sh   # emailed if collection breaks
#   POLL_MINUTES=10 ./infra/deploy.sh
#
# What it does:
#   1. stages the Lambda bundle
#   2. sam build + sam deploy (creates buckets, Lambda, schedule, CloudFront)
#   3. uploads the static dashboard to the site bucket
#   4. invokes the collector once so the dashboard has data immediately
#   5. prints the dashboard URL
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
STACK="${STACK:-power-tracker}"
REGION="${AWS_REGION:-us-east-1}"

echo "==> [1/5] Staging Lambda bundle"
bash "$HERE/build-lambda.sh"

# The bundle is pure JS with no dependencies to compile, so we skip `sam build`
# and let `sam deploy` zip the staged CodeUri (build/lambda/) directly.
echo "==> [2/5] sam deploy (stack: $STACK, region: $REGION)"
sam deploy \
  --template "$HERE/template.yaml" \
  --stack-name "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --resolve-s3 \
  --parameter-overrides \
    "PollMinutes=${POLL_MINUTES:-15}" \
    "AlertEmail=${ALERT_EMAIL:-}"

get_output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

SITE_BUCKET="$(get_output SiteBucketName)"
FUNCTION="$(get_output CollectorFunction)"
URL="$(get_output DashboardUrl)"

echo "==> [3/5] Uploading dashboard to s3://$SITE_BUCKET"
# Static assets (index.html, app.js, styles.css). The data/ feed is written by
# the Lambda, so it is excluded here.
aws s3 sync "$ROOT/public" "s3://$SITE_BUCKET" \
  --region "$REGION" \
  --exclude "data/*" \
  --cache-control "public, max-age=300" \
  --delete

# Bust the CDN cache so redeployed assets show up immediately.
DIST_ID="$(get_output DistributionId)"
if [ -n "$DIST_ID" ]; then
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
    --paths '/index.html' '/app.js' '/styles.css' '/' >/dev/null || true
fi

echo "==> [4/5] Seeding first data point (invoking collector once)"
aws lambda invoke --function-name "$FUNCTION" --region "$REGION" \
  --cli-binary-format raw-in-base64-out /dev/stdout >/dev/null || \
  echo "   (invoke failed; the scheduled run will populate data shortly)"

echo "==> [5/5] Done."
echo ""
echo "    Dashboard:  $URL"
echo "    Collector runs every ${POLL_MINUTES:-15} min. Accuracy fills in as outages resolve."
if [ -n "${ALERT_EMAIL:-}" ]; then
  echo "    Alerts:     confirm the SNS subscription email sent to $ALERT_EMAIL"
fi
echo ""
echo "    (CloudFront can take a few minutes to finish provisioning on first deploy.)"

#!/usr/bin/env bash
set -euo pipefail

# Deploy the dashboard to S3 and invalidate CloudFront cache.
#
# Usage:
#   ./scripts/deploy-dashboard.sh
#   ./scripts/deploy-dashboard.sh prod          (default)
#   ./scripts/deploy-dashboard.sh prod my-profile us-west-1
#
# Prerequisites:
#   - SAM stack deployed (sam deploy --config-env prod)
#   - AWS CLI configured with appropriate credentials

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

# Load .env if present
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

STAGE="${1:-${STAGE:-prod}}"
AWS_PROFILE="${2:-${AWS_PROFILE:-default}}"
DASHBOARD_DIR="${SCRIPT_DIR}/../dashboard"
STACK_NAME="infcft-${STAGE}"

export AWS_PROFILE
export AWS_DEFAULT_REGION="${3:-${AWS_REGION:-us-west-1}}"

echo "Deploying dashboard for stage: ${STAGE}"

# Get stack outputs
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardBucketName'].OutputValue" \
  --output text)

API_URL=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text)

CF_DIST_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDistributionId'].OutputValue" \
  --output text)

if [ -z "${BUCKET}" ] || [ -z "${API_URL}" ]; then
  echo "ERROR: Could not read stack outputs. Is the stack '${STACK_NAME}' deployed?"
  exit 1
fi

echo "  S3 Bucket: ${BUCKET}"
echo "  API URL: ${API_URL}"
echo "  CloudFront: ${CF_DIST_ID}"

# Upload dashboard
echo "Uploading to s3://${BUCKET}/"
aws s3 sync "${DASHBOARD_DIR}" "s3://${BUCKET}/" \
  --delete \
  --cache-control "public, max-age=300" \
  --content-type "text/html" \
  --exclude "*" --include "index.html"

# Invalidate CloudFront cache
if [ -n "${CF_DIST_ID}" ] && [ "${CF_DIST_ID}" != "None" ]; then
  echo "Invalidating CloudFront cache..."
  aws cloudfront create-invalidation \
    --distribution-id "${CF_DIST_ID}" \
    --paths "/*" \
    --query "Invalidation.Id" \
    --output text
else
  echo "WARNING: No CloudFront distribution ID found. Cache NOT invalidated."
fi

# Print dashboard URL
DASHBOARD_URL=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" \
  --output text)

echo ""
echo "Dashboard deployed: ${DASHBOARD_URL}"

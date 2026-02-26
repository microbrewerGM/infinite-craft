#!/usr/bin/env bash
# Sets up the deployer IAM policy.
# Run with an admin profile that has IAM write access.
#
# Usage: ./iam/setup-deployer.sh <admin-profile>
# Example: ./iam/setup-deployer.sh default

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

# Load .env if present (line-by-line parsing, no eval/source)
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      val="${val%\"}" ; val="${val#\"}"
      val="${val%\'}" ; val="${val#\'}"
      export "${key}=${val}"
    fi
  done < "$ENV_FILE"
fi

ADMIN_PROFILE="${1:?Usage: $0 <admin-profile>}"
POLICY_NAME="infcft-deployer"
USER_NAME="${DEPLOYER_USER:-infcft-deployer}"
ACCOUNT_ID=$(aws sts get-caller-identity --profile "$ADMIN_PROFILE" --query Account --output text)
REGION="${AWS_REGION:-us-west-1}"
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

echo "==> Account: $ACCOUNT_ID"
echo "==> Region: $REGION"
echo "==> User: $USER_NAME"
echo "==> Policy: $POLICY_NAME"

# Substitute placeholders in policy template
RESOLVED_POLICY=$(sed \
  -e "s/YOUR_ACCOUNT_ID/${ACCOUNT_ID}/g" \
  -e "s/YOUR_REGION/${REGION}/g" \
  "${SCRIPT_DIR}/deployer-policy.json")

# Check if policy exists
if aws iam get-policy --policy-arn "$POLICY_ARN" --profile "$ADMIN_PROFILE" 2>/dev/null; then
    echo "==> Policy exists, creating new version..."
    # Delete oldest version if at limit (max 5 versions)
    VERSIONS=$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --profile "$ADMIN_PROFILE" \
        --query "Versions[?IsDefaultVersion==\`false\`].VersionId" --output text)
    VERSION_COUNT=$(echo "$VERSIONS" | wc -w | tr -d ' ')
    if [ "$VERSION_COUNT" -ge 4 ]; then
        OLDEST=$(echo "$VERSIONS" | tr '\t' '\n' | tail -1)
        echo "    Deleting oldest version: $OLDEST"
        aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLDEST" --profile "$ADMIN_PROFILE"
    fi
    aws iam create-policy-version \
        --policy-arn "$POLICY_ARN" \
        --policy-document "$RESOLVED_POLICY" \
        --set-as-default \
        --profile "$ADMIN_PROFILE"
else
    echo "==> Creating policy..."
    aws iam create-policy \
        --policy-name "$POLICY_NAME" \
        --policy-document "$RESOLVED_POLICY" \
        --description "Least-privilege deployer policy for Infinite Craft serverless stack" \
        --profile "$ADMIN_PROFILE"
fi

# Attach to user
echo "==> Attaching policy to user ${USER_NAME}..."
aws iam attach-user-policy \
    --user-name "$USER_NAME" \
    --policy-arn "$POLICY_ARN" \
    --profile "$ADMIN_PROFILE"

echo ""
echo "Done. The ${USER_NAME} user now has deployer permissions."
echo "Verify with: aws sts get-caller-identity --profile \$AWS_PROFILE"

# Infinite Craft Pulse Explorer — Deployment Guide

## Architecture

Self-coordinating Lambda workers explore element combinations on a schedule,
persist results to DynamoDB, and a read-only CloudFront dashboard displays
the accumulated state. Total cost: $0/month (AWS Free Tier).

## Prerequisites

- AWS CLI v2 configured with credentials (`aws sts get-caller-identity`)
- SAM CLI installed (`sam --version`)
- Python 3.12+
- A DNS provider where you can create CNAME records (for custom domain)

## Environment Setup

```bash
cp .env.example .env
# Edit .env: set your AWS_PROFILE, AWS_REGION, DOMAIN_NAME, etc.
```

All scripts read from `.env` automatically. You can also pass values as CLI arguments.

## Deployment

### Step 1: Request ACM Certificate (us-east-1)

CloudFront requires certificates in us-east-1, regardless of your stack region.

```bash
aws acm request-certificate \
  --domain-name your-domain.example.com \
  --validation-method DNS \
  --region us-east-1
```

Note the returned `CertificateArn`.

### Step 2: Validate via DNS

```bash
# Get the validation CNAME record
aws acm describe-certificate \
  --certificate-arn <CERT_ARN> \
  --region us-east-1 \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord"
```

In your DNS provider, add a CNAME record:
- **Name**: The `Name` value from above (e.g., `_abc123.your-domain.example.com`)
- **Target**: The `Value` from above
- **Proxy**: Disabled (DNS only — do not proxy through CDN services)

> **Cloudflare users**: Set proxy status to "DNS only" (gray cloud icon). Proxied mode will interfere with ACM validation.

Wait for validation (usually 5-15 minutes):
```bash
aws acm wait certificate-validated \
  --certificate-arn <CERT_ARN> \
  --region us-east-1
```

### Step 3: Configure and Deploy

```bash
# Copy and edit the config
cp samconfig.toml.example samconfig.toml
# Edit samconfig.toml: set your AWS profile, region, domain, and certificate ARN

# Build and deploy
sam build
sam deploy
```

### Step 4: Point Domain to CloudFront

Get the CloudFront domain from the stack outputs:
```bash
aws cloudformation describe-stacks \
  --stack-name infcft-${STAGE:-prod} \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" \
  --output text
```

In your DNS provider, add a CNAME record:
- **Name**: Your subdomain (e.g., `app`)
- **Target**: The CloudFront domain (e.g., `d1234abcd.cloudfront.net`)
- **Proxy**: Disabled (DNS only — do NOT proxy through CDN services, as CloudFront handles TLS/caching)

> **Cloudflare users**: Set proxy status to "DNS only" (gray cloud icon). If proxied (orange cloud), Cloudflare's TLS/CDN will conflict with CloudFront, causing certificate errors and broken routing.

### Step 5: Deploy Dashboard

```bash
./scripts/deploy-dashboard.sh
```

## Configuration

Runtime config is stored in SSM Parameter Store. Change without redeploying:

```bash
# Change exploration strategy
aws ssm put-parameter \
  --name "/infcft/${STAGE:-prod}/strategy" \
  --value "rotate" \
  --type String \
  --overwrite

# Change workers per pulse
aws ssm put-parameter \
  --name "/infcft/${STAGE:-prod}/workers-per-pulse" \
  --value "2" \
  --type String \
  --overwrite

# Change rate limit delay
aws ssm put-parameter \
  --name "/infcft/${STAGE:-prod}/rate-limit-delay" \
  --value "2.0" \
  --type String \
  --overwrite
```

Note: The EventBridge schedule in the SAM template is static (`rate(4 hours)`).
To change the trigger schedule, update `template.yaml` and redeploy.

## Manual Worker Invocation

Trigger a worker pulse manually:

```bash
aws lambda invoke \
  --function-name infcft-worker-${STAGE:-prod} \
  --payload '{"source": "manual"}' \
  --cli-binary-format raw-in-base64-out \
  /dev/stdout
```

## Backup & Restore

Export DynamoDB tables to local JSON files for disaster recovery or migration.

### Backup all tables

```bash
python scripts/backup-restore.py backup
```

Creates a timestamped directory under `backups/` with one JSON file per table and a `manifest.json`.

### Backup specific tables

```bash
python scripts/backup-restore.py backup --tables discoveries recipes
```

### List available backups

```bash
python scripts/backup-restore.py list
```

### Restore from backup

```bash
# Dry run (shows counts, no writes)
python scripts/backup-restore.py restore --dir backups/2026-02-24T15-30-00 --dry-run

# Restore all tables
python scripts/backup-restore.py restore --dir backups/2026-02-24T15-30-00

# Restore specific table
python scripts/backup-restore.py restore --dir backups/2026-02-24T15-30-00 --tables discoveries
```

Restore prompts for confirmation before writing. Items with matching keys are overwritten.

## Cost Monitoring

Set up a budget alert:

```bash
aws budgets create-budget \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget '{
    "BudgetName": "infcft-free-tier",
    "BudgetLimit": {"Amount": "1", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST"
  }' \
  --notifications-with-subscribers '[{
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [{
      "SubscriptionType": "EMAIL",
      "Address": "your-email@example.com"
    }]
  }]'
```

## Free Tier Budget

| Service | Free Tier | Estimated Usage |
|---------|-----------|-----------------|
| Lambda | 1M req + 400K GB-s | ~162K GB-s/mo (40%) |
| DynamoDB | 25 GB + 25 RCU/WCU | < 1 GB, on-demand |
| CloudFront | 1 TB transfer | < 1 GB |
| S3 | 5 GB | < 1 MB |
| API Gateway | 1M calls (12-mo) | < 10K/mo |
| ACM | Free | Free |
| SSM | Standard params free | Free |
| EventBridge | All custom events | Free |
| **Total** | | **$0.00/month** |

## IAM Policies

The `iam/` directory contains least-privilege deployer policies. Before using them:

1. Replace `YOUR_ACCOUNT_ID` with your AWS account ID
2. Replace `YOUR_REGION` with your deployment region

## Troubleshooting

### Workers not running
```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/infcft-worker-${STAGE:-prod} \
  --start-time $(date -v-1d +%s000) \
  --filter-pattern "ERROR"
```

### Dashboard shows no data
1. Check API Gateway is working: `curl <API_URL>/api/state`
2. Verify DynamoDB has data: `aws dynamodb scan --table-name infcft-discoveries-${STAGE:-prod} --select COUNT`
3. Check CloudFront origin routing in the distribution settings

### Rate limiting
The worker Lambda uses AIMD rate limiting. If you see many HTTP 429 errors,
increase the rate limit delay:
```bash
aws ssm put-parameter --name "/infcft/${STAGE:-prod}/rate-limit-delay" --value "5.0" --type String --overwrite
```

# How To Deploy Your Own Explorer

This guide covers deploying your own instance of the Infinite Craft Explorer.

## Architecture

```
EventBridge (rate 4h)
    |
    v
Worker Lambda ──> DynamoDB (discoveries, recipes, tried-pairs, worker-runs)
                      ^
                      |
CloudFront ──> API Lambda (read-only)
    |
    v
S3 (dashboard/index.html)
```

All infrastructure is defined in a single SAM template. Total cost: **$0/month** on AWS Free Tier.

## Project Structure

```
template.yaml              SAM infrastructure (Lambda, DynamoDB, CloudFront, API Gateway, etc.)
samconfig.toml.example     Deployment config template
.env.example               Environment variable defaults
DEPLOY.md                  Detailed deployment guide
functions/
  worker/handler.py        Self-coordinating exploration worker
  api/handler.py           Read-only API for the dashboard
dashboard/
  index.html               Single-page dashboard (vanilla JS + D3.js)
scripts/
  deploy-dashboard.sh      S3 sync + CloudFront invalidation
  backup-restore.py        DynamoDB backup and restore
iam/
  deployer-policy.json     Least-privilege IAM policy for CI/CD deployer
  setup-deployer.sh        IAM user creation script
```

## Prerequisites

- AWS CLI v2 with configured credentials
- [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Python 3.12+

## Quick Start

```bash
# Set up environment
cp .env.example .env
# Edit .env: set your AWS profile, region, etc.

# Copy and edit the SAM config
cp samconfig.toml.example samconfig.toml
# Edit samconfig.toml: set your AWS profile, domain, and certificate ARN

# Build and deploy
sam build
sam deploy

# Deploy the dashboard
./scripts/deploy-dashboard.sh
```

See [DEPLOY.md](DEPLOY.md) for the full walkthrough including ACM certificate setup and DNS configuration.

## Configuration

Runtime config lives in SSM Parameter Store and can be changed without redeploying:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `/infcft/{stage}/strategy` | `bfs` | Exploration strategy: `bfs`, `random`, `anchor`, `rotate` |
| `/infcft/{stage}/rate-limit-delay` | `3.0` | Initial delay between API calls (seconds) |
| `/infcft/{stage}/max-duration` | `840` | Max worker runtime (seconds, 14 min) |
| `/infcft/{stage}/workers-per-pulse` | `1` | Concurrent workers per scheduled pulse |

```bash
aws ssm put-parameter --name "/infcft/${STAGE}/strategy" --value "rotate" --type String --overwrite
```

## Security

- API Gateway: GET-only, throttled (100 burst / 50 sustained)
- S3: Origin Access Control only, no public access
- Lambda IAM: worker has CRUD, API has read-only with explicit write deny
- DynamoDB: conditional writes prevent duplicate work
- CloudFront: HSTS, CSP, X-Frame-Options, TLS 1.2 minimum
- Top-level exception handling in both Lambdas (no stack trace leaks)

## Dashboard Features

- **D3.js force-directed graph** with clickable nodes, generation coloring, and 4 node-size modes
- **Full dependency chain viewer** with critical path highlighting and build order
- **Analytics dashboard** with generation distribution, name length distribution, and top ingredients charts
- **First discoveries tracker** with persistent discovery numbering
- **Worker run history** with expandable detail cards and efficiency metrics
- **Server-side search** across the full element database
- **AIMD rate limiting** that adapts to API throttling

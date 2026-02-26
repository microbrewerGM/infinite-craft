#!/usr/bin/env python3
"""
DynamoDB backup and restore for Infinite Craft Explorer.

Usage:
  # Backup all tables
  python scripts/backup-restore.py backup

  # Backup specific tables
  python scripts/backup-restore.py backup --tables discoveries recipes

  # Restore all tables from latest backup
  python scripts/backup-restore.py restore --dir backups/2026-02-24T15-30-00

  # Restore specific table
  python scripts/backup-restore.py restore --dir backups/2026-02-24T15-30-00 --tables discoveries

  # Dry-run restore (show counts, don't write)
  python scripts/backup-restore.py restore --dir backups/2026-02-24T15-30-00 --dry-run

Environment:
  Reads from .env file in project root, or set directly:
  AWS_PROFILE  — AWS CLI profile
  AWS_REGION   — AWS region

Requires: boto3 (pip install boto3)
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import boto3
from botocore.exceptions import ClientError


def _load_env():
    """Load .env file from project root if present."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())


# ── Table configuration ─────────────────────────────────────

TABLES = {
    "discoveries": {
        "name_pattern": "infcft-discoveries-{stage}",
        "priority": "CRITICAL",
        "description": "All discovered elements (master inventory)",
    },
    "recipes": {
        "name_pattern": "infcft-recipes-{stage}",
        "priority": "CRITICAL",
        "description": "Element combination results",
    },
    "tried-pairs": {
        "name_pattern": "infcft-tried-pairs-{stage}",
        "priority": "important",
        "description": "Pairs already attempted (deduplication)",
    },
    "worker-runs": {
        "name_pattern": "infcft-worker-runs-{stage}",
        "priority": "low",
        "description": "Worker execution audit log (TTL 30 days)",
    },
}


# ── JSON encoder for DynamoDB types ─────────────────────────

class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            if obj == int(obj):
                return int(obj)
            return float(obj)
        return super().default(obj)


def decimal_hook(obj):
    """Convert floats back to Decimal for DynamoDB compatibility."""
    for k, v in obj.items():
        if isinstance(v, float):
            obj[k] = Decimal(str(v))
    return obj


# ── Backup ──────────────────────────────────────────────────

def backup_table(dynamo, table_name, output_path):
    """Export all items from a DynamoDB table to a JSON file."""
    table = dynamo.Table(table_name)

    items = []
    scan_kwargs = {}
    page = 0

    while True:
        resp = table.scan(**scan_kwargs)
        batch = resp.get("Items", [])
        items.extend(batch)
        page += 1
        print(f"  Scanned page {page}: {len(batch)} items (total: {len(items)})")

        if "LastEvaluatedKey" not in resp:
            break
        scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(items, f, cls=DecimalEncoder)

    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"  Saved {len(items)} items to {output_path} ({size_mb:.1f} MB)")
    return len(items)


def run_backup(args):
    """Backup selected tables to a timestamped directory."""
    stage = args.stage
    profile = args.profile
    region = args.region
    selected = args.tables or list(TABLES.keys())

    session = boto3.Session(profile_name=profile, region_name=region)
    dynamo = session.resource("dynamodb")

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    backup_dir = Path(args.output) / ts

    print(f"Backing up to: {backup_dir}")
    print(f"Stage: {stage}, Region: {region}, Profile: {profile}")
    print()

    manifest = {
        "timestamp": ts,
        "stage": stage,
        "region": region,
        "tables": {},
    }

    for key in selected:
        if key not in TABLES:
            print(f"Unknown table: {key} (valid: {', '.join(TABLES.keys())})")
            sys.exit(1)

        config = TABLES[key]
        table_name = config["name_pattern"].format(stage=stage)
        output_path = backup_dir / f"{key}.json"

        print(f"[{config['priority']}] {key} ({table_name})")

        try:
            count = backup_table(dynamo, table_name, output_path)
            manifest["tables"][key] = {
                "table_name": table_name,
                "item_count": count,
                "file": f"{key}.json",
            }
        except ClientError as e:
            print(f"  ERROR: {e.response['Error']['Message']}")
            sys.exit(1)

        print()

    # Write manifest
    manifest_path = backup_dir / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print("Backup complete.")
    print(f"Manifest: {manifest_path}")
    for key, info in manifest["tables"].items():
        print(f"  {key}: {info['item_count']} items")


# ── Restore ─────────────────────────────────────────────────

def restore_table(dynamo, table_name, input_path, dry_run=False):
    """Import items from a JSON file into a DynamoDB table."""
    with open(input_path) as f:
        items = json.load(f, object_hook=decimal_hook)

    print(f"  Loaded {len(items)} items from {input_path}")

    if dry_run:
        print("  (dry run — no writes)")
        return len(items)

    table = dynamo.Table(table_name)
    written = 0

    with table.batch_writer() as writer:
        for i, item in enumerate(items):
            writer.put_item(Item=item)
            written += 1
            if (i + 1) % 1000 == 0:
                print(f"  Written {i + 1}/{len(items)}...")

    print(f"  Restored {written} items to {table_name}")
    return written


def run_restore(args):
    """Restore tables from a backup directory."""
    stage = args.stage
    profile = args.profile
    region = args.region
    backup_dir = Path(args.dir)
    dry_run = args.dry_run

    if not backup_dir.exists():
        print(f"ERROR: Backup directory not found: {backup_dir}")
        sys.exit(1)

    # Read manifest
    manifest_path = backup_dir / "manifest.json"
    if manifest_path.exists():
        with open(manifest_path) as f:
            manifest = json.load(f)
        print(f"Backup from: {manifest['timestamp']}")
        print(f"Original stage: {manifest['stage']}, region: {manifest['region']}")
    else:
        manifest = None
        print("WARNING: No manifest.json found, proceeding with file detection")

    selected = args.tables or list(TABLES.keys())

    session = boto3.Session(profile_name=profile, region_name=region)
    dynamo = session.resource("dynamodb")

    print(f"Restoring to stage: {stage}, Region: {region}, Profile: {profile}")
    if dry_run:
        print("DRY RUN — no data will be written")
    print()

    if not dry_run:
        print("WARNING: This will overwrite existing data in the target tables.")
        print("         Items with the same keys will be replaced.")
        confirm = input("Continue? (yes/no): ").strip().lower()
        if confirm != "yes":
            print("Aborted.")
            sys.exit(0)
        print()

    for key in selected:
        if key not in TABLES:
            print(f"Unknown table: {key}")
            sys.exit(1)

        input_path = backup_dir / f"{key}.json"
        if not input_path.exists():
            print(f"[skip] {key}: no backup file found ({input_path})")
            continue

        config = TABLES[key]
        table_name = config["name_pattern"].format(stage=stage)

        print(f"[{config['priority']}] {key} -> {table_name}")

        try:
            restore_table(dynamo, table_name, input_path, dry_run=dry_run)
        except ClientError as e:
            print(f"  ERROR: {e.response['Error']['Message']}")
            sys.exit(1)

        print()

    print("Restore complete." + (" (dry run)" if dry_run else ""))


# ── List backups ────────────────────────────────────────────

def run_list(args):
    """List available backups."""
    backup_root = Path(args.output)
    if not backup_root.exists():
        print(f"No backups directory found at: {backup_root}")
        return

    backups = sorted(backup_root.iterdir(), reverse=True)
    if not backups:
        print("No backups found.")
        return

    print(f"Available backups in {backup_root}/:\n")
    for d in backups:
        if not d.is_dir():
            continue
        manifest_path = d / "manifest.json"
        if manifest_path.exists():
            with open(manifest_path) as f:
                m = json.load(f)
            tables = ", ".join(
                f"{k}({v['item_count']})" for k, v in m.get("tables", {}).items()
            )
            print(f"  {d.name}  stage={m.get('stage', '?')}  {tables}")
        else:
            files = [f.stem for f in d.glob("*.json") if f.stem != "manifest"]
            print(f"  {d.name}  (no manifest)  files: {', '.join(files)}")


# ── CLI ─────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Backup and restore DynamoDB tables for Infinite Craft"
    )
    parser.add_argument(
        "--profile", default=os.environ.get("AWS_PROFILE", "default"),
        help="AWS CLI profile (default: from .env or 'default')",
    )
    parser.add_argument(
        "--region", default=os.environ.get("AWS_REGION", "us-west-1"),
        help="AWS region (default: from .env or 'us-west-1')",
    )
    parser.add_argument(
        "--stage", default="prod",
        help="Deployment stage (default: prod)",
    )
    parser.add_argument(
        "--output", default="backups",
        help="Backup directory root (default: backups/)",
    )

    sub = parser.add_subparsers(dest="command")

    # backup
    bp = sub.add_parser("backup", help="Export DynamoDB tables to JSON")
    bp.add_argument(
        "--tables", nargs="+", choices=list(TABLES.keys()),
        help="Tables to back up (default: all)",
    )

    # restore
    rp = sub.add_parser("restore", help="Import JSON files into DynamoDB")
    rp.add_argument(
        "--dir", required=True,
        help="Backup directory to restore from",
    )
    rp.add_argument(
        "--tables", nargs="+", choices=list(TABLES.keys()),
        help="Tables to restore (default: all available)",
    )
    rp.add_argument(
        "--dry-run", action="store_true",
        help="Show what would be restored without writing",
    )

    # list
    sub.add_parser("list", help="List available backups")

    args = parser.parse_args()
    _load_env()

    if args.command == "backup":
        run_backup(args)
    elif args.command == "restore":
        run_restore(args)
    elif args.command == "list":
        run_list(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

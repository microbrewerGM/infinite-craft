"""
Infinite Craft Worker Lambda — Self-coordinating element explorer.

Triggered by EventBridge on a schedule. Each invocation:
1. Reads config from SSM Parameter Store
2. Loads known elements and tried pairs from DynamoDB
3. Generates untried pairs using selected strategy
4. Calls neal.fun API with AIMD rate limiting
5. Writes results to DynamoDB (conditional writes prevent duplicates)
6. Logs run summary to worker_runs table

Uses only stdlib + boto3 (available in Lambda runtime).
"""

import json
import os
import random
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

# ── Environment ──────────────────────────────────────────────

DISCOVERIES_TABLE = os.environ.get("DISCOVERIES_TABLE", "infcft-discoveries-dev")
RECIPES_TABLE = os.environ.get("RECIPES_TABLE", "infcft-recipes-dev")
TRIED_PAIRS_TABLE = os.environ.get("TRIED_PAIRS_TABLE", "infcft-tried-pairs-dev")
WORKER_RUNS_TABLE = os.environ.get("WORKER_RUNS_TABLE", "infcft-worker-runs-dev")
SSM_PREFIX = os.environ.get("SSM_PREFIX", "/infcft/dev")

BASE_ELEMENTS = ["Water", "Fire", "Wind", "Earth"]
API_ENDPOINT = "https://neal.fun/api/infinite-craft/pair"
HEADERS = {
    "Referer": "https://neal.fun/infinite-craft/",
    "Origin": "https://neal.fun",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/133.0.0.0 Safari/537.36"
    ),
    "sec-ch-ua": '"Chromium";v="133", "Not(A:Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
}

# ── Clients (reused across warm invocations) ─────────────────

_dynamo = None
_ssm = None


def _get_dynamo():
    global _dynamo
    if _dynamo is None:
        _dynamo = boto3.resource("dynamodb")
    return _dynamo


def _get_ssm():
    global _ssm
    if _ssm is None:
        _ssm = boto3.client("ssm")
    return _ssm


# ── Config from SSM ──────────────────────────────────────────

def _load_config():
    """Read runtime config from SSM Parameter Store."""
    ssm = _get_ssm()
    defaults = {
        "strategy": "rotate",
        "rate_limit_delay": 3.0,
        "max_duration": 840,
        "workers_per_pulse": 1,
    }
    try:
        paginator = ssm.get_paginator("get_parameters_by_path")
        for page in paginator.paginate(
            Path=SSM_PREFIX,
            Recursive=True,
            WithDecryption=False,
        ):
            for p in page.get("Parameters", []):
                name = p["Name"].rsplit("/", 1)[-1]
                val = p["Value"]
                if name == "strategy":
                    defaults["strategy"] = val
                elif name == "rate-limit-delay":
                    defaults["rate_limit_delay"] = max(0.2, min(60.0, float(val)))
                elif name == "max-duration":
                    defaults["max_duration"] = max(60, min(840, int(val)))
                elif name == "workers-per-pulse":
                    defaults["workers_per_pulse"] = max(1, min(10, int(val)))
    except Exception as e:
        print(f"[config] SSM read failed ({type(e).__name__}), using defaults: {e}")
    return defaults


# ── DynamoDB helpers ─────────────────────────────────────────

def _pair_key(a, b):
    """Normalized pair key: sorted alphabetically, joined by |."""
    return "|".join(sorted([a, b]))


def _load_elements():
    """Load all known element names from DynamoDB."""
    table = _get_dynamo().Table(DISCOVERIES_TABLE)
    elements = {}
    kwargs = {
        "ProjectionExpression": "#el, generation",
        "ExpressionAttributeNames": {"#el": "element"},
    }
    while True:
        resp = table.scan(**kwargs)
        for item in resp.get("Items", []):
            elements[item.get("element", "")] = {
                "generation": int(item.get("generation", 0)),
            }
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return elements


def _load_tried_sample(limit=10000):
    """Load a sample of tried pair keys for deduplication.

    For large datasets we load a random sample rather than the full set.
    The conditional write on DynamoDB handles true dedup.
    """
    table = _get_dynamo().Table(TRIED_PAIRS_TABLE)
    tried = set()
    kwargs = {"ProjectionExpression": "pair_key", "Limit": limit}
    while True:
        resp = table.scan(**kwargs)
        for item in resp.get("Items", []):
            tried.add(item["pair_key"])
        if "LastEvaluatedKey" not in resp or len(tried) >= limit:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return tried


def _save_discovery(element, recipe, is_new, generation, emoji):
    """Save a new discovery using conditional write (no overwrite)."""
    table = _get_dynamo().Table(DISCOVERIES_TABLE)
    try:
        table.put_item(
            Item={
                "element": element,
                "recipe": recipe,
                "is_new": is_new,
                "generation": generation,
                "emoji": emoji or "",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
            ConditionExpression="attribute_not_exists(#el)",
            ExpressionAttributeNames={"#el": "element"},
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False  # Already exists
        raise


def _save_recipe(pair_key, result):
    """Save a recipe using conditional write."""
    table = _get_dynamo().Table(RECIPES_TABLE)
    try:
        table.put_item(
            Item={"pair_key": pair_key, "result": result},
            ConditionExpression="attribute_not_exists(pair_key)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def _mark_pair_tried(pair_key):
    """Mark a pair as tried using conditional write."""
    table = _get_dynamo().Table(TRIED_PAIRS_TABLE)
    try:
        table.put_item(
            Item={"pair_key": pair_key},
            ConditionExpression="attribute_not_exists(pair_key)",
        )
        return True  # We claimed this pair
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False  # Another worker already tried it
        raise


def _count_total_runs():
    """Count total worker runs for strategy rotation (approximate via DescribeTable)."""
    table = _get_dynamo().Table(WORKER_RUNS_TABLE)
    table.load()
    return table.item_count  # approximate, updated every ~6 hours — sufficient for rotation


def _save_worker_run(run_summary):
    """Log this run to the worker_runs audit table."""
    table = _get_dynamo().Table(WORKER_RUNS_TABLE)
    # TTL: expire after 30 days
    ttl = int(time.time()) + (30 * 86400)
    table.put_item(Item={**run_summary, "ttl": ttl})


# ── API call ─────────────────────────────────────────────────

def _query_pair(first, second):
    """Make one API call to neal.fun. Returns dict or None."""
    url = (
        f"{API_ENDPOINT}"
        f"?first={urllib.request.quote(first)}"
        f"&second={urllib.request.quote(second)}"
    )
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        t0 = time.monotonic()
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read(64 * 1024)  # Cap response at 64KB
            data = json.loads(raw.decode())
            data["_response_time"] = time.monotonic() - t0
            return data
    except urllib.error.HTTPError as e:
        if e.code in (429, 403):
            return {"_rate_limited": True, "_status_code": e.code}
        print(f"[query] HTTP {e.code} for {first} + {second}: {e.reason}")
        return None
    except Exception as e:
        print(f"[query] Failed {first} + {second}: {type(e).__name__}: {e}")
        return None


# ── Strategies ───────────────────────────────────────────────

def _generate_bfs_pairs(elements, tried, batch_size=100):
    """BFS: combine newest generation with all known elements."""
    if not elements:
        return []

    max_gen = max(e["generation"] for e in elements.values())
    # Use current frontier (highest gen) as anchors
    frontier = [name for name, e in elements.items() if e["generation"] == max_gen]
    all_names = list(elements.keys())

    pairs = []
    for anchor in frontier:
        for partner in all_names:
            key = _pair_key(anchor, partner)
            if key not in tried:
                pairs.append((anchor, partner))
                if len(pairs) >= batch_size:
                    return pairs
    # If frontier exhausted, try gen-1
    if not pairs and max_gen > 0:
        prev_frontier = [name for name, e in elements.items() if e["generation"] == max_gen - 1]
        for anchor in prev_frontier:
            for partner in all_names:
                key = _pair_key(anchor, partner)
                if key not in tried:
                    pairs.append((anchor, partner))
                    if len(pairs) >= batch_size:
                        return pairs
    return pairs


def _generate_random_pairs(elements, tried, batch_size=100):
    """Random: pick random untried pairs."""
    all_names = list(elements.keys())
    if len(all_names) < 2:
        return []

    pairs = []
    attempts = 0
    max_attempts = batch_size * 10
    while len(pairs) < batch_size and attempts < max_attempts:
        a = random.choice(all_names)
        b = random.choice(all_names)
        if a == b:
            attempts += 1
            continue
        key = _pair_key(a, b)
        if key not in tried:
            pairs.append((a, b))
            tried.add(key)  # Prevent duplicates within batch
        attempts += 1
    return pairs


def _generate_anchor_pairs(elements, tried, batch_size=100):
    """Anchor sweep: pick a random element and combine with shuffled partners."""
    all_names = list(elements.keys())
    if not all_names:
        return []

    anchor = random.choice(all_names)
    partners = [n for n in all_names if n != anchor]
    random.shuffle(partners)
    pairs = []
    for partner in partners:
        key = _pair_key(anchor, partner)
        if key not in tried:
            pairs.append((anchor, partner))
            if len(pairs) >= batch_size:
                break
    return pairs


def _generate_pairs(strategy, elements, tried, batch_size=100):
    """Route to the right strategy."""
    generators = {
        "bfs": _generate_bfs_pairs,
        "random": _generate_random_pairs,
        "anchor": _generate_anchor_pairs,
    }
    gen_fn = generators.get(strategy, _generate_bfs_pairs)
    return gen_fn(elements, tried, batch_size)


# ── Main handler ─────────────────────────────────────────────

def lambda_handler(event, context):
    """Lambda entry point. Self-coordinates a single exploration pulse."""
    run_id = str(uuid.uuid4())[:8]
    started_at = datetime.now(timezone.utc).isoformat()
    start_mono = time.monotonic()

    try:
        return _run_pulse(event, run_id, started_at, start_mono)
    except Exception as e:
        duration = round(time.monotonic() - start_mono, 1)
        print(f"[worker:{run_id}] FATAL: {type(e).__name__}: {e}")
        try:
            _save_worker_run({
                "run_id": run_id,
                "started_at": started_at,
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "duration_seconds": int(duration),
                "strategy": "unknown",
                "api_calls": 0, "pairs_tried": 0,
                "discoveries": 0, "first_discoveries": 0,
                "nothing_count": 0, "errors": 1,
                "elements_total": 0,
                "final_delay": Decimal("0"),
                "source": str(event.get("source", "manual"))[:50],
                "fatal_error": f"{type(e).__name__}: {str(e)[:100]}",
            })
        except Exception:
            pass
        raise


def _run_pulse(event, run_id, started_at, start_mono):
    """Core pulse logic, wrapped by lambda_handler for error safety."""
    print(f"[worker:{run_id}] Starting pulse")

    # Load config
    config = _load_config()
    initial_delay = config["rate_limit_delay"]
    max_duration = config["max_duration"]

    # Strategy: event payload can override, otherwise rotate or use SSM value
    _STRATEGIES = ["bfs", "random", "anchor"]
    event_strategy = event.get("strategy")
    if event_strategy in _STRATEGIES:
        strategy = event_strategy
    elif config["strategy"] == "rotate":
        run_count = _count_total_runs()
        strategy = _STRATEGIES[run_count % len(_STRATEGIES)]
    else:
        strategy = config["strategy"]

    print(f"[worker:{run_id}] Config: strategy={strategy}, "
          f"delay={initial_delay}s, max_duration={max_duration}s")

    # Load state from DynamoDB
    elements = _load_elements()
    tried = _load_tried_sample()

    # Ensure base elements exist
    for base in BASE_ELEMENTS:
        if base not in elements:
            _save_discovery(base, "base", False, 0, "")
            elements[base] = {"generation": 0}

    print(f"[worker:{run_id}] Loaded {len(elements)} elements, "
          f"{len(tried)} tried pairs (sample)")

    # AIMD rate limiter state
    delay = initial_delay
    min_delay = 0.2
    known_safe_delay = initial_delay
    consecutive_successes = 0
    consecutive_failures = 0
    stability_threshold = 20

    # Exploration loop
    api_calls = 0
    discoveries = 0
    first_discoveries = 0
    errors = 0
    nothing_count = 0
    pairs_tried = 0

    def time_left():
        return max_duration - (time.monotonic() - start_mono)

    while time_left() > 5:
        # Generate a batch of pairs to try
        pairs = _generate_pairs(strategy, elements, tried, batch_size=50)
        if not pairs:
            print(f"[worker:{run_id}] No untried pairs available for strategy={strategy}")
            break

        for first, second in pairs:
            if time_left() <= 2:
                break

            pk = _pair_key(first, second)

            # Claim this pair atomically in DynamoDB
            if not _mark_pair_tried(pk):
                continue  # Another worker already claimed it

            tried.add(pk)
            pairs_tried += 1

            # Rate limiting
            if consecutive_failures > 0:
                wait = min(60, 5 * (2 ** (consecutive_failures - 1)))
                if wait > time_left() - 2:
                    print(f"[worker:{run_id}] Backoff {wait:.0f}s exceeds remaining time, stopping")
                    break
                time.sleep(wait)
            else:
                time.sleep(min(delay, max(0, time_left() - 2)))

            # Make API call
            data = _query_pair(first, second)
            api_calls += 1

            if data is None:
                errors += 1
                continue

            if data.get("_rate_limited"):
                consecutive_failures += 1
                consecutive_successes = 0
                errors += 1
                delay = min(60, max(known_safe_delay, delay) * 2.0)
                status_code = data.get("_status_code", "?")
                print(f"[worker:{run_id}] Rate limited (HTTP {status_code}), "
                      f"streak={consecutive_failures}, delay={delay:.1f}s")
                continue

            # Successful API call
            consecutive_successes += 1
            consecutive_failures = 0
            if consecutive_successes >= stability_threshold:
                old = delay
                delay = max(min_delay, delay * 0.9)
                if delay < old:
                    known_safe_delay = old

            result_name = data.get("result")
            if not isinstance(result_name, str) or not result_name or result_name == "Nothing":
                nothing_count += 1
                continue
            if len(result_name) > 200:
                print(f"[worker:{run_id}] WARN: result name too long ({len(result_name)} chars), skipping")
                continue

            is_first = bool(data.get("isNew", False))
            emoji = data.get("emoji", "")
            if not isinstance(emoji, str) or len(emoji) > 20:
                emoji = ""

            # Save recipe
            _save_recipe(pk, result_name)

            # Save discovery if new
            if result_name not in elements:
                gen_a = elements.get(first, {}).get("generation", 0)
                gen_b = elements.get(second, {}).get("generation", 0)
                generation = max(gen_a, gen_b) + 1

                saved = _save_discovery(result_name, f"{first} + {second}",
                                        is_first, generation, emoji)
                if saved:
                    discoveries += 1
                    if is_first:
                        first_discoveries += 1
                    elements[result_name] = {
                        "generation": generation,
                    }
                    print(f"[worker:{run_id}] {'FIRST' if is_first else 'NEW'}: "
                          f"{first} + {second} = {result_name}")

    duration = round(time.monotonic() - start_mono, 1)

    # Save run summary to audit table
    run_summary = {
        "run_id": run_id,
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": int(duration),
        "strategy": strategy,
        "api_calls": api_calls,
        "pairs_tried": pairs_tried,
        "discoveries": discoveries,
        "first_discoveries": first_discoveries,
        "nothing_count": nothing_count,
        "errors": errors,
        "elements_total": len(elements),
        "final_delay": Decimal(str(round(delay, 3))),
        "source": str(event.get("source", "manual"))[:50],
    }

    try:
        _save_worker_run(run_summary)
    except Exception as e:
        print(f"[worker:{run_id}] ERROR: Failed to save run summary: {type(e).__name__}: {e}")
        print(f"[worker:{run_id}] Lost run summary: {json.dumps(run_summary, default=str)}")

    print(f"[worker:{run_id}] Done: {api_calls} API calls, "
          f"{discoveries} discoveries ({first_discoveries} firsts), "
          f"{errors} errors, {duration}s")

    return run_summary

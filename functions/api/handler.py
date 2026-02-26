"""
Infinite Craft API Lambda — Read-only DynamoDB gateway.

Serves the dashboard with current exploration state.
GET /state          — Summary stats
GET /discoveries    — Paginated discovery list
GET /discoveries/{element} — Single element detail with recipes
GET /workers        — Recent worker run history
"""

import json
import os
import time
import urllib.parse

import boto3

# ── Environment ──────────────────────────────────────────────

DISCOVERIES_TABLE = os.environ.get("DISCOVERIES_TABLE", "infcft-discoveries-dev")
RECIPES_TABLE = os.environ.get("RECIPES_TABLE", "infcft-recipes-dev")
WORKER_RUNS_TABLE = os.environ.get("WORKER_RUNS_TABLE", "infcft-worker-runs-dev")
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*")

# ── Clients (reused across warm invocations) ─────────────────

_dynamo = None


def _get_dynamo():
    global _dynamo
    if _dynamo is None:
        _dynamo = boto3.resource("dynamodb")
    return _dynamo


# ── Response helpers ─────────────────────────────────────────

# Thread-local request ID set per invocation
_request_id = None


def _response(status, body, cache_seconds=60):
    """Build API Gateway proxy response with security headers."""
    if cache_seconds < 0:
        cache_control = "no-store"
    elif cache_seconds == 0:
        cache_control = "no-cache"
    else:
        cache_control = f"public, max-age={cache_seconds}"
    headers = {
        "Content-Type": "application/json",
        "Cache-Control": cache_control,
        "Access-Control-Allow-Origin": ALLOWED_ORIGINS,
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "X-Content-Type-Options": "nosniff",
    }
    if _request_id:
        headers["X-Request-Id"] = _request_id
    return {
        "statusCode": status,
        "headers": headers,
        "body": json.dumps(body, default=str),
    }


def _error(status, message):
    return _response(status, {"error": message}, cache_seconds=-1)


# ── Route: GET /state ────────────────────────────────────────

def _get_state():
    """Return summary statistics using a single discovery table scan."""
    dynamo = _get_dynamo()
    disc_table = dynamo.Table(DISCOVERIES_TABLE)

    # Single paginated scan of discoveries with minimal projection
    all_items = []
    scan_kwargs = {
        "ProjectionExpression": "#el, generation, recipe, is_new",
        "ExpressionAttributeNames": {"#el": "element"},
    }
    while True:
        resp = disc_table.scan(**scan_kwargs)
        all_items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    # Compute all stats in a single pass
    discovery_count = len(all_items)
    first_discovery_count = 0
    gen_dist = {}
    name_len_dist = {}
    elem_gen = {}
    ingredient_usage = {}

    for item in all_items:
        gen = int(item.get("generation", 0))
        name = item.get("element", "")
        gen_dist[gen] = gen_dist.get(gen, 0) + 1
        elem_gen[name] = gen

        if item.get("is_new"):
            first_discovery_count += 1

        length = len(name)
        bucket = "1-4" if length <= 4 else "5-7" if length <= 7 else "8-10" if length <= 10 else "11-15" if length <= 15 else "16+"
        name_len_dist[bucket] = name_len_dist.get(bucket, 0) + 1

        recipe = item.get("recipe", "")
        if recipe and recipe != "base" and " + " in recipe:
            parts = recipe.split(" + ", 1)
            for p in parts:
                ingredient_usage[p] = ingredient_usage.get(p, 0) + 1

    top_ingredients = sorted(ingredient_usage.items(), key=lambda x: x[1], reverse=True)[:20]

    # Recipe count via DescribeTable (no scan needed)
    rec_table = dynamo.Table(RECIPES_TABLE)
    rec_table.load()
    recipe_count = rec_table.item_count  # approximate, updated every ~6 hours

    # Last worker run
    runs_table = dynamo.Table(WORKER_RUNS_TABLE)
    all_runs = []
    runs_kwargs = {
        "ProjectionExpression": "run_id, started_at, finished_at, api_calls, discoveries, first_discoveries, strategy",
    }
    while True:
        runs_resp = runs_table.scan(**runs_kwargs)
        all_runs.extend(runs_resp.get("Items", []))
        if "LastEvaluatedKey" not in runs_resp:
            break
        runs_kwargs["ExclusiveStartKey"] = runs_resp["LastEvaluatedKey"]
    all_runs.sort(key=lambda x: x.get("started_at", ""), reverse=True)
    last_run = all_runs[0] if all_runs else None

    return _response(200, {
        "elements": discovery_count,
        "recipes": recipe_count,
        "first_discoveries": first_discovery_count,
        "generation_distribution": dict(sorted(gen_dist.items())),
        "name_length_distribution": name_len_dist,
        "top_ingredients": [{"name": n, "count": c, "generation": int(elem_gen.get(n, 0))} for n, c in top_ingredients],
        "last_run": last_run,
        "timestamp": int(time.time()),
    }, cache_seconds=120)


# ── Route: GET /discoveries ──────────────────────────────────

def _get_discoveries(params):
    """Return paginated discovery list."""
    dynamo = _get_dynamo()
    table = dynamo.Table(DISCOVERIES_TABLE)

    try:
        limit = min(500, max(1, int(params.get("limit", "100"))))
    except (ValueError, TypeError):
        return _error(400, "Invalid limit parameter")
    generation = params.get("generation")
    search = params.get("search", "").strip().lower()
    if len(search) > 100:
        return _error(400, "Search query too long")

    projection = "#el, recipe, is_new, generation, emoji, #ts"
    attr_names = {"#ts": "timestamp", "#el": "element"}

    # When searching, use DynamoDB FilterExpression with contains() and
    # paginate until we have enough results (search across ALL elements)
    if search and len(search) >= 2:
        items = []
        scan_kwargs = {
            "ProjectionExpression": projection,
            "ExpressionAttributeNames": attr_names,
            "FilterExpression": boto3.dynamodb.conditions.Attr("element").contains(search)
                                | boto3.dynamodb.conditions.Attr("element").contains(search.title())
                                | boto3.dynamodb.conditions.Attr("element").contains(search.capitalize()),
        }
        if generation is not None:
            try:
                gen_val = int(generation)
            except ValueError:
                return _error(400, "Invalid generation parameter: must be an integer")
            scan_kwargs["FilterExpression"] = scan_kwargs["FilterExpression"] & boto3.dynamodb.conditions.Attr("generation").eq(gen_val)

        max_pages = 10
        pages = 0
        while pages < max_pages:
            resp = table.scan(**scan_kwargs)
            items.extend(resp.get("Items", []))
            pages += 1
            if len(items) >= limit or "LastEvaluatedKey" not in resp:
                break
            scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

        # Case-insensitive post-filter for exact match
        items = [i for i in items if search in i.get("element", "").lower()]
        items.sort(key=lambda x: (-int(x.get("generation", 0)), x.get("element", "")))
        items = items[:limit]

        return _response(200, {
            "discoveries": items,
            "count": len(items),
        })

    # Non-search path: paginated scan
    kwargs = {
        "Limit": limit,
        "ProjectionExpression": projection,
        "ExpressionAttributeNames": attr_names,
    }

    # Pagination — validate token matches expected schema {"element": "<string>"}
    next_key = params.get("next")
    if next_key:
        if len(next_key) > 256:
            return _error(400, "Invalid pagination token")
        try:
            parsed = json.loads(next_key)
            if (isinstance(parsed, dict)
                    and set(parsed.keys()) == {"element"}
                    and isinstance(parsed.get("element"), str)
                    and len(parsed["element"]) <= 200):
                kwargs["ExclusiveStartKey"] = parsed
            else:
                return _error(400, "Invalid pagination token")
        except (json.JSONDecodeError, TypeError):
            return _error(400, "Invalid pagination token")

    # Filter by generation
    filter_expr = None
    expr_values = {}
    if generation is not None:
        try:
            gen_val = int(generation)
        except ValueError:
            return _error(400, "Invalid generation parameter: must be an integer")
        filter_expr = "generation = :gen"
        expr_values[":gen"] = gen_val

    if filter_expr:
        kwargs["FilterExpression"] = filter_expr
        kwargs["ExpressionAttributeValues"] = expr_values

    resp = table.scan(**kwargs)
    items = resp.get("Items", [])

    # Ensure base elements (gen 0) are always included
    BASE_ELEMENTS = {"Earth", "Water", "Fire", "Wind"}
    if generation is None and not next_key:
        present = {i.get("element") for i in items}
        missing = BASE_ELEMENTS - present
        if missing:
            for base_el in missing:
                base_resp = table.get_item(Key={"element": base_el})
                base_item = base_resp.get("Item")
                if base_item:
                    items.append(base_item)

    # Sort by generation desc, then name
    items.sort(key=lambda x: (-int(x.get("generation", 0)), x.get("element", "")))

    result = {
        "discoveries": items,
        "count": len(items),
    }
    if "LastEvaluatedKey" in resp:
        result["next"] = json.dumps(resp["LastEvaluatedKey"], default=str)

    return _response(200, result)


# ── Route: GET /discoveries/{element} ────────────────────────

def _get_discovery_detail(element):
    """Return single element detail with all recipes that produce it."""
    dynamo = _get_dynamo()

    # Get discovery
    disc_table = dynamo.Table(DISCOVERIES_TABLE)
    disc_resp = disc_table.get_item(Key={"element": element})
    item = disc_resp.get("Item")
    if not item:
        return _error(404, "Element not found")

    # Find all recipes that produce this element via GSI query
    rec_table = dynamo.Table(RECIPES_TABLE)
    recipes = []
    query_kwargs = {
        "IndexName": "result-index",
        "KeyConditionExpression": boto3.dynamodb.conditions.Key("result").eq(element),
        "ProjectionExpression": "pair_key",
    }
    while True:
        rec_resp = rec_table.query(**query_kwargs)
        for r in rec_resp.get("Items", []):
            parts = r["pair_key"].split("|")
            if len(parts) == 2:
                recipes.append({"first": parts[0], "second": parts[1]})
        if "LastEvaluatedKey" not in rec_resp:
            break
        query_kwargs["ExclusiveStartKey"] = rec_resp["LastEvaluatedKey"]

    return _response(200, {
        "element": item,
        "recipes": recipes,
        "recipe_count": len(recipes),
    })


# ── Route: GET /first-discoveries ────────────────────────────

def _get_first_discoveries():
    """Return all first discoveries (is_new=True)."""
    dynamo = _get_dynamo()
    table = dynamo.Table(DISCOVERIES_TABLE)

    all_firsts = []
    scan_kwargs = {
        "FilterExpression": boto3.dynamodb.conditions.Attr("is_new").eq(True),
        "ProjectionExpression": "#el, recipe, generation, emoji, #ts",
        "ExpressionAttributeNames": {"#el": "element", "#ts": "timestamp"},
    }
    while True:
        resp = table.scan(**scan_kwargs)
        all_firsts.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    # Sort by generation desc, then name
    all_firsts.sort(key=lambda x: (-int(x.get("generation", 0)), x.get("element", "")))

    return _response(200, {
        "discoveries": all_firsts,
        "count": len(all_firsts),
    }, cache_seconds=120)


# ── Route: GET /workers ──────────────────────────────────────

def _get_workers():
    """Return recent worker run history."""
    dynamo = _get_dynamo()
    table = dynamo.Table(WORKER_RUNS_TABLE)

    # Scan all runs (paginate for full coverage)
    all_items = []
    scan_kwargs = {
        "ProjectionExpression": (
            "run_id, started_at, finished_at, duration_seconds, "
            "strategy, api_calls, pairs_tried, discoveries, "
            "first_discoveries, errors, elements_total, #src, "
            "nothing_count, final_delay"
        ),
        "ExpressionAttributeNames": {"#src": "source"},
    }
    while True:
        resp = table.scan(**scan_kwargs)
        all_items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    # Sort by started_at desc
    all_items.sort(key=lambda x: x.get("started_at", ""), reverse=True)

    return _response(200, {
        "runs": all_items[:100],
        "count": len(all_items),
    }, cache_seconds=30)


# ── Route: GET /chain/{element} ────────────────────────────

_BASE_ELEMENTS = {"Water", "Fire", "Wind", "Earth"}


def _get_chain(element):
    """Build full dependency tree from element back to gen 0, server-side."""
    dynamo = _get_dynamo()
    table = dynamo.Table(DISCOVERIES_TABLE)

    nodes = {}  # name -> {element, generation, recipe, emoji}
    edges = []  # [{source, target}]
    pending = {element}  # names to fetch next
    visited = set()

    while pending:
        # Safety cap — prevent runaway chains
        if len(nodes) > 1000:
            return _error(400, "Element dependency tree too large (exceeded 1000 nodes)")

        # Separate base elements (no fetch needed) from non-base
        to_fetch = []
        for name in pending:
            if name in visited:
                continue
            visited.add(name)
            if name in _BASE_ELEMENTS:
                nodes[name] = {"element": name, "generation": 0, "recipe": "base", "emoji": ""}
            else:
                to_fetch.append(name)
        pending = set()

        # Batch fetch up to 100 at a time via resource-level batch_get_item
        for i in range(0, len(to_fetch), 100):
            batch_keys = [{"element": n} for n in to_fetch[i:i + 100]]
            resp = dynamo.batch_get_item(
                RequestItems={
                    DISCOVERIES_TABLE: {
                        "Keys": batch_keys,
                        "ProjectionExpression": "#el, generation, recipe, emoji",
                        "ExpressionAttributeNames": {"#el": "element"},
                    }
                }
            )
            # Process returned items
            found_names = set()
            for item in resp.get("Responses", {}).get(DISCOVERIES_TABLE, []):
                name = item.get("element", "")
                found_names.add(name)
                gen = int(item.get("generation", 0))
                recipe = item.get("recipe", "base")
                emoji = item.get("emoji", "")

                nodes[name] = {"element": name, "generation": gen, "recipe": recipe, "emoji": emoji}

                if recipe and recipe != "base" and " + " in recipe:
                    parts = recipe.split(" + ", 1)
                    if len(parts) == 2:
                        edges.append({"source": parts[0], "target": name})
                        edges.append({"source": parts[1], "target": name})
                        for p in parts:
                            if p not in visited:
                                pending.add(p)

            # Handle unprocessed keys (retry)
            unprocessed = resp.get("UnprocessedKeys", {}).get(DISCOVERIES_TABLE, {}).get("Keys", [])
            for key in unprocessed:
                name = key.get("element", "")
                if name and name not in nodes:
                    pending.add(name)
                    visited.discard(name)

            # Elements not found in DB — treat as base
            for name in to_fetch[i:i + 100]:
                if name not in found_names and name not in nodes:
                    nodes[name] = {"element": name, "generation": 0, "recipe": "base", "emoji": ""}

    return _response(200, {
        "target": element,
        "nodes": list(nodes.values()),
        "edges": edges,
        "node_count": len(nodes),
        "edge_count": len(edges),
    }, cache_seconds=300)


# ── Router ───────────────────────────────────────────────────

def lambda_handler(event, context):
    """API Gateway proxy handler — routes to the correct function."""
    global _request_id
    _request_id = getattr(context, "aws_request_id", None) if context else None

    try:
        path = event.get("path", "/")
        method = event.get("httpMethod", "GET")
        params = event.get("queryStringParameters") or {}
        path_params = event.get("pathParameters") or {}

        # Only allow GET
        if method == "OPTIONS":
            return _response(200, {}, cache_seconds=3600)
        if method != "GET":
            return _error(405, "Method not allowed")

        # Strip /api prefix if present (CloudFront routes /api/* to this origin)
        if path.startswith("/api"):
            path = path[4:] or "/"

        # Route
        if path == "/state":
            return _get_state()
        elif path == "/discoveries":
            return _get_discoveries(params)
        elif path.startswith("/discoveries/"):
            element = path_params.get("element") or path[len("/discoveries/"):]
            if element:
                element = urllib_unquote(element)
            if not element or len(element) > 200:
                return _error(400, "Invalid element name")
            return _get_discovery_detail(element)
        elif path.startswith("/chain/"):
            element = path_params.get("element") or path[len("/chain/"):]
            if element:
                element = urllib_unquote(element)
            if not element or len(element) > 200:
                return _error(400, "Invalid element name")
            return _get_chain(element)
        elif path == "/first-discoveries":
            return _get_first_discoveries()
        elif path == "/workers":
            return _get_workers()
        else:
            return _error(404, "Not found")
    except Exception as e:
        print(f"[api] Unhandled error (request_id={_request_id}): {type(e).__name__}: {e}")
        return _error(500, "Internal server error")


def urllib_unquote(s):
    """Decode URL-encoded string (stdlib only)."""
    return urllib.parse.unquote(s)

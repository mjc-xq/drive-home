#!/usr/bin/env python3
"""Headless bulk-download of Mixamo animations as FBX for your PRIMARY character.

A no-GUI port of github.com/juanjo4martinez/mixamo-downloader. The GUI's only job is to
grab the Mixamo `access_token` from localStorage after you log in; everything else is the
Mixamo API. So: log into mixamo.com, SELECT/UPLOAD the rig you want as your *Primary
Character*, grab the token (instructions below), and run this.

Get the token: on mixamo.com (logged in) open the browser console (F12 -> Console) and run
    localStorage.getItem('access_token')
copy the long string, and pass it via --token or the MIXAMO_TOKEN env var.

Downloads in-place FBX (fbx7_2019, NO skin) -> feed straight into convert_mixamo_fbx.py.
RESUMABLE: a .done manifest of completed animation IDs is kept, so re-running (after the
token expires, which it will on a big run) skips what's already fetched. Token expiry is
detected (401/403) and the run stops cleanly so you can paste a fresh token and resume.

Usage:
  MIXAMO_TOKEN=eyJ... scripts/.venv/bin/python scripts/mixamo_bulk_download.py [--all]
  ... --query walk            # only anims whose name contains "walk" (case-insensitive)
  ... --words idle,walk,run,jump,punch,kick,hit,death,dance,wave   # any of these
  ... --limit 200             # cap the count (after filtering)
  ... --out exports/mixamo_fbx
"""
import argparse
import json
import os
import re
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://www.mixamo.com/api/v1"
HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "X-Api-Key": "mixamo2",
    "X-Requested-With": "XMLHttpRequest",
}


class TokenError(Exception):
    pass


def load_token(arg):
    t = arg or os.environ.get("MIXAMO_TOKEN")
    if not t and os.path.exists(os.path.join(ROOT, ".mixamo_token")):
        t = open(os.path.join(ROOT, ".mixamo_token")).read().strip()
    if not t:
        sys.exit("No token. Get it from mixamo.com console: localStorage.getItem('access_token') "
                 "-> pass via --token or MIXAMO_TOKEN env.")
    return t.strip().strip('"').strip("'")


def safe(name):
    return re.sub(r"[^\w\-. ]+", "_", name).strip()[:120] or "anim"


def check(resp):
    if resp.status_code in (401, 403):
        raise TokenError(f"{resp.status_code} — access token invalid/expired. Grab a fresh one and re-run (it resumes).")
    return resp


def primary_character(s):
    r = check(s.get(f"{API}/characters/primary", headers=HEADERS, timeout=30))
    j = r.json()
    return j.get("primary_character_id"), j.get("primary_character_name")


def build_payload(s, cid, anim_id):
    r = check(s.get(f"{API}/products/{anim_id}?similar=0&character_id={cid}", headers=HEADERS, timeout=30))
    d = r.json()
    name, _type, gms = d["description"], d["type"], d["details"]["gms_hash"]
    gms["params"] = ",".join(str(int(p[-1])) for p in gms["params"])
    gms["overdrive"] = 0
    gms["trim"] = [int(gms["trim"][0]), int(gms["trim"][1])]
    payload = {
        "character_id": cid, "product_name": name, "type": _type,
        "preferences": {"format": "fbx7_2019", "skin": False, "fps": "24", "reducekf": "0"},
        "gms_hash": [gms],
    }
    return name, json.dumps(payload)


def export_and_link(s, cid, payload, poll_timeout=90):
    check(s.post(f"{API}/animations/export", data=payload, headers=HEADERS, timeout=30))
    t0 = time.time()
    while time.time() - t0 < poll_timeout:
        time.sleep(1.0)
        r = check(s.get(f"{API}/characters/{cid}/monitor", headers=HEADERS, timeout=30))
        st = r.json().get("status")
        if st == "completed":
            return r.json().get("job_result")
        if st == "failed":
            return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token")
    ap.add_argument("--out", default="exports/mixamo_fbx")
    ap.add_argument("--catalog", default=os.path.join(ROOT, "scripts", "mixamo_anims.json"))
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--query", help="substring filter on animation name (case-insensitive)")
    ap.add_argument("--words", help="comma-separated keywords; keep anims matching ANY")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--delay", type=float, default=0.3)
    args = ap.parse_args()

    token = load_token(args.token)
    HEADERS["Authorization"] = f"Bearer {token}"
    out = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)
    os.makedirs(out, exist_ok=True)
    done_path = os.path.join(out, ".done.json")
    done = set(json.load(open(done_path))) if os.path.exists(done_path) else set()

    catalog = json.load(open(args.catalog))               # {anim_id: name}
    items = list(catalog.items())
    if args.query:
        q = args.query.lower()
        items = [(i, n) for i, n in items if q in n.lower()]
    if args.words:
        ws = [w.strip().lower() for w in args.words.split(",") if w.strip()]
        items = [(i, n) for i, n in items if any(w in n.lower() for w in ws)]
    if args.limit:
        items = items[:args.limit]
    todo = [(i, n) for i, n in items if i not in done]

    s = requests.Session()
    try:
        cid, cname = primary_character(s)
    except TokenError as e:
        sys.exit(f"TOKEN: {e}")
    if not cid:
        sys.exit("No primary character on your Mixamo account. On mixamo.com, select/upload the rig "
                 "(it becomes your Primary Character), then re-run.")
    print(f"primary character: {cname} ({cid})")
    print(f"to download: {len(todo)} (filtered {len(items)}, already done {len(done)}) -> {os.path.relpath(out, ROOT)}")

    ok = fail = 0
    try:
        for k, (anim_id, name) in enumerate(todo, 1):
            try:
                pname, payload = build_payload(s, cid, anim_id)
                link = export_and_link(s, cid, payload)
                if not link:
                    fail += 1
                    print(f"  [{k}/{len(todo)}] FAIL (export) {name}")
                    continue
                data = s.get(link, timeout=120).content
                fn = safe(pname)
                path = os.path.join(out, fn + ".fbx")
                if os.path.exists(path):
                    path = os.path.join(out, f"{fn}_{anim_id[:6]}.fbx")
                open(path, "wb").write(data)
                done.add(anim_id); ok += 1
                if k % 10 == 0 or k == len(todo):
                    json.dump(sorted(done), open(done_path, "w"))
                    print(f"  [{k}/{len(todo)}] ok={ok} fail={fail}  last: {fn}.fbx ({len(data)//1024} KB)")
                time.sleep(args.delay)
            except TokenError:
                raise
            except Exception as e:
                fail += 1
                print(f"  [{k}/{len(todo)}] ERR {name}: {str(e)[:80]}")
    except TokenError as e:
        json.dump(sorted(done), open(done_path, "w"))
        print(f"\nSTOPPED — {e}\nProgress saved ({len(done)} done). Paste a fresh token and re-run to resume.")
        sys.exit(2)
    finally:
        json.dump(sorted(done), open(done_path, "w"))
    print(f"\nDONE. downloaded {ok}, failed {fail}, total complete {len(done)} -> {os.path.relpath(out, ROOT)}")


if __name__ == "__main__":
    main()

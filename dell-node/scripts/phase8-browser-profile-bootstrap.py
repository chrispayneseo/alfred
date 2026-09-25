#!/usr/bin/env python3
"""Create one human-authenticated Playwright storage-state profile for Alfred.

Run this on the Dell desktop session. Alfred never receives login credentials:
Chromium is launched visibly, the owner completes login/2FA/CAPTCHA manually,
and this script saves only Playwright storage state plus a small origin allowlist.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,31}$")
DEFAULT_ROOT = Path("/opt/alfred-node/browser-profiles")


def origin_for(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("URL must be HTTP(S) with a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Credentials must not be embedded in the URL")
    default = 443 if parsed.scheme.casefold() == "https" else 80
    port = parsed.port or default
    suffix = "" if port == default else f":{port}"
    return f"{parsed.scheme.casefold()}://{parsed.hostname.casefold()}{suffix}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap one Alfred authenticated browser profile")
    parser.add_argument("profile_id")
    parser.add_argument("url")
    parser.add_argument("--label", default="")
    parser.add_argument("--allow-origin", action="append", default=[])
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    args = parser.parse_args()

    profile_id = args.profile_id.strip().casefold()
    if not PROFILE_ID_RE.fullmatch(profile_id):
        parser.error("profile_id must match [a-z0-9][a-z0-9_-]{2,31}")
    primary_origin = origin_for(args.url)
    allowed = {primary_origin}
    for value in args.allow_origin:
        allowed.add(origin_for(value))
    if len(allowed) > 10:
        parser.error("At most 10 origins may be allowed")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright is required on the Dell for this one-time human bootstrap.", file=sys.stderr)
        print("Use the Phase 8 setup command from Alfred's deployment notes.", file=sys.stderr)
        return 2

    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    state_path = root / f"{profile_id}.state.json"
    meta_path = root / f"{profile_id}.meta.json"
    state_tmp = root / f".{profile_id}.state.tmp"
    meta_tmp = root / f".{profile_id}.meta.tmp"

    print(f"Opening {args.url}")
    print("Complete sign-in yourself in the browser window, including any 2FA or CAPTCHA.")
    print("Alfred does not see or store what you type into those login fields.")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context(accept_downloads=False)
        page = context.new_page()
        page.goto(args.url, wait_until="domcontentloaded")
        input("When login is complete and the account page is visible, press Enter here... ")
        final_origin = origin_for(page.url)
        if final_origin not in allowed:
            print(
                f"Refusing to save: final browser origin {final_origin} is not in the allowed origin set.",
                file=sys.stderr,
            )
            browser.close()
            return 3
        context.storage_state(path=str(state_tmp))
        browser.close()

    meta_tmp.write_text(json.dumps({
        "profile_id": profile_id,
        "label": (args.label.strip() or profile_id)[:80],
        "allowed_origins": sorted(allowed),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "bootstrap": "human_interactive",
    }, indent=2), encoding="utf-8")
    os.chmod(state_tmp, 0o600)
    os.chmod(meta_tmp, 0o600)
    state_tmp.replace(state_path)
    meta_tmp.replace(meta_path)
    os.chmod(state_path, 0o600)
    os.chmod(meta_path, 0o600)

    print(f"Saved authenticated profile: {profile_id}")
    print(f"Allowed origins: {', '.join(sorted(allowed))}")
    print("No password, OTP or CAPTCHA value was passed to Alfred Core.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

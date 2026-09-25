#!/usr/bin/env python3
"""Bootstrap read-only Google OAuth credentials for Alfred on the Dell.

Runs entirely on the Dell. Reads a Google Desktop OAuth client JSON file, uses
an OAuth loopback callback on 127.0.0.1, exchanges the authorization code for an
offline refresh token, verifies the exact requested scope, and writes the
required values into Alfred's private .env file. Secrets/tokens are never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import NoReturn

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"

SERVICES = {
    "calendar": {
        "scope": "https://www.googleapis.com/auth/calendar.readonly",
        "env": {
            "GOOGLE_CLIENT_ID": "client_id",
            "GOOGLE_CLIENT_SECRET": "client_secret",
            "GOOGLE_REFRESH_TOKEN": "refresh_token",
            "GOOGLE_CALENDAR_ID": "primary",
            "GOOGLE_CALENDAR_WRITE_ENABLED": "false",
        },
    },
    "gmail": {
        "scope": "https://www.googleapis.com/auth/gmail.readonly",
        "env": {
            "GMAIL_CLIENT_ID": "client_id",
            "GMAIL_CLIENT_SECRET": "client_secret",
            "GMAIL_REFRESH_TOKEN": "refresh_token",
            "GMAIL_USER_ID": "me",
        },
    },
}


class CallbackState:
    code: str | None = None
    error: str | None = None


def fail(message: str) -> NoReturn:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_client(path: Path) -> tuple[str, str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"Could not read OAuth client JSON ({type(exc).__name__})")
    node = payload.get("installed") if isinstance(payload, dict) else None
    if not isinstance(node, dict):
        fail("OAuth JSON must be a Google Desktop app client (installed)")
    client_id = node.get("client_id")
    client_secret = node.get("client_secret")
    if not isinstance(client_id, str) or not client_id:
        fail("OAuth JSON has no client_id")
    if not isinstance(client_secret, str) or not client_secret:
        fail("OAuth JSON has no client_secret")
    return client_id, client_secret


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def callback_handler(expected_state: str):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            state = (query.get("state") or [""])[0]
            if state != expected_state:
                CallbackState.error = "OAuth state mismatch"
                status = 400
            elif query.get("error"):
                CallbackState.error = str(query["error"][0])[:200]
                status = 400
            else:
                code = (query.get("code") or [""])[0]
                if code:
                    CallbackState.code = code
                    status = 200
                else:
                    CallbackState.error = "Authorization response contained no code"
                    status = 400
            body = (
                "<html><body><h2>Alfred Google authorization received.</h2>"
                "<p>You can close this tab and return to the terminal.</p></body></html>"
            ).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args) -> None:
            return

    return Handler


def exchange_code(client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict:
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }).encode("utf-8")
    request = urllib.request.Request(
        TOKEN_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except Exception as exc:
        fail(f"OAuth token exchange failed ({type(exc).__name__})")
    if not isinstance(result, dict):
        fail("OAuth token exchange returned invalid data")
    return result


def update_env(path: Path, values: dict[str, str]) -> None:
    try:
        original = path.read_text(encoding="utf-8") if path.exists() else ""
    except OSError as exc:
        fail(f"Could not read {path} ({type(exc).__name__})")

    lines = original.splitlines()
    remaining = dict(values)
    output: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in remaining:
                output.append(f"{key}={remaining.pop(key)}")
                continue
        output.append(line)
    if remaining:
        if output and output[-1] != "":
            output.append("")
        output.append("# Google OAuth values managed by google-oauth-bootstrap.py")
        for key, value in remaining.items():
            output.append(f"{key}={value}")

    try:
        path.write_text("\n".join(output) + "\n", encoding="utf-8")
        os.chmod(path, 0o600)
    except OSError as exc:
        fail(f"Could not update {path} ({type(exc).__name__})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Configure Alfred Calendar or Gmail OAuth locally")
    parser.add_argument("service", choices=sorted(SERVICES))
    parser.add_argument("credentials", type=Path, help="Downloaded Google Desktop OAuth client JSON")
    parser.add_argument("--env", type=Path, default=Path("/opt/alfred-node/.env"))
    args = parser.parse_args()

    config = SERVICES[args.service]
    scope = config["scope"]
    client_id, client_secret = load_client(args.credentials)
    state = secrets.token_urlsafe(32)
    port = free_port()
    redirect_uri = f"http://127.0.0.1:{port}/"

    CallbackState.code = None
    CallbackState.error = None
    server = HTTPServer(("127.0.0.1", port), callback_handler(state))
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()

    auth_url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": scope,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    })

    print(f"Authorizing Alfred {args.service} with one read-only scope.")
    print("A browser window should open. If it does not, open this URL on this Dell:")
    print(auth_url)
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass

    thread.join(timeout=300)
    server.server_close()
    if thread.is_alive():
        fail("Timed out waiting for Google authorization")
    if CallbackState.error:
        fail(f"Google authorization failed: {CallbackState.error}")
    if not CallbackState.code:
        fail("Google authorization returned no code")

    token = exchange_code(client_id, client_secret, CallbackState.code, redirect_uri)
    refresh_token = token.get("refresh_token")
    granted = token.get("scope")
    if not isinstance(refresh_token, str) or not refresh_token:
        fail("Google returned no refresh token; revoke prior test grant and retry if needed")
    granted_scopes = set(granted.split()) if isinstance(granted, str) else set()
    if scope not in granted_scopes:
        fail("Google did not grant the requested scope")

    mapping = config["env"]
    values: dict[str, str] = {}
    for env_key, source in mapping.items():
        if source == "client_id":
            values[env_key] = client_id
        elif source == "client_secret":
            values[env_key] = client_secret
        elif source == "refresh_token":
            values[env_key] = refresh_token
        else:
            values[env_key] = source

    update_env(args.env, values)
    print(f"Configured Alfred {args.service} OAuth in {args.env} without printing secrets.")
    print("Restart Core before testing the integration.")


if __name__ == "__main__":
    main()

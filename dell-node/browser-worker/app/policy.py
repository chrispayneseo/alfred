from __future__ import annotations

import hashlib
import ipaddress
import json
import socket
from urllib.parse import urlsplit

SAFE_SCHEMES = {"http", "https"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
SENSITIVE_TERMS = {
    "password", "passwd", "passcode", "pin", "otp", "2fa", "totp",
    "cvv", "cvc", "cardnumber", "card-number", "creditcard", "credit-card",
    "secret", "token", "securitycode", "security-code",
}
ALLOWED_SUBMIT_KINDS = {
    "form_submit", "reservation", "purchase", "account_change", "other",
}


class BrowserPolicyError(ValueError):
    pass


def _host_is_public(host: str, port: int | None = None) -> bool:
    if host.casefold() == "localhost" or host.casefold().endswith(".localhost"):
        return False
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_global
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(host, port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise BrowserPolicyError("Browser destination could not be resolved") from exc
    if not infos:
        raise BrowserPolicyError("Browser destination could not be resolved")
    for info in infos:
        address = info[4][0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return False
        if not ip.is_global:
            return False
    return True


def validate_public_url(url: str) -> str:
    if not isinstance(url, str) or not 1 <= len(url) <= 2048:
        raise BrowserPolicyError("Invalid browser URL")
    parsed = urlsplit(url)
    if parsed.scheme.casefold() not in SAFE_SCHEMES:
        raise BrowserPolicyError("Only public HTTP(S) URLs are allowed")
    if not parsed.hostname:
        raise BrowserPolicyError("Browser URL requires a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise BrowserPolicyError("Credentials must not be embedded in browser URLs")
    port = parsed.port or (443 if parsed.scheme.casefold() == "https" else 80)
    if not _host_is_public(parsed.hostname, port):
        raise BrowserPolicyError("Private, local and reserved network destinations are blocked")
    return url


def origin_for(url: str) -> str:
    parsed = urlsplit(validate_public_url(url))
    default_port = 443 if parsed.scheme.casefold() == "https" else 80
    port = parsed.port or default_port
    suffix = "" if port == default_port else f":{port}"
    return f"{parsed.scheme.casefold()}://{parsed.hostname.casefold()}{suffix}"


def same_origin(url: str, expected_origin: str) -> bool:
    try:
        return origin_for(url) == expected_origin.casefold().rstrip("/")
    except (BrowserPolicyError, ValueError):
        return False


def method_allowed(method: str, *, submit_mode: bool, same_target_origin: bool) -> bool:
    verb = str(method or "").upper()
    if verb in SAFE_METHODS:
        return True
    return bool(submit_mode and same_target_origin)


def validate_selector(selector: str) -> str:
    if not isinstance(selector, str) or not 1 <= len(selector) <= 300:
        raise BrowserPolicyError("Invalid browser selector")
    lowered = selector.casefold().replace("_", "").replace("-", "").replace(" ", "")
    if any(term.replace("-", "") in lowered for term in SENSITIVE_TERMS):
        raise BrowserPolicyError("Sensitive credential and payment fields are not supported")
    return selector


def validate_field_value(value: str) -> str:
    if not isinstance(value, str) or len(value) > 1000:
        raise BrowserPolicyError("Invalid browser field value")
    return value


def validate_submit_kind(kind: str) -> str:
    if kind not in ALLOWED_SUBMIT_KINDS:
        raise BrowserPolicyError("Invalid browser submission kind")
    return kind


def state_fingerprint(url: str, prepared_fields: dict[str, str]) -> str:
    payload = {
        "url": url,
        "fields": sorted((str(key), str(value)) for key, value in prepared_fields.items()),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def content_fingerprint(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()

# Phase 8 release notes

Phase 8 is a sequential release built from Phase 7 merge `94b07972478dab86ef4aa699e0133d8fe463652f`.

Deployment entrypoint: `dell-node/scripts/deploy-phase8.sh`.

The deploy script refuses to continue unless the currently installed Phase 7 live smoke passes. After installation, Phase 8 acceptance must pass before `/opt/alfred-node/.phase8-live-accepted` is written.

The Phase 8 release adds human-bootstrapped authenticated browser profiles without adding password/OTP/card/CAPTCHA inputs to Alfred and without changing the existing exact-scope browser submission approval boundary.

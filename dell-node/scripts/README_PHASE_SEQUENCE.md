# Sequential Phase 8+ deployment

Each later Alfred phase is released as an exact Git commit and includes its own `deploy-phaseN.sh` script.

Rules:

1. Run phases in numerical order.
2. Each deploy script reruns the previous phase's live smoke before changing runtime code.
3. Each phase backs up the currently installed code before replacement.
4. Each phase rebuilds only the services it changes.
5. Each phase runs its own live smoke and adversarial acceptance suite.
6. A `.phaseN-live-accepted` marker is written only after all acceptance checks pass.
7. If any command fails, the script exits before the marker is written.

This lets the repository continue moving forward while preserving a deterministic Dell installation path through each exact release SHA.

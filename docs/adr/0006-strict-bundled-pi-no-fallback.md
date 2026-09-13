# ADR-0006: Strict bundled pi only, no system fallback

- 状态：Accepted

## Context

When xyz-agent is packaged (DMG/NSIS/AppImage), it bundles a pi binary inside the app. The user may also have pi installed system-wide via npm. We need to decide whether to use only the bundled pi or fall back to the system pi if the bundled one fails.

## Decision

Use only the bundled pi binary. No fallback to system pi. If bundled binary is missing or fails, throw a fatal error.

## Reason

1. Version consistency: xyz-agent is tested and released with a specific pi version. Using a different system pi version could cause incompatibilities.
2. No dependency on user's Node.js environment: the whole point of bundling is to eliminate the "install Node.js + npm install pi" prerequisite.
3. Simpler error handling: one code path instead of fallback chains.
4. Clear upgrade path: user upgrades pi by upgrading xyz-agent.

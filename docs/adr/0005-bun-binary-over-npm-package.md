# ADR-0005: Use Bun-compiled binary instead of npm package

- 状态：Accepted

## Context

pi is available both as an npm package (`@mariozechner/pi-coding-agent`, 179MB with node_modules) and as a Bun-compiled standalone binary (70-120MB, from GitHub Release). We need to bundle pi into xyz-agent's Electron app.

## Decision

Use the Bun-compiled standalone binary from `earendil-works/pi` GitHub Release.

## Reason

1. Smaller size: ~70MB vs ~179MB (no node_modules needed)
2. No Node.js dependency: Bun runtime is embedded in the binary
3. Official support: pi's `build:binary` script produces these binaries
4. Already available for all 6 platform/arch combinations

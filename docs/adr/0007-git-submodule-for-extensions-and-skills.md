# ADR-0007: Git submodule for extension and skill dependencies

- 状态：Superseded（被 ADR-0011 取代）

## Context

xyz-agent bundles pi extensions (subagent, goal, todo) from `xyz-pi-extensions` repo and skills (19 xyz-harness skills) from `xyz-harness` repo. We need a mechanism to include these files in the build.

## Decision

Add both repositories as git submodules under `vendor/`. CI and local build scripts copy files from submodules into `resources/pi/agent/`.

## Reason

1. Version coupling: submodule pins a specific commit, making the build reproducible. We know exactly which version of extensions/skills is bundled.
2. No npm publishing overhead: these repos aren't npm packages and don't need to be.
3. Simple copy operation: extensions are ~228KB TypeScript files, skills are ~404KB Markdown files. No build step needed — just `cp -RL`.
4. Alternative (npm package) would require publishing flow that doesn't exist and adds maintenance burden for repos that aren't packages.
5. Alternative (commit directly) would cause drift and merge conflicts when extensions/skills update.

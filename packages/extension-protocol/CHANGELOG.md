# @taiji/extension-protocol

## 0.11.0

### Minor Changes

- 65a462c: First public release of `@taiji/extension-protocol` on npm. The package was previously workspace-only while `@zhushanwen/subagent-core` (and renderer consumers) declare it as a dependency, so publishing subagent-core without it would replace `workspace:*` with a range that resolves to nothing on the registry (npm install E404). Publishing at the current 0.10.0 version keeps the monorepo version line intact.

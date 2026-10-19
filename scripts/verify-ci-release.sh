#!/bin/bash
# 验证 CI 构建完成且 GitHub Release 产物完整
# Usage: bash scripts/verify-ci-release.sh <tag> [--ci-timeout N]
#   tag:         如 v0.4.7 或 v0.4.7-beta.1
#   --ci-timeout: CI 等待超时分钟数（默认 30）
#
# Exit: 0 = CI 完成 + 产物完整, 非 0 = 失败（具体见输出）
# 实现在 scripts/merge/verify-ci-release.mjs（本文件为 shim）
exec node "$(dirname "$0")/merge/verify-ci-release.mjs" "$@"

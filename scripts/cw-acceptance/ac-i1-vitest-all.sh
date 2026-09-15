#!/usr/bin/env bash
# ac-i1-vitest-all.sh — 根验收 AC-I1 包装：runtime 全量回归零失败
# （根 spec plugin-trust-hardening AC-I1，命令冻结：bash scripts/cw-acceptance/ac-i1-vitest-all.sh）
#
# 干净 checkout 自含 pnpm install 后 `packages/runtime` 全量 vitest 零失败。
# 末行输出 `AC-I1 PASS`/`AC-I1 FAIL` 标记行（cw e2e-sh 判定协议），exit code 与
# 标记一致。install 失败路径同样输出 FAIL 标记（不静默崩溃）。
#
# 注意：不用 `set -e`——子命令失败必须落到 FAIL 标记行输出，不能中途退出。

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! (cd "$REPO_ROOT" && pnpm install --prefer-offline --silent); then
  echo "[AC-I1] pnpm install 失败（cwd=${REPO_ROOT}）" >&2
  echo "AC-I1 FAIL"
  exit 1
fi

if (cd "$REPO_ROOT/packages/runtime" && npx vitest run); then
  echo "AC-I1 PASS"
  exit 0
else
  echo "AC-I1 FAIL"
  exit 1
fi

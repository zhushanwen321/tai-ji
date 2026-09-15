#!/usr/bin/env bash
# ac-i3-typecheck.sh — 根验收 AC-I3 包装：类型检查与 extensions 零回归
# （根 spec plugin-trust-hardening AC-I3，命令冻结：bash scripts/cw-acceptance/ac-i3-typecheck.sh）
#
# `packages/runtime` 的 `npx tsc --noEmit` 与仓库根 `pnpm extensions:typecheck`
# 双零错误（plugin-sdk types 变更波及面受控）。自含 install，末行输出
# `AC-I3 PASS`/`AC-I3 FAIL` 标记行，exit code 与标记一致。
#
# 注意：不用 `set -e`——子命令失败必须落到 FAIL 标记行输出，不能中途退出。

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! (cd "$REPO_ROOT" && pnpm install --prefer-offline --silent); then
  echo "[AC-I3] pnpm install 失败（cwd=${REPO_ROOT}）" >&2
  echo "AC-I3 FAIL"
  exit 1
fi

FAILED=0

if ! (cd "$REPO_ROOT/packages/runtime" && npx tsc --noEmit); then
  echo "[AC-I3] packages/runtime tsc --noEmit 失败" >&2
  FAILED=1
fi

if ! (cd "$REPO_ROOT" && pnpm extensions:typecheck); then
  echo "[AC-I3] pnpm extensions:typecheck 失败" >&2
  FAILED=1
fi

if [ "$FAILED" -eq 0 ]; then
  echo "AC-I3 PASS"
  exit 0
else
  echo "AC-I3 FAIL"
  exit 1
fi

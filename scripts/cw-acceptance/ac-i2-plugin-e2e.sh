#!/usr/bin/env bash
# ac-i2-plugin-e2e.sh — 根验收 AC-I2 包装：插件 E2E 基线通过
# （根 spec plugin-trust-hardening AC-I2，命令冻结：bash scripts/cw-acceptance/ac-i2-plugin-e2e.sh）
#
# 真实 fork 子进程 + 真实 ESM loader + 真实 activator 链路（SEC-A1~A5 场景）。
# 包装层自含 install（幂等，verify-plugin-e2e.sh 内部亦有同款自举），调用
# scripts/verify-plugin-e2e.sh，基于其退出码在末行输出 `AC-I2 PASS`/`AC-I2 FAIL`
# 标记行并透传退出码。内部场景明细行（SEC-XX PASS/FAIL 等）由 verify-plugin-e2e.sh
# 原样输出，包装层不吞不改。
#
# 注意：不用 `set -e`——子命令失败必须落到 FAIL 标记行输出，不能中途退出。

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! (cd "$REPO_ROOT" && pnpm install --prefer-offline --silent); then
  echo "[AC-I2] pnpm install 失败（cwd=${REPO_ROOT}）" >&2
  echo "AC-I2 FAIL"
  exit 1
fi

if bash "$REPO_ROOT/scripts/verify-plugin-e2e.sh"; then
  echo "AC-I2 PASS"
  exit 0
else
  echo "AC-I2 FAIL"
  exit 1
fi

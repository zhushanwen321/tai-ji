#!/usr/bin/env bash
# red-phase-guard.sh — cw e2e 脚本共用的红阶段守卫（scripts/cw/lib/）
#
# 用法：source "$(dirname "$0")/../lib/red-phase-guard.sh"（在设置 PROJECT_ROOT 后）
# 效果：实现产物缺失/不含目标类时以非零退出（cw verify 红阶段区分力检查）
#
# 参数（可选）：$1 = 实现文件相对路径（默认 session-manager handler）；$2 = 类名（默认 SessionManagerHandler）

red_phase_guard() {
  local impl_rel="${1:-packages/runtime/src/transport/session-manager-handler.ts}"
  local class_name="${2:-SessionManagerHandler}"
  local impl="$PROJECT_ROOT/$impl_rel"

  if [ ! -f "$impl" ]; then
    echo "ERROR: $impl_rel not found — implementation missing (red phase guard)" >&2
    exit 1
  fi

  # 验证实现文件包含目标类（区分力：基线代码树即使有文件也不会有这个类）
  if ! grep -q "class $class_name" "$impl"; then
    echo "ERROR: $class_name class not found in implementation — red phase guard" >&2
    exit 1
  fi
}

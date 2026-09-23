#!/usr/bin/env bash
# =============================================================================
# check-domain-boundaries.sh —— renderer-rebuild-v2 全域铁律 gate（FR7/AC10/AC11 终验收）
#
# 检查内容（两条铁律，机器 gate 而非手工 review）：
#
# 1. AC10 跨域 import 铁律（core/src/domain 下各域目录内部）：
#    - domain/<域A> 下任何文件不得 import domain/<域B>（B≠A）的内部模块，
#      包名路径（@taiji/core/domain/<域>/<模块>）与相对路径（resolve 后落
#      入其他 domain 下各域目录）双查。
#    - 合法形态：'@taiji/core'（包入口 index.ts）与
#      '@taiji/core/domain/<域>'（单层，域 index.ts 公开 API）。
#      相对路径跨域一律违规（即使目标是别的域 index.ts——跨域必须走公开 API 形态）。
#    - core 包内非 domain 层（foundation/coordination/platform）不受本规则约束
#      （domain 向下依赖基础设施层是合法方向）。
#
# 2. AC11 per-session 状态分区铁律（core/src 全域）：
#    - per-session 状态必须经 useSessionScopedState 分区（ADR-0049），
#      禁止 reset*ModuleState 手动清空派 / watch(sessionId) 显式清空派。
#    - 显式 allowlist（非 per-session 或非清空派形态）：
#      * coordination/presence.ts + coordination/lease.ts —— 全局协同态占位
#        （C4 deferred，§4.2 显式全局例外，非 per-session 状态）
#      * *ForTest 测试隔离 reset（resetChatModuleStateForTest 等）—— 测试隔离，
#        非生产清空派
#      * watch(sessionId) 订阅重订形态（watch 仅触发重订阅/刷新，不持有
#        per-session 业务状态，如 useSessionEvents 类编排）—— 见 AC11_ALLOWLIST
#
# 用法：bash scripts/check-domain-boundaries.sh
# 退出码：0 = 通过；1 = 存在违规（打印 文件:行 + 原因）。
# 可被 pre-commit / CI 调用。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# -----------------------------------------------------------------------------
# AC11 allowlist：watch(sessionId) 订阅重订/刷新形态白名单（相对 ROOT 的文件路径，
# 命中即豁免清空派检查；新增豁免必须在此登记 + 文件内注释说明为什么不是清空派）。
#
# 扫描范围说明：AC10 扫 core/src/domain 下各域目录；AC11 扫 core/src 全域。
# renderer 侧 watch(sessionId)（useSessionEvents/useExtensionUI 订阅重订、
# useChatViewDeps）不在本 gate 扫描范围——由各自域 wave 迁移后归位。
#
# 全局态例外（§4.2 显式全局例外，非 per-session 状态，不适用分区要求，
# 即使未来被扫描到也显式豁免）：core/src/coordination/presence.ts（全局协同态
# 占位，C4 deferred）、core/src/coordination/lease.ts（TTL 管控占位，C4 deferred）。
# 2026-08-04 审计：core/src 全域零 watch(sessionId)、零 reset*ModuleState（非
# ForTest），AC11 当前零违规，allowlist 为空为结构预留。
# composer/model-thinking.ts（2026-09-20 R1 评审登记）：「换绑清」语义——armed 意图
# token 是会话级单值（非 per-session 分区态），watch(sessionId) 换绑即作废全部未消费
# 意图（安全侧语义，u3·D3 规则 6）；迁 useSessionScopedState 分区会改为「按 session
# 保留」，换绑回原 session 时意图复活——行为回退，故显式豁免。
# -----------------------------------------------------------------------------
AC11_WATCH_ALLOWLIST=(
  "packages/core/src/domain/composer/model-thinking.ts"
)

node "$ROOT/scripts/check-domain-boundaries-node.mjs" "${AC11_WATCH_ALLOWLIST[@]}"

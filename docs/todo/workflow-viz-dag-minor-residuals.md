# workflow-viz DAG 布局打磨 minor 残余（4 条，随分支带走）

状态：开放（minor 档，不阻塞合并；终局 PR 期复核）。来源：dev-merge branch-review review-fix-loop run wf-1792073055433-g3dxvf（分支 fix-workflow-graph，R2-R4 三轮 reviewer 全员 clean、must-fix MF-1 已修，4 条 suggestion 未派修延续至清单）。

## 残余清单

1. **fit 容器尺寸竞态**（`packages/renderer/src/components/panel/workflow-viz/dag/WorkflowVizDag.vue`）：`fitView()` 在容器尺寸未就绪时（overlay 刚挂载、布局未稳定）可能按过渡态尺寸计算变换。修复方向 = fit 前确认容器尺寸就绪（ResizeObserver 首回调或 rAF 双帧后执行）。
2. **fit 不追打策略**（同文件）：dag 结构变化时重复 fit 会打断用户手动缩放/平移——需要「仅首次 fit + 用户操作后不再自动 fit」的策略收敛。
3. **同列垂直 sequence 边折线穿卡片**（`packages/renderer/src/components/panel/workflow-viz/dag/layout.ts`）：同列相邻节点的垂直边走中位竖线时可能穿过中间增高节点（实例行增高后暴露）。修复方向 = 垂直边路由对途经节点 x 区间做避让侧道。
4. **callId 未命中回退 `calls?.[0]`**（`packages/renderer/src/components/panel/workflow-viz/overlay/WorkflowVizOverlayHost.vue`）：实例行点击上抛的 callId 在 byNode 清单未命中时回退取首个 call，应显式空态（no-op）而非静默换目标。

## 关联工具缺陷（已修复）

review-fix-loop workflow 的 state 对账缺陷：聚合器把「延续未修」条目写成无 title/severity 的空壳（state.json S-1/S-2/S-3/S-5），后续 clean 轮 reconcile 无法匹配关闭 → 连续 3 轮 clean 后误判 stuck 终态。已修复（2026-10-23，双版本单源化收编）：zcode 版延续条目无条件字段覆盖改为 `inheritCarryoverFields`（title 锁定 + severity 采信显式）+ `refreshTrackedFields`（内容字段非空刷新），实装在 `packages/subagent-core/workflows/src/review-fix-loop.shared.ts`（双平台产物共用单源段，经 `pnpm build:workflows` 构建拼入两侧）；pi 内置版同款修复先于此（inheritCarryoverFields，utils 旧实装）已上线。

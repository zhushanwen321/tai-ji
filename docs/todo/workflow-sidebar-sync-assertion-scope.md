# workflow-sidebar-sync.spec.ts 断言范围确认（ui-optimize-unified e2e 影响面评估③）

- 状态：已确认（2026-10-08 终态同步补记）——结论 = 无需扩断言范围，不建新 e2e
- 背景义务：ui-optimize-unified 设计 §4「e2e 影响面评估③」要求 `e2e/workflow-sidebar-sync.spec.ts` 随批确认断言范围是否需扩（U15 侧栏双模式触及 sidebar 组件，该 spec 登记 scope 含 `packages/renderer/src/**` 可命中）；执行期未落确认记录，本文件补记结论
- 确认依据（亲自读 spec 断言范围核实）：该 spec 三个用例 T1/T2/T3 全部断言 workflow 托盘同步跨进程链路（T1 演员清单托盘分桶挂载 / T2 切无数据 session 条目摘除 / T3 面板行点开 workflow overlay），与 U15 侧栏双模式（平铺/目录分组、区头开关、hover 详情卡）无交集——spec 内无 sidebar 列表形态断言
- 双模式覆盖载体：`packages/renderer/src/__tests__/sidebar/session-list-dual-mode.test.ts` 单测（默认平铺 / 切换持久化 / 选中同步 / hover 详情卡字段），符合设计「优先单测」路径；侧栏形态视觉面由 E2E-VISUAL-01 像素对比层 shell 基线（U19 重录，含区头/双模式开关形态）承载
- 复核触发：后续若 workflow 托盘行为与 sidebar 列表形态产生交互断言需求（如托盘条目定位到分组行），再评估扩大范围

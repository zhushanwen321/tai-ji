# workflow-viz DAG 布局打磨 minor 残余（4 条，随分支带走）

状态：设计完成（2026-10-23 裁决立项 → 设计产物 `.tmp/need-design-batch/workflow-viz-fit-and-routing-design.md`，待实施排期；设计期待裁决项见文末）。残余 1、4 已入 just-do-it 条目 59/60。来源：dev-merge branch-review review-fix-loop run wf-1792073055433-g3dxvf（分支 fix-workflow-graph，R2-R4 三轮 reviewer 全员 clean、must-fix MF-1 已修，4 条 suggestion 未派修延续至清单）。

## 残余清单

1. **fit 容器尺寸竞态**（`packages/renderer/src/components/panel/workflow-viz/dag/WorkflowVizDag.vue`）：`fitView()` 在容器尺寸未就绪时（overlay 刚挂载、布局未稳定）可能按过渡态尺寸计算变换。修复方向 = fit 前确认容器尺寸就绪（ResizeObserver 首回调或 rAF 双帧后执行）。
2. **fit 不追打策略**（同文件）：dag 结构变化时重复 fit 会打断用户手动缩放/平移——需要「仅首次 fit + 用户操作后不再自动 fit」的策略收敛。设计期核实：现行装配下 `watch(dag)` 不可达（挂载条件保证引用替换必先卸载组件走 onMounted），watch 属防御代码但组件契约层可达（`setProps` 直接触发，`workflow-viz-dag.test.ts:252` 先例）——正是本条风险点。设计 = `viewMode: 'fit'|'free'` 二态状态机 + 用户接管事件 7 条裁决（pointerdown 未移动不算、pan moved / wheel 算、程序化写视口结构性排除）+ ResizeObserver pending-fit；「回到全景」入口推荐提供（待裁决）。
3. **跨列不同行边通道中位竖线穿卡片**（`packages/renderer/src/components/panel/workflow-viz/dag/layout.ts`）。设计期修正登记描述：原登记「同列垂直 sequence 边穿卡」与实码不符——同列边行走列右缘细道（`layout.ts:442-457`）不穿卡；真正穿卡的是跨列不同行边（channeled 分支）的通道中位竖线（`layout.ts:472` `laneX=(x1+x2)/2`，隔列边中位可落在中间列节点带内），车道铺开 ≥11 游程越界为第二场景。设计 = 通道级「竖线整体迁移到最近安全空隙」（折点结构不变、无障碍零扰动）。
4. **callId 未命中回退 `calls?.[0]`**（`packages/renderer/src/components/panel/workflow-viz/overlay/WorkflowVizOverlayHost.vue`）：实例行点击上抛的 callId 在 byNode 清单未命中时回退取首个 call，应显式空态（no-op）而非静默换目标。
5. **跨列同行直线边横穿中间列节点**（设计期新发现，2026-10-23）：y 相同的同行节点间直线边可横穿中间列节点（与残余 3 同族不同分支——直线分支无通道）。未纳入本次设计（设计边界只覆盖 channeled 分支），待与残余 3 同批或另行处置。

## 设计期待裁决项

- 「回到全景」入口（free 态右下角按钮）采纳与否——设计推荐提供。
- 残余 5 的处置批次（并入残余 3 实施批 or 另行）。
- 登记描述偏差的真机对拍（原观察形态与实码分支的对照确认）。

## 关联工具缺陷（登记备查）

review-fix-loop workflow 的 state 对账缺陷：聚合器把「延续未修」条目写成无 title/severity 的空壳（state.json S-1/S-2/S-3/S-5），后续 clean 轮 reconcile 无法匹配关闭 → 连续 3 轮 clean 后误判 stuck 终态。实质审查已收敛（R4 报告明确 must-fix 无、4 条为 minor 延续项）。修复方向 = 聚合器延续条目继承上轮 title/severity 字段。

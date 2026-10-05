# workflow trace 表状态列与 DAG 节点的双色分歧（存量呈现分歧）

状态：未修（登记不修——修复要动 `RunTraceTable` 的 dotClass 映射与 DAG tone 派生，超出 workflow-overlay-refine 布局设计边界；该设计只保证「图例 = DAG 的图例」）。登记来源：workflow-overlay-refine 设计 D4（走查 W-3）+ §3.3 D9 同族登记纪律

## 分歧明细

`RunTraceTable` 的状态 dot 映射与 `WorkflowVizDagNode` 的 tone 映射各自独立，同一 run 状态在两处呈现不一致：

1. **retrying**：DAG = warn 色；表格状态 dot = accent 色。
2. **skipped**：DAG 有色有词；表格无词无色。
3. **pending**：透明度两处不一。

## 影响面

workflow 运行态浮层中，用户对照「DAG 节点色 ↔ 表格状态 dot」解码 run 状态时，retrying / skipped / pending 三态的视觉词汇不同源。workflow-overlay-refine D4 落地的新图例以 DAG tone 映射为单一事实源（图例 = DAG 的图例），不覆盖表格侧——三处分歧保持现状，图例不能当作表格状态列的解码表。

## 修复方向（待立项时参考）

把状态 → 视觉词汇（色 + 词）的映射收敛为单一事实源，DAG tone、表格 dotClass、图例三方共同消费；词走 i18n 既有状态词族（skipped 现无 i18n 词条，需新增）。修复属 workflow-viz 域的语义统一，非纯样式改动——须核对两处映射各自的消费方与测试断言面。

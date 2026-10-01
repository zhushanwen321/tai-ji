# plan 面 data-testid 清单（PlanModeBar / PlanReviewBar / PlanDocsPanel / PlanCommentPopover）

> 口径：testid 以组件 template 内 `data-testid` 属性为准（手册总则 [00-overview.md](./00-overview.md)）。
> 覆盖面 = `packages/renderer/src/components/panel/plan/` 四组件；消费测试 =
> `packages/renderer/src/__tests__/{components,stores,composables}/plan-*` 族（资产登记见
> [e2e-map.json](./e2e-map.json) E2E-MOCK-02）。本账随 plan 模式状态机显式化 U4b 建立
> （2026-09-24）：该批次首次对 plan 面 testid 做新增/更名/退役，按同 commit 纪律建账并留变更登记。
> 改 testid 必同步本表 + 清扫指向已删 testid 的悬空引用（负向守卫断言除外，见文末登记）。

## 1. PlanModeBar.vue（计划模式状态带，Panel composer 下方常驻行）

| testid | 触发/可见条件 |
|--------|---------------|
| `plan-mode-bar` | 整行根节点；isActive=true 时渲染（false 时整行无 DOM） |
| `plan-mode-bar-title` | 左区模式名「计划模式」（常驻行内） |
| `plan-mode-bar-skills` | D7① 技能 chips（至多 2 枚 + +n 溢出计数）；view.skills 空/缺失不渲染。**新增（U4b）** |
| `plan-mode-bar-skills-list` | chips 点击 Popover 的全量技能名列表（Portal 到 body，开合时可见）。**新增（U4b）** |
| `plan-mode-bar-stage` | 三步阶段指示（①需求探索/②文档撰写/③审阅确认；approved 档三步全对勾） |
| `plan-mode-bar-exit` | 左区「退出」按钮（常驻；唯一退出入口） |
| `plan-mode-bar-exit-confirm` | 退出确认 Popover 容器（Portal；点退出后打开） |
| `plan-mode-bar-exit-warn-revising` | 确认层警示：revising 态（agent 侧修订将中止） |
| `plan-mode-bar-exit-warn-drafts` | 确认层警示：有评论草稿（N 条将丢弃） |
| `plan-mode-bar-exit-cancel` | 确认层「取消」 |
| `plan-mode-bar-exit-confirm`（按钮） | 确认层「确认退出」（与容器同名 testid，点击发 session.abortPlan） |
| `plan-mode-bar-error` | 退出命令失败错误行（E9 就近呈现） |
| `plan-mode-bar-load-error` | 首拉/冷拉失败错误行（分区 loadError） |

## 2. PlanReviewBar.vue（审批条，PlanModeBar 行内右区；D4 分支公式单源）

分支公式：ready ⇔ 挂起 planReview 注册表（presence 语义，恒优先）/ revising ⇔ state=revising /
degraded ⇔ state=reviewing ∧ 无挂起 ∧ 稳定窗放行（2s 持续或冷拉真值豁免）；已应答抑制窗压
degraded/revising；dispatching/approved 与其余不渲染。

| testid | 触发/可见条件 |
|--------|---------------|
| `plan-review-bar` | 右区根节点；mode ∈ {ready, revising, degraded} 时渲染 |
| `plan-review-summary` | ready：评论草稿计数键（0 草稿不渲染——D13⑦）；点击回看草稿 |
| `plan-review-self-review` | ready：agent 自审结论行（截断展示，点击 Popover 看全文）；请求无 selfReview 不渲染（D9③）。**新增（U4b）** |
| `plan-review-self-review-full` | 自审结论 Popover 全文层（Portal；开合时可见）。**新增（U4b）** |
| `plan-review-revise` | ready：「提交评论并要求修订」（0 草稿禁用） |
| `plan-review-approve` | ready：「确认并执行」 |
| `plan-review-dismiss` | ready：「搁置」（D3 协议级 dismiss 决策，respond 通道）。**更名（U4b）← `plan-review-ignore` 退役** |
| `plan-review-revising` | revising 分支：「修订中」状态行 |
| `plan-review-degraded` | degraded 分支（稳定窗放行后） |
| `plan-review-degraded-reason` | degraded 成因行（resumeHint 分源文案） |
| `plan-review-resubmit` | degraded：「重新提交审批」按钮（消息发送通道注入固定文案，D8）。**新增（U4b）** |
| `plan-review-resubmit-error` | 重新提交发送失败就近错误行。**新增（U4b）** |

## 3. PlanDocsPanel.vue（drawer 计划产物 tab）

| testid | 触发/可见条件 |
|--------|---------------|
| `plan-docs-pending-active` | isActive 且 docs 空、agent 推进中 |
| `plan-docs-pending-idle` | isActive 且 docs 空、agent 未推进 |
| `plan-docs-empty` | 无 plan/产物的空态（含「输入 /plan 开始规划」指引） |
| `plan-docs-load-error` | 计划状态首拉失败（分区 loadError）空态 |
| `plan-docs-panel` | 面板主容器（有 docs 时） |
| `plan-docs-tabs` / `plan-docs-tab` | L2 文档 tab 行 / 单 tab |
| `plan-docs-tab-version` / `plan-docs-tab-revising` | tab 版本角标 / 修订中角标 |
| `plan-docs-meta` / `plan-docs-meta-skill` / `plan-docs-meta-version` / `plan-docs-meta-revising` | 文档 meta 行 / 来源技能 chip / 版本 / 修订中徽标 |
| `plan-docs-body` / `plan-docs-content-area` | 正文滚动区 / 划选评论目标内容区 |
| `plan-docs-error` / `plan-docs-loading` / `plan-docs-content` | 正文三态：文件缺失占位 / 加载中 / 正文 |
| `plan-comment-drafts` / `plan-comment-draft-item` / `plan-comment-draft-delete` | 评论草稿列表（>0 渲染）/ 单条 / 删除 |

## 4. PlanCommentPopover.vue（划选评论浮条）

| testid | 触发/可见条件 |
|--------|---------------|
| `plan-comment-trigger` | 文档内容区划选后的「评论」触发钮 |
| `plan-comment-popover` / `plan-comment-editor` / `plan-comment-quote` / `plan-comment-input` | 评论编辑浮层 / 编辑器容器 / 划选引文 / 评语输入 |
| `plan-comment-save` / `plan-comment-cancel` | 添加评论 / 取消 |

## 5. 变更登记

**[2026-09-24 plan-mode-state-machine U4b]**（更名/新增/退役逐条，以四组件 template 现值对齐）：

- **更名**：`plan-review-dismiss` ← `plan-review-ignore` 退役（D3「忽略=杀 turn」→「搁置=respond dismiss 决策」，非破坏）。
- **新增**：`plan-review-resubmit`、`plan-review-resubmit-error`（D8 降级态可行动化）；
  `plan-review-self-review`、`plan-review-self-review-full`（D9③ 自审结论行）；
  `plan-mode-bar-skills`、`plan-mode-bar-skills-list`（D7① 技能 chips）。
- **退役（源码零命中）**：`plan-review-ignore`、`plan-review-ignore-error`（搁置不经 message.abort，无 abort 失败错误行）；
  `plan-review-degraded-hint`（D8 改「成因 + 按钮」，恢复指引小字删除）。
- **更早已退役（本账建账前已不存在，防清扫误判）**：`plan-review-degraded-exit`（退出入口收敛左区）、
  `plan-review-explain`（解释键随 2026-09-21 两键裁决删除）、`plan-banner`（挂载已拆除）。
- **负向守卫断言登记（引用退役键但断言不存在，不是悬空引用，清扫时勿删）**：
  `plan-mode-bar.test.ts`（`plan-review-degraded-exit` / `plan-review-ignore` / `plan-review-explain` 的 exists()=false）、
  `plan-review-bar.test.ts`（`plan-review-ignore` / `plan-review-degraded-exit` 的 exists()=false）——锚定退役键不复活。

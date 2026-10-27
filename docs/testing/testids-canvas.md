# canvas 面 data-testid 清单（CanvasPane / CanvasGraph / CanvasNodeCard / CanvasNodeDetail / CanvasDetailPanel / CanvasArgStrip / CanvasReviewPanel / CanvasExportPanel / CanvasOpDialog / CanvasBindingBadge / TrayCanvasPanel）

> 口径：testid 以组件 template 内 `data-testid` 属性为准（手册总则 [00-overview.md](./00-overview.md)）。
> 覆盖范围 = `packages/renderer/src/components/canvas/` 十个组件 + `packages/renderer/src/components/panel/tray/TrayCanvasPanel.vue`；消费测试 =
> `packages/renderer/src/components/canvas/*.test.ts` 四件 + `src/components/panel/tray/__tests__/tray-widget-bundle.test.ts` + `src/stores/canvas.test.ts` +
> `src/composables/use-canvas-sync.test.ts` + overlay 两件（资产与触发范围登记见 [e2e-map.json](./e2e-map.json) E2E-CANVAS-01）。
> 本账随 problem-solve-canvas D5 终态同步建立（2026-10-15，登记类批次 F1-27）：设计 §3.1(3) UI 规范要求 testid 全量登记，
> 建账前 docs/testing 零 canvas 条目。建账实测：模板共 103 处 data-testid（81 静态 + 22 动态绑定），去重 100 个唯一值，
> 前缀纪律 canvas-* / tray-canvas-* 实测 100/100（下表 99 行：`canvas-zoom-in` / `canvas-zoom-out` 合用一行）；其中 33 个值有模块单测断言、67 个仅登记未断言（断言覆盖随各组件测试增量补齐）。
> 改 testid 必同步本表 + 清扫指向已删 testid 的悬空引用。

## 1. CanvasPane.vue（画布 tab 内容根组件；WorkflowVizOverlay canvas body 分支异步挂载）

| testid | 触发/可见条件 |
|--------|---------------|
| `canvas-pane` | 整面板根节点（CanvasPane 挂载即渲染） |
| `canvas-pane-header` | 头部工具条（画布名 + 阶段徽标 + 绑定徽标 + 方向徽标 + 三动作钮，常驻） |
| `canvas-pane-title` | 画布名标题（state.name，截断展示） |
| `canvas-phase-badge` | 阶段徽标（生长中/审查中/已收敛，canvasPhaseOf 派生；`:data-phase` 同源） |
| `canvas-direction-badge` | 方向裁决徽标（state.direction 存在才渲染；title = 裁决理由） |
| `canvas-direction-action` | 头部「方向裁决」按钮（开 decide-direction 操作对话框） |
| `canvas-review-action` | 头部「发起审查」按钮（mutate review-request，actor=user） |
| `canvas-converge-action` | 头部「确认收敛」按钮（converged=true 时禁用并切「已收敛」文案） |
| `canvas-pane-error` | 首次拉取失败错误态（loadError 非空且 state 空） |
| `canvas-pane-retry` | 错误态「重试」按钮（重发 loadCanvas + listCanvases） |
| `canvas-pane-loading` | 加载中态（state 空且无 loadError） |

## 2. CanvasGraph.vue（图渲染视口：transform 视口 > SVG 边层 + 节点卡树 + 底部约束带）

| testid | 触发/可见条件 |
|--------|---------------|
| `canvas-viewport` | transform 视口根（wheel 缩放 / 拖拽平移 / 空白单击取消选中） |
| `canvas-plane` | 布局平面（translate+scale 变换层，节点卡与边层的承载） |
| `canvas-edges-svg` | SVG 边层（主干 decompose/resolve 边 + 支撑度缺口/不成立线上标记） |
| `canvas-edge-${e.type}` | 单条主干边（decompose / resolve 两值；`:data-edge-id` 同源；点击选中边目标） |
| `canvas-constraint-band` | 底部约束带（constraint 节点 >0 才渲染——约束节点不进主干流） |
| `canvas-zoom-controls` | 右下缩放控制组（放大 / 缩小 / 适应视图三钮） |
| `canvas-zoom-in` / `canvas-zoom-out` | 以视口中心放大 / 缩小（档位 [0.28, 1.6]） |
| `canvas-fit-view` | 手动适应视图（点击后视口归用户接管，不再自动适配） |

## 3. CanvasNodeCard.vue（主干节点卡：question / option；纯展示，交互上抛）

| testid | 触发/可见条件 |
|--------|---------------|
| `canvas-node-${node.type}` | 节点卡根（question / option 两值；`:data-node-id` / `:data-lifecycle` / `:data-selected` / `:data-dirty` 同源） |
| `canvas-node-recheck-badge` | 待重审角标（dirtyPaths 成员才渲染——门禁③「待重审=空」的可感知通道） |
| `canvas-node-comments-badge` | 评论计数气泡（commentCount>0；有待响应评论时 warn 醒目） |
| `canvas-node-status-dot` | 生命周期状态点（色与描边随 lifecycle） |
| `canvas-node-title` | 节点内容标题（rejected 态删除线） |
| `canvas-node-rejected-chip` | 否决折叠 chip（rejectedKids>0；折叠不消失，保留展开入口与计数） |
| `canvas-node-dispatched-badge` | 已派发徽标（node.dispatch 存在；title = 下游产物指针） |
| `canvas-node-dispatch-button` | 派发按钮（执行叶子 + passed + 未派发；上抛 dispatch 意图） |

## 4. CanvasArgStrip.vue（节点卡框内论据条：支持 / 反对两横框）

| testid | 触发/可见条件 |
|--------|---------------|
| `canvas-arg-strip-${polarity}` | 论据条容器（support / object 两值，随极性着色） |
| `canvas-arg-row` | 单条论据行（超 4 条折叠计数；点击选中论据） |
| `canvas-arg-verified-${ok\|unknown}` | fact 论据核实角标（ok=已核实 / unknown=未核实——未核实不算数） |

## 5. CanvasDetailPanel.vue（右侧详情面板：节点详情 / 审查报告 / 导出三 tab）

| testid | 触发/可见条件 |
|--------|---------------|
| `canvas-detail-panel` | 面板容器（宽 340px 固定，三 tab 内容区） |
| `canvas-detail-tabs` | 三 tab 行（detail / review / export） |
| `canvas-detail-tab-${seg.value}` | 单 tab 按钮（detail / review / export 三值） |
| `canvas-review-tab-count` | 审查 tab 的未处置 must-fix 计数徽标（>0 才渲染） |

## 6. CanvasNodeDetail.vue（详情面板·节点详情 tab）

| testid | 触发/可见条件 |
|--------|---------------|
| `canvas-node-detail` | 节点详情 tab 根 |
| `canvas-detail-empty` | 空态引导（未选中节点时的操作指引） |
| `canvas-detail-title` | 节点内容标题 |
| `canvas-root-criteria` | 根节点完成判据行（isRoot；逐条，确认态变色） |
| `canvas-root-criteria-mark` | 判据行首确认标记点（root.confirmed 决定填充 / 描边） |
| `canvas-detail-selected` | 方案选定状态区（option 且 selected；附对比理由） |
| `canvas-leaf-criteria` | 执行叶子判据行（dispatchable 节点；逐条） |
| `canvas-detail-dispatched` | 已派发指针区（node.dispatch 存在；pointer 等宽展示） |
| `canvas-detail-argument` | 论据属性区（argument 节点：极性 × 素材性 × 核实 + 锚定与互驳） |
| `canvas-detail-fact-verified` | fact 核实徽标（materiality=fact；已核实 / 未核实两态） |
| `canvas-detail-transitions` | 生命周期转移菜单（契约合法转移表枚举；根不渲染） |
| `canvas-transition-to-${tr.to}` | 单个转移按钮（under-review / passed / rejected / shelved / draft 五目标值） |
| `canvas-detail-actions` | 用户操作链入口区（选定 / 编辑 / 判据 / 评论 / 派发，按节点类型条件渲染） |
| `canvas-action-select` | 「选定」按钮（option 且未选定） |
| `canvas-action-edit` | 「编辑」按钮（全类型节点） |
| `canvas-action-criterias` | 「判据」按钮（dispatchable 节点） |
| `canvas-action-comment` | 「评论」按钮（全类型节点） |
| `canvas-action-dispatch` | 「派发」按钮（执行叶子 + passed + 未派发） |
| `canvas-detail-comments` | 评论块（锚定评论 + agent 响应留痕，只读） |
| `canvas-comment-${c.status}` | 单条评论（按 status 分值；无响应时 pending 显式标注） |

## 7. CanvasReviewPanel.vue（详情面板·审查报告 tab）

| testid | 触发/可见条件 |
|--------|---------------|
| `canvas-review-panel` | 审查报告 tab 根 |
| `canvas-review-empty` | 空态（review===null；附发起审查按钮） |
| `canvas-review-request` | 「发起审查」按钮（空态首发起 / 有报告再发起两处同值） |
| `canvas-review-status` | 审查状态徽标（in-progress / converged / max-rounds / escalated / stuck 五终态族） |
| `canvas-review-stop-note` | 停回说明（非 converged 终态必附） |
| `canvas-review-recover-hint` | 恢复动作提示（recoverHint 存在才渲染） |
| `canvas-review-round-${group.round}` | 轮次分组区（按 round 倒序——最新轮次顶置） |
| `canvas-review-entry` | 审查条目（`:data-severity` 同源；含 severity 徽标 / 维度 / 处置态） |
| `canvas-review-entry-resolved` | 已处置徽标（first-writer-wins；title 含归属与处置说明） |
| `canvas-review-resolve-${entry.id}` | 未处置条目的「处置」按钮（user 直接处置 = review-resolve，actor=user） |

## 8. CanvasExportPanel.vue（详情面板·导出 tab：收敛门禁 + 导出解锁 + 执行清单）

| testid | 触发/可见条件 |
|--------|---------------|
| `canvas-export-panel` | 导出 tab 根 |
| `canvas-export-gates` | 收敛门禁区（三格派生视图 + 拒绝呈现 + 解锁提示） |
| `canvas-gate-${gate.key}` | 单格门禁（root / readiness / clean 三值；`:data-gate` = ok / blocked） |
| `canvas-export-blockers` | 门禁区阻断清单块（CanvasState.convergenceBlockers 非空时渲染——导出前逐项可见缺口；缺字段 = marker 通道形态不渲染） |
| `canvas-export-blocker` | 阻断清单单条（每条 = runtime convergenceBlockers 一项，就绪类与待重审类混合） |
| `canvas-export-rejection` | 最近一次未收敛拒绝（错误码 + 恢复动作文案，converge-check / export 失败臂） |
| `canvas-export-unlocked` | 导出解锁提示（state.converged=true） |
| `canvas-export-planning` | 「导出规划文档」按钮（converged 解锁；时点快照语义） |
| `canvas-export-leaf-select` | 需求卡叶子选择器（passed 叶子候选；有候选才渲染） |
| `canvas-export-leaf-${leaf.id}` | 选择器的叶子选项（逐叶子） |
| `canvas-export-requirement` | 「导出需求卡」按钮（选中叶子 + converged） |
| `canvas-execution-empty` | 执行清单空态（无执行叶子） |
| `canvas-execution-leaf` | 执行清单行（实时派生视图；`:data-lifecycle` 同源） |
| `canvas-execution-dispatched` | 行内已派发指针呈现（title = 完整指针） |
| `canvas-execution-dispatch-${leaf.id}` | 行内派发按钮（passed 且未派发的执行叶子） |

## 9. CanvasOpDialog.vue（画布用户操作对话框：九类操作单实例，规格驱动）

| testid | 触发/可见条件 |
|--------|---------------|
| `canvas-op-dialog` | 对话框容器（选定 / 否决 / 转移 / 评论 / 编辑 / 判据 / 处置 / 派发 / 方向裁决共用一个实例） |
| `canvas-op-replace-hint` | 换选前置告知（select 迁移语义：旧选定子树将进入待重审——D9） |
| `canvas-op-field-${field.key}` | 规格字段控件（textarea / criterias / select / input 四渲染分支同值；`:id` 同源） |
| `canvas-op-option-${opt.value}` | select 字段的选项（逐选项） |
| `canvas-op-required-error` | 必填缺失错误行（提交时校验，不发放行） |
| `canvas-op-cancel` | 「取消」按钮 |
| `canvas-op-submit` | 「提交」按钮（busy=mutate 在途时禁用） |

## 10. CanvasBindingBadge.vue（画布头部 agent 绑定状态徽标）

| testid | 触发/可见条件 |
|--------|---------------|
| `canvas-binding-badge` | 绑定徽标（active / none 两态；count=null = reply 未携带字段，未知不渲染） |

## 11. TrayCanvasPanel.vue（composer 任务托盘第 5 件「画布」面板）

| testid | 触发/可见条件 |
|--------|---------------|
| `tray-canvas-panel` | 面板根（画布按归属会话隔离 D4：清单 = 本会话画布，props.sessionId 即归属上下文） |
| `tray-canvas-header` | 段头摘要（总数 + 进行中数；entries>0 才渲染） |
| `tray-canvas-row` | 画布清单行（点击 = openCanvasTab(canvasId, sessionId) 直达画布 tab，载荷带归属会话） |
| `tray-canvas-dot` | 行阶段点（生长中 accent / 审查中 warn / 已收敛 success；派生值非可写状态） |
| `tray-canvas-mustfix` | 行 must-fix 计数（>0 才渲染——归零不虚亮） |
| `tray-canvas-meta` | 行 meta（阶段文案 + 问题陈述截断） |
| `tray-canvas-empty` | 空态（零画布；D4 隔离后外壳按钮已隐藏，本态为防御性保留——清单竞态清空时面板仍渲染不破版） |
| `tray-canvas-create` | 「＋ 新建画布」按钮（创建入口；owner = props.sessionId——D4 隔离后随首张画布出现，零画布时外壳按钮隐藏） |
| `tray-canvas-form` | 三要素表单 modal（问题陈述 / 完成判据 / 范围与排除项） |
| `tray-canvas-statement` | 问题陈述输入 |
| `tray-canvas-criterias` | 完成判据输入（每行一条） |
| `tray-canvas-scope` | 范围与排除项输入（每行一条） |
| `tray-canvas-form-error` | 缺一拒绝文案（列出全部缺失项——不变量 1 前置校验） |
| `tray-canvas-submit` | 「创建」提交按钮（creating 在途时禁用） |

## 12. 变更登记

**[2026-10-15 problem-solve-canvas D5 终态同步]** 建账：全量 100 个唯一值首次登记（F1-27——设计 §3.1(3)「testid 全量登记」UI 规范要求的落地；建账前 docs/testing 零 canvas 条目）。前缀纪律 canvas-* / tray-canvas-* 实测 100/100（103 处出现 = 81 静态 + 22 动态绑定）。无更名 / 退役（本批次零 testid 改动）。动态绑定值（`canvas-*-${...}` 族）的运行时实例不在表中逐一枚举——实例集合由组件状态决定，断言按具体实例值写。

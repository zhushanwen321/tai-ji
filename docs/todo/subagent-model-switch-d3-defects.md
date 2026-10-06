# subagent-model-switch D3 验收缺陷登记（2026-10-06 首轮真机验收产出）

状态：未解决（D3 首轮验收 A1/A4/A6 节点产出；A2/A3 degraded 已含入口层降级说明；修复后须重验收覆盖）。

## 缺陷一：chat 域模型切换入口点击不可达（U1 入口层，验收节点 A6 实证）

- 现象：`subagent-model-trigger` 点击三次均不弹出模型 popover，chat 域成员的 UI 切换路径整体不可用。
- 根因：`SubagentTab.vue:78-93` 的 ModelSelectPopover `#trigger` 具名 slot 传裸 `Button`，未包 `PopoverTrigger as-child`（`ModelSelectPopover.vue:16-29` 无 slot 包裹逻辑）；`SubagentTab.model-label.test.ts:71-72` mock 掉 ModelSelectPopover 组件，点击行为零覆盖（三视角缺一不可红线的「使用者黑盒」缺席实例）。
- 修复方向：trigger slot 内容包 `PopoverTrigger as-child`（WorkflowTab.vue 同款检查）；补一条真实渲染点击用例（不 mock ModelSelectPopover）。

## 缺陷二：网关会话归属判定在多会话共享 cwd 时误路由（U6 适配器，验收节点 A4 实证）

- 现象：`SubagentModelSwitchGateway.resolveSessionMeta` 的 record 分支按 `getSubagentRecordsDir(agentDir, s.cwd)` 共享目录存在性判定归属，同 cwd 多会话全部命中 `sessions.find` 第一个（scanSessions mtime 序）——请求被路由到非归属会话的 pi 进程，宿主 `getRecordForAction` 归属校验拒绝。并行多会话场景必现；单会话正常使用不可现。
- 修复方向（A4 建议）：record 分支改按 record 事件帧 rootSessionId（或会话 id 精确匹配）判定归属，目录存在性只作快速过滤不作归属裁决。

## 缺陷三：chat 域活进程判活形态不匹配，执行中热切全部降级记账型（U2 编排判活面，验收节点 A1 实证）

- 现象：宿主镜像判活（`subagent-core engine/host/spawned-children.ts` 镜像）与 chat 域每轮新进程形态不匹配——即使在跑轮次内（存在活进程），执行中切换也全部降级记账型；§7.2 分流「有活进程 → 已生效型」路径真机不可达。
- 修复方向：判活锚点改到真实存活事实（引擎侧子进程注册表或 runtime spawn 记录），或明确「轮间无活进程 = 记账型合法」并把「轮内热切」的可达性补齐——须先核实 chat 域进程形态（每轮新进程 vs 会话常驻）再定，属设计 §7.2 分流的实施核对项。
- 连带：`model_change` 断言面依赖条目序列完备，冷 spawn 换模型不写该条目——§7.2 审计口径在冷 spawn 形态需改锚 assistant 条目 model 字段或约定补写（验收脚本 a14 与设计口径同步适配）。

## 验收环境教训（非缺陷）

- 并行 inspect 共享单窗口 DOM：UI 输入通道全局唯一焦点，逐键注入与会话切换穿插交叉污染——多 agent 单窗口 UI 验收须预置时隙互斥协议；重验收轮按串行链编排（前一轮 A5 升级裁决已现场补课）。
- 凭据缺失变体结构性不可达：catalog 准入即凭据检查，§5.2 宿主预检分支无构造面（设计字面的构造前提不成立）；变体以同族校验型分型「目录无此模型」承接成立。

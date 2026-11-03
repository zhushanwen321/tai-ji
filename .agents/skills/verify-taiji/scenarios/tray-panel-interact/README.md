# tray-panel-interact 场景族（A1-A4 + 汇总，2026-11-03 交付入库）

L4 inspect 场景族：真机驱动（verify-taiji mock-http 通道，agent 按任务书执行 + 机读断言落盘），
**非 scripts/run.mjs 剧本形态**——消费方式 = dev-flow-wf D3 验收派发（exec-plan inspect 节点
promptFile 指向本目录任务书），或单场景人工驱动（任务书内含装配与断言全量口径）。

| 任务书 | 场景 | 通过标准概要 |
|--------|------|--------------|
| a1-row-nav.md | A1 托盘行点击导航 | V1 行点击落 drawer/对话流/续聊框 + 面板收起；V2 overlay DAG 高亮/trace/gantt/agent 抽屉/焦点回 composer |
| a2-lifecycle-ops.md | A2 生命周期操作 | V3 取消两段式（确认态→toast→行翻→角标减一→pin 保持）；V4a 失败行重试；V4b interrupted 续跑全链（restore 后托盘件恢复+续跑钮可达+run 回 running）；V6 RPC 失败不乐观翻转 |
| a3a4-patrol.md | A3+A4 巡检 | V5 hover 安全 6 断言；V7 多面板回归（todo/goal/scheduler 零变化、SubagentTab 续聊、切回重挂）；V8 i18n 中文 + 断连壳层呈现（ADR-0185）+ 无空面板口径（未开面板前置数 DOM） |
| a-summary.md | D3 汇总判定 | 逐节点 verdict 一览 + 兜底扫描 + 未决项汇入交付口径 |

公共契约 `_contract.md`：断言通道三件套（A=CDP/B=runtime RPC+events/C=磁盘与进程）、
verdict.json 双落位（artifactsDir 根 + 镜像）、机读断言 artifactsDir/summary.jsonl 逐步汇总。

已知口径（复用时先读任务书尾注）：断连构造 = 杀会话 pi 进程集（杀 runtime 触发全屏重启页 UI 不可达，
ADR-0185）；显式派发模型需实例 providers.json scopedModels 白名单含 mock 演员（launch 后 patch 即生效，
a2-driver 同款）；mock 成员 SO 工具名 = 下划线 `structured_output`（pi 工具名 snake_case 规范）。

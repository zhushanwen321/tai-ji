# A2 / V3+V4+V6：托盘面板生命周期操作（L4 判断型）

承 `_contract.md` 公共契约。deps：无（独立真机场景，与 a1-row-nav / a3a4-patrol 并行，实例隔离见公共契约）。

## 背景与目标

托盘面板内的生命周期操作链：取消两段式确认 + 回执 + 行状态翻转（V3/GL3、GL4 操作半边）、failed 行重试与 interrupted 行续跑（V4）、RPC 失败不乐观翻转（V6）。设计 §4.1 场景 V3/V4/V6。

确定性子断言已由机器资产承担，本节点不重复：confirm 两段式状态机 = Actionbar 单测族（RL3，含降级矩阵）；行状态翻转与角标减一、按钮声明与参数映射 = tray-widget-buttons / primitives 单测族；RPC 失败不写行状态 = useExtensionHostBridge-host-commands 单测（RL6）。本节点 L4 收窄声明 = 机器判不了的部分：**操作序列全程的视觉流畅性与失败路径表现**（确认态翻牌、toast 实际出现、面板保持 pin 不闪断、对话流无命令轮次痕迹）。

## 步骤（mock-http 零 token 装配，单实例串段）

1. `createInstance` 装配 mock-http 实例：name=`verify-tray-a2-lifecycle-ops`，data-dir=`~/.taiji-dev/verify-tray-a2-lifecycle-ops`；doctor 五项全绿 + CDP URL 核对。
2. 段一（V3，取消两段式）：派发一个 subagent（等 bot 图标）→ 点图标 **pin** 面板（行尾出现操作按钮）→ 点「取消」→ 断言按钮翻红色确认态且确认文案出现 → 再击 → 观察回执与行状态。
3. 段二（V4，重试 + 续跑）：构造一次失败的 subagent（mock 响应脚本编排失败轮）→ pin 面板 → 已结束段 failed 行点「重试」→ 观察重新派发；构造 interrupted workflow（mock 编排中断）→ 面板内点「续跑」→ 观察 run 恢复。
4. 段三（V6，失败路径）：pin 面板 → 切走焦点会话（或断开 runtime 连接）→ 点取消并确认 → 观察回执与行状态。断连构造口径：杀 runtime 进程会触发应用全屏连接态过渡屏（壳层语义，impl-plan §5.1 发现 14），UI 不可达——用**杀会话 pi 进程集**的等价构造（respawn 窗口内 chat/composer/托盘保持可用 + RPC reject；D3 attempt1 已验证可达），如实登记构造差异。
5. 每步截图 + testid 断言输出；抓副作用证据（records 事实源与显示一致——侧栏/SubagentTab 同步翻已结束；对话流无命令轮次痕迹）；写 report.md。「无命令轮次痕迹」的判定 = **检查会话树无命令类条目**（命令轮次产生独立 entry 形态），禁用裸子串匹配（通知载荷的 transcript 文件路径文本含命令名，attempt1 实证为误报源）。

## 通过标准

- V3：确认态文案出现（如「确认取消？」）；再击后 toast 回执出现、该行翻「已结束」、图标角标运行数减一、面板保持 pin 不闪断；records 事实与显示一致。
- V4：重试 = 重新派发同任务（新运行记录出现在进行中段）；续跑 = run 恢复运行（DAG 当前节点推进）；两操作均有 toast 回执；全程对话流不出现命令轮次痕迹（不开 agent turn）。
- V6：toast 显示失败原因与恢复指引（指向目标会话重试），行状态**不翻转**（保持运行中——不乐观假成功）；无静默失败。

## 判定与返回

按公共契约返回 `{verdict, test_evidence, deviations, blockers}` 并落 verdict.json 到本节点 artifactsDir。失败路径表现不符（toast 缺失败原因/行被翻转）= product-bug 候选，先归因再定；environment 类（mock 装配/实例问题）重试一次后仍败 → degraded + blockers。

# A1 / V1+V2：托盘面板行点击导航（L4 判断型）

承 `_contract.md` 公共契约。deps：无（独立真机场景，与 a2-lifecycle-ops / a3a4-patrol 并行，实例隔离见公共契约）。

## 背景与目标

托盘聚合面板的行点击导航终态：subagent 行 → 右抽屉直接定位该子代理（GL1）；workflow 行 → 全屏浮层呈现该 run（GL2）。设计 §4.1 场景 V1/V2。

确定性子断言已由机器资产承担，本节点不重复：RL1 = container-navigation sink 映射单测（ui.subagent → 打开 + 选中 subagent tab）；入口链（tray-widget-button → tray-widget-panel → tab-bar 段 → list-tree 可点行）由 a5-entry-chain 的 e2e/tray-entry-real.spec.ts（E2E-REAL-01，RE1）承担。本节点 L4 收窄声明 = 机器判不了的部分：**浮层 DAG 节点状态与 run 实际进度一致性的视觉确认** + 导航终态在真实进程链路上的实际表现（tab 落位、浮层内容非空、焦点回归）。

## 步骤（mock-http 零 token 装配，双段单实例）

1. 读 verify-taiji SKILL.md §1.1b，`createInstance` 装配 mock-http 实例：name=`verify-tray-a1-row-nav`，data-dir=`~/.taiji-dev/verify-tray-a1-row-nav`，model-keyed 响应脚本覆盖主会话与孙进程演员。启动后 doctor 五项全绿 + CDP URL 核对本实例。
2. 段一（V1，subagent 导航）：建用户会话（工作目录选真实 git 仓库，如 `<repo>` 自身）→ 派发一个 reviewer 子代理（等托盘 bot 图标/徽标出现）→ 悬停图标约 160ms 待面板弹出 → 点「进行中」段的 reviewer 行 → 观察右抽屉。
3. 段二（V2，workflow 导航）：同会话派发一个 workflow run（等多 agent 脚本，等 workflow 图标出现）→ 悬停弹面板 → 点运行中的 run 行 → 观察全屏浮层。
4. 每步截图 + testid 断言输出；段末抓副作用证据（ext-sessions 会话树内容、runtime 日志关键行）；写 report.md。

## 通过标准

- V1：右抽屉打开且**直接落在 subagent 标签页的该 reviewer 详情**——二级 tab 标题为 reviewer、对话流可见、底部续聊输入框在（引擎 chatCapable 时）；不是默认标签页、不需要手动切换；面板随导航收起。
- V2：全屏浮层打开且呈现该 run——DAG 图节点状态与 run 实际进度一致（运行中节点高亮，与 mock 响应脚本编排的进度对照）、甘特图与 trace 表非空；点 trace 行可开 agent 对话流抽屉；浮层关闭后焦点回 composer。

## 判定与返回

按公共契约返回 `{verdict, test_evidence, deviations, blockers}` 并落 verdict.json 到本节点 artifactsDir。environment 类（mock-http 装配失败重试一次仍败 / 端口被他人实例占且无法派生）→ verdict=degraded + blockers 记录；导航终态不符 = product-bug 候选，先归因（读 TROUBLESHOOTING）再定，禁放宽断言。

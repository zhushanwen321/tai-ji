# A3+A4 / V5+V8+V7：体验巡检与回归（L4 判断型，F4 裁决合并实例）

承 `_contract.md` 公共契约。deps：无（独立真机场景，与 a1-row-nav / a2-lifecycle-ops 并行，实例隔离见公共契约）。

## 背景与目标

一次巡检实例串段覆盖三项（impl-plan F4 裁决：A3+A4 定死合并为同实例串段，行 id 双记录）：

- **V5**（GL4）：hover 浏览安全性——面板处于 hover 态（未 pin）时，行内操作按钮不渲染（点击按钮渲染位无操作可触发）；行点击导航仍可用（导航是安全操作）；title 提示在悬停图标时出现（如「子代理 · 1 运行中 / 3」）。
- **V8**（GL5）：i18n 与断连态——中文界面下面板标题/分段/按钮悬停提示为中文；WS 断连后面板顶部出现「连接已断开，内容可能过期」提示条、重连后自动消失；冷启动窗口 = 图标随首帧出现（无空面板/骨架形态；「无空面板」断言按 V8-④ 裁决在未开面板前置下数 DOM 托盘按钮，或改为断言在场面板内容完整性——不得以「打开面板后面板在不在」充当断言，该形态是无关行为的副产品）。
- **V7**（GL1/GL2 回归）：其他托盘件与既有入口不受影响——bash 件面板开合与行点击、todo/goal/scheduler 面板开合、SubagentTab 从 chat 块入口打开与续聊发送、无条目会话切换后切回（托盘挂载回归）、todo/goal 条目按钮 title 无错乱文案。

确定性子断言已由机器资产承担，本节点不重复：hover 未 pin 交互降级 = primitives 单测（RL4，pin 注入缺省/关/开/响应式联动四例）；title 分段省略矩阵（含 viewId 判别）= TrayWidgetButton 单测族（RL9）；断连条出现/消失 = TrayWidgetPanel 单测（RL5）；挂载回归 = a5-entry-chain 的 e2e/tray-entry-real.spec.ts（E2E-REAL-01，RE3）。本节点 L4 收窄声明 = 机器判不了的部分：**hover 悬停序列与提示形态的视觉确认 + 多面板视觉回归巡检**。

## 步骤（mock-http 零 token 装配，单实例串段）

1. `createInstance` 装配 mock-http 实例：name=`verify-tray-a3a4-patrol`，data-dir=`~/.taiji-dev/verify-tray-a3a4-patrol`；doctor 五项全绿 + CDP URL 核对。界面语言设中文（读 verify-taiji 设置能力原语）。
2. 段一（V5 hover 安全）：仅悬停打开面板（不点击图标）→ 鼠标扫过各行 → 在按钮渲染位点击 → 断言无行内命令被触发；再试行点击导航可用；悬停图标读 title。
3. 段二（V8 i18n + 断连）：中文下打开 subagent/workflow 面板读标题与分段标签、按钮悬停提示 → 断开 runtime 连接后观察壳层呈现 → 重连后观察恢复形态。断连呈现的判定标准（impl-plan §5.1 发现 14 裁决）：壳层对任意非 connected 态整屏摘除 AppShell（App.vue:11 自初始导入即存在）——真机断连的预期呈现 = **壳层连接态过渡屏或会话错误页**；面板级提示条为组件契约由 RL5 单测承载（6/6 绿），真机不断言其出现；重连后是否自动回对话 UI 属启动域观察项（F2），如实登记不作为本节点 fail 判据。
4. 段三（V7 回归巡检）：bash 件面板开合与行点击 → todo/goal/scheduler 面板开合 → SubagentTab 从 chat 块入口打开并发一条续聊消息 → 切到无条目会话再切回有条目会话（托盘重挂）→ 悬停 todo/goal 条目按钮读 title。
5. 每段截图 + testid 断言输出；写 report.md（含每段期望 vs 实际）。

## 通过标准

- V5：hover 态行内操作按钮不渲染且点击无命令触发；行点击导航可用；图标 title 悬停出现且文案形态正确。
- V8：标题「子代理」「工作流」、分段「进行中/已结束」、按钮悬停提示中文；断连呈现 = 壳层过渡屏/错误页（按发现 14 裁决的标准判定）；图标随首帧出现无空面板（断言前置按上方 V8-④ 口径：未开面板下数 DOM）。
- V7：bash 面板行为与迁移前一致；todo 等面板零变化；SubagentTab 续聊正常；切回有条目会话托盘正常重挂；todo/goal 条目按钮 title 无错乱文案（无「运行中 / undefined」类输出；完成计数条目不出现「运行中」段）。

## 判定与返回

按公共契约返回 `{verdict, test_evidence, deviations, blockers}` 并落 verdict.json 到本节点 artifactsDir。任一段不符先归因（spec-bug / product-bug / environment）再定 verdict；回归段发现既有机能被破坏 = product-bug 候选，禁以「迁移前就这样」弱化。

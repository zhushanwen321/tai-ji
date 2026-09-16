# composer-pi-shortcuts L4 真机验收报告（核心组 A2-A4）

- 日期：2026-09-16
- 环境：dev 实例 `TAIJI_DEV_BACKGROUND=1 pnpm dev`（worktree feat-shortcut-follow-pi，CDP 9518 / Vite 1628 / runtime 3670），真实 LLM（默认模型 xiaomi-token-plan-cn/mimo-v2.5-pro，provider router @ 192.168.1.202:9980）
- 行为规格：docs/design/composer-pi-shortcuts.md §4 场景表 S1/S2/S4/S10/S11 行 + §3.1 终态
- 键盘注入方式：Playwright over CDP（Input.dispatchKeyEvent，trusted 事件）。Enter/Ctrl 系组合均被应用正常响应（消息发送、模型切换均生效），无需降级方案
- console 采集：全程 CDP Runtime.consoleAPICalled/Log.entryAdded 监听（console-capture.log）

## 总结

| 场景 | 结论 |
|---|---|
| S1 流式中 shift+tab ×3 档位循环 + popover 同源 | **PASS** |
| S2 ctrl+p / ctrl+shift+p 双向循环 + 绕回 + popover 高亮 | **PASS** |
| S4 ctrl+x 复制最后回复（非流式 + 流式） | **PASS** |
| S10 runtime 断开后循环 RPC 失败保持真值 + 恢复后从真值起算 | **PASS** |
| S11 空流 ctrl+x 无反应 + 选区原生剪切让位 | **PASS** |

5/5 pass，无 fail、无 blocked。

---

## S1：流式输出中 shift+tab ×3（A2 核心）—— PASS

**操作**：已建 session「秋天山间散文创作」第二条长文请求流式生成期间（工具条 t/s 活跃），composer 聚焦，按 shift+tab 三次，每次间隔 1.5s 读 chip。

**前置状态**：档位 popover 打开记录可用集 = 关/极简/低/中/开（5 档），当前「开」（表尾）。见 s1-popover-initial.png。

**观察**（预期序 = 归一序循环 +1，表尾绕回表头）：

| 按键 | chip 实际 | 预期 | 判定 |
|---|---|---|---|
| 第 1 次 | 开 → 关 | 开 → 关（绕回表头） | ✓ |
| 第 2 次 | 关 → 极简（由第 3 次结果反推锚定） | 关 → 极简 | ✓ |
| 第 3 次 | 极简 → 低 | 极简 → 低 | ✓ |

第 2 次的中间态 chip 读数脚本输出损坏，但链条闭合：第 1 次后=关、第 3 次后=低；若第 2 次未生效，第 3 次应停在极简而非低。

**popover 同源**：三次按键后打开档位 popover——列表「低」带 ✓，与 chip「低」一致（s1-popover-after3.png，流式仍在进行）。

**证据**：s1-popover-initial.png / s1-streaming-start.png / s1-chip-after3-low.png / s1-popover-after3.png

## S2：ctrl+p 与 ctrl+shift+p 双向循环（A3 核心）—— PASS

**操作**：同一已建 session，composer 聚焦。前置 popover 记录：模型列表 8 个（MiMo-V2.5 / MiMo-V2.5-Pro / GLM-4.6V / GLM-4.7 / GLM-5-Turbo / GLM-5.1 / GLM-5.2 / GLM-5V-Turbo），起点 MiMo-V2.5-Pro。见 s2-model-popover-before.png。

**观察**：

| 按键 | chip 实际 | 语义 | 判定 |
|---|---|---|---|
| ctrl+p | MiMo-V2.5-Pro → GLM-4.6V | 前进一步 | ✓ |
| ctrl+p | GLM-4.6V → GLM-4.7 | 前进一步 | ✓ |
| ctrl+shift+p | GLM-4.7 → GLM-4.6V | 后退一步 | ✓ |
| ctrl+shift+p | GLM-4.6V → MiMo-V2.5-Pro | 后退一步 | ✓ |
| ctrl+shift+p | MiMo-V2.5-Pro → MiMo-V2.5 | 后退到表头 | ✓ |
| ctrl+shift+p | MiMo-V2.5 → **GLM-5V-Turbo** | **表头绕回表尾** | ✓ |
| ctrl+p | GLM-5V-Turbo → **MiMo-V2.5** | **表尾绕回表头** | ✓ |

**popover 一致性**：绕回验证后（chip=MiMo-V2.5）打开 ModelSelectPopover——「MiMo-V2.5」带 ✓，与 chip 一致（s2-model-popover-after.png）。

**证据**：s2-model-popover-before.png / s2-model-popover-after.png

## S4：ctrl+x 复制最后回复（A4 核心）—— PASS

**操作 A（非流式）**：第一条回复（约 900 字散文）完成后，剪贴板写入哨兵值 `SENTINEL-BEFORE-CTRLX`，composer 聚焦按 ctrl+x，1s 内截图 + `navigator.clipboard.readText()` 取证。

**观察 A**：
- toast「已复制最后回复」（info 级，右上角）出现：s4-toast-nonstream.png
- 剪贴板 1113 字符，head「雾还没有散去的时候，山是安静的。」/ tail「雾散尽了。山醒了。我也该下山了。」——与最后一条回复全文首尾一致（截图 02-reply-done-check.png 可视比对），哨兵被覆盖

**操作 B（流式）**：第二条回复（海边黄昏散文）流式生成期间按 ctrl+x。

**观察 B**：
- toast「已复制最后回复」出现：s4-toast-streaming.png
- 剪贴板 1391 字符：head「退潮之后，沙滩上留下一面巨大的镜子。」（第二篇开头）→ tail「明天还有日落，你不必着急。」（当时流式已生成的最后一句，与 s1-popover-after3.png 中消息流可见进度一致）——即「当前已生成部分文本」

取证方式：CDP evaluate `navigator.clipboard.readText()`，Electron renderer 权限放行，未走 paste 间接路径。

**证据**：s4-toast-nonstream.png / s4-toast-streaming.png / 02-reply-done-check.png

## S10：runtime 断开 + 恢复（A3 核心，依赖 S2）—— PASS

**操作**：`ps` 定位 dev 链 runtime 子进程（tsx 运行 packages/runtime/src/index.ts --port=3670）精确 kill（PID 70196，后继 80478），Electron 主进程与 vite 未动。kill 后 composer 聚焦按 ctrl+p 1 次 + 快按 2 次。

**时序要点（第一次尝试的教训）**：主进程 supervisor 有崩溃自动重启（restart-policy 1s/2s/4s/8s/16s 退避 + MAX_RESTARTS=5）。第一次尝试 kill 后 sleep 2 再按键，runtime 已被拉起且 WS 已重连，按键正常切换（非断开态）。第二次 kill 后**立即**按键，3 次全部落入断开窗口。

**观察（断开窗口内）**：
- 3 次按键后 chip 保持 GLM-4.7 不变（s10-runtime-down2.png）
- 无错误 toast（截图右上角干净）
- console.warn ×2：`[composer-shortcut] model cycle RPC failed: Error: session not active`——符合设计 §3.3「RPC reject → catch → console.warn，无 toast，chip 保持旧值」

**观察（恢复）**：supervisor 自动拉起新 runtime 且 WS 重连，但 pi session 不自动恢复 active（console：`session 01a0a924... not active`），恢复期按键 RPC 仍失败、chip 不动（s10-recovered-1press.png）——失败按键未产生误导性 UI。按任务预案重启整个 dev 链 + 重新打开 session 后：
- chip 真值 = GLM-4.7（s10-restart-landing.png 为 landing 态持久化显示）
- 按 1 次 ctrl+p → **GLM-4.7 → GLM-5-Turbo**（列表中 GLM-4.7 的下一个，s10-recovered.png）——断开期间 3 次失败按键的意图目标未残留，从真值重新起算 ✓

**证据**：s10-runtime-down2.png / s10-recovered-1press.png / s10-restart-landing.png / s10-recovered.png / console-capture.log

## S11：空流 no-op + 选区原生剪切让位（A4 核心）—— PASS

**操作 A（空流）**：新建任务（landing/空 session 无任何消息），剪贴板写哨兵 `SENTINEL-BEFORE-S11`，composer 聚焦按 ctrl+x。

**观察 A**：剪贴板仍为哨兵（复制动作未执行）、无任何 toast（DOM toast 查询为空 + 页面无「已复制最后回复」文本）、UI 无变化（s11-empty-ctrlx.png）。

**操作 B（选区）**：composer 输入 `S11-cut-test-text` 并全选，按 ctrl+x。

**观察 B（取证方式注明）**：
- 应用行为面：**未触发复制动作**——无「已复制」toast、剪贴板哨兵未被 writeText 覆盖 ✓
- 原生剪切本体：CDP 合成 Ctrl+X 不触发 Chromium 原生 cut 编辑命令——对照实验证实为工具限制而非应用拦截：在不受 composer 动作表控制的侧边栏搜索 input 中，选区 + 合成 Ctrl+X 同样不剪切。改用与真实按键默认行为同层的编辑命令通路 `document.execCommand('cut')` 补充验证：composer 选区剪切成功（文字从输入框消失、剪贴板 = `S11-cut-test-text`、无 toast），证明放行路径下原生剪切通路可用
- 若需「人手真实按键」级别的原生剪切取证，需物理键盘操作（超出本次 CDP 通路能力），结论以 execCommand 通路 + 对照实验为据

**证据**：s11-empty-ctrlx.png / s11-selection-cut.png

---

## console 问题清单（与本次改动相关）

1. `[composer-shortcut] model cycle RPC failed: Error: session not active`（warn ×2）——S10 验收动作触发的**设计内预期**日志（§3.3 RPC reject → console.warn），非缺陷。
2. 观察项（非本次改动面，登记备查）：① `[Vue warn] onScopeDispose() ... no active effect scope` 每次 app 启动出现 ×2（启动期既有，时间点早于任何快捷键操作）；② 一条 `log.error [security]: Creating a worker from blob:... violates CSP script-src`（dev 链重启窗口期出现一次，来源未定位，快捷键改动不创建 worker）。

## 环境观察（不影响结论）

- S1/S2/S4 期间 composer 工具条残留上一轮的 t/s 统计（如回复完成后仍显示「27 t/s」），属既有工具条统计展示，不在本次改动面。
- S10 场景下「仅恢复 runtime 进程」不足以恢复功能：supervisor 拉起 runtime 后 pi session 需重新打开才 active。S10 的「恢复」按任务预案执行了整链重启。

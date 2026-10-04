# 浮层 chunk 装载失败：内部自动重试（现行机制 + 残余限制）

> **状态**：已裁决并实施（2026-10-03 用户裁决：「重试按钮，不应该有，应该是内部保证加载重试，而不是界面做这个事情」——界面无重试按钮，装载失败由系统内部自动重试兜底，穷尽才呈现错误态）。
>
> **本文件定位**：懒加载 chunk 失败自动重试机制的现行说明（SSOT）：实现位置、机制、探针证据、残余限制。

## 现行实现

- `packages/renderer/src/components/ui/lazy-chunk-retry.ts`（createLazyChunkRetry 状态机）
- `packages/renderer/src/components/ui/AsyncErrorFallback.vue`（错误态无按钮，穷尽文案给恢复指引）
- 消费方：AppShell 设置弹窗 + PanelContainer 的 DetailPane / TerminalView / WorkflowTab 三挂载点
- 设计文档：`.tmp/tech-design/display-containers.md` §5.3 第 2 行（.tmp 过程产物不入 git，本文件为仓库内唯一登记处）

## 机制

- **有界自动重试**：3 次 × 300ms 递增退避（300/600/900ms，累计 ~1.8s）。参数依据：瞬时类失败（升级替换窗口 / AV 扫描 / dev server 抖动）恢复窗口在亚秒～秒级，3 次覆盖之；仍失败即持久故障（版本错配 / 文件缺失），继续重试只推迟错误态出现。
- **失败未穷尽 → loading 占位**（非错误态，瞬时失败不闪错误）；**穷尽 → 错误态**：文案给恢复指引（已自动重试 3 次未成功，关闭后重新打开可恢复，Esc/⌘W 可退出——退出与重开路径既有且不回归）。
- **cache-busting 自愈**：从失败错误消息提取 chunk URL（严格锚定 Chromium 原生前缀 `Failed to fetch dynamically imported module: <url>`），`import(/* @vite-ignore */ url + '?t=N')` 绕过浏览器 module map 对失败 URL 的记忆化（同 URL 再 import 零网络请求是浏览器模块语义，非同 URL 重试不构成自愈）。
- **重试驱动（Vue 3.5.39 runtime-core 实装核对）**：退避到点 `userRetry() + retryKey++` 双要素同调——前者清 pendingRequest 并重跑 loader（busted 重跑唯一跑点），后者重挂新 wrapper 接续同一链、结算时置 loaded。穷尽 fail 后实装 setup catch 清 pendingRequest，「关闭后重新打开」恒获得全新一轮自动重试。
- 构建产物零改动（正式构建验证：静态 import 的 chunk 拆分无损，变量 import 保留为运行时动态 import）。

## 探针证据（file:// 可 bust 的实证链）

1. **浏览器层**（Electron 42 / Chromium 实测，file://）：失败 URL 记忆化确认（同 URL 再 import 零网络瞬时失败，即使文件已恢复）；`?t=N` busting 绕过记忆化重新加载成功——dir 与 asar 双形态一致。
2. **构建层**（vite 8 / rolldown spike）：静态 `import()` 保持 chunk 拆分的同时，`import(/* @vite-ignore */ 变量URL)` 原样保留为运行时动态 import——不需要固定 chunk 名或改指纹策略。
3. **集成层**（正式构建产物核对）：4 个懒加载 chunk 正常生成；busting 表达式与错误前缀匹配串编译在位。

证据链全文见 `.tmp/dev-flow/display-containers.runlog/d6-fix-internal-retry.md`（.tmp 过程产物不入 git）。

## 残余限制（落地事实，不美化）

1. **busting 只覆盖失败入口 chunk**：若失败发生在入口 chunk 依赖的共享 chunk（vendor 等），依赖 URL 已被记忆化，入口 busting 后依赖仍瞬时再拒——该形态不自愈，出路仍是关闭重开 / 重启进程（版本错配类在进程重启后天然消除）。
2. **非 URL 形错误回落机械重试**：错误消息不符合 Chromium 前缀（如测试 mock 错误）时提取不到 URL，重试为同 URL 机械路径（无效但无害）；真实浏览器装载失败恒带 URL（探针实证）。
3. **重试调度期间关闭挂载点**：后续轮次在背景继续推进（计数有界），穷尽 fail 主动归零，重开恒全新一轮。
4. **失败未穷尽期间 wrapper 停 loading 占位**（Vue userOnError 契约：链 pending → loading）：设计内形态，非缺陷。

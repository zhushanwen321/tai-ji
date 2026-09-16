# composer-pi-shortcuts L4 真机验收报告（守卫组 A5）

- 日期：2026-09-16
- 执行者：A5（一次 dev 实例会话连测 5 场景：S5/S6/S7/S12/S13）
- 环境：dev 实例 `TAIJI_DEV_BACKGROUND=1 pnpm dev`（worktree feat-shortcut-follow-pi，CDP 9518 / Vite 1628 / runtime 3670），已建 session「秋天山间散文创作」（01a0a924）
- 行为规格：docs/design/composer-pi-shortcuts.md §4 场景表 S5/S6/S7/S12/S13 行 + §3.3 决策 7/9
- 键盘注入：Playwright over CDP（Input.dispatchKeyEvent trusted 事件，与 a2a4 同通路）；S7 IME 组合经 `Input.imeSetComposition` / `Input.insertText`；S13 auto-repeat 经 `Input.dispatchKeyEvent` 的 `autoRepeat:true` 参数（26 keydown ≈ 1.05s，25Hz 量级）
- console 采集：全程 CDP Runtime.consoleAPICalled / Log.entryAdded（console-capture-a5.log）
- 辅助脚本（落盘本目录）：cdp-ime.mjs（IME 组合驱动）/ cdp-repeat.mjs（长按模拟）/ cdp-keydiag.mjs（事件形态诊断）

## 总结

| 场景 | 结论 |
|---|---|
| S5 选区 ctrl+x：动作表放行原生剪切 | **PASS** |
| S6 命令浮层内四键位：动作表不介入、ctrl+shift+p 冒泡弹预设（既有语义） | **PASS**（附浮层 shift+tab 既有消费语义注记） |
| S7 IME 组合中 shift+tab / ctrl+p：不触发动作、chip 不变 | **PASS**（附组合 finalize 归因注记） |
| S12 已建 session ctrl+shift+p：切模型 + 预设不弹（决策 7）+ 既有入口零回归 | **PASS** |
| S13 长按 shift+tab：26 keydown 仅走一步 + 焦点让位（决策 9） | **PASS** |

5/5 pass，无 fail、无 blocked。

---

## S5：composer 选区 ctrl+x 原生剪切让位 —— PASS

**操作**：已建 session composer 聚焦，Playwright type 输入 `S5-cut-marker-AAA tail-part-BBB`，Selection API 选中前 17 字符（`S5-cut-marker-AAA`），剪贴板写哨兵 `SENTINEL-A5-S5`，window bubble 层挂探针，合成 Ctrl+X；再以 `document.execCommand('cut')` 同层通路验证原生剪切本体（核心组已证 CDP 合成 Ctrl+X 不触发 Chromium 原生 cut，为工具限制非应用拦截）。

**观察**：
1. 合成 Ctrl+X 后：window bubble 探针 received=1 且 defaultPrevented=false → **动作表未 preventDefault、未 stopPropagation（选区场景返回 false 放行）**；剪贴板保持哨兵 → 复制动作（writeText）未执行；无「已复制」toast ✓
2. `execCommand('cut')` 后：composer 文本 `S5-cut-marker-AAA tail-part-BBB` → ` tail-part-BBB`（选区消失）；剪贴板 = `S5-cut-marker-AAA`（**选区文字而非最后回复**）；无 toast ✓

**判定**：动作表对选区剪切零拦截零动作；原生剪切通路在放行路径下可用。三断言点（handler 返回 false 的行为面等价证据 / 无 toast / 剪贴板 = 选区文字）全命中。

**证据**：s5-selection-cut.png

## S6：命令浮层内键位共存 —— PASS（附注记）

**态修正**：预设 popover 的载体 PresetSelectChip（工具条「全工具模式 ▾」）仅在 landing 存在；S6 的「ctrl+shift+p 冒泡触发预设 popover」必须在 **landing 态**验证（已建 session 无载体，见 S12 附注）。

**操作（landing）**：composer 聚焦输入 `/` 打开命令浮层（/compact、/goal、/permission…）→ 按 ctrl+p → 按 ctrl+shift+p → Esc 关预设 popover → 重开浮层按 shift+tab → 清理后确认恢复。

**观察**：
1. 浮层内 ctrl+p：浮层保持 open、模型/档位/预设 chip 全不变（GLM-5-Turbo / 高 / 全工具模式）→ 动作表 cmdOpen 守卫跳过 ✓
2. 浮层内 ctrl+shift+p：**预设 popover「选择启动预设」弹出**（全工具模式 ✓ / Orchestrator / 只读模式），与命令浮层**两 popover 并存**（截图）→ 全局表正常命中、既有并存语义复现 ✓
3. 浮层内 shift+tab：**chip 全不变**（动作表零介入 ✓）；事件被浮层自身既有 Tab 消费语义接管——`command-popover-keyboard.ts:98` `isEnterOrTab = e.key === 'Enter' || e.key === 'Tab'` 不区分 shift 修饰 → 高亮命令被选中插入 token（浮层随之关闭）。
4. 关闭后恢复：chip 恢复基线、无浮层、composer 干净 ✓

**注记（非缺陷）**：第 3 条 shift+tab 在浮层内的「选中命令」行为是浮层既有实现（该文件不在本次改动面——`git show --name-only 918fb6f6a` 证实改动面 = Composer.vue / composer-keydown / composer-shell / composer-shortcut-actions / i18n）；事件经浮层 window capture 主入口消费，根本到不了动作表，动作表行为（跳过）与设计 §3.4 首行一致。已建 session 侧补充对照（s6-after-shifttab.png / s6-after-ctrlshiftP.png）：同样 chip 不变；ctrl+shift+p 在已建 session 无预设弹出 = 无 PresetSelectChip 载体（组件拓扑事实，非行为回归）。

**证据**：s6a-landing-float-open.png / s6b-landing-both-popovers.png / s6c-landing-shifttab.png / s6-after-shifttab.png（已建态对照）

## S7：IME 组合中按键不触发 —— PASS（附注记）

**操作**：已建 session composer 聚焦，`Input.imeSetComposition` 建立「nihao」组合（探针证实 compositionstart、composingNow=true、组合文本入 DOM）；组合中分别合成 shift+Tab 与 ctrl+p；`Input.insertText('你好')` 上屏提交后重按两键验证恢复。window capture 层探针记录每次 keydown 的 `isComposing` 实际值。

**观察**：
1. 组合中 ctrl+p：keydown `isComposing=true`、`composingNow` 保持 true（**组合不中断**）、chip 不变（GLM-5-Turbo / 高）、焦点保持 composer → IME 守卫（`e.isComposing` 分发链段）放行且动作表未触发 ✓
2. 组合中 shift+tab：keydown `isComposing=true` → 应用层守卫路径生效、chip 不变、动作未触发 ✓；同时观察到 compositionend——**归因：浏览器对 Tab 键的默认 finalize 处理，非应用层干预**。对照证据：同组合下 ctrl+p 完全不中断组合，证明应用在组合中不主动打断；合成事件绕过 OS 输入法层直达 renderer（真实用户场景中组合期 Tab 先被输入法层消费），故该 finalize 仅在合成通路可见。
3. 上屏后（compositionend=2）：shift+tab 恢复触发——档位「高」→「关」；ctrl+p 恢复触发——模型 GLM-5-Turbo → GLM-5.1 ✓。「高」不在 GLM-5-Turbo 归一可用集（关/极简/低/中/开），forward 取第一档「关」——设计 §3.3 起点规则精确生效。

**判定**：组合中两键均「不触发动作、chip 不变」（规格主体）pass；「组合不中断」对 ctrl+p 成立、对 shift+tab 的偏差已归因为浏览器默认行为 + 工具通路限制（非应用拦截），L1 isComposing 单测兜底仍有效。

**附带观察**：上屏后 ctrl+p 切模型同时档位 chip 随回执快照变为「高」（新模型档位值）——切模型回执含档位属既有快照行为，非本次改动面。

**证据**：s7a-composing-state.png / s7b-after-commit-cycle.png

## S12：已建 session ctrl+shift+p 拦截（决策 7）+ 既有入口零回归 —— PASS

**操作**：已建 session composer 聚焦（基线 GLM-5.1 / 高），window bubble 层挂决策 7 探针，按 ctrl+shift+p；随后按 ⌘⇧P（Meta+Shift+p）；切 landing 验证 ⌘⇧P 与鼠标点工具条预设 chip。

**观察**：
1. ctrl+shift+p：模型 chip **GLM-5.1 → GLM-5-Turbo**（backward 一步 ✓）；**预设 popover 不弹出** ✓；window bubble 探针 **0 次收到该事件** → 动作表 `stopPropagation` 生效、全局表根本未收到（决策 7 直接机制证据，强于行为面推断）✓
2. ⌘⇧P（已建 session）：全局表**正常命中**——pinia preset store `openRequest` 计数递增（读数 6，含历史各次 ⌘⇧P/浮层内 ctrl+shift+p 命中）→ 键盘通路零回归 ✓；popover 不渲染因已建 session 无 PresetSelectChip 载体（landing-only 组件拓扑，非回归）
3. landing 实弹：⌘⇧P → 预设 popover 弹出 ✓（Esc 可关）；鼠标点工具条「全工具模式」chip → popover 弹出 ✓——既有双入口零回归

**附带观察**：S12 第 1 步切模型后档位 chip 高→关（GLM-5-Turbo 档位集内回执真值），同 S7 附带观察。

**证据**：s12a-ctrlshiftP-model-only.png / s12b-landing-cmdshiftP-preset-open.png / s12c-landing-mouse-preset-open.png

## S13：长按 shift+tab 单步 + 焦点让位（决策 9）—— PASS

**操作**：已建 session composer 聚焦（基线 GLM-5-Turbo / 极简），CDP 模拟长按 1 秒：1 个 `autoRepeat:false` keydown + 25 个 `autoRepeat:true` keydown（40ms 间隔 ≈ 25Hz）+ 1 个 keyup（总耗时 1050ms）；composer 元素级探针记录事件序列（window 级探针不可用——动作表命中即 stopPropagation，事件不冒泡到 window，元素级 listener 不受影响）。

**观察**：
1. 探针 seq：26 keydown = 1 首按（repeat=false）+ 25 auto-repeat（repeat=true）+ 1 keyup——模拟保真 ✓
2. 档位 chip：极简 → 低（**恰好一步**，归一序 forward +1）——26 个 keydown 只走 1 步 = `e.repeat` 忽略生效（防 auto-repeat RPC 风暴，决策 8）✓
3. 焦点：长按后 activeElement 仍为 `.composer-input` → shift+tab 不移出输入框（决策 9 反向焦点让位）✓
4. 前向对照：按 Tab（无 shift）→ 焦点移出 composer 至下一可聚焦元素 → 前向移焦不受影响 ✓

**过程记录**：首跑因自写 CDP 脚本连接层挂起（0 事件发出，已杀进程）与诊断性按键混入，档位出现多步漂移；重挂元素级探针后正式跑数据如上，证据干净。

**证据**：s13a-after-hold.png

---

## console 问题清单（与本次改动相关）

验收操作期间**零新增** console warning/error（无 `[composer-shortcut] ... RPC failed`——所有切换 RPC 成功；无异常抛出）。

既有观察项（非本次改动面，登记备查，与 a2a4 报告一致）：`[Vue warn] onScopeDispose() ... no active effect scope` 启动期 ×2（时间点早于任何快捷键操作）。

## 环境观察（不影响结论）

- 预设 popover 载体 PresetSelectChip 仅 landing 渲染；S6/S12 的「预设弹出与否」判定均以此为前提（组件拓扑事实，非行为差异）。
- 切模型后档位 chip 随回执快照更新（S7/S12 各观察到一次）——既有回执真值行为。
- CDP 合成 Ctrl+X 不触发 Chromium 原生 cut（上轮已证工具限制），S5 以 `execCommand('cut')` 同层通路补证。

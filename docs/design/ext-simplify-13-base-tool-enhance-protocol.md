# ext-simplify-13：base-tool-enhance + extension-protocol 下沉（行为原语归一 + bt- 差集归一 + isGui 组合 helper）

> **一句话结论（v2）**：把 base-tool-enhance（下称 bte）与 xyz-agent runtime 之间靠注释对齐维持的「registry 行为原语」（pid 探测/进程树处置、输出 tail、原子写、终态 LRU 裁剪、registry 解析防御）与「bt- 差集规则」两套跨端重复知识下沉到双端共同依赖的 `@xyz-agent/extension-protocol`（单一实现，两侧改 import；三个含 node 内建依赖的原语模块经**独立子出口 `./background-task`** 暴露，renderer/core 浏览器消费面结构性零触达）；顺带以一个 protocol 组合 helper 收敛 todo/goal 的 isGui 模式分派四分支（07 号设计移交项）。bte 对 pending-notifications 保持 optional peer 不变（D3 否决强依赖方案）；对账「尽力补 emit」路径在 12 号终态下恒 no-op，v2 改判删除（D5 重裁）。

## 开篇（SCQA）

- **S（情境）**：bte 是同名 override 内置 bash 工具的增强层（前台委托 pi 官方工厂 + 增量 background 后台模式 + 工具报错审计，承接已废弃 unified-hooks，设计契约见 `docs/design/base-tool-enhance.md`）；`@xyz-agent/extension-protocol` 是 xyz-agent 体系内 extension 与桌面端之间的跨层契约包（GUI 渲染 helper、session-manager 嵌套契约、background-task registry.json 契约），零运行时依赖，extension 侧 7 包（plugin-bridge/ask-user/base-tool-enhance/goal/session-manager/subagent-workflow/todo）与 runtime 侧 5 包（runtime/core/renderer/shared/subagent-core）共同 import——其中 renderer/core 运行在浏览器/同构环境。bte 的后台任务收殓在 2026-09 下沉 runtime（`docs/design/file-lock-unification-and-reaper-sink.md`）后，同一套 pid 判活/进程树 kill/tail/原子写/LRU 逻辑在 pi 进程侧（bte）与 runtime 侧各存一份，靠注释互指「移植自对方」对齐。
- **C（冲突）**：2026-09-11 过度设计审计（M12/M13）证实「注释对齐」已经失守——两侧 `readOutputTail` 的参数顺序已经相反、返回字段名已经分叉（`output` vs `text`）；LRU 裁剪实存 4 份；bt- 差集规则在 bte 对账与 pending-notifications 守卫判据间双写，pending 侧刚经历 W4 翻档 + 12 号「entries 现算化」两轮大改证明该规则是活动决策。另有一个 07 号设计移交的跨包同构：todo/goal 各自维护一份「清屏/推送 × GUI/TUI」四分支 widget 分派，且 `isGuiCapable` 外层判定不可省略的守卫注释在 3 处重复。
- **Q（问题）**：如何让这些跨包/跨端的重复知识回归单一实现，使「改一处、两侧同时生效」构造性成立，且不破坏 bte 作为 universal 包可独立安装的既有语义（pending 保持 optional）、不让浏览器环境的 protocol 消费者（renderer/core）触达 node 内建依赖？
- **A（答案）**：行为原语与差集规则下沉 extension-protocol——三个含 node 内建依赖的原语模块经独立子出口暴露（浏览器消费面结构性隔离，不依赖 tree-shake 行为），纯算法模块进 index 桶出口（runtime tsup 已将 protocol 列入 noExternal、bte 已硬依赖它，两侧零新增依赖边）；M13 在「A 提强依赖复用」与「B 下沉 protocol」间裁决选 B；M5 落一个 `setWidgetDual` 组合 helper。全部改动为等价替换（用户/LLM 可见面与 registry 字节形态零变化；内部 API 归一/日志通道适配/恒 no-op 死路径删除为有意变化，见 D2/D5），以真实场景双端验收。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改造清单），准则 5/6/7 全适用。

**证据基线**：pi SDK 版本以本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4` 为准（`npm ls` 核对通过；本设计不新增 pi SDK 断言）。v1 行号为分支 `feat-optimize-extensions-over-engineering` 2026-09-11 起草时点实读值；**v2 于 2026-09-13 在 HEAD 0e714d2a1 上重扫刷新**——v1 起草后 01/02/03/09/12/14 六份设计已实施，其中 12 号（pending-notifications）重排了 pending `state.ts` 并改变了 emit 路径前提（MF1）、01 号修订移动了 ext-simplify-01 的登记行号、03 号移动了 goal `widget.ts` 行号；v2 全文行号以 12 号实施后基线为准（漂移明细见各节）。bte 单元四问记录实读自 `~/.pi/agent/tmp/session-view-01a09053-2419-759a-87ab-4d5e911ea840.md`。

**审计修正**（以实读为准）：
1. **四问记录索引错位**：审计附录把 `session-view-01a09053-2429-*` 标为 bte 单元，实读该文件是 scheduler 记录；bte 记录实际在 `-2419` 文件（审计附录把 `-2419` 标为 goal engine+projection）。03 号设计附注已登记同一错位，本设计按实读内容取材。
2. **LRU 副本数 3→4**：审计/四问记录计 3 份终态 LRU 裁剪，实读为 4 份（bte `registry.ts:183-191`、bte `task-store.ts:124-132`、runtime `background-task-reaper.ts:337-341`、runtime `registry-write.ts:34-41`）。
3. **tail 漂移已是事实而非风险**：两侧 `readOutputTail` 不止算法同构——参数顺序相反（bte `(file, maxLines, maxBytes)` / runtime `(file, maxBytes, maxLines)`）、返回字段名不同（`output` vs `text`）、默认字节上界不同（50KB vs 32KB，后者有意为之）。注释对齐已经失守，坐实 M12 根因。
4. **M5 行号与形态修正**：审计写 `todo/index.ts:47-71`，实读为 `todo/src/index.ts:48-65`（makeRefreshDisplay），且 todo 侧已 import protocol `isGuiCapable`（:24,:52）——重复的是「清屏/推送 × GUI/TUI」2×2 分派结构而非 isGui 判定本身；goal 侧实文件为 `goal/src/projection/widget.ts:232-262`（updateWidget，3 处 2×2 分派；v2 复核：03 号实施后漂移至 :200-230，正文 §2.1 例 5 用新值）。07 号设计（`ext-simplify-07-todo.md:33`）已将 M5 登记为 out-of-scope 归本设计。
5. **config 内联数 8→4**：四问记录称 `getConfigFilePath` 生产诊断文案 8 处内联，实读当前 `config.ts` 为 4 处 warn 文案内联（:66,:84,:112,:145），定义点 :49-51 注释「诊断文案与测试用」与事实不符的现状不变。
6. **（v2 修正）goal→pending 依赖登记实存**：审查报告曾判「goal dependsOn 缺 pending 登记」——实读 `extension-dependencies.json` goal 条目 dependsOn 三项齐备（extension-protocol 强 / todo optional / **pending 强**，reason 引 countActiveFromEntries + agent-end.ts:23 top-level import），登记无缺口；v1 引用的行号 :24-26/:55-57 归属错位（:24-26 区是 subagent-workflow 条目、:55-57 区是 goal→protocol 项），本 v2 已修正归属（§3.3 方案 A 证据）。

---

## 1. 背景目标

### 1.1 被设计的系统是什么

**bte 与 runtime 通过一份共享磁盘文件（registry.json）协作，协作规则却各自实现一份——本设计就是把规则收敛回契约包。** 后台 bash 任务的完整生命周期横跨两个进程：pi 进程内的 bte 负责 spawn/查询/kill/完成通知（运行时权威 = 模块级单例任务表）；xyz-agent runtime 负责孤儿收殓与桌面侧边栏视图（触发面 A session 销毁时 / 触发面 B 启动期兜底）。两侧读写同一份 `<agentDir>/base-tool-enhance/<sessionId>/registry.json`，文件形状契约（字段/枚举/守卫函数）已在 `packages/extension-protocol/src/background-task.ts` 单点化（u-bte-remove 迁移成果），但**围绕这份文件的行为逻辑**——怎么判一个 pid 死活、怎么杀进程树防 pid 复用误杀、怎么原子写、怎么裁剪终态条目、怎么读输出尾部——仍是两份实现。

第二条协作线是 pending 事件流：bte 完成/发起后台任务时经 `pi.events.emit("pending:register"/"unregister")` 把状态**投影**给 pending-notifications（通用异步操作注册/查询设施，goal 的 continuation 守卫消费其差集）；bte 在 session_start 时做「对账」——对差集显示活跃但任务已终态的 bt- 任务补写 `pending:unregister` entry（设计 `base-tool-enhance.md` §3.5 接入细则 4）。对账的差集算法是 pending 守卫判据的同构复制品。

第三条是 GUI 渲染：todo/goal 在 RPC 模式推 GuiComponent、TUI 模式推文本行，模式分派逻辑各写一份。

三条线的共同点：**知识只有一份，实现却有两份以上，且对齐手段是注释。**

### 1.2 设计目标（从使用者体验倒推）

本次为纯内部等价简化，终端用户与 LLM 可见行为零变化；「使用者」在本设计指两类：维护者（改规则的人）与双端协作语义本身。

| # | 目标 | 可见标准 |
|---|------|---------|
| G1 | 行为原语单一实现 | pid 判据/进程树 kill/tail/原子写/LRU/registry 解析防御在仓内各只有一份实现（extension-protocol），bte 与 runtime 改 import；任一侧修改语义，另一侧编译期即见 |
| G2 | bt- 对账判据与 pending 差集规则同源 | bte `collectUnsettledTaskIds` 删除，对账消费 protocol 差集核心；对账与 goal 守卫对同一 session 文件得出一致的活跃集 |
| G3 | isGui 模式分派单点 | 「isGuiCapable 外层判定不可省略（TUI 误调 marker 乱码）」这条约束被编码进 protocol helper 一次，todo/goal 消费方不再各自持守卫注释 |
| G4 | 零用户可见回归 + bte 独立性保持 | **用户/LLM 可见行为与 registry.json 文件字节形态零变化**；内部 API 签名归一（tail 字段名/参数序、registry 读写薄壳）、日志通道经回调注入的适配、对账 emit 恒 no-op 死路径删除（D5）为**有意内部变化**（清单见 D2/D5）；bte 的 bash 后台/查询/kill 行为、pending optional peer 语义不变；纯 CLI 单独安装 bte（无 pending）仍功能完整 |

**In-scope**：`extensions/universal/base-tool-enhance/src/`（kill-tree/output-tail/registry/task-store/pending-reconcile/tool-error-audit 注释）、`packages/extension-protocol/src/`（新模块 + background-task.ts 补常量 + helpers）、`packages/runtime/src/services/`（reaper/registry-write/output-tail 改 import）、`extensions/universal/todo/src/index.ts`、`extensions/universal/goal/src/`（ports + projection/widget 消费侧）、`docs/design/base-tool-enhance.md` 与 `file-lock-unification-and-reaper-sink.md` 的边界登记回写。
**Out-of-scope**：
- **M5 索引补充说明**：M5（isGui 四分支跨包同构）未列入 `ext-simplify-index.md` 发现映射（索引漏项），由 07 号设计 :33 实读修正后移交本设计，在此显式接收；03 号设计 :184/:283 移交的「UiPort isGui 模式外泄」一并归入 E9。
- pending-notifications 的 W4 死代码区/registry 现算化/导出面收敛 = 12 号设计领地（`ext-simplify-12-pending-notifications.md`，已实施），本设计输出差集核心契约并经 E6 让其委托（v2：确定执行项）；
- goal UiPort 的 `theme` 成员声明（03 号设计 E3，模式分发与主题能力正交，:184 已划界）；
- bte 其余机制（poller/task-store 两层存储、force-patterns、config 5 键）——审计四问记录全部判定「本质复杂度」不可砍；
- relay 域的第 4 份 `isPidAlive`（`packages/runtime/src/infra/relay/relay-registry.ts:128`，不属审计 M12 面）——移交 code-simplify 评估改引（见 §5.4）。

---

## 2. 现状与问题分析

**本章结论：三类跨包知识（registry 行为原语、bt- 差集规则、isGui 模式分派）各自存在 2 份以上实现，对齐手段是注释，且 tail 一处已经实际漂移——失败模式 F1-F4 全部由此而来。**

### 2.1 现状的真实样子（取自代码）

**例 1：pid 身份判据逐字双写。** 「当前占用 pid 的进程是不是当年登记的那个进程」的判定（防 pid 复用误杀，设计 `base-tool-enhance.md` §3.6「宁不杀勿误杀」）在两侧各有一份：

```ts
// extensions/universal/base-tool-enhance/src/kill-tree.ts:143-151
export function pidStartMatchesRegistered(actualStartSec, registeredStartSec, startedAtMs) {
  return registeredStartSec !== undefined
    ? actualStartSec === registeredStartSec
    : actualStartSec <= Math.floor(startedAtMs / MS_PER_SECOND);
}
// packages/runtime/src/services/session/background-task-reaper.ts:202-210 —— 逐字相同
```

同文件族里 `isPidAlive`（kill-tree.ts:30 / reaper.ts:98）、`killProcessTree` + Windows 分支 + pgrep 递归（kill-tree.ts:44-109 / reaper.ts:114-170）、`getProcessStartTimeSec`（kill-tree.ts:117 / reaper.ts:178）全部逐字级重复（唯一差异是日志通道：extension 用 `getLogger("base-tool-enhance")`，runtime 用 `console.debug`）。bte 侧消费点：`bash-kill-tool.ts:99,103,128`、`spawn-background.ts:192,256,272`、`pending-reconcile.ts:158`；runtime 侧消费点：reaper 自身 + `background-task-service.ts:34-36`。

**例 2：tail 已经漂移。** 同一个「末尾字节窗口 + 余量、残首行丢弃、行/字节双上限」算法，两侧 API 形态已分叉：

| 维度 | bte `background/output-tail.ts:34` | runtime `background-task/output-tail.ts:36` |
|---|---|---|
| 签名 | `(file, maxLines=2000, maxBytes=51200)` | `(file, maxBytes=32768, maxLines=2000)` |
| 返回 | `{ output, truncated }` | `{ text, truncated }` |
| 备注 | 另有 bte 私有 `readTailSummary`（通知摘要） | 默认 32KB 是桌面 RPC 的有意口径（D3） |

算法主体逐行同构，参数顺序却相反——未来任何一侧单修 bug（如残行判定边界），另一侧静默保持旧行为，且没人能从签名看出它们曾是同一个函数。

**例 3：registry 文件行为四份 LRU + 双份解析防御。** 「终态条目按 `endedAt ?? startedAt` 升序、超上限淘汰最老」在 4 处重复（见审计修正 2）；原子写 `atomicWriteRegistry`（tmp 名 = pid + 36 进制随机段 + rename）在 bte `registry.ts:154-171` 与 reaper `:306-321` 逐字相同；「解析失败 → `.corrupt` 改名保留现场 + 空表重建」在 bte `registry.ts:72-126` 与 reaper `:237-291` 同构。bte 本地 `isValidRegistryEntry`（registry.ts:56-69）与 protocol 已导出的 `isBackgroundTaskRegistryEntry`（background-task.ts:113-126）逐字相同——u-bte-remove 契约迁移漏掉了这一个 guard。

**例 4：bt- 差集双写。** bte 对账判据（`pending-reconcile.ts:77-95` `collectUnsettledTaskIds`）与 pending 守卫判据（`state.ts:98-111` `countActiveFromEntries`，12 号终态结构 = 私有 `scanPendingEntries` 分流 :141-158 + `filterActiveRegisters` 差集过滤 :160-187 两层组合）共享同一套规则：`pending:register` 首见去重 + `pending:unregister` 全局抵消 + id 全局唯一前提；差异只在过滤层（bte 只认 `bt-` 前缀；pending 叠加 types 过滤/currentSessionId 过滤/normalize 归一）。规则本体写了两份——且 pending 侧先后经历 W4 翻档与 12 号「entries 现算化」两轮改造（state.ts:10-17 文件头自述「历史的内存 registry、session_start 重建、TTL 与 shutdown 机器已删除」），证明这套规则是活动决策，bte 侧复制品不会跟随演化。

**例 5：isGui 四分支 ×2。** todo（`index.ts:48-65`）与 goal（`projection/widget.ts:200-230`，经 UiPort；3 处 2×2 在 :206-207/:218-219/:224-229——03 号实施后偏移）各自维护同一结构：`const isGui = ...; 有内容时 isGui ? guiSetWidget(payload) : setWidget(lines)；清屏时 isGui ? guiSetWidget(undefined) : setWidget(undefined)`。而 `guiSetWidget(ctx, key, undefined)` 现状两分支都落到 `ctx.ui.setWidget(key, undefined)`（protocol helpers.ts:65-78）——**清屏分支的模式判别本来就是死分支**。「isGuiCapable 外层判定不可省略，否则 TUI 误调 marker 乱码」这条守卫约束的说明注释在 helpers.ts:59-60、todo index.ts:44-46、goal adapters/ports.ts:52-54 三处重复。

### 2.2 真实失败模式

| # | 失败模式 | 触发条件 |
|---|---------|---------|
| F1 | 双端对同一 registry 条目判定分叉（一侧修了 pid 判据/LRU 规则，另一侧静默旧行为）→ 误杀/漏杀语义不一致 | 任一侧单点修 bug 或调参（tail 已实际发生） |
| F2 | pending 差集规则演化（W4 已演示一次）后 bte 对账判据停留在旧语义 → 对账漏收尾或误收尾，goal 守卫与对账对同一 session 得出不同活跃集 | pending 侧改 register/unregister 语义 |
| F3 | 新 extension 作者复制 todo/goal 的四分支样板，漏掉 isGuiCapable 外层判定 → TUI 模式推 marker 行乱码（守卫约束靠注释传播） | 新增带 widget 的 extension |
| F4 | 维护者按 bte 侧签名记忆调用 runtime 侧 tail（或反之）→ 参数静默错位（maxLines 当 maxBytes 传） | 跨端改代码时 |

### 2.3 根因

**跨端共享知识的落点缺失。** runtime 不 import extension 包内非导出源码（runtime `output-tail.ts:4-7` 注释明示：extension 代码属 pi 进程侧源码树，runtime bundle 不引用 extension 内部模块）；runtime **可以**经 npm 子入口消费 extensions/shared 组的包——`pi-file-lock` 即现存先例（runtime `utils/file-lock.ts:46` `import { acquireLock, ... } from '@zhushanwen/pi-file-lock/core'`，tsup noExternal 亦列该包，14 号 shared-libs 实施后的统一形态）——但 bte 的原语不在 extensions/shared，所以收殓下沉时只能「移植」不能「共享」，注释对齐成了唯一纽带。而**双方唯一都已依赖的共同包是 `@xyz-agent/extension-protocol`**（runtime tsup `noExternal` 已列它；bte dependencies 已列它），契约形状已经下沉成功（background-task.ts），行为原语却是同一批迁移里漏掉的那一半。M13/M5 同理：差集规则与模式分派都是「双方/多方都需要的协议级知识」，只是还没人给它们建 protocol 落点。

---

## 3. 解决方案

**本章结论：5 个决策——行为原语下沉 protocol（D1/D2）、差集规则下沉 protocol 并否决强依赖（D3）、isGui 分派收敛为 helper（D3-M5）、两个 contested low 按「兼容承诺优先」关闭（D4/D5）；全部改动为等价替换。**

### 3.1 终态（使用者视角先行）

终端用户/LLM 视角：**什么都不变**。后台 bash 照常启动/查询/kill/收通知；桌面侧边栏照常预览与 kill；TUI 照常文本行、桌面照常组件。变化只对维护者可见——以「修一次 tail 残行判定边界」为例的终态：

```
维护者在 extension-protocol/src/output-tail.ts 修一处窗口裁剪逻辑
  → bte 侧 bash_output（50KB 口径）与 runtime 侧桌面预览（32KB 口径）
    下次构建同时获得修复，无 second PR、无注释互指、无漂移窗口
同理：pending 侧若改差集规则 → protocol 核心 → bte 对账编译期跟随
     todo/goal 的 widget 推送 → 一行 setWidgetDual 调用，守卫内置于 helper
```

失败路径（实施期探针不过的降级，详见 §5.3）：若 bte builtin 打包对 protocol 新模块出现打包/解析问题（P1），回退方案乙（bte 内收敛 + 跨包重复登记）并回本设计重审 D1；若归一后 registry 文件字节不兼容（P2），修 protocol 单点序列化后重验，不许两侧各自加兼容分支。

### 3.2 决策一（M12）：行为原语下沉 extension-protocol

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 甲：下沉 protocol，两侧改 import（选） | 双端共同依赖的唯一合法落点，契约形状下沉（u-bte-remove）的补全；「改一处两侧生效」构造性成立 | 中：protocol 新增 3 模块 + 子出口配置 + 两侧删本地改 import + 测试改 import 路径；机械性高 | 打包面风险被子出口结构性消除（node 内建模块不进 index 桶出口，renderer/core 零触达——见 D2）；归一签名需一次定型（D2） | ✅ |
| 乙：bte 内收敛 + 观望 | 跨包 4 份 LRU/2 份 pid/2 份 tail/2 份原子写维持注释对齐——F1/F4 漂移面原样保留，且 tail 已实证漂移 | 低（只删包内重复 + guard 改引 protocol） | 漂移已经发生（审计修正 3），观望 = 等第二次 | ❌ |
| 丙：新建 extensions/shared 共享包 | 双端可达性**成立**（runtime 经 npm 子入口消费 extensions/shared 包有 pi-file-lock/core 现存先例，§2.3）——但为 3 组原语新增第 26 个包，而双端已共同依赖的 protocol 且已承载同域 background-task 契约 | 中（新包脚手架 + 双端接线 + 发布管线） | 同域知识分裂到两个包（契约在 protocol、行为在 shared）= 维护成本 > 收益 | ❌ |

- **采用**：protocol 新增 `src/background-task-process.ts`（isPidAlive / killProcessTree / getProcessStartTimeSec / pidStartMatchesRegistered，锚定 reaper.ts:92 既有段注释「pid 探测 / 处置原语」）、`src/background-task-registry-file.ts`（registry 解析 + corrupt 隔离 + 原子写 + 终态 LRU 裁剪纯函数）、`src/output-tail.ts`（tail 算法，两侧既有同名模块）；`background-task.ts` 补 `BACKGROUND_TASK_ID_PREFIX = 'bt-'` 常量（契约注释 :60-61 已提及该前缀，升级为导出常量；以上新导出名均为建议新增 API）。
- **被否**：方案乙/丙理由见表；另否「原语放进既有 background-task.ts 契约文件」——契约（形状 + guard）与行为（spawnSync/文件 IO）不变量不同，混装让 127 行契约文件膨胀且行为改动会被迫动契约文件版本。
- **证据**：runtime tsup.config.ts:57 noExternal 已含 `@xyz-agent/extension-protocol`；bte package.json dependencies 已含；reaper.ts:8-11 自认「实现独立于 extension 源码——契约类型一律取 extension-protocol」（形状已下沉、行为没下沉的割裂现状）。
- **效果**：G1 成立；F1/F4 消灭。

**D2 归一策略（M12 的签名定型 + 出口形态 + 日志通道）**：
- **出口形态（v2 主方案 = 独立子出口，结构性隔离浏览器消费面）**：三个新原语模块均含 node 内建顶层 import（process = `node:child_process`，registry-file/output-tail = `node:fs`），而 protocol 的 12 个消费包中 renderer（vite 浏览器环境，如 `BackgroundTaskDetailPanel.vue:151`）与 core（同构，`transport/mock/run-send-stream-branches.ts:7`）只从 index 桶出口 import——若原语进 index，浏览器构建对 `node:` 内建的处理依赖 vite externalize/tree-shake 行为（protocol 无 `sideEffects` 声明，保守 tree-shake 下新模块代码可能进 bundle）。**主方案**：package.json `exports` 增子出口 `"./background-task"`（指向新增聚合模块 `src/background-task-entry.ts`，re-export 三个原语模块；`publishConfig.exports` 与 tsup entry 同步配置），三个原语模块**不进 index 桶出口**——renderer/core 消费面结构性不触达 node 内建，bte/runtime 从子出口 import（`import { isPidAlive, ... } from '@xyz-agent/extension-protocol/background-task'`）；契约常量 `BACKGROUND_TASK_ID_PREFIX` 与纯算法模块 `pending-entries.ts`（无 node 依赖）照常进 index。纯 CLI/桌面行为不受出口形态影响（同一份源码）。
- tail：单一签名 `(file, opts: { maxBytes: number; maxLines: number })` → `{ text, truncated }`（字段名从 runtime 的 `text`，比 `output` 中性且不与「输出文件」混淆；50KB/32KB 默认值**留在各自调用方**，不进 protocol 默认参数——两个口径都是各自产品决策）。bte `readTailSummary` 是 bte 私有需求，保留本地薄壳。
- 进程原语：签名不变；现有回退路径 debug 日志改为可选回调参数 `onFallback?: (step: string, err: unknown) => void`（protocol 零依赖纪律，不引 extension-logger；extension 侧传 `logger.debug` 适配、runtime 侧传 `console.debug` 适配）。
- **registry 文件原语与 output-tail 的日志通道（v2 补全，与进程原语同款注入模式）**：两模块同样持有日志语句且两侧通道不同（bte registry.ts corrupt 隔离 warn :105/:115/:119、tmp cleanup warn :165、write fail warn :199 走 `getLogger` 落盘；runtime reaper 对应 :275/:283/:286/:317/:356 走 `console.warn`；output-tail close 失败 debug bte :60 vs runtime :62）——统一改为可选回调 `onLog?: (level: 'warn' | 'debug', event: string, detail?: unknown) => void`：bte 侧注入 logger 适配（`(lvl, event, detail) => logger[lvl](event, { detail })`），runtime 侧注入 console 适配；**corrupt 隔离 warn 是排障生命线，两侧适配必接；close debug 可选**。protocol 自身零日志依赖，日志落盘路径（bte 经 extension-logger）与 console 通道（runtime）行为均与现状一致。
- registry 文件原语：导出「读（带 corrupt 隔离，返回 `{ entries, corrupted }`，runtime 现形态为超集）/ 原子写 / 终态裁剪」三个纯函数；bte `readRegistry`（Map 形态）与 runtime `readRegistryEntries`（数组形态）保留为各侧薄壳。
- LRU：纯函数 `trimTerminalEntries(entries, max)`（入参数组/出参保留集），bte task-store 与 registry、runtime registry-write 共用（task-store 用本地 `MAX_TERMINAL_TASKS` 常量传参，值不变）。

### 3.3 决策二（M13，核心 contested 裁决）：bt- 差集规则归一——选 B 下沉 protocol，否 A 强依赖

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A：bte 对 pending 提强依赖，直接 import `countActiveFromEntries` | 单一实现落在规则所有者（pending）处；goal/subagent-workflow 已有同款静态强依赖登记先例（`extension-dependencies.json` 两条件：subagent-workflow→pending 与 goal→pending 均登记「代码层静态 import countActiveFromEntries……是强依赖」——goal 的登记在其 dependsOn 第三项，v1 引用行号归属错位已在审计修正 6 更正） | 低（改 import + 过滤 bt- 前缀） | **推翻 D16 拍板**：bte 的 pending 依赖按设计 `base-tool-enhance.md` D16 是 optional peer（「未装则通知链路缺失但 bash 后台功能完整」）；静态 import 使 pending 缺失时**模块加载即抛 = bash 工具整个不可用**。审计方案 A 附带的「运行时 try-detect」属 notify.ts:22-27 已否决的「硬造检测机制」类别；且 optional peer 在 esbuild builtin 打包下动态 import 的解析路径脆弱 | ❌ |
| **B：差集核心下沉 protocol（选）** | 差集规则本质是 pending entry 的**落盘形态语义**（customType 字符串 + 抵消/去重规则）——与 background-task.ts 契约同类的跨层落盘契约，protocol 是其既定归属；bte 零新增依赖边 | 低-中：protocol 新模块 `pending-entries.ts` ~60 行（两层 API，见采用段）+ bte 删 `collectUnsettledTaskIds` 改 import + pending 侧委托（E6，12 号已落地后为确定项） | API 形状须同时服务两个消费者（bte 要差集 Set / pending 要分流列表）——v2 已按两层蓝图定型，形状错位风险消除 | ✅ |

- **采用（v2：两层 API 蓝图）**：protocol 新增 `src/pending-entries.ts`（建议新增 API，纯算法无 node 依赖，进 index 桶出口）：
  - `PENDING_REGISTER_ENTRY_TYPE` / `PENDING_UNREGISTER_ENTRY_TYPE` 常量；
  - **底层分流原语** `scanPendingEntries(entries): { registerEntries: Array<{ data: Record<string, unknown> }>, unregisteredIds: Set<string> }`——单趟把 entries 分流为 register 流水与注销 id 集（12 号终态 pending `state.ts:141-158` 同形语义；protocol 侧 data 用最小结构类型，消费方自行窄化）；
  - **差集本体** `applyPendingDiff(scan): Array<{ data }>`——register 首见去重 + unregister 全局抵消 + id 非法跳过（规则本体，单点）；
  - **上层差集组合** `collectActivePendingIds(entries, opts?: { idPrefix?: string }): Set<string>`——scan + diff + 可选前缀过滤 → id 集（bte 便利入口）。
  bte 侧 `collectUnsettledTaskIds` 删除，对账改调 `collectActivePendingIds(entries, { idPrefix: BACKGROUND_TASK_ID_PREFIX })`（其 `:77-95` 现实现的语义 = scan + diff + 前缀过滤，单点替代后逐语义等价，含「register→unregister→register 同 id 复用」边界——§5.4 待验证①的契约测试锁定）。先例辨析：goal/subagent-workflow 的强依赖成立，是因为 pending 查询是它们的核心功能（continuation 守卫/后代判定）；bte 的 pending 依赖仅通知增强，D16 的 optional 语义是拍板过的产品决策，M13 无推翻它的理由。
- **被否**：方案 A 见表；「维持现状 + 注释互指」= F2 原样保留（审计 contested 项用户已拍板必须执行，不改也是未落实）。
- **证据**：bte package.json `peerDependenciesMeta.@zhushanwen/pi-pending-notifications.optional: true`；notify.ts:22-27（D16 静态声明理由 + 检测机制否决）；pending `state.ts:98-111`（countActiveFromEntries = scan :141-158 + filter :160-187 组合，12 号终态实读）与 bte `pending-reconcile.ts:77-95` 实读同构比对；protocol background-task.ts:60-61 已把 bt- 前缀写进契约注释。
- **效果**：G2 成立（**以 E6 落地为完成件**）；F2 消灭。**E6（归一完成件，v2 收死为确定执行项）**：pending `state.ts` 的 `countActiveFromEntries` 内部改为委托 protocol 的 `scanPendingEntries` + `applyPendingDiff`，其 `filterActiveRegisters` 收窄为 pending 特有过滤层（types 归一 / currentSessionId 过滤 / `normalizeRegisterEntry` :206-216 归一——这些是 pending 产品语义，不下沉）；差集本体（去重+抵消）自此单点。12 号已实施完成（state.ts 重排已落地、领地已释放），v1 的「协调规则/暂缓」分支不再存在——**若 E6 不落地，`collectActivePendingIds` 真实调用方仅 1 个（bte 对账），F2 的漂移面（pending 侧规则演化后 bte 对账停留旧语义）原样保留，只是把其中一份换了位置；G2 的「同源」声称以 E6 落地为前提**。

### 3.4 决策三（M5）：isGui 模式分派收敛为 protocol 组合 helper

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 协议 helper：`setWidgetDual(ctx, key, content: { gui; text } \| undefined)`（建议新增 API）（选） | 「TUI 误调 marker 乱码」守卫编码一次；审计 M12 定向 + 07 号设计 :33「修复点在 extension-protocol 组合 helper」既定方向；顺带消灭清屏死分支（§2.1 例 5） | 低：helper ~15 行 + todo/goal 消费侧改写 | goal 侧 UiPort 接口收敛与 03 号设计 E3 同文件（ports.ts）——:184 已划界「theme 成员声明保持不变，模式分发归 13」 | ✅ |
| 各包本地塌缩：不新增 API，各包删清屏死分支、保留 isGui 判定 | 零新 API 面，但 2×2 分派样板与守卫注释仍在 2 包复制，F3 不消灭 | 最低 | 与审计/07 号移交方向相悖，contested 项未落实 | ❌ |

- **采用**：protocol `core/helpers.ts` 增 `setWidgetDual`——content 为 undefined 时清屏（`ctx.ui.setWidget(key, undefined)`，模式无关）；有内容时 `isGuiCapable(ctx) ? guiSetWidget(ctx, key, content.gui) : ctx.ui.setWidget(key, content.text)`。todo `makeRefreshDisplay` 四分支 → 两次调用；goal 侧按 03 号 :184 预留的收敛形态：UiPort 删 `isGui`/`setGuiWidget` 成员，`setWidget` 签名改 dual payload（顺带删除 `string \| string[]` union 中零调用方的 string 臂），adapter delegate 到 helper，`updateWidget` 三处 2×2 塌缩。`hasUI` 守卫留在调用方（goal 的 FR-6.6 语义，helper 不感知）。payload 构造说明：`content: { gui, text }` 按值立即构造两侧——`buildGoalGui`/`renderWidgetLines` 均为廉价纯函数，成本可忽略；实施可留 lazy 自由度（payload 形态传 getter 或对象均可），不构成约束。
- **被否**：本地塌缩见表。
- **证据**：protocol helpers.ts:59-60（guiSetWidget 无守卫的自述）、:65-78（undefined 双分支同落 setWidget——清屏死分支实证）；todo index.ts:44-46 与 goal adapters/ports.ts:52-54 的重复守卫注释。
- **效果**：G3 成立；F3 消灭。

### 3.5 contested low 裁决（审计四问记录发现 5/6，必须本设计关闭）

**D4：审计 entry customType `unified-hooks:tool-error` 的处置（选定：不改名）**
- **采用**：保持 customType 原值不变，仅修正 `tool-error-audit.ts:7` 注释——由「消费方无感」改为「无代码消费方；保持旧名是历史 entry 可查询性承诺（01 号设计 P-protocol / README 承接表），废弃包名残留为已接受代价」。
- **被否**：审计方向「改名为 `base-tool-enhance:tool-error`」——存在兼容承诺：①01 号设计（`ext-simplify-01-unified-hooks-llm-shared.md:32`）把「bte 保持原 customType 字符串」立为删包的**关键协议承诺**（P-protocol 探针 + 验收场景 5 + :202「协议字符串 SSOT」白名单条目），改名 = 两设计正面冲突；②bte CHANGELOG.md:56/:69 与 README.md:3 已向用户承诺 "same type as the deprecated unified-hooks extension so history stays queryable"——历史 session entry 用旧名，改名后新旧混杂使「按名查询历史」承诺打折；③审计发现 5 自己证实的「无代码消费方」只否定「改名会断代码链」，不构成改名收益。
- **证据**：tool-error-audit.ts:7,:76 实读；ext-simplify-01 :32/:153-167/:202；bte CHANGELOG.md:56/:69、README.md:3。
- **效果**：01 号设计 P-protocol 承诺与验收场景 5 不受影响；已接受代价四要素——量级 = 排查者看到旧包名的一次误判可能；恢复路径 = 修正后注释 + README 指引；重审触发 = 未来出现按 customType 过滤的脚本生态时再评估；显式判定 = 可接受。

**D5：对账「尽力补 emit」第二写路径（v2 重裁：删除 + 同批回写拍板文本；v1「保留 + 补注释」被 12 号终态击穿）**

> **重裁背景**：v1 选「保留 + 按四问记录建议补注释（『pending 内存 registry 仅在其自身 session_start rebuild 后非空——本路径只服务该毫秒级窄窗口』）」。该裁决的两个前提均已被 12 号（pending-notifications，2026-09-12 实施）推翻：①「内存 registry / session_start rebuild」机制已被 12 号物理删除（state.ts:10-17 文件头自述）；②「不一致窗口拉长」的代价已不存在——12 号终态下 pending 的 unregister listener 落盘前置 `isPendingActive` 对 entries **现算**（pending index.ts:186-191），而 bte 对账的 `appendEntry` **同步入账**（pi dist 实证）先于 emit 执行，emit 到达时该 id 必已注销 → listener 恒跳过。**emit 的落盘效果恒 no-op（除 debug 日志外零副作用），这是结构性事实而非极端情况**。且 12 号实施已把 bte `pending-reconcile.ts` 文件头（:15-19）与 emit 前注释（:135-137）改写为新口径（「其内存 registry/rebuild 已随 ext-simplify-12 删除，emit 到达时该 id 已注销即跳过，失败无害」）——按 v1 设计补旧口径注释 = 把 12 号写好的正确注释改回自相矛盾。
>
> **反例重演（删除后行为核对）**：①emit 仅在 appendEntry 成功后调用（失败则 continue 跳过），无「emit 成功而 appendEntry 失败」路径；②「register→unregister→register 同 id 复用」等差集边界与 emit 无关（对账判据走 appendEntry 落盘面）；③仓内监听 `pending:unregister` 的只有 pending 自身（全仓 grep），第三方 extension 监听生态不存在（私有 extension 体系，无证据）——删除不影响任何现存消费者；④pending 未安装场景：emit 本就无人收（D16 optional 语义），删除等价。**无反例击穿删除**。
>
> **遗留文档漂移连带处理（v2.1 扩范围：接入细则 4 段内**全部**12 号前机制口径，共三处）**：`base-tool-enhance.md` §3.5 接入细则 4（现 :333）在 12 号终态下有三处旧机制论据——①「appendEntry 之外可尽力补一次 emit（listener 就绪时同步其内存视图，缩短 `pending_notifications` 工具列表的不一致窗口，失败无害）」；②「**不走 bus emit 作为权威路径**：pending-notifications 的 unregister listener 落盘条件是『其内存 registry 该 id active』（index.ts:174-198，changed=false 时静默不落盘、无报错），而其内存 registry 只在自身 session_start rebuild 后非空……」——②中的「内存 registry / changed 标志 / rebuild」均已被 12 号删除（现 listener 前置 = `isPendingActive` 对 entries 现算，index.ts:185-191）；③appendEntry 权威论证句括号注「不读 pending-notifications 内存 registry」指称已删除机制（论证主体「goal 从 getEntries() 算差集」仍真实，仅括号注指称过时）。12 号实施回写了该文档 D16 行（:175）但漏了这三处。v2 删除 emit 时**同批回写整段口径**（参照 :175 D16 行的回写先例形态）：①句追加「该 emit 步骤已随 ext-simplify-13 删除——pending 内存 registry 已随 ext-simplify-12 删除后 listener 对 entries 现算、对账 appendEntry 同步入账，emit 到达时必已注销 = 恒 no-op；appendEntry 即唯一权威路径」；②句论据更新为新口径（listener 落盘前置 = `isPendingActive` 现算判定，「不走 emit 作为权威」的结论不变——新口径下 emit 的权威性更差：即使 listener 就绪，appendEntry 已同步入账，emit 恒 no-op）；③括号注改写为「pending 无内存状态，entries 是唯一状态源」。

- **采用（v2）**：删除 `pending-reconcile.ts:135-144` 的尽力 emit 路径（emit 调用 + try-catch + 旧口径注释，-12 行 -1 层概念）；同批回写 `base-tool-enhance.md` :333 接入细则 4 段内**三处** 12 号前机制口径（emit 句删除登记 + 「不走 bus emit 权威」论据刷新 + 括号注改写，见重裁背景）；文件头 :15-19 注释的 emit 句同步删改。拍板精神的兼容性：细则 4 拍板的核心是「appendEntry 是权威路径、emit 不得作为权威」（反对 bus emit 依赖 listener 存活），删除 emit 恰是彻底贯彻「appendEntry 唯一权威」，与拍板精神一致而非推翻。
- **被否（v2 记录）**：
  - **v1 方案「保留 + 补旧口径注释」——被 12 号终态击穿**（重裁背景：注释前提失效 + 现状注释已正确，补写 = 改错；「不一致窗口」代价不存在使保留论证失去实质收益）。
  - **「保留 + 登记恒 no-op 为已知事实」**——为一段已知恒空转的代码维护解释性注释，恰是本设计（过度设计收敛）要消灭的形态；「万一 pending 恢复内存视图」是想象未来（12 号刚以「entries 现算」为终态删掉该机制），不构成保留理由。
- **证据**：pending-reconcile.ts:15-19（文件头新口径注释）、:135-144（emit 路径）、:128-131（appendEntry 成功后紧接 emit 的顺序）；pending index.ts:186-191（listener 现算判定）；base-tool-enhance.md :333（旧口径句）/ :175（D16 行回写先例）。
- **效果**：-12 行死路径；「同文件两种机制描述」的矛盾风险消除；G4 的有意变化清单登记（emit 删除不改变任何用户/LLM 可见行为——V1 的 unregister entry 落盘断言不受影响）。

### 3.6 执行项总表

| # | 位置 | 改动内容 | 类别 |
|------|------|---------|------|
| E1 | protocol `src/background-task-process.ts`（新）、`src/background-task-registry-file.ts`（新）、`src/output-tail.ts`（新）、`src/background-task-entry.ts`（新，子出口聚合）、`background-task.ts`、`index.ts`、package.json、tsup.config | 三新原语模块按 D1/D2 落地 + `BACKGROUND_TASK_ID_PREFIX` 导出（进 index）；**package.json `exports` 增 `"./background-task"` 子出口（publishConfig.exports 与 tsup entry 同步）**，三原语模块不进 index 桶出口（renderer/core 结构性零触达，D2 出口形态）；`pending-entries.ts` 进 index；顺带把 index.ts:2 / package.json description / **README.md 首段**的「GUI 渲染协议」更新为覆盖多域契约的表述（v2 补 README 面） | 直接执行（D1） |
| E2 | bte `kill-tree.ts`、`background/output-tail.ts`、`background/registry.ts`、`background/task-store.ts` | 删本地原语改 import protocol 子出口（kill-tree.ts 整文件删除，消费点改 import）；registry.ts 删本地 guard/parse/atomicWrite/LRU 改引（日志经 onLog 注入 logger 适配）；task-store `evictTerminalOverflow` 改用 trim 纯函数；output-tail.ts 薄壳化（readTailSummary 保留）。**LLM 可见契约字段保持**：bash_output 工具返回的 `output` 字段名不变——bte 薄壳做字段名适配（`{ output: r.text, truncated }`）或调用点一行映射（bash-output-tool.ts:99 `output: tail?.output ?? "<lost>"` → `tail?.text`），工具 schema 与返回 JSON 形态零变化 | 直接执行（D1/D2） |
| E3 | runtime `session/background-task-reaper.ts`、`background-task/registry-write.ts`、`background-task/output-tail.ts` | 删本地原语改 import protocol 子出口（reaper 保编排层：三分支判定/双触发面/锁壳；registry-write `writeTrimmedLocked` 改用 trim；output-tail 删实现、`OUTPUT_TAIL_DEFAULT_MAX_BYTES` 留作调用方实参；日志经 onLog/onFallback 注入 console 适配） | 直接执行（D1/D2） |
| E4 | protocol `src/pending-entries.ts`（新）+ index 出口 | 差集两层 API：常量 + `scanPendingEntries`（分流原语）+ `applyPendingDiff`（差集本体）+ `collectActivePendingIds`（bte 组合）（D3-B，v2 两层蓝图） | 直接执行（D3） |
| E5 | bte `background/pending-reconcile.ts` | 删 `collectUnsettledTaskIds` 改 import `collectActivePendingIds`；`BTE_TASK_ID_PREFIX` 本地常量改引 protocol（或 re-export 保持测试兼容）；**D5：删除尽力 emit 路径（:135-144）+ 文件头注释 emit 句删改** | 直接执行（D3/D5） |
| E6 | pending `state.ts` | 删私有 `scanPendingEntries` 改 import protocol 版，`countActiveFromEntries` 委托 `scanPendingEntries` + `applyPendingDiff`，`filterActiveRegisters` 收窄为 pending 特有过滤层（types/sessionId/normalize 不动）；**state.ts 全部三个差集消费点**（`countActiveFromEntries` :98-111 / `hasPendingId` :118-120 / `isPendingActive` :128-132——后两者已内建在 scanPendingEntries 之上，isPendingActive 的「抵消 + 存在」判定即差集本体的单 id 特化）随私有 scan 删除自动消费 protocol 原语，无需单独迁移；**v2：12 号已落地，从协调项收死为确定执行项** | 直接执行（D3，v2 确定项） |
| E7 | protocol `core/helpers.ts` + helpers.test | `setWidgetDual` 建议新增 + 测试（含 TUI 不产 marker 断言） | 直接执行（D3-M5） |
| E8 | todo `src/index.ts` | makeRefreshDisplay 四分支 → setWidgetDual；删重复守卫注释（守卫已内置） | 直接执行 |
| E9 | goal `src/ports.ts`、`adapters/ports.ts`、`projection/widget.ts`、`session.ts` | UiPort 删 isGui/setGuiWidget、setWidget 签名改 dual（theme 成员归 03 号 E3 不动）；adapter delegate helper；updateWidget 塌缩；session.ts:129 调用形态兼容 | 直接执行（03 号 :184 联动兑现） |
| E10 | bte `tool-error-audit.ts:7` | 注释修正（D4，不改 customType） | 直接执行 |
| E11 | `docs/design/base-tool-enhance.md` + `docs/design/file-lock-unification-and-reaper-sink.md`（或 base-tool-enhance.md 设计演变段） | **base-tool-enhance.md :333 接入细则 4 段内三处 12 号前机制口径回写（D5 删除的连带登记：emit 句删除登记 + 「不走 bus emit 权威」论据刷新 + 括号注改写，参照 :175 D16 行回写先例）**；登记「纯 CLI 独立安装无 runtime 收殓兜底」为已接受边界（审计四问记录发现 8，doc-right）；`bash-kill-tool.ts` 错误文案 runtime 指引——**已评估并落地（v2.3）**：cross-process 分支 hint 原写死 runtime 收殓承诺在纯 CLI 形态失真，改为「事实陈述（孤儿自行存活）+ inside the xyz-agent runtime 条件式收殓 + standalone pi 可操作 kill -- -<pgid> 指引」；pid-reuse/start-time 两段评估为无 runtime 存在性假定不改 | 直接执行（登记类） |

**移交 code-simplify 清单**（low 级、非 contested，实现阶段批量执行；行号为本次实读）：
1. `task-store.ts:53-55` getTask 零生产调用——建议方向：让 `bash-output-tool.ts:84` / `bash-kill-tool.ts:65` 的 `getAllTasks().find(...)` 改用 getTask（语义等价 O(1)），而非删除（测试断言面大）；
2. task-store 包装链（getActiveTasks→countActiveTasks→oldestActiveTask，task-store.ts:63-74）——三函数各有唯一生产消费方（poller.ts:54 / process-exit-guard.ts:77 / spawn-background.ts:115-116），非死代码，仅评估内联层数；
3. `config.ts:49-51` getConfigFilePath 声明不实 + 4 处 warn 内联（:66,:84,:112,:145；审计修正 5）——改用该函数或降非导出并修注释；
4. `poller.ts:23` POLL_INTERVAL_MS 去 export（仅本文件 :41 消费）；`background/types.ts:25-33` re-export 垫片维持现状（四问记录判定包内短名有可读性收益，不强求）；
5. relay-registry.ts:128 本地 isPidAlive 改引 protocol 原语的评估（out-of-scope 项的后续）。

---

## 4. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「中」（跨 4 包等价替换 + 双端行为契约），6 个真实场景验收，每个回溯 §1.2 目标；单测（bte 12 文件 / runtime 4 套 / protocol 新增）仅作回归辅助。**

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | M13 对账一致性（bt- 僵尸收口） | G2 | 本地 pi CLI 装好 bte + pending（`pi --mode rpc --session-dir <tmp> --extension <bte> --extension <pending>`）：起 background `sleep 3600` → `kill -9 <pi_pid>`（复现孤儿+僵尸 register）→ 新建 session → resume 原 session → `pending_notifications` 工具 list | resume 后该任务非 active（对账补写的 `pending:unregister` entry 落盘，JSONL 中 entry 形态 `{id, reason, status}` 与改动前逐字段一致）；激活 goal 时 continuation 不被僵尸卡死 |
| V2 | bte 后台 bash 全流程（含 tail 归一后口径） | G1 G4 | pi CLI：`pnpm test` 白名单强转后台 → 立即得 task_id → 产出 >50KB 输出的任务后 `bash_output` 查询 → `bash_kill` 一个 running 任务 | task_id 即时返回；`bash_output` 输出为末尾内容且 truncated 标记在 50KB/2000 行口径正确（与改动前一致）；kill 后 `pgrep -f` 进程组消亡 |
| V3 | runtime 双端协作不回归（含 corrupt 日志落盘） | G1 | `pnpm dev` 桌面端：session 起后台 dev server → 强杀该 pi 进程 → 重启 app → 观察启动期兜底收殓；再对 running 任务点桌面 kill 按钮；另预置一份损坏 registry.json（截断 JSON）触发 bte 侧读取 | `pgrep` 确认孤儿被补杀、registry 条目转 orphaned；侧边栏输出预览正常（32KB 口径不变）；kill 后 bte 轮询器经 D6-en killing 读回正常收尾（两侧经同一 registry 文件握手成功）；**corrupt 场景：bte 侧 `~/.pi/agent/logs/` 含经 onLog 注入的「registry corrupted, quarantined」warn（protocol 单点措辞，v2.2 修正——旧 bte 措辞 renamed to preserve scene 已随归一变为 quarantined；extension-logger 落盘路径不变），runtime 侧 console 输出对应 warn** |
| V4 | registry 文件邻居表面不变 | G1 G4 | 取 V2（bte 写侧）与 V3（runtime 写侧）各自产出的 registry.json：diff 改动前基线（version=1、indent 2、尾换行、字段序）；把改动前旧文件放入新版本环境跑 V3 | 文件逐字节同构；旧文件可被新代码正常读取收殓（无 version 迁移需求） |
| V5 | widget 双模渲染（含负面） | G3 | pi TUI 直载 todo+goal（`pi --extension <todo> --extension <goal>`）触发 widget；桌面 dev 触发同一扩展；`--mode json` headless | TUI：状态栏/widget 文本行正常，**无 `[GUI_WIDGET_MARKER]` 编码行**（负面断言）；桌面：组件渲染 + goal 终态后 widget 清除；headless 不渲染不报错 |
| V6 | bte 独立安装语义保持（负面） | G4 | 纯 CLI 只装 bte（无 pending-notifications）：后台 bash 启动/查询/kill 全流程 | 全部可用（对账因无 pending entries 恒 no-op 不报错）——D16 optional 语义未被 E5 破坏 |

环境基准遵循 AGENTS.md：extension 改动优先本地 pi CLI 实测（V1/V2/V5/V6），桌面链路用 dev 模式（V3/V5）；三连 `pnpm extensions:typecheck && extensions:lint && extensions:test` + runtime 包 vitest 全绿作为合入门禁（回归辅助，不替代上表）。

---

## 5. 下一层拆分

**本章结论：5 个执行单元，protocol 先行立单一实现、bte/runtime 两侧并行切换、todo/goal 独立收敛、pending 委托按领地协调；3 个实施期门探针把关。**

### 5.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 探针门 | 跑 §5.3 P1（打包面）；P2/P3 内嵌于验收场景 | ⛔ 不通过不开工 |
| M1 protocol 落地 | E1 + E4 + E7（protocol 侧全部新模块 + 单测，独立可验收） | G1/G2/G3 的单一实现就位 |
| M2 bte 侧切换 | E2 + E5 + E10 + E11 登记 | bte 行为零变更（V1/V2/V6） |
| M3 runtime 侧切换 | E3 | 双端闭环（V3/V4） |
| M4 M5 收敛 | E8 + E9（todo/goal 消费切换） | G3（V5） |
| M5 pending 委托 | E6（v2：确定执行项，12 号已落地） | G2 归一完成件 |

M1 先行（新模块与旧实现并存无冲突）；M2/M3 可并行（各自独立验收）；每阶段一个 commit，行为等价性由 V1-V6 把关。

### 5.2 执行单元与 justification

| 单元 | 说明 | justification |
|---|---|---|
| u1 = M1 | protocol 三新模块 + pending-entries + helper + 契约常量 + 单测 | protocol 是唯一无两侧依赖方向问题的包，先立单一实现再切消费方，避免中间态两份新实现 |
| u2 = M2 | bte 五文件切换 + 注释/登记 | bte 是原语的主要写侧，先行切换可尽早用 V1/V2 验证等价性 |
| u3 = M3 | runtime 三文件切换 | 依赖 u1；与 u2 无耦合可并行，独立跑 V3/V4 |
| u4 = M4 | todo/goal 消费切换 | 与 M12/M13 无依赖，独立验收（V5）；goal 侧需与 03 号 E3 同文件编排（见待验证） |
| u5 = M5 | pending 委托 | 归一完成件；12 号已落地领地已释放，单独拆出保持 G2 验收独立（V1 扩展：对账与 goal 守卫对同一 session 文件经同一 protocol 单点得出活跃集） |

### 5.3 探针清单（⛔ 实施期门）

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | ① bte builtin esbuild staging 与 runtime tsup 对 protocol **子出口** `./background-task` 的打包可用（import 解析、无 tree-shake 丢出）；② renderer/core 浏览器消费面零回归 | ① bte 打包产物 grep 新原语符号 + pi CLI 实跑（V2 载体）；runtime `bash scripts/validate-runtime-bundle.sh`（V3 载体）；② renderer `pnpm dev` 启动 + `pnpm build`（vue-tsc + vite production，覆盖浏览器构建路径）+ core vitest 跑通——index 桶出口面不变（三原语模块不进 index），renderer/core 理论零触达，此探针为实证回归确认 | ⛔ M0 | 子出口解析异常 → 核对 exports/publishConfig/tsup entry 三处同步后重试；仍失败 → 回退方案乙（bte 内收敛）并回本设计重审 D1。不采用「index 出口 + sideEffects:false」路线（结构性隔离优于 tree-shake 行为依赖） |
| P2 | 两侧经同一 registry.json 互换读写字节兼容 | V3 内嵌（桌面 kill 预写 killing → bte poller 读回收尾；bte 写文件 → runtime reaper 消费） | ⛔ M3 | 字节不兼容 → 检查 protocol 单点序列化（indent/换行/字段序）修正后重验；禁止两侧各加兼容分支 |
| P3 | TUI 模式经 setWidgetDual 不产生 marker 行 | V5 负面断言（helpers.test 增同款单测双保险） | ⛔ M4 | helper 守卫失效 → 修复 helper 单点；不回退到各包手写守卫 |

### 5.4 跨设计协调与待验证检查点（诚实标注）

- **E6 与 12 号设计的领地协调（v2 收敛）**：12 号已实施完成（2026-09-12，pending `state.ts` 重排落地、领地释放）——v1 的「12 号先落地 → E6 随该设计执行」分支条件已满足，**E6 定为本设计确定执行项**（M5 阶段交付，不再有「暂缓」分支，见 §3.3 效果段）。
- **E9 与 03 号设计 E3 同文件（goal ports.ts）**：03 号只加 `theme` 成员声明、本设计改模式分发成员——:184 已划界正交；03 号已实施（theme 成员已在 ports.ts:68-69），本设计实施时直接在其终态上改模式分发成员，无同文件冲突窗口。
- **01 号设计的 P-protocol 承诺**：D4 保持 customType 不变，01 号验收场景 5 不受影响；E10 注释修正需在 01 号 :202 登记行补一句「注释已修正、字符串承诺不变」的对账说明。
- **待验证**：①`collectActivePendingIds`（protocol 单点）对「register→unregister→register 同 id 复用」场景与 pending 侧语义的一致性（v2：两份实现已被单点替代，该测试从「两份实现一致性巧合检查」转为「protocol 单点语义锁定」——实施期补一条契约测试固化；id 全局唯一前提由设计 `base-tool-enhance.md` §2.3 task_id 编码保证）；②bte `maintenance-once.test.ts` / `index.test.ts` 对 reconcile 出口面的断言改写范围（collectUnsettledTaskIds 去 export 后的测试 import 路径）；③V1 的 JSONL entry 逐字段比对基线需在 M2 前采集（改动前跑一次留档）；④D5 emit 删除后 pending 侧测试若有对 emit 行为的间接断言（pending 测试 grep「emit」）需同批清理——实施期核对。

### 5.5 文件改动地图

| 文件 | 动作 | 归属 |
|---|---|---|
| `packages/extension-protocol/src/background-task-process.ts` | 新增（~90 行，含 4 原语 + onFallback） | E1 |
| `packages/extension-protocol/src/background-task-registry-file.ts` | 新增（~90 行：parse+corrupt 隔离 / 原子写 / trim 纯函数，含 onLog） | E1 |
| `packages/extension-protocol/src/output-tail.ts` | 新增（~60 行，opts 签名，含 onLog） | E1 |
| `packages/extension-protocol/src/background-task-entry.ts` | 新增（子出口聚合，re-export 三原语模块） | E1 |
| `packages/extension-protocol/src/pending-entries.ts` | 新增（~60 行，两层 API：scan + diff + 组合） | E4 |
| `packages/extension-protocol/src/background-task.ts` / `core/helpers.ts` / `index.ts` / package.json / tsup.config / README.md | 改（前缀常量 / setWidgetDual / index 出口（pending-entries，不含三原语）/ 子出口 exports 三处同步 / 描述与 README 首段） | E1/E4/E7 |
| `extensions/universal/base-tool-enhance/src/kill-tree.ts` | 删除（消费点 bash-kill-tool / spawn-background / pending-reconcile 改 import 子出口） | E2 |
| `.../src/background/output-tail.ts`、`registry.ts`、`task-store.ts`、`pending-reconcile.ts`、`tool-error-audit.ts` | 改（薄壳化 / 改 import / onLog 注入 / emit 路径删除） | E2/E5/E10 |
| `packages/runtime/src/services/session/background-task-reaper.ts`、`services/background-task/{registry-write,output-tail}.ts` | 改（删本地原语改 import 子出口 + console 适配注入） | E3 |
| `extensions/universal/todo/src/index.ts` | 改（四分支 → setWidgetDual） | E8 |
| `extensions/universal/goal/src/{ports,adapters/ports,projection/widget,session}.ts` | 改（UiPort 收敛 + 塌缩） | E9 |
| todo/goal 测试：`__tests__/index.test.ts`（todo）、`__tests__/{ports,service,goal-control-adapter,event-adapter}.test.ts`（goal 的 UiPort fake 成员同步删 isGui/setGuiWidget、dual 签名） | 改 | E8/E9 |
| `extensions/universal/pending-notifications/src/state.ts` | 改（countActiveFromEntries 委托 protocol 两层 API，filter 收窄为特有过滤层） | E6（确定项） |
| `docs/design/base-tool-enhance.md` | 改（:333 旧口径句回写 + E11 登记） | E11 |
| 对应测试：bte `__tests__/{kill-tree,registry,task-store,pending-reconcile,maintenance-once,index}.test.ts`、runtime `test/background-task-reaper{,-primitives}.test.ts`、`services/background-task/{output-tail,background-task-service}.test.ts`、protocol `helpers.test.ts` + 新模块单测 | 改/增（import 路径 + 新增断言） | 各单元 |
| `docs/design/file-lock-unification-and-reaper-sink.md` 或 `base-tool-enhance.md`、`ext-simplify-01-*.md:202` | 登记（CLI 兜底边界 / P-protocol 对账说明） | E11 + 待验证③ |

净行数预估：protocol +~300（三原语 + 子出口聚合 + pending-entries 两层），bte -~210（kill-tree 152 整删 + registry/output-tail/task-store 本地副本 + emit 路径 12 行），runtime -~150，todo/goal ±0 附近（分派塌缩 vs helper 调用）；整体净删 + 单一实现收益。

---

## 附录：变更历史

- v1（2026-09-11）：初稿。覆盖审计 M12（下沉，D1/D2）、M13（contested 裁决选 B，D3）、M5（07 号移交，协议 helper）、四问记录发现 5/6 两个 contested low（D4 不改名 / D5 保留）、发现 3/4/7/8 移交或登记；含 5 条审计修正（四问索引错位、LRU 3→4、tail 已漂移实证、M5 行号/形态、config 内联 8→4）。
- v2（2026-09-13）：按 over-engineering-audit 审查报告（ext-simplify-13-base-tool-enhance-protocol.review.md，5 MF + 4 S）修订——**MF1** D5 按 12 号终态整体重裁：v1「保留 + 补注释」前提（内存 registry 毫秒级窗口）失效且现状注释已是新口径，改为「删除 emit 恒 no-op 死路径 + 同批回写 base-tool-enhance.md :333 旧口径句（连带修复 12 号遗留文档漂移）」，含反例重演与被否谱系；**MF2** E4 API 两层化（scanPendingEntries 分流原语 + applyPendingDiff 差集本体 + collectActivePendingIds bte 组合），E6 从协调项收死为确定执行项（12 号已落地），「漂移面已消除」表述修正为以 E6 落地为前提；**MF3** §2.3 根因更正（runtime 可经 npm 子入口消费 extensions/shared 包，pi-file-lock/core 先例）+ 方案丙否决理由从「不可达」改为「成本与同域聚合」；**MF4** 出口形态主方案改为独立子出口 `./background-task`（renderer/core 浏览器消费面结构性零触达），P1 探针面补 renderer dev/build + core 构建；**MF5** D2 补 registry-file/output-tail 的 onLog 日志注入设计，V3 补 corrupt 场景日志落盘断言；**S1** 行号全量刷新至 12 号实施后基线（pending-reconcile :77-95/:135-144/:158、notify :22-27、goal widget :200-230、CHANGELOG :56/:69、01 号 :202、reaper :8-11 等）；**S2** 方案 A 先例证据归属修正（goal→pending 登记实存，审计修正 6）；**S3** G4 口径限定（用户/LLM 可见面 + registry 字节零变化；内部 API 归一/日志适配/emit 删除为有意变化）；**S4** E1 更新范围补 protocol README 首段、E9 补 payload 构造说明。三主干方向（D1/D3-B/D3-M5）不变。
- v2.1（2026-09-13）：聚焦复审第 1 轮修复（tech-design-review，1 MF + 2 S）——MF-R2-1 base-tool-enhance.md :333 回写范围从单句扩展为接入细则 4 段内两处 12 号前机制口径（emit 句 + 「不走 bus emit 权威」论据，消除同段新旧口径并存）；S-R2-1 E6 补 state.ts 全部三个差集消费点说明（hasPendingId/isPendingActive 已内建在 scanPendingEntries 之上，随私有 scan 删除自动同源）；S-R2-2 E2 补 bash_output `output` 字段名保持的适配说明（薄壳适配或调用点一行映射，LLM 可见契约零变化）。复审对实质变更的对抗验证结论：D5 删除裁决（含 pi dist 实证 appendEntry 同步入账）、两层 API 语义等价、子出口打包可行、goal→pending 登记实存（上轮 F17 判定错误）均确认成立。
- v2.2（2026-09-14）：聚焦复审第 2 轮 PASS（0 MF / 1 S）——S-R3-1 修复：:333 段旧机制口径枚举从两处扩为三处（补 ③appendEntry 权威论证句括号注「不读 pending-notifications 内存 registry」→ 改写为「pending 无内存状态，entries 是唯一状态源」）；hasPendingId 行号 :119-121 → :118-120。设计就绪（0 must-fix）。
- v2.3（2026-09-14）：阶段 3 审查 doc_errors 修复——V3 corrupt 断言文本对齐 protocol 单点实际措辞（renamed→quarantined，bte 薄壳经 onLog 落盘的是新措辞，按旧文本 grep 会 miss）。
- v2.3（2026-09-14）：阶段 4 修复批次落地记录——批次1 protocol 测试矩阵回port（Windows taskkill/pgrep 顺序/ps 错误注入/真进程孙子组 kill 四段，16 用例恢复 + 同矩阵低成本补齐，protocol 178/178）；批次2 bte process-exit-guard 缩进归一（diff -w 零语义）+ E11 错误文案评估落地（上段）；批次3 pending 侧「尽力补 emit」悬空指称清扫（state.ts JSDoc/测试用例名/注释 + 涟漪面第 4 处 index.ts，32/32 零断言改动）。

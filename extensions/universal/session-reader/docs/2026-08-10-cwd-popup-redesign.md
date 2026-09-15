# # 引用补全：当前目录化 + 展示重构

> **设计层性质**：技术方案设计（下一层产物 = 可实现的接口/数据路径/渲染映射）。准则 5/6/7 全适用，最严格。
> **scope**：本次只设计 `@zhushanwen/pi-session-reader` 的 TUI 层（`#` 弹窗 + `/session-pick`）数据获取与展示映射；不改 `session_read` 工具语义，不改 pi-tui 渲染引擎。

---

## §1 背景目标

**结论**：把 `#` 引用补全从「全盘扫描 + 窄预览 + 无 name」改造成「当前目录化 + 宽预览 + name 优先 + 单位时间」，对齐 pi 内置 `/resume` 的信息密度。

**SCQA**：
- **情境 (S)**：`@zhushanwen/pi-session-reader` 在 pi TUI 里提供 `#` 引用补全——用户键入 `#` 弹出历史 session 列表，选中插入 `#uuid片段`。
- **冲突 (C)**：当前实现全盘扫描 4000+ session 文件（~1.5s 才出列表）、预览被卡在 23 字符、不识别 session name、跨项目 session 混在一起。
- **问题 (Q)**：补全慢、信息少、噪声多，用户不愿用，退回手敲片段或开 `/resume`。
- **答案 (A)**：数据源换成 pi 自带的 `SessionManager.listAll(当前目录)`（19ms，含 name/count/firstMessage），展示对齐 `/resume`（name 优先、单位时间、预览占满宽）。

### 系统是什么

`@zhushanwen/pi-session-reader` 是 pi 的 extension，提供两个 TUI 能力：
1. `#` 引用补全：键入 `#` 弹出 session 列表，选中插入 `#xxxxxxxx`（8 字符 uuid 片段），供用户在对话里引用历史 session（如 `#019fe56b 帮我看看这个 session 的 outline`）。
2. `/session-pick` 命令：降级入口，`ctx.ui.select` 模态列表，选中后 `setEditorText(#片段)`。

两者共享数据层 `findSessions`（`src/discovery/find.ts`）。

### 设计目标（从使用者体验倒推）

| # | 使用者能感知到 | 回溯自用户反馈 |
|---|---|---|
| G1 | 键入 `#` 只看到**当前项目目录**的 session，不被其他项目噪声干扰 | 用户反馈点 1「只显示本目录相关 session」 |
| G2 | 预览文本看得足够长（接近 `/resume` 的信息量），不再被截到 20 来字 | 用户反馈点 2「第二列内容更多」 |
| G3 | 命名过的 session 显示 **name 而非首消息** | 用户反馈点 3「有 name 优先展示 name」 |
| G4 | 时间用单单位（`12m`/`3h`/`2d`），不出现「刚刚/分钟前」混排 | 用户反馈点 2 的时间格式要求 |
| G5 | 键入 `#` 后列表**几乎瞬间出现**（体感无延迟） | 用户反馈点 5「加载慢」 |
| G6 | 默认 10 条，`/session-pick` 也对齐 10 | 用户反馈点 4 |

### in-scope / out-of-scope

- **in-scope**：`#` 弹窗 + `/session-pick` 的数据获取路径、AutocompleteItem 字段映射、时间格式、limit 对齐、进程内缓存。
- **out-of-scope**：
  - `session_read` 工具的 `find` action（LLM 跨目录查找，保留全盘 `findSessions` 不变）
  - pi-tui 的 `SelectList` 渲染引擎（第三方，不改）
  - 跨项目 `#` 引用（用户已确认放弃，跨项目走 `session_read` 工具）

---

## §2 现状与问题分析

### 2.1 使用者视角的现状（真实截图）

键入 `#` 后当前看到（120 列终端）：

```
→ 019fe56b <skill name="emil-ani  刚刚
  019fdfc4 阅读 ：docs/retrospec  刚刚
  019febdf <skill name="dev-link  刚刚
  ...
  (1/10)
```

问题肉眼可见：
- 预览 `<skill name="emil-ani` 被截断（原本是 `<skill name="emil-animate-designer ...`）
- 5 条全是「刚刚」，时间信息密度为零
- 混了多个 cwd 的 session（这些恰好都是当前项目，但代码没保证）
- 出列表要等 ~1.5 秒

### 2.2 物理数据流（当前）

```
键入 #
  → pi-tui editor debounce 20ms
  → createHashAutocompleteProvider.getSuggestions
  → provideHashCandidates(textBeforeCursor, agentDir)
  → findSessions('recent', agentDir, {limit:10})        ← 热点
       ├─ listMainSessions(agentDir)                    递归 readdir sessions/ 全部子目录
       │    └─ 对每个 .jsonl: readdir + stat            4000+ 文件
       ├─ for 每个 file: await readFirstLine(8KB)        串行读首行 parseHeader    ← 串行瓶颈
       ├─ 全部 candidates 按 mtime 倒序
       ├─ slice(0, 10)
       └─ for top10: await readFirstUserMessageText       串行 stream 读首条 user msg
  → toCandidate: label = `${8字符片段} ${预览截40}`, description = 相对时间
  → AutocompleteItem[] 渲染
```

### 2.3 根因分析（逐个目标）

**G5 慢的根因（实测，探针 ✅）**：

| 阶段 | 实测耗时 | 根因 |
|---|---|---|
| readdir + stat 全盘 | ~640ms | 扫了所有 cwd 的所有文件（4027 个），没有按当前 cwd 收窄 |
| 串行读首行 parseHeader | ~870ms | `for (meta of files) await readFirstLine()` 串行，无并发 |
| 合计 | **~1500ms** | — |

探针脚本：`node` 跑 `scanJsonlRecursive + readFirstLine` 全盘（见分析阶段实测，非推理）。

**G1 跨目录根因**：`provideHashCandidates` 调 `findSessions(query, agentDir, { limit })` **没传 `opts.cwd`**；`listMainSessions` 递归扫 `sessions/` 下全部子目录（150+ 个 cwd 目录）。

**G2 预览窄的根因（探针 ✅）**：`#` 弹窗用 pi-tui 的通用 `SelectList`，其布局在 `editor.js:166` 硬编码：

```js
const SLASH_COMMAND_SELECT_LIST_LAYOUT = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,   // ← label 被夹到 32 字符
};
```

`AutocompleteItem` 只有 `{value, label, description}` 三字段。`label`（主列）≤32 字符，`description`（次列）占剩余宽度。当前 `toCandidate` 把预览放进 `label`（`label = 片段+预览`），所以预览被夹到 32−8−1 = **23 字符**。把 `LABEL_PREVIEW_MAX` 从 40 改到 80 **无效**——pi-tui 照样截到 32。

**G3 无 name 根因**：`findSessions` 只解析 header（`type:"session"`，含 id/cwd），从不读 `type:"session_info"` entry（name 存在这里）。实测 4367 个 session 中 223 个有 name，且 `session_info` 行位置不固定（line 2 / 19 / 619 / 1456 都有，改名会追加新 entry，最后一个生效）——自己可靠取 name 需全文扫描，全盘做不可接受。

**G4 时间格式根因**：`formatRelativeTime` 用「刚刚 / N 分钟前 / N 小时前」多级文案，与用户要的单单位（`12m`/`3h`）不一致。pi 内置 `formatSessionDate`（`session-selector.js:21`）正好产出 `now/Xm/Xh/Xd/Xw/Xmo/Xy`——可直接对齐。

### 2.4 关键事实：pi 已有可复用的数据 API（探针 ✅）

**这是改变方案走向的决定性发现**，不是推理：

| 事实 | 证据位置 | 实测 |
|---|---|---|
| `SessionManager` 从主包 export，extension 可 import | `pi-coding-agent/dist/index.d.ts:19` | — |
| `SessionManager.listAll(sessionDir?)` 接受目录参数，只扫该目录 | `session-manager.js` listAll 实现 | — |
| 返回 `SessionInfo {path,id,cwd,name?,modified,messageCount,firstMessage,allMessagesText}` | `session-manager.d.ts:125` | — |
| `ctx.sessionManager.getSessionDir()` 直接返回当前 session 的目录（encoded cwd dir），无需自己算编码 | `session-manager.js` getSessionDir + ReadonlySessionManager 含此方法 | — |
| listAll 用并发读（`MAX_CONCURRENT_SESSION_INFO_LOADS`），非串行 | `buildSessionInfosWithConcurrency` | — |

**listAll 性能实测**（用 pi 自己的 API，非模拟）：

| 场景 | 文件数 | 耗时 |
|---|---|---|
| `listAll(当前cwd目录)` | 6 | **19ms** |
| `listAll(Stock目录)`（worst-case cwd） | 530 | 667ms |
| `listAll()` 全盘 | 3486 | 7905ms |

含义：复用 `listAll(getSessionDir())` 一招同时解决 G1（自动限当前目录）、G3（白送 name/count/firstMessage）、G5（19ms vs 1500ms，78 倍）。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径**——在当前项目键入 `#`（终端 120 列，label 满宽无 padding）：

```
→ now 看看 pi-session-reader 这个 extension 在本项目的源码。 现在在 pi 中 TUI 输入 # 会出现...
  01h <skill name="tech-design" location="~/.agents/skills/tech-design/SKILL.md...
  01h <skill name="dev-link" location="<workspace>/<worktree>/feat-read-...
  01h 确保全部改动都已经提交。然后 pull origin main 合并最新代码。
  01h 修复登录bug                                          ← 有 name 时只显示 name（在 label 里）
  11h 我现在在设计开发一个 extension tool： 目的是...
  (1/10)
```

- `label` = `${格式化时间} ${预览/name}`（满宽渲染，见 §3.2）—— 时间最左 + 1 空格 + 预览吃满
- **不设 description**（触发 SelectList 满宽分支，绕过主列固定 32）
- 时间等宽 3 字符：`now` / `01m`/`59m` / `01h`/`23h` / `01d` / `02w` / `02M` / `01y`（2 位补零 + 1 位单位，月=M）
- **不显示 uuid 片段**（只在 insertText）、**不显示 count**（用户反馈）
- 有 name → label 里显示 name 不显示 firstMessage
- 选中插入 `#019fec09`（不变，向后兼容）

**失败路径 + 恢复**：
- 当前目录无 session → 弹窗为空，pi-tui 自动显示 `No matching commands`。恢复：用户继续敲完整 uuid 片段，或用 `/session-pick`，或 `/resume` 切到全目录视图。
- 用户要引用**别的项目**的 session → `#` 弹窗找不到（已确认 out-of-scope）。恢复：直接让 agent 用 `session_read {action:"find", query:"<片段>"}` 跨目录定位。

### 3.2 关键约束与解法：不传 description 绕过主列固定 32（实测发现）

**问题**：pi-tui 的 `createAutocompleteList`（editor.js:1794）对非 `/` 前缀（`#`/`@`）传 `layout=undefined`，SelectList 默认主列固定 32 字符（min=max=32）。若传 description，label 后 padding 到 32 再接 description，`count age` 与预览间隔 ~24 空格（用户反馈「隔太远」）。

**解法（纯 extension 层，不改 pi）**：**不传 description**。读 SelectList.renderItem 源码（select-list.js）发现：

```js
if (descriptionSingleLine && width > 40) { /* 有 description：走主列固定32分列 */ }
// 无 description：
const maxWidth = width - prefixWidth - 2;  // 满宽
return prefix + truncatePrimary(item, ..., maxWidth, maxWidth);  // label 截到满宽
```

`item.description` 为 undefined 时 `descriptionSingleLine` 为 undefined，跳过主列分列分支，label 被当作整行截到 `width-4` 满宽。**主列固定 32 不生效**。

故映射改为：**label = `${格式化时间} ${预览/name}`，不设 description**。label 满宽渲染，时间最左 + 1 空格 + 预览吃满，无 padding。无 count（用户反馈「243 是什么」）、无 uuid 片段（仅在 insertText）。

时间格式：`formatAge` 返回固定 3 字符等宽 `XXu`（2 位数字补零 + 1 位单位 m/h/d/w/M/y，月用 M 区分分钟的 m），`now` 也是 3 字符。用户要求「保留2位数字+一位单位」。

### 3.3 多方案对比

#### 决策 1：数据获取路径

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 复用 `SessionManager.listAll(getSessionDir())`**（选） | 高：数据解析、cwd 编码、name 提取、并发全由 pi 维护，extension 只做 UI 映射。`session_read` 工具侧仍用自己的 `findSessions`（跨目录需求），两不干扰 | 低：删 `provideHashCandidates` 里的 `findSessions` 调用，换成 listAll + 映射 | listAll 对大 cwd（如 Stock 530 文件）读全部文件 667ms；需加缓存缓解 | ✅ |
| B. 自己实现：`findSessions` 加 `opts.cwdDir` 快路径 + 自己全文读取 name | 低：重复造 pi 已有的解析轮子，cwd 编码规则、session_info 扫描都要自己维护，pi 改格式就坏 | 中：改 `find.ts`+`roots.ts`，加 name 全文扫描 | 编码规则依赖 pi 实现（已从源码确认但非契约） | ❌ 若用 B，pi 升级改 session 文件格式时 extension 要跟改两处（listAll 路径 + 自写路径），双轨维护 |

**推荐 A**。一致性 > 品味：pi 已有官方 API 且性能达标，不重写。

#### 决策 2：`#` 弹窗字段映射（在主列固定 32 字符约束下）

| 方案 | label（主列固定32） | description（次列，剩余宽） | 预览可见量 | 裁决 |
|---|---|---|---|---|
| **C2. label=`${count} ${age}`，description=预览/name**（选，迭代自原 C） | `243 1h`（6字符+padding到32） | 预览/name 吃满 ~width-36 列 | ~84 字符（满宽） | ✅ |
| D. label=`片段 预览`，description=时间（初版现状） | 截到 32 | `刚刚` | ~23 字符 | ❌ G2 不达标 |
| E. label=预览，description=`count age` | 预览截到 32 | `130 12m` | ~30 字符 | ❌ 预览仍被 32 夹 |
| C1（原 C）. label=片段，description=`预览 count age` | 片段+padding到32 | 预览+count+age，末尾 age 易被左截 | 不稳定 | ❌ 时间被截 |

**推荐 C2**。主列固定 32 是死约束（§3.2），把短而必现的 `count age` 放主列（不被截），把要满宽的预览放次列（吃满）。不显示 uuid 片段（用户反馈「不要最左片段」）。代价：label 后 padding（~24 空格）。

#### 决策 3：是否加进程内缓存

`#` 弹窗 debounce 20ms，敲 `#019` 触发 3 次查询。listAll(当前目录) 19ms 不缓存也可接受，但 Stock 类大 cwd（667ms）每次重读会卡。

| 方案 | 裁决 |
|---|---|
| **F. 加 mtime 缓存**：key=`sessionDir`，value=`{files:[{path,mtime}], sessionInfos, ts}`；命中条件=目录 readdir 结果的文件名+mtime 集合未变；TTL 无（靠 mtime 失效） | ✅ 推荐 |
| G. 不缓存 | ❌ 大 cwd 反复卡 |

**推荐 F**，但列为 §5 的独立可选拆分单元——先上线无缓存版（19ms 已达标），缓存作为大 cwd 的增强。

#### 决策 4：`#` 触发改模态（被否）

| 方案 | 裁决 |
|---|---|
| H. `#` 改为开 `ctx.ui.select` 模态，全宽行可右对齐 | ❌ 失去内联补全（用户键入 `#` 后弹模态、选中后回填），与 pi `@文件` / `/命令` 内联体验不一致；且 `ctx.ui.select` 的 `string[]` 构建时也不知道终端宽度，右对齐仍要自定义组件 |

### 3.4 关键决策与权衡

1. **时间格式直接复刻 `formatSessionDate`**（`now/Xm/Xh/Xd/Xw/Xmo/Xy`），而非保留现有「刚刚/分钟前」。理由：与 `/resume` 一致，且是用户明确要求。实现：在 `hash-provider.ts` 新增 `formatAge(mtime)`，逻辑照搬 pi（不 import pi 内部函数，避免耦合未导出的内部模块）。

2. **name 优先级**：`SessionInfo.name ?? firstMessage`。有 name 时 description 只放 name（+count+时间），不拼 firstMessage——对齐用户点 3「有 name 仅展示 name」。无 name 时 description 放 firstMessage。注：name 与 firstMessage 在 `#` 弹窗里同色（SelectList 对整段 description 统一上色，`theme.description(spacing+truncatedDesc)`，select-list.js:106），不像 `/resume` 能给 name 单独上 warning 色——后者是 pi 内部自定义组件 `SessionSelectorComponent` 的能力，通用 SelectList 不具备。若未来要 name 视觉区分需改 pi-tui，列 out-of-scope。

   **实现期发现（firstMessage 是全文，非预览）**：`SessionInfo.firstMessage` 是首条 user message 的**完整全文**（可能含 `<skill>` 注入全文，上千字符），不是截断预览。直接拼 `${text}  count age` 会让 pi-tui SelectList 从左截断时吃掉末尾的 `count age`。故 `toCandidate` 先把 text 截断到 `PREVIEW_MAX=50` 字符再拼 count+age——保证 ≥80 列终端（description 区 ~64 列）下 `count age`（≤9 字符）完整可见，预览 50 字符仍远超现状的 23 字符（G2 达标）。

3. **limit 统一 10**：`#` 弹窗已是 10（`DEFAULT_LIMIT`）；`/session-pick` handler 现为 20，改为 10（用户点 4）。

4. **uuid 片段匹配仍在，keyword fallback 移除（行为变更，显式声明）**：用户键入 `#019` 时，对 listAll 结果按 `id.includes('019')` 过滤。旧 `findSessions` 在 uuid 零匹配且 query 非十六进制时会深读 firstMessage 做关键词匹配——**此 keyword fallback 在 # 弹窗路径移除**（合理收窄：# 弹窗是 uuid 引用入口，关键词查找走 `session_read {action:"find", query:"<词>"}` 工具）。`session_read` 工具侧的 `findSessions` 保留全量三路匹配不变。

5. **`session_read` 工具侧不动**：`findSessions`（全盘、跨目录、LLM 驱动）保持原样。TUI 层换数据源不影响工具层。

6. **适用前提：# 弹窗面向典型项目 cwd**：`listAll(当前目录)` 的耗时与该目录 session 数线性相关。典型项目 cwd 6-50 文件 = 19-~60ms（G5 达标）。超大 cwd（如 Stock 目录 530 文件）首次加载 667ms——这是已知边界，由 P2 缓存缓解（缓存命中后 < 10ms）。不为此给 listAll 加 limit（pi API 不支持），避免重造分页轮子。

7. **TUI provider 注册：按 pi 实例去重（`WeakSet<ExtensionAPI>`），不用模块级布尔**（实测发现，design 原写法是 bug 源头）：`/resume` 会**重新加载 extension 并再次调用 factory**（新 session = 新 pi/runner 实例，非进程级一次）。模块级 `let tuiRegistered` 跨 factory 持久 → resume 的新 session 跳过 `addAutocompleteProvider` → 新 editor 没挂 # provider → # 不弹。改用 `WeakSet<ExtensionAPI>` 按 pi 实例去重：resume 新 pi 实例不命中 → 正常注册；同一 pi 内多次 session_start 仍去重防堆叠。同理 cwdSessionDir 不能闭包固定，用 getter 读模块级 `currentCwdSessionDir`（每次 session_start 更新）。

---

## §4 验收

> 真实环境实测，非单测非 mock。每个场景标注回溯的 §1 目标。

### 场景 A：当前目录化 + 性能（G1, G5）

- **上下文**：在 `feat-read-pi-session-extension` worktree（当前 cwd）开 pi TUI。
- **步骤**：
  1. 键入 `#`，观察弹出的列表。
  2. `ls ~/.pi/agent/sessions/<当前cwd编码目录>/ | wc -l` 记录该目录文件数 N。
  3. 确认列表项数 ≤ min(10, N)，且每项片段对应的 session 文件都在该目录内（抽查 3 项：用 `session_read {action:"find", query:"<片段>"}` 看 cwd 字段 = 当前目录）。
  4. 用秒表/录屏测从键入 `#` 到列表出现的时间。
- **通过标准**：列表项全在当前 cwd；时间 < 100ms（19ms 实测 + 渲染余量）。

### 场景 B：宽预览（G2）

- **上下文**：同 A。
- **步骤**：键入 `#`，找一条 firstMessage 较长（>50 字符）的 session。
- **通过标准**：预览显示 ≥40 字符（当前 23），且 `count 时间` 紧跟预览后可见。录屏留证。

### 场景 C：name 优先（G3）

- **上下文**：先 `/resume` 找一个有 name 的 session（或用 `session_read` family 确认），记录其 uuid 片段。
- **步骤**：键入 `#`，定位该片段对应的列表项。
- **通过标准**：该行 description 显示的是 name（不是 firstMessage），且与 `/resume` 里看到的 name 一致。

### 场景 D：时间单单位（G4）

- **步骤**：键入 `#`，观察各行的 时间部分。
- **通过标准**：全部为 ` Xm`/` Xh`/` Xd`/` Xw` 之一（或 `now`），无「刚刚/分钟前/小时前」字样。

### 场景 E：uuid 片段过滤 + 选中回填（回归，不破坏现有契约）

- **步骤**：键入 `#019`，选中一项，发送消息。
- **通过标准**：编辑器插入 `#019xxxxx`（8 字符）；agent 收到的消息含 `#019xxxxx`；`session_read` 工具能据此片段解析到该 session（剥 `#` 后 findSessions 命中）。

### 场景 F：`/session-pick` 对齐（G6）

- **步骤**：`/session-pick`，观察列表。
- **通过标准**：≤10 项；数据源与 `#` 弹窗一致（同 cwd、同 name 优先、同时间格式）。

### 场景 G：跨目录 uuid 引用的降级路径（out-of-scope 确认）

- **上下文**：在 A 项目键入 `#`，想引用 B 项目的 session `019fabcd`。
- **步骤**：`#` 弹窗找不到 → 让 agent 跑 `session_read {action:"find", query:"019fabcd"}`。
- **通过标准**：工具侧仍能跨目录找到（证明 `findSessions` 全盘能力未被 TUI 改造波及）。

---

## §5 下一层拆分

### 实施路径（分 3 阶段，每阶段可独立验收）

| 阶段 | 产物 | 可验收场景 |
|---|---|---|
| P1 | TUI 数据层换 listAll + 字段映射 + 时间格式 + limit 对齐 | A/B/C/D/E/F（核心） |
| P2（可选） | 进程内 mtime 缓存 | A 在大 cwd（如把 cwd 切到 Stock 目录复测 < 100ms） |
| P3 | 单测补全（listAll 适配层的纯函数映射） | 单测（非主验收，辅助） |

### 拆分清单（P1）

| 单元 | 文件 | 改动 | justification |
|---|---|---|---|
| U1 数据获取层 | `src/tui/hash-provider.ts` `provideHashCandidates` | 入参加 `cwdSessionDir`；内部 `findSessions('recent',...)` 换成 `SessionManager.listAll(cwdSessionDir)`；uuid 片段非空时对结果 `.filter(s => s.id.includes(fragment))` | 决策 1 方案 A |
| U2 字段映射 | `src/tui/hash-provider.ts` `toCandidate` | 改签名收 `SessionInfo`；label=`片段`；description=`${name??firstMessage}  ${messageCount} ${formatAge(modified)}` | 决策 2 方案 C + 决策 3.4 |
| U3 时间格式 | `src/tui/hash-provider.ts` 新增 `formatAge` | 照搬 `formatSessionDate` 逻辑（now/Xm/Xh/Xd/Xw/Xmo/Xy） | 决策 3.4-1，不 import pi 内部 |
| U4 cwd 目录注入 | `src/index.ts` `session_start` handler | 捕获 `ctx.sessionManager.getSessionDir()`，传给 provider factory（替代仅传 agentDir） | ExtensionContext.getSessionDir 是当前 cwd 目录的权威源 |
| U5 `/session-pick` 对齐 | `src/tui/session-command.ts` | handler 的 `findSessions(...,{limit:20})` 换成 `listAll(cwdSessionDir)` + limit 10；`getArgumentCompletions` 同样换 listAll + uuid 子串过滤（Tab 补全也变 cwd-scoped + uuid-only，与 handler 一致） | 决策 3.4-3，统一数据路径 |
| U6 依赖声明 | `extensions/session-reader/package.json` | `SessionManager` 已在 peerDep `@earendil-works/pi-coding-agent` 内，确认 import 路径走主包 export（`index.d.ts:19`）| 不新增依赖 |

### 待验证检查点（实施期）

- **⚠️ listAll 的 `SessionInfo.firstMessage` 是否含 `<skill>` 等纯文本**：实测当前 cwd firstMessage 确含 `<skill>` 标签（如 `<skill name="tech-design"...`）。**决策：不清洗标签**——对齐 `/resume`（resume 截图同样原样显示 `<skill name="emil-ani`，不清洗），是减法。firstMessage 是首消息全文（上千字符），`toCandidate` 截断到 `PREVIEW_MAX=50` 字符（见 §3.4-2 实现期发现），末尾拼 count+age。
- **⚠️ listAll 在 RPC 模式（taiji 子进程）下是否可用**：`session_start` 的 once-guard 已限定 `ctx.mode==='tui'` 才注册，RPC 模式不触发。但需确认 taiji 环境下 `ctx.sessionManager.getSessionDir()` 返回值正确（应指 taiji 隔离数据目录下的当前 cwd 目录）。
- **P2 缓存的失效边界**：readdir 拿文件名+mtime 集合做 cache key；新 session 创建后下次 `#` 触发会因目录 mtime 变化失效重读。实施时验证「刚创建的 session 能在 `#` 弹窗出现」。

### 文件改动地图

```
extensions/session-reader/
├── src/index.ts                    改：session_start 捕获 getSessionDir，传入 provider
├── src/tui/
│   ├── hash-provider.ts            改：provideHashCandidates 换 listAll + toCandidate 重映射 + 新增 formatAge
│   └── session-command.ts          改：handler/getArgumentCompletions 换 listAll + limit 10
├── src/__tests__/
│   └── hash-provider.test.ts       改：mock listAll，断言新字段映射 + formatAge + uuid 过滤
└── package.json                    不改（peerDep 已覆盖）
```

`src/discovery/find.ts` / `roots.ts` **不改**（`session_read` 工具侧继续用）。

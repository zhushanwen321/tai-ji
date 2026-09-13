# zcode 引擎会话库隔离（消除 ZCode GUI 侧边栏污染）技术设计

> **一句话结论**：把 zcode 引擎 app-server 的会话库从宿主 `~/.zcode/cli/db/db.sqlite` 隔离到
> xyz-agent 引擎数据目录下的**独立会话库**（spawn env `ZCODE_SESSION_DB_PATH`，**已真机探针验证**），
> 使 subagent 会话不再进入 ZCode GUI 侧边栏；HOME 保持共享（凭据 / 插件 / MCP / pnpm store 语义零变化），
> **不**重启 2026-09 已删除的池 / 锁 / pidfile 复杂度。

> 层声明：当前层 = 技术方案设计；下一层 = 可实施代码单元（W1–W6，见 §5）。
> 状态：**已交付**（设计就绪：R4~R7 全修 + v6 减法 + R8 4 must-fix/5 suggestion 全修；2026-09-09 随 W1–W5b 落地，W6 TTL 为 D4 触发后的后续项，见 v12 注记）。
> - v11（2026-09-08，**分层拆分**）：设计层收敛后，按 dev-flow 分层把**实现级细节**下沉到 zcode-session-db-isolation.impl-plan.md（已删除，git 可追溯；实施细节现由代码承载）（D7 清理工具的 I1–I3b 判据/CLI 参数/SQL/容差常量/备份与窗口写者清单、W 单元领地与测试命令）；
>   本文件保留决策、不变量、数据流、错误语义、验收场景与粗粒度拆分。R9 的 7 项实现级残留改在 plan §7.2 跟踪。
> **分层声明（2026-09-08）**：本文件是**设计层**（决策 / 不变量 / 数据流 / 错误语义 / 验收场景 / 下一层拆分）。
> **实现级细节（清理工具的 CLI 参数与判据、SQL 语句与参照查询、常量字面量、单元领地与测试命令）的 SSOT
> 已由代码承载（原下沉目标 zcode-session-db-isolation.impl-plan.md 已删除，git 可追溯）**。
> 后续改动实现级细节直接改代码并以本文件对应章节为入口。

> 事实基准：2026-09-08 真机探针 + 存量双库统计（探针脚本已随 2026-09-13 docs purge 删除，见 §2.3 证据列）。
> 修订记录：
> - v1（2026-09-08）：首轮分析 + 三组探针后成文。
> - v2（2026-09-08，R1 修复）：①改点纠错（生产读取链是**第二份白名单**，非 `EnginePort.read`）；
>   ②隔离库选址移出池目录（原选址落在 `deletePoolNativeState` 删除边界内）；③E3 断言按实装事实重写 + 补探针；
>   ④补宿主伴生写入面穷举（9 行面）/ 用量观测面 / 第二宿主 zsw / 存量污染行四节；⑤代价量化四要素补全；
>   ⑥同步面点名为约束表 + AGENTS.md；⑦补反向验收与概念 gloss。
> - v3（2026-09-08，R2 修复）：①A9 守卫改为**经公共 API + 真实隔离库路径**（原测模块私有 `deletePoolNativeState` → 空断言）；
>   ②D4 量级按同一锚重算（原 30–50MB/日 与「数十 GB/年」不自洽）+ 恢复路径代价 + 阈值时间预期；
>   ③§2.4.1 阈值口径钉死（累计口径下**已触发**）+ 增量/累计分列 + log 通道边界；④§2.4.2 补量级（今日占比 94%）+ 判定拆「工程侧 / 产品口径」；
>   ⑤§2.4.3 zsw 写实为 re-vendor 继承 + 交付物 W5b + 误删面口径纠正；⑥D7 补四件套安全网 + schema 实装校正
>   （11 表/12 FK 列 + `input_history` 显式删 + `PRAGMA foreign_keys=ON` + SET NULL 越行登记 + 索引库全枚举）+ 代价量化；
>   ⑦D1 父目录事实纠正（引擎自建）；⑧`:401`→`:407`；⑨W1 落点 `db-path.ts`、W4 补权威源文档回写、W5b、A12 diff 根扩到 `~/.zcode/`、counts.sql 落成可执行 SQL。
> - v4（2026-09-08，R3 修复）：①§2.4.2 量级纠正（原「我们历史累计 13.70B」实为**全库 interactive 类目**，含 GUI；
>   我们真实累计 92.1M/838 行）+ 判定改为**默认不可接受**（owner/期限/知情落点）；
>   ②D4 量级锚改为**我们自己的会话** 0.3–0.4MB/条（原用全库均值 1.8MB，差 4.9×）→ 日增量 ≈45MB/日、阈值 ≈45 天，W6 改「先就绪再触发」；
>   ③§2.4.1 判定链闭合（新上界 + owner/期限/跟踪 + 有期限债务）；④D7 四件套可执行化（哨兵与删除集构造性互斥 /
>   索引删除对象 vs 冲突面分离 / 目录红灯按本仓分布重定 / 解析路径钉死）+ A11 双口径；
>   ⑤A9 加枚举断言与 mkdir 入参修正；⑥D7 代价单位/停机分段/可用空间前置；⑦W5b 改仓内 handoff；
>   ⑧W4 第六面（protocolization 文档）；⑨F6/F11 行号与快照口径。
> - v5（2026-09-08，R4 修复）：①**哨兵重设**——不再追求与删除集互斥（那导致恒真/恒中止两种失效），改为「重叠即真警报」的独立面
>   （`parent_id ∈ 删除集` / `title_source='custom'` / 目录外）+ A11 反向 fixture；
>   ②**索引面单向化**（对齐邻仓）：`task_group_members` 命中 = 冲突 → 整体剔除，删除面只 `tasks` + 姊妹表；
>   ③**目录红灯输入定义**（`git worktree list --porcelain`；目录已不存在降为报告项；删「已知 zsw 目录」项）；
>   ④**A11 索引面前置**（先在 GUI 打开目录使 `tasks` 命中 N≥1，再断言 N→0；否则显式标不可证伪）+ 双口径改独立参照 SQL；
>   ⑤§2.4.2 恢复路径拆 A/B 分支（候选① 若选则成 W 单元 + 宿主库新表写入面分析）+ 重审补绝对缺失量；
>   ⑥§2.4.1 跟踪落点落成 W4 子项 `docs/todo/companion-surface-governance.md` + 余量基准改写；⑦**派生行（4 条）纳入删除集**；
>   ⑧隔离库非会话状态（`local_setting` 189 行）枚举 + 判定；⑨W5 备份量级/安全网名同步；⑩counts.sql 口径修正 + 补 dbstat 法。
> - v6（2026-09-08，**减法收敛**——R5 四个 reviewer 因会话压缩被中止、无报告；按 `flow/write.md` §101「轮次问题同级 → 回到方案对比重做」）：
>   D7 安全网由「四件套」压成**三条硬不变量** + FK 兜底（该版有两处被 r5 实测击穿，见 v7）。
> - v7（2026-09-08，R5 修复——zcode 引擎重跑 R5，5 must-fix + 4 suggestion）：
>   ①**I2 改为跨源交叉验证硬中止**（r5 实测：用户 `interactive`+`generated` 与我们行**字段不可区分**，字段式判据拦不住 → 用 record 自带目录/时间戳 vs 宿主行互证）；
>   ②**I3 作用域钉死为「直接删除集」+ 新增 I3b 派生集不变量**（否则「任一行非 interactive 即中止」会被自己的派生行触发 → 通道永不可执行）；
>   ③**I2 执行形态钉死**（交互式输入删除集总数 / 非 TTY 拒绝且无 `--yes` 旁路 / 报告置顶异常汇总 / 确认凭证落盘）；
>   ④**索引侧预检恢复**（r5 实测索引库零 FK 到 `tasks` → 「FK 失败即中止」在索引面是死断言；「不预计算」限定为**宿主库**）；
>   ⑤快照漂移标注（白名单/删除集/派生行数字均标快照 + 复测值）；§2.4.2 补「用户沉默」默认走向与分支 B 写面分析落点。
> - v8（2026-09-08，R6 修复——5 must-fix + 4 suggestion）：
>   ①**I2 改时间戳维度**（r6 实测 record **无目录字段**，`SubagentRecordEntryData` 只有 `startedAt`；目录维度不可作硬判据）——容差 ≤60s（**史实值**；v9 已统一为 ≤10s，见下行）；
>   ②**I2 作用域 = 直接删除集**（派生行在 record 里 0 entry，否则恒中止）；
>   ③**非 TTY 改受控旁路 `--confirm-count <N>`**（本仓现实：运维/AI agent 跑 bash 天然非 TTY；精确匹配删除集总数，不是笼统 `--force`）；
>   ④**索引预检与 I1 对齐**（命中 → 两侧同时剔除；参照 SQL 含同一预检条件，否则 I1 必失败）；⑤§2.4.2 沉默 ≠ 永久接受（补重审出口）。
> - v9（2026-09-08，R7 修复——4 must-fix + 4 suggestion）：
>   ①**I2 容差三处口径统一为 ≤10s**（修订记录/D7/A11；依据 = r7 实测 max Δ≈4.0s → 2.5× 余量，且不取 60s 以免碰撞面扩大一个量级）；
>   ②**跨库删除顺序写死**（每 id 先宿主后索引 → 中间态只可能是「宿主已删、索引残留」可恢复方向）+ A11 补索引删除失败 fixture；
>   ③**I2 残余风险按真实前置重写**（record 白名单被污染/伪造）+ P0-20 四要素齐备（量级 ≈3/1642、恢复=备份回滚、重审触发）；
>   ④**参照 SQL 落盘单一文本**（`counts.sql` W5 查询 + Δ 分布查询）；⑤`--confirm-count` 威胁模型边界显式声明；⑥§2.4.2 措辞去恒真。
> - v10（2026-09-08，R8 修复——4 must-fix + 5 suggestion）：
>   ①**参照口径全文统一**（I1 表与 A11 前快照段去掉「只读查宿主库」旧措辞，统一指向 `counts.sql` W5 单一文本，跨双库）；
>   ②**Δ 分布落成可执行 SQL**（counts.sql 第 0 步导出 + ④/⑤ 查询，容差推导可复跑）+ 容差「全局唯一常量」护栏；
>   ③**「宿主已删、索引残留」降为未验证假设**（F7 只实测加法方向）+ 残留 id 清单落盘 + `--replay-residue` 补删模式 + A11 真机观测；
>   ④**备份粒度与停机窗口写者清单**（整库还原；zsw re-vendor 进程必须在窗口内停用）；⑤确认凭证补「授权来源」；⑥counts.sql grep 法仅限只读证据，不得复用为白名单构造；⑦v8 修订记录恢复史实值。
> - v12（2026-09-09，**W11 迁移注记**）：zcode 引擎已随引擎协议化外移至 `packages/zcode-subagent-cli`（subagent-core 内建 `engines/zcode/` 删除）——§1「系统是什么」实现锚点、§2.3 F12 读取链、§3.2 D2 站点表按迁移后实态回写：生产链①级读 = runtime `registerNativeSessionReader` 协议读（`subagent-engine-history.ts:229`）经协议 `read` 落引擎包 `zcode-engine.ts` `read()`（:921，白名单集合判定 :936 内聚引擎包）；`readZcodeNativeTier` 符号已不存在；handle 回填现锚 `:429/:484`（行号已按 2026-09-13 复核刷新）。决策内容不变，成文时点锚点保留为史实。
>
> 关联：本设计是 [subagent-engine-protocolization.md](subagent-engine-protocolization.md) 的**前置小改**——
> 若引擎协议化先落地，本设计改动直接落进 `zcode-subagent-cli` 包内（core 侧零改动）；否则外移时随包搬走。
> **（已发生**：2026-09-09 W11 随引擎协议化落地，本设计改动现位于 `packages/zcode-subagent-cli`，见 v12 注记。**）**

---

## §1 背景目标

**SCQA**

- **S（现状）**：core 的 zcode 引擎走「app-server 常驻 + 共享宿主 HOME」形态（2026-09 用户拍板，
  见 `zcode-engine-appserver-resident.md` 头部）。引擎 spawn 的 app-server 用真实 `$HOME`，
  会话落 `~/.zcode/cli/db/db.sqlite`——**与 ZCode GUI 同一个库**。
- **C（冲突）**：ZCode GUI 左侧边栏的数据源是它自己的索引库 `~/.zcode/v2/tasks-index.sqlite`，
  由 GUI 从引擎库同步。引擎写的会话行 `task_type='interactive'`、`parent_id` 为空、标题正常，
  **与真实用户会话无任何可区分特征** → 一旦该会话所在目录被 GUI 当作 workspace 同步过，
  它就会作为一条普通会话出现在用户侧边栏里。
- **Q（问题）**：怎么让 xyz-agent 派发的 zcode subagent 会话**不再污染用户侧边栏**，
  同时不把 2026-09 刻意删掉的 HOME 池化 / 锁 / pidfile / 派生目录复杂度重新背回来？
- **A（答案）**：不隔离 HOME，**只隔离会话库**——app-server 支持 `ZCODE_SESSION_DB_PATH`
  （配置面 `storage.sessionDbPath` 的 env 通道），把它指向
  `<engineDataDir>/engines/zcode/session-db/db.sqlite`。真机探针已验证：会话完整落在隔离库、
  宿主库零行、create→send→终态→read→close 全链正常（§2.3 F1）。

**系统是什么**（给不熟悉 subagent-core 的读者）：`packages/subagent-core` 是引擎中立的 subagent
执行核心，`packages/subagent-core/src/execution/engine/engines/zcode/` 是 zcode 引擎实现
（**v12 实态注记（2026-09-09 W11 后）**：zcode 引擎实现已外移至独立包 `packages/zcode-subagent-cli`，
core 侧 `engines/zcode/` 已删除；下文代码锚点按成文时点记录，现行位置见修订记录 v12 与 D2 表行内尾注）。
任务经 `ZcodeEngine.run()` 进入：`AppServerConnection` 惰性 spawn 一个常驻 `zcode.cjs app-server`
进程（stdio NDJSON 协议），`SessionChannel` 在其上做 `session/create → subscribe → send →
事件流 → 终态 → read → close` 的**每任务自包含**会话生命周期。会话正文由 app-server 写
SQLite；引擎侧只读（`reader.ts`）用于 GUI 详情页的「①级 sqlite 读取」。

> 历史读取三级降级链的 gloss（首次出现即定义，避免只熟悉 subagent-core 的读者猜）：
> **①级 = 读引擎原生会话存储**（zcode 读 SQLite / pi 读 JSONL，内容最全）；
> **②级 = 重放宿主 event journal**（`handle.journalPath`，任务运行中逐事件落盘）；
> **③级 = outcome-only**（只有终态文本，内容最少）。降级方向恒 ①→②→③，`SessionView.source` 标记实际命中级。

**设计目标**（从使用者体验倒推）

| # | 目标 | 使用者视角 |
|---|------|-----------|
| G1 | 侧边栏零污染 | 在任意目录跑 zcode subagent，ZCode GUI 侧边栏（含重启后）都不多出会话 |
| G2 | 现有能力零回归 | subagent 执行、GUI 详情页历史（①级 sqlite）、凭据 / 插件 / MCP、并发与 abort 全部与改造前等价 |
| G3 | 不重启复杂度 | 不引入 HOME 池 / 目录锁 / pidfile / 派生目录；pnpm store 与 HOME 语义零变化 |
| G4 | 存量兼容 | 改造前产生的 record（含池时代相对路径、共享 HOME 时代宿主绝对路径）仍能读历史 |
| G5 | 残留可回收 | 隔离库归 xyz-agent 独占，具备可判定的清理通道（我们拥有全部行 + 存量宿主行可用自己的 record 白名单定位）；**口径 = 「行可回收」**（磁盘回收另需 VACUUM） |

**in scope**：zcode 引擎会话库路径隔离（spawn env + 两条读取链白名单 + 存量兼容 + 隔离库回收 +
存量宿主行清理通道）；相关测试与文档/约束同步。

**out of scope**：
① 修改 zcode CLI / GUI 源码（用户约束，排除）；
② `~/.zcode/cli/{artifacts,exec,log,…}` 等**伴生写入面**的治理（磁盘残留，与侧边栏无关）——
**但本设计必须穷举登记它们**（§2.4.1），因为「隔离库」只解决侧边栏，不解决磁盘；
③ zsw（z-code-plugin-workspace）侧代码改动——但**必须分析其连带影响**（§2.4.3）；
④ 让隔离后的会话「在 GUI 里可见但折叠」——GUI 无此 API（§2.5）。

---

## §2 现状与问题分析

### 2.1 污染链路（现状物理数据流）

```
xyz-agent 派发 subagent(engine=zcode)
   │
   │ ① 写入面：spawn `node appserver-launcher.cjs app-server --cwd <engineDataDir>`
   │    env 由 buildAppServerEnv() 组装（connection.ts:128-134）——只覆写
   │    ZCODE_MODEL_TELEMETRY_ENABLED，HOME 保持真实值（共享宿主 HOME）
   ▼
zcode.cjs app-server（常驻进程，每 ZcodeEngine 实例一条连接）
   │ ② session/create {workspace:{path,key}, mode:"yolo", persistence:"immediate"}
   │    → 行落 ~/.zcode/cli/db/db.sqlite
   │      task_type='interactive'（RPC 无 taskType 通道，见 §2.5）
   │      parent_id=NULL、title_source='generated'（偶见 `first_input`——r5 实测删除集 55 行中 1 行）
   ▼
宿主引擎库（GUI 与 xyz-agent 共写同一 SQLite）
   │ ③ 同步面：GUI host 的 zcode-task-index-syncer 按 workspace 订阅 sessions-index
   │    （快照 + delta）；外来 app-server 的会话不在 delta 流里，
   │    靠 GUI 重订阅 / 索引按需重建补上（延迟数十秒~数十分钟）
   ▼
GUI 私有索引库 ~/.zcode/v2/tasks-index.sqlite（tasks 表）
   │ ④ 展示面：queryTaskList({workspaceScopes, kind})
   │    WHERE 基线只有 `deleted = 0`（+ pinned/archived 分类）
   ▼
ZCode GUI 左侧边栏会话列表 ← 用户看到「凭空多出来的会话」
```

### 2.2 根因：三个面都没有我们的位置

| 面 | 现状 | 后果 |
|----|------|------|
| **写入面** | 引擎 app-server 用真实 HOME → 写 GUI 的引擎库 | 会话物理上进入 GUI 数据源 |
| **识别面** | RPC `session/create` 无 `taskType` 参数（strict schema 拒收）→ `task_type` 恒 `interactive`、`parent_id` 为空 | 库里无任何字段能把我们与用户会话区分开 |
| **展示面** | GUI 列表查询不按 `task_type` / `parent_id` 过滤 | 索引里有的行就会显示 |

结论：**只要写入面还落在宿主库，就必然污染**；识别面与展示面我们无法参与（改不了 GUI）。

### 2.3 事实基准（2026-09-08 真机探针 + 存量统计；**数值为成文时快照，参照查询见 §3.2 D7 权威 SQL 正文**）

> 探针脚本已随 2026-09-13 docs purge 删除（commit 722c6886a，git 可追溯）——原
> `docs/design/probes/zcode-session-db/probe-session-db.mjs`（隔离库可行性）、`probe2.mjs`
> （隔离库 + 真实一轮 prompt 端到端），两者都用本仓生产的 `appserver-launcher.cjs` wrapper +
> 真实凭据，只创建临时目录，不触碰宿主库。**结论以当时实测为准（本表【实测】标记），不再宣称可复现**；
> 仍可复跑的证据 = §3.2 D7 的参照 SQL 正文（原 `counts.sql` 已删除并入正文）。

| # | 事实 | 证据 | 置信 |
|---|------|------|------|
| F1 | **`ZCODE_SESSION_DB_PATH` 生效**：app-server 在指定路径建库（19 张表全量迁移），create→subscribe→send→`turn.terminal`→read→close 全链通过；会话行 / message / model_usage 全部落隔离库，**宿主库该 sessionId 0 行** | 探针 `probe2.mjs`（已删，结论以当时实测为准） | 【实测】 |
| F2 | `titleGenerationEnabled:false` 被接受，且**不再产生 `session_title` 用量行**（隔离库只有 `main_turn` 1 行） | 探针 `probe2.mjs`（已删，结论以当时实测为准） | 【实测】 |
| F3 | **`taskType` 参数被 strict schema 拒收**（`-32602 Unrecognized key: "taskType"`）→ RPC 无法把会话标成 `subagent_child` | 探针 `probe-session-db.mjs`（已删，结论以当时实测为准） | 【实测】 |
| F4 | create 应答 `session.sessionKind = "interactive"`，与库里 `task_type` 一致 | 探针 `probe2.mjs`（已删，结论以当时实测为准） | 【实测】 |
| F5 | GUI 侧边栏查询**只按 `deleted` / `pinned` / `archived` 过滤**，无 `task_type` / `parentSessionId` 条件 | ZCode app 包内 `out/host/index.js` 的 `queryTaskList`（`WHERE deleted = 0` + `workspace_key IN (…)` + provider + pinned/archived + 搜索；由 R1 影响面审独立复核） | 【实测】 |
| F6 | 是否进索引的**判别键是 `task_type`，不是 `parent_id`**：`subagent_child` 787/788 条未进索引；`interactive`+有父 13/13 条、`fork`+有父 6/6 条**全部进索引**（无父 `interactive` 766/865 进索引） | 存量双库交叉统计（SQL 见 §3.2 D7 参照 SQL 正文，原 `counts.sql` 已删除并入正文；**本节数字为成文时快照，随数据漂移属预期**） | 【实测·可复跑（参照 SQL 在 §3.2 D7）】 |
| F7 | 污染是**延迟可见**的：外来进程会话靠 GUI 重订阅/按需重建进索引（zsw 同库正例：创建后 1–2 分钟进索引） | GUI 日志 + 索引 `updated_at` 对齐 | 【实测】 |
| F8 | 当前 xyz-agent 已产生 50 条 zcode 会话（今日 10:34–13:17），全在宿主库；这 50 条**当前 0 条**在索引里——因为所在三个 worktree 不在 GUI workspace 列表 | 双库交叉 + `recentProjects` 对比 | 【实测】 |
| F9 | 每条会话额外触发 1 次标题生成模型调用（50 条会话 → 50 条 `session_title` 用量行，37.8k input / 898 output tokens） | `model_usage` 统计 | 【实测】 |
| F10 | 引擎**无删除会话 RPC**（24 个 `session/*` 方法里没有 delete/archive），`session/close` 只回收内存，SQLite 行保留 | engine 协议方法表盘点 + zsw 残留清理设计 | 【实测】 |
| F11 | **池目录删除器会删池内一切非 journal 条目**（含 `db.sqlite*`）：`deletePoolNativeState`（`pool-manager.ts:378`，定义行）由 `releasePoolRef`（`:181`）与 `cleanupExpiredPoolRefs`（`:234` 定义 → `:284` 删除调用点）触发；当前休眠（`acquirePool` 生产零调用方），但**不是设计保证** | `packages/subagent-core/src/execution/engine/common/pool-manager.ts:13-18/181/234/378`（行号 2026-09-13 复核） | 【实测】 |
| F12 | 生产 GUI 详情页的①级读**不经过** core 壳侧 `EnginePort.read()`：链路为 `session-records.ts:313 → readEngineSubagentHistory → readSubagentHistoryMessages → session-view-service.ts:473 → readZcodeNativeTier(:161 白名单)`；`EnginePort.read()`（`zcode-engine.ts:889`）在本仓**无生产调用方**（成文时点实测）。**v12 实态（W11 协议化后）**：runtime ①级读改经 `registerNativeSessionReader` 协议 read（`subagent-engine-history.ts:229`）——①级放行判定内聚引擎包 `zcode-engine.ts` `read()`（:921，白名单集合判定 :936），两条链路同判同源；`readZcodeNativeTier` 符号已不存在（行号 2026-09-13 复核） | 全仓 `rg '\.read\('` + 上述链路逐跳 read；v12 实态 = `registerNativeSessionReader` / `zcode-engine.ts:921` 逐跳 read（2026-09-09，行号 09-13 复核） | 【实测】 |

### 2.4 影响面量化（改造前）

#### 2.4.1 宿主 HOME 下的伴生写入面穷举（P0-19 ⓪；快照时点 2026-09-08，复测 `du -sh ~/.zcode/cli/*`）

> 方法：实装 bundle 路径解析（`zcode.cjs` 的 storage 派生）+ 磁盘实测增量（`find … -newermt` 限定在
> §2.3 F8 的 50 会话窗口 10:30–13:30），非想象列举。

| 写入面 | 路径 | 3h 窗口增量 | 单调累积 | 清理通道 | 本设计判定 |
|--------|------|-----------|---------|---------|-----------|
| 会话库 | `~/.zcode/cli/db/db.sqlite` | 会话行 | 是 | 无（引擎无删除 RPC） | **本设计隔离对象** |
| artifacts | `~/.zcode/cli/artifacts` | +189 项（磁盘 925M） | 是 | 未见 | 另案（登记） |
| 图片/PDF/视频缓存 | `~/.zcode/cli/{image,pdf,video}-cache` | — | 是 | 未见 | 另案（登记） |
| exec | `~/.zcode/cli/exec` | +156 项（117M） | 是 | 空壳 7 天（zsw doctor，仅 zsw 口径） | 另案（登记） |
| log | `~/.zcode/cli/log` | —（538M） | 是 | 引擎自带 `scheduleLogRetentionCleanup`（**通道边界**：每进程**一次性** `setTimeout`（delay 默认 60s、`unref`）、单目录、只匹配 `^zcode-YYYY-MM-DD\.jsonl$`、retention 默认 7 天——**非周期性策略**） | 另案（有通道，边界已登记） |
| clipboard 临时 | `<storage>/clipboard` | — | 否（临时） | OS/引擎 | 另案 |
| agents | `~/.zcode/cli/agents` | 窗口内新增 21 项（每项 20–28K）；**累计 68G**（单目录 ≥1.2G 有 8 个、>2G 有 3 个，最大 4.0G） | 是 | 未见 | **最高风险**（登记 + 重审触发） |
| rollout | `~/.zcode/cli/rollout` | +1（15M） | 是 | 未见 | 另案（登记） |
| debug | `~/.zcode/cli/debug` | —（293M） | 是 | 未见 | 另案（登记） |

**显式判定**：以上伴生面**本设计不治理**（out of scope ②），但登记为已接受代价——
**量级（增量与累计分列，避免口径混用）**：3h 窗口增量（实测）= artifacts +189 / exec +156 / agents +21 / rollout +1；
**累计**存量 = artifacts 925M / log 538M / debug 293M / exec 117M / **agents 68G**（单目录 ≥1.2G 有 8 个、>2G 有 3 个，最大 4.0G）/ 会话库 2.8G。
> 口径说明：窗口增量无法在复审时点复现（窗口已过），上列数值为成文时快照；累计值可随时复测（`du -sh ~/.zcode/cli/*`）。
**恢复路径**：`agents`/`artifacts` 无现成通道，需 zsw `doctor clean`（其识别集覆盖部分）或人工；
**重审触发条件（已越原阈值 → 改为有期限的已接受债务）**：
- 原阈值（任一目录 > 2GB）在成文时**已触发**（`agents` 68G / 会话库 2.8G）→ 该面**无剩余触发点**，改为**新上界**：
  `agents` 累计 > **100G**，或系统盘可用 < **100G**，或 `agents` 周增速 > **10G**（当前可用 436G，约 6 倍余量）；
- **启动条件落成可验证项**：owner = **合入 PR 作者**；期限 = **G1 止血合入后 30 天内**；跟踪位置 = **W4 的子项：合入 PR 内新增 `docs/todo/companion-surface-governance.md`**（含 owner/期限/上界/复测命令；逾期未排期即**升为阻塞项**，检查主体 = 下一次触碰该面的设计/PR 评审）；
- **余量基准**：距上界 100G 还有 **336G**（实测 `df -h /` 可用 436G）；按 `agents` 周增速 10G 估约 **33 周**；
- **判定**：**有期限的已接受债务**（不是无条件可接受）——已越过原阈值，但本设计 out of scope ②（不治理），
  两者并存的前提是上条的 owner/期限/跟踪三者齐全。
**依据**：与侧边栏污染正交，混入会显著放大本设计的改动面。
**为什么不顺手用 `ZCODE_STORAGE_DIR` 一把隔离**：该 env 会连带移动 `cli/config.json`
（引擎侧配置路径派生自 `storage.dir`），使 `appserver-launcher` 的 fs 拦截路径失效、凭据注入整体不可用
（见 §3.2 D5）——收益/风险不成立。

#### 2.4.2 用量观测面（P0-19 ①）

隔离库含 `model_usage` / `turn_usage` / `tool_usage` 三张用量表，并被引擎的聚合查询
（totals / per-model / per-day / per-session）经 `usage/stats`、`session/usage`、`v4/usage/stats`
供 **ZCode GUI 用量页**消费。改造后我们 subagent 的 token 消耗**不再计入该页面**。

- **量级（实测锚，宿主库只读 SQL；口径 = `input+output+cache_read`）**：
  全库 `model_usage` = **20.54B / 76,788 行**（**含 GUI 用户会话**）；
  **全库 `task_type='interactive'` 类目 = 13.70B / 44,111 行（含 GUI 用户会话，非我们）**；
  **我们**（以 record 的 `sessionRef.sessionId` 为白名单）= **92.1M / 838 行**（50 条会话，全部今日）。
  今日（成文时点）全部会话 97.96M → 我们占 **≈94%**；**复测（同日稍后）今日全部已 184.8M，我们占比降至 ≈50%**。
- **后果**：隔离后 ZCode GUI 用量页的**今日口径**会少掉我们这部分（历史占比仅 ≈0.45%，失真集中在当日）；
  用户看到「页面几乎没用量、额度却在掉」会误判——但该失真随用户自身使用**迅速摊薄**（上条复测为证）。

**显式判定（默认不可接受）**：

| 要素 | 内容 |
|------|------|
| **判定** | **不可接受**（第三方 GUI 可见数字失真）——分两条可执行分支 |
| **分支 A：用户判「接受」** | 合入门 = **合入时未裁决即视为接受**（见下行沉默默认），Release Notes 知情条目**必须随合入发布**；无需实现 |
| **分支 B：用户判「不可接受」** | 候选① 必须成为 §5 的 W 单元（含 owner/期限）**且同批补「宿主库新表写入面」分析**（对方 schema 迁移容忍度 / 消费方 / 清理通道——§2.4.1 未穷举该面）；或改选候选②（xyz-agent 侧自建视图，不写宿主库） |
| **用户沉默时（默认走向）** | 截止点 = **合入评审时点**未裁决 → **视为分支 A**（接受 + Release Notes 知情落点）——与「W5/W6 不阻塞 G1」的节奏一致；若用户随后改判「不可接受」，按分支 B 起独立设计（不回溯 G1）。**沉默 ≠ 永久接受**：Release Notes 告知后用户仍可提异议触发重审（重审触发条件见下行） |
| **分支 B 的写面分析落点** | 挂在**候选① W 单元的 DoD 首项**（分析先行于实现）；候选① 未立项则分支 B 不成立（此时只能选候选②） |
| 依据 | 该页是 ZCode GUI 的可见数字；工程侧可观测性不丢（我们 record 已记 token、详情页可见、历史行不丢） |
| owner / 期限 | owner = **合入 PR 作者**；期限 = **合入前**；知情落点 = 修订记录 + Release Notes（若最终选择「接受」） |
| 恢复路径 | 历史数据仍在宿主库（改造不动存量行），无数据丢失 |
| 重审触发条件 | 用户裁决为「不可接受」→ 立即启动候选设计；或**今日占比 ≥ 80% 连续 3 日**（相对指标可能随摊薄永不响应 → 故同时监控**绝对缺失量**：我们今日 tokens 连续 3 日 > 100M 即回审） |

#### 2.4.3 第二宿主 zsw（P0-19 ①）

本设计改的是**共享 core**，但 zsw 消费的是 **vendored 副本**（`lib/vendor/subagent-core/`，由 zsw 仓
`scripts/vendor-subagent-core.js` 刷新 + 插件包发版；`lib/core-ref.js` 头注明确「三形态都没有 node_modules 解析面」）
——**不是自动继承**：只有在 zsw **re-vendor + 发版**之后，其新会话才落
`~/.zcode/zsw/engines/zcode/session-db/db.sqlite`；在此之前 zsw 继续写宿主库
（`lib/config.js` 的 `engineDbPath = <cliRoot>/db/db.sqlite` 硬编码）。

- **继承时序（写实）**：xyz-agent 合入 → core 版本 bump → zsw re-vendor（**版本门槛 = 本设计合入的 core 版本**）
  → zsw 发版 → 新会话落隔离库。**观测主体**：re-vendor 之前「zsw 侧隔离库 > 1GB」的观测对象
  **不存在**（条件永不触发），故重审触发条件必须带该前置。
- **清理归属（交付物写实 + 本仓可验证）**：zsw `doctor clean` 硬编码宿主库 → 对新库恒 0 命中。交付物拆两半：
  ① **本仓可验证部分**（W5b）= 导出 `zcodeSessionDbPath` + 清理规格由**仓内清理脚本**
  `scripts/zcode-session-db-cleanup.mjs` 承载（头注即实现纪律：I1–I3b 判据 / I2_TOLERANCE_MS
  唯一常量 / 删除面与跨库顺序 / 残留清单与 `--replay-residue`；原规格文件
  `docs/design/handoff/zsw-session-db-cleanup-spec.md` 已随 2026-09-13 docs purge 删除，git 可追溯）；
  ② **跨仓部分**降为「投递动作」：在本仓记录 owner + 投递日期，登记动作 owner = zsw。
  → 避免「跨仓承诺不可验证」。

**显式判定**：可接受（迁移期）。依据：① 隔离库体量按 §2.4.4 量级可控；② 清理归属与登记已写实（上条）；
③ **误删面口径纠正**：zsw `clean-identify.js` 的三类识别集（`task_type='subagent_child'` 按龄 /
自身 records 白名单 / 特征目录闭集）**从未能识别我们的行**（我们是 `interactive` + 普通 worktree 路径），
改造前后命中概率同为 0——本设计**不改变该事实**，因此不主张「隔离也隔离了误删面」。
**重审触发条件**：**zsw 已完成 re-vendor** 且其隔离库 > 1GB，或 zsw 用户报告磁盘异常；
**补一条**：下次 zsw re-vendor 时校验「其隔离库路径 == `zcodeSessionDbPath` 推导值」与「清理工具已覆盖新库」（否则缺口静默存在）。

#### 2.4.4 存量污染行与恢复通道（P0-20）

- **量级**：当前 50 条（3 小时/3 个 worktree）；按 **8h 活跃口径**（与 D4 同源）≈ **130 条/日**，即 **百条量级/日**。
- **可见性**：当前 0 条在 GUI 索引里，仅因所在目录不在 GUI workspace 列表（F8）；用户一旦在 GUI
  打开这些目录，存量行会**成批涌现**（F7）。
- **恢复通道（改造前）**：zsw `doctor clean` **清不到**我们的行（其识别集 = zsw 白名单 / 特征目录 /
  `subagent_child`，我们是 `interactive` + 普通 worktree 路径，识别集见 §2.4.3）——即改造前**无通道**。
- **本设计提供的通道（W5）**：我们**知道自己的 sessionId**（record 的
  `engineHandle.sessionRef.sessionId`，落在宿主 record 存储里）→ 可构建「以自身 record 为白名单」的
  清理工具（删除宿主库行 + tasks-index 行联动，须停机窗口）。本设计**登记该通道并给出规格**，
  实现排期独立（不阻塞 G1 的新污染止血）。
- **显式判定**：存量行**可接受**（不阻塞本设计），因为：① 它们不再增长（新污染已被隔离）；
  ② 有明确通道（上条）；③ 清理是破坏性操作，需停机窗口与用户授权，不应塞进本设计主链。
  **重审触发条件**：用户报告「GUI 侧边栏出现历史 subagent 会话」→ **启动 W5 清理流程**（含停机窗口与授权编排，非即时执行）。

### 2.5 三个「显然的修法」为什么都不成立

| 候选 | 结论 | 依据 |
|------|------|------|
| 传 `taskType: "subagent_child"` 让 GUI 过滤 | **不可行** | RPC strict schema 拒收（F3）；GUI 侧只显示不按 kind 过滤（F5），真正过滤发生在**索引导入**环节 |
| 传 `parentSessionId` 让会话变成子会话 | **不生效** | 父会话只影响 `parent_id`，`task_type` 仍是 `interactive`（F4）；而进索引的判别键是 `task_type`（F6）——13 条带父 `interactive`（fork 派生）全部在侧边栏里 |
| 任务结束删库行 | **不可行** | 引擎无删除 RPC（F10）；直写别人家的库要处理 **11 张带 FK 的引用表（12 个 FK 列）** + 无 FK 的 `input_history`（显式删）+ `part`（经 `message` 传递级联）+ `PRAGMA foreign_keys=ON` 连接级开关（zsw 已论证），且会毁掉我们自己的①级历史读取 |
| 隔离 HOME（回到池化） | **代价过大** | 2026-09 已按用户拍板删除（HOME 副作用 / pnpm store 翻转 / 锁 / pidfile / 派生目录），本设计要保留其收益（G3） |

---

## §3 解决方案

### 3.1 方案对比

| 方案 | 做法 | 长期架构合理性 | 短期实现成本 | 风险 | 结论 |
|------|------|---------------|-------------|------|------|
| **A 隔离会话库（推荐）** | spawn env 加 `ZCODE_SESSION_DB_PATH` → `<engineDataDir>/engines/zcode/session-db/db.sqlite`；两条读取链白名单跟随 | **好**：写入面根治，HOME 语义不动，隔离库归我们独占（可回收） | **低**：env 1 行 + 路径构造函数 + 两处白名单 + 存量兼容分支；已探针验证全链 | 中：需验证「共享库假设」在别处不存在 | ✅ 推荐 |
| B 源头减害 + 回收通道 | 保留宿主库，只加 `titleGenerationEnabled:false`，并把 sessionId 落盘做清理白名单 | 差：不解决侧边栏，只减少成本；清理仍要停机窗口 | 低 | 低 | 备选（A 的真机门若不过则退此） |
| C 接受现状 + 外部维护 | 不改代码，靠 GUI「任务自动归档」+ 周期离线清理 | 差：用户侧边栏仍然被污染 | 零 | 中：残留不可识别，清理需自建识别集 | 不推荐 |

**推荐 A，理由三条**：① 它直接消掉 G1（侧边栏零污染）而不牺牲 G3（不重启复杂度）——两者在 2026-09
决策里被当成互斥的取舍，本设计证明**不互斥**（隔离库 ≠ 隔离 HOME）；② 探针已把最大的未知项
（env 是否被引擎采纳、端到端是否可用）变成实测事实（F1）；③ 隔离库由我们独占，顺带解决 G5
（残留可回收），而 B/C 的清理永远受「行不可识别」制约。

**与 2026-09 决策的关系**：`zcode-engine-appserver-resident.md:12` 登记的「已接受代价：GUI 会话列表
可见 headless 会话」由本设计**撤销**（写入面改变后该代价不成立）；该决策其余部分（常驻连接 /
abort 链 / 会话自包含 / capabilities / 停机面 / 共享 HOME）**全部不变**。

### 3.2 方案 A 详细设计

#### 目标物理数据流（含进程与绝对路径）

```
pi 扩展进程（xyz-agent）/ zsw CLI 进程
 └─ ZcodeEngine
      │ ① spawn env：HOME 保持真实值（不变）
      │    + ZCODE_SESSION_DB_PATH=<engineDataDir>/engines/zcode/session-db/db.sqlite   ← 新增
      │    + 清空 ZCODE_SESSION_DB（同层别名键，见 D1）
      ▼
   zcode.cjs app-server（常驻；连接/会话/事件语义零变化）
      │ ② 会话行落**隔离库**（我们独占；任务间 WAL 并发同前）
      ▼
   <engineDataDir>/engines/zcode/session-db/db.sqlite     ← journal 分组目录之外（`cleanupExpiredJournals`
                                                         [池抽象降级后更名，原 cleanupExpiredPoolRefs] 会把
                                                         `engines/<id>/*` 每个子目录**枚举**，但 db.sqlite*
                                                         不匹配任何删除条件——由 A9 断言，见 D4）
      │ ③ handle.sessionRef.dbPath = 隔离库绝对路径（运行中回填 + 终态 handle 同源）
      ▼
   读取链（两条独立白名单，均需放行隔离路径）
      ├─ 生产链（成文时点）：runtime 进程 → readEngineSubagentHistory → session-view-service.readZcodeNativeTier
      │    【v12 实态·W11 后】runtime 进程 → registerNativeSessionReader 协议 read
      │    （subagent-engine-history.ts:229）→ 引擎包 zcode-engine.ts read()（白名单判定 :936）
      └─ API 链：EnginePort.read()（zcode-engine.ts，成文时点仅测试触达；
           v12 实态 = 协议 read 与生产链共用同一 read() 判定）
      ✗ ZCode GUI：宿主库无行 → 同步面拿不到 → 侧边栏不再出现
```

#### D1 路径与 env 契约

- **路径（单一构造函数）**：`zcodeSessionDbPath(engineDataDir) = join(engineDataDir, "engines", "zcode", "session-db", "db.sqlite")`。
  **选址在池目录之外**（不落 `engines/zcode/shared/`）——`engines/zcode/shared/` 是 journal 池目录，
  被 `deletePoolNativeState` 覆盖（F11）。journal 路径不变（仍 `engines/zcode/shared/journal-<taskId>.jsonl`）。
  构造函数是唯一权威（禁止手拼字面量），与 `resolvePoolDir` 同款纪律；engineDataDir 由现有
  `deps.engineDataDir()` 提供。
- **env**：在 `zcode-engine.ts` 组装 app-server env 处追加 `ZCODE_SESSION_DB_PATH`（覆盖式写入，
  忽略宿主继承值——避免用户 shell 里的同名 env 把我们重定向到别处）；**同时显式清空同层别名键
  `ZCODE_SESSION_DB`**（实装里 `ZCODE_SESSION_DB_PATH` 与 `ZCODE_SESSION_DB` 都映射到 `storage.sessionDbPath`，
  按 env 键序后写胜出；当前写法恰然后写，但那是顺序巧合，必须显式化）。
- **配置优先级依据**：引擎配置分层 `Cli 50 > Env 40 > Session 30 > Project 20 > User 10 > System 0`，
  故 env 覆盖用户 `~/.zcode/cli/config.json` 里的 `storage.sessionDbPath`——D1 的覆盖语义成立（已核实）。
- **父目录**：引擎**自身**会递归创建（`ensureParentDir`，由 `SqliteSessionStore` 构造期以解析后的 `dbPath` 调用）
  ——故「父目录不存在」不是失败原因；D6 E1 的真实信号是 **EACCES/ENOSPC 下的
  `Failed to open SQLite session database at <path>`（`kind: open_failed`）**。
  我们仍建议启动前 `mkdirSync(recursive:true)`（把权限/磁盘错误提前到可读文案）。
- **禁硬编码**：路径一律由 `engineDataDir` 推导（pre-commit 路径白名单检查）。

#### D2 两条读取链与白名单（**本设计最易错的一处**）

| 链路 | 位置 | 现状 | 改造后 |
|------|------|------|--------|
| **生产链**（GUI 详情页①级读） | `engine/common/session-view-service.ts:161`（`readZcodeNativeTier`）——**已迁（v12 实态）**：runtime `registerNativeSessionReader` 协议读（`subagent-engine-history.ts:229`），①级放行判定内聚引擎包 `zcode-engine.ts:936` | 绝对路径只认 `resolve(homedir(), ...ZCODE_HOST_DB_SUFFIX)` | 白名单集合加入 `zcodeSessionDbPath(dataDir)` |
| **API 链**（`EnginePort.read()`） | `zcode-engine.ts:889`（成文时点；**v12 实态** = `packages/zcode-subagent-cli/src/zcode-engine.ts:921`，协议 read 与生产链同判） | `dbPathRaw === hostZcodeDbPath()` | 同上（集合成员判定） |
| handle 回填 | `zcode-engine.ts:407/453`（成文时点；**v12 实态** = 引擎包 `zcode-engine.ts:429/:484`） | `dbPath: hostZcodeDbPath()` | `dbPath: zcodeSessionDbPath(engineDataDir)` |

- **白名单形态**：由单一构造函数产出**合法路径集合** `zcodeDbPathAllowlist(dataDir) = {zcodeSessionDbPath(dataDir), hostZcodeDbPath()}`
  （后者仅为存量兼容，见 D3），两站点都只做「集合成员判定」——避免 `||` 列表膨胀（未来第三个路径只需改集合构造）。
- **dataDir 权威源（含传播前提，勿当同源事实）**：两站点各自用**它打开数据库时所用的同一个 dataDir** 构造集合——
  生产链用 runtime 传入的 `dataDir`（`getDataDir()`，缺省 `~/.xyz-agent`），API/写侧用 `deps.engineDataDir()`
  （`getEngineDataDir()`，env 缺失时**回退 `HostServices.dataRoot()` = pi agent dir**，与前者缺省值**不同**）。
  当前产品路径下两者相等，靠的是**传播链**：runtime `process-manager.ts:136` 显式注入 `getConfigDir()`（≡`getDataDir()`）
  → pi 子进程 `{...process.env}` 继承（`session-runner.ts:1764`）→ 引擎 spawn 透传。
  **前提**：该 env 必达；任一 spawn 点剥掉它，写侧落 `<piAgentDir>/engines/zcode/session-db/db.sqlite`
  而读侧按 runtime dataDir 构造白名单 → ①级**静默**降②级（A3 在正常配置下测不到）。
  兜底：单元断言「xyz-agent spawn 配置下两站点 dataDir 相等」+ D3 单列该形态。
- **安全边界不变**：record/handle 来自 append-only JSONL（不可信面），**只放行集合内精确绝对路径**，
  其余绝对路径继续拒绝①级、降 journal——防任意文件读。
- **`hostZcodeDbPath()` 定位变更**：降级为「存量兼容锚点」，仅出现在集合构造与兼容测试里（注释改写）。

#### D3 存量兼容（零迁移）

| record 时代 | `sessionRef.dbPath` 形态 | 改造后行为 |
|------------|------------------------|-----------|
| 池时代（2026-09 前） | 相对路径（`.zcode/cli/db/db.sqlite`） | 走池目录锚定分支（[池抽象降级] 锚定 key 用 SDK SHARED_POOL_KEY 常量承载，值恒 'shared'——协议面 poolKey 已删，池时代真实池 key 不再随 handle 传输；锚定目录不存在时自然降②级 journal） |
| 共享 HOME 时代（2026-09–本次改造） | 宿主库绝对路径 | 白名单集合第二项放行 → ①级可读（**不迁移、不删除**） |
| 本次改造后 | 隔离库绝对路径 | 集合第一项放行 |
| **误配（env 未传播）** | 隔离库落在 `HostServices.dataRoot()`（pi agent dir）下 | 读侧集合按 runtime dataDir 构造 → **不含**该路径 → ①级**静默**降②级 journal；修 env 后恢复。由单元断言「两站点 dataDir 相等」在测试期拦截 |

隔离库是**新建**的，不导入任何历史会话；宿主库里的历史行保持原样（处置见 §2.4.4 / D7）。

**非会话状态不继承（新增枚举）**：隔离库是空库，宿主引擎库的非会话表状态不会带过去——实测 `local_setting` **189 行**
（`permission|mode` 174 项目级 + `permission|ruleset` 14 项目级 + `model|reasoningLevel` 1 用户级）；
`permission` / `workflow_definition` / `workflow_event` 均 0 行。
**判定**：**不继承但无行为差异**——依据 = `session/create` 显式传 `mode`（我们固定 `yolo`），本项目不依赖宿主侧
项目级 permission ruleset / 用户级 reasoningLevel；**重审触发条件**：出现「权限/推理档位与改造前不一致」报告 → 升级为独立影响面。

#### D4 隔离库生命周期与回收（代价四要素）

- **归属**：隔离库只被 xyz-agent 的 zcode 引擎写（GUI 不认这个路径）→ **全部行都是我们的**。
- **量级（锚 = **我们自己的会话**，不是全库均值；两法交叉实测）**：
  ① dbstat 按行数占比归属：我们 50 条会话合计 **≈15MB → 0.30MB/会话**；
  ② 逐 session 键控表 `sum(length(data))` × DB 页开销 1.75：我们 50 条 = 10.46MB data → **0.37MB/会话**；
  取区间 **0.3–0.4MB/会话**（对照：全库均值 1.80MB/会话——**不可用**，含 GUI 长会话，差 ≈4.9×）。
  窗口增量（3h/50 会话）= **推导值** ≈ 50 × 0.35MB ≈ **17MB/3h**（非实测；§2.4.1 同窗口只测了会话数）。
  日增量（统一口径 = **8h 活跃**）：≈ 130 会话/日 × 0.35MB ≈ **45MB/日**（区间 40–50MB/日；24h 口径为 ≈140MB/日，本设计统一采 8h 口径，§2.4.4 同源）。
  → 阈值时间预期：`>2GB` ≈ **45 天**；行龄 90 天对应 **≈4GB**。
- **恢复路径（含代价）**：删除 `session-db/db.sqlite*` 即可（引擎下次启动重建）。
  **代价**：隔离库是**唯一**①级历史源 → 删库 = 全部 subagent 历史降②级 journal（journal 自身靠 30 天 TTL 兜底回收），
  **且无 per-session 删除粒度**（W6 前）。
  **前置条件**：无在途任务 + 引擎已 dispose（或宿主退出）；运行期删除见 D6 E3。
- **重审触发条件**：隔离库 > 2GB，或最早行龄 > 90 天，或用户报告磁盘异常 → 启动 TTL 清理（W6，**预期 ≈45 天内就绪**——先就绪再触发，不再是硬 T+2 周）。
- **显式判定**：**可接受**（首期不做自动删除）。依据：量级可控 + 我们独占 + 通道明确。
- **禁止**：运行期删除隔离库文件（在途会话句柄会失效，D6 E3 已按事实改写）。
- **与 journal TTL 清理的边界（措辞与实装对齐，作用域已限定；[池抽象降级 2026-09-13] 后口径）**：隔离库**不在 journal 分组目录内**；`cleanupExpiredJournals`
  （`pool-manager.ts`，[池抽象降级] 更名自 `cleanupExpiredPoolRefs`，refs 引用计数机制已删）把
  `engines/<engineId>/` 下**每个子目录**都遍历，`session-db/` 因此会被当作「伪分组」枚举。
  对 `db.sqlite*`：**不匹配任何删除条件**（清理目标只有 `journal-*.jsonl` 与池时代 `refs.json` 残留）。
  **但作用域仅限 `db.sqlite*`**：若该目录内出现超龄 `journal-*.jsonl`，会被当孤儿 journal 删。
  实践不可达（无代码往该目录写 journal），但这是**隐式假设**，不是结构保证
  → 由 **A9 守卫测试**（core `pool-manager.test.ts` + 引擎包 `zcode-session-db-pool-gc.test.ts`
  枚举/结构断言）钉死。

#### D5 明确不动的面（防实施者过度扩展）

| 面 | 结论 | 理由 |
|----|------|------|
| HOME / 凭据注入 wrapper | **不动** | `appserver-launcher.cjs` 的 fs 拦截只关心 `~/.zcode/cli/config.json`，与库路径无关 |
| `ZCODE_STORAGE_DIR` | **不设** | 它会连带移动 `cli/config.json`（配置路径派生自 `storage.dir`），使 wrapper 的拦截路径失效、凭据注入整体不可用 |
| 插件 / MCP / agents 目录 | **不动** | 仍从共享 HOME 继承（GUI 装什么我们用什么） |
| `~/.zcode/cli/{artifacts,exec,log,…}` | **不动**（out of scope ②，已穷举登记 §2.4.1） | 与侧边栏无关；跟随 `storage.dir` 的改动会破坏上一条 |
| 连接 / 会话 / abort / capabilities / dispose | **不动** | 本设计只改「库写在哪」+「我们从哪读」 |
| zsw 侧 | **不动**（影响面已登记 §2.4.3） | 它继承共享 core，清理归 zsw 排期 |

#### D6 错误规格与恢复指引

| 触发 | 信号 | 引擎行为 | 用户可见 / 恢复 |
|------|------|---------|----------------|
| E1 隔离库不可写（权限 / 磁盘满） | `Failed to open SQLite session database at <path>`（`kind: open_failed`；引擎自身 `ensureParentDir` 会建父目录，故**不是**「父目录不存在」） | 任务失败，错误含隔离库路径 | 检查 `engineDataDir` 权限与磁盘后重试（错误文案带路径） |
| E2 隔离库 schema 迁移失败（zcode 升级） | app-server 启动期迁移报错 | 任务失败（与宿主库同语义） | 备份并删除隔离库文件后重试（库可重建；历史详情降②级 journal，record 不丢） |
| E3 运行期删除隔离库文件 | app-server 启动期已打开 store（`openStartupSessionStore` + `startup.sqlite_migration`）；unlink 后**既有 fd 继续写已删 inode**，新库只在 app-server 重启后出现 | 在途任务数据写入已 unlink 的 inode（重启后不可见）；重启后自动重建新库 | **禁止运行期删除**；需停机窗口（无在途任务 + 引擎 dispose 后）。恢复：重启宿主后自动建新库，历史详情降②级。**unlink 集合 = `db.sqlite*`（含 `-wal`/`-shm`）**——只删主文件而留残留 WAL/SHM 时，观测形态与断言不一致（E2 的恢复动作已用 glob，口径统一） |
| E4 env 被宿主覆盖 | —— | 引擎侧**覆盖式写入** `ZCODE_SESSION_DB_PATH` 并**清空** `ZCODE_SESSION_DB`；配置分层 `Cli > Env > …` 保证 env 压过用户 config | 无 |
| E5 隔离库路径与宿主库同路径（误配） | 单元测试守卫 | 断言两者恒不等 | 无（配置错误在测试期拦截） |
| E6 多进程首开迁移竞争 | 两个宿主/进程同时首开隔离库 | 引擎自带迁移锁（`ZCODE_FILE_LOCK_TIMEOUT`）；失败按 E2 恢复 | 重试；仍失败按 E2 |

#### D7 存量宿主行清理通道（独立通道；实现规格由 `scripts/zcode-session-db-cleanup.mjs` 承载——原 impl-plan §2.5 已删除，git 可追溯）

**决策**：存量污染行（我们改造前写进宿主库的会话行）需要一条**独立清理通道**，排期独立、不阻塞 G1 止血；
**必须经用户授权**（停机窗口 + 整库备份）。

**四条设计级不变量**（为什么是这个形状）：

1. **白名单只能来自我们自己的 record**（`engineHandle.sessionRef.sessionId`）——我们**知道自己的 id**（区别于邻仓 zsw
   `doctor clean` 的「库里不可识别」）；record 是 append-only JSONL（**不可信面**），故必须**只解析结构化 entry**，
   禁止文本/正则提取。
2. **误删面必须可证明为零，且判据不能用「字段长相」**：实测证明用户会话与我们自己的行在 `task_type`/`title_source`
   上**完全同分布**（用户 interactive 会话 885 行里 generated 656 / first_input 135；我们的直接删除集同样是 interactive+generated）
   → 只能靠**跨源交叉验证**（record 的 `startedAt` 与宿主行 `time_created` 互证；record **没有目录字段**，故目录维度不可作硬判据）。
3. **删除必须可回滚**：整库快照 + 整库还原（无单行回滚）；窗口内所有写者必须停用（含第二宿主与 GUI）。
4. **双库一致性由工具保证**：宿主库有 FK 兜底，**索引库零 FK 到 `tasks`** → 索引侧冲突面必须显式预检；
   跨库顺序固定为「先宿主后索引」，使中间态只可能是可恢复方向，且残留必须落清单、可补删。

**被否谱系**：字段式哨兵（两次失效：恒非空 → 恒真）→ 四件套安全网（层间交互互相击穿）→
「FK 机制兜底一切」（索引库零 FK，死断言）→ 「record 目录交叉验证」（字段不存在）。

**残余风险（已登记）**：record 白名单被污染/伪造时，落在时间窗内的用户会话仍可能通过 → 量级 ≈3/1642，
恢复 = 整库回滚，重审触发 = 误删报告或碰撞计数 > 10。

**实现级规格**（I1 双计数 / I2 时间戳容差与唯一常量 / I3 与 I3b 作用域 / 执行形态与 `--confirm-count` /
索引预检与跨库顺序 / 残留清单与 `--replay-residue` / 备份粒度与窗口写者清单）由代码承载（原 impl-plan §2.5 已删除，git 可追溯；入口 = `scripts/zcode-session-db-cleanup.mjs`）。

**删除面（按实装 schema，2026-09-08 只读打开 `~/.zcode/cli/db/db.sqlite` 核实）**：

- 宿主库：`session` 行 + **11 张带 FK 的引用表（12 个 FK 列，`session_task_link` 占 2 列）**；
- `input_history.session_id` **无 FK、也无间接级联路径** → **显式 DELETE**（并保留与 zsw `countInputHistoryHits` 同款计数）；
- `part` **无到 `session` 的直接 FK**，但 `part.message_id → message(id) ON DELETE CASCADE` → 经 `message` **传递级联**（自身带 `session_id NOT NULL` 列）；
- **前置 `PRAGMA foreign_keys = ON`**（FK 级联是**连接级开关**，`node:sqlite` 默认 ON、`better-sqlite3` 默认 OFF——不写则级联静默失效）；
- **越行修改登记**：3 个 `ON DELETE SET NULL`（`session_task_link.parent_session_id`、`workflow_run.parent_session_id`、
  `workflow_activity.child_session_id`）会在删白名单行时**修改引用行的列** → 与「只删白名单命中行」不同口径，执行后须报告被改行数；
- 索引库：删除面 = `tasks` + `automation_runs.session_id` + `tasks.forked_from_task_id`（实测当前 0 行非空）；
  **`task_group_members` / `automations.target_task_id` / `off_peak_tasks.session_id` / `tasks.off_peak_task_id` 属冲突源（只读预检，命中即剔除 id），不列入删除面**。
- **派生行（越行修改与残留）**：实测 `session.parent_id ∈ 删除集` 有 **4 条**（r5 复测 6 条；`sess_subagent_agent_*`，`task_type='subagent_child'`，目录为本仓 worktree，即 zcode 内部子会话）→ **纳入删除集**（否则宿主库留残行 + 其 message/usage 行，与 G5「行可回收」有缺口），并在报告里单列；
  `session_task_link` / `workflow_run` / `workflow_activity` 的 SET NULL 命中实测 **0**。

**代价（四要素）**：
**量级**：备份双库三件套实测 **2.86GiB（= 3.07GB，单位统一为 GB）**——db.sqlite 3,028,619,264B + wal 4,173,592B + shm 32,768B + index 41,066,496B + index-wal 2,014,712B；
**停机窗口（分段）**：备份 3GB ≈ 数十秒（实测为准）+ 删除 ≈ 秒级 + **可选 VACUUM 分钟级（须在窗口内、独占访问）**；
**前置**：执行前检查可用空间 ≥ **峰值 ≈ 9GB**（备份 3GB + VACUUM ≈2×）；
**注意（口径）**：**删行不回收磁盘**（3.0GB 库删行后文件仍 3.0GB；VACUUM 需 ≈2× 空间与分钟级耗时）
→ G5 口径明确为**「行可回收」**，磁盘回收另需 VACUUM（可选步骤，写进工具指引）；
**恢复路径**：备份三件套回滚；**重审触发条件**：用户报告 GUI 侧边栏出现历史 subagent 会话；
**判定**：通道存在、代价可接受（一次性操作）。

**A11 的双口径与删除集构成（必须分离计数）**：邻仓头注硬约束——「**白名单总数 ≠ 白名单∩引擎库**」。
实测（2026-09-08 成文时快照，复测值随会话增长漂移）：record 白名单 **84**（r5 复测 89）条，其中宿主绝对路径 50 条、池时代相对路径 34 条；宿主库命中 **50**（r5 复测 55）。
→ 数字均为**快照值**，A11 断言一律用「复测时的实际值」+ 独立参照 SQL（不写死数字）。
→ **直接删除集 = 白名单 ∩ 宿主库（本次 50）**；**派生删除集 = `parent_id ∈ 直接删除集 且 task_type='subagent_child'`（本次 4）**；
**删除集总数 = 54**。差额 34 逐条归因（池时代相对 dbPath，不进宿主库）。
**独立参照 SQL（不依赖工具自算）**：**本节以下代码块即权威文本**（原 `docs/design/probes/zcode-session-db/counts.sql` 已删除并入正文；跨双库：宿主库直接集/派生集 + 索引库四冲突源只读预检；「W5 参照查询」节为 D7 I1 的单一文本来源，勿在别处复制），工具自算值必须等于该参照；不相等则逐条归因。

```sql
-- ============================================================================
-- zcode-session-db-isolation.md 的 F6 / F8 / F9 证据查询（可一键复跑）
--
-- 两库均以只读模式打开（不会写入宿主数据）：
--   引擎库：~/.zcode/cli/db/db.sqlite
--   索引库：~/.zcode/v2/tasks-index.sqlite
--
-- 用法（macOS 自带 sqlite3；本节即原 counts.sql 的权威文本，已并入正文——
--   将本节 SQL 保存为临时文件后按下列方式执行）：
--   sqlite3 "file:$HOME/.zcode/cli/db/db.sqlite?mode=ro"      < /tmp/counts.sql
--   sqlite3 "file:$HOME/.zcode/v2/tasks-index.sqlite?mode=ro" < /tmp/counts.sql
-- 说明：同一份脚本在两个库上执行时，不适用的语句会因缺表报错——按下面的分节标记
--       分别在对应库上执行对应段落即可（或直接跑整份，忽略「no such table」行）。
-- 复现时点：2026-09-08；数字随时间变化属预期（本文件的价值是「查询可复跑」）。
-- ============================================================================

-- ── 1) F6：进索引的判别键是 task_type（不是 parent_id） ──── 引擎库 ──────
-- 输出（2026-09-08 实测）：
--   interactive|no_parent|867   subagent_child|has_parent|792
--   interactive|has_parent|13   fork|has_parent|6   selection_side_chat|has_parent|2
SELECT task_type,
       CASE WHEN parent_id IS NULL THEN 'no_parent' ELSE 'has_parent' END AS parent_state,
       COUNT(*) AS n
FROM session
GROUP BY task_type, parent_state
ORDER BY n DESC;

-- 索引库侧：列出已进索引的 task_id（与上面 session.id 交叉即得 F6 的
-- 「subagent_child 787/788 未进索引；interactive+has_parent 13/13 全进」结论）
SELECT COUNT(*) AS indexed_tasks FROM tasks;
SELECT task_id FROM tasks ORDER BY task_id;

-- ── 2) F8：xyz-agent 自身产生的会话与其索引命中数 ─────────── 两库 ──────
-- 白名单来源 = xyz-agent record 存储里的 engineHandle.sessionRef.sessionId：
--   grep -h -o '"sessionId":"[^"]*"' ~/.xyz-agent/pi/sessions/*.jsonl | sort -u
-- 把结果贴进下面两个 IN 列表（示例占位，勿留占位符执行）：
-- 引擎库：
SELECT COUNT(*) AS our_sessions,
       MIN(time_created) AS first_created,
       MAX(time_created) AS last_created
FROM session
WHERE id IN ('<sessionId-1>', '<sessionId-2>' /* … */);

-- 索引库：
SELECT COUNT(*) AS our_indexed_tasks
FROM tasks
WHERE task_id IN ('<sessionId-1>', '<sessionId-2>' /* … */);

-- ── 3) F9：会话标题生成的用量行（`titleGenerationEnabled:false` 的对照） ── 引擎库 ──
-- 判别列是 query_source（取值：main_turn / subagent / session_title / compact），
-- 不是 task_type（task_type 只有 interactive / subagent_child / fork）。
SELECT COUNT(*) AS title_usage_rows,
       SUM(input_tokens) AS input_tokens,
       SUM(output_tokens) AS output_tokens
FROM model_usage
WHERE query_source = 'session_title';

-- 对照：全部用量规模（**口径 = input+output+cache_read_input_tokens，与正文 §2.4.2 一致**）
SELECT COUNT(*) AS all_rows,
       SUM(input_tokens + output_tokens + cache_read_input_tokens) AS total_tokens_same_caliber,
       SUM(computed_total_tokens) AS computed_total_tokens_for_reference
FROM model_usage;
-- 注：computed_total_tokens 约为前者一半（实测 10.45B vs 20.57B）——两者口径不同，勿混用。

-- ── 5) D4 量级锚：我们自己的会话 vs 全库均值（可复现） ─────── 引擎库 ──
-- 白名单：先用第 2 节的 `grep -h -o '"sessionId":"[^"]*"' ~/.xyz-agent/pi/sessions/*.jsonl | sort -u`
-- 口径：逐 session 键控表 sum(length(data)) ÷ 命中会话数 × DB 页开销
SELECT (page_count * page_size) AS db_bytes,
       (SELECT SUM(length(data)) FROM part) AS part_bytes,
       (SELECT COUNT(*) FROM session) AS all_sessions
FROM pragma_page_count(), pragma_page_size();
-- 方法①（dbstat 按行数占比归属，与文档 D4 方法①对应）：
--   sqlite3 "file:$HOME/.zcode/cli/db/db.sqlite?mode=ro" \
--     "SELECT name, sum(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC;"
--   再乘以「我们命中行数 / 全表行数」即得归属占用（文档实测 part 11.70MB + message 1.25MB
--   + session_entry 0.22MB + model_usage 0.81MB + tool_usage 0.48MB ≈ 14.5MB / 50 = 0.29MB/条）。
-- 我们的子集（把 id 列表贴进 IN）：
SELECT (SELECT SUM(length(data)) FROM part  WHERE session_id IN ('<id>' /* … */)) AS our_part_bytes,
       (SELECT SUM(length(data)) FROM message WHERE session_id IN ('<id>' /* … */)) AS our_msg_bytes,
       (SELECT SUM(length(data)) FROM session_entry WHERE session_id IN ('<id>' /* … */)) AS our_entry_bytes;
-- 2026-09-08 实测：全库 1,726,000,853B / 1682 会话 → 1.80MB/条；
--   我们 10,459,192B / 50 会话 → 0.37MB/条（页开销 1.75×）→ **差 4.9×**。

-- ── 6) §2.4.1：宿主伴生写入面（shell，非 SQL） ──────────────────────────
-- 窗口增量（成文时的 3h 窗口；窗口已过，仅作口径示例）：
--   find ~/.zcode/cli/<dir> -newermt "2026-09-08 10:30" ! -newermt "2026-09-08 13:30" | wc -l
-- 累计存量（随时可复测）：
--   du -sh ~/.zcode/cli/*

-- ============================================================
-- W5 参照查询（D7 I1 的「独立参照 SQL」单一文本来源；本节即权威文本，勿在别处复制）
-- 口径：直接删除集 = record 白名单 ∩ 宿主库 ∩ 索引预检通过集；
--       删除集总数 = 直接集 + 派生集（parent_id ∈ 直接集 且 task_type='subagent_child'）。
-- 复跑方式（5 步）：第 0 步生成白名单临时库 /tmp/w5.db（CSV 装载，R9-1 修复——
--   `.mode json` + `.import` 实测跑不通，JSONL 整行落一列致 startedAt 恒 NULL、Δ/碰撞假阴）；
--   ① 宿主库会话内执行（直接集）；② 索引库会话内 ATTACH 白名单库后执行（索引预检，
--   R9-2 修复——白名单库必须 ATTACH 在**执行会话**上，原注释形态报 no such table: wl.wl）；
--   ③ 宿主库会话内执行（派生集）；④⑤ 宿主库会话内执行（Δ 分布 / 碰撞面）。
-- 工具侧同一口径的机器实现 = scripts/zcode-session-db-cleanup.mjs 的
--   referenceDeletionSetImpl（I1 断言用），两处任一改动须同步另一处。
-- ============================================================

-- 第 0 步：从 record JSONL 导出 (sessionId, startedAt) CSV → /tmp/w5_whitelist.csv
--   （只解析 type='custom' && customType='subagent-record' 的结构化 entry；
--    startedAt 缺失的行照常装载为 NULL——④ 的 over_10s/碰撞面统计在 NULL 上为 0，
--    工具侧 I2 对 NULL 硬中止，口径差异属预期）
--   node -e '
--     const fs=require("fs"),os=require("os"),path=require("path");
--     const dir=path.join(os.homedir(),".xyz-agent/pi/sessions");
--     const out=[];
--     for(const f of fs.readdirSync(dir).filter(x=>x.endsWith(".jsonl"))){
--       for(const line of fs.readFileSync(path.join(dir,f),"utf8").split("\n")){
--         if(!line.trim())continue;
--         let e; try{e=JSON.parse(line)}catch{continue}
--         if(e.type!=="custom"||e.customType!=="subagent-record")continue;
--         const d=e.data||{};
--         const sid=d.engineHandle&&d.engineHandle.sessionRef&&d.engineHandle.sessionRef.sessionId;
--         if(sid) out.push(sid+","+(typeof d.startedAt==="number"?d.startedAt:""));
--       }
--     }
--     fs.writeFileSync("/tmp/w5_whitelist.csv",out.join("\n")+"\n");
--     console.log("rows",out.length);}'
--   rm -f /tmp/w5.db
--   sqlite3 /tmp/w5.db "CREATE TABLE wl(sessionId TEXT PRIMARY KEY, startedAt INTEGER);"
--   sqlite3 /tmp/w5.db ".mode csv" ".import /tmp/w5_whitelist.csv wl"
--   sqlite3 /tmp/w5.db "SELECT COUNT(*), SUM(startedAt IS NULL) FROM wl;"   -- 装载自检：NULL 计数应为 0

-- ① 直接删除集（宿主库 ~/.zcode/cli/db/db.sqlite 会话；:WHITELIST_DB = /tmp/w5.db）
ATTACH DATABASE ':WHITELIST_DB' AS wl;
SELECT s.id, s.task_type, s.title_source, s.time_created
FROM session s JOIN wl.wl w ON w.sessionId = s.id;

-- ② 索引预检（在**索引库** ~/.zcode/v2/tasks-index.sqlite 的会话内执行；零 FK，必须显式预检）
--    命中即「两侧同时剔除」（宿主行也不删）。R9-2：wl 必须在本会话 ATTACH：
-- sqlite3 "file:$HOME/.zcode/v2/tasks-index.sqlite?mode=ro" <<'SQL'
--   ATTACH DATABASE '/tmp/w5.db' AS wl;
--   SELECT DISTINCT task_id AS id FROM task_group_members WHERE task_id IN (SELECT sessionId FROM wl.wl)
--   UNION SELECT target_task_id AS id FROM automations WHERE target_task_id IN (SELECT sessionId FROM wl.wl)
--   UNION SELECT session_id AS id FROM off_peak_tasks WHERE session_id IN (SELECT sessionId FROM wl.wl)
--   UNION SELECT task_id AS id FROM tasks WHERE off_peak_task_id IS NOT NULL AND task_id IN (SELECT sessionId FROM wl.wl);
-- SQL
--    （备选：白名单 id 内联 IN 列表——但失去与 wl 临时库的单一装载来源，非首选）

-- ③ 派生删除集（宿主库会话，wl 已按 ① ATTACH）
SELECT id FROM session
WHERE parent_id IN (SELECT s.id FROM session s JOIN wl.wl w ON w.sessionId = s.id)
  AND task_type='subagent_child';

-- ④ D7 I2 容差取值依据（可执行）：Δ = |record.startedAt - session.time_created|
--    我们行的 Δ 分布（r7 复测 max ≈ 4022ms → 容差取 10s，约 2.5× 余量）
--    权威常量 = scripts/zcode-session-db-cleanup.mjs 的 I2_TOLERANCE_MS（单源），
--    改容差须同步此处字面量（10000）与 ⑤。
SELECT COUNT(*) AS rows_,
       MIN(ABS(w.startedAt - s.time_created)) AS delta_min_ms,
       MAX(ABS(w.startedAt - s.time_created)) AS delta_max_ms,
       SUM(CASE WHEN ABS(w.startedAt - s.time_created) > 10000 THEN 1 ELSE 0 END) AS over_10s
FROM session s JOIN wl.wl w ON w.sessionId = s.id;

-- ⑤ 碰撞面：用户 interactive 会话落入我们任一 record ±10s 窗的计数
--    （10000 = I2 权威常量同款同步要求，见 ④ 注释）
SELECT COUNT(*) AS collisions_10s FROM session u
WHERE u.task_type='interactive'
  AND EXISTS (SELECT 1 FROM wl.wl w WHERE ABS(w.startedAt - u.time_created) <= 10000)
  AND u.id NOT IN (SELECT sessionId FROM wl.wl);
```

**边界**：只删白名单命中行（SET NULL 越行修改单独报告）；不删 journal（生命周期跟随 record）；不动真实用户会话。

**验收**：A11（含 I1 双计数 / I2 dry-run 复核 / I3 硬中止 + 反向 fixture）。

### 3.3 实施不变量

1. **HOME 语义不变**：spawn env 的 `HOME` 与改造前逐字相同（探针断言）。
2. **路径单一来源**：`ZCODE_SESSION_DB_PATH` 的值、`handle.sessionRef.dbPath`、两站点白名单集合
   全部由 `zcodeSessionDbPath()` / `zcodeDbPathAllowlist()` **两个构造函数**产出（集合第二项含存量兼容锚点，
   不宣称全部由前者推导），禁止两处各算（含读取侧比较基准）。
3. **白名单封闭**：①级读取只放行 `zcodeDbPathAllowlist(dataDir)` 集合内的精确绝对路径。
4. **存量零迁移**：改造不修改、不删除任何既有 record 与宿主库行（清理是独立通道 D7，需用户授权）。
5. **失败不静默**：隔离库不可用时任务显式失败（不回落写宿主库——回落会让污染静默复活）。
6. **隔离库不在 journal 分组目录内**：`zcodeSessionDbPath()` 的结果不在 `resolvePoolDir(dataDir,'zcode','shared')` 之下；
   TTL 扫描（`cleanupExpiredJournals`，[池抽象降级] 更名）会**枚举** `session-db/`，但 `db.sqlite*` 不匹配任何删除条件
   （journal 名条目除外——实践不可达）——由 A9 经公共 API + 枚举断言。

---

## §4 验收（真实场景）

> 全部场景在**真实 zcode.cjs + 真实凭据 + 真实 ZCode GUI**上验证；fake-server 只作单元回归。
> 每场景标注回溯目标与适用期（迁移期 / 终态）。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| A1 | 隔离库落库（端到端） | `pnpm dev` 起 xyz-agent，在某个 worktree 派发一个 zcode subagent 任务 | 隔离库出现该 sessionId 行 + message + `model_usage`；宿主库同 sessionId **0 行**；任务结果与改造前等价 | G1/G2 |
| A2 | 侧边栏零污染 | 承接 A1，用 ZCode GUI 打开该 worktree 目录 → 重启 GUI → 查看侧边栏 | 侧边栏**无**该 subagent 会话；用户自己的历史会话完好；重复跑 3 个任务后仍为 0 | G1 |
| A3 | 历史详情①级读取（生产链） | GUI 详情页打开 A1 的 subagent 记录（运行中 + 结束后各一次） | 详情页正常渲染（①级命中隔离库，**走 `session-view-service` 白名单**）；`source` 非 `outcome-only`；重开 session 后一致 | G2 |
| A4 | 存量兼容（三类 record） | 打开改造前产生的三类 record（池时代相对路径 / 共享 HOME 时代宿主绝对路径 / 新隔离路径） | 三类详情页均正常；前两类①级仍命中宿主库（未被误拒） | G4 |
| A5 | 共享面零回归 | 任务里验证：模型凭据可用（非 `engine_credential_missing`）、项目插件 / MCP 继承、`pnpm` 安装不触发 store 翻转 | 全部与改造前一致；`~/.zcode/cli/config.json` 未被本改造改写 | G2/G3 |
| A6 | 并发与崩溃 | 并发 3 个任务；运行中 `kill -9` app-server | 3 个会话各归各（隔离库行数 = 3）；在途任务失败、下一任务自动重建 | G2 |
| A7 | 无宿主残留 | A1–A6 后统计宿主库新增行 | 宿主库新增 subagent 行 = 0（判定方法：以 A1–A6 的 record sessionId 为白名单查宿主库）；`tasks-index` 无新增任务 | G1/G5 |
| A8 | 失败路径 | ①隔离库父目录 `chmod 000`；②运行期 unlink `db.sqlite*`（主文件 + `-wal`/`-shm`，按 E3 事实核验） | ①任务显式失败且错误含路径与恢复指引，**宿主库零新增**；②在途会话数据落已 unlink inode、重启后自动重建新库、旧 record 降②级 journal 仍可读 | D6 |
| A9 | 池 GC 守卫（反向不变量，**经公共 API + 枚举断言**）[池抽象降级 2026-09-13 修订：`acquirePool`/`releasePoolRef`/refs 机制已删，现行形态 = core `pool-manager.test.ts` 的 `cleanupExpiredJournals` 超龄 db.sqlite 不删断言 + 引擎包 `zcode-session-db-pool-gc.test.ts` 结构守卫（隔离库与任意分组目录双向前缀分离 / db 文件名族与 journal 名族不相交）] | 原规格（历史）：`dataDir=mkdtempSync()` 下写入隔离库三件套后经 `acquirePool`+`releasePoolRef`+`cleanupExpiredPoolRefs` 断言不删；现行等价断言经 `cleanupExpiredJournals(dataDir, 0)` 触达 | ①隔离库三件套**字节不变**；②目录级分离结构断言；③journal 分组目录内可清理条目清空后目录回收、`db.sqlite*` 目录保留 | 不变量 6 |
| A10 | 存量零迁移（反向不变量） | 改造前后对比宿主库行数 / 既有 record 文件 | 宿主库行数与 record 内容**逐字节不变**（除新会话）；无任何自动删除 | 不变量 4 |
| A11 | 存量行清理通道（W5） | 用 D7 规格对自身 record 白名单做 dry-run → **先在 ZCode GUI 打开含我们会话的 worktree**（让索引侧有可观测行）→ 停机窗口执行 | **四数报告 + 删除集 == 参照 SQL 结果**（白名单总数 / 白名单∩宿主库 / 派生删除集 / 删除集总数）；**I2 时间戳交叉验证全部通过**（无一条中止）；**I3/I3b 无命中**；**反向 fixture 两条**（混入用户 `fork` id → 中止；混入普通用户 interactive+generated 且时间戳差数小时 id → 必须中止）；**无确认参数且非 TTY → 拒绝**；`--confirm-count` 错值 → 拒绝；**确认凭证落盘且与删除集总数匹配**；**索引面归零** + 预检命中项两侧同时剔除并报告 + 索引删除失败时残留清单落盘、补删后归空；执行后宿主库 11 表 + `input_history` + 派生行零残留；SET NULL 修改行数与 FK 失败中止记录（若发生）已报告。**实现级步骤与 fixture 由代码承载（原 impl-plan §2.5/§7.2 已删除，git 可追溯；入口 = `scripts/zcode-session-db-cleanup.mjs` 及其测试）** | G5 |
| A12 | 伴生写入面登记准确性（反向不变量） | A1–A6 后 diff `~/.zcode/` 增量（排除已知 GUI 面 `v2/tasks-index.sqlite`、`v2/telemetry-state.json` 与第二宿主 `zsw/`） | 增量面与 §2.4.1 表列出的面一致（无未登记的新写入面）；若出现未登记面 → 回写登记表并重审判定 | 已接受代价登记 |

**探针挂钩**（随代码落地）：
① 单元：spawn env 含 `ZCODE_SESSION_DB_PATH` 且等于 `zcodeSessionDbPath(engineDataDir)`，且不含 `ZCODE_SESSION_DB`；
② 单元：`onHandleReady` 与终态 handle 的 `dbPath` 相等；两站点白名单集合成员判定一致；
③ 单元：journal TTL 清理守卫（A9，[池抽象降级] 后经 `cleanupExpiredJournals` 公共 API + 引擎包结构断言）；
④ 集成（fake-server）：create 帧后断言 fake 侧收到的 env 含隔离路径；
⑤ 真机：A1/A2/A3 各跑一次（本设计成文时已用探针 `probe2.mjs` 预验证 F1/F2；E3 的「运行期删除」行为
   需在实施期补一条真机探针，观测「unlink 后写入 + 重启后新库」实际形态）。
   **降级路径**：若探针与 E3 描述不符，**仅回改 E3/A8② 措辞**，D4（禁止运行期删除）与方案不变——本设计不依赖该行为的精确形态。

---

## §5 下一层拆分

| 单元 | 职责（设计级） | 依赖 | 验收挂钩 | 领地与实现细节 |
|------|----------------|------|---------|------------------|
| W1 路径与 env | `zcodeSessionDbPath()` / `zcodeDbPathAllowlist()` 两个构造函数 + env 注入（含清空别名键）+ 父目录确保 | —（DAG 根） | A1；探针①；实现级规格由代码承载（原 impl-plan §2.1，已删除） | 实现级细节由代码承载（入口 = `db-path.ts`） |
| W2 读取链与 handle | 两站点改集合成员判定 + handle 回填隔离路径 + `hostZcodeDbPath()` 降级为兼容锚点 + 注释回写 | W1 | A3/A4；探针②；实现级规格由代码承载（原 impl-plan §2.2，已删除） | 实现级细节由代码承载（入口 = `zcode-engine.ts` / `db-path.ts`） |
| W3 测试 | 单元 + 集成（fake-server）+ 真机 live 用例；含池 GC 守卫（经公共 API） | W1/W2 | A1–A4/A6/A9；实现级规格由代码承载（原 impl-plan §2.3，已删除） | 实现级细节由代码承载（入口 = 引擎包测试目录） |
| W4 文档与约束同步 | 约束表 / AGENTS / 池边界注释 / 漂移检查 / 权威源文档 / 第六面 / 伴生面债务落点 | W1/W2 | 实现级规格由代码承载（原 impl-plan §2.4，已删除；文档同步纪律 C-proc-10） | 实现级细节由代码承载（入口 = 本文档 + `docs/constraints.json`） |
| W5a 清理工具实现 | 按 D7 规格实现（I1/I2/I3/I3b + 执行形态 + 索引预检 + 跨库顺序 + 残留清单） | W1 | A11；实现级规格由代码承载（原 impl-plan §2.5，已删除） | 实现级细节由代码承载（入口 = `scripts/zcode-session-db-cleanup.mjs`） |
| W5b zsw 侧交接物 | 导出 `zcodeSessionDbPath` + 清理规格由 `scripts/zcode-session-db-cleanup.mjs` 承载（原仓内规格文件已随 docs purge 删除，git 可追溯） | W1 | §2.4.3；实现级规格由代码承载（原 impl-plan §2.6，已删除） | 实现级细节由代码承载（入口 = `scripts/zcode-session-db-cleanup.mjs`） |
| W6 隔离库 TTL（后续项） | 按 D4 重审触发条件启动（体积/行龄阈值 → 清理策略） | D4 触发后 | D4 触发后另立（原 impl-plan §2.7 已删除） | 实现级细节由代码承载（入口 = 触发后另立单元） |

**版本与排序**：W1+W2 必须同批（env 与 handle 分叉会立刻产生读取降级）；W3 随 W1/W2 同批交付；
W4 在合入前完成；W5/W6 独立排期（不阻塞 G1）。

**风险与回退**：最大的未知是 **A2（真实 GUI 侧边栏零污染）**——若隔离库仍被 GUI 索引到
（说明 GUI 有第二条发现通道），回退 = **撤 W1 env 注入 + 同步回退 W2 handle 回填（两站点）**，
白名单改动向后兼容（撤注后隔离路径不再产生，存量分支不受影响），
并按方案 B 补 `titleGenerationEnabled:false` 减害。只撤 env 不撤 handle 会让新 record 指向空隔离库、①级读取静默降②级。
次高未知是 **A5/A6** 暴露「共享库假设」被别处依赖（例如某插件按宿主库路径读历史），处置同上。

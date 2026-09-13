# GUI 数据多源治理：原则与裁决索引

> **一句话结论**：GUI 数据多源的病根不是缓存，而是「权威源之外的第二个写入者」与「派生在多个进程独立发生」。终态架构由五条原则构成（§3）。
>
> **状态（2026-09-13 压缩）**：本设计已全部实施完成（P0–P4 收口，登记表 W 编号全部落地）。诊断、方案对比、分阶段迁移计划、验收场景等一次性内容已删除，git 可追溯。现行权威：
> - **登记表 SSOT**：[data-source-registry.md](data-source-registry.md)（owner / 权威源 / 唯一写入口 / 空值语义 / 例外的唯一对照源 + 跨进程锁协议表）
> - **架构决策固化**：[ADR-0062](../adr/0062-single-data-owner-absolute-write-rule.md)（单一数据 owner + 绝对写规则）· [ADR-0063](../adr/0063-session-attachment-invariants.md)（session 附着不变量）
> - 实施计划 wave 编号出处 data-source-governance-plan.md 已删除，git 可追溯。

---

## 1. 关键术语（全文与代码注释通用）

- **权威源（source of truth）**：某数据唯一正确的最终存储。本体系中 = pi 进程（session 文件 + agent 内存态）。subagent/workflow 是例外——pi 无此概念，权威源是 xyz 扩展经 `appendEntry` 写入 pi 文件的自描述 custom entry（存储由 pi 执行，语义归 xyz 扩展）。
- **绝对写规则**：xyz 的任何代码（runtime / renderer / 脚本）永不写 pi **当前持有**的 session JSONL——对 pi 持有文件的修改只发生在 pi 内部（内置 RPC 或扩展 API）。精确边界含两类**登记在案的合法形态**（非例外，裁定 D3/D3b）：① **sidecar 家族**——pi 体系外的 xyz 自有文件（`.meta.json` / `.preset.json` / `.project.json` / `.handoff.json` / `.agent.json` / `.model.json`，全集见登记表 §4 ⑤）；② **文件创建型**——创建 pi 将来才持有的新 session 文件（目标写前不存在、无并发写方、写后即移交 pi，fork/导入/restore 归一化等实例见登记表 §4）。这条规则的力量在于绝对性——一旦有例外，例外就会衰变（label 双写方是前车之鉴）。
- **pi 内操作原则**：pi 没有而 xyz 需要的能力，默认解法是开发 pi 扩展在 pi 进程内实现（经 `appendEntry` 持久化、经 `entry_appended`/`get_entries` 上报），runtime 只经 RPC 存取。禁止 runtime 绕过 pi 直接读改 pi 的内部数据。
- **owner（数据所有者）**：xyz 侧某类数据唯一的写入者——一个模块、一个状态容器、一个写入口。所有来源（事件/RPC/文件）都汇入 owner 的单一入口，读方只读 owner。
- **投影宿主**：runtime 是唯一的投影发生地——所有派生在 runtime（或 core 包的唯一实现）发生一次；**renderer 零派生**，stores 只是视图模型容器，经单一 `applySnapshot` 入口接收 view-ready 数据。
- **纯派生缓存**：只有一个写方（扫描/转换/计算本身）、可随时丢弃并从权威源完整重建的缓存。
- **影子状态库**：有独立写路径（被多条事件/RPC 回写直写）、承载真值的缓存。它是多源问题的载体（典型已删实例：runtime `sessionMetaCache`）。
- **快照拉取 + 事件失效**：标量状态的复制模式——数据只由 owner 从权威源拉取快照填充；事件到达只做一件事：标 dirty 并触发（防抖后的）重拉。事件永远不直接写数据。载体 = `ReplicatedState<T>` 原语（`packages/runtime/src/services/session/replicated-state.ts`）。
- **单一 reducer 双路喂入**：append-only 日志数据（消息流）的复制模式——renderer 的消息列表是 entry 日志的纯函数，一个 `applyEntry` reducer 同时被实时事件流与文件重放喂入。「live ≡ reload」从构造上成立。载体 = `packages/core/src/domain/chat/apply-entry.ts`。
- **按字段分权威**：当权威源对某数据只覆盖部分字段（如消息队列：深度有 `get_state.pendingMessageCount` 快照、内容无任何 pi 通道），按字段拆分权威并显式登记，而不是虚构一个单一权威。

---

## 2. 终态架构原则（五条，全方案的判断准绳）

1. **绝对写规则**：xyz 代码永不写 pi **当前持有**的文件。pi 持有状态的所有修改发生在 pi 内部——内置 RPC（`set_session_name` 等）或扩展 API（`appendEntry` 等）。合法形态（sidecar 家族、文件创建型）是规则边界的一部分；例外是带期限的债务，必须登记并带移除期限。无白名单。
2. **pi 内操作原则**：pi 能力缺口由 pi 扩展在 pi 进程内补齐（持久化经 `appendEntry`，上报经 `entry_appended` + `get_entries`），runtime 只经 RPC 存取。runtime 对 pi 数据只有两种动作：调 RPC 命令、订阅事件。
3. **投影只发生一次**：runtime 是唯一投影宿主。所有派生逻辑（merge / normalize / 计数对账 / 状态推导）在 runtime（或 core 包唯一实现）发生一次；renderer 零派生，stores 是视图模型容器，唯一写入口是 `applySnapshot`。多 pane / 多窗口是 runtime 副本的下游扇出，绝不出现两个消费者各自从 pi 独立推导。
4. **两种复制模式按数据形态分流**：标量 session 状态走通用快照复制原语 `ReplicatedState<T>`（快照拉取 + 事件只做失效）；append-only 日志（消息流）走单一 `applyEntry` reducer 双路喂入。不发明第三种模式；权威源能力缺失处（队列内容）降级该通道为对账信号 + 按字段重划权威，而非绕过权威源另起炉灶。
5. **治理即代码**：数据登记表的终态是可执行配置——驱动 `ReplicatedState` 实例、lint/pre-commit 许可表、契约测试参数。护栏是双层：机器检查（模式级：R1 直写检查 / R2 写入口 / R3 `@data-owner` 注解）+ pr-cr-fix review-data-governance agent（语义级，长期存在，因为跨文件语义「第二写方」机器只能拦直呼形态）。

---

## 3. D1b 快照合并规则（两条规则不可混用 + wire 层归一细则）

> 本节被 `replicated-state.ts` 头注释直接引用，是实现级契约，原文保留。

- **owner 快照合并 = 权威源整字段覆盖，含显式空值**。真实依据：pi `get_state.sessionName` 的合法值为 `string | undefined`——未命名 session 就是 undefined（空名是显式语义而非占位）——若一刀切「空值不覆盖非空值」，未命名 session 的初始快照为 undefined，owner 将永远保留旧名，影子状态复活。注意「用户清空名字」无法经 RPC 到达 pi（`set_session_name` 显式拒绝空名），sessionName 为 undefined 的真实来源是未命名初始态与文件级空 session_info。
- **wire 层空值归一**：`get_state` 经 JSON 序列化时值为 undefined 的字段 key 被丢弃——「整字段覆盖含显式空值」在 wire 层实际是「key 缺失」。快照解析必须按字段 schema 归一：缺失 key 按该字段登记的空值语义处理（sessionName 缺失 = 未命名 = 覆盖；thinkingLevel 无空值语义，key 缺失按协议异常处理），禁止把「key 缺失」当「字段不动」。
- **空值守卫仅用于磁盘扫描占位值路径**：`scannedToSummary` 硬编码的 `modelId:''`/`tokenCount:0` 是「无数据」占位符而非权威空值，守卫语义是「占位符不覆盖已知真值」。
- 落实到登记表：按字段登记空值语义（[registry §2](data-source-registry.md) 三条区分）。字段空值语义是 `ReplicatedState` 配置的一部分。

---

## 4. 决策索引（D1–D8 一行式，全文 git 可追溯）

| 决策 | 一句话 | 现行落点 |
|---|---|---|
| D1 缓存处置判据 | 缓存里存在权威源之外的第二个写入者 → 收编或删除（影子状态库）；没有 → 保留（纯派生缓存） | registry §1 各条目处置列 |
| D1b 快照合并规则 | 见 §3（实现级契约，原文保留） | `replicated-state.ts` + registry §2 |
| D2 label 写路径 | 活跃 rename 切 pi `set_session_name` RPC；非活跃切 `withEphemeralPi` 短命附着（逐次冷起 ~500ms 已探明定型） | `session-lifecycle.ts` renameSession 两分支 |
| D3 / D3b 写边界裁定 | session_end 维持 sidecar 单写方（合法形态非例外）；handoff_marker 迁 sidecar；patchSessionCwd 归一化；fork 创建型登记 | registry §3 / §4 |
| D4 扩展数据单一来源 | 扩展 `appendEntry` 自描述 entry 为唯一持久化权威（写方是 pi），runtime 经 `entry_appended` 失效 + `get_entries(since)` 增量拉取 | registry #8/#9（W17/W18 已落地） |
| D5 消息流单一 reducer | `applyEntry` 双路喂入；message entry 不发射 `entry_appended`（已实测），实时 feed 由 `message_end` 等事件重构 entry | `apply-entry.ts` + 等价性测试族 |
| D6 队列按字段分权威 | 深度权威 = pi（pendingMessageCount 推送投影）；内容权威 = renderer 提交日志；xyz 自研扩展禁止 `sendUserMessage({deliverAs})` 注入 | registry #6 / #15 |
| D7 投影一次 | renderer 零派生；`ReplicatedState` 配置三元组 =（快照 RPC, 失效触发源, 合并策略）；既有 subscribe/ring/stateSnapshot 通道复用为推送通道，state 类话题数据源切 owner 快照发布 | registry §1 各条目「唯一写入口」列 |
| D8 预防双层护栏 | 语义层 review-data-governance agent + 机器层 R1/R2/R3 + 等价性测试族 + 登记表即代码 + ADR | `.githooks/check_pi_direct_write.py` · taste-lint · `packages/runtime/src/__tests__/equivalence/` |

# 架构决策记录（现行有效）

> 本文档是 taiji 的架构决策 SSOT，浓缩自历史 ADR 体系（2026-09-15 整合，原始文件已删除、git 历史可考）。
> 只收录**现行有效**与**部分有效（核心成立、细节已漂移，按现状表述）**的决策；已过时/被推翻的决策在文末「已否谱系」留一行注记。
> 编号沿用原 ADR 编号——源码注释中的 `[ADR-XXXX]` 回链在本文件内解析（如 `[ADR-0049]` → 下文 §状态管理 ADR-0049 条目）。
> 约束登记号（C-xx-xx）指向 [docs/constraints.json](../constraints.json)；每条决策的「登记」列给出对应约束 id。

## 进程与外部依赖

### ADR-0005 / ADR-0006 pi 供给与打包形态（部分有效）
pi 以独立可执行文件随应用打包（`Resources/pi/pi-<plat>-<arch>`，dev 由 `scripts/prepare-pi-resources.sh` 预置同源产物）。打包态严格 bundled-only：二进制缺失即 throw fatal（`packages/runtime/src/infra/pi/find-pi-executable.ts`），不回退系统 pi——版本一致性、升级随应用走。dev 态允许 PATH/nvm 兜底（仅开发便利）。登记 C-pi-04。

### ADR-0009 数据目录与 pi 完全隔离
应用数据目录 `~/.taiji/` 与 pi 原生目录 `~/.pi/agent/` 完全隔离，扩展/技能/配置互不污染；路径一律从 `packages/shared/src/paths.ts` 的 `getConfigDir()`/`getPiAgentDir()` 动态推导，禁止硬编码（pre-commit 检查）。登记 C-pi-06。

### ADR-0037 pi 协议是真契约，无防御性双读
`packages/runtime/src/infra/pi/pi-protocol.ts` 是 pi 事件协议的类型镜像（PiEvent 联合覆盖全部 AgentSessionEvent），translate 入参用窄类型获得 exhaustive check；禁止 args/input 双读 fallback——pi rpc 序列化无字段改名，双读是死代码。pi 升级时由 pi-semantics 探针族（`scripts/check-pi-semantics.mjs` + `docs/pi-semantics.json`）红灯提示补齐。登记 C-pi-05。

### ADR-0064 pi 语义吸收层四支柱
taiji 与 pi 之间的私有语义适配收敛为四支柱：① 能力注册表——模型/思考档位能力只在 `packages/runtime/src/services/model-capability.ts` 一点进入（离线 pi-ai 同源计算 + 在线 get_available_models 对账），renderer/扩展禁止本地推断；② 生效回执——改状态 RPC reply 必回 pi 实际生效值，禁乐观写；③ 确认式送达——结果语义通知走 session-delivery 持久账本 + 幂等键（at-least-once），禁依赖 pi 内存队列；④ 漂移检查——pi 语义依赖机器登记 + 探针测试 + 版本门禁。另有轮询精简准则：对方会 push 的信息禁周期 pull 兜底。权威源 [docs/architecture/pi-boundary-reliability.md](../architecture/pi-boundary-reliability.md)，登记 C-pi-12/13、C-ext-19、C-proc-08。

### ADR-0074 投递所有权内核：单一所有者 + 两阶段回执
**背景**：pi 的契约假定「消息进入 transcript 之前所有权属于前端」（steer/followUp 队列只是交接槽位，前端须自己盯它是否被取走、必要时用 `clear_queue` 收回），而 taiji 的消息所有权长期碎在四处——renderer 乐观气泡、renderer defer 队列、renderer pendingBuffer 计数、runtime 投递内核（仅服务 agent 间消息）——四处都不完整：steer 投递路径 fire-and-forget（入槽后无人跟踪），且投递路径判定源有三套（renderer 发送路由表 / runtime occupancy / extension 自身视角）互不同步，压缩、中止、进程回收三类窗口轮流暴露同一结构性缺口（消息丢失/滞留/乱序）。

**决策**：全部发送方（composer 用户消息 / session_manager send / completion-backflow / plugin / landing 首发）经 runtime **投递所有权内核**提交——纯逻辑状态机在 `packages/session-delivery`，pi 适配与对账在 `packages/runtime/src/services/session/session-delivery-registry.ts`：
1. **lane 判定单一源**：direct（pi 空闲直投）/ steer（并入当前 run 的 turn 边界）/ queued（内核 FIFO 持有）由内核按 runtime 权威 occupancy 推算（C-data-19 单写原语）+ 内核队列态判定；renderer 侧发送路由表降级为发送位按钮形态的 UI 预测，extension 不做投递路径判定。
2. **两阶段回执**：受理（prompt 受理 / 文本进入 pi 槽位）与送达（`message_end(user)` 命中消息标记 = 已进 transcript）显式分离，只有拿到送达回执的条目转终态，停留受理的由对账器接管。`sendChecked` 的同步 settle 时点维持**受理口径**（agent 间 send 的 `{queued:true}` 契约锚定受理时点，不因送达而阻塞工具调用），记账回调 `onSettled` 为送达口径。
3. **对账器**：五触发点（agent_settled / compaction_end / abort 完成 / pi restored / 30s watchdog）在「空闲 + pi 槽位非空」时 `clear_queue` 全收，按消息标记三分处置——reclaim（内核在途条目回队首重投）/ rebuild（带标记但内核无记录，先按标记对 transcript 全量扫描判已送达再决定重建或仅记账）/ adopt（无标记外来文本收养入队；rebuild 身份判据的尾附锚细化见 ADR-0077）。撤销（`delivery.cancel`）与投递中收回复用同一路径（pi 只有队列级原语，不新造条目级原语）。
4. **消息身份**：出站文本尾附裸标记 `<!--taiji:msg:<uuid>-->`（与 host-internals msg-id-mapper 模块的 `u-` 前缀标记空间互斥、正交共存），随文本进 transcript 成为逐消息精确身份；判重按 id 匹配（禁计数 FIFO / 文本匹配）；终态 tombstone 在 runtime 存活期内全量保留供 `delivery.resync` 去重，不跨 runtime 重启——reattach 场景判重锚回落 transcript 全量标记扫描。
5. **UI 单一数据源**：队列区状态广播 = `session.delivery`（内核条目**派生视图**：活跃态全量 + delivered 最近 50 条完整条目 + lane；cancelled 不进派生视图），`queue_update` 一条消息降级为内核内部回执；pi 的 steer/followUp/clear_queue/get_state/get_entries/nextTurn 契约原语全部保留复用，零绕过、零重造。
6. **回执锚申报制（`DeliverySubmitOptions.receiptAnchor`，消息链路去冗余 D1）**：条目级提交选项 `'marker' | 'acceptance'`（缺省 `'marker'` = 保守语义）——`'marker'` 条目出站文本尾附裸标记、等 `message_end` 回执命中转 delivered；`'acceptance'` 条目（无回执锚点的 agent 通路文本）port.send 受理即落 delivered——「受理 = 送达」是无锚条目唯一可判事实（前提 = pi 无逐条回执原语）。申报制替代旧适配层文本反查（反查在合批/混合批次下构造性失效——G2 投递死锁根因：无标记合批第 5 环确认落空 → in-flight 永挂 → gate 恒关）；内核保持零正则、零 pi 知识，无标记判定归有身份知识的提交方。receiptAnchor 是 KernelEntry 内部字段，不进条目视图 DTO、不进 session.delivery 帧（派生视图范围零扩散）。**来源清单（SSOT；新增无标记投递来源必须显式申报 `'acceptance'` 并回登本清单——漏申报 = 条目永挂 in-flight、该 session 投递 gate 恒关，诊断链见 [data-source-registry #15](../architecture/data-source-registry.md)）**：`'marker'` 恒申报 = runtime registry `submit`/`submitToKernel`（`withDeliveryMarker` 在自己手里）；`'acceptance'` 申报点 = `completion-backflow.ts`（agent 完成回流）/ `session-manager-handler.ts`（agent-managed send）/ subagent-core `notifier.ts` handle.send fallback（通知出站文本无标记）/ subagent-core pi-host（custom payload，经 notify-ports.ts 影子契约同步）。护栏 = 提交方行为锁单测（subagent-workflow notifier-receipt-anchor 装配测试 + runtime S1 复现单测，重构丢申报时亮红；无通用正则护栏——与内核零正则冲突，有意不做）。演进路径 = D7-33 per-id 回执契约改造后，`'acceptance'` 保守口径被逐条回执替代。

**后果**：消息「按序必达」由结构保证——任一窗口的判定误判从致命降级为一次对账回收，新发送方接入即继承（无需各自发明时序防御）。已接受代价：出站消息文本携带 ~40 字符裸标记进 LLM 上下文与 session 文件（展示层剥离 SSOT = `apply-entry-convert.ts`，live/reload 同点）；删除 session = 显式废弃未送达条目（与既有语义等价）；无标记条目（命令/技能）无回执凭据，崩溃重放按 transcript 全文包含判定、不可判定时保守重投。**耐久侧现行规则（统一投递 v3）**：交互类文本经 runtime 磁盘 outbox 落盘（`<dataDir>/delivery-outbox/<sessionId>.jsonl`，受理前 persist、终局 delivered/cancelled 后 ack，JSONL 终局行单调累积为判重依据、不实现清理通道）——应用整体退出/崩溃后 runtime 启动经 `loadUndelivered` + reattach transcript 裸标记判重把未送达消息自动重新入队（已送达的不重投）；通知投递路径持久账随 session entries（port 半区）；判重终态事实源 = 持久终局记录（`loadTerminalIds` 启动播种跨重启），reattach 走一次 O(transcript) 标记扫描兜底。权威域注记见 [pi-boundary-reliability.md 附录 E](../architecture/pi-boundary-reliability.md)。登记 C-data-08、C-data-25。

### ADR-0063 session 附着不变量 I1-I5
五条硬不变量防「会话写错文件/丢数据」：I1 runtime 登记路径必须恒等于 pi 实际写目标（`session-attach-assert.ts` 附着后 get_state 对账，不一致即 throw）；I2 对话数据只许存在于 sessions 目录 + 内存（禁入 $TMPDIR）；I3 退出/切换前登记文件须含 pi 已写全部 entry（`__tests__/equivalence/attach-lifecycle.test.ts` 真实 pi 等价测试）；I4 pi 内部行为断言必须带 pi-mono 源码锚点且穷尽全部消费层；I5 会话文件身份是受治理数据。登记 C-data-10。

### ADR-0062 单一数据 owner + 绝对写规则
pi 当前持有的 session JSONL 唯一写方是 pi 进程——taiji 任何代码永不直写，能力缺口由 pi 扩展在 pi 进程内补齐。三类登记在案的合法边界形态：sidecar 家族四后缀（.meta/.preset/.project/.handoff.json，写前 existsSync 检查）、fork 文件创建型、restore-time 归一化 rename-over（inactive-only、白名单变换、每文件一次）。标量状态复制模式 = 快照拉取 + 事件只做失效（事件永不直写数据）。登记表 SSOT：[docs/architecture/data-source-registry.md](../architecture/data-source-registry.md) + `replicated-states.config.ts`（新数据 = 新配置条目）。登记 C-pi-07、C-data-01。

### ADR-0083 btw 旁路提问：派生临时会话形态
btw 旁路提问（主对话旁开 drawer 辅助对话流）的会话形态定案（2026-09-22 定案，2026-09-23 交付）：① 每条 btw 线 = 主会话当前进度的 **pi 原生 fork 全树快照**（`--fork` + `--session-dir`，含分支；不复用 session-fork.ts 单路径截断），跑在独立 pi 进程；源状态三分支（正常 / 无快照线（fork throw → 回落无 fork 新建 spawn，宿主零直写）/ 截断快照）；② 虚拟 ID 第三家族 `btw:<piSessionId>` 两段式（与 pi id 零冲突契约：真 sid 禁冒号、虚拟 id 永含冒号；派生键第二段 = owner piSessionId，INVAR-1.1 强制化 + 生产值域断言）；③ 持久化 = 目录即关联（session 存储树域 7 `<dataDir>/ext-sessions/<mainSid>/btw/`，[ADR-0151](#adr-0151-session-维度存储布局反转ext-sessions-树--分区键-rootsessionid--整树软删2026-10-17-用户裁决session-store-layout-inversion) 布局反转后；线文件名保持 pi 命名约定，注册表启动重建 hidden 复原）+ 重载链（applyEntry 全量回放；离线尾读含 btw 目录解析路径）+ 线树随主树回收（主删级联 = 整树软删自动覆盖，deleteSession / deleteByCwd 连带）+ 显式关线 closeLine 对称软删 `<root>/<线sid>/` 整树（线作为会话有自己的树：线派生的 subagent 记录等）；关闭/退出/闲置回收均不删；旧启动孤儿补账机制随布局反转退役（应用内删除总是整树回收，补账判据扫新根会误删存活线树——退役依据见 ADR-0151 决策 2）；④ G4 三防线（目录隔离 / `hidden: true` / 不记工作区历史）——关联只服务生命周期与自身线列表，不进任何展示链；⑤ 派生资源边界（zcode selection side chat 先例对照）：命令族硬禁 + 派发能力保留 + 派生视图收窄（无 opener）+ 派生键三触发分层（失效保留 / 终结清除 / btw 驱逐同驱）+ model-only 行为契约注入；⑥ 挂起交互请求终态机（应答 / 撤回 / 失效 + 回收提醒/未读清除支），失效提示三路收敛——事件 invalidated 与快照对账差集两路写入收敛单入口 + 回放悬空对账独立路（信号源 = pi 会话文件持久层，不依赖内存簿记跨进程存活）；交互呈现现行形态 = **D8 降级启用**（V4 核实三通道抽离的 plan 通道不成立）：五类请求统一 drawer 内联确认条 + 富表单降档，三通道 per-vid 路由为未启用备手（产品意图仍为与主 agent 同形态保真，plan-store 分区化后可复评启用）。权威源为 btw-question 设计文档（设计档案已随 .tmp 清理，不入 git；实施记录 git 可追溯）。登记：数据范围见 data-source-registry ⑧ btw 补登链；未新增约束族（机制边界由既有 C-ext-19 / C-pi-12/13 / C-data-01 等覆盖）。

### ADR-0123 codemode 常驻默认开 + 设置页可关（2026-10-03 用户裁决，codemode 设计 T1 确认点）
**决策**：codemode（pi 1.0 内置的脚本化工具调用能力）产品形态 = **常驻默认打开 + 设置页开关可关（默认显示开）**——用户零配置开箱即得。落地三支柱：① **启动迁移幂等写入**：settings.json `defaultTools` 字段缺失 → 写 `["+codemode"]`；字段存在（含坏值）→ 不碰，尊重手改——「字段缺失 = 未配置 = 默认开；字段存在 = 有人配置过 = 尊重」，与 pi `mergeDefaultTools` 缺失回落语义同构；② **开关写增量条目**：打开 = 先移除 `"-codemode"` 再按 pi 解析语义幂等补 `"+codemode"`；关闭 = 移除 `"+codemode"` 与纯名 `"codemode"` 后，数组为空时写 `["-codemode"]` 占位（防启动迁移写回、防落空数组），非空则保留其余条目原样——激活态单一事实源恒为 settings.json，禁止运行时 `setActiveTools()` 影子点亮；③ **spawn 恒带装载旗标**：pi spawn 参数恒带 `--extension builtin:codemode`（pi 1.0 起 `--no-extensions` 把内置扩展一并排除，缺旗标会「配置已开但会话未装载」）。

**依据**：pi RPC 无 per-session 工具开关参数，settings.json `defaultTools` 是唯一持久控制通道；增量条目与用户手工编辑、MCP 侧 `autoEnableCodemode` 联动正交同向叠加。否决面：launch preset `--tools` 会话级全量枚举（pi 调整默认集即静默失真，多入口重复接线）；运行时激活 API（影子状态双源漂移）；纯开关无默认写入（违背默认开裁决）。

**登记**：无新约束族。实装 = `packages/runtime/src/infra/pi/pi-codemode-settings.ts`（启动迁移 + 字段域 + 损坏 fail-fast 跳过告警）+ `packages/runtime/src/infra/pi/pi-settings-store.ts`（'tools' scope 与损坏检测单点）+ `packages/pi-rpc/src/spawn-args.ts`（恒带旗标）+ WS 通道（`packages/runtime/src/services/ports/codemode-settings.ts` / `packages/runtime/src/transport/codemode-message-handler.ts`）+ `packages/renderer/src/components/settings/system/SystemCodemodeSection.vue`。机制现状另登记于 [docs/CONTEXT.md](../CONTEXT.md)（codemode / defaultTools 词条）、[docs/FEATURE-PRIORITIES.md](../FEATURE-PRIORITIES.md) 与 [docs/architecture/data-source-registry.md](../architecture/data-source-registry.md) §6；设计文档 codemode（设计档案已随 .tmp 清理，不入库），本条即该裁决的现行登记处。

### ADR-0124 出站结果回程契约：disposition 终局 + handled 通知 + 孤儿对账 + 命令出站形态（2026-10-04 设计裁决，pi1-disposition-chat-flow D1/D2）
**决策**：出站条目的终局判定由 pi disposition 响应与投递标记回执双通道承接，终局事实一对一通知前端：
1. **disposition 接线 + handled tombstone 终局**：出站 prompt（时为 `promptWithBusyRetry`，现为 `promptAwaitingCompaction`）读响应 disposition（rpc-client 出口经 `parseInputDisposition` 归一）；extension 命令被 pi 接管（disposition=handled）的条目不进 in-flight 等待，直接写终局记录（时为 `DeliveryTombstone`，v3 后 = DeliveryStore 终局记录经 `confirmDelivered` 落定）——终态固定为 delivered，语义从「送达事实」扩为「离开系统的事实」（不新造终态形态；cancelled 保持用户撤销专用——被接管混入撤销判据面会破坏 `isUserReclaimRejection` 双信号判据与「已投递不可撤」语义），继承断线重连 resync 判重防线。
2. **终局通知**：内核经 WS 消息 `session.deliveryHandled { sessionId, clientUuid }`（一次性事件消息，非 last-value 快照）一对一通知前端；前端静默回滚三件套（移除乐观气泡 + 清空空窗计时器 + 递减在途计数），无错误提示。不采用快照消息承载（消息缺席无法区分取消/接管/丢失）与受理回执携带（受理回执必须即刻返回，等处置会让 reply 时延顶到 pi 处置时长、且把受理口径按投递路径割裂）。
3. **孤儿对账**：`session.delivery` 快照到达（含断线重连回放）时，本地在途气泡的 clientUuid **曾经在场**（曾出现于任一帧派生视图——必要条件，防连发场景误清第二条气泡）且已离开在途（终态判据双分支：不在当前派生视图 / 在派生视图呈 delivered 终态）→ 按 handled 同形态静默清除。数据源 = delivery 快照派生视图而非 transcript 派生视图（pi 1.0 首次 flush 前会话文件不存在，transcript 口径不可判定；且仍在内核排队的条目会被误清）。**操作域限定（U2 实装收窄）**：对账清除只作用于受理回执 isCommand 登记的命令条目（useChat `handledDeliveryTargets` 在册成员）——普通消息条目终局必有 message_end 回执链管气泡，孤儿清除操作普通条目会在「快照帧先于 message_end 回执到达」窗口删掉已送达气泡（direct 投递路径降级豁免下构成文本丢失风险）；命令条目不注标出站永无回执，是唯一悬挂源，清除恒正确。「本端无取消操作」豁免条件随操作域收窄结构性消解，无需取消豁免集合——命令条目撤销后清除恒正确（cancel 成功 → 内核删条目 → 下一帧「不在派生视图」分支清气泡，原文已回填草稿；cancel 竞态落败 → delivered 在场 → 命令已执行，清气泡同样正确）。曾见集合随对应气泡移除、上界 = 活跃气泡数；页面刷新后退化为「不清除」（保守方向，误清零风险），悬挂残留由重开 session 恢复。
4. **命令识别 + 出站形态分型**：session 建立时经 `get_commands` 拉清单缓存；识别规则 = 文本 `/` 开头 + 首空格前段剥前导 `/` 后与清单 name 逐字精确匹配 + `source === 'extension'`（pi 侧接管判定只查扩展注册命令，匹配集与匹配口径两侧构造性一致）。识别为命令的条目出站**不尾附投递标记**（裸命令文本），终局凭据 = disposition 本身；未识别的 `/` 开头条目按普通消息带标记出站（实际被接管则 handled 仍驱动终局，纯单词漏识别则退化普通回合、与现状一致）；skill 与 prompt 模板输入恒走普通消息链路（注标出站 + message_end 回执——两类输入在 pi 侧展开开回合、不返回 handled，剥标记即无终局凭据）。清单拉取失败时全量按普通消息出站（兜底分支）。

**效果**：命令终局时效从「永等 → 30s 超时」变为「响应即终局」；普通消息出站形态与送达回执链路零变化（pi 无输入持久化回执，标记 + message_end 命中是唯一送达凭据）。实装 = `packages/runtime/src/services/session/session-delivery-registry.ts` + `packages/session-delivery/`（内核）+ `packages/shared/src/protocol.ts`（`session.deliveryHandled` 消息）+ 前端消费（useChat / store）。登记无新约束族（ADR-0074 投递所有权内核的回程通道延伸）。设计文档 pi1-disposition-chat-flow（设计档案已随 .tmp 清理，不入库），本条即该契约的现行登记处。

### ADR-0125 occupancy 事实驱动 + CP6 回落窗退役（2026-10-04 设计裁决，pi1-disposition-chat-flow D3）
**决策**：occupancy（dispatching/generating/idle 派生视图）回落由事实凭据驱动，2 秒定时回落窗（CP6）退役：
1. `deliverOne` 前置换位加 `turn === 'idle'` 条件——生成中出站保持 generating 不覆盖；handled 响应到达即主动回落 dispatching → idle（pi 权威回答取代时间窗猜测）。
2. CP6 删除后的防悬挂承接 = `sweepInFlight` 对账扫描补 occupancy 收尾：confirm 分支（transcript 命中）与命令清单静默终局分支在清空该 session 最后一笔在途条目时，若 `turn === 'dispatching'` 则转移 idle（幂等门 = 仅 dispatching 才回落，不覆盖 generating/settling；真误判由 turn 事件自愈）。凭据 = transcript 命中 / 命令清单命中的事实（事件驱动），触发时机随既有 10s 宽限对账轮，不新增定时窗；requeue 分支（transcript 未命中重投）条目仍在途、不做收尾。
3. **时间平抑红线登记**：CP6 的退役条件 = pi 提供权威去向事实——由 ADR-0124 的 disposition 接线达成。sweep 收尾动作的根因 = 「started 形态下回合事件异常不可达但 transcript 已有事实凭据」的残余形态兜底，退役条件 = pi 提供回合事件必达保证或输入级回执。

**效果**：时间平抑类机制净减一；空闲发命令不干扰原回合生成状态。实装 = `packages/runtime/src/services/session/event-interpreter.ts`（CP6 删除 + sweep 收尾）+ `session-delivery-registry.ts`（前置条件 + handled 回落）。登记无新约束族。设计文档同 ADR-0108（不入库，过程产物），本条即该退役决策的现行登记处。

### ADR-0126 pi 词汇合法持有点清单 + 泄漏机器检查（2026-10-04 设计裁决，pi1-disposition-chat-flow D5）
**决策**：pi 词汇（pi 系 import / 事件名字面量 / 拒绝文案 / pi 方法名 / 协议类型）只允许出现在两层**合法持有点清单**内，清单外由 `.githooks/check_pi_type_leak.py` 五项机器检查拦截（类型项 + import / 事件名 / 文案 / 方法名四项）。**本条即清单 SSOT，与检查器文件头注同源维护——两处改一处必同步**：
1. **合法持有点清单（两层）**：runtime 内 = `packages/runtime/src/infra/pi/**`（infra 门面层）+ `packages/runtime/src/services/session/session-delivery-registry.ts`（文件头封闭声明）；仓内 pi 系镜像层 = `packages/pi-rpc/**`（RPC 消息契约镜像）+ `packages/pi-subagent-cli/**`（pi spawn 事件直接适配器）。文案项更严：唯一驻留点 = `infra/pi`（消费方经 `infra/pi/pi-rejection.ts` 导入常量，清单内其他文件亦不得持有）。与类型项存量 ALLOWLIST（2026-08-22 过渡基线，独立专项治理）互不取代、不合并维护——两套白名单分管两类词汇。
2. **事件名词表界定规则**：扫描词表 = `packages/runtime/src/infra/pi/pi-protocol.ts` 的 `PI_EVENT_NAMES` 常量数组值域（字面量唯一驻留点，兼作检查器词表派生载体——检查器启动解析提取，定位失败或空表 fail-fast 退出非 0，摘要行输出词表基数）。等价关系「常量表值域 ≡ PiEvent 联合判别值全集 − 同形剔除集」由同文件两层编译期断言机器强制（`as const satisfies` 子集层 + `PiEventNameDriftGuard` 的 ExpectNever 穷尽层）——联合扩成员而常量表与剔除集均未收即 tsc 红，剔除集扩容路径由该红灯获得机器触发入口；检查器 python 侧零第二套词表（扩联合后下次运行自动取到新词表，检查器代码零改动）。services 层引用 pi 事件名一律经 `PI_EVENT` 具名常量导入，字面量直写即违规。
3. **同形剔除集（6 词，不进扫描词表防误报，与 pi-protocol.ts `PiEventNameHomoglyphExempt` 同源）**：trace-trigger 联合判别值 3 词（message_end / agent_settled / entry_appended——pi 原始事件名作 taiji 侧触发标签，已属 taiji 自有词表成员）+ compaction_end（taiji 判别值是连字符 'compaction-end'，pi 原词经 onTraceSync 宽 string 传值——该词无类型约束防线，防线下限 = 唯一用途点单点存在 + 评审承接）+ 通用词 2 词（status / error——taiji 通用词汇大面积同形）。
4. **「检不出」盲区声明（口径边界，登记备查）**：(a) taiji 复合消息类型尾段（如 'message.message_start'）——字符串完整值 ≠ 词表词，属整串相等口径的选型理由而非盲区；(b) 无引号对象键形态（`{ agent_start: ... }`）——标识符键非字符串字面量，检不出（该形态的现存实例已随 plugin-bridge 退役删除；未来再现时扩「对象键」匹配形态为纯增量动作，检查器头注即重审触发器）；(c) 日志模板串内嵌——完整值 ≠ 词表词不命中，日志文本非协议穿透通道，保留原文。剔除代价如实登记：剔除集 6 词上的 L2 型泄漏（services 层直听 pi 原始事件流）检不住。

**效果**：pi 升级的代码审查范围 = 合法持有点清单（类型项另含存量 ALLOWLIST 过渡基线）；检查上线以泄漏修法族落地为前置，首检红灯仅限设计登记的预期存量（整串口径）。同源对端 = `.githooks/check_pi_type_leak.py` 文件头注（白名单 / 词表派生规则 / 剔除集 / 盲区声明的检查器侧副本）与 `pi-protocol.ts` 剔除集断言红灯指引。登记无新约束族（既有 C-comm-02 延伸）。设计文档同 ADR-0108（不入库，过程产物），本条即该清单的现行登记处。

### ADR-0134 工具声明信息单源化：三层分工（2026-10-13 设计裁决，tool-declaration-slimming D1）

**决策**：extension 工具声明（description / 参数 schema 字段说明 / promptGuidelines）的同一信息只在一处写，三层分工固定：① 功能语义（参数是什么、合法值域）只写在 schema 字段说明；② 使用纪律（何时该用、禁用什么）只写在该工具的 promptGuidelines；③ 跨工具通用规则（不要 poll 轮询等待、tokens/time 仅用户明确要求才设、model/thinkingLevel 默认继承主 agent）收敛到 subagent-workflow extension 的 `<available_subagents>` / `<available_workflows>` 每 turn 注入段，说一次（`SUBAGENT_DISPATCH_SHARED_RULES`）。两项范围裁决：**bash 契约锚词保留**——bash 的 description 是 taiji 自写的功能契约文案（background 后台模式契约、「DO NOT bash sleep」自动通知契约），在压缩范围内但契约文案保留，只有跨工具纪律类语句收敛到注入段；**跨工具交叉引用保留原文**——direct 工具文案里指向延迟加载工具的引用不改写（工具不在场时模型经 tool_search 检索即可），工具改名时的旧名引用由拆分同批全扫改写承接（ADR-0135）。分层配套两条：拒绝条件类教学文案移到运行时错误文案（运行时错误自带恢复指引；结构性缺参由 pi schema 校验层天然承载参数回显与缺失明细，模型可自纠重发）；弱模型正例价值的守护手段 = 每工具压缩时列**锚词保留清单**（该工具必须保留的关键词与单例正例，写入契约测试替代原逐字断言）。

**不采用**：各层各自「再讲一遍更保险」的写作方式（三层重复是声明量臃肿的主因）；全部使用指导移 system prompt 注入段的重写形态（注入段随子代理清单等动态内容每 turn 变化，会把稳定的工具声明区变成频变区、破坏 prompt cache——外部同类系统的实测教训；且等于重写全部工具声明，成本远超压缩收益）。

**登记**：实装 = `extensions/universal/subagent-workflow/src/index.ts`（注入段常量）+ 各 extension 工具定义文件；基线对比口径为 tool-size-audit 过程产物（已随 .tmp 清理，不入库）。效果：声明量最大的五个工具（subagent 组 / session_read / workflow 组 / ask_user / subagents）合计约 35.8K 字符压缩至约 22.2K 字符（u-a1 落地实测，commit `af1d02ea6`），逐项落入设计目标区间。设计文档 tool-declaration-slimming（设计档案已随 .tmp 清理，不入库），本条即该裁决的现行登记处。

### ADR-0135 subagent/workflow 工具拆分粒度与 permission 旧名规则迁移（2026-10-13 设计裁决，tool-declaration-slimming D3）

**决策**：复合工具按动作拆分，让每个工具的参数 schema 真实反映必填性：**subagent 拆三**——`subagent_start`（必填 task/slug，可选 model/worktree 等 start 场景参数）/ `subagent_manage`（action: list/cancel/close）/ `subagent_message`（message 与 fork-from 两动作）；**workflow 拆二**——`workflow_run` 与 `workflow_control`（action: status/abort/resume，与既有 `schedule_control` 同族命名）。**旧名不保留别名**（pi 对激活集内未知名静默忽略，fork 含旧名 toolCall 记录的会话加载不报错——探针实证）。**必填性真实化的范围收窄**：真实收益集中在 start/run 场景（原「21 个可选参数挑 2 个必填」）；manage/control 内部是小 action 枚举（参数同构），不再往下拆单动作工具。**permission 既有规则一次性迁移**：permission 扩展的用户权限规则按工具名精确匹配并持久化落盘，工具改名使既有 `tool: "subagent"` / `"workflow"` 精确规则失配（deny 静默退化成 ask 兜底）——规则加载时把精确匹配旧名的规则**原地展开**为对应新名的同 pattern 规则（subagent → subagent_start/subagent_manage/subagent_message 三条；workflow → workflow_run/workflow_control 两条），wildcard 规则不动，迁移幂等。两条实装契约：① **原地替换保序**——展开条目替换原规则在数组中的位置（展开序固定：subagent → start/manage/message、workflow → run/control），与未迁移规则的相对次序不变（matcher 为 last-match-wins 按数组顺序遍历，「收集展开规则追加到数组尾部」会静默翻转精确规则与 wildcard 规则混合集的胜负且无报错）；② **每条分配新 id**（复用 `makeNextIdCounter` 从既有规则取最大 user-N 递增分配），禁止克隆原对象共享 id（`Rule.id` 语义为唯一 id，rule-editor 按 id 键控删除，同 id 多条会删除错乱）。**宿主侧键控集合同步扩名**：`packages/shared/src/constants.ts` 的 `SUBAGENT_TOOL_NAMES` / `WORKFLOW_TOOL_NAMES` 扩入拆分新名并**保留旧名**——历史会话 toolCall 渲染依赖旧名在集（agentgraph 块分类入口与 record 失效信号分流按工具名字面量键控，漏扩则渲染静默退化为普通工具块且无报错）。

**不采用**：一次拆到最细（subagent 6 + workflow 4 个单动作工具——工具数翻倍，system prompt 工具列表行与模型可选项同增；manage 三动作合一已是真实必填性粒度）；hidden 别名壳工具承接旧 permission 规则（与「旧名不保留别名」裁决冲突，且 subagent 1→3 的映射无法用单个别名工具表达）；显式接受规则失配不迁移（deny 静默退化是持久化用户数据被作废的真实行为回退，不该无处置接受）。

**登记**：实装 = `extensions/universal/subagent-workflow/src/interface/tool/`（拆分 schema 与 gui-mappers action 判别适配）+ `extensions/universal/permission/src/`（加载时迁移）+ `packages/shared/src/constants.ts`（键控集合扩名）。设计文档 tool-declaration-slimming（设计档案已随 .tmp 清理，不入库），本条即该裁决的现行登记处。

> **补记（2026-10-22，subagent-tool-interface-refactor）**：工具拆分粒度结论继续成立（7 个工具、manage/control 不再往下拆单动作工具，批量工具不拆为 run/status 等单动作碎片——run 控制归 `workflow_control`、批量派发归 `subagents`，工具数量不变）；本设计变更的是 `subagents` 批量工具的**参数形状**——`tasks` 改为成员对象数组（成员级 `agent`/`model`/`thinkingLevel`），`agents` 逗号串与 `aggregate` 从工具 schema 移除（出现即报错并给正确形状，详见 [ADR-0156](#adr-0156-批量派发成员对象--成员表-record-权威源--subagents-转常驻2026-10-22-设计落地subagent-tool-interface-refactor)）。参数形状变更不动工具拆分结构，本条拆分结论无需修订。

### ADR-0136 低频工具延迟加载：defer 名单 + tool_search 启动迁移 + 孙进程波及（2026-10-13 设计裁决，tool-declaration-slimming D4）

**决策**：工具按使用密度分级装载——低频工具注册声明 `exposure: "deferred"`（不进每轮请求的 tools 数组，经 pi 内置 tool_search 检索激活）：defer 名单 = session_read、rename_session、bash_output、bash_kill + session-manager 七件套（send_to_session、read_session_history、list_my_sessions、get_session_status、abort_session、delete_session、archive_session）+ subagent_manage、subagent_message、workflow_control（2026-10-23 重划，见文末补记）；高频工具保持 direct 常驻 = bash、todo、ask_user、pending_notifications、structured-output、subagent_start、subagent_batch（原 `subagents`，2026-10-23 改名，见文末补记）、workflow_run、workflow-script、plan、goal_control、schedule、schedule_control、compact_context、create_managed_session（2026-10-23 重划，见文末补记）。**tool_search 经启动迁移默认启用**（与 codemode 启动迁移同通道同口径）：复用 `PiCodemodeSettings` 写入通道，幂等追加 `+tool_search` 条目——`defaultTools` 数组存在且不含任何 tool_search 条目（`+tool_search` / `-tool_search` / 纯名 `tool_search` 任一形态）时追加，已含任一形态则不重复；**`-tool_search` 视为「已含」**（负条目在场时迁移永不追加，pi 按条目顺序应用增删后 tool_search 关闭且跨重启持久）。用户退出语义：永久关闭 = 手工写入 `-tool_search`；手工删除 `+tool_search` 会在下次启动被补回（数组形态无法区分「用户删除」与「从未迁移」，不为区分二者引入迁移标记字段）。**孙进程波及（终态：零波及）**——settings.json 全 pi 进程共享，但 subagent 模板不装载 builtin:tool-search（`buildPiSubagentSpawnArgs` 无该项，pi-rpc 与 pi-subagent-cli 双回归锚锁定），孙进程 tool_search 未注册（pi 的 defaultTools 只能激活已注册工具），`+tool_search` 条目在孙进程无消费方：零声明零成本，无功能影响；设计期「接受波及（约 200 token/孙进程请求）」的量化与 subagent 宿主 spawn 加 `--exclude-tools tool_search` 的降级路径随装载体裁决（v-a3-fix）失效退役。**跨进程边界**：fork/resume 后先前激活的 deferred 工具退场（pi 构造期激活恢复分支不可达——探针实证），再次需要时重新检索一次即恢复，非卡死。

**不采用**：高频工具（subagent/bash 等）一并 defer（每会话首次使用多一轮搜索，交互轮次代价大于声明收益）；session-manager 直接摘除（已交付的托管会话功能，defer 已省下声明位、保留功能可用性）；tool_search 走设置页开关形态（与 codemode 同属系统级默认启用，开关化徒增设置侧）；自研工具目录按需注入（检索、激活、transcript 记录与 pi 原生 tool_search 逐语义等价，属双轨实现）。

**登记**：实装 = defer 名单各工具的注册定义（各 extension `src/`）+ `packages/runtime/src/infra/pi/pi-codemode-settings.ts`（`+tool_search` 迁移条目）+ `packages/pi-rpc/src/spawn-args.ts`（主 agent spawn 基座恒带 `--extension builtin:tool-search`——settings 通道只能激活已注册工具，`--no-extensions` 下显式 `-e` 是唯一装载通道，缺装载则迁移条目无消费方、deferred 工具经检索的按需激活链路不可达；subagent 模板不装载，其工具范围是显式白名单语义无检索需求，三处测试带防误传导断言（pi-rpc spawn-args / pi-subagent-cli spawn-args / runtime rpc-client-spawn-markers——末者断言 runtime 组合根真实 spawn argv 的 `--extension` 恒为 builtin 三项））；pi 语义门禁登记 = [docs/pi-semantics.json](../pi-semantics.json) PS-78（tool_search 激活通道：defaultActive:false 注册 / defaultTools 只激活已注册工具 / 未注册条目静默无效果）+ PS-79（ToolExposure 五档分级 / setActiveTools 点名即声明只滤 hidden / 构造期 transcript 激活恢复分支在 SDK 入口不可达——「跨进程边界」段的探针实证入册处）；能力分级登记 = [docs/FEATURE-PRIORITIES.md](../FEATURE-PRIORITIES.md)「工具延迟加载」条目（P2）；术语登记 = [docs/CONTEXT.md](../CONTEXT.md)（deferred / tool_search 词条）。设计文档 tool-declaration-slimming（设计档案已随 .tmp 清理，不入库），本条即该裁决的现行登记处。

> **补记（2026-10，session-manager-archive-delete）**：defer 名单随 session-manager 工具扩容由六件套为八件套（新增 archive_session、delete_session，上文名单句已同步）。deferred 归属理由 = 两工具与其余六件同族同密度（低频终局操作）；delete 的 deferred 形态兼具「平时不可见降低误用面」保护语义——激活前不进活跃工具集，模型平时看不到删除工具，仅用户提示触发 tool_search 检索时才激活。设计依据 session-manager-archive-delete 设计文档（过程产物不入库）。

> **补记（2026-10，调度模式预设白名单交叉点）**：内置「调度模式」预设（`builtin:session-dispatch`，toolMode allowlist）的 `allowedTools` 列入 session-manager 八件套全部（含 archive_session / delete_session）。**事实 ①（pi 1.0.0 源码 + 本地 pi CLI 探针实证）**：allowlist 下 `--tools` 命名的 deferred 工具直接激活并声明给模型——SDK 入口 `initialActiveToolNames = options.tools`（`dist/core/sdk.js:148`）经 `_buildRuntime` 进 `_applyToolLoadout`，该过滤只排除 hidden（`dist/core/agent-session.js:1121-1125`，PS-79 同机制）；`_isDeclarable` 检查（:2833）只作用于「在白名单却不在初始名单」的 defaultActive:false 工具，不拦截点名的 deferred 工具。探针形态：`pi -ne --mode rpc --session-dir <tmp> -e <session-manager/index.ts> -e <probe.mjs> --tools <调度模式白名单>`，probe 扩展在 session_start 读 `pi.getActiveTools()`——现状白名单下六件 deferred 全部在活跃集，追加 archive_session / delete_session 后两者同样进入。**事实 ②**：allowlist 下 tool_search 不在白名单即不进 registry（`_isAllowedTool` 过滤，:2785）；即便列入，`getAllTools()` 只含白名单内工具且已全部激活，`searchAndLoad` 候选集恒空——tool_search 在 allowlist 模式零作用，**不列入**调度模式白名单。**裁决（delete_session 列入）**：上文「平时不可见」保护在 allowlist 模式对白名单内全部工具（含同为破坏性操作的 abort_session）整体让位于用户显式选择模式的语义，并非 delete 独有；调度模式是子会话最密集的场景，不列入则用户明示删除也不可达（无 tool_search 检索通道）；delete 的发起者约束（仅用户提示可调）由三处承载：`USER-INITIATED ONLY` 标记词（description 与 promptSnippet 各一处）、词义消歧（模糊词归 archive_session）、`isOwnedBy` 圈定（只能删 agent 自己 create 的子会话、整树进废纸篓可手工找回），随激活一并声明给模型、不依赖可见性层，约束链路不断。实装 = `packages/shared/src/pi-preset.ts` DEFAULT_PRESETS 的 SESSION_DISPATCH 条目（单测 `__tests__/pi-preset.test.ts` 锁 14 项）+ 镜像 [pi-launch-presets.md](../architecture/pi-launch-presets.md) §1.2 + [FEATURE-PRIORITIES.md](../FEATURE-PRIORITIES.md) session-manager 行。

> **补记（2026-10-22，subagent-tool-interface-refactor）**：defer 名单移出 `subagents`（注册不写 `exposure` 字段 = SDK 缺省 direct 常驻，上文名单句已同步）。理由：批量的成员对象形状（`tasks` 元素 = `{task, agent?, model?, thinkingLevel?}`）与成员级模型是首调正确性的关键——deferred 工具不进每轮声明集（pi `_isDeclarable()` 只放行 direct/model-only），schema 不可见时「第一轮就写对调用形状」无从谈起，schema 可见比正例文案更可靠；`workflow-script` 继续延迟加载（脚本创作是低频路径，延迟收益仍在）。常驻预算实测登记于 [ADR-0156](#adr-0156-批量派发成员对象--成员表-record-权威源--subagents-转常驻2026-10-22-设计落地subagent-tool-interface-refactor) 决策 3（真实 `tools[]` 序列化 2984 字符 / 对照 `subagent_start` 4254，倍率 0.70 通过「≤约 2 倍」判据；设计期声明文本口径预估约 +2.6K 与实测口径不同）。设计依据 subagent-tool-interface-refactor 设计（过程产物不入库），现行登记处 = [ADR-0156](#adr-0156-批量派发成员对象--成员表-record-权威源--subagents-转常驻2026-10-22-设计落地subagent-tool-interface-refactor)。

> **补记（2026-10-23，可见性重划 + 批量工具改名，同日两轮裁决的终态）**：defer/direct 名单按用户裁决重划（上文名单句已同步）——转常驻（移出 defer）：plan、goal_control、schedule、schedule_control、compact_context、workflow-script、create_managed_session、subagent_batch；转收起（移入 defer）：subagent_manage、subagent_message、workflow_control。批量派发工具 `subagents` 改名 `subagent_batch`（反转 §3.3.4 零改名裁决）并常驻（ADR-0156 决策 3 的常驻裁决与首调可见性论证随改名恢复成立）。改名配套三件：① `WORKFLOW_TOOL_NAMES` 集合（packages/shared/src/constants.ts）加新名并保留旧名——历史会话 toolCall 渲染依赖旧名在集（ADR-0135 同模式）；② permission 旧名展开表加 `subagents → ["subagent_batch"]`（精确规则原地展开，ADR-0135 同机制；登记 [extension-conventions.md](../extensions/extension-conventions.md)「跨包隐式契约」条）；③ 跨工具交叉引用（subagent_start promptGuidelines 的批量入口引用）同批改新名。边界说明：session-manager 由八件套整体 defer 改为 create_managed_session 常驻 + 其余七件 defer——创建入口常驻（模型默认可见可建），管理/终局操作保持低频 defer，delete_session「平时不可见降低误用面」保护语义不变；转收起工具的发现链路 = workflow_run 常驻 description 指名引用 workflow_control（按名检索即达——BM25 排名的高置信经验、非构造性保证，pi@1.0.0 实装锚：检索语料含工具名 = dist/extensions/tool-search/tool.js:85、候选含非活跃 deferred = :149，语义登记 PS-90），subagent_manage/message 经 tool_search 检索激活（激活当轮起 promptSnippet 进系统提示词工具文字清单——pi@1.0.0 实装锚：snippet 表构建不限 exposure = dist/core/agent-session.js:2802-2807、渲染 = 激活集 ∩ 有 snippet = dist/core/system-prompt.js:82，语义登记 PS-89）。

## 通信与协议

### ADR-0055 MessageBus：per-session 消息分发 SSOT
runtime→renderer 的 per-session 消息分发（`packages/runtime/src/services/message-bus/`）。每 session 维护单调 seq + 1000 条 ring buffer + stateSnapshot；renderer 切 session 时 `session.subscribe` 走「snapshot 回放 + last-value 注入 + lastSeq 基线」，此后 live push 靠 seq gap 检测触发 reconcile。ServerMessage 的 id（RPC reply）与 seq（push 事件）互斥。session 级消息已收敛为 bus.publish 单通道，global 级走 broker.broadcast。登记 C-comm-06。

### ADR-0060 route-inbound 三通道路由
入站消息分发单一真相源在 `packages/core/src/coordination/route-inbound.ts`，三出口：dispatchSession（per-session 消费者）、dispatchGlobal（无 sid 消息）、dispatchCrossSession（带 sid 但全局消费者需收的消息——extension:widget/status/notify/ui_request 等，合法消费者仅 ExtensionHost）。crossSession 不是广播；raw-message-tap 旁路已删除。事件分发面在 `core/src/transport/api/events.ts`。登记 C-comm-05。

### ADR-0046 RPC 类型配对 SSOT
协议层单点真相源——`packages/shared/src/protocol.ts` 的 ServerMessageMap + ReplyPayloadMap（K → reply payload 或 void），domain 侧经类型化 `command<K>()` 原语从协议推导，禁止手写泛型与协议脱钩。登记 C-comm-07。
协议条目退役执行记录（防未来重提）：`message.steer` / `message.follow_up` 已按投递所有权内核 u5a 退役条件删除（runtime transport 路由 + dispatcher/sessionService 转发路径 + 协议三处条目同批删，消费方统一收敛 delivery.submit，lane/intent 判定归内核）；`send.rejected` 保留（runtime bash 通道 busy 时 publish 的活跃生产路径，bash 通道在投递内核改造面之外）。

### ADR-0016 ServerMessageType 类型约束（部分有效）
事件/RPC 消息类型受 ServerMessageType 联合约束，emit 拼错编译期报错（原 event-bus 文件已随包重构消失，现形态 = protocol.ts 类型定义 + route-inbound 分发，约束精神不变）。

### ADR-0010 / ADR-0012 Extension UI 独立通道（0012 的 plugin bridge 部分已退役）
pi extension 的 confirm/select/input 交互走独立 `extension.ui_request`/`extension.ui_timeout` 事件，与 Tool Approval 的 tool_call_pending 语义隔离、错误隔离；该通路的现行形态 = event-adapter 直接消费 pi 事件按结构化字段路由（ADR-0111）。plugin-bridge 已整体退役（插件工具进 pi 通路暂缺，原缺口登记已关闭删除，本条即权威记录）。登记 C-comm-12。

### ADR-0024 FileChanges runtime 解析通道
event-adapter 在 tool_execution_end 按 write/edit 分派提取 FileChange（参数名 path 为契约权威），bash 不解析、由回合边界 git 对账补齐 delete/bash 变更；runtime 只推 accumulating/ready 两态，审查态归前端。登记 C-comm-04。

### ADR-0044 系统提示词双路
替换走 pi 原生 `--system-prompt` CLI 核心段替换（runtime spawn 链透传，仅新会话生效）；追加走 builtin 扩展 `extensions/taiji/system-prompt` 的 before_agent_start hook 每轮读 `<dataDir>/system-prompt.json`（热生效）。配置全局一份，runtime 与 pi 内扩展读同一文件。登记 C-pi-09。

### ADR-0068 扩展消息注入形态：custom message 首选（2026-09-21）
pi extension 向 LLM 注入提示词/通知消息统一走 `pi.sendMessage()` custom message 形态（`display` 控制用户可见性、不伪装用户消息归属）；`pi.sendUserMessage()` 保留给承载真实用户视角语义的消息——提示词类内容伪装用户消息的形态已在四包改造中清除（smart-context/goal/structured-output/plan，merge accb67c37）。关键语义两条：① custom message 经 pi `convertToLlm` 无条件转 LLM user 消息，对 LLM 与 user message 无差别，形态迁移不损失模型可见性（语义登记 [pi-semantics.json](../pi-semantics.json) PS-43，锚 pi `dist/core/messages.js:89-96` case "custom"）；② `sendMessage(triggerTurn:true)` 非 streaming 时直调 `_runAgentPrompt`，跳过 `prompt()` 主路径前置链（compaction 检查 / before_agent_start 事件 / systemPrompt 叠加 / pending nextTurn 消费）——依赖 per-turn 注入的需求不得走该通道。约定载体 [extension-conventions.md](../extensions/extension-conventions.md)「Event handler 消息注入」。

### ADR-0071 引擎协议演进宪法：删改分类学与判据（2026-09-22）
engine-protocol v1 的演进纪律从「头注承诺 + 人工记忆」落为成文宪法。终态条文浓缩于协议四处头注（`packages/subagent-engine-sdk/src/protocol/` 的 engine-protocol.ts / contract-types.ts / reverse-channels.ts / schema.ts——头注只载终态纪律不载删改史）；**本条是 6 次历史破坏性删改与判据 why 的唯一入库权威载体**（协议目录系 fresh import、git 不可追溯，改写前的源码头注是唯一现场记录，随本条收编后同批改写为终态）。约束登记：C-proc-13（存量演进表述对齐）、C-proc-22/23/24（判据 6 行为键必配门 / 四张词表锁 / 宽容语义四行）。

**6 次破坏性删改分类学**（三型纪律不同，不能一刀切 additive 也不能一刀切同批）：
- **A 型同形改名**（1 项）：`run.params.chat` → `run.params.resume`（载荷同形仅键名泛化；架构权威 docs/architecture/subagent-chat-run-unification.md §3.3 D3/D5）。additive 替代（新增 resume 键 + 读端 `params.resume ?? params.chat` 双读 + 旧键 `@deprecated` + major 清除）成本趋零却走读写同批，且双读形态从未被实践——A 型但书由此立：同形改名默认 additive 双读，仅当双读引入语义纠缠时才允许同批。
- **B 型机制替换**（2 项）：`interact` 控制范围方法删除（续聊统一为新 run + resume 锚点；双轨 = 两套执行模型在 reducer/journal/conformance/能力门四面长期双维护，本身就是协议债）；`task.conversation` 键删除（per-run 模式开关语义消亡、职责并入 resume，双保留会造成「谁赢」的语义纠缠）。同批切换合法，条件 = 对端同仓 + ADR 登记（即本条）。
- **C 型死成员清理**（3 项）：轮次相位反向通道（新增后从未被消费）、`host/poolResolved` 通道（poolKey 恒 'shared'、回调零信息量——池抽象降级，docs/architecture/zcode-engine-appserver-resident.md）、`host/permission` 通道骨架（双侧零实装占位，「未接线死通道」）。根因不在删除在**新增**——治理 = 新增门槛：无消费方不进协议、占位先行即违宪（与能力位「声明链路实际接通的能力」哲学同源）。

**判据 1-7 证据锚点**（条文终态见 engine-protocol.ts 头注）：判据 1（引擎不消费→宿主自持）→ `task.idleTimeoutMs` 错位（六引擎映射全部不支持，实为宿主 idle GC 参数）；判据 2/3（what→task / 推导分叉→ctx）→ schemaEnv 三次搬家与 sessionRootId 事故补丁（文字判据靠人执行必然漏的两次实证）；判据 4（task/ctx 双写禁令）→ schemaEnv 双源事故——**H1b 收敛未完成**：`packages/subagent-core/src/execution/engine/client/remote-engine.ts:382` 仍 `ctx.schemaEnv ?? task.schemaEnv`——wire 层禁令断言现状纯 never、无豁免（AgentCallOpts 已单侧排除 schemaEnv，键集交集为空），双源现状登记于断言注释（wire-field-locks.test.ts）待收敛回看；判据 5（能力位双向回指）→ 先例 streamMode↔eventGranularity；判据 6（键三分类 + behavior 键必配门）→ resume↔conversation gate（error-codes.ts `assertChatConversationSupported`）与 forkSource 注释双先例，判别式 =「旧引擎静默忽略此键，宿主会发现吗？该降级是设计内吗？」（三案例归档唯一：resume→behavior、streamMode→degradable、description→advisory）；判据 7（能力位消费点/载体登记）→ steer 首个登记条目（capability-gate.ts 联合判据消费、pi-host-binding.ts 声明 unsupported，无独立 wire 执行通道——缺失如实登记，不设计）。

**演进政策三条**：① additive 面——新增可选字段/事件变体/方法/反向通道不 bump 版本，旧端忽略或 no-op 安全落空；新增须过门槛：消费方 + 降级路径 + 能力位绑定三件齐才进协议，无消费方不进协议。② 删除范围——A 型同形改名默认「新增新键 + 旧键 deprecated 双读 + major 清除」；B 型机制替换/语义收窄同批切换合法（条件 = 对端同仓 + ADR 登记）；对端独立节奏出现时删除一律走 major。③ major bump——core 支持区间平移 `[1,2)→[2,3)`，遗留清单届时清理。存量不搬家（搬家本身是删改），遗留清单 = idleTimeoutMs（明确错位）/ scene、description（弱错位待核）/ schemaEnv（待 H1b 收尾，未收尾）/ steer 执行通道缺失；**重审触发条件** = 遗留清单 >5 项或任一错位引发实际派发事故 → 提前清理裁决，不等 major。

**未知成员宽容语义四行**（与编译期词表锁互补的运行时半边；词表头注与 engine-development-guide.md 引擎实装义务落地随之推进）：①未知 event.type → 旧宿主 reducer default no-op 安全落空（逐变体 noop-safe 论证标记）；②未知正向 method → 引擎回 error 帧 `engine_method_unsupported`（engine_ 前缀透传逻辑新码，旧宿主收到不崩；引擎实装义务绑定下一引擎适配层立项随批带上 + conformance 用例，当前无消费方不实装）；③未知 host/* 反向通道 → 宿主回 `{unsupported:true}`（由 askUser 语境泛化到全通道），发送方引擎走自身降级路径；④未知可选键 → advisory 忽略、behavior 键必有门（判据 6），不存在无门依赖。配套机器锁 = **四张词表锁**（事件/方法/通道/能力位键集统一为常量 SSOT 派生或键集互锁，编译期红灯堵 schema enum 缺值与缺键 undefined 透传洞）。

**minor 协商触发条件（任一命中重开裁决；条件不到不加协商位）**：① 出现本仓之外发布的引擎适配层（第三方作者或独立 npm 分发/版本节奏）；② 单宿主需同时挂载跨协议代差引擎且无法同批升级；③ 出现「需宿主确认才可启用」的运行时可变能力（能力位从静态 manifest 变动态协商的真实需求）。

判据 1-5 是宿主→引擎字段归属判据，不适用于引擎→宿主上报（引擎→宿主新增帧/事件按上述演进政策与反向通道关联键总纲裁决）。权威源 [subagent-engine-protocolization.md](../architecture/subagent-engine-protocolization.md) §3.3「协议演进宪法」。

### ADR-0091 workflow run 显式状态机：转移表裁决 + 事件流权威派生视图（2026-09-21）
workflow run 生命周期治理（`packages/subagent-core/src/orchestration/run-events.ts`）四件套：① `RunLifecycle` 5 态显式状态机（`created/dispatched/running/settling/terminal`；W2 死形态清退收敛，见 [ADR-0080](#adr-0080-runrecord-状态机收敛五态机唯一权威--outcome-四值--record-意图原语即状态机2026-09-27-设计裁决)；已被 [ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 修订为四态 + interrupted 暂停态——dispatched 并入 running、interrupted 入 lifecycle 为非终局暂停态），`transition` 纯函数 + `RUN_MACHINE` 机器声明（@zhushanwen/state-machine，ADR-0152）是唯一裁决入口——表外转移 fail-fast（`IllegalTransitionError` 让位 + debug 留痕），禁止直写状态字段；约束由 API 形态结构性承载（对外只暴露 query + transition 唯一入口），非 grep 检查型、不设独立约束登记。② 事件流 journal（`RunEventJournal`，`<agentDir>/workflow-state/<runId>.events.jsonl`）是 run 态权威派生视图源——注册表派生视图 = journal fold 四相（missing/active/terminal/interrupted），文件 mtime 推导退役；abandon 是终局化动作（被动终局写 run-settled 帧 outcome='interrupted'），非静默丢失。（介质与 abandon 已被 [ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 修订：事件流更名 record 单源 `.record.jsonl` 且升格唯一事实源；abandon 全链移除，中断改落 `run-interrupted` 转移事件非终局帧）③ 终局诊断引用（stderrTeePath）随 ask-settled 登记事件流、终局派生视图从事件流读回——不引入第二写点、不扩 run-settled 载荷。④ run 级恢复场景的杀伤半径收窄（D9-2）：watchdog no-progress 与 cancel 收敛兜底两类调用点从全量按进程组终止 `killAll` 收窄为 `killRunTopology` 定点收割（只杀该 run 锚定的引擎孙进程，引擎宿主与同引擎并发 run 存活；零拓扑引擎降级为 stall 出声不杀——ADR-0047 静默 ≠ 卡死）；dispose（停机全灭）/ stdout-wedge（引擎级路径楔死）/ failEngine（引擎级故障，反向通道楔死）三个调用点豁免保留按进程组终止——故障定位在引擎级而非 run 级，本无 run 级目标。排障姿势见 [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) §26。

### ADR-0075 workflow 域四支柱平移与 schema 通道终态（2026-09-21）
workflow/subagent 域对 pi 边界四支柱（ADR-0064）的同构落地与 schema 传输终态：① **确认式送达平移**——注册操作的终局通知必达，workflow run 成功/失败/取消一律出终局通知（持久账本 + 幂等键，C-ext-19 在 workflow 域的细化）；② **生效回执平移**——schema 强制武装回执：`armed` 事件是引擎自查断言之外的独立信号源（监控信号不与施控同源），宿主等待窗内未收到即 fail-fast；仅 native 引擎、仅 schema 任务上报，emulated 引擎恒不上报（契约义务权威源 [engine-development-guide](../extensions/subagents/engine-development-guide.md) §6 `armed` 行）；③ **契约显式化**——schema 跨进程只经 wire `task.schema` 单字段传输（env 预编码形态 `schemaEnv` 已退役，env 由引擎宿主从 task.schema 派生，resolver 产出侧负断言锁防回流）；扩展加载显式化（`ctx.extensionPaths` 白名单收窄落壳侧 pi-host，argv 镜像机制退役）。**schema 通道终态**：native schema 链保留直传（宿主对 parsedOutput 不做二次校验）、emulated 仿真为退出通道，由 `schemaEnforcement` 能力位声明分流。登记 C-ext-24 / C-ext-25 / C-ext-26。

### ADR-0094 run/record 介质归位：journal 唯一事实源 + 两条 v2 条目 + 收编统一（2026-09-26）
workflow run 与 subagent record 的运行态持久化介质收敛（承接 ADR-0091 的事件流 journal，把「权威派生视图源」升格为「唯一事实源」）：① **journal 唯一事实写**——run 侧既有 `<sessionDir>/workflow-state/<runId>.events.jsonl`，record 侧新增 `<recordsDir>/<sa-id>.events`（无 .jsonl 后缀——既有 .jsonl 扫描器/清理器结构性忽略该文件族；首行 `{"type":"record-journal"}` 头行自描述），两域事件行均携带单调 seq；② **主 session 每实体只写注册 + 终态两条 v2 小条目**（customType 不变、v 升格 2、kind 判别 registered/settled；终态条携带 result 全文与 engineHandle 双键；注册条携带 journalPath 锚点——session-reader workflow 发现链主源）；v1 全量快照 entry（含 eventLog/displayItems 死字节）停写；③ **state/manifest 降级为 journal fold 的物化派生视图**（可删可重建、读方零改动；.alive 仍是操作租约不计事实源）；record-bound 时物化一次 running manifest（zcode 运行窗口锚定，带锚定就绪检查与写失败降级）；④ **恢复统一为「journal 重放 + 收编」**——「有注册、无终态」的实体经幂等收编入口补追加终态事件（先查双面证据防重复），recoverCrashedRuns 与 abandon 的终局化同走该入口（证据落点对称）；⑤ **清理 = 显式保留窗口（默认 30 天）+ fold 终态资格判据，cap=50 废除**（多 session 分摊误清消除），统一保留维护轮承接 run/record 两域（原 session-file-gc 对 `*.events` 的显式忽略面已随 [ADR-0133] 废弃删除——无 GC 面可忽略，维护轮是唯一窗口判据）；⑥ **runtime 读路径 = 内存派生视图**（entry 游标 + journal tail 双增量源单点合并，同实体冲突 journal 胜出；32MB 预检与全文重读退役为旧格式惰性兼容读专属；WS 信号形态不动）。写侧检查 `scripts/check-record-write-surface.mjs` 断言范围同步（R1-R7：写函数直调 / 两族条目写侧白名单 / v1 快照派生视图构造器与载荷形态拒绝 / 死字节拒绝 / .events 直写拒绝）。条目契约单源 = `packages/subagent-core/src/execution/persistence/record-entry.ts`（subagent-record 族）与 `orchestration/workflow-record-entry.ts`（workflow-record 族）。登记 C-data-20（写侧唯一入口口径刷新）。

**写侧宿主扩充（2026-09-29，resume 修订 D15/D16 落地连带）**：workflow-record 条目写点宿主在原三写点（worker-message-pump.ts / lifecycle.ts / 壳 jsonl-run-store.ts）基础上新增 terminal-actions.ts（D15 终局编排单一入口的注册/终态条目写点）与 resume-run.ts（D16 resume 链注册条目写点）——条目构造仍全走 buildWorkflowRecord*EntryData 意图原语与 appendEntry 通路，写侧唯一入口语义不变（宿主清单扩充非写点扩散）；`check-record-write-surface.mjs` R3 白名单同步为五写点宿主。

**v1 兼容层已整体删除（2026-09-30 裁决：项目未上线、无 v1 数据，不迁移不兼容；登记 §3.3）**：原「W4 legacy sunset 失效版本清单」的 subagent-record 侧写侧/读侧全部落地删除——
- core `record-entry.ts`：v1 快照接口 `SubagentRecordEntryData` 与写点 `toSubagentRecordEntry` 删除，`classifySubagentRecordEntryData` 收为 v2-only（`ok:true` = 当前版本条目；v1 形态归 `future-v`）；
- core `record-store-rebuild.ts`：v1 收集/重建路径删除，改为 `collectV2EntryPairs` / `v2PairToRecord`（v2 注册 + 终态条目对；身份域损坏拒绝重建）；
- core `record-store.ts`：`reportSubagentRecord`（v1 快照纠偏写点）删除；孤儿恢复改由 v2 形态承担——事件文件在者归 `adoptV2Orphans`，entry-only 形态（注册条目在、无事件文件、无子文件）归 `recoverEntryOnlyOrphans` 补写 v2 终态条目（stopReason=interrupted-by-restart）；
- runtime `journal-projection.ts`：`v1Subagents`/`v1Workflows` 源与「v1 冻结定界优先」仲裁删除（该仲裁是「派生视图遮蔽事件流」的方向性缺陷本体）；
- runtime `subagent-extractor.ts`：v1 快照分支删除，改按 v2 条目对重建；
- 遗留未删（非 subagent-record v1 快照侧）：`workflow-extractor.ts` 的 workflow 旧形态分支与 `session-file-extraction.ts` 全文读路径（32MB 预检——冷启动旧 session 兜底）；session-reader discovery/workflows 的旧 workflow-state-link 指针 fallback（三档发现链的下两档）；
- state-marker 旧值（finalized/cancelled）上行映射等伴随面（`Atomics.wait` 同步睡重试已随 W1 D6 全量退役，无 W4 残余——state-marker.test.ts 断言锁定）。

**第六读者失效登记**：`scripts/zcode-session-db-cleanup.mjs`（zcode 引擎存量宿主行清理工具）自持 customType 白名单解析带 `data.v !== 1` 版本门——v1 条目停写后对全部新记录恒跳过、白名单恒空 → 清理侧恒空，属**功能性保守降级**（漏清不误删：新记录本来就不落宿主库，白名单空集 = 零删除，语义安全）；该脚本为一次性清理工具，不随 W4 sunset 强制退役，重跑时对存量 v1 数据仍有效。

**修订注记（2026-09-30）**：事件文件头行已定 `{"type":"record-events"}` 并落盘（`RECORD_EVENTS_HEADER_TYPE`，`record-events.ts`——本文 `record-journal` 头行表述以本注记为准）；落盘键与符号旧词清理已落：`engineHandle.journalPath` → `engineHandle.eventsPath`（SDK wire 契约 + core record/manifest/entry 形状 + 读写两侧 + 扫描检查同批）、workflow-record 注册条目锚点键 `journalPath` → `recordPath`（无 v1 数据，不留兼容读）、遗留符号清单改名完成（`JsonlEventJournal`→`JsonlEventStream`、`RecordJournalWriteFace`→`RecordEventsWriteFace`、`RecordJournalFoldState`→`RecordEventFoldState`、`journal-tail.ts`→`event-tail.ts`、`SessionJournalProjection`→`SessionEventProjection`、`journal-wiring.ts`→`event-journal-wiring.ts`）——本文 `journalPath` 锚点等旧词表述以本注记为准。

**读侧换源与 manifest 裁决（2026-09-30，②④ 批次落地）**：record 读侧身份/统计/revive 基线全部换源事件流折叠（`identityFromFold` / `receiptStatisticsFromFold` / `baselineStatisticsFromFold`——TerminalCtx 增 `foldOf` 注入位；binding 读函数零生产读路径，`.record-binding` 只剩写侧与戳职责，写点退场 = 后续批次）；record 侧 manifest 裁决为**方案 A：收敛为带水位纯索引**（`eventsStamp` 水位统一收敛到 `withEventsWatermark`，markSettled 改先事件后派生视图写序；读侧不匹配即跳过回落重建）——方案 B（删除 manifest、session-reader 换源 fold）不采用：session-reader 侧改动范围 6 文件超阈值、其生产依赖范围刻意不引 subagent-core（折叠无法复用又不许复制）、孤儿可见窗口语义等价拿不准；跨包读侧是 manifest 整体退场的挂起点。索引条目 v3 自承收条统计域（turns/totalTokens）；负缓存三消费点（reconstructAll 快路径 / scanFile / buildEntryFromIndex）增事件侧反查击穿（bound 帧追加不写 binding 也可见）。

### ADR-0080 run/record 状态机收敛：五态机唯一权威 + outcome 四值 + record 意图原语即状态机（2026-09-27 设计裁决）
workflow run 与 subagent record 的状态词表与状态机形态收敛（承接 ADR-0091 显式状态机与 ADR-0094 介质归位；权威源为 w2-state-machine-convergence 设计文档（设计档案已随 .tmp 清理，不入 git）——实施记录 git 可追溯）。七件套：

① **run 活体终局单一裁决点**：活体终局全部经五态机 `dispatchRunTrigger` per-run 串行队列裁决（表外转移 fail-fast）；两态机（`RunStatus` running|done + `state.status`/`state.reason` 快照字段）降级 v1 兼容层——活体写点删除，恢复路径写点显式清单保留（`recoverCrashedRuns` 公共快照收敛），live 读者（终局判定 / 通知载荷链 / 淘汰排序 / sweep 判据 / 派生视图读者等）全部换源 journal fold 与终局记录，禁止以 `state.status`/`state.reason` 为活体终局判据或载荷源。终局记录四件套（journal run-settled 帧 / manifest / 终态条目 / pending 注销）收敛为共享原语 `settleRunAccounting` 单点，活体终局 / 崩溃收编 / abandon / idle 回收四场景共用，场景差异只在触发时机、幂等判据与 outcome 取值，不在记录结构；完成通知回调仅活体路径注入，冷路径（收编/abandon/回收）不执行——中断 run 不产生 workflow-result 完成通知。

② **lifecycle 死形态清退，六态收敛五态**（created/dispatched/running/settling/terminal；已被 [ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 修订为四态 created/running/settling/terminal + interrupted 暂停态）：`interrupted` 态（无进入事件）、`host-died` 控制触发、`ask-executing` 事件、`abandon-elapsed` 控制触发与 `from:"interrupted"` 表行全部删除；`RUN_EVENT_TYPE_PROBE` 键型随词表缩窄恢复穷尽（member-pool 补键，runtime typecheck 由红转绿即修复验收锚）。

③ **outcome 升四值**（`RunOutcome` = completed/failed/cancelled/interrupted，`ALL_RUN_OUTCOMES` 单源；已被 [ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 修订为 done/failed/cancelled/time_limited——completed→done 改名、interrupted 移出 outcome 入 lifecycle 暂停态、time_limited 从 errorCode 升格独立 outcome 值；已被 [ADR-0159] 扩为五值增 partially_succeeded——run 终局吸收成员交付）：`interrupted` 是被动终局的唯一权威表达（「崩溃 ≠ 失败」的用户可感区分）——崩溃收编 / abandon 7 天窗 / idle-gc 30 天回收三条被动终局路径写 outcome='interrupted'，细分语境由 errorCode 承载（`interrupted_abandoned` / `idle-evicted`；该三路径已被 [ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 收敛：abandon 全链移除、idle-gc 已随 ADR-0081 退役，中断改落 `run-interrupted` 转移事件）；`cancelled` 保留「用户主动取消」语义不被稀释，显示侧「已取消」（主动）与「已中断」（被动）禁混用。W1 存量收编帧（outcome='failed'）读侧不映射、按 failed 显示，登记已接受代价（随 core retention 保留窗自然出清，重审触发 = 被动终局语境帧占比 >20% 或出现用户可感误报）。DoneReason ↔ outcome 映射归单点函数（`runSettledOutcomeToDoneReason` (outcome, errorCode) 联合判别，预算/超时终局细分语境不折叠；partially_succeeded 直返同名 DoneReason）；显示语义一律走 outcome 值域，reason 诊断范围的折叠是已接受过渡形态（pending 注销条目 run 侧 'failed' vs record 侧 'aborted' 对同一崩溃场景并存，W4 DoneReason 退役时收敛）。

④ **record 域不建显式转移表，意图原语族即状态机**（已被 [ADR-0152](#adr-0152-状态机统一基建-zhushanwenstate-machine声明即用--五域迁移收敛2026-10-20-设计落地state-machine-infrastructure) 修订：翻边判定收进 `permanentSessionStatusMachine` 显式表——意图原语族仍是唯一写入口，CAS 拒绝语义保形）：唯一入口 = RecordStore 意图原语 + C-data-20 写侧两级拦截（eslint no-restricted-imports + grep 门）；表外拒绝 = `tryEnterRunning` CAS 失败 + 原语前置断言；词表 = 三维正交单源——lifecycle 维（`ExecutionStatus` running|idle）× 停因维（`StopReason`，展示排障侧；已被 [ADR-0158] 事实化——停因只存引擎原值与宿主中断族事实词，推断值 completed/failed 降为派生展示词）× 结果维（outcome 四值；轮终参数收窄 `ExecutionOutcome = Exclude<RunOutcome,"interrupted">`——interrupted 只由收编/回收路径写入，类型上构造性封死）。与 run 域显式转移表的不对称是有意的（两态域转移表只有两行有效转移，CAS 比表级 fail-fast 更早更严，复制六态域机制 = 重复保险式过度工程），验收判据两域统一（「表外转移构造性不可能」），不要求机制同构；`tryTransition`/`completeRecord` 说谎签名随调用方迁移到意图原语后删除。

⑤ **manifest legacy 三态口径归类为派生视图持久化格式**：manifest 是 journal fold 的落盘物化派生视图（ADR-0094），其 running|closed|cancelled 三态是派生视图持久化格式（单一生产者 = 物化步，消费方经翻译函数 `manifestToSubagent` 消费），不是消费方必须在代码里理解并翻译的状态词表——状态词表套数口径以「消费方直接消费的枚举」为准，manifest 三态不计入。shared `WorkflowRunOutcome`（core↔shared 依赖方向不允许物理单源的第三份字面量）同口径归类为**派生视图输出**并升四值，值域跟随由两道锚承载：runtime extractor 值级判定集合 `WORKFLOW_RUN_OUTCOMES` 同步升四值（漏升 = interrupted 经 session 记录提取链被静默丢为 undefined）+ runtime 双包值级等价断言（core `ALL_RUN_OUTCOMES` ≡ extractor 集合 ≡ shared 词表成员）；`WorkflowRunStatus`（派生视图二值，同先例）与 `WorkflowDoneReason`（随 W4 sunset 收敛）按同口径登记。

⑥ **abandon 注销差集登记不修（已接受代价）**：abandon 的 journal 帧 + manifest 两件直落，终态条目可选（壳触发点不传即不补，重开 fallback 补写）、pending 注销差集残留仅存在于「旧 session 永不重开」场景（该 session 内 pending 列表多一行，无跨 session 泄漏；重开即 reconcile-sweep 自愈——sweep 的 workflow 分支判据源已改接 journal fold / manifest 终态证据，非终态/坏链/IO 故障保守按活跃处理不误注销）。为低频残留给收编路径加「跨 session 定位旧 session 文件并写入」通道 = 新增写路径与新的失败情形，收益不成比例，不修。idle-gc 回收与 abandon 对称：same-session 四件直落齐套、cross-session 两件直落 + 重开自愈，同样不新增跨 session 写通道。

⑦ **词表单源的机器保证 = TypeScript 构造性保证**（删值后引用即编译红），不新增 grep 第二道检查；构造性保证的执行时点 = CI typecheck job 全包步承载跨包阻断（runtime / core / shared / SDK / extensions 五步覆盖词表改动范围，任一消费包漏同步即 CI 红）；UI 状态→颜色映射的穷尽锁（satisfies Record / never 断言）由 type-level 测试断言锁本身存在。

本波不新增约束登记（构造性保证无需第二道 grep 检查）；既有 C-ext-26（终局通知裁决点）/ C-data-20（record 写侧唯一入口）口径不变。

### ADR-0081 idle-gc 机制退役，崩溃恢复收敛为事件驱动两层 + 启动扫描（2026-09-28 设计裁决）
**idle-gc 机制退役，崩溃恢复收敛为事件驱动两层 + 启动扫描**：30 天 TTL 定时器机制（record 内存回收 + workflow run 僵尸收编）整体删除——三个必要性论据经核实全部不成立（视图按目录取数 / journal 恒 KB 级 / retention 事件驱动），且机制跑在 pi 进程内、pi 空闲态事件循环停止调度周期任务使其在生产常态下停摆。替代 = runtime 启动序列的一次性全量收编扫描（单实例锁确立后、先于任何 pi spawn 的时点；实装 `packages/subagent-core/src/orchestration/startup-sweep.ts`）：全量枚举 pi 宿主形态 run（候选 = record 事件流文件族，status = 共享判定核 fold record 读取折叠派生，[ADR-0082] D16⑥ 换源），对判读 running 的 run 逐个收编——收编形态一件直落 = 只追加 `run-interrupted` 转移帧（[D2] 后 interrupted 是 lifecycle 暂停态非终局，中断来源 errorCode=startup-sweep；不写 manifest 派生缓存【仅 terminal 输出】、不写终态/注销条目——宿主 session 重开由 reconcile-sweep 依 record 折叠 / manifest 终态证据自愈补写）。判僵尸依据 = 创建顺序契约（无时间窗）：扫描时点先于任何新 pi spawn（runtime 启动段不 spawn）+ 单实例锁确立（同数据目录无并存 runtime）——此刻判读 running 的 run 其执行者只可能是上一生命周期的孤儿 pi；孤儿 pi 若正常收尾，其尾帧与终态证据已落盘，收编被终态证据幂等让位（skippedTerminal，误收编不发生）；孤儿 pi 若已死/挂死，收编即正确修正。已接受代价（现行两件，四要素登记）：① 收编与孤儿 pi 正常收尾赛跑时，收编帧可能抢先落在孤儿尾帧之前——fold 读侧保守停帧在 interrupted、读侧不崩坏（量级 = 该 run 的显示在本进程内短暂呈 interrupted 的瞬态）；恢复路径 = manifest 事实面完好、下次扫描以 manifest 为准让位，数据最终一致；重审触发 = 该瞬态误报用户可感成规模。② record 半边失联清点合并进同一扫描入口（[ADR-0161]）——同入口两半各自声明失败纪律：run 侧枚举整体失败 error 留痕仅跳过 run 收编半边、record 失联清点半边照常执行（单 run 收编失败 warn 留痕继续其余），失败各自留痕不连坐；扫描整体不放大为启动失败（结构性不 reject）。record 内存回收无替代（驻留有界：session 结束进程退出全清；重审触发 = 单 session 驻留过千条或内存排障定位到 record 驻留）；孤儿 `.alive` 经三条代码证据核实无拦截路径（三分支重建判 running / 覆盖写 / pid 探针放行）。

### ADR-0082 workflow run record 单源收敛、生命周期与词表重构（2026-09-28 设计裁决，workflow-run-resume-revision）
**D1/D2/D3/D4/D5/D6/D7/D9/D11/D15/D16 + 裁决点 7 锚链原子批**（承 ADR-0081 的继承关系：idle-gc 退役后的替代链 startupSweep 在本批改经 D15 入口并换源 fold，其「双 run-settled 事件已接受代价」随 [D2] 中断转移事件形态整体消亡——中断不再有终局事件；承 ADR-0094 的介质归位：run 侧 journal 更名为 record 事件流并升格唯一事实源，state 快照物化派生视图取消）：
- **D1 record 单源存储收敛**：删 state 快照文件，唯一事实源 = record 事件流（`<workflow-state>/<runId>.record.jsonl`，append-only）——`run-created` 携带 scriptSource 全文、`agent-settled` 携带 result 全文，lifecycle/calls 全为 fold 内存派生视图，判终局 = record fold 唯一判法（无第二份可分叉的派生视图），收编 = 追加 `run-interrupted` 转移事件、不覆盖任何文件（双源病两阻断构造性消失）。壳 JsonlRunStore 重写为 record store 单模式（save = 显式 no-op；类名沿用历史文件名）。manifest 降格为 record 终局事件的派生缓存（判读 record 唯一权威 + manifest 加速，损坏即重建）；manifest 兼容读例外：历史 manifest 词表外 outcome（[D2] 前 interrupted 族——文件名未随 [D1] 迁移故磁盘可达）经判定核穷尽 switch 漏 undefined 时统一折叠诊断兜底容器 failed（W2 D5 先例「interrupted → failed」），不落 completed 兜底——中断形态报完成是语义误报；折叠收敛在 runSettledOutcomeToDoneReason 派生单点（reconcile-sweep-settlement.test manifest 用例 + pi-host-run-store 枚举 status 用例钉住）；旧格式两件套（`.events.jsonl` journal + `<runId>.jsonl` 快照）不读、不写、不主动删（用户裁决 2026-09-28：历史数据暂无不迁移——历史 run 不进 GUI 列表、resume 一律拒绝，随裁决点 7 清理自然消亡）；startupSweep 枚举判据换源 fold record（快照删除后原快照行 status 判据失效形态静默，D16⑥）；zcode 宿主 FileRunStore record 化不做（射程外，docs/todo 登记）。
- **D2 生命周期四态 + interrupted**：lifecycle `created → running → settling → terminal`（dispatched 并入 running——两态行为相同且零消费方）；interrupted 为暂停态（running/settling → interrupted：崩溃收编 / terminate 被动失联；interrupted → running：resume），非终局、无特殊转移行。RunOutcome 重构四值 `done/failed/cancelled/time_limited`（已被 [ADR-0159] 扩为五值增 partially_succeeded）：completed→done 与 shared status 同词；interrupted 移出入 lifecycle；time_limited 从 RunErrorCode 升格独立 outcome（新写入方无码，错误处理分级改双路判定——outcome 直判）。call 级（agent-settled 载荷）随共用类型随改不拆分，call 级实际值域 = done/failed/cancelled。宿主派生视图三态（shared WorkflowRunStatus 'running'|'interrupted'|'done'）；settled 终态条目仅 terminal 时写、中断形态条目 status 'interrupted'；中断 run 计托盘 ended 桶（显式裁决）。
- **D3 phase 状态机**：phase-started/phase-settled 转移事件入 record（worker 模板 phase() 经 postMessage 通知壳侧——模板快照同批更新）；fold 自愈规则（agent-started 载荷 phase 字段驱动 pending→running）承接 postMessage 异步丢失窗口，不判损坏。
- **D4 事件词对齐 pi**：ask-dispatched/retrying/settled → agent-started/retrying/settled；新增 run-interrupted/run-resumed。RunErrorCode 中断来源成员 crashed/terminated/startup-sweep；interrupted_abandoned/idle-evicted/time_limited 保留为历史帧解析（无新写入方）。
- **D5 armed 删除 / D6 member-pool 消解**：占位事件与词表成员删除；绑定改 agent-started 载荷 memberRecordId 字段（首派缺省、续写携带），member-reuse-pool 退化为绑定查询辅助，登记收尾零 IO。
- **D7 resume 入口跨进程锁**：锁文件 `<workflow-state>/<runId>.resume.lock`，proper-lockfile 直用（core 既有依赖 + worktree-registry 直用先例：`realpath:false`、stale 30s 夺取、指数退避）；锁段 = 资格校验 → v2 注册条目补写（先于复活事件落 record，失败干净拒绝——裁决点 7 引用归属）→ `run-resumed` 落 record → 活体注册；锁被占 = 拒绝文案指明另一进程持有；孤儿 run 清理时顺带删残锁（裁决点 7）。跨进程双宿主同时 resume 恰一成功（单写者纪律只到进程内的并发缺口封闭）。
- **D9 abandon 全链移除**：abandonElapsedInterruptedRuns 及常量/env 通道删除——「数天后回来仍可 resume」的 run 不再被判死；无主 run 清理归裁决点 7。
- **D11 terminate 被动失联分叉**：terminate 对 resume 接管来源 run 落 `run-interrupted`（errorCode=terminated）转 interrupted 暂停态——session 切换是被动失联，语义对齐崩溃中断、可再 resume；正常 run 维持 failed 终局（现状语义有消费方；统一转 interrupted 属独立语义变更，待用户另裁）。
- **D15 终局编排单一入口**：terminal-actions.ts 承载投递域（dispatchRunTrigger 单写者链）+ finalizeRun（terminal 五步 coda）+ interruptRun（中断转移统一写点，零终局副作用）；五路收敛 = abortRun / terminateRunningRuns / recoverCrashedRuns / startupSweep（u1b 接线）/ 正常终局链（pump 消息侧）；v1 兼容尾段删除（store 覆盖写语义已随 [D1] 不存在）；worker-message-pump 薄化为消息路由 + 重试矩阵。
- **D16 宿主读侧锚链**：runtime RUN_EVENT_TYPE_PROBE 词表镜像（9 键）+ projectV2Workflow 三态派生视图；shared 三态 + WORKFLOW_RUN_OUTCOME_ALL + 文案表（成功/失败/已取消/已超时）；renderer tray-tone interrupted 专属中性暗 + WorkflowTab call 级词表 done 贯穿；session-reader 发现链重锚（journalPath 锚点语义 = record 流路径——v2 档直读流提 calls[].sessionFile，不引 subagent-core 生产依赖【两案裁决：案 A（废除「不引 core」边界）不采用，sessionFile 从 agent-settled.result 承载】）。
- **裁决点 7 对账清理**：reapOrphanRuns（run-state-evidence 维护轮族扩展）——引用集三代解析（v2 注册/v1 快照/link 指针，壳侧 session-lifecycle 注入采集）+ 宽限窗登记（7 天 env 可调，锚 = 首判无主时刻非 mtime，与门防活跃误删）+ 三件删除（record 流 + manifest 派生缓存 + 历史遗留旧双源顺带删 + .resume.lock 残锁）。采集成本首轮实测（2026-09-29，等量级 fixture 400 session 文件 / 61.4MB，同款同步扫描形态）：单轮 37-40ms，远低于秒级预期上限；重审触发线 = 单轮 >5s 或文件数 >5000。壳侧采集器读错分通道（sessions 根 ENOENT = 空态，EACCES/EIO 真故障上抛 → core 采集失败整轮跳过的宁保留防御经生产路径可达）。
- 实施期裁决：ExecutionOutcome（execution/subagent-record 域）从 `Exclude<RunOutcome,"interrupted">` 改独立实体字面量 completed/failed/cancelled——设计未裁决该域（Out of scope 射程外），保留其写入值不变；D10/D11 状态载体落进程内注册表（worker-message-pump 的 resumedBudgetLedger「累计活跃段已耗 + 本段复活时刻」与 lifecycle 的 resumedOriginRunIds 来源标记——设计原文的 run meta 字段侧不在 U2 领地；record 流是权威源，再次 resume 按 run-resumed/run-interrupted 事件重算覆盖，注册表生命周期与消费方 [本进程 runs Map] 一致、evictDoneRunsBeyondCap 连带回收）；replay 输入漂移（回放入参哈希不匹配）= failed 终局 + 含恢复指引的诊断文案（D2 四态无 running→interrupted 人工回退转移——run-interrupted 写入方仅崩溃收编与 terminate 被动）；D12 宽松读取侧：agent-settled 无对应 agent-started 帧的残形态按 fold 自愈占位行处理（warn 留痕不拒绝——对齐 run-events fold 兜底语义），严格拒绝情形限坏行/seq 断档/settled 缺 result 三项。

- **resume 恢复语义修订（2026-09-30 用户裁决）**：原三档中的档 1（从子代理会话文件复用「已跑完但未提交」的结果）整体删除——恢复只保留「已有 agent-settled 则回放、没有则重跑（能定位同一成员会话则续写，否则重开）」，随删的派生机制见 [ADR-0099](#adr-0092-resume-只复用已提交结果删除从子代理会话日志复用结果的通道2026-09-30-用户裁决)。本条 D1–D16 其余内容不变。

### ADR-0087 session-manager 通知债权模型与 watch 桥（2026-09-24 设计裁决）

managed session 完成通知从「每次 settle 无条件回流（CompletionBackflow 文本 steer）」改为**通知债权模型**：主 session 每笔经 session-manager 发出的请求产生一笔债权（唯一 `notifyId` 幂等键），该请求被消费的轮次结束时关闭并经 B-ledger 通知一次；无债权的完成一律静默。**结构性不变量**：债权只在 session-manager 通道产生（create+prompt / send 成功）与消灭（settle 兑现 / exit·deleted 终结 / 主 abort 抹除），UI 续聊/插话、scheduler、孙会话回流一律不触碰。claim 记录 `{notifyId, kind: claim|lifetime, sessionId, parentSessionId, state, outcomeSnapshot?}`，键 `(parentSessionId, notifyId)` 唯一、重复 arm 拒绝；状态机 **armed → injected → fulfilled{outcomeSnapshot} → 删除**，吸收/终态 **orphaned** / **aborted**，delivery 失败路径 armed → 删除（静默 disarm）。兑现锚 = injected 后首次 `agent_settled`（reason outcome 映射 **completed/failed/stopped**；前提 = pi stdout JSONL 按序到达 PS-57 + steer 级联排空 PS-58 + marker select 长挂 PS-59，三条均登记 docs/pi-semantics.json 探针门禁、随 pi bump 重验）；主 abort 在 `handleAbort` 入口同步抹除（respond 'cancelled'，先于 await abort）。

**watch 桥（notifyId 单键寻址）**：extension 以 `{action:'watch', params:{notifyId}}` 长挂 select（不传 timeout、fire-and-forget），runtime 按（调用方 parentSid, notifyId）反查 claim——查无 fail-closed 立即 respond **'cancelled'**、已兑现 catch-up 快照、每 claim 单 watch 槽新覆盖旧；respond payload 回带 **sessionId**（optional——claim 命中路径恒携带；fail-closed 查无 claim 路径无 claim 可回带，缺席时 reason 恒 'cancelled'、extension 静默收尾不消费该字段） + meta **deathSeq** / **settleSeq** / fulfills N（death 侧 = 同 deathSeq claim 数；settle 侧 = 本批兑现总笔数，同批同值）/ exitCode / stderrTail / **sessionFilePath**（Full transcript 指针行数据源）。协议范围全 additive：send/create params `notifyId` optional（缺省不 arm + **willNotify:false**）、create result **lifetimeNotifyId**（runtime 生成，与 claim 键独立、同 `sm-` 形态同入站校验）、status/list result **undeliveredResults** 事实计数、pending type **'session'**。extension 响应处理 = unregister（**mapReasonToStatus** 族映射 stopped→aborted、exited/deleted/orphaned→cancelled，不扩共享词表）+ 默认 `recordManagedNotify`（经 delivery-port `port.deliver` 投递，现行载体；时为 `notifyLedger.record`，账本已随统一投递波 2 退役），两例外 = cancelled·orphaned 静默、死亡新闻槽 (sessionId, deathSeq) 去重；合批 = extension 侧 50ms trailing debounce（分拣键 **(sessionId, reason)**——跨 session 不合批的构造性来源；批身份 settleSeq/deathSeq）。

**B-ledger 确认式送达（清偿 C-ext-19 存量违规；现行投递路径已由统一投递 v3 取代——见 ADR-0074 耐久侧现行规则与 pi-boundary-reliability 附录 E）**：通知投递走确认式送达（notifyId 幂等 + at-least-once + 回执 + 重放）——现行载体 = `extensions/shared/delivery-port` 的 `port.deliver`（投递日志 + details-id 凭据 + session_start 差集重放，投递直达 pi 唯一队列）；时为 notify-ledger 择父 session settled 边沿投递，该边沿编排已随唯一队列退役（unified-delivery §3.10）。替换旧 backflow 的 at-most-once 内存文本通道；managed session 同时进入 pending-notifications 注册范围（type 'session'，register id = notifyId，三键契约零改动）。CompletionBackflow 全链废弃（settled/exit 检测职责并入 ClaimLedger，文案构造迁 extension）。死亡无条件通知 = create 时 runtime 自动 arm lifetime 记录，非 respawn 链死亡（delete / forceQuit / 不可恢复 crash）发声三入口：delete 经死亡处置汇聚点**先于 pm.destroySession** respond **'deleted'**（防 delete→exit 双事件竞态）；forceQuit 等不经 exit 链的收敛销毁经 removeSessionEntry 汇聚点补 respond **'exited'**（finally 必经步，时点在杀进程之后）；不可恢复 crash 经 respawn 熔断终态发声——三者同 deathSeq 同批终结；另有 onSessionExit 不在册兜底路径（session 已不在内存 Map 时直接发声，与上述入口重叠窗口幂等空转）；respawn 链（普通 crash 复活、idle 回收）静默。

**持久化二期登记（D8）**：v1 债权账本 = runtime 内存（与 delivery outbox 同生命周期）；跨 runtime/父 pi 重启的债权存活登记**持久化二期**（方向：并入 B-ledger 同族持久设施或 runtime 侧 journal，复用不另造），二期同时根治父 pi 死亡窗口的通知补投。

**关键不采用**：① per-session「已通知」布尔 flag——推导性质不应物化为状态，多债权合并时语义破碎；② extension 侧轮询子会话状态——有事件源禁周期 pull（ADR-0064 轮询精简准则），且「谁的完成算数」仍绕不开债权模型；③ 扩 notify-ledger 外部通道合批——P0 设施改动连带 workflow-result 通知形态回归，合批改 extension 侧 50ms 微窗（现行终态：投递经 delivery-port，managed-session-notify 外部通道结构性逐条不合批，批身份在 watch-coordinator 50ms 微窗重建——unified-delivery D3 裁决 4）；④ 死亡新闻槽「槽释放后新 claim 自带」的时间基判定——extension 无从知晓死亡事件响应笔数，arm→watch 微窗竞态下迟到 watch 会二次发声，(sessionId, deathSeq) 槽键序无关消解。已接受代价全集（本节即登记处，四要素：量级/恢复路径/重审条件/判定）：C-1 create 失败路径死亡通知缺失（罕见 throw 窗，poll/重试恢复，月级 1 次即重审）；C-2 >50ms 跨窗拆条 + 单笔 +50ms 延迟（幂等不破，A6 口径「至多一条、总数守恒」，用户可感知多条即重审）；C-3 象限2 混装整体退化（同 bundle 不可达，once 日志观测，锚失守即重审）；C-4 arm→watch 微窗通知缺位（毫秒级×父死并发，登记如实，实测可感知即重审）；C-5 arm↔register 非原子窗口（毫秒级自愈）；C-6 放弃旧文本通道 outbox 排队补投（已由统一投递 v3 双介质根治：runtime 磁盘 outbox + port 投递日志跨重启）；C-7 runtime 重启账本全失（已由统一投递 v3 双介质根治——投递日志持久于 pi session entry，重启经 session_start 差集重放）；C-8 宿主 JSONL 写侧线性增长（每 send 2 行 pending+每通知 ≥3 行，goal 每 turn 全量扫描，实施期测基线定阈值，compaction P-B4 实测丢 entry 即重审）；C-9 respond 失败窗口 register 残留（下次 session_start 收尾路径清理，长命 session 残留堆积即扩口对账心跳）。

过程设计文档为不入库产物（已随交付弃置）——**本 ADR 即决策现行登记处**，实施记录 git 可追溯（commit d06d9464a 起）。

### ADR-0127 extension_ui_request 通路结构化契约（2026-10-04 设计裁决，pi1-disposition-chat-flow D6）
**决策**：extension UI 交互通路按结构化字段路由，bridge 中介零驻留（plugin-bridge 已整体退役，RPC 事件 payload 是 event-adapter 对 pi 事件的直接消费，无转发注入）：
1. event-adapter 从 pi RPC 事件 payload 派生结构化字段：`method`（pi 1.0 RPC 实发全集 9 个：select / confirm / input / editor / notify / setStatus / setWidget / setTitle / set_editor_text）、`kind`。`extensionName` 不派生（U4 实装裁决：pi 1.0 extension_ui_request 九变体 payload 均无扩展名字段——dist rpc-mode.js + rpc-types.d.ts 实读核实，强加即恒 undefined 死字段；扩展归属信息仅 extension_error 事件自带 extensionPath，该事件翻译处保留该字段）。
2. **kind 词表三值（dialog / notify / widget），值值有消费点**：dialog 族 = `extension.dialog`（载荷 dialogKind ∈ select/confirm/input/editor，需回包族）；notify 族 = `extension:notify`；widget 族 = `extension:widget`。setStatus / set_editor_text 与 select 的 marker 家族（session-manager 通道 / inflight 上报）属 runtime/前端内部状态上报——**不进 kind 词表、保持特化出口**（进词表判据 = 该值物化于某族 WS 消息载荷并驱动路由，防词表死分支；亦避免与 event-adapter 内部路由字段 PiTranslatedEvent.kind 撞名）。setTitle 无出口：warn 留痕 + noop（pi 升级语义变化可诊断）。
3. transport handler 与前端按消息类型路由（取代 marker 字符串分支识别）；marker 约定 → 结构化 kind 的翻译职责收敛在 event-adapter（合法持有点内，见 ADR-0110），title 降级为纯展示。

**效果**：新通道接入 = 声明一处；kind 词表与 9 method 映射表即终态实有值（无死分支），可作实施对账底表；taiji 协议零 pi 专有方法名穿透（由 ADR-0110 方法名项检查拦截）。实装 = `packages/runtime/src/infra/pi/event-adapter.ts`（派生与分发）+ transport handler 消息类型路由 + `packages/core/src/transport/api/domains/extension.ts`（前端消费）。登记无新约束族。设计文档同 ADR-0108（不入库，过程产物），本条即该契约的现行登记处。

## 状态管理范式（renderer/core）

### ADR-0049 per-session Map 分区范式（最高频引用）
任何持有 per-session 状态的 composable/组件必须用 `useSessionScopedState` 工厂（`packages/core/src/foundation/use-session-scoped-state.ts`，内部 Map<sessionId,T> 分区）；禁止实例级状态依赖组件树隔离、禁止 watch(sessionId) 手动清空。WS handler 必须用 `updateFor(capturedSid)` 显式分区（结构性消除切换竞态）；cleanup 统一挂双壳各自的删除编排入口（桌面 `useSidebar.deleteSession` / 移动壳 `app-runtime.deleteSession`，两者均归入 core `triggerSessionCleanups` 统一执行）销毁编排，纯加状态不接线清理的 PR 打回。例外清单显式登记（useSessionEvents 订阅编排层、全局 sid 协调器类模块级 Map、Pinia factory 体内 Map、useTerminal 混合形态、TurnRenderCache shallowRef 容器、useTtsPlayer 全局单例播放状态——同一时刻每窗口只有一条消息在朗读，状态窗口级唯一而非 per-session，cleanup 走 deleteSession 统一编排调 stop）。**范围修订（ADR-0074 投递所有权内核）**：队列区状态不作为独立 cleanup 注册项——现役载体 = 投递内核的 per-session 派生视图（`session.delivery` 帧消费），清理点在 core `useChat.disposeSession`（随 `deleteSession → triggerSessionCleanups → disposeChat` 编排一并执行），renderer 侧注册清单不新增队列分区项。机器防线：taste-lint `no-instance-level-session-state`（error 级）。登记 C-state-01、C-state-08。

### ADR-0121 回放重复防御范式：同源查重 + 跨源清洗两层各管一段（2026-10-03 设计裁决）
chat 消息流对重复投递的防御按重复来源分两层，各管一段、不互相兜底：**同源重复**（同一 runtime 消息流同一 messageId 的重复投递——订阅失败后重订的全量回放、重连重订与缺失段回拉的重叠段）走**消费端 messageId 查重**：`packages/core/src/domain/chat/effects/registry.ts` 的 `message.message_start` handler 见同 id 气泡已存在则复用不 append；查重命中仅跳过 append——不改已有气泡 status（已终结保持终态由 sealed guard 幂等丢弃后续 delta，内容不丢；流式中保持 streaming，delta 由「最后一条 streaming assistant」定位继续累积到原气泡），`clearPendingSend` 照常执行（早返回会跳过 clear，把乐观发送态卡在 pending 窗口）。**跨源重复**（getHistory 基线的 entry 派生 id 与回放消息的 runtime messageId 是不相交 id 空间，查重结构性不命中）走**切入链时序 + 基线合并清洗**：先订阅（切入链步 5）后拉基线（步 9），首订回放产物经 `packages/core/src/domain/chat/store.ts` 的 `mergeBaselineWithLive` 尾部保护段清洗（已终结实体被基线替换）；双壳切入时序一致是该层成立前提。链外残余窗口（重连全量重订落在已加载分区）允许瞬态重复，残留至下一次清洗触发点（再次切入或 connected 边沿对账，同走 `mergeBaselineWithLive`）收敛为单份。**不采用**：①链外全量回放后强制基线合并清洗增强——链外重复属同源重复，查重已防住；②回放期序号门扩展（`subscribeSession` 回放前置「回放中」状态供序号门判定）——引入 subscription-state ↔ registry 跨模块状态耦合，其内容级双计防御的独立价值登记 [docs/todo/long-stream-delta-double-count.md](../todo/long-stream-delta-double-count.md) 观察项（触发条件 = 链外全量重订回放落在已加载分区且该分区含流式中轮次；症状判别 = 流式中气泡内容跳增（双计）或无头 delta（新气泡仅 delta 片段）；重审触发 = 真机复现内容跳增即重启该方案）。

### ADR-0043 消息模型 Segment[]
user message content 为 Segment 判别联合（text/skill/file/mention），badge 信息从 composer DOM（getSegmentsFromEl）结构化传递到渲染层；序列化/反序列化各只一处（segmentsToPrompt / parsePiUserContent）；归一化函数在 `packages/shared/src/segments.ts`。assistant/system 仍为纯 string。登记 C-state-02。

### ADR-0040 统一 file chip 通道
`#` 输入与 drawer 注入共用 insertFileChip（`packages/dom-core/src/composer/input/chip-commands.ts`），dataset 承载 path/lineRange；Segment file 类型为唯一结构化载体。

### ADR-0048 display 字段三路透传
pi CustomMessage 的 `display:false`（如 goal/todo context 提醒）三路透传（实时 effect / get_messages converter / JSONL apply-entry），渲染层 filterDisplayableMessages 统一按 `display === false` 过滤（仅 false 隐藏），store 保留完整消息供 fork/compact/replay。无黑名单。登记 C-state-03。

### ADR-0039 / ADR-0041 shallowRef 不可变更新 + 派生状态（0041 部分有效）
chat messages 用 shallowRef(Map)（`core/domain/chat/store.ts`），所有更新必须「新对象 → 新数组 → Map.set」不可变写法——直接 mutate 字段不触发响应式，属反模式。isGenerating 从 messages 派生（单一真相源 + 增量跟踪缓存）。

### ADR-0065 mutation reply 生效值契约
改状态 RPC 先判「后端会不会变换请求值」：经 pi（model.switch/setThinkingLevel）→ 禁乐观写，reply 生效值是唯一写 store 路径，协议 reply 生效字段类型必需；本地存储（preset CRUD）→ 允许乐观写 + reply 权威覆盖 + 失败回滚。机器强制两层：协议 reply 类型层（生效/回显字段必需不 optional，复用既有形状）+ `mutation-reply-contract.test.ts` MUTATION_RPC_REGISTRY（echo-value/exempt 两张清单的机器镜像与唯一登记处，新 mutation 不登记即测试红；reply 契约升级为 payload 消费型时须同步把条目改 echo-value/effective-value 并登记 replyKey + effectiveFields，ack-exempt 登记与 void 类型锁定互为校验）。现行锚点：config.setProvider = echo-value（reply `config.providerUpdated`，providerId 必需回显，quotaAutoEnabled optional 供 toast）。登记 C-pi-15。

## 包拓扑与分层

### ADR-0036 Monorepo 结构终态
pnpm-workspace.yaml 三组：packages/*（@taiji/* 16 包）+ apps/*（electron）+ extensions/*（taiji/universal/shared 三分组，@zhushanwen/pi-* 25 包）。renderer 依赖链单向：shared ← core ← dom-core ← ui ← renderer。单一 pnpm-lock.yaml，禁 npm。登记 C-build-03/05。

### ADR-0058 dom-core 包：DOM-bound 逻辑独立
「需要 DOM API、无 electron 耦合、跨 DOM renderer 复用」的前端逻辑归 `@taiji/dom-core`（现主要承载 composer/input：contenteditable/chip-commands/dragdrop）；`@taiji/core` 保持真 headless（零 DOM 零 jsdom，node/worker 可跑）。登记 C-state-04。

### ADR-0059 core factory + pinia 集成范式
createXxxStore factory（core headless）+ createUseXxx 编排 factory 的集成范式 =「store 封装（经公开接口访问）+ renderer 薄壳 defineStore + getXxxStore 处集中 cast（pinia unwrap ref 的固有类型鸿沟）」；禁止 raw createXxxStore() 双轨 + 桥接同步。chat 为范式标杆（`core/domain/chat/useChat.ts`）。

### ADR-0027 / ADR-0026 / ADR-0025 文件域三层 + 懒加载 + File View 语义（0027 部分有效）
FileService 三层：transport(FileMessageHandler) → services(FileService 编排：cwd 守门/懒加载/ignore/readFile 截断) → infra(FsExecutor)，IO 经 IFileExecutor port 不直连 node:fs；ignore 匹配为纯函数（`runtime/src/infra/fs/ignore-parser.ts`）。文件树懒加载：listTree 返回顶层 + 一级子，expandDir 单层按需，前端 5 态节点状态机（loaded 复用/inFlight 幂等/error 重试/invalidated 重新拉取）。File View = session cwd 完整目录树 + git.status 现在态角标，与消息流 ChangeSetCard（历史态）正交。

### ADR-0004 / ADR-0035 配置写入原子性 + write-back 模式
所有 JSON 持久化经 `atomicWrite`（writeFileSync(tmp) + renameSync）落盘——崩溃不留损坏中间态（`packages/runtime/src/utils/fs-utils.ts`）。「dirty + debounce flush + flushAll」write-back 为各持久化域统一模式（recent-workspaces-store 为范例）。登记 C-data-11。

### ADR-0001 / ADR-0002（digest）runtime 分层与手动 DI
runtime 为 transport → services → infra 三层，组装在 index.ts 手动 new（无 IoC 容器）；SessionPool 上帝类已拆为 SessionService + message-converter 纯函数。登记 C-comm-01。

### ADR-0011（部分有效）builtin 扩展打包内置
`@zhushanwen/pi-*` 扩展 esbuild bundle 后 staged 到 `apps/electron/resources/extensions/` 随应用打包，不走 npm 安装；清单 SSOT = `packages/shared/src/mandatory-extensions.json`。「随应用内置、版本随应用」核心决策延续（实现从源码拷贝演进为 bundle）。登记 C-build-02。

### plan 模式重设计的决策承载（2026-09-18，显式裁决：不另立 ADR 编号条目）
plan 模式重设计（GUI 呈现 + skill 挂载 + 文档审阅闭环）的全部关键决策由 pi-ext ADR 家族（pi-ext-021 prompt-only readonly / pi-ext-022 session-manager state 等既有条目）与 `extensions/universal/plan/` 源码注释 + [CONTEXT.md](../CONTEXT.md) 的「计划模式 / plan-state entry / PLAN_REVIEW_MARKER / record 派生视图链」词条承载，不另立 ADR 编号条目。理由：决策密度已由设计期对抗式审查收敛，核心机制（marker select 通道 = Marker RPC 词条、派生视图链 = 既有 subagent/workflow 机制的参数化扩容）均复用已登记决策，新编号只增检索成本不增信息。本条目即「为何检索 plan 相关决策不到 ADR-XXXX 编号」的权威解释。

## 可靠性与看护

### ADR-0047 watchdog 用进程健康探测
pi 卡死检测用「进程健康探测」（每 60s ping get_state）替代「事件静默时长」——静默 ≠ 卡死（ask_user 等待/慢工具都会静默），连续 2 次失败广播 WARN、3 次（180s）才 onSilentAbort。实装 `event-interpreter-ping.ts`（PingProbe）。与「runtime watchdog 滚动重启」（默认不武装，TAIJI_RUNTIME_WATCHDOG_ARMED）是两套机制。登记 C-comm-09。

### ADR-0069 内存活性治理审计裁决（2026-09-14，维持不治为默认）
全仓内存活性审计后的用户裁决：登记不治点位「维持不治」是默认，翻案需新实测压力数据（原审计文档 docs/design/memory-leak-remediation.md 已删除、git 可追溯，各点位量级锚与重审条件见其 §2.5；裁决注释已写入各源码处）。不治 8 项：sessionMetaCache / externalMetaCache / notRepoCache / usage-stats shards（语料有界）、pi-respawn 熔断计数（熔断语义优先）、clearedSessions tombstone（有意无界防迟到写）、executingBash 断连残留（两害相权残留更轻）、session-file-utils 32MB 全量读（协议合法载荷有硬上界）。已治理侧：G2 活性无界组（openPiStreams close 摘除、ws-client sweepExpiredInFlightSubscribes 挂重连路径）与 G4 杂项组（prematureTimeoutIds/deferFlushFailureCounts 纳入 disposeSession、skill-registry projectWatchers LRU(8)、ImportSessionDialog close 清扫描结果、quota fetch body cancel）。系统性防护（纯加状态不接线清理打回）已并入 ADR-0049 checklist。

### ADR-0018 extension 安装临时目录
Collection 安装先完整落 `tmp/ext-scan-{timestamp}/`（clone/cp + npm install），用户确认后拷入正式目录——取消/失败只清理临时目录，不污染 extensions/。

### ADR-0038 subagent 只 cancel 无 pause/resume
subagent 是 single-shot 子进程，控制只支持 cancel（现扩展 message/start），不实现 pause/resume——底层无长驻进程，不做假对称。

### ADR-0067 subagent「已收起」第三状态全链路清除（2026-09-16 用户裁决）
subagent 对用户的可见状态只有两桶：进行中 / 已结束（判据 = `isRunningProjection` 及其取反）——「已收起」（archived）不以第三状态呈现，全链路清除不残留：renderer 三桶视图与「已收起」过滤器删除；shared/runtime 派生视图链的 Intent 类型与 ExecutionRecord.intent / SubagentRecord.intent 字段删除；subagent-core markArchived 原语删除，close 的资源收尾职责由 `markSettledOut` 承接（close 终态写点：幂等、worktreeHandle 清句、`.alive` release、manifest 派生视图，不写任何意愿字段）；markReactivated 删除（message 续聊无翻位发生，万物可续判据不变）；通知 gate ①（archived 静默检查）删除，close 注销 reason 词 `archived` → `completed`。机制权威 [docs/architecture/subagent-permanent-session-model.md](../architecture/subagent-permanent-session-model.md)（§3.2.5/§3.2.7 已按删除后现状改写）。登记 C-data-20、C-proc-13。

### ADR-0013 / ADR-0014（digest）sessionData 本地文件持久化（0013 部分有效）
plugin 的 per-session KV API 保留；底层为本地文件持久化（`plugin-service/session-data-store.ts`，atomic write + 启动恢复 + debounce flush），不依赖 pi.appendEntry。

### ADR-0034 / ADR-0033（digest）recent-workspaces pull-only + 三层
pull-only RPC（workspace.listRecent，无 broadcast——规避订阅时序竞争）+ 三层（handler 零业务路由 → workspace-service 编排检查 → recent-workspaces-store LRU 纯算法）。登记 C-comm-08。

### ADR-0021（部分有效）资源加载策略
config 层 skill/agent 加载 = 强制目录（桥接层硬编码注入，不可关）∪ discovery.json v2 可选目录（project/global 拆分、可排序）；目录级粒度无文件级开关。agent/workflow 的资源发现已改 `subagent-core/src/shared/resource-discovery.ts` 7 源代码推导（last-writer-wins 遮蔽语义），discovery.json 在该链路废弃。

### ADR-0051 项目 skill 目录 .agents/skills
skill 路径按 cwd 解析（getSkillPaths(cwd)），项目自用 skill 归 `.agents/skills/`，跨项目通用归 `~/.agents/`；实体存储形态（workspace 根共享 + 脱离版本化）见 ADR-0103。

### ADR-0103 项目级 AI skill 实体迁 workspace 根，脱离分支版本化（2026-09-25 裁决）
`.agents/` 项目级 skill 实体唯一落 workspace 根 `<workspace>/.agents/`，各 worktree 以相对 symlink（`.agents -> ../.agents`）共享同一实体，git 不跟踪（`.gitignore` 忽略条目即裁决载体）；路径解析仍按 ADR-0051（cwd 相对 `.agents/skills/`，symlink 对消费方透明）。理由：skill/workflow 是开发者工作流资产而非分支交付物，随分支版本化 = 各 worktree 各持副本、实体改动与业务分支耦合出合并负担；单一共享实体按变化原因归位（工作流资产全 worktree 同步演化，不随业务分支分叉）。脱离 git 版本化的丢失风险由备份恢复通道补偿：`refs/skills-snapshot` 备份 ref（滚动快照链，覆盖 `.agents/skills/` 全量文件），恢复操作见 [TROUBLESHOOTING.md §27](../TROUBLESHOOTING.md)。边界：① symlink 必须相对路径形态——`check_directory_rules.py` 白名单只放行 `../` / `./` 前缀相对 symlink，指向外部绝对路径的 symlink 仍禁（AGENTS.md 规则 13）；② skill 目录自包含义务不变（引用的脚本随 skill 目录存放、禁依赖 `~/.agents/` 全局脚本），但「随 git 跟踪」义务随 untrack 消失（AGENTS.md 规则 14）；③ 回退形态（恢复 git 跟踪）= 删 worktree symlink 后 `git checkout refs/skills-snapshot -- .agents` 检回实体，同批删 `.gitignore` 忽略条目。

### ADR-0092 集成线传播纪律与检查：fix 优先回流 main（2026-09-24）
多条 dev-x.x.x 集成线数周并行下，修复跨线传播不再靠人记，两条纪律：① **fix 优先回流 main**——修复当日 cherry-pick / merge 回 main，不滞留开发线过夜是默认；滞留须自知检查不保证兜底（见下残余类）。② **打包 / 集成合并前跑传播检查**（`scripts/check-line-propagation.mjs`）——硬检查红灯必须消除（merge main）或显式 `--allow-diverged` 一次性越过，红灯静默放行即违纪律。检查两级语义：硬检查 = 目标线 ⊇ main（`git merge-base --is-ancestor main <target>`，挂接常态 = 目标线 worktree 内 `--target HEAD`——目标 worktree 不存在的挂接分支可在源 worktree 内以分支名变量跑，见 dev-merge skill 1.8 步；禁 'main' 等恒绿字面量）；软提示 = 兄弟 dev-* 线触及目标线共享文件的未传播 commit 清单（总量 + 最老停留天数头条 + 明细，无状态恒常呈报、无本地基线文件），裁决粒度 = 线粒度（吸收 / 暂缓），挂接 skill 的执行 agent 须将头条摘要呈报用户后才继续。**残余类诚实声明**：「修复滞留兄弟线、main 与目标线均无」在 git 形态上与正常 WIP 无差别，检查只软提示不保证拦截——该类主防线 = 纪律①。**P6 裁决（2026-09-25 用户确认）**：硬检查维持 block（红灯 exit 1 + 一次性 `--allow-diverged` 越过，越过决定呈报用户）——正常运转下红灯是罕见态（纪律①保证打包线通常 ⊇ main），罕见态多一步显式动作的成本可控，warn 形态会把检查的机器保证退化为提示。登记 C-proc-30。

### ADR-0079 workflow run 资源模型：资源按载体回收 + pi 薄壳随窗口生灭 + 成员会话 name 键复用（2026-09-26 设计裁决）
run 是资源容器，窗口级资源按物理载体回收——统一规则四条：① **pi 引擎薄壳（pi-subagent-cli）per-window**：一个派发窗口（workflow run / chat record 轮次）一个薄壳实例，窗口收尾在 finalizeRun / 轮 idle 收尾链 dispose（复用既有 dispose 请求 + 按进程组终止兜底杀链，孙进程同进程组连带收割）；registry 不再缓存 pi 薄壳跨窗口单例。形态判别 = manifest `taiji.subagentEngine.processModel` 声明字段（`per-window`（缺省，轻壳是常态）| `shared-service`），不进 SDK 任务能力字段（进程形态不是任务能力）。② **zcode 零改动**：zcode 薄壳 + app-server 是懒加载单例（未装引擎包不拉起 / 首次派发才拉起 / 全 taiji 一个，多任务共享），随 taiji 停机链回收——窗口级资源是 app-server 会话对象（每任务自包含 create→run→close），close 即回收，杀薄壳无窗口资源可收只会破坏 app-server 单例。③ **workflow 成员会话 name 键复用**：name = run 内唯一的子代理身份（对齐 zcode 平台语义），同名 `agent()` 调用 = 该身份的续写轮（Continuation 续写 + resume 锚点冷续写，回喂只发增量），round 不参与路由，换名 = 隔离（无 resume 标记参数——zcode 续聊是同名默认语义非显式参数）；成员 record 只有 running / 已结束两态，跑完即结束（现状终态化不变），同名续聊 = revive 把已结束 record 拉起回 running（复用 chat 域 revive/resume 通道语义，2026-09-27 裁决反转 idle 挂起方案），run 收尾对仍在 running 的成员按 run 终态收尾；外部 message 通道对 workflow 成员的域边界拒绝不变（内部复用与外部通道严格分离）。④ **杀链与防御删减（判据：兜底只兜无法预测的物理异常，不掩盖业务 bug）**：D9-2 调用点裁决表①②（run 级回收禁杀薄壳）随共享前提消失而反转删除，killRunTopology / runTopologyKey 定点杀链删除（cancel 收敛窗满与 armed 超时兜底统一改走收尾 dispose）；崩溃重建（CRASH_REBUILD 退避 + respawn 服务同窗口）与握手重试保留（属「无法预测的瞬时故障」类）；**stdout 楔死自愈与 settled-watchdog（会话轮等待两段式守护 30min/600s）删除**——二者防护的场景核定全是 bug 而非物理异常（版本错配已由 C-proc-08 门禁修复、输出管道丢行与 pi 上游 compact 卡死进连带修复清单），进程死亡的正面感知已由 exit 事件事件驱动承担（毫秒级）；删除后「引擎活着但事件不达」的未知场景不再自动回收（人工停止），剩余保护 = 用户显式任务预算。chat 域窗口 = 轮次（轮 idle 即释放，revive 靠 respawn + session 文件冷续写）与 workflow 域窗口 = run（成员续写间歇薄壳保持）的差异合理性：workflow 续写是设计内机械行为（间隔短可预期），chat 续写是用户行为（间隔不可预期）。⑤ **引擎查询范围归属（2026-09-27 裁决，两形态专项评估后定案）**：查询走各自适配包通道、宿主不直读引擎内部存储——pi 适配包内置查询范围（协议分发位已预留，读 pi 数据目录 json、零新依赖，定性可选诊断范围）；zcode 查询走 app-server 协议通道；「pi 库宿主进程」（进程内 AgentSession 派成员）经评估不采用——pi 扩展按一进程一任务假设写成（进程级 env schema 多成员串线 / process.exit 硬杀连带全进程），zcode 引擎自身实态也是新 session + 历史注入冷恢复，实例级续聊无语义增量。上下文膨胀宿主不处理、交引擎自带压缩（2026-09-27 裁决，无降级无换绑）。权威源为 pi-workflow-run-resource-model 设计文档（设计档案已随 .tmp 清理，不入 git；实施记录 git 可追溯）。约束登记随实施批补（域边界约束 C-proc 系新登记 + D9-2 相关注释清扫）。

> **补记（2026-10-13，引擎描述符装配缺陷修复）**：①的形态判别声明曾因发现器装配缺口失效——`buildManifestCliDescriptor` 组装 `descriptor.manifest` 时遗漏 `processModel`（仅条目级 `DiscoveredEngine.processModel` 携带），`engineProcessModelOfDescriptor` 读 `descriptor.manifest?.processModel ?? "per-window"` 把一切 cli 引擎误判 `per-window`：zcode（声明 `shared-service`）chat 直派被只读代理拒答（`engine_window_scoped`），workflow 成员每 run 冷启窗口实例破坏 ② 单例形态。修复 = 装配处同源补进 `processModel`（与 RemoteEngine 快照同值，恒填归一值），条目↔描述符一致性由 `engine-discovery-scan.test.ts` 三态断言兜底；chat 轮窗口键接线（U3）维持不做——shared-service 引擎经透传路径直通单例，U3 剩余场景 = 未来 per-window 非 pi 引擎接入 chat 直派时才需要。

## 前端交互结构

### ADR-0056 / ADR-0057 Composer Staging 双层
模型暂存层（stagingModel/stagingThinking 快照，enter 快照/exit 恢复，getStagingConfig 供 fork/handoff 创建新 session 传 override；优先级 Staging > preset > 默认）+ 行为策略层（StagingAction 接口收敛 enter/exit/send/abort/visual，Composer 经 activeStaging 路由）。落点 `core/domain/composer/dispatch/staging-mode.ts` / `handoff-mode.ts`。

### ADR-0053 SideDrawer per-session 控制态
isOpen/activeTab/docked 三控制态经 useSessionScopedState 按 focusedSessionId 分区；事件驱动的打开对非聚焦 session 只置 pendingOpen 标记，切回时消费——区分「用户手动关闭」与「未看过待提示」。

### ADR-0032 thinkingLevelMap key/value 语义
key = UI 档位（含 max），value = 发 pi 的实际 level（max → xhigh）；可用档位按 key 判定，传 pi 必经 resolveThinkingValue 映射（pi 不认识 max 会 clamp）。实装 `core/domain/composer/thinking-levels.ts`。

### ADR-0050 slash/skill 候选源按 variant 分支（skill 段与 slash 段 skill 项均 = taiji registry）
skill 候选两态统一 taiji 源：globalSkills ∪ projectSkills（location 取 `SkillInfo.sourcePath`），新鲜度由 `config.skillCacheInvalidated` 广播链即时驱动，不依赖 pi reload 往返；panel 态 project skill 的 cwd = sessionStore 派生的 session cwd（landing 维持 `flow.currentCwd`）。slash 段仍走 registry 声明 ∪ pi 真源合并（panel 另注入 compact），panel 态 slash 段的 skill 项**换源保留**（0.10.1 首版「过滤 skill 项、panel 的 skill 段是唯一 skill 入口」的双入口消除二次修订推翻）：pi 真源 skill 命令（reload 才刷新的滞后快照）仍剔除，registry 源 skill 项以 `/skill:<name>` 形态补入（与 landing 单列形态同构、同一追加函数）。行首 `/` 与行中 `/` skill 段双入口共存——跨入口防双插由 selectedSkillNames 已选标记（S-2）承担，不依赖入口裁剪。用户可感知后果两条：①panel `/` 浮层 slash 段列 registry 源 skill 项（首版不列致行首 `/` 肌肉记忆下 session 发起后 skill 不可见，属回归）；②taiji 独有目录（taiji 扫描集含、pi 扫描集不含，如 `~/.taiji/skills`）的 skill 进面板候选与注入，但 pi `/skill:` 命令注册表与 system prompt skills 段不含——模型不可自主调用 taiji 独有 skill（pi 只认自己扫的目录）。扫描集语义差：pi 扫 `cwd/.pi/skills`（taiji project 扫描集已补齐对齐）；taiji 独有目录不反向追齐，属既定语义差。
[2026-09-25 退役延伸] W5 skill 变更→pi reload 编排整体退役：两态 skill 候选与 composer 注入既已全部以 taiji SkillRegistry 为权威源（即时生效），pi 全量 reload（invalidate 扩展 ctx + clearExtensionCache 重建全部扩展，曾致后台任务完成通知在旧模块世界投递失败）在 skill 场景无净收益，触发链删除（reload-orchestrator / promptReload / `/__taiji_reload__`）。pi 侧 `/skill:` 注册表与 system prompt skills 段冻结在 pi spawn 时点（spawn 传 skillPaths 基线不变），新 skill 需新开 session 生效——本 ADR「模型不可自主调用 taiji 独有 skill」的降级扩展为「pi 侧 skill 视图统一滞后到 spawn 时点」。
[2026-09-25 补投机制落点] W5 退役的配套收尾：后台 bash 任务完成通知原为「单次尽力投递」（投递失败永久丢失，曾致 AI 空等已完成的任务）。补投 = 双触发范围（pi 进程构造的 session_start 链 + runtime 激活链 getCommands 发 `/__taiji_bg_reconcile__` 维护命令，per-session 60s 节流）跑同一扫描：registry 严格终态（isTerminalState ∧ exited 时 reason≠killed）∧ 会话无送达痕迹（background-bash 消息）∧ 无补投标记（`background-bash:reconciled` plain entry，appendEntry 同步入账）→ 合并单条 steer 消息 + 同步写标记。幂等三配套（await 兼容规格 / in-flight 单飞检查 / 同步标记）源于两个已核实事实：桌面激活对账 handler 多次派发（startup+resume 双派发）、pi 桥接层丢弃 sendMessage promise。V2-R/V3a/V3b 真机全链 PASS。实现 extensions/universal/base-tool-enhance/src/background/（judgement/pending-reconcile/notify）。

### ADR-0028 / ADR-0029 / ADR-0030（digest）搜索域内聚（0028/0029 部分有效）
多源聚合（命令/文件/会话/recents）收敛于 `core/src/domain/new-task-search/`（search.ts 编排 + match-engine + file-match 单一管线复用于 composer # 与 SearchModal）；mock 反向依赖生产类型，生产类型归 domain types.ts。登记 C-state-07。

### ADR-0054 Browser Drawer 用 WebContentsView
内嵌网页用 WebContentsView（任意 URL + 独立 preload + CDP target），排除 iframe（X-Frame-Options 硬伤）与 webview tag（官方 discouraged）。实装 `apps/electron/main/browser/browser-view-manager.ts`。登记 C-build-06。

[2026-10-04 理由边界修正] 「禁 iframe」的排除理由（依赖 `X-Frame-Options` / CSP `frame-ancestors` 的硬伤）只对**嵌入第三方远程网页**成立——目标站响应头拒绝被嵌。本地 HTML 文件由应用自有 `protocol.handle` 服务、响应不携带这些头，理由不命中；对话流 HTML 产物预览走 `sandbox="allow-scripts"` iframe（无 `allow-same-origin`、文档落 opaque origin、网络出站由内容级 CSP 封死）不在本条禁用范围。边界收窄同批落 `constraints.json` C-build-06 与 [ADR-0118](#adr-0107-对话流-html-预览与产物落点约定2026-10-04-设计裁决chat-html-support)。

### ADR-0066 太极·玄纯灰 V3（唯一现行视觉 ADR）
全族去冷蓝换纯灰（bg/surface/neutral/border 同步），accent 弱蓝灰 `#a5adc2`（见下方补记），状态色保留极弱色相（M/A/D badge 语义辨识下限）。值权威 = `packages/renderer/src/style.css`（暗色默认，亮色 [data-theme=light] 镜像）。视觉演化史见 [docs/design-evolution.md](../design-evolution.md)。

> **补记（2026-10，ui-signal-density D3，用户终裁全局路径）**：玄主题 accent 现值 = 弱蓝灰 `#a5adc2`（OKLCh C 0.0315 / H 269°，对 bg `#131316` 对比 8.26:1），定位为**重新引入弱色相的尝试**——不是对「去冷蓝 = 防色疲劳」的安全论证：冷蓝 `#4f8ef7`（C≈0.15 / H≈220°）的否决理由不变，新值彩度约其 1/5、色相从青蓝转向紫灰，「长时间使用不疲劳」需真实使用反馈验证，设计阶段不可判定。**重审触发条件**：用户报告暗色界面视觉疲劳 / 冷色相不适。届时回退首选 = 锚点专用令牌（`--accent` 回纯灰、新增 `--accent-anchor` 弱蓝灰只挂三处点睛位——侧栏新建任务主按钮、选中会话行、当前导航/活动指示；见 ui-signal-density §3.2 候选 F）。

### ADR-0084 Overview 视图整体移除
用户裁决 Overview（多会话鸟瞰）不应在任何地方存在，全链路删除（组件/路由 view/入口链/i18n/测试）。背景：入口早已收敛（v6 D14 移除 sidebar 按钮，仅 ⌘K 命令面板 go-overview 可达），实态为 v1 骨架无真实用户价值。替代形态：会话切换与统筹由 Sidebar Session List + ⌘K 搜索满足；后台任务可见性由侧栏 Agents/Flows 视图 + 通知体系承担。连带删除唯一消费者 sessionDigest 派生（useSessionDerivations）。

### ADR-0085 TTFT 首字延迟锚点与聚合口径
锚点 = pi `turn_start`（移出 adapter NULL_EVENTS → 新中间事件 `llm-request-start`，逐 LLM 请求 emit；含 context transform/steering 注入段，**不含原生 auto-compaction**（prepareNextTurn 内、先于锚点）与工具执行）；首输出结算 = adapter 单点产 `llm-first-output`（text/thinking/toolcall start 三子类型），**interpreter 侧 delta/tool-call 兜底钩否决**（pi-ai 全部流式实现凡产 delta 必先产 `*_start`，兜底无服务对象且挂最高频路径）；聚合 = **p50 中位数**（延迟重尾，速度口径的加权均值不适用）；存储 = 独立 ttft 日文件单元素组，校验签名参数化（元组长度入参，默认 2 不降既有强度）。已否方案：B 锚 message_start（缺网络段系统性偏小）/ C 锚前端 dispatch（无工具循环锚）。pi 语义前提登记探针 PS-46/47（pi bump 门禁复验）。实装 `runtime/services/session/event-interpreter-gen-stats.ts` + `gen-stats-store.ts`；设计 SSOT `docs/design/composer-genstats-ttft.md`。

### ADR-0070 scheduler widget 推送减频与帧双职责显式接管（2026-09-21 设计裁决）
widget 推送从「每 30s 无条件全量」改为**任务集指纹跳推**（稳定字段 id/name/schedule/kind/enabled/nextRunAt/locale 序列化对比，不变不推；维护不变量：指纹字段集 ⊇ widget 显示决定因素全集）。显示侧**时间呈现整体移除**（用户裁决全砍倒计时/时间呈现）：widget 行文本只含任务名与静态调度描述，TUI 逾期标记、GUI status 逾期翻牌删除，TUI 最近任务选择按 nextRunAt 升序不用 now 过滤；连带清理 = widget 专用 i18n 词条 + widgetStatus 逾期分支（`formatRelativeTime` **保留**——`task.list`/`task.created`/`service.list` 命令层仍消费，`renderTaskLine` 拆分为 widget 静态变体 / 命令变体）；`task.list` 人侧渲染补执行状态摘要补偿失败可见性——widget 显示 = f(稳定字段, locale)，时间流逝不是状态变化，不得触发推送。widget 帧曾意外承载的两个隐藏职责显式接管：①**空闲保活心跳**（入站全帧 touch `lastActivityAt`，30s 帧掩护下 scheduler 会话永不 idle）→ 显式化为「有任务且距上次推送 >10min」的保活底线帧（方案不变量：保活间隔 ≪ idle 回收阈值 ≥3 倍余量；空任务不发——pi 清屏帧同样 touch 心跳，空任务保活 = 空会话永不回收）；②**reload 恢复时机**（现状靠 per-session ring 概率性回放，忙会话冲刷后失源）→ message-bus 中 `extension:widget`/`extension:widgetGui` 改登记 **state 类**（typeKey 载荷派生 per-widgetKey），重订阅经既有 stateSnapshot 段构造性恢复（清屏帧 gui:null 即 last-value；session 销毁随 bus.clearSession 清理；曾考虑 runtime 新建帧缓存 + sendInitialState 补发段，因与 stateSnapshot 重复建设且重连场景被 seqGate drop 而否决）。设计文档 scheduler-widget-push（设计档案已随 .tmp 清理，不入库），实施落点 = u1 extension 侧闭环（静态化+清理+跳推+保活，挂既有 onAfterTick）→ u2 runtime message-bus widget 帧 state 类化 → u3 回归测试。

### ADR-0072 pendingSend 分型清除锚点与 composer 发送布尔契约（2026-09-22 设计裁决，expectTurn 相关边界已由 ADR-0073 交付收敛）
表单假忙修复的语义裁决：`isActive ≡ isGenerating ∨ pendingSend` 的 pendingSend 桥接清除收敛为**分型锚点**——form 通路 ui_response 送达（delivered=true）后仅 cancel 型（result===null：Esc/取消按钮）即时清除；提交型（result≠null）不清，桥接「respond 完成 → message_start」窗口由 turn 事件正常清除（无 turn 期待型经 ADR-0073 expectTurn 声明即时清除）；`requests-invalidated` 广播按 sid 清除（reclaimed/plan-aborted/turn-aborted/session-destroyed 四源）；30s timeout 纯兜底（可观测三要素：上界/自愈/warn——timeout 分支 warn 已去 dev 门（ADR-0073 U5），生产 attach 可见含 sid）。原登记已知边界「无 turn 提交型每提交必命中 30s 兜底 + 源元数据通路未打通（后续候选）」已由 ADR-0073 交付解决（scheduler 提交 91ms 即时清）；剩余常态命中侧 = plain dialog 提交侧已由通路级即时收尾解决（sendPiResponse 应答终局无条件清 pendingSend，生产者穷尽论证：command handler 源结构性无 turn / turn 内源 pendingSend 恒空；落地 98e2aa8b5）；已知失真登记：多步链悬挂期插发直发会被误清（构造上无从区分直发与命令链置位的 pendingSend）——实测 pi 命令 dispatch 即返（void run()），直发被并行处理、message_start 即时到达覆盖，无可见假闲窗口（2026-09-23 验收 O-5）；重审触发 = 用户报告误导操作（保留）。occ-idle 不可作锚的裁决维持（会破坏 ask-user 桥接制造 isActive=false 空窗）。composer 发送布尔契约：`send()` 返回 true = 已投递或输入已可见保留（直发失败乐观气泡亦 true），false = 输入未消费须恢复（仅 B 策略专用）；steer 三早退（空段 / 空白文本 / session 非活跃——非 busy：busy 时 steer 是合法投递路径）返回 false 并 warn（60 字符截断），主链三个 clearInput-first 落点（routeSteer/sendActiveMessage/sendLandingFirstMessage；onSteer 死代码防御对齐为同范式第四落点）统一「快照空 + hasInput 短路不变量」（快照非空失败走 restoreSegments 恢复）。设计文档 form-hang-fix（设计档案已随 .tmp 清理，不入库），实施 = U1 respond 分型锚点 + invalidated 清除 / U2 steer 输入保留三落点。

### ADR-0073 expectTurn 源元数据通路与直发门终态通道（2026-09-22 设计裁决）
表单提交型「是否有 turn 跟随」的判别权归扩展作者显式声明：`uiFormInteract` options 增 `expectTurn?: boolean`（缺省 true 全兼容存量），五段通路 = 声明（scheduler 命令路径传 `expectTurn:false`）→ marker select options JSON 携带 → event-adapter `tryTranslateFormSelect` 单点**条件落键**（仅显式 false 落键、undefined 省键；legacy 归一分支不透传——旧 npm 包结构上不可能携带）→ `ExtensionUIRequest` 加员（`toExtensionUIRequest` typeof 检查）→ respond 分型严格双条件 `result≠null && expectTurn===false → clearPendingSend`（`=== false` 显式判定禁 truthy，undefined 走桥接 = fail-safe；双侧类型检查把脏值挡在帧外走桥接）。效果：/schedule 提交即时收尾（真机 91ms/48ms 两轮实测，不再命中 30s 兜底）；ask-user/plan 桥接零改动。连带裁决：D4a——plain dialog 应答收尾锚点落壳层 transport `sendPiResponse`（**先于 delivered 检查**即 clearPendingSend，cancel/提交/断连三型应答终局统一收尾（ADR-0072 收敛条目）；**两通路相位分叉属有意设计**——form 通路分型锚点在 delivered 之后（`useExtensionUI.respond` 未送达即 return，锚点不可达，未送达期间维持 busy），plain 恒清在 delivered 之前（「意图先于送达」），重审 = 两通路收尾语义统一化提案出现时整体重审，勿单独判其一为 bug；原 ui 队列落点结构性不可达 store，chat-view-deps 反向依赖禁令）；D5——timeout warn 去 dev 门（store timeout 分支恒发；该残余已由 renderer console 落盘管道解决（renderer-console-<date>.log，落地 4f85d2964/7dfe760bf；重开 = 用户 2026-09-22 裁决，30s 兜底 warn 生产可取证——warn/error 级经 main 侧 console-message 监听落盘，排障取 <dataDir>/logs/ 即得））；30s 兜底 timer 保留（语义收窄为真异常回收层）。已知边界：plain dialog 提交侧（/permission 命令族）pi select API 无元数据通道、每次提交命中 30s 兜底的挂着不处理已由通路级即时收尾解决（sendPiResponse 应答终局无条件清 pendingSend——pi select 无元数据位的缺口由通路默认值「无 turn 收尾」绕开，非交互形态迁移：CompanionBand → FormOverlay 方案已否（错层反例：用交互形态重构解决收尾语义缺陷）；论证与已知失真登记见 ADR-0072 收敛条目）；/session-pick 系 tui 注册门源 RPC 模式不可触发。同批终态通道：composer 直发门读 ShellInputInstance expose 的 `getInputElement()`（禁回退 `$el`——dev 构建模板首注释使 `$el` 为注释节点、门恒 false 的 W1 F-1 教训，[HISTORICAL] 固定于 command-popover-keyboard.ts）。实施 = form-submit-busy-convergence 七单元（43ca4df7b…0f1ac2dce）+ F-1 修复 3227df0bd；设计文档 form-submit-busy-convergence（设计档案已随 .tmp 清理，不入库）。

### ADR-0088 settings 域 transport seam 按通道分工（2026-09-25 架构审查裁决）
「settings 域只经 SettingsTransport seam 访问」的边界按**通道**划分而非一刀切：WS 通道（provider/model/skill/agent/system 配置侧）必须进 seam（real/mock 双 adapter 证明）；Electron main 通道（update/proxy/directory 等走 `@/api/domains/settings` IPC 的面）登记豁免，不强行纳入 seam 类型范围——全部收编会把无 mock 需求的 IPC 通道强行套上双 adapter 形态，收益为零。transport.ts 头注即登记处；读到「seam 收敛」时不得把 main 通道二次「收编」进 seam。

### ADR-0089 i18n 文案不作状态判定依据（2026-09-25 架构审查裁决）
任何「按展示文案判定状态/归属」的模式在 locale 切换后失效（文案是运行时渲染值，不是稳定判据）。settings 编辑体动作错误的归属/清除按 source 标签（ActionErrorSource，见 CONTEXT.md 词条）判定；本条为可复用否决条目，其他域出现文案比对模式时按本条否决。

### ADR-0090 seam 与注入通道二选一（2026-09-25 架构审查裁决，反转 W3「ui 依赖一律注入」决议）
方法已在 SettingsTransport seam 上时，ui 包组件直取 seam（ui→core 合法依赖方向），不再经 provide/inject 复刻第二条注入通道——双通道是对同一方法的双轨复刻（假接缝）。本次以删除 `SETTINGS_CONFIG_API_KEY`（detectSources 注入通道）落地；保留的注入 key（SETTINGS_TOAST_KEY/QUOTA_CONFIGURE_FACTORY_KEY/SETTINGS_CHOOSE_DIRECTORY_KEY）承载的是 seam 之外的真实依赖（壳层 toast、工厂装配、Electron dialog），不适用本条。

### ADR-0096 命令/技能获取统一走自研共享能力，禁直用 pi 注册表快照（2026-09-25 审计裁决）
pi 的 `ExtensionAPI.getCommands()` 返回 resource loader 的启动加载集（reload 才刷新的滞后快照，与 ADR-0050 对 pi 真源的定性同族）。裁决：**pi 底层内部逻辑**可用 `getCommands` 之类方法；**本项目代码与全部 extensions** 获取命令/技能一律走自研封装——自研扫描直读磁盘，技能安装即时可见，无需 reload pi 进程。共享能力抽出为独立包（落点 `extensions/shared/` 新包，与 llm-shared / ext-guards 同列；目录扫描 + overrides 语义 + `plan-exec` 类 frontmatter 标记读取 + 名称归一），项目内共用，禁止各扩展自扫目录或直用 pi 注册表形成第二实现。迁移侧：`extensions/universal/plan` 的 `exec-skills.ts`（现自扫四根，作为共享包的实现种子）与 `enter.ts resolveSkills`（现用 `pi.getCommands()` 校验 `--skills`，随共享包落地迁移）。落地义务：共享包实现时补 constraints.json 约束登记 + extension-conventions 规则条目 + `check-extension-dependencies.mjs` 依赖方向校验；pi bump 时共享包的目录/overrides 语义漂移由包内测试对拍真实 pi 行为兜住（登记 pi-semantics 探针）。**消费语义闭环（0926 补）**：自研扫描用于**发现**（表单列出可用技能），执行门禁仍归 pi 注册表——steer 注入前经 resolveSkills（pi.getCommands 校验）确认 pi 实际认得该技能（闭环已存在于 plan enter.ts；共享包落地时此两段语义一并归位：扫描=发现，注册表=执行门禁）。**实施落地（0926）**：共享包 = `extensions/shared/exec-skills/`（`@zhushanwen/pi-exec-skills`，出口：`detectExecSkills` 扫描发现 / `isEnabledByOverrides` overrides 语义 / `hasPlanExecMarker` frontmatter 标记 / `normalizeSkillName`+`resolveSkills` 名称归一与执行门禁）；迁移侧第三落点：plan 包 `command.ts` 的 E1 报错文案可用技能清单 `pi.getCommands()` 枚举（发现语义，与门禁同源），迁移归属批次 4 interactive 单元，随 command.ts 改动范围同批切换。依赖方向校验落地 = `check-extension-dependencies.mjs` 检查项 3 双向校验——反向：包 package.json dependencies/peerDependencies 声明的 `@zhushanwen/*` / `@taiji/*` 包必须登记进 extension-dependencies.json 该条目 dependsOn，漏登记即红（覆盖 extensions/{taiji,universal} 分组包与 extensions/shared/ 库，shared 库缺条目同红）；正向：dependsOn 引用的 workspace 内包必须可解析，悬空引用即红。**重审条件与理由修正（0926 复核）**：pi 实际提供 `ctx.reload()`（agent-session.js:2210——重读 settings、`resourceLoader.reload()` 重扫 skills/prompts/agents 磁盘、重建扩展运行时，**不换 session 文件**）——不是「必须重启 pi 进程」，修正为：**该 API 粒度过粗**——重建整个扩展运行时 = 全部扩展内存态清零（plan 会话分区/工具白名单/挂起交互全打散），为「刷新一个技能列表」付出打散全部挂起交互的代价不可接受。pi 缺的是细粒度资源重扫 API（只刷 skills 注册表、不重建扩展运行时）——pi 提供该类细粒度 API 时，自研扫描整体退役、换回注册表消费。

### ADR-0097 拉为主推补充：数据同步第一原则与域同步协议收敛（2026-09-26 架构裁决）
**拉是真理通道，推是性能提示**——任何数据查询必须返回当前真值（缓存优先、磁盘兜底）；推送允许丢失，丢失后的收敛由协议层统一提供（订阅快照回放 / 重连重放 / 事件边沿拉三路），**功能域代码禁止出现推送补偿逻辑**（域层新增 reconcile/主动拉取/兜底定时器 = constraints 红灯，豁免须登记理由）。背景：plan 审计与项目级推拉诊断实证「推不可靠（R11）+ 拉被做贵（getPlanState 全量解析 + 目录扫描 35ms 地板价）」逼出逐域补偿（renderer 三件套手写 8 处、检查 6 种变体、重连重新拉取 6-8 处）的恶性循环——可靠性必须由通道保证，不得用消费侧补丁偿付。协议收敛：功能域经 `DomainSyncDescriptor` 声明式接入（key + source 参数 + read），数据源（bus-state / rpc / file-derived / memory-registry）是参数，上层不感知底层方案；拉的可靠性与性能是基建义务（缓存优先 + 负缓存 + cursor 增量管线泛化 + 逆序分块冷读 + 结构化可观测），不属于任何功能域。数据分型五类（内存注册表无缓存 / 磁盘推导走增量管线 / 外部配置 mtime 缓存 / 外部服务 TTL / 本地 UI 态不入协议）。已否方案：推送必达化（分布式消息税，重复乱序仍未消）；维持逐域修（恶性循环加码）。保留不推翻：ADR-0049 分区范式、message-bus 三分类（stream/transient 流类不在协议范围）、chat 域帧流形态（天然豁免）。设计 SSOT 为 pull-push-architecture 设计文档（设计档案已随 .tmp 清理，不入库；分波 W0 从根源修复可观测 → W1 性能四刀 → W2 协议收敛 → W3 样板迁移与补偿退役 → W4 散件收编，每波独立可回退）；constraints 检查随 W2 登记。**事件数据直通（D8，ReplicatedState 不变量修订）**：pi `entry_appended` 事件携带完整 entry 直通派生缓存——「事件只做失效」修订为「事件携带数据、多通路共用同一派生/合并函数、拉取是校验与冷启动路径」：handleEntryAppended 透传 entry；事件直通 / getEntries 拉取 / 冷启动全量三条路径喂**同一个**单 entry 增量合并函数（等价性：append-only + 事件序=文件序下，「新 entry 经 parsePlanStateEntry 非空即胜出」≡「逆序取末条」）；拉取降级（冷启动/Entry-not-found 自愈/低频校验），300ms 防抖退役于常态路径；等价性照搬 chat 域模式（applyEntry reducer 双通路 + apply-entry-equivalence 测试防线，规则 9）——三族各建等价性测试。已否：保持「事件只做失效」（丢了再拉的 RPC 往返+防抖延迟是常态税，新鲜度押在拉取必然成功上）；各域自写事件处理逻辑（两条写路径两套逻辑 = live ≡ reload 破裂标准形态）。前置探针：pi 事件 emit 序 = 文件追加序（反证则 D8 整体退回）。
### ADR-0098 subagent 资源引用 = 绝对路径 + 两段式暴露（承接包内 ADR-0001/0002/0003，2026-09-29 收敛）

subagent 体系的资源侧决策三条现状（原记于包内 `extensions/universal/subagent-workflow/docs/adr/`，该目录已按「包内不自建 ADR 目录」规则退役，内容折入本条）：

- **引用形态 = 绝对路径**：`agentRef` / `workflowRef` 统一为绝对路径引用（原 ADR-0002），发现与解析不依赖 cwd；后续实现质量补强（发现对齐 pi skill 的 session 级节奏、M2 改 `appendSystemPrompt` 内容语义并删除 agent/schema 临时文件、`AgentCallOpts` 字段统一、砍 info action、review-fix-loop 启动期 stat fail-fast）见原 ADR-0003 各条，均已落地。
- **暴露机制 = 两段式**（原 ADR-0001）：workflow 侧「结构化参数 + 固定编排」按第一性原理推导（结构化参数是暴露问题的单一根因），subagent 侧参考竞品优化；四家（含 pi-subagent）趋同于两段式而非三段式。
- **决策记录归属**：包内不再自建 ADR / 长期设计文档源（规则见 [extension-conventions.md](../extensions/extension-conventions.md)「决策记录与设计文档归属」）；体系级决策进本文件，包内实现细节进 `docs/architecture/` 或源码注释。

现行载体：[docs/extensions/subagents/architecture.md](../extensions/subagents/architecture.md)（包拓扑 / 协议范围 / 机制落点导航）+ `packages/subagent-core/src/shared/resource-discovery.ts`（7 源同名 last-writer-wins，SSOT）。
### ADR-0076 消息撤回：navigateTree 树内回退 + 系统信令旁路（2026-09-24 设计裁决）

消息撤回能力的机制裁决：**已消费层撤回 = pi `navigateTree(entryId, {summarize:false, label:'taiji:revoked'})` 树内回退**——同 session 文件、append-only、被撤内容移出活跃路径（模型视角从未发生），不 fork 新文件（用户硬约束）；label 参数经 `appendLabelChange` 落 LabelEntry 到文件尾 = 持久化锚（树重放规则 leaf=文件尾，重启/空闲回收后回退不复活；实锚与重验义务登记 pi-semantics PS-60——探针随 pi bump 门禁复验）。**「未注入」层（排队/在途）现状 `delivery.cancel` 两段式收回已覆盖**（价值审核实——设计初版误判为空白，据此砍掉 delivery.revoke 重复 RPC）。**系统信令通道 = dispatcher 新增 `sendSystemCommand` 旁路**：不经 `runBeforeSendHook`（插件 transform 不适用——信令非用户消息）、不经 `registry.submit`（无裸标记尾附/无内核条目/无投递路径 hold），复用 `ensureCommandAvailable` 探测（requireCommand 语义保留）；命令 `__taiji_nav__` 注册于 host-internals 扩展 host-commands 模块（internal host commands 指定宿主，ADR-0008 navigate-tree 桥接命令的形态回归——当时因 runtime 消费方被删而删，本设计即消费方回归；不新建 session-navigator 包，简洁审 Rule of Three 反向命中）。**完成确认 = reply 后 `get_entries` 校验**（`session_tree` 是 extension 进程内专属事件不经 RPC 流——主审 R3 核实，监听方案整族不可行）：从 leafId 沿 parentId 回溯验证「路径不含被撤 entryId 且回溯链终点 === expectedParentId（null 自然终止于根）」，谓词按 entry.id 集合判定（LabelEntry.targetId 陷阱）；expectedParentId 唯一取数点 = 信令前校验（活跃路径须仍含被撤 entryId——防复活性跳转）。**撤回编排七步**：同步临界区（revoking 置位 + 空闲/workflow-running/互斥检查）→ cancel active（草稿抑制）→ 定位 entryId → 清 history-rebuild-cache 与派生态缓存 → 信令前校验 → 信令 + 结果校验 → reply；revoking 为内核 hold 第四判定输入（`piCompactingBlocked` 同型，try/finally 全路径释放硬契约）。RPC 契约 = `session.revokeMessage {sessionId, targetId}`，targetId 为消息 id 原样（live 态 `u-<uuid>` = clientUuid / 基线与重开态 pi entryId——两 id 空间构造性互斥，固定绑定 clientUuid 会使撤回 reply 驱动刷新后的第二次撤回全失效）；定位按形态分派：`u-` 前缀走双通道（富消息 custom entry 映射 / 纯文本裸标记**末尾锚**扫描——纯文本消息无映射 entry（renderer needsBackfill 门控不拼 `u-` 标记 + mapper 只认 `u-` 形态），内核 withDeliveryMarker 全量尾附裸标记保证末尾锚可达；恒尾附构造使末尾锚为精确逆、防内嵌字面误命中），entryId 形态直用；信令前校验幂等化（目标不在活跃路径但全文件存在 → 回 `revoked: true`——reply 丢失重试安全）。连带裁决：history 重建链增加 leafId 活跃路径裁剪（get_entries 返回全文件无过滤，增量路径不裁剪）；**派生面板口径二分准则 =「未来状态随树 / 已发生事实照实」**——注入模型上下文的面必修随树（todo/plan/goal/scheduler 四 extension 重建接活跃路径 + plan/goal/scheduler 须新增 session_tree handler 即时重建、handler 体纯重建两行体禁复刻 plan session_start 的 steer 副作用；model binding 改活跃路径逆读），subagent/workflow/usage 与 session 名照实豁免（run 真实执行过、token 真实消耗过——与工具副作用残留同口径）；SessionRecords 撤回失效契约 = 丢 cursor 强制全量重建（防抖增量通道的 null 保持基线语义会留残影）；**census 义务** = 实施期全仓 session 文件读取点普查（机器锚点 grep `getEntries(` 于 extensions/ 已验证穷尽），按二分准则归类登记 constraints.json 新约束（session 文件读者必须 branch-aware 或显式豁免）；**U8 送达回执重建保留原 id**（结构性前提：回执入流保留提交 clientUuid——现状 appendUser 换新号使 steer/queued 已送达消息 live 窗口撤回入口构造性 miss，reconcile 仅切入/重试触发窗口无界）；workflow running 前置检查（session_tree 触发 subagent-workflow terminateRunningRuns——撤回不得静默杀后台 run）；生成中撤回 = 置灰 + tooltip（自动 abort 待用户拍板）；撤回粒度常态逐条（出站 splitComposed 已把内核合批拆回逐条投递——每条独立 user entry），拆分失败降级形态整批 + 草稿**两层规则**还原（层 1 纯用户合批裸标记切条——段界标记确定性、第 2..N 段剥首个连接产物 + 段尾标记剥除；层 2 一切校验不过形态宁合不裂整条**原样**单草稿不剥标记——mapper 单标记结构使验真锚不可闭环，误剥用户字面 = 内容丢失，宁留可手删字面；分隔符启发式与全文搜索锚均已否决）。已接受代价：旧分支单调累积无清理通道（重审条件 = READ_PRECHECK_MAX_BYTES 阈值）；「撤回 ≠ 抹除」（tee 日志/provider 侧/文件保留，UI 按「模型不再可见」表述）。**版本基线 = pi 0.87.x**（升级独立立项；navigateTree/树重放核心语义实锚登记 pi-semantics PS-60——0.84.4 dist file:line 锚点（session-manager.js `_buildIndex`/`_appendEntry`/`appendLabelChange`/`branch` + agent-session.js `navigateTree` 两步形态）+ 探针 pi-semantics-session-replay.test.ts 代码形态断言，pi bump 经 check-pi-semantics.mjs 版本门禁强制重验，0.87.x 新增 compacting 入口显式拒绝——runtime 前置检查由单保险变双保险；0.87.x 起 pi 自身恢复路径会写 `context_edit` entry 并经 `entry_appended` 跨 RPC 广播，taiji entry 消费链对该类型及 0.85.0 `usage` 类型的处理义务（逐类型裁决 = 不渲染独立气泡、不复算派生视图——raw 树路径视角与 pi UI history 一致，context edits 只在 pi model context 派生视图应用）登记在 U6）。**降级路径登记**：P1（navigateTree 语义）崩塌时退回方案 D——原地截断重写 session 文件（复用 createForkedSessionFile 树回溯）+ `switch_session` 同路径进程内重载（全现役机制，文件保持线性、无 branch-aware 税，代价 = 审计移位 sidecar + 放弃文件内树资产）；context hook 过滤方案维持否决（断层语义 + 压缩摘要泄漏面）。**机制重审触发条件**：pi 将 `appendContextEdit` 暴露到 ExtensionCommandContextActions 或 RPC 命令范围（C-proc-08 版本门禁复验清单登记此项）——pi 0.87.0 原生 `context_edit` 原语（append-only 派生视图剔除，压缩自动遵守）届时严格优于 navigateTree 与方案 D，撤回机制整体重审。实施单元 U2-U8（U1 EventAdapter 翻译随通道事实退役；U8 = 送达回执重建保留原 id）；设计文档 message-revoke（设计档案已随 .tmp 清理，过程产物；两轮完整对抗审查收敛：第一轮六轮 0 must-fix 后用户实质修订基线，第二轮价值审通过 + 三审聚焦复审 r3-r11 收敛，must-fix 轨迹 4→3→5→5→3→1→1→2→2→0——问题逐轮下沉：方案级→登记完整性→派生侧深水区→撤回入口 id 生命周期，全部源码核实后收敛）。

### ADR-0077 投递身份判据形态二分：判定严格、剥除宽松（2026-09-24 架构审查裁决）

`<!--taiji:msg:...-->` 模式串同时服务「投递身份判定」与「标记剥除」，两需求的形态要求相反：**判定要准**——宽松 `[^>]*` 形态曾作为身份判据（原 `BARE_MARKER_RE`），用户文本中字面假标记（如从 transcript 复制的标记）经 rebuild 路径以假 id 重建投递，产生重复投递（现实击中，架构审查 MF-1-1）；**剥除要净**——严格 uuid 形态会漏剥残缺/历史形态标记留下脏文本。**决定**：身份判据（提取/回执对账/rebuild 分派）只允许 `DELIVERY_MARKER_ID_RE`（shared `MSG_ID_TAG_RE` source 派生的严格 uuid 双形态 ∪ 本地收养条目 `m-<base36>-<seq>` 形态，uuid 段禁手写）；宽松形态仅授权剥除面（`stripDeliveryMarkers` / `DEFER_FLUSH_MARKER_RE` 家族）；rebuild 重投另加**出站尾附锚**判据（仅处于**精确文末**的标记构成 rebuild 身份——原文串末尾锚定、不 trimEnd 尾换行，与剥除口径「剥标记不吞尾换行」（P5）同源：出站标记恒尾附，与 `withDeliveryMarker` 写侧同形；文本中部标记字面量走 adopt 收养，不丢弃不重投）。**为什么**：判据分叉的修复成本随调用点增殖上升（难逆）；「同一正则两种形态边界」无上下文会惊讶；收敛后 SSOT 形态变化自动跟随，消灭手写体静默漂移（MF-1-11 同族）。

### ADR-0078 消息协议收敛：分类码定码 + 中止独立帧 + 非终结呈现通道 + respawn 发布点统一（2026-09-25 消息链路去冗余裁决）

四项协议收敛终态（错误判别契约：instanceof 错误类 + 分类码词表，废除文案前缀匹配与时序推断）：

1. **分类码词表 shared 单点**：`CompactErrorCode`（`compact_busy` = dispatcher compact busy 预检拒绝 / `compact_failed` = pi 层执行失败）与 `SendPromptReason`（`'command-missing' | 'hook-blocked' | 'error'`）均定义于 `packages/shared/src/protocol.ts` / `message.ts`，消费方一律 import——五处手写词表收敛单点。SendPromptReason 的 busy/compacting/bash 退役值删除：投递所有权内核「排队取代拒绝」后运行侧只产三值；收窄裁决非 breaking（plugin-sdk `private:true` 不发布 npm、词表非外部契约范围 + 运行侧只消费 blocked/rejected 布尔、reason 是诊断/文案侧 + 仓内零处退役值比较）。WS 广播 `send.rejected`（'busy' | 'compacting' | 'processing'）保留——bash 通道 busy 预检的防御反馈词表，不经 SendPromptReason。
2. **bash 中止走独立 `message.bashAborted` 帧**：中止是终态不是错误——UI 呈现「已取消」中性形态（statusTag 中性色，非 text-danger），协议回执 `message.status{aborted}` + bashResult `cancelled:true`；不经 message.error 误导终局。
3. **非终结反馈通道 = `message.stream_warn`**：busy 拒绝（compact busy 预检）等非终结提示经 stream_warn 内联进对话流（turn 内 notice，不切断 turn 分组、不触发错误终局；`message.error` 保留给真错误——错误作为 assistant 消息插入对话流的规则不变）；分类错误的 toast 呈现标志已删（呈现职责归对话流）。
4. **respawn 恢复发布点统一（D3）**：`session.restored` 发布锚 = `SessionService.restoreSession` facade 成功尾部（四入口拓扑全汇合点：attemptRespawn timer / ensureActive 惰性 / 手动 RPC / startup-reattach；三信号判别态在 pi-respawn 编排器，经 `onRestoreSuccess` 单点调用），经编排上下文判别 + 三信号（pendingTimers 在册 / attemptInFlight / 失败计数>0）判别发布——恢复一次成型恰好一帧，删除「惰性路径成功不发 / 经编排器路径发」的双点不对称；普通懒 spawn（进程存活首启）构造性排除（三信号皆零 miss）。renderer 恢复窗口订阅 / respawnPending 分区 / respawn TTL 拣回保留（非冗余：帧丢失与 bus 订阅生命周期的独立防线）。已知判据残余洞（attempt 让位裸 return 不置标志 → 跨 fire 子态三信号皆 miss）登记 D7-41，兜底靠保留的 message_start gate（真机验证：该子态无 restored 帧、gate 恰好 1 条提示条收尾、不落 dead 终态页）。

**发布配套义务**：`@zhushanwen/session-delivery` 0.10.1→0.11.0（DeliverySubmitOptions.receiptAnchor 增补 + port `hasPendingMessages` / DeliveryConfig `busyPolicy` 拆除；0.x 阶段 minor 位表 breaking）；npm 发布时 `@zhushanwen/pi-subagent-workflow` 消费方同批配套发版（notifier-receipt-anchor 行为锁依赖 0.11.0 语义）。

**D7 延后登记表收编**（15 项 = 投递审计 13 项 + 本设计新增 D7-40/41；每项 = 触发条件满足才启动，不预付任何实现）：

| # | 延后项 | 触发条件 | 触发后去向 |
|---|--------|---------|-----------|
| D7-27/28 | followUp 双键分流幻影语义 + DeliveryIntent 'after-run' 透传链 | 产品裁决：恢复 intent 载体兑现双键语义 vs 承认同义删分流 | A → 独立设计补 intent 语义链；B → 纯删除 |
| D7-29 | 投递确认②计数兜底 → per-id 挂着不处理 | R2-b04-3 dev 观测数据到位 | 与 33 合并契约专项 |
| D7-30 | TurnRenderCache 尾部快路径 + redrive 路径 | 一次真机测量（三路径 vs fullRescan 帧耗时对比） | 数据证收益才保留，否则删 |
| D7-31 | readers.ts 11 函数容差层 | 协议 W05-W07 收紧 wave | 帧类型收紧后退场 |
| D7-32 | mergeBaselineWithLive 判据②③ 内容启发式 | wire Message 透出 clientUuid | 启发式收窄为兜底 |
| D7-33 | splitComposed 合批拆批 → port 逐条投递契约 | 与 29 合并的「内核↔适配层契约收敛」专项立项 | ADR-0074 acceptance 口径被 per-id 回执替代 |
| D7-34 | notifyHoldRelease 手动边沿义务散落 | occupancy 原语加边沿回调的跨模块设计 | 3 手动点收敛 |
| D7-35 | 9 个 *_unsupported 防御码家族 | 惯例一致性裁决（缺服务码 vs 必选注入） | 统一其一 |
| D7-36 | host-internals msg-id-mapper 模块双标记载体 | 登记决策裁决（收敛方向：backfill 改派生/写侧退役/读侧兼容） | 按裁决执行 |
| D7-37 | morph 段 TTL（R2-b04-4 防泄漏兜底，core 模块级 Map 双侧惰性清扫） | delivery 条目作废生命周期事件挂钩改造立项（事件挂钩后 TTL 降级为兜底或删除） | 与 respawn 恢复事件零耦合，非同根源，独立立项 |
| D7-38 | 双 30s watchdog flush 半边冗余（内核 delivery.ts watchdogMs 30_000 flush 复核 vs registry 对账/补投/唤醒周期器） | session-delivery 域下次改动顺带核实双周期器对象异同（路径 A 收官未顺手执行，疑非冗余） | 确冗余删半边，非冗余本条注销 |
| D7-39 | gap 判定泄漏 ring 内部知识 | bus.subscribe 返回侧扩 oldestSeq/gap 的协议变更窗口 | 随协议 wave |
| D7-40 | ui↔renderer 镜像族收编 @taiji/shared（镜像检查生效后的正式收编） | 下次 renderer 域改动立项时顺带 | 3 处镜像归 shared 单份，防御测试删除 |
| D7-41 | 惰性恢复跨 timer fire 子态发帧（attempt 让位裸 return 不置标志 → 三信号皆 miss；根治 = 第四信号或让位路径 join+标志改造，需裁决 join 失败记账归属） | 该格 UX 表现退化——症状锚点 = 活 session 回落 dead 终态页需手动解锁，或下次 respawn 域专项 | 判据封闭或收尾机制重构 |

### ADR-0115 窗口外壳 mimic_mac 形态维持（issue #24 复核 reaffirm，2026-10-01）
GitHub issue #24（Windows 10 窗口外壳四问题）复核结论：用户抱怨全部指向 win/linux 自绘路径的实现缺陷（悬停圆点消失、16px 图标溢出 12px 圆点、侧栏顶部不可拖拽、四角色差方块、默认尺寸不看屏幕），无一条指向「自绘彩色圆点放左侧模拟 mac」的形态本身——无推翻既定裁决的新证据，mimic_mac 维持（三平台左上视觉统一，数值 SSOT = [DESIGN.md §11](../DESIGN.md)）。窗口控制按钮改为各平台原生风格的方案不采用（三平台视觉从此分裂，破坏「跨平台同一工作台」气质）。实现缺陷已在同批修复：悬停同色覆盖 + 8px 图标锁定 + 非 mac 顶部拖拽条带（DESIGN.md §11 增补段）。

### ADR-0116 窗口圆角策略：应用内圆角仅 mac，不加窗口配置键（2026-10-01）
三平台窗口圆角策略定案：mac = 系统圆角 + AppShell 根节点 `rounded-[10px]` 保留；Windows 11 = 无边框窗口系统默认圆角（Electron `roundedCorners` 默认值即 `true`，实装依据 electron.d.ts 平台标注 darwin/win32）；Windows 10 与 Linux = 方角（OS 能力边界）。应用内圆角仅 mac 渲染（AppShell 根节点 setup 期 `detectPlatform()` 类绑定，非 CSS 选择器分支——避免非 mac 首次渲染 rounded 闪现，且组件测试可断言）；非 mac 四角与窗口内容同色，色差方块随应用内圆角关闭而消除。两条不采用登记防复发：① **显式声明 `roundedCorners: true`**——默认值即 `true`，显式化行为增量为零（Win11 本就圆角、Win10 键无效果、Linux 键不适用），零收益纯维护成本；② **透明窗口统一圆角**（`transparent: true`）——丢失系统贴边吸附与阴影、部分 Linux 合成器直接失效，为视觉细节引入 P0 级窗口行为风险。

### ADR-0117 窗口尺寸持久化三字段裁决：{width, height, isMaximized}、仅主窗口、close 同步 flush（2026-10-01）
非 mac 平台的窗口尺寸持久化（`<getDataDir()>/window-state.json`）字段恰三件 `{width, height, isMaximized}`，四条语义裁决：① **位置（x,y）不持久化**——窗口由 Electron 默认居中放置；已接受代价：多显示器用户重启后窗口回主屏居中、不记忆用户摆放位置（位置记忆引入恢复错位问题家族——副屏拔除后窗口开在不可见区域、「相交不足一半丢弃」的阈值裁决、恢复归属歧义，收益与证据不匹配；重审触发 = 用户反馈不可忍受）。② **仅主窗口写者**——只有 bootstrap 创建的主窗口挂持久化监听与启动恢复（`isMainWindow` 门标志），create-window IPC 迁移窗口不读不挂，持久化文件全局单写者，多窗口 last-writer-wins 互踩结构性消除。③ **close 同步 flush**——关闭事件取消防抖定时器立即落盘，`isMaximized` 取退出时刻窗口实际值：「最大化→直接关闭」序列下最大化期间跳过写、无防抖数据，须以退出时刻状态落 `isMaximized: true`，重启才能按正常态尺寸 show 后恢复最大化，同时消除防抖窗口的退出竞态。④ **最大化/全屏态跳过防抖写**——字段恒记最近一次正常态尺寸；resize/move 防抖 500ms 合并写；启动读取损坏/字段非法 → 丢弃回默认尺寸 + warn 日志（不阻断启动），合法值 clamp 到当前工作区后生效。实装 `apps/electron/main/window/window-state.ts`（不 import electron，窗口经最小结构接口注入；tmp+rename 原子写）。默认尺寸公式（主屏工作区 62%/75%、cap 1440×960、下限 800×600）与 darwin 分支恒 1200×800 的零改动边界同属本条裁决，数值权威 = [DESIGN.md §11](../DESIGN.md)。

### ADR-0120 远程访问凭据走跨进程文件热读，开启信号走 argv flag（2026-10-03 用户裁决登记）

**决策**：远程访问（手机浏览器经局域网直连 runtime，词条见 [CONTEXT.md](../CONTEXT.md)）三个通道裁决：

1. **remote token 凭据通道 = `<dataDir>/remote-access.json`（0600）跨进程文件**：main 是唯一写者（`apps/electron/main/remote-access/store.ts`，原子写 = 同目录 tmp + fsync + renameSync，防读侧撕裂），runtime **每次 WS auth 握手时读文件取当前值**（`packages/runtime/src/infra/remote-access.ts` 的 `readRemoteAccessToken`，由组合根以 `remoteTokenProvider` 注入，关态不装配零 IO）——token 轮换 = main 重写文件即生效，不重启 runtime、不中断在途 turn；文件缺失/损坏 → remote 凭据成员为空、退化为仅 spawn token 可认证（fail-closed）+ 频控日志（同因首次响亮含恢复指引，读取成功即重置）。
2. **开启信号 = argv flag `--remote-access`（配套 `--mobile-dist=<path>`），新增 env 键 = 0**：listen host（`127.0.0.1` / `0.0.0.0`）是启动期一次性决策，supervisor 按 `remote-access.json` 的 enabled 在 spawn 时现读拼参（非快照）；argv 不经环境变量继承链——scripts 直跑、验证脚本、vitest e2e 池等非 supervisor 启动路径不传 flag 即天然关态，构造性免疫、无需任何剥除机制。
3. **shape 判据单源 = shared**（`packages/shared/src/remote-access.ts` 的 `isRemoteAccessConfigShape` / `REMOTE_TOKEN_HEX64` / `REMOTE_ACCESS_FILENAME`）；main 写侧从严（hex + createdAt 全验）、runtime 读侧从宽（enabled=false 早退跳过 hex）的不对称是文档化刻意差异，不上收、不参数化。

**依据**：① env 注入 remote token 不可行——env 在 spawn 时固化，「轮换即时生效」与「桌面无感（重启 runtime 会杀 pi 进程树、中断在途 turn）」不可兼得：轮换触发重启则杀在途 turn，不重启则 runtime 持有旧值永不刷新；文件热读使「轮换 = 写文件」由构造成立。② env 开启信号不可行——关态剥除只挂 supervisor spawn 一路，仓内存在多条直跑 runtime 的启动路径（`validate-runtime-bundle.sh`、verify-ws-auth 等验证脚本、e2e 池），任何一条漏剥即 fail-open（LAN 监听面）；argv 判据让该整族路径不传 flag 即关态，无需逐路径设防。③ main/runtime 共享 dataDir 是既有架构约定（`resolveRuntimeToken` 读 `<dataDir>/runtime-token` 同通道先例）；auth 是低频事件（每连接一次），每握手读 4KB 文件成本可忽略。④ 轮换不踢存量已认证连接（auth 只门禁握手是现状语义）——「怀疑泄漏」的完整处置 = 面板轮换（断新接入）+ 关开开关（重启 runtime 踢全部存量连接），登记于 CONTEXT.md「remote token」词条。

**登记**：契约 SSOT = `packages/shared/src/remote-access.ts`；配置侧 = `apps/electron/main/remote-access/`（写侧）与 `packages/runtime/src/transport/connection-manager.ts`（读侧鉴权消费）；无新约束族、无新增机器检查——fail-closed 语义由 connection-manager 单测锁定（E5 dist 探测 / E10 损坏重建处置单测在位）。设计过程产物 remote-use-mobile（已随 .tmp 清理，不入库、git 不可追溯），本条为通道裁决的权威登记处。

## 已否谱系（决策已过时/被推翻，一行注记防重新发现旧坑）



- **ADR-0008** navigate-tree 桥接命令——命令已删，桥接形态被 marker 通道取代。
- **ADR-0015** statusline plugin 封装（`plugin:statusBarUpdate` 通道）——随 StatusBar 底栏整体退役（ADR-0141），通道、registry 与 builtin statusline 插件已删。
- **ADR-0019 / ADR-0022** 冷蓝暗色视觉方向——被 ADR-0066 太极纯灰推翻。
- **ADR-0023** Overview 入口 = sidebar 按钮 + ⌘⇧O——v6 D14 nav 重构移除入口按钮，⌘⇧O 未绑；go-overview 仅经 SearchModal 可达。
- **ADR-0045** 自研虚拟滚动不引入库——决策反转：MessageStream 已切 virtua/vue `<Virtualizer>`（cw wave w3）。
- **ADR-0003**（digest）translate 宽类型——被 ADR-0037 真契约窄类型取代。
- **ADR-0007**（digest）git submodule 管理依赖——被 ADR-0011 打包内置取代。
- **ADR-0017**（digest）traffic light safe-zone v2——数值 SSOT 现为 DESIGN.md §11。
- **ADR-0061**（digest）cw store repo 级键控——被 coding-workflow 仓库方案取代。

### ADR-0086 项目 skill 实体迁 workspace 根，脱离 git 分支版本化（2026-09-25 设计裁决）
`.agents`（42 skills + workflows）不再被 git 跟踪：实体唯一一份放 workspace 根 `<workspace>/.agents/`（非 git 仓库），各 worktree 经 symlink `../.agents` 共享——任一现场改动全部 worktree 实时生效，构造性消除「skill 随分支版本化 vs 横切工具需要恒定」的根因冲突。**判据裁决（两刀）**：刀一 = 开发阶段工具 vs 产品能力（scripts/.githooks/CI 实测整体属开发工具——产品运行时源码零引用）；刀二 = 在不在代码变更传播链上——检查/测试/构建/CI 被代码变更强制拉动（拉不动 = 假红/假绿/构建崩），必须版本化锁同代、随分支流动是正确语义；skill 对代码只有操作入口引用，不同步的失效温和、可见、有人工裁决缓冲，可独立版本化。`.agents` 是唯一刀一链外 + 刀二链外 + 发现层 symlink 友好的资产（`.zcode/agents/` 过两刀但 host 桌面 app agent 发现 root lstat 零容忍，维持现状；`.githooks`/`scripts`/`.github` 卡刀二——各分支检查与该分支代码配套，统一刷平 = 2026-09-11 [HISTORICAL] 事故形态复刻，实测 8 个活工作线各领先 dev-0.10.5 17–58 commits，故不做全量基底刷平，检查/快照配套仅落活跃分支随 merge 自然传播）。**配套**：备份 = `refs/skills-snapshot` 快照 ref（`.githooks/snapshot-skills.sh`：临时 index + commit-tree 不碰工作树，空树防御防好快照被覆盖，push 超时降级链 timeout→perl→跳过，remote 自适应 github/origin）；pre-commit 第 0 段 = symlink 三分支判定（常态跳过 / 缺失幂等补建 / 真实目录等异态停手指引，bisect/detached 专用指引禁 merge）；CI（invariants + test-extensions 两 job）从 snapshot ref 物化 `.agents` 后再跑检查读点（snapshot 缺失 fail-fast 给指引）；git-cwt setup-worktree.sh 加部署段（补建/跳过/未迁移分支保留真实目录）。实体初版构成 = dev-0.10.5 侧全量 + main 侧 pi 内置版 pr-lifecycle（用户裁决 main 为最终版）− 退役 zsw 版 `.agents/workflows/pr-lifecycle.js`。已知形态：检出未迁移 ref/tag（v0.10.4 等）时 git 静默把 symlink 替换为旧内容真实目录——第 0 段③停手指引（该分支先落迁移 commit 或确认丢弃重建）。设计 SSOT 为 cross-worktree-skill-sync 设计文档（设计档案已随 .tmp 清理，不入库）；迁移 commit = 2133009f9（dev-0.10.5 试点）等 8 分支。

### ADR-0093 workflow 步骤视图数据源 = runtime 合并派生视图（2026-09-25 设计裁决）
WorkflowTab 步骤列表的数据源绑定从「workflow-record 全量快照（60s 节流持久化通道）」改为 runtime 合并派生视图：① workflow-record 供编排结构（trace 骨架：stepIndex/phase/agent）× ② subagent-record 供运行状态（迁移即写无节流），关联键 = (parentRunId, stepIndex)，在 runtime 派生缓存层合并（`packages/runtime/src/services/session/workflow-step-merge.ts`，冷热路径共用同一纯函数、单次解析两遍内存扫描）——步骤实时性不再寄生持久化通道（9.5-12.2 分钟盲区根因消除，真机实测 64-324ms 出现）。关键裁决：两态→四态映射矩阵 13 值域全覆盖——**gc 按写侧 D7 例外族语义分叉**（workflow origin 成功/失败 settle 均写 gc、由 error 区分：空→completed、非空→failed，同 `deriveOutcome` truthy 判定同构），中断族三值→failed+原文，cancelled→failed+文案，不产出第五态；一键多 record 收敛 = running 优先 + startedAt tiebreak（重试链退避窗口显示 failed 是真实状态）；无 stepIndex 的 record 不成行（旧 session 回落 trace-only）；水位维度增终态计数（settledSteps）驱动 workflowUpdate；renderer 拉取收敛（per-session in-flight 合并 + 可再武装 dirty 补充拉取，`stores/workflow.ts`）为**过渡层**——根治形态 = workflowUpdate 直接携带合并派生视图全量帧（独立优化紧随立项，落地后过渡层整体退役）。run 级徽标权威仍归 ①（接受「步骤全终态而 run 仍 running」≤60s 窗口，不新增第三状态词表）。schema additive 纪律：SubagentRecordEntryData / ExecutionRecord / SubagentRecord / RecordBinding 四型增可选 `stepIndex`（零迁移：旧 entry 读取归一 undefined + 序列化字节层负向单测锚定；constraints 机器检查评估结论 = 不登记，单测锚定足够）。设计文档 workflow-step-visibility-data-source（设计档案已随 .tmp 清理，不入库）；实施 = W0 四单元 + 验收缺陷修复（25410fac4 / c3cb48854 / 8e4afe05f / cb254b427 / ce0ab4e5d）。

### ADR-0099 resume 只复用已提交结果，删除从子代理会话日志复用结果的通道（2026-09-30 用户裁决）
**决策**：崩溃恢复只保留两种形态——① 该调用已有已提交结果（record 流里那条 `agent-settled`）→ 原样回放、零成本；② 没有 → 重跑（能定位到同一成员会话则续写，定位不到则重开）。删除「从子代理会话文件里把已跑完但结果未提交的结果捞回来复用」这条通道（原三档设计的档 1 补收）：`packages/subagent-core/src/orchestration/resume-run.ts` 的 `classifyResumeTierFromContent`（抽取末尾正文）、`dispatchTierCollectFrames`（合成补收用的 `agent-settled` 事件）、`planResumeTiers` 里按子代理名字取会话文件的部分，以及由它派生的时间下界、跨库身份查询、按契约判档、契约未知分支、原因枚举一并作废；`run-resumed` 的档位词由 `collect(tier-1)/continue(tier-2)/restart(tier-3)` 收敛为 `continue(tier-2)/restart(tier-3)`，档位判据换为「能否定位到该调用所属的成员会话」——定位口径沿用既有成员复用通道（`agent-started` 载荷的 `memberRecordId` + member-reuse-pool 查询），该通道自身的定位精度不在本条射程内。本条只约束**结果的来源**：交给脚本的结果必须来自已提交的调用结果；它不禁止任何功能读取子代理会话文件（读本身无害，被禁止的是把会话文件的内容当作某次调用的权威结果）。

**依据**：① 不变式判据——交给脚本的结果必须来自一次已提交的调用结果；满足它时，结果形态、归属、轮次、并发、数据格式漂移全部无需判断（这些难点只在「复用一份未提交的东西」时才出现）。② 读侧方案无法自洽：2026-09-30 两轮业务用例走查（核心组 + 边界组，独立 subagent）共查出 9 条缺口，形态是「每补一处就冒出新的前置」——按名字取会话文件 → 归属不可证（可能把别的调用甚至上一轮的对象交给脚本）→ 补「文件内自证」→ 自证不足需时间下界 → 时间下界之外仍需调用身份 → 身份查询又依赖源码注释自陈「重启后可能回落 undefined」的字段；首次派发即中断的场景则结构性取不到文件（现有测试必须预置一条同名已落定记录才能构造档 1 / 档 2）。③ 需求证据为零：本机可得的全部 run 记录 7 份 / 23 次调用中，未完成调用 0 个、`run-resumed` 0 次（有 1 次 run-interrupted，当时其调用已全部落定）。样本小（7 份，且记录会被清理）不构成「不会发生」的证明，但足以说明该能力目前由设计推演驱动而非需求驱动。④ 减法优先：删除后恢复链的判据只剩「有没有已提交结果」与「成员会话能不能定位」两条，不再解析对话日志。

**修订关系**：[ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 的 D1–D16 其余内容不变，被修订的是 resume 对「未提交结果」的处置。不采用的读侧方案与其两轮走查证据留档在不入库的过程产物 resume-tier1-structured-result（已随 .tmp 清理，git 不可追溯），故本条为决策的权威登记处。

**条件性重审**：若「崩溃后零成本恢复」被判定为产品级要求（长任务、token 成本高的场景），唯一正确形态是写侧携带身份——调用在派发时记下它启动了哪个成员（`agent-started` 载荷补成员记录 id，或把成员登记提前到该事件写入之前），提交时带上本次调用的身份，使「哪次提交属于哪次调用」成为记录读取而非事后推断；届时应另立 ADR 与设计，不在读侧续补。

**登记**：未新增约束族，也未新增机器检查（本条为能力删除与语义收敛，事件词表与载荷形态不变；「结果只能来自已提交结果」由恢复链的实现形态承载——判据只剩「有没有 `agent-settled`」，没有第二条取结果的通路可走）。带 schema 的调用「必须给对象、否则报错」的义务**不在本层**：它已由引擎契约承载（pi 引擎 `collectOutcome` 在 `schemaExpected` 且无有效对象时强制失败并填 error；emulated 引擎失败走 `schema_emulation_failed`；义务登记见 [engine-development-guide.md](../extensions/subagents/engine-development-guide.md) §「schema 分流义务」），宿主侧不再加一层——引擎违契约应在引擎侧暴露，宿主补丁会把边界故障掩盖成正常回落。

### ADR-0100 引擎路由不换目标：显式指定即严格 + 不可用显式失败（2026-09-30 用户裁决）
**决策**：一次 subagent 派发选哪个引擎，只由三层路由决定——调用参数 `engine` > agent .md frontmatter `engine` > 全局 config.json `defaultEngine`，三层全缺落内置缺省 `pi`；三层任一指定了引擎，运行期就按该引擎执行，**不换目标**。不可用一律以结构化错误显式失败：id 未注册（含 `defaultEngine` 指向已卸载引擎）→ `engine_not_found`（列已发现引擎 + 配置路径 + 安装指引）；probe 失败 → `engine_probe_failed`（逐项 check 摘要 + 恢复指引）；全局 config.json 存在但读不出来（坏 JSON / 权限）→ 派发前拒 `engine_config_unreadable`（缺省引擎是未知量，不按内置缺省 pi 执行；文件不存在仍是合法缺省）。要换引擎只能由调用方显式改传 `engine:'<id>'`。`EngineRouteResult` 只承载实际执行的引擎 id 与生效层，不存在「换了目标」的第二种值；`engineFallback` 留痕字段与 `engineRouting.strict` 配置项不存在。

**依据**：① 静默换引擎等于替调用方改写意图——沙箱类任务被静默卸除安全能力、显式 model 与引擎 provider 的绑定被打破；② 「显式指定」与「该引擎不可用」是两个独立事实，后者不改变前者——把不可用降级为「换个引擎跑」会让失败不可见，用户在非预期引擎上拿到结果；③ 引擎清单与 manifest 在派发前同步可得，不可用应前置暴露并给恢复指引，宽容回落面没有服务对象。

**登记**：设计规格权威源 [subagent-engine-protocolization.md](../architecture/subagent-engine-protocolization.md) §3.8 D4；约束 C-ext-16 描述随本裁决更新（entry 不因路由回落增 engine 系字段）；未新增约束族。

### ADR-0101 worker 诊断日志入 record 流：errorLogs 重启后可重建（2026-09-30 用户裁决）
**决策**：run 事件词表新增 `worker-log` 帧（载荷 `entry: {level, message}`）。worker 的 `console.*` 捕获与主线程 log 消息在追加 `run.state.errorLogs` 的同时**写入 journal 记录**，journal 记录唯一写点 = `orchestration/terminal-actions.ts` 的 `appendRunDiagnosticEvent`（journal append 的单写者纪律不变：pump 经它写，不自己 append）。重建侧 = `orchestration/run-events.ts` 的 `errorLogsFromEvents(events)`（按事件序追加 + `slice(-MAX_ERROR_LOGS)` 尾部裁剪，与活体写入同语义），壳 `jsonl-run-store.ts` 的三个重建点由「`errorLogs: []`」改用该函数。journal 写入为 **best-effort**：写失败只 warn 留痕，不影响 run 生命周期（活体 errorLogs 已在内存，重建侧少几条不改变终局语义）。

`worker-log` **不进生命周期状态机**：`foldRunEventCheckpoint` 显式跳过该事件（并推进 seq 水位），故不占 `RUN_MACHINE` 表行。

**依据**：① 诊断日志的价值集中在「run 崩了/失败了之后」——重启即空等于在最需要现场时没有现场（此前 errorLogs 无任何持久化侧）。② 刻意不进状态机：诊断范围与状态侧正交，若让它走 `transition`，run 终局后迟到的诊断日志会撞上「terminal 是吸收态、任何事件 fail-fast」而把 fold 判成坏帧，进而丢掉后续判读；不占表行也避免把诊断事件写进转移表这份状态机权威。③ 单写者纪律保持：journal 写入仍在 terminal-actions 内，pump 只经函数调用触达。④ 体量可控：`MAX_ERROR_LOGS` = 500 条上限，实测 run journal 每 run 2-20 条量级，诊断帧随 run 生命周期同清理（统一保留维护轮）。

**登记**：事件词表 `RUN_EVENT_TYPES` 由 9 增至 10（journal 事件；控制事件词表不变），`WorkflowRunEvent` 联合新增 `WorkerLogEvent`。无新约束族；机器检查范围 = run-events 的词表/转移表穷尽测试（新增样本）+ 本条的诊断帧折叠与重建单测（core）+ 壳重建单测。

### ADR-0102 run 侧 v1 读侧整体删除（2026-09-30 用户裁决，承 ADR-0094 同款裁决的延伸）
**决策**：workflow run 侧（workflow-record）的 v1 兼容读侧整体删除——record 侧 v1 兼容层已按「项目未上线、无 v1 数据，不迁移不兼容」裁决先行删除（ADR-0094 v1 删除补记），run 侧残留读侧按同款裁决收敛为 v2-only。删除范围四项：① session-reader 发现链收敛单档（`discovery/workflows.ts`——删 workflow-record v1 全量快照档、workflow-state-link 旧指针档与 wf-state 快照解析族 `extractCallSessionFiles`，只认 v2 注册条目的 recordPath 锚点）；② runtime `workflow-extractor.ts` 删 v1 快照条目扫描与 legacy 双管线（workflow-state-link 指针 + state 文件派生视图），文件收缩为 session-file-extraction 共享骨架的消费壳，records 恒空——runtime workflow 列表唯一数据源 = events-projection 的 record 流 fold + v2 注册/终态条目；③ core `run-snapshot.ts`（`SNAPSHOT_VERSION` 快照行版本常量，写侧死后仅存读侧残件）整文件删除，barrel 导出移除；④ 跨包契约测试同批收敛（runtime 三文件删除/重写、session-reader 两文件收敛单档、core `SNAPSHOT_VERSION` 值锁定测试删除）。

**旧格式语义**：历史格式条目（v1 全量快照 entry / workflow-state-link 指针 entry / wf-state 快照行）不识别、不拒读、不报错——静默从各读侧消失（发现链不产 runId、列表不显示、resume 一律拒绝），是历史数据处置的预期行为（不迁移、不兼容、不主动清盘文件）。session-reader 的 `readRunSnapshot` 保留（tool-handler workflow 概览快照链仍有 import；发现链收敛 v2 后该链对 v2 档不可达，随该文件后续批次清理）。

**登记**：壳 `jsonl-run-store.ts` 注释措辞同批终态化（v1 行静默消失 = 设计预期）；壳 `session-lifecycle.ts` 的 link 条目读侧不在本批领地、另行批次收敛；无新约束族（数据处置口径承 ADR-0094 系）。

### ADR-0104 workflow 可视化入口语义分立：openWorkflow 改向 overlay + openWorkflowInDrawer 显式 drawer 语义（2026-10-02 设计裁决，workflow-visualization D1）
**决策**：「看 workflow」的入口从「切 drawer 到 workflow tab」改为「打开全屏 overlay」，入口函数语义分立为两个，同一函数不承担两种语义：① `openWorkflow`（`packages/core/src/domain/drawer/coordination.ts`）改向为开 overlay——汇聚点单点改向，托盘 workflow 行零改动（已传 runId）；未绑定 overlay opener 时 no-op（headless/测试安全默认，不触达 drawer）。② 新增显式 drawer 语义函数 `openWorkflowInDrawer`（= 原 openWorkflow 实现的移位保留：setWorkflowView 三步——切 workflow tab + 记录选中名 + 开 drawer），供 overlay 装载失败回落链（Guard 捕获后 openDrawerTab + openWorkflowInDrawer 注入选中态，不得经改向后的 openWorkflow，否则重入 overlay 入口）与 SubagentTab 返回按钮直调；形参双语义（收 workflowName 或 runId，由 WorkflowTab「先 runId 精确匹配、后 scriptName 取最新」兼收解析）。配套：对话流 workflow block 从只传脚本 name 改为以 (scriptName, slug) 经 workflowStore 反查 runId（slug 缺失回落「name → 最新 run」现状语义；slug 碰撞取最新不阻塞；反查名字匹配为归一形态——双侧 basename 化 + 去扩展名后比较，路径 / 带扩展名 / bare 三形态互通（实装锚 = renderer workflow-viz overlay 控制器的 findRun；L4 真机发现主 agent 常传脚本路径、record.scriptName 存 basename，严格等值恒 miss）；反查未命中的兜底 = openWorkflowInDrawer(nameOrRunId) 显空态——点击不丢反馈）；drawer WorkflowTab 保留作回落载体（overlay 装载异常与窄窗口形态）。

**依据**：不采用「两处入口组件零改动」——被现状证伪（block 只传脚本 name，同脚本并发 run 会打开错误的 run）；不采用「回落复用 openWorkflow(runId)」——改向后该函数语义已是开 overlay，回落经它调用会再次触发 overlay 入口、与装载失败形成重入，显式函数让两条通道在调用点即可区分意图；不采用「从 tool result 解析 runId」——tool result 是面向模型的文本，解析它是脆弱间接链，(scriptName, slug) 反查用的是 slug 的设计本职（区分并发 run）。

**登记**：无新约束族（调用意图经函数名区分，语义边界由 coordination.ts 的 D1/D10 注释锚点与测试钉住）；实装 = `packages/core/src/domain/drawer/coordination.ts`。设计文档 workflow-visualization（设计档案已随 .tmp 清理，不入库）；本条即该决策的现行登记处。

> **补记（2026-10-06，workflow-overlay-refine D2，header 形态修订）**：workflow-visualization（2026-10-02）交付的 overlay「双 header」形态——壳 header 与 `WorkflowLivePanel.vue` 自身 header 行（状态 pill / elapsed / args）并存——已被该设计 D2 修订为**单 header** 终态：LivePanel 自身 header 行删除（面板顶部直接从 L2TabBar 开始，run 状态要素由壳 header 单点呈现），args 整体不进 header（用户 v5 终裁：真实形态是 JSON 串、扫读价值低）。本条登记的入口语义分立与回落链不受影响；overlay 现行结构以该形态为准。

### ADR-0105 workflow DAG 静态解析器落 subagent-core（2026-10-02 设计裁决，workflow-visualization §3.2 解析位置 A 方案）
**决策**：`scriptSource → DAG JSON` 静态解析器（acorn 解析；节点/边/phase 分区/条件谓词/并行组/循环回边/调用点行号；模板名保留；不支持语法 fail-fast 结构化错误）落 **subagent-core**（workflow 编排核心包）——解析器紧邻 script-lint 与 record 写入点，与引擎 CLI 包（pi-subagent-cli / zcode-subagent-cli）无关（引擎包被边界禁止依赖 core）；解析产物作为 run 数据的派生物经 `session.getWorkflowDag(runId)` RPC 透出（runtime 读该 run record 的 `run-created` scriptSource，调 core 解析器，runId 内存缓存、仅缓存成功结果）。到达 renderer 的链路 = runtime tsup bundle（noExternal inline core）。**acorn 依赖只声明在 subagent-core**（runtime 不声明——runtime tsup 对自身 dependencies 默认 external，声明错位会致打包态断链）。

**依据**：不采用 renderer 侧解析——acorn 进 renderer 包体，且解析逻辑与引擎 lint 规则形成双份漂移；不采用 runtime 侧解析——runtime 对 workflow 脚本的语义责任就此开端，职责边界不如编排核心干净。

**登记**：无新约束族；实装 = `packages/subagent-core/src/shared/workflow-dag-parser.ts` + `packages/subagent-core/package.json`（acorn 声明）+ `tsup.config.ts` noExternal 同步。设计文档 workflow-visualization（设计档案已随 .tmp 清理，不入库）；本条即该决策的现行登记处。

> **补记（2026-10-15，不可区分调用点合并）**：解析产物收尾新增合并规则——同 `(phase, templateName, kind)` 的调用点合并为单代表节点（组内最前行号；边候选端点重映射后走既有 `(from,to)` 优先级去重；并行组/循环成员 id 同步重映射去重；不同 phase / 不同模板不合并）。根因：同 phase 同模板的调用点在 D2 蓝图-实例匹配下天然并列歧义，保留多个只会互致歧义——任一实例命中并列候选即判歧义进「未匹配实例」分组，该 agent 家族在 DAG 图上整体失去挂接（实测形态：① helper 解析把「派发 + 原位重试」映射成两个全通配 `*` 节点，review-fix-loop 的 Review 相全部 reviewer 实例歧义；② 同字面模板双直呼节点如 aggregate 派发 + 其重试分支，同族实例全部歧义）。合并后单候选实例正常挂接、节点实例行展示真实 agent 名（2026-10-15 DAG 画布正交路由 + 实例行同批实装）。无合并需求时零开销原样返回。

### ADR-0106 事件流通道 = 拉模式 RPC + 信号水位 diff 扩维与 worker-log 滞后取舍（2026-10-02 设计裁决，workflow-visualization D4）
**决策**：workflow run 事件流原文对 renderer 的通道 = 新增 `session.getWorkflowRunEvents(runId)` 拉取 RPC（大字段 2KB 截断 + truncatedFields 标注——input/result/scriptSource/args 四个全文载荷字段；截断形态仅供展示，resume 恢复与 args 一致性校验在引擎侧读 record 原文全文字段，不经本通道）；运行中更新沿用 `workflowUpdate` 信号触发重新拉取（[ADR-0097](#adr-0097-拉为主推补充数据同步第一原则与域同步协议收敛2026-09-26-架构裁决)「拉为主推补充」的应用）。信号水位 diff 扩两维——① phases 折叠（纯脚本 phase 转态发信号）② per-ask attempt 计数（重试边沿发信号，`stepStatusFingerprint` 在串各 call status 之外串入 attempts）——修复「纯脚本 phase 推进期间无信号」与「重试窗口内无信号」两个盲区。**已接受代价**：worker-log 行不纳入信号 diff 维度（无 phase 字段、不对应 call 转态、行数无上界——纳入等于把日志打印频率放大为每次信号的全量重新拉取频率），其展示滞后到下一转态信号（转态类事件秒级到达；worker-log 后无转态跟随时可能分钟级）。不做事件边沿级推送（逐条直播属体验增强非结构必需）。

**依据**：逐条事件推送被 ADR-0097 否决面覆盖（拉是真理通道、推是性能提示，可靠性由通道保证）；拉模式满足「开 overlay 即得全量、运行中信号触发刷新」，结构/实况两个展示目标不依赖逐条直播。

**登记**：无新约束族（推拉纪律承 ADR-0097）；实装 = `packages/shared/src/protocol.ts`（两 RPC 契约与错误码闭集）+ `packages/runtime/src/services/session/session-records.ts`（指纹扩维）。设计文档 workflow-visualization（设计档案已随 .tmp 清理，不入库）；本条即该决策的现行登记处。


### ADR-0107 展示容器三形态拓扑与内容归属：右抽屉 / 底抽屉 / 浮层，容器注册表为唯一权威（2026-10-03 设计裁决，display-containers §6.1/§7.1/§7.2）
**决策**：展示型内容按内容形状分进三个固定容器——右抽屉（竖长阅读型，终态 8 tab：git/doc/detail/subagent/bashTask/plan/btw + workflow 回落载体）、底抽屉（横宽输出流，本期仅 terminal 一种内容、不预设 tab 枚举——第二种横向内容出现时它才从「终端面板」升格为「容器」）、浮层（全画布：browser/workflow）。内容归属的声明处 = 容器注册表（core 纯数据 + 图标标识串，ui 层映射组件），DrawerPanel 硬编码 tabs 数组改注册表驱动；注册表为唯一权威，ui 壳组件与 core 协调函数都读它、禁止各自文字化。workflow tab 保留作 [ADR-0104](#adr-0104-workflow-可视化入口语义分立openworkflow-改向-overlay--openworkflowindrawer-显式-drawer-语义2026-10-02-设计裁决workflow-visualization-d1) 回落链载体（L1 常驻第 8 图标，主入口仍浮层；回落触发范围 = 浮层装载/渲染失败，render-error 链实装已核实）。TraceInspector 临时上下文页不入 L1 注册表（slot 首位注入绕过 activeTab 体系），在老能力映射表登记保位。右抽屉默认 activeTab 从 'terminal' 改 'git'（枚举收窄后首项且高频）。控制态粒度：开合态 per-session 分区（useSessionScopedState 范式）；尺寸类（底抽屉 heightPct）= 全局布局值全局单键 `taiji:bottom-drawer-height` 持久化（对齐右抽屉宽度 `taiji:drawer-width` 先例，姊妹容器同构尺寸同粒度）、显示期 clamp 不写回持久值、拖拽区间 15%–70%。

**依据**：不采用「单抽屉优化」——terminal 半宽折行与 browser 死腔证明竖长容器承载不了形状错配的内容，容器级问题抽屉内优化无解；不采用「自由 docking 互移」——见 ADR-0109。注册表机制的证据 = 10 tab 硬编码已拥挤 + browser 死腔无人发现（归属无声明处）。

**登记**：无新约束族（拓扑经注册表数据结构自承载）；实装 = `packages/core/src/domain/drawer/registry.ts`（新）+ `packages/core/src/domain/bottom-drawer/` + `packages/core/src/domain/overlay/`，W0-W2 分波（W0 注册表先载旧 10 条行为不变）。设计文档 display-containers（设计档案已随 .tmp 清理，不入库）；本条即该决策的现行登记处。

### ADR-0108 tab 两层上限：类型层容器拥有，实例层内容拥有，二选一不叠加（2026-10-03 设计裁决，display-containers §6.3）
**决策**：任何容器内可见 tab 最多两层。L1 类型层（固定图标列表，回答「这是什么类型的东西」）由容器拥有；L2 实例层（文档式 tab 条或组件内部导航，回答「具体是哪一个」）由内容拥有；**实例层要么在组件内部、要么用容器统一实例条，二选一不叠加**。本期唯一新增实例层 = detail 多文件 tab（做在 detail 面板内顶部；keep-alive 多实例共存——切换不丢滚动位置与 diff/preview 模式态；注入语义 = 入口命中未开文件新增 tab 并激活、命中已开仅激活、不设打开上限）；PlanDocsPanel 文档切换条与 BtwPanel 线列表属组件内部导航，维持不变。

**依据**：不采用「容器层统一实例条」——与组件已有内部导航叠成三层，tab 套 tab 是公认混淆源；DESIGN.md §6.3「形态 B：icon 一级 + 各 tab 自治二级」既有方向；现状 PlanDocsPanel 证明组件内部导航够用。

**登记**：无新约束族；实装 = `packages/renderer/src/composables/features/file-tree/useDetailPane.ts`（单值→map）等，W3（顺带承接 detail 展示链 per-session 化终局解——selectedPath 全局单值串线与 DetailPane 单实例清空）。设计文档同 ADR-0107；本条即该决策的现行登记处。

### ADR-0109 固定家 + 显式双入口，否决内容自由互移（2026-10-03 设计裁决，display-containers §6.4，承 ADR-0104 模式推广）
**决策**：每种内容一个固定归属容器；个别内容多一个备用容器，靠内容标题栏上的显式动作（「浮层展开」/「收回抽屉」）切换；入口函数语义分立——`openX` 与 `openXInDrawer` 两个函数、不叫同一函数传参区分（ADR-0104 已验证模式的推广）。本期双入口只给 workflow（既有）；subagent 浮层 trace 模式（左右分栏）为 W4 后续，本期 SubagentTab 零改动，「浮层展开」动作位随 W4 trace 模式一并设计（不预埋不可见的视觉占位，display-containers §5.4）。

**依据**：不采用自由拖拽互移——①多数内容只在一种形状里是对的（browser 在竖长抽屉里的死腔即证据）；②移动要迁移运行态（终端 PTY 不能死、浏览器 view 要重挂定位），成本 = 内容数 × 容器数；③ VS Code 的视图自由移动是其最复杂、使用率最低的功能之一。用户要的不是互移，是「这个实例此刻需要更大空间」——尺寸拖拽 + 展开/收回动作已覆盖。

**登记**：无新约束族；W4 实装 subagent trace 模式时落动作位。设计文档同 ADR-0107；本条即该决策的现行登记处。

### ADR-0110 键盘栈序：Esc 固定层级序唯一属主 + 模态表面聚合双键旗标 + 局部表面执行序两档 + view 转发键清单（2026-10-03 设计裁决，display-containers §6.7）
**决策**：① Esc/⌘W 关闭序 = **固定层级序**（浮层 → 底抽屉 → 右抽屉，不按开序时间记账、状态模型不存开序）；全关后 ⌘W 才关窗口。② Esc 唯一属主 = AppShell 层栈序编排器（window keydown bubble 监听、根 setup 首位注册，isComposing 前置检查；存量 WorkflowVizOverlay 与抽屉侧 Esc 监听拆除——现状双裸监听同按双关已核实）。焦点所有权五层分派：焦点所在内容自消费 Esc 时编排器让位（未收编模态族 / staging 活跃态与地址栏编辑态 / 底抽屉终端聚焦——xterm 5.5 Escape cancel 实装 stopPropagation 事件到不了 window、禁 capture 接管 / 浮层浏览器页面内——Esc 归页面自身语义）。③ **模态表面聚合**（AppShell 级开合态注册单一事实源）成员带旗标组：`yieldsEsc` / `yields⌘W`（两键让位各自独立）与 `shieldsView`（原生 view 遮蔽联动）。弹出层族（reka DismissableLayer 托管的 Popover/Select/ContextMenu）**只让 Esc 不让 ⌘W**——reka 不以 ⌘W dismiss，让位即死键（按键无动作且无递进）；模态族（有未提交输入保护理由）双键均让位。指针驱动瞬态表面（HoverCard/Tooltip 类）显式豁免双旗标（hover 中按 Esc 双动作登记为已知可接受边界）。④ **局部表面 Esc 消费方按相对编排器执行序两档分流**：先行档（capture 相任意节点 / document 级（树序压倒注册序）/ 元素级冒泡先达）= 消费即 preventDefault 约定；后行档（window bubble 且注册晚于编排器，全仓唯一 = SessionList escCount）= 入聚合让位登记，开合态绑删除确认态本体（SessionItem 确认态 / folderConfirmingCwd 聚合谓词），非 escCount 广播计数器（单调递增非状态本体，误绑 = 全局 Esc 死键）。⑤ `` ⌃` `` = 底抽屉开关，主进程 before-input-event **窗口级**拦截（⌘W 同款转发链；不经 shortcut-registry/globalShortcut——那是系统级全局键，会全系统占用并抢走其它应用同键；失焦时无动作）。⑥ 焦点进入浮层浏览器 WebContentsView 后，三键（⌃`/⌘W）连同 app 快捷键族（⌘K/⌘,/⌘[ 等，renderer 注册处 IPC 上报）经 **view 转发键清单**接管（双端匹配配对契约 + 键矩阵单测）；**Esc 不入清单**（页面所有权优先）。焦点契约：任一容器关闭后焦点回 composer；staging 活跃态与浮层浏览器地址栏编辑态聚焦时 Esc 优先服务输入语义（不触发容器栈序）；裸 composer 输入态无 Esc 消费方、Esc 走层级序（第 5 层，与现状一致）。

**依据**：现状 Esc 双裸监听（overlay 仅 preventDefault 不阻断传播 + PanelContainer 裸挂）同按双关——统一编排必须拆其一；⌘J 已被 fast-handoff 占用（选键历史注释明言）；VS Code `` ⌃` `` 为窗口级（肌肉记忆现成）；弹出层族 wrapper 补 preventDefault 方案不采用（反杀 reka 自身 dismiss——`if (!event.defaultPrevented) dismiss` 判定在前，须再手动关闭的组合改造逐 wrapper 侵入）；「聚合注册同步于开关动作」硬约束对 reka 托管弹层无自然钩子，降档为 flush 时序 + 注册序前提（编排器根 setup 先注册，FIFO 同相位先执行让位判定）。

**登记**：门禁项 = Esc 消费方扫描脚本化（先行档无 preventDefault / 不在任一档登记即红；reka 原语 import 纳入扫描锚点防直接组装盲区）随 W1 单测族或交付后落地；实装 = 编排器/聚合新模块 + 局部表面改造 + window-factory ⌃` 拦截，W1。设计文档同 ADR-0107；本条即该决策的现行登记处。

### ADR-0111 docked 死状态删除（2026-10-03 设计裁决，display-containers §6.6③）
**决策**：`DrawerControlState.docked` 与其全链（pin 图标 / emit 链 / toggleDrawerDock / useSideDrawer re-export / i18n key）整体删除——全仓唯一消费方是 pin 图标变色与 title 切换，无任何行为逻辑（close() 无 docked 门、无条件置 isOpen=false），死状态机械清扫，无行为回归。

**依据**：保留 = 假功能信号（用户点 pin 期待行为、实际无任何效果）；删除安全性经源码核实（单消费方）。

**登记**：无新约束族；实装 = W0 状态还债单元（与选中态迁出、瞬时参数分区同批）。设计文档同 ADR-0107；本条即该决策的现行登记处。

### ADR-0112 原生 view 层级共存防御与显示收敛（browser 浮层复活配套，2026-10-03 设计裁决，display-containers §7.4）
**决策**：WebContentsView 恒渲染于宿主全部 DOM 之上（z-index 不可穿越），配套四条防御：① **显示收敛谓词**——view 显示当且仅当「浮层开 ∧ 内容 browser ∧ 无错误态 ∧ 无相交 shieldsView 面」；错误态（页面加载失败 / create 失败 reject / render-process-gone）主动 `browserHide`（keep-alive 幂等），三触发恢复动作一律收敛到对该单一谓词求值、禁止各触发独立 show（防恢复通道竞态）。② **shieldsView 几何相交双阈值空间滞回**——进入隐藏 = 遮蔽范围与 view 原始矩形相交；退出隐藏 = 与外扩矩形（外扩 N px）仍完全不相交；缓冲带内两切换条件皆假、双向状态保持（施密特结构）；显式不采用 debounce / 时间滞回（时间平抑红线——空间解可达成同一目的）；重算触发范围 = resize + rect 推送链 + 成员开态内 rect 变化 + 浮层内容切换。③ **浮层随行**——浮层开着切 session 时 view 换显豁免（内容与 view 保持发起会话的，视口不空白）；`focus()` 收敛：非「浮层开 ∧ 内容 browser」态只隐藏不显示（实装 `focus(sessionId)` 无条件 `_showEntry` 与「恢复现状语义」矛盾——关浮层→切走→切回的残影旁路，主进程/renderer 改动项；browserFocus 生产调用点唯一已核实）。④ **会话删除级联**——仅发起会话触发浮层关闭 + view 销毁（SessionCleanupHooks browser 分支 + browserDestroy）。错误通道：`browserCreate` IPC 失败改 reject（现状 create 失败仅主进程 warn 静默）；池满不是失败（LRU 自动淘汰）。

**依据**：仓内 view 池 hide() 残留事故前科（[HISTORICAL] 注释在案）；Toast 相交隐藏期重开浮层的 show 竞态、关浮层后切回的复显反例（逐路径推演 + 实装核实）。

**登记**：无新约束族；实装 = `apps/electron/main/browser/browser-view-manager.ts` 等主进程半边，W2；S9/S10 真机断言对账（含滞回两半边）。设计文档同 ADR-0107；本条即该决策的现行登记处。

### ADR-0113 终端多实例：实例编号贯通四层 + runtime 为注册表与序号分配事实源 + 世代判据 = token 变化（2026-10-04 交付，terminal-multi-instance）

**决策**：一个会话内可并行多个终端，主键由「会话 id」升为「实例编号」——① **编号格式** `term:<会话id>:<序号>`：序号由后台按会话维度分配、会话内单调递增、**实例关闭后不复用**（复用会让迟到 exit 帧误清新实例分区、清理到达前的旧残留串入新分区）；枚举/归属校验一律取**精确前缀 `term:<sid>:` + 序号段数字校验（`^\d+$`）**，禁按冒号切分取段；由编号反解 sid / 序号则取最后一个冒号前的余段 + 数字校验（sid 域不含冒号由格式保证；该口径把「sid 域不含冒号」从必要条件降级为防御项）。② **事实源 = runtime**：注册表 = 重键后的 `ptyMap` 派生视图（键集即存活实例全集，不建平行结构）+ 会话级序号计数器；**否决「live 键 max+1 纯函数派生」**（实例死绝后 max 回落会复用编号，竞态窗口无键隔离）；界面经新增查询帧 `terminal.list` 在**三触发点**（⌘R 刷新 / 会话激活 / 世代变更重连）对账恢复，对账范围固定为被查会话（他会话键不参与增删）。③ **世代判据 = auth token 是否变化**（端口值不可靠——`findAvailablePort` 重启常落回原端口；`runtime-port` 广播沿是世代变更的保守超集，含无新进程的幂等分支）；**重置触发范围收窄为世代变更**，同世代 WS 闪断不重置（宽触发会清空仍有效的输出历史、且派生无触发点的订阅重建义务）；重置枚举含输出分区、写队列状态机（滞留命令丢弃 + 提示）、**模块级订阅表先退订再清空**（跨世代同形键会命中幂等检查致新世代订阅静默 no-op）；旧 token 不可得时保守判为世代变更。④ **关闭语义**：主动关闭与自然退出（exit/崩溃）同语义——切换条移除 + 三路径清理（输出分区 / 写队列实例态 / 模块级订阅退订）；「最后一个实例禁用关闭」是 **UI 供养规则而非域不变量**（唯一实例可自然退出归零至空态）；会话删除与 runtime shutdown 均级联全量杀链（新增 shutdown 步骤 `dispose-terminal-pties`，紧随 `server-stop`）。⑤ **三码互斥**：`unknown_terminal_id`（注册成员资格的否定回执，**唯一触发回收**的码）、`terminal_id_required`（缺编号 / 编号类型非法的畸形帧）、`terminal_id_session_mismatch`（编号会话段与请求会话不一致）——后两者走普通错误通道、不触发回收（同码会把仍存活的实例误判为幽灵并清理）。⑥ **ack 残窗双通道回收**：`spawn` 完成到界面建档之间可丢 `terminal.data`（首屏输出）与 `terminal.exit`（假阳幽灵条目）；回收靠「首个否定回执检查」+「`terminal.list` 对账」两通道并列（均幂等、先到先回收、**无排序契约**），可达性不据仓内推导下断言、实施期探针留痕。

**依据**：并行长任务是终端典型用法（服务常驻 + 测试跑批），而会话是重量级对象（各带对话与模型上下文），「多开会话」不解决同一工作上下文内并行；「单终端分屏」是伪并行（一个 PTY 不可能同时跑两个交互命令）。编号唯一性与不回填的立法理由 = 迟到帧与清理窗口的竞态隔离；世代判据取 token 而非端口/沿的理由 = 两者均可证伪（端口可复用、沿含幂等分支）。

**登记**：约束登记 = C-proc-18 的 shutdown 步序 SSOT 同步为 15 步（新增终端 PTY 全量清理紧随 `server-stop`）；e2e 资产 = `E2E-TERMINAL-01`（`e2e/terminal-multi-instance.spec.ts`，L2/on-diff/serial，覆盖 T1/T2/T4/T8/T9/T10/T13；T3/T5 走 L4 真机、T6/T7/T11/T12 归单测）。设计文档 terminal-multi-instance（设计档案与实施验收过程产物已随 .tmp 清理，不入 git）。同族未落地项（浏览器多页面、浮层实例 tab 条）依赖本编号先例，另立项。

### ADR-0114 主区三卡化：内容区各自成卡 + 实例 tab 条范式统一 + 终端头部一行化（2026-10-04 用户裁决，drawer-cardification）

**决策**：① 对话流 / 右抽屉 / 底抽屉三块内容区各自持 float-panel 壳（surface + border + 10px 圆角 + shadow-1），卡间 8px 缝，卡内底色统一——**推翻 D2「一体化生长」裁决**（原右抽屉从主面板右缘生长、共享外壳与横跨 header）；PanelHeader / StatusBar 保持横跨工具条/状态条语义，不属任何卡。② 右抽屉 L1 栏选中态回归 §3.4 标准 tab 型（bg-elevated + neutral-fg）——原「bg-surface-hover 例外」以「drawer 与 main 同 surface」为前提，三卡化后前提消失。③ 终端面板头部一行化：实例切换条（tab 条 + 右簇「+」/收起按钮）单行承载，原第二行工具栏（清屏/终止）移除——终止与 tab 关闭叉同义，清屏功能退役（用户裁决接受）。④ 终端区收起语义 = 收起非销毁（实例保留、重开走对账恢复），入口 = 头部收起按钮 + 顶栏开关 + `⌃`` ` 三通道。⑤ 终端开关迁 PanelHeader 顶栏（右抽屉开关左边），StatusBar trailing 原生动作通道退役，StatusBar 回落「有状态项才显示」纯显隐。⑥ 实例 tab 条范式统一（§5.3.1）：终端实例 tab / detail 文件 tab / plugin L2 tab 三族同构——非激活 bg-input+border、激活 bg-elevated+border-strong、关闭叉常驻命中 ≥20px（原「hover 才显现」形态因可发现性差被用户裁决推翻）；pin 功能全链移除（L2TabBar/L2TabItem/PluginViewContainer/WorkflowLivePanel，用户裁决：不需要该功能）。⑦ TurnRail 定位从 fixed 视口垂直居中改为 absolute 于对话流容器右缘——fixed 不感知底抽屉高度，窗口矮/抽屉高时叠进终端卡（跨区缺陷）；absolute 后随对话流卡 overflow 裁剪，跨区构造性不可能。

**依据**：用户 2026-10-04 对底/右抽屉的 5 点产品反馈（三区分割缺失、开关位置、头部两行、tab 可区分性、tab 关闭叉）+ critique 补充发现（TurnRail 跨区、tab 条无横向滚动、空态黑块、最后实例禁用叉伪装可点、composer 窄宽叠字）。一体化生长的「同 surface 无缝」语言在多容器并存场景不可辨识（三区边界靠 1px 拖拽线不可发现），卡片化是分区可见性的直接解；代价 = 卡缝占 8px×2 垂直空间与推翻 D2 的回写成本，收益 = 分区心智清晰 + tab 范式全局一致 + 跨区缺陷构造性消除。

**登记**：设计 SSOT = docs/DESIGN.md §3.4/§4.1/§5.3.1/§6.1/§6.3/§6.4（2026-10-04 同批回写）；CONTEXT.md「底抽屉」词条开关入口同步。实现落点 = MainPanel（壳下沉）/ PanelContainer（三卡 + 卡缝 handle）/ DrawerPanel（卡片化）/ TerminalView + TerminalInstanceBar（head 一行）/ TerminalToggleButton（原 StatusBarTerminalToggle 迁移）/ DetailPane / L2TabBar / TurnRail。

### ADR-0118 对话流 HTML 预览与产物落点约定（2026-10-04 设计裁决，chat-html-support）

**决策**：对话流支持「agent 交付 HTML 产物 → 用户在应用内直接看渲染结果」——扩写 capability 段成精确能力契约（M0：正/负面清单；M1：交付约定与预览约束 + 每 turn 注入会话产物目录绝对路径）、新 fence info string `html-preview` + 对话流预览卡片、DetailPane 对 `.html` 新增渲染态。四条关键裁决：

1. **产物目录落点 = session 存储树域 2**（`<dataDir>/ext-sessions/<sessionId>/artifacts/`，[ADR-0151](#adr-0151-session-维度存储布局反转ext-sessions-树--分区键-rootsessionid--整树软删2026-10-17-用户裁决session-store-layout-inversion)）：local-file 协议白名单静态成员集（`apps/electron/main/utils/local-file-prefixes.ts`）已含 `<dataDir>` 前缀，产物落其下则预览无需新增白名单成员、renderer 不成为白名单输入方（「白名单外路径一律 403」不变量保持）。目录推导公式单点 = `packages/shared/src/paths.ts` 的 `getSessionArtifactsDir`（含 sessionId 穿越校验，规则与 `isPiSessionId` 同域：允许 `.` / `_`、禁 `:`——不用 `getImageCacheDir` 的窄集）；system-prompt 扩展侧不 import shared（包边界 + C-proc-26 / C-proc-09 门禁组合），以同公式镜像推导，两实现段名与校验正则字面量对拍机检。
2. **session cwd 动态注册方案不采用**：该方案让 renderer 首次成为 local-file 白名单的输入方（白名单防线对 renderer 的信任假设从零变为有），并连带引入新 IPC 通道、进程内集合、注册时序竞争、预检对注册完成的依赖；落点约定后这些复杂度全部无服务对象。**已接受代价**：项目目录内的 HTML 不能被应用内预览——恢复路径 = 要求 agent 把产物写到会话产物目录，或经「查看源码」在项目内直接读源码（2026-10-15 起代价部分修订：各会话项目 `.tmp/` 子树可预览，见 3d）。
3. **预检通道统一落主进程 `localFile:servable`**（入参绝对路径，出参 `{servable, reason, size}`，reason ∈ `not_found` / `is_dir` / `out_of_whitelist`）：卡片（经 deps `probeArtifact?`）与抽屉渲染态共用；谓词与 `protocol.handle` 复用同一规范化管线模块（白名单成员资格先行短路 → 存在性 → 目录性——越界路径不触 fs，杜绝任意路径存在性探测通道）。**不新增 runtime 文件 RPC**：白名单成员资格只在 main 信任域可见，runtime file 族的 cwd 守门看不见白名单，两处预检会形成两套准入语义。
3b. **实施期补全：源码态读取通道 `localFile:read`**（2026-10-04，D2 一致性审查反证）——产物目录在 session cwd 之外，既有 runtime `file.read` 的 cwd 守门不可达，故 `.html` 的**源码态**读取需一条与 servable **同源**的主进程通道：同谓词模块（准入前缀成员资格先行短路，越界不触 fs）、仅 `out_of_whitelist` 时回落既有 cwd 通道；通道名 `localFile:read`（`packages/shared/src/ipc-channels.ts` 登记）。它是第 3 条「预检通道统一落主进程」原则的对称补全（**探测与读取同源**），未新增白名单成员、未新增白名单输入方。

3c. **实施期收窄：读/预检通道准入 = 会话产物子树**（2026-10-05，branch-review dmg-r1-2；前缀形态随 [ADR-0151](#adr-0151-session-维度存储布局反转ext-sessions-树--分区键-rootsessionid--整树软删2026-10-17-用户裁决session-store-layout-inversion) 布局反转更新）——`localFile:servable` / `localFile:read` 两条 IPC 的准入前缀 = 产物子树（`computeLocalFileReadPrefixes`，`apps/electron/main/utils/local-file-prefixes.ts`），不复用协议 handler 全量白名单。收窄理由：通道入参含模型消息文本承载的路径载荷（html-preview fence = 不可信输入），全量白名单含 `<dataDir>` 整前缀（含 `<dataDir>/agent/auth.json` 等凭据），读/预检面复用全量白名单 = 渲染进程被注入后可直读数据目录内任意文件文本。准入前缀按「只放行产物子树」的收窄语义随布局取形态：产物子树以 sessionId 分区（`<dataDir>/ext-sessions/<sessionId>/artifacts/`），无静态单前缀——每次准入现算 readdir 存储树一级目录（先例 = 3d 的 encodeCwd 目录集，本地 fs µs 级，无缓存无时间平抑面），只对 `isPiSessionId` 合法形态的一级目录产出其 artifacts 前缀（树内遍历规约：非 sid 形态跳过）；枚举失败（缺目录/权限）→ 空集（准入从紧，不构成放行），ENOENT 静默（存储树未建 = 无产物，常态），其余异常经 onError 旁路出声。收窄后越界仍返回 `out_of_whitelist`（不触 fs），消费方回落既有通道（useDetailPane cwd 通道 / 容器降级占位）；三条调用链（容器源码态、挂载前 size 预检、抽屉产物源码读取）全部只消费产物路径，无功能回退。协议 handler（渲染范围：图片 / iframe 服务）保持全量白名单不变；谓词函数与检查顺序同源不变，未新增白名单成员、未新增白名单输入方（成员集后随 3d 扩大范围，本条「越界不触 fs」与同谓词性质不变）。

3d. **实施期扩大范围：会话项目 `.tmp/` 子树加入三面准入**（2026-10-15，用户裁决）——决策②「已接受代价：项目目录内的 HTML 不能被应用内预览」部分修订：应用全部会话的项目根（session cwd）下的 `.tmp/` 子树加入协议 handler / servable 预检 / read 通道三面准入。成员派生不经 renderer（决策②否决的 session cwd 动态注册方案不回归——无新 IPC 通道、无进程内集合注册、无预检对注册完成的依赖）：main 自有 sessions 目录（`<dataDir>/agent/sessions/<encodeCwd>/`，`getPiSessionsDir` SSOT）的 encodeCwd 子目录名集与被验路径做**正向对拍**——encodeCwd 把 `/ \ :` 归并为 `-` 不可反向解码，但候选 cwd 只能取自被验路径中 `/.tmp/` 边界的结构性前缀，逐候选 encode 后与目录集全串比对（`isPathUnderSessionTmp` / `collectSessionTmpEncodeCwdDirs`，`apps/electron/main/utils/local-file-prefixes.ts`；encodeCwd SSOT 收敛至 `packages/shared/src/paths.ts`，runtime pi-paths re-export）。每次准入现算（readdir 本地 fs µs 级，无缓存无时间平抑面，ADR-0122 事实驱动）；`..` 穿越在 resolve 层折叠后对拍，「越界不触 fs」性质保持。风险 = 应用用过项目集合的 `.tmp/` 可读——与 ~/Downloads 等既有用户内容成员同粒度，且该 `.tmp` 本就是对应 session agent 可全量读写的域；项目其余路径仍不可预览（决策②代价保留部分）。字面量 `.tmp` 单点收敛 `SESSION_PROJECT_TMP_SEGMENT`。

4. **产物回收 = 删会话级联单一通道**（2026-10-12 裁决定案，见 [ADR-0133](#adr-0133-会话下挂内容回收统一归删主会话级联三机制废弃--保留边界2026-10-12-用户裁决)；级联形态随 [ADR-0151](#adr-0151-session-维度存储布局反转ext-sessions-树--分区键-rootsessionid--整树软删2026-10-17-用户裁决session-store-layout-inversion) 整树软删收敛）：产物目录落 session 存储树域 2，删会话 = `<root>/<sid>/` 整树 trashDirectory 进废纸篓（mac）——产物随树回收，无独立删除动作；外部删除主会话文件场景的残留按裁决接受（无保留期扫描兜底）。main 侧 `image-cache.ts` 的孤儿扫描属 main 资源域，不在级联射程（换根扫新树继续工作）。

**三条配套**：① **引用语法** = 新 fence info string `html-preview`（首词匹配，内容 = 单行文件路径；空 / 多行 → 卡片降级态「路径非法」），卡片走 Vue 段组件（`HtmlPreviewCard.vue`）不进 v-html / DOMPurify 通道——「用户 HTML 白名单契约」与「预览卡片不经 sanitize 通道」不变量保持；段类型复用 mermaid 同构通道，finalize 仅由 fence 收尾 / 消息 complete 触发（静默 200ms 不提前 finalize——半截路径不产假降级卡片）。② **渲染态** = DetailPane 对 `.html` 新增「预览 | 源码」切换，渲染态为 `<iframe sandbox="allow-scripts" src="local-file:///<百分号编码 abs>?r=<n>">`（无 `allow-same-origin`，文档落 opaque origin，读不到主窗口 DOM / localStorage / cookie；`?r=n` 仅作重导航触发）；CSP meta（`packages/renderer/index.html`）新增 `frame-src 'self' local-file:`。③ **协议响应头** = `protocol.handle('local-file')` 全部响应附加 `Cache-Control: no-store`，`.html` / `.htm` 再附加内容级 CSP（`default-src 'none'` 封网络出站；`script-src 'unsafe-inline' local-file:` 保脚本与相对子资源；指令集不含 opaque origin 下恒不匹配的 `'self'`）——sandbox 管「碰不到主窗口」、文档 CSP 管「连不出网络」双保险。

**依据**：① 根因是四环缺失（能力契约 / 交付模式 / 预览链路 / 产物落点未约定），落点约定消除整类「白名单外不可读」问题，比事后放宽白名单（renderer 成为白名单输入方）代价更低；② 预览文档唯一需要的同源能力是相对子资源，而子资源经 local-file 协议加载不依赖 origin 同源，故 sandbox 可不给 `allow-same-origin`；③ 两条不采用路线的击穿点——srcdoc 方案（file.read RPC + iframe srcdoc）能力死（继承主文档 CSP 致内联脚本不执行、相对子资源无基准地址，交互价值消失）；WebContentsView 方案在抽屉内可行，但与对话流内联预览方向冲突（窗口层原生覆盖视图不随虚拟滚动同步，需一整套滚动同步机制）。

**登记**：约束 C-build-06 表述随本裁决收窄——scope 由「嵌入式网页」收窄为「嵌入第三方远程网页」，理由（`X-Frame-Options` / CSP `frame-ancestors` 硬伤）仅对远程站成立，本地 HTML 由应用自有 `protocol.handle` 服务、不携带这些头（见 ADR-0054 理由边界修正补记），登记 `docs/constraints.json` C-build-06；未新增约束族（预览隔离由 sandbox + 文档 CSP 构造性保证，落在 C-build-06 的 review-electron-build 面内）。设计文档 chat-html-support（设计档案已随 .tmp 清理，不入库）；实施 = 8 单元（u-foundation / u1-prompt / u2-infra / u-artifacts / u3-detailpane / u4-card / u5-docs / u6-acceptance）。

### ADR-0119 html-preview 渲染形态 = 对话流内联容器（2026-10-04 用户裁决，chat-html-support v16）

**决策**：`html-preview` fence 段在**对话流内直接渲染**（`HtmlPreviewInline.vue` 内联容器：头部条[文件名/大小/源码-预览切换/刷新/收起展开] + sandbox iframe 原位嵌入消息流）；原「预览卡片 → 点击 → DetailPane 渲染态」两级形态**退役**——DetailPane 对 `.html` 恢复基线源码高亮，相对链接不再承载预览。安全模型零变化：sandbox 权限侧、`local-file` 协议白名单、`localFile:servable` 预检、CSP `frame-src`、内容级 CSP 全部平移适用（机制规格从原 D4 抽屉渲染态整体平移到容器）。

**要点**：
1. **单渲染范围原则**：内联容器是唯一渲染范围。抽屉保留渲染态会造成「同一文件两个渲染入口、两套挂载序列」的双轨；内联容器的展开/源码态已覆盖抽屉渲染态的全部用户价值。`localFile:read` 通道保留（消费方 = 容器源码态 `useChatViewDeps` readArtifact 与 DetailPane 文件树/抽屉源码读取 `useDetailPane` loadPreviewContent——与设计 §6.4 D4「退役的连带回收」同口径；变更集卡入口语义是看 diff，不消费该通道）。
2. **高度策略降级裁决**：内容高度自适应（iframe 内上报）三条通道均不可行——产物文档内协作脚本不可假设、opaque origin 收不到定向 postMessage、`sandbox` 无 `allow-same-origin` 时 `contentDocument` 恒 null——降级为固定 480px（展开 720px）、超限 iframe 内滚动；升级预案（协议 handler 注入上报脚本）登记设计文档 §6.3。
3. **流式与降级形态保持**：finalize 仅由 fence 收尾/消息完成触发（静默不提前）；预检三原因降级占位形态延续（文件名 + 原因两行，恢复指引由失败路径表承载）。**S4 验收留痕口径（终态同步 R1 显式声明）**：「链接 → 抽屉源码高亮」为基线行为恢复（file-type 分发与 DetailPane code 类高亮由既有单测承载），**不作独立真机重验**——v16 重验覆盖 A3a/A3b/A5/A8 + A6；产物目录文件场景的链接正向断言已随抽屉入口 cwd 内外分流落地：cwd 外产物文件走 preview 模式、经 `localFile:read` 白名单通道读取（useDetailPane-html 单测承载），不再被 forceDiff 通道拒绝。

**依据**：用户裁决动机 = HTML 交付物在对话流内直接可见可交互，不经点击跳转（交互式图表/自包含组件的核心价值前置呈现）；ADR-0118 方案 A 本就预期「iframe 在 DOM 流内随滚动天然正确」，本裁决是该预期的终态化；已接受代价 = 对话流 turn 虚拟化使旧 turn 容器随滚动卸载/重挂载（脚本重执行，既有虚拟化行为的固有代价，实测无可感知卡顿阈值内）。

**登记**：设计文档 v16（chat-html-support 设计 §6.3/§6.4，档案已随 .tmp 清理）；实施 = u7-inline-refactor 单元（M1.5 批次）；验收 = v16 重跑四项（渲染/观感/安全负面/降级矩阵）+ 打包态，全部通过（2026-10-04）。S4 相对链接场景随之重定义为「链接 → 抽屉源码态（基线行为恢复）」；链接打开产物目录文件经抽屉入口 cwd 内外分流走 preview 模式与 `localFile:read` 白名单通道（终态，useDetailPane-html 单测承载）。

### ADR-0122 事实驱动原则体系：状态、传播、失败、呈现的统一纪律（2026-10-05 用户裁决）
**决策**：本地 GUI 应用的工程原则体系，总原则 = **事实驱动，不做补偿性猜测**——系统的每一个状态判定都锚定确定性事实（回执到达、断连信号、同步查询返回、磁盘记录）；用时间猜事实、用补偿掩盖丢失、用乐观呈现代替确认的机制一律不建，存量一律清拆。分则按四个层面：

**地基——故障模型（进程生死二态）**：本机全链（回环网络、本地管道、本地文件）内进程间消息不会无缘无故丢失，「没收到」的唯一现实解释是对端进程死亡，而死亡有操作系统级断连信号。不存在需要独立防御的「对端活着但消息丢了」形态；应用层广播的时序竞态用事实查询消解（见判定层），不建防御机制。

**传播架构（活状态与存储的分工）**：
- 活状态走订阅推送，存储只做恢复源：进程活着时才有意义的实时状态（运行事件、进度、流式输出）一律订阅-推送传播；文件与记录只承担持久化事实源与崩溃/断点恢复两个职责。禁止用监视存储模拟实时（tail 日志、watch 数据目录、轮询表）。判据：数据在进程死后仍有意义（恢复/对账/审计）→ 落盘由恢复场景读；仅活着时有意义 → 推送不落盘或落盘只为审计。
- 推管即时，拉管正确：推送丢失可容忍，消费方重连后按消费水位从事实源补读（拉取通道）；事实源读取不可绕过。推是延迟优化，拉是正确性底线（与 ADR-0097「拉为主、推补充」合并解释：拉保证正确性与收敛，推只优化延迟）。
- 单一事实源，消费方只持水位：一个状态只有一个产生方、一份权威存储；消费方本地只留订阅水位，重连凭水位补读。禁止多消费方各自拉同一存储再互相对账。

**判定与决策（事实的三级来源）**：
- 状态判定锚定确定性事实，来源严格递减：同步事实查询 > 确定性事件 > （禁止）时间推测。能查到的状态直接查（会话空闲、进程存活、消费水位），事件只作提前触发的加速器；禁止「先信事件、不信了才查事实」的两段式。
- 竞态用顺序契约与事实查询消解：多步写（数据文件与登记）的竞态用创建顺序契约（登记先行）加持有者存活查询消解，不用宽限窗猜「是否还在写」。
- 知识与决策同地：重试、恢复这类决策需要「后果是什么」的语义知识；谁拥有语义知识谁决策。内核与基础设施只做无语义的忠实执行与如实上报，不建自动重试/自动恢复/静默重投。

**失败与呈现（显式纪律）**：
- 失败显式上报：失败不自动补偿——失败即显式通知（人看页面通知、agent 收失败回执），首败即停；时间窗扫描、宽限窗、静默终局、自动重试、对账补偿全部不建。
- UI 呈现跟随事实：确认成功才呈现（受理回执到达气泡才上屏），不建「先显示、错了再回收」的乐观态；结果未知显式标注（如「执行结果未确认，重发前请核对」），不静默假装无事发生。

**范围纪律**：
- 机制服务可达场景：产品全链路无入口的形态不为它建行为路径（含注释穷举与用例）。判定依据 = 触发源存在性。
- 信任边界内不设防：本机全链无网络类故障面，墙钟兜底不建；「调用永不返回」（实现卡死）的处置 = 显式失败 + 用户重启应用，不自动恢复。

**删除判据**：删掉某机制后数据仍最终一致 → 它是补偿补丁，删；不一致 → 事件顺序契约本身未定义，先定义契约（谁的事实、谁推送、丢了如何补充拉取）再删。

**元原则**：原则面前无存量豁免——与本体系冲突的既往裁决一并推翻（已删：zcode 无进展检测双 timer、notify 看门狗重投、update 停滞检测、event-tail watch 族、structured-output 强制退出等，清单原 defense-mechanism-cleanup 登记已随清查完结删除，git 历史可追溯）。

**保留白名单（原则不适用域）**：产品功能定时（调度/提醒/产品轮询能力）、调用方显式配置传入的超时参数（C2 显式业务超时）、恢复场景的文件读取、锁语义原语（file-lock）、事件驱动的对账与拉取通道（ADR-0097 实现本体：delivery-port 回执对账（details-id 命中 + session_start 差集重放）、reconcile 事件触发路径、worktree 观察期族）、构建脚本类、PingProbe 无进展检测（ADR-0047 口径）、外部网络端点墙钟（npm/oauth，网络客户端标准防线）。过渡形态轮询登记：trace-sync 现取轮询（FETCH_CURRENT_PROMPT_POLL_MS=250ms / 8s 上限，pi 侧写侧无完成事件信号、轮询是当前唯一可达通道；退役条件 = pi 提供 entry 写入事件边沿或命令 RPC 直返结果）。

**依据**：本体系收敛自 pi 1.0 适配设计包交付后的系列裁决（2026-10-05）：命令终局事件化（handled/started/断连三事件）、投递 backoff 退役、全项目防御机制清查（约 270 处登记）、event-tail 退役与推送通道方向、受理层同步上屏、scheduler 切换对账翻转为事实查询。故障模型依据 = 本地进程通信无网络类瞬态失败情形，对端死亡有 OS 级信号。

**登记**：清查清单与删改记录 = 原 `docs/todo/defense-mechanism-cleanup.md`（清查完结已删除，git 历史可追溯）与 defense-scan 过程产物（已随 .tmp 清理，不入库；四分区清单 + 改动清单）；投递域重构与推送通道设计为 tech-design 过程产出（已随 .tmp 清理，不入库；决策以本条为准）；AGENTS.md「防御机制第一原则」规则条目为本条的规则面派生视图。原「时间平抑类逻辑红线」为本体系判定层的既有条目，继续有效。

**边界澄清（SendReceipt 设计内等待类型化申报，2026-10-18 架构审查裁决）**：首败即停的「失败」判定以 SendReceipt 拒绝分支的判别联合为准——`{ accepted: false, deferred: DeliveryDeferReason }`（设计内等待：条目未被注入、等投递端下一边沿重提，**不计首败**，词表 = 内核 `packages/session-delivery` 单源导出）与 `{ accepted: false, reason }`（真失败：计首败）互斥，由类型构造保证；内核消费点按判别字段分流，不维护字符串白名单。演进动因：白名单形态下生产点裸字面量与消费点集合两处独立演化，同族漂移两次现实击中（建白名单与三小时后补第二个 reason 各一次）；类型化通道防未来审查把判别联合当冗余「简化」回字符串。词条见 [CONTEXT.md「设计内等待」](../CONTEXT.md)。

### ADR-0128 subagent 流式通道 = 增量推送 + 按需拉取（2026-10-06 用户裁决，B2 设计裁决）

**决策**：subagent 流式输出通道（relay 路径）采用「chunk 增量消息（带 msgSeq/deltaSeq 双序号）+ 按需拉取收敛」——不做周期快照、不做攒批。拉取触发 = 接入（订阅建立/记录刷新发现运行中 record/流中首条 chunk 缺前缀）与失步（deltaSeq 跳号）两类事件；恢复源 = 新增 RPC `session.getSubagentStreamState` 读取 RelayTee 既有内存状态（当前 msgSeq / 已发 delta 数 / 累积全文），产生端不保留 delta 历史。响应携带水位（记录已处理到哪的位置标记：lastDeltaSeq，这份全文含到第几条 delta），消费端凭水位去重缓冲回放。形态对标 Kubernetes ListAndWatch（接入 LIST 全量 → WATCH 增量 → 失步重新 LIST）。

**要点**：
1. **ADR-0097 豁免**：分则「功能域禁止消费侧补充拉取」红灯由本通道触发豁免——拉取对象是既有内存状态的只读视图（非新建补偿状态）；失步在活连接上按传输契约（TCP 有序可靠 + transient 直传订阅者）不会发生，拉取触发源是连接生命周期事件与防御性检查，不是高频补偿路径；豁免范围仅限 subagent 流式通道。
2. **兼容窗口不设防**：npm 移动壳跨版本窗口内旧 renderer 收未知 chunk 静默忽略、无实时流显示，定稿 entry 照常——用户裁决移动壳尚无用户、renderer/runtime 同仓同发，不为兼容窗口保留冗余推送机制，亦不设移动壳冒烟义务。
3. **无时间窗逻辑**：失步修复与失败重触发均为事件驱动（跳号 / 下一条 chunk 到达），无周期快照、无重试定时器（ADR-0122）。
4. **周期快照制不采用**（本设计前一版形态，经对抗比较后裁决）：机制体量最小且对旧 renderer 兼容窗口友好，但稳态多发约 9× 全文量字节、恢复延迟受快照间隔约束——与「恢复语义对齐现状量级」的长期合理性判据冲突。

**依据**：用户裁决「只做长期合理的方案，不做短期成本控制考量的方案」（2026-10-06）；拉取收敛与 ADR-0097「拉为主、推补充」直配，恢复源 = 同步查询（ADR-0122 状态判定来源最高优先级）。

**登记**：设计文档 subagent-stream-chunk-design（设计档案已随 .tmp 清理，不入库）；实施跨 shared / runtime / core / renderer 四包 + 本登记，清单见设计文档 §5。

**【2026-10-18 现状更正（ADR-0145）】**：relay 通道已整体退役——本条产出端 = 引擎 fd3 raw mirror（`SubagentMirrorHub`）+ `SubagentTee`（`packages/runtime/src/infra/subagent-control/subagent-tee.ts`）；`session.getSubagentStreamState` 数据源 = runtime control server 的 tee，响应增 `degraded:boolean`（镜像 seq 空洞时 live 视图降级，reload 不受影响）。「增量推送 + 按需拉取」语义与触发源不变。

### ADR-0129 subagent 执行模型切换：用户覆盖语义与跨端命令通道（2026-10-06 用户裁决「按 A 做」）
**决策**：
- **用户覆盖赢**：`setModel` 在模型解析链第 0 层加用户覆盖记账，优先级高于 agent frontmatter 与脚本/调用参数显式指定的模型。
- **持久化与热切是同一意图的两半，必须同步落**：只热切会被下一轮 spawn 的旧 `--model` argv 压回（pi CLI flag 恒优先于 session 恢复）；只记账则执行中不受控。记账载体 = record 事件文件 `record-model-override` 帧（chat 域）/ run journal `model-override` 事件（workflow 域），fold 取最新、替换不叠加；records 磁盘快照 json 是派生视图非事实源（不作断言范围）。
- **跨端通道（runtime → pi extension）= prompt 斜杠命令出站点**：runtime `client.prompt("/subagent-model <单行 JSON>")` → pi `prompt()` 扩展命令分支（流式中也立即执行；排队路径会拒扩展命令，不可绕行）→ subagent-workflow 进程内编排 → 结果文件 `<subagent 数据根>/model-switch/<requestId>.json` 回执（原子写、网关读后即删、60s 超时 best-effort）。pi 1.0.0 无结构化 RPC 注册范围（rpc-mode 命令词表封闭）且上游不 fork/不提 PR——斜杠命令是仓内在产标准通道（三先例：workflow abort / subagents 动作族 / plan abort）；新出站点登记 `.githooks/check_prompt_outposts.py` 白名单。
- **成员态三态（引擎中立）**：switched（生效值+档位回执）/ not-active（引擎定位不到活跃子进程，已退出成员承接态）/ not-applicable（引擎 capability unsupported，提示性应答非错误，记账照写）+ 失败名单（独立组件，非成员态——转发失败成员的成员标识 + fail-fast 分型；单成员失败不回滚其他成员、不影响 run 级意图写入）。聚合应答恒为「成员态数组 + 失败名单 + 汇总文案」三组件固定结构（前端按成员分项呈现）。run 级全切为 2026-10-05 用户裁决翻转初稿「run 级只记账不转发成员」条款的结果（随持久化裁决一并确认——该反向方案已否决，勿再议）。resume 生效模型三档回落：resume 显式参数 > 持久化覆盖 > run 创建模型。

**登记**：设计 SSOT 为 subagent-model-switch 设计文档（设计档案已随 .tmp 清理；§5.2 解析链 / §7.1.1 通道机制 / §7.4 三态）；术语登记 = docs/CONTEXT.md「模型覆盖」词条；验收终态 = 5 轮真机验收 degraded 无阻塞缺陷（verdict 记录为 dev-flow 过程产物，已随 .tmp 清理）；验收期遗留裁决项已全部修复收尾（2026-10-07，终态记录 git 可追溯）。

### ADR-0130 界面视觉令牌体系：五层职能分层 + 令牌名只改值 + 灰阶四档去蓝偏 + 字重三档上移（2026-10-08 用户裁决，ui-optimize-unified）

**决策**：
- **五层职能分层规则**：明度层级按「读的地方沉下去、操作的地方浮上来」组织，五层自沉到浮 = 窗口壳 `--bg-stage #0a0a0c` → 内容层 `--surface #101010`（对话流/drawer 等阅读区沉底）→ 内容层内次级 `--bg-input #161618` → 框架层 `--bg #1e1e1e`（侧栏与 composer 同层，操作区浮亮）→ 浮层 `--bg-elevated #2b2b2e`；亮色族按镜像规则反向推导，settings 域与派生令牌（`--bg-card`/`--secondary`/`--bg-sunken` 等）随批归层对齐；`--bubble-bg` 不在归层集合（暗族随 `--bg-elevated` 派生、demo 暗族三主题同值，亮族独立 `#fefefe`，见 style.css :root 注释）。
- **令牌命名裁决 = 保留现行令牌名只改值**：不新增 `--card`/`--card-inset` 等新令牌名——设计表中的此类名是概念层名，实装一律映射到现行令牌改值。理由：同一「对话流卡片底」在改值前后换名字，git 历史里「明度反转」这一行为会被改名噪声淹没，review 与回溯成本上升而用户可感知终态相同。
- **灰阶四档去蓝偏**：`--neutral-fg #ececec`（正文/侧栏主文字/composer 可操作文字共用正文档，R=G=B 纯中性）+ `--neutral-mid #8a8a8a`（工具行/次要）+ `--neutral-dim #5c5c5c`（时间/元信息）+ `--neutral-faint #45454a`。对比度显式取舍：dim 档对 surface 约 2.8:1、低于 WCAG AA 正文线，仅用于时间戳/元信息等低显著度装饰性文字；工具行落 mid 档（约 5.4:1）。范围 = 暗色族三主题（玄/黛蓝/暖墨）文字档全部重校，亮色族三主题文字档维持现行值（无蓝偏问题），bg 分层经镜像规则核对零 diff。
- **字重三档上移**：`--fw-text/mid/bold` 400/500/600 → 500/600/700——「档差不变、整体更实」的解读（三档等距上移；mid 不动则 text 与 mid 重合塌成两档）。

**依据**：双向真机实测 + 用户对分层表与灰阶值的逐项裁决（设计包 wave3 §2.1/§2.4）；「正文 ≥12:1 / 工具行 4–6:1 / 元信息 ≥2.8:1」阈值固化为永久单测——亮色族 dim 因维持现行值 #9d9b96（≈2.57）不跑 2.8 阈值，改锚定现行值断言防漂移、改值须先改设计。ADR-0066 的 accent 弱蓝灰补记不受影响（本波未动 accent 与状态色）。

**登记**：值权威 = `packages/renderer/src/style.css`；挂值对照 = `docs/DESIGN.md` §4（CSS_TOKEN_SSOT_CHECK 机器核对两处逐字一致）；阈值单测 = `packages/renderer/src/__tests__/contrast-tokens.test.ts`；设计文档 ui-optimize-unified（设计档案已随 .tmp 清理，不入库），本条即令牌体系裁决的现行登记处。

### ADR-0131 运行态动画与「回到最新」胶囊：文字扫光替换底板扫光（sheen-x 退役）+ 浮现条件改离底一屏（unreadBelow 退役）（2026-10-08 设计落地，ui-optimize-unified 决策 10/12）

**决策**：
- **文字扫光**：扫光对象 = 执行中行正在发生的内容文字（思考行状态词与预览流、工具行执行命令/摘要），稳定标识（工具名/时间戳/计数）不扫；实现 = `linear-gradient` + `background-clip: text` + 透明字色，base = 行常态字色（dim/mid）、peak = `--neutral-fg`，全令牌化免六主题逐个定值；周期 2.6s、扫程占前 55%；`prefers-reduced-motion` 下退回常态字色。
- **sheen-x 扫光层退役**：原「icon 底板扫光」（Block 普通工具块与 bash 组头的 `absolute inset-0` 扫光层、style.css `sheen-x` keyframes、`--sheen` 令牌、DESIGN.md 挂值条目）全链删除，退役范围经 grep 穷尽核实零残留。
- **「回到最新」胶囊浮现条件**：从「非贴底且有未读新内容（unreadBelow）」改为「滚动离底超过一屏」（一屏 = 对话流滚动容器可视高度，virtua 环境以 viewportSize 快照承载）——回看历史（无新内容）也有回底入口；点击平滑回底后消失，生成中自动跟随不变。`unreadBelow` 状态链（ref/置位清除分支/`shouldMarkUnread`）全删。

**依据**：N13 问题陈述 = 底板扫光扫的是静态标识而非正在发生的内容，信息价值错位；N11 问题陈述 = 回看历史后无快捷回底入口，unreadBelow 必要条件直接指向此变更。两处退役范围均实施期 grep 复核零残留消费。

**登记**：实装 = `packages/ui/src/features/chat/Block.vue`（text-sweep 挂点与动画）/ `block-icon.ts` / `packages/renderer/src/style.css` / `packages/renderer/src/composables/panel/useVirtuaFollow.ts`；设计文档 ui-optimize-unified（设计档案已随 .tmp 清理，不入库），本条即两项裁决的现行登记处；运行态观感验收为用户真机自验项（D3 inspect verdict=degraded 无 blockers）。

### ADR-0132 引擎 provider 来源统一：启动时单向同步 pi→zcode（数据目录内副本 + merge 实时视图装载）+ 外部配置零写入（2026-10-12 设计落地，engine-provider-unification）

**决策**：runtime 组合根启动段（`packages/runtime/src/index.ts` 的 `runZcodeProviderStartupSync` 接线点，`sanitizeInvalidProviders` 之后）把 pi 侧 provider 配置单向同步为 zcode 校验源可读的副本——三读取源（models.json / auth.json / catalog 合并视图），其中凭据获取全部经既有凭据 resolver 单通道（机检红线 C-proc-14，`scripts/check-provider-credential-reads.mjs`），映射产物落 `<dataDir>/engines/zcode/pi-synced-provider-config.json`，形态 = 纯 pi 侧产物：providerRules 仅含 pi 映射条目与 zai 关联条目、providerOrder 仅含 pi 追加序，不透传真实文件内容（真实内容合并由读取时 merge 承载）。装载通道 = 两处同规则实装、对账单测锁步：wrapper fs 拦截（`appserver-launcher.ts` `mergeProviderConfig` 分支）与引擎校验链（`preparer.ts` `mergePersonalProviderConfig`）都读同一 merge(真实 `~/.zcode/v2/provider_config.json` 实时内容, 同步副本) 合并视图——真实条目优先、providerOrder = 真实现值序 + 副本独有 id 追加去重保序、每次读取重算无缓存；副本路径经既有 `ZCODE_ENG_PROVIDER_CONFIG` 锚点传递（语义收窄为 taiji 同步副本路径；`zcode-engine.ts` 赋值链与 preparer default 解析走同一 `resolvePersonalProviderConfigPath`），副本缺失/不可读时短路回落真实文件（零行为变化）。**红线：taiji 全程零写入 `~/.zcode/` 任何文件**（窄例外见 ADR-0143：standalone 账号元数据两条非秘密键）。家族边界：zcode builtin:/account: 家族不经内容同步；zhipu/zai 系官方 provider（zai-coding-cn/zai）走 token 关联特例——两前置同时成立（ZCode 桌面端 plan 已设置且特有 token 已生成 + taiji 已配 zai 系 provider）时副本生成个人关联条目 id=`zai-coding-plan`（anthropic 网关，baseUrl/模型清单读 zcode 内建目录 coding-plan 条目，apiKey = zcode 侧特有 token 只读引用，pi 原始 key 不参与），任一前置缺失不生成条目 + warn 指引。映射保守纪律（宁缺毋错）：凭据不可得 / 无 zcode 对应协议 / per-model 协议或 baseUrl 差异 / 同名让位（判定源 = 真实 provider_config providerRules、providerOrder、v2 config 字典带 key、cli config 字典按键存在，四源并集任一命中即让位）的条目一律跳过 + warn。失败语义 = 降级不阻断：读取失败保留上次副本产物 + warn、启动不中断；pi 映射条目归零时删除副本、全链回落真实文件。同设计包配置域半边：settings per-engine 默认模型进 `<dataDir>/agent/subagents/config.json` 的 `engineDefaults` 键（新 RPC `session.setSubagentEngineDefaultModel`，写入校验 ref ∈ 引擎模型清单），派发模型解析扩四层：task 显式 > agent frontmatter > engineDefaults > 引擎缺省（pi 路由恒不插层）。

**依据**：pi 与 zcode 的 provider 配置体系完全隔离，zcode 引擎校验源只认 `~/.zcode/v2/provider_config.json`——用户在 taiji 配好的 provider 对 zcode 引擎不可见（显式模型派发 `model_not_available`，而配置明明已配好，错误对用户不可理解）。直写真实文件不采用（taiji 与 ZCode GUI 互为多写方互踩、回滚语义缺失）；独立 env 双源不采用（两处合并逻辑漂移风险）；「wrapper 补注入合成条目 → Registry 装载」通道被 A0 探针证伪（zcode 0.16.9 Registry 个人 provider 供数直读真实 provider_config.json，补注入 cli config 的条目不被装载），据此改走 fs 拦截 merge 实时视图——校验链与 Registry 装载链读到同一视图，副本存在期间 ZCode 端配置变更对两消费方实时生效，副本缺失时全链回落现状行为。

**登记**：实装 = `packages/runtime/src/services/zcode-provider-sync.ts`（映射 + 副本编排）/ `zcode-provider-sync-wiring.ts`（启动接线）+ `packages/zcode-subagent-cli/src/preparer.ts` / `appserver-launcher.ts` / `zcode-engine.ts`；未新增约束族（凭据单通道沿既有 C-proc-14/15 机检）；副本落 taiji 数据目录内（数据目录隔离纪律不变）；设计文档 engine-provider-unification（设计档案已随 .tmp 清理，不入库），本条即启动时单向同步决策的现行登记处。

### ADR-0133 会话下挂内容回收统一归删主会话级联：三机制废弃 + 保留边界（2026-10-12 用户裁决）

**决策**：删主会话 = 事务性级联删除其下挂的一切内容（级联清单单一入口 = `packages/runtime/src/services/session/session-content-cascade.ts`；删除编排形态随 [ADR-0151](#adr-0151-session-维度存储布局反转ext-sessions-树--分区键-rootsessionid--整树软删2026-10-17-用户裁决session-store-layout-inversion) 布局反转收敛为四段——① 收殓（后台任务收殓先于删除）→ ② 插件 KV tombstone 前置登记（session-lifecycle 编排侧）→ ③ session 存储树 `<dataDir>/ext-sessions/<sid>/` **整树 trashDirectory 软删**（mac 进废纸篓可恢复 / 非 mac 降级递归硬删——树内域随树回收，无逐域删除动作）→ ④ pi 树内本体（主 jsonl 文件级 trash + sidecar 六段硬删）；fork 引用并集保护，被引用族树删前拷出暂存、树删后拷回 A 树残留）。「下挂内容生命周期 ⊆ 主会话生命周期」——下挂内容不再有任何独立回收机制，三条既有独立回收通道废弃删除：

1. **产物目录保留期扫描**（runtime `services/session/artifact-retention.ts`：7 天 mtime + 三树枚举保护，启动扫 + 每日复扫，`TAIJI_ARTIFACTS_KEEP_DAYS` env 通道）——产物目录在存储树域 2 内，回收由级联整树软删段承接（树删前无逐域 purge 动作）；startup-background-init 序列 ⑪ 挂载点随之摘除（编号保留不重排）。
2. **subagent 会话树 TTL GC**（subagent-core `session-file-gc.ts` 的 walkAndClean 族：30 天 mtime + `.alive` 探活 + 孤儿 sidecar/records manifest 清理）——子代理会话文件族落存储树域 9 内，随整树软删回收（sidecar 名单迁居 cascade `SUBAGENT_SESSION_SIDECAR_EXTS`，布局反转后用途 = fork 引用并集保护中被引用族文件收集〔含 sidecar 伴随〕与树外锚留痕，非逐域删除名单）；该文件收缩为 `engine-journal-gc.ts`（引擎 journal TTL 定时器 + worktree `.patch` 孤儿 TTL 清扫，`cleanupExpiredEngineJournals` / `startEngineJournalGcTimer`）。
3. **session-reader 导出物保留期清扫**（`sweepExpiredSessionViews`：export 写入点顺带 30 天清扫）——session-view 导出物由级联 A21 段承接。

**保留边界（非会话下挂域，不在本裁决射程）**：引擎 journal 30 天 TTL（`engine-journal-gc.ts` → `cleanupExpiredJournals`——journal 是引擎运行证据域，record 主数据死亡对 core 无触发点，无精确回收锚）；worktree `.patch` 回传件 30 天 mtime TTL 孤儿清扫（同文件 `cleanupOrphanWorktreePatches`，接线方传 agentDir 生效——`<sessionsDir>/<branch>.patch` 按 branch 命名、与 `.jsonl` basename 无关联，v2 条目契约不承载 patchFile/branch，级联引用并集〔record id ∪ sessionFile〕无锚可达，与引擎 journal 同性质只能按 mtime 兜底回收；清扫范围仅 subagents 各 enc 段 sessions 目录内的 `*.patch` 两层枚举，级联领地文件族不触碰；超龄后 `record.patchFile` 指针悬空 = 「续聊重建无备份」的既有降级形态承接）；zcode 隔离会话库条目 TTL（引擎侧 sweep，C-data-22——pi 侧 transcript 无独立 TTL 后两域不再有「同窗」绑定，窗口值 30 天维持）；workflow run 孤儿对账与统一保留维护轮（`run-state-evidence.ts`——判据本就以主会话引用集为锚，维持现状，换根扫新树）；main 域机制（log-retention / tts-cache 封顶 / gen-stats 窗口 / update 版本封顶 / image-cache 孤儿扫描——属 main 进程资源域，image-cache 孤儿扫描随布局反转换根扫存储树内 image-cache/ 域继续工作，active 会话缓存仍按保留期清理）。

**接受残留（显式不回收）**：外部删除主会话文件场景（绕过删除链路的直接 rm）的下挂内容残留；级联枚举/引用扫描失败时保守放弃族删除的残留（宁保留不误删 fork 共享文件）。

**依据**：三条机制都是级联缺失时代的兜底——级联补齐后同一文件族存在两个生命周期权威（TTL 按时间判、级联按归属判），先于级联触发即误删、后于级联触发即死代码；数据目录累积治理由级联单判据承载（原缺口登记已关闭删除，本条即权威记录，branch-review 三树枚举完备性检查提案的前提随扫描废弃消失）。

**登记**：CONTEXT.md「会话产物目录」词条 / data-source-registry.md #8 与 #51 删除通道 / runtime-layering.md 基线债登记 / permanent-session-model 资源生命周期表述同批回写；C-data-22 summary 的「与 pi transcript 同窗」限定随之改写（结构不变，`node scripts/validate-constraints.mjs` 复验）。

### ADR-0137 引擎模型 ref 派发期翻译：zai-coding-cn ↔ account:bigmodel-individual-coding-plan 等价对 + 其余 1:1 原样（2026-10-14 用户裁决，engine-ref-translation；取代 ADR-0132 的 zai 关联条目特例）

**决策**：pi 与 zcode 是两套独立 provider 词汇，跨引擎等价只在**派发期翻译**表达，禁止在 zcode 命名空间伪造 pi 词汇条目：

1. **翻译对（唯一跨世界等价）**：pi 的 `zai-coding-cn/*`（智谱 GLM coding plan 通道）与 zcode 的 `account:bigmodel-individual-coding-plan/*` 是同一通道的两个名字。派发非 pi 引擎时，四层解析产物（task 显式 > agent frontmatter > engineDefaults 偏好）经引擎翻译侧 `EnginePort.translateModelRef`（可选成员）改写为引擎原生 ref；模型段大小写归一（pi 小写 id ↔ zcode 目录大写 id），返回目标目录原生拼写。GLM plan 凭据完全归 zcode 账号体系（account 直通，2026-10-13 裁决），零 key 注入。翻译幂等（产物再入恒等）；record/上报侧呈现翻译后 ref（UI 跟随事实）。
2. **其余 provider 1:1 完全原样映射**：同步副本（ADR-0132 主体）维持直传 pi id/模型清单，不引入等价改写。
3. **两层失败语义**：显式层（task/frontmatter）翻译失败（目标通道缺失/模型无等价）= 派发同步期显式抛错（首败即停，自带恢复指引，record 创建前）；偏好层（engineDefaults）翻译后不在引擎清单 = 跳过偏好走引擎缺省 + warn（清单漂移不炸派发——历史遗留值如已退役的 `zai-coding-plan/*` 自动降级，settings 页可重选）。清单成员校验仅对实现 listModels 的引擎生效（undefined/null = 无枚举形态放行，引擎侧 validateModel 兜底；空数组 = 枚举形态在册但当前无可用模型 → 跳过）。
4. **退役清单**：ADR-0132 的 zai 关联条目特例（同步副本伪造 id=`zai-coding-plan` 个人条目、name 借用用户 plan 名）及其 2026-10-13 key 来源修订（pi 侧活凭据首选——违反「zcode 侧 GLM plan 不随 taiji provider 修改联动」）整体删除；`buildZaiLinkedEntry` / `readZcodeBuiltinPlanTokens` / `readCodingPlanCatalogEntry` 与 v2 token 读取链随拆，zai-coding-cn 在同步侧以 skip=translation-channel 登记（不映射条目）。
5. **清单侧同步扩展**：`listZcodeModels`（引擎）与 `deriveZcodeEngineModels`（runtime settings 派生）追加内建目录 `account:*` 直通家族枚举（无 apiKey 过滤，凭据在 zcode 账号体系；与个人 id 去重个人优先）——settings 页能直接选到用户自己的 plan（zcode 原生 ref），跨包同判据对账锁步。

**依据**：用户裁决原文「派发期翻译是对的。account:bigmodel-individual-coding-plan/* 这个等同于 pi 中 zai-coding-cn，其他的都是 1:1 完全原样映射」——pi 词汇 id（zai-coding-cn）与 zcode 词汇（account:/builtin: 家族）各归其位。ADR-0132 关联条目在 zcode 造 pi 词汇 id 且 name 借用用户 plan 名（身份与名字脱节）、key 来源修订使 zcode GLM 流量凭据随 taiji 改动联动，均与用户心智模型冲突（本机实证：engineDefaults 存 `zai-coding-plan/GLM-5.3-Flash` 压掉 zcode 自身 model.main）。

**登记**：实装 = `packages/zcode-subagent-cli/src/preparer.ts`（`translatePiModelRefToZcode` 翻译单源 + `resolveZcodeModelRef` account 分支前置）+ `zcode-engine.ts`（Port 成员实装）/ `packages/subagent-core/src/execution/engine/model-ref-translation.ts`（派发层共享编排，chat/workflow 两解析点同语义）+ `port.ts`/`registry.ts`（EnginePort.translateModelRef 可选成员）/ `packages/runtime/src/services/zcode-provider-sync.ts`（翻译通道 skip + derive account 段）；ADR-0132 文本保留作历史记录，冲突处以本条为准。

### ADR-0138 延续条目语义裁决：title 清单权威 / severity 本轮权威（2026-10-16 架构审查循环裁决，rfl-f5c7f1506）

**决定**：review-fix-loop 聚合器 R2+ 重报命中问题清单已追踪条目（延续条目）时，字段继承语义分两半——`title` 以清单侧已有值为权威（缺失才从重报回填），`severity` 以本轮显式标注为权威（在位即刷新）。实装 = `inheritCarryoverFields`（review-fix-loop-utils.cjs）单点。

**为什么**：title 是跨轮身份锚点（L1/L2 身份对齐依赖它），锚点稳定优先于措辞新鲜——重报换措辞覆盖会让下一轮标题对账失配；severity 是裁决等级，本轮审查者对当前事实的判定优先于历史标注。两者权威方向相反是有意为之，不是不一致。

**两侧差异裁决**：zcode 侧 workflow（`~/.zcode/workflows/review-fix-loop.dwf.ts`）现行 `prev.title = i.title` 无条件覆盖，与本裁决相反——属 pi 侧宽契约（title 可选）下的局部补偿语义与 zcode 侧必填 schema 的形态差异，登记为刻意差异（zcode schema title 必填 + 结构化门禁下空壳不可达），非漂移待对齐；两侧语义若要收敛，以本条为锚。

### ADR-0139 dormant 列表 = pending 单形态，复活即迁出（2026-10-16 架构审查循环裁决，rfl-f5c7f1506）

**决定**：`state.dormant` 列表中的条目恒为 pending 单形态——复活不在原条目上置 `revived` 标志位，而是在复活点把条目从 dormant 迁出（`state.dormant.filter` 移除），信息回到 issues 问题清单单一权威；`revived` 字段整体退役。

**为什么**：修饰字段形态下，dormant 的每个消费者（prompt 注入 / 对账分区 / 标题匹配器）必须各自记得过滤 revived，漏一处即身份分裂（同 id 同题同时存在于 issues 与 dormant，L2 标题对齐恒假歧义——实证探针见 rfl-f5c7f1506 round-1 MF-1-2）；迁出形态下三个过滤谓词结构性退役，匹配器无需任何新过滤。删字段形似丢信息，实际是消除信息双权威。

**回加禁令**：后续消费者依赖单形态后，回加 revived 标志需重审全部 dormant 消费点——禁止把本裁决当「丢失的簿记」修回来。

### ADR-0140 extension-host 请求通道以共享 factory 下沉为家族默认形态（2026-10-16 架构审查循环裁决，rfl-f5c7f1506）

**决定**：taiji 双壳（桌面 renderer / 移动 mobile-renderer）消费的 extension-host 请求通道——dialog / permission / form 三通道——通道算法（分区容器 / 快照对账 / 作答编码）单点下沉 `packages/ui/src/extension-host/` 共享模块（factory / 纯函数），壳侧只留策略回调与呈现差异。新增请求通道默认走同一形态，壳内自建通道算法副本是被禁形态。

**为什么**：form 通道曾是三通道家族唯一未下沉成员，核心双壳各一份靠镜像注释手工维持对齐（companion-bridge 11 处 + useExtensionUI 8 处「同构/镜像」注释），已发生第一处真实漂移（移动壳断连不清挂起 form，桌面壳清——用户可见后果为断连期僵尸 form 假成功提交）。dialog/permission 先行下沉的先例证明 factory 形态可行；第四通道再出镜像即是回归。

**边界**：呈现形态差异（桌面 tab / 移动堆叠、band 样式）留壳侧，不下沉；下沉对象是通道的**行为算法**，不是 UI。

### ADR-0141 StatusBar 底栏整体退役（2026-10-17 用户裁决）

**决定**：main-panel 局部底栏 StatusBar（`packages/ui/src/extension-host/StatusBar.vue`，26px 状态条）及其全部数据链删除——渲染层（组件 / status-bar-source 契约 / StatusBarController / PanelContainer 挂载）、core 数据链（bridge 的 `plugin:statusBarUpdate` / `plugin:statusSetUpdate` / `extension:status` 三解析器 + InternalEvent 三 kind + statusBarItem 贡献类型与 statusbar 挂载点）、runtime 转发链（event-adapter setStatus 翻译、interpreter status-set/status-broadcast、`server.handleStatusSetUpdate`、`plugin.ui.updateStatusBarItem` RPC、StatusBarRegistry、builtin statusline 插件）、shared 协议类型与 plugin-sdk 声明同批删除。pi 扩展的 `ctx.ui.setStatus` 调用保留（pi CLI 独立运行状态栏仍有意义；taiji 内 event-adapter 静默 noop，与 setTitle 同类已知落点）。

**为什么**：状态项的两个真实消费场景已被其他表面承接——pi 扩展状态（goal/todo 进度）由 Composer 任务托盘 widget 区与对话流内联呈现，插件交互入口由 headerAction 顶栏按钮区承接；底栏只剩低价值展示位。ADR-0015 的「plugin 不直写 UI、经 registry 中转」间接层随之失去服务对象。

**边界**：`plugin.*` WS 方法命名空间与 `message.status` 事件链（pi passthrough）不动；ContributionRegistry 其余贡献类型与挂载点不受影响。

### ADR-0142 翻译目标通道修正 + 部署形态翻译面（manifest modelTranslation）+ 生效回执（2026-10-16 用户裁决，engine-ref-translation D5；修订 ADR-0137 的等价对映射目标）

**决策**（三段，同一事故链的修复）：

1. **映射目标（2026-10-16 二次修订，证据驱动）**：`zai-coding-cn/*` 的 zcode 对应通道维持/回到 **`account:bigmodel-individual-coding-plan`**。同日首版曾改向 `account:zai-individual-coding-plan`（基于家族命名的推断）；随后凭据链实证推翻该推断——本机 `coding-plan-cache.json` 显示 bigmodel 家族 available、zai 家族 unavailable；`credentials.json` 只有 `oauth:bigmodel:*` 与两条 bigmodel plan api-key；GUI 成功日志 providerId = `account:bigmodel-individual-coding-plan`；pi 侧 `zai-coding-cn` 的 baseUrl 即 `open.bigmodel.cn/api/coding/paas/v4`（bigmodel 通道，名字带 zai）。ADR-0137 其余裁决（派发期翻译、两层失败语义、退役清单、清单扩展）全部维持。
2. **部署形态翻译面（RemoteEngine 补成员）**：ADR-0137 的翻译面只在 in-process 引擎类实装，staged 引擎 cli 形态（`TAIJI_AGENT_ENGINE_ROOTS` 发现 → RemoteEngine 代理）的 `translateModelRef` 缺席且无任何信号——2026-10-16 双会话实测：engineDefaults 偏好死值直穿引擎侧炸 `model_not_available`（16 个 subagent 批次全灭）、record 盖章未翻译 ref，修复语义在部署形态整体静默失效。修复 = 引擎 manifest 新增可选段 **`modelTranslation`**（静态翻译表声明，SSOT = `package.json taiji.subagentEngine.modelTranslation`），发现期快照携带（与 capabilities/modelCatalog 同模式：静态声明读快照不握手），RemoteEngine 构造器按声明装配/摘除 `translateModelRef` 成员（纯查表改写 provider 段、模型段原样保留；大小写归一与目录校验由引擎侧幂等再翻译承担——代理侧无内建目录，不复制该职责）。与 validateModel/setModel 同款形态映射：声明缺席 = 成员摘除，消费方 `typeof` 探测缺席语义。in-process 引擎类代码表与 manifest 声明表由对账锁步单测绑定（`preparer.test.ts` modelTranslation 锁步用例）。
3. **生效回执**：派发层翻译编排（`resolveEngineModelWithTranslation`）发现 `translateModelRef` 缺席时按 engineId 进程级一次告警（`has no model translation face`）——缺席语义（恒等透传）不变，但必须可观测。

**边界（远程形态偏好层成员校验，2026-10-25 实装后口径）**：远程形态 `listModels()` 为 union 门面——manifest 静态快照可枚举（`dynamic:false` / 非空静态目录）时同步返回快照；无静态枚举（省略 / null / `dynamic:true, models:[]`——zcode/pi manifest 均此占位形态）时发协议 `listModels` 帧取引擎活清单（async RPC，控制范围超时 `LIST_MODELS_REQUEST_TIMEOUT_MS` = 10s；连接复用路由 probe 已锚定的连接）。偏好层清单成员校验（`resolveEngineModelWithTranslation`，async）await 消费 union：远程形态的偏好死值在派发同步期即被成员校验拦截（跳过偏好走引擎缺省 + warn，与 ADR-0137 决策 3 同语义）；RPC 失败放行 + per-engine 一次性 warn（引擎侧 validateModel/run prepare 兜底，不拦截模型解析）。ADR-0137 偏好层降级语义自此在远程形态同样达成。仍不做的：engineDefaults 存量失效自动清理（D5 减法裁决维持）；写入时校验（u7，翻译感知扩展）为独立后续项。

**依据**：2026-10-16 用户裁决原文「全部修复。默认引擎应该用 zai-coding-cn/glm-5.3-flash（期望应该是自动翻译到 account:zai-individual-coding-plan/glm-5.3-flash）」（原始裁决命名的目标通道为同日中间态，决策 1 已按凭据链实证修正为 `account:bigmodel-individual-coding-plan`）；事故取证 = 双 pi 会话（01a14400 workflow 批次 16 失败 + 01a14414 派发测试 3/4 失败）+ 本机 bundle 指纹（运行版 v0.11.5 已含 ADR-0137 实装但 RemoteEngine 无 translateModelRef、staged manifest 无翻译声明）。

**登记**：实装 = `packages/zcode-subagent-cli/src/preparer.ts`（映射目标）+ `package.json`（modelTranslation 声明）/ `packages/subagent-core/src/execution/engine/engine-manifest.ts`（parseModelTranslation）+ `engine-inspect-package.ts`（快照组装）+ `client/remote-engine.ts`（成员装配/摘除）+ `client/manifest-lookup.ts`（查表实现）+ `model-ref-translation.ts`（生效回执）；engine-development-guide manifest 契约段同批补 modelTranslation 条目。

**镜像架构补充（2026-10-16 同日用户裁决）**：透传翻译的数据前提是「zcode engine 的 provider 配置副本 = taiji provider 的逐字镜像」。落地三点：① 同步枚举范围并入 auth.json 型 catalog provider（候选集 = models.json 条目 ∪ 凭据两源 id 并集 `listCredentialBackedProviderIds`；此前只读 models.json，xiaomi/kimi/minimax 等 catalog 型 provider 永不进镜像——StepFun 能透传而 xiaomi 被挡的事故根因）；② write-through：settings 域 provider 变更成功后经 `providersMutatedSync` 钩子重跑镜像同步（与启动同步同源同实现，失败只 warn 不阻断配置写入），启动同步保留作对账兜底；③ 零写死原则：全链唯一 provider id 写死点 = 翻译表那对等价对（代码表 + manifest 声明 + 同步 skip 集合三处同源），其余任何 provider 禁止落入代码（运行时翻译、配置镜像均为数据驱动的泛化路径）。同批修复：同步模块注释/skip 文案的目标通道以本 ADR 决策 1 为准——同日按 zai-individual 中间态改写 bigmodel 引用的动作已随决策 1 回退，相关注释/文案最终对齐 `account:bigmodel-individual-coding-plan`。触发点补充：④ 凭据域登录/退出同样经 `providersMutatedSync` 重跑镜像（与 settings 域共用触发点）；⑤ 串行化契约 = 组合根 `createZcodeProviderMirrorSync` 串行队列、latest-wins 重跑（触发不丢、不并发写同一副本）。


### ADR-0143 zcode 账号族凭据链实证 + app-server standalone 模式补丁（2026-10-16 用户裁决驱动排查）

**凭据链实证**（源码 = ZCode.app 3.15.3 `glm/zcode.cjs`；GUI = `app.asar`）：

1. **生成/存储**：OAuth 登录（GUI 或 CLI `login [zai|bigmodel]`）→ `~/.zcode/v2/credentials.json`（值 `enc:v1:` 加密）：`oauth:<family>:access_token` / `oauth:<family>:user_info` / `oauth:active_provider` / `zcodejwttoken`；plan api-key 键名模板（源码 `Q8e`）＝ `account-provider:coding-plan:<providerId>:account:<identity>:api-key`。plan 可用性缓存 `coding-plan-cache.json`（本机：bigmodel available、zai unavailable）。
2. **使用分两模式**（源码 `xCt` = startProcessProviderRegistryRuntime）：
   - **host 模式**（默认；`t.standalone` 未传）：account 态由宿主配置构造（`zcodeBuiltinProviders` 路径**硬编码 `entitled:!1`**），且**不注入本地 providerRuntimeHeaders 端口** → 模型请求前须向宿主发 `interaction/requestProviderRuntimeHeaders`，应答过 `yQt`（discriminatedUnion）解析。GUI 宿主（`zcode-agent-service`）日志「收到…已应用」即此路径成功形态。
   - **standalone 模式**（`{standalone:{}}`）：自建本地账号源（`readStandaloneAccountProviderConfigSnapshot`：读 credentials.json，**entitled 由「凭据存在性」计算**，无硬编码）+ 注入本地 `providerRuntimeHeadersPort`（`createStandaloneProviderRuntimeHeadersPort`）→ 账号族全链本地完成、零宿主依赖。
3. **headersApplied 根因（修正 ADR-0142 边界段的推测）**：taiji 引擎 spawn `node zcode.cjs app-server --cwd <dir>`（协议路径 `zcodeProtocolAgent`）恒以 **host 模式**创建 provider registry（源码 `create:r(()=>xCt(z),"create")` 不传 standalone）→ 需要宿主任应答；taiji 链上无宿主实现该协议（宿主日志零踪迹、失败路径日志亦未出现）→ 回来/兜底帧非合法形状 → zod `invalid_union headersApplied`。**不是 ZCode 自身 bug、不是凭据缺失**，是「headless spawn 落在 host-only 模式」。
4. **taiji 补丁（本 ADR 实装）**：launcher 内存补丁层新增第二处改写——锚定稳定串 `startProcessProviderRegistryRuntime:()=>`（取 minified 函数名）＋调用点 `create:r(()=>` → 注入 `,{standalone:{}}`；形态漂移 → 原文透出 + stderr warn。安装门日志增 `standalone-account=armed|off`。真机验证：`standalone-account=armed` 生效、翻译/盖章正确（`account:bigmodel-individual-coding-plan/glm-5.3-flash`）。
5. **当前阻塞（下一步裁决项）**：standalone 快照 `readStandaloneAccountProviderConfigSnapshot` 要求 `account-provider:<id>:identity`（缺则**该 provider 直接丢弃**；源码 `if(!I) return []`）与 `account-provider:<id>:auth-source`——本机 credentials.json **无这两条**（GUI OAuth 只写 host 态键）。写这两条的唯一手段是 ZCode 自己的流程：CLI `login [zai|bigmodel]`（浏览器 OAuth，写 standalone 态）或 SDK 导出 `configureCodingPlanApiKey`（api-key 形态：identity = `key-<sha256(key).slice(0,24)>`、auth-source = manual）。GUI 不调用后者（app.asar 0 命中）。**三选项待用户裁决**：A) 用户跑一次 CLI 登录写 standalone 态（零新 hack，推荐）；B) taiji 在 CLI 进程内自举调用 `configureCodingPlanApiKey`（零用户操作，但需把凭据传入 app-server 进程）；C) 回退 ADR-0132 式关联条目（api-key 个人 provider，完全绕开账号体系，10-14 已验证；逆转零 key 注入裁决）。

**终态（2026-10-16 真机端到端验证通过）**：补丁层三处改写（① entitled 翻转 ② standalone 选项注入 ③ **认证头端口注入**——协议路径 app 创建 `createZCodeApp:r(` 未传 `providerRuntimeHeadersPort`，app 因此回落 host 请求端口；②只修 registry 侧，③把 registry runtime 对象上的本地端口注入该 app 创建选项）+ 凭据库两条**元数据键**（`account-provider:<planProviderId>:identity` / `:auth-source`，明文即可——凭据库读路径以 `enc:v1:` 前缀判定加密，明文值直接可用；二者非秘密，秘密仍是 ZCode 自有 `oauth:bigmodel:access_token`）。真机结果：`zai-coding-cn/glm-5.3-flash` → 翻译 `account:bigmodel-individual-coding-plan/glm-5.3-flash` → **round completed（输出 "ok"）**，**零凭据注入**（taiji 不传任何 token/apikey，账号凭据全程 ZCode 自有）。安装门日志：`standalone-account=armed, header-port=armed`。

**元数据键幂等供给（2026-10-16 实施并真机验证；用户当日授权 hack 方式）**：launcher wrapper 在 spawn 前置步 `ensureAccountMetadata()`（调用点 = 安装门确认 standalone 与 header-port 两锚均已武装之后；未武装版本不写共享凭据库——这些键只被 standalone 账号源消费且账号链还要求认证头走本地端口）——从内建目录取 plan provider 清单（`access.type==='zhipu-account'`，数据驱动无 id 写死；过滤面宽于 3.15.3 standalone 快照判据但只多写非秘密键，跨版本 mode 值域演化下刻意不收窄），对每个 plan 每次 spawn 重算派生值：identity 优先以 `project-key-location:v1:[...]` 键内嵌 identity 为确定性信号（多 plan api-key 共存〔旧+新 account / 轮换残留〕时不取键序首个，2026-10 review DG-R2-1），无信号且 api-key 候选唯一时从当前 host 态键名 `account-provider:coding-plan:<pid>:account:<identity>:api-key` 派生，多候选无法确定时不猜测——保留既有 stored identity 并 log 歧义；auth-source 依 `oauth:<family>:access_token` 存在性取 `oauth`（否则 manual）。写入语义 = **缺时追加 + 孤儿值矫正**（2026-10 review MF-1-1）：既有非空值仍不无差别覆写（ZCode 登录/GUI 写入是权威），仅当它已无凭据支撑时才改写——`auth-source==='oauth'` 而对应家族 token 已撤销 → 换成当前派生值；identity 无对应 api-key 且当前可派生（仅 `auth-source==='oauth'` 时 identity 不参与查找；`manual` 形态即使 oauth token 同时存在仍按 manual 判定）→ 换成当前身份；修正逐条写 stderr（`account metadata reconciled`），否则账号切换/凭据轮换后旧值永久门控该 provider 且无自愈路径。写路径 = tmp+rename 原子写（保留既有文件 mode），失败只 warn 不阻断 spawn（非秘密键，真凭据始终是 ZCode 自有项）。并发边界：写路径为与 GUI 共享凭据库的无锁 read-modify-write 全量写回，与 GUI token 刷新并发存在毫秒级丢更新窗口——后果自愈（GUI 侧重试刷新 / 本侧缺键下次 spawn 幂等补齐），事实驱动原则下不加锁、不做时间补偿，登记为已知边界；元数据键的写入另有 compare-and-skip 防线（2026-10 review N-3）：写回前重读磁盘比对 identity/auth-source 两键，检测到并发写入（含重读失败）即放弃本次写入并 log、下次 spawn 幂等重算——矫正可能因检测到并发写入而放弃本次写入，恢复 = 重新登录/配置或删除该键。真机验证：手工删除四条键后直接派发——launcher 日志 `account metadata provisioned: …`（自动补齐 individual + team 两家族）且 `stop=completed`；省略 model 的偏好路径（engineDefaults=zai-coding-cn/glm-5.3-flash）同样 completed。测试：`appserver-launcher.test.ts`（供给 + 幂等不重写 + 存在性检查 + 撤销/轮换矫正契约回归 + 补丁产物自读等用例；计数不登记，避免随套件增长漂移）。

**多版本适配（2026-10-16 用户要求）**：本机仅一个 CLI bundle（`ZCode.app/Contents/Resources/glm/zcode.cjs`，3.15.3；`~/.zcode/v2/runtime/**` 的「多版本」只是 catalog 快照、无代码）。适配策略 = 锚点抗漂移 + 自检 + 变体回归：① 授权门锚 = 属性名（`zcodeBuiltinProviders.entries()` / `zhipu-account` / `entitled:!1`）窗口法；② 注册源锚首选**函数定义默认参数法**（导出映射 `startProcessProviderRegistryRuntime:()=>` 取 minified 名 → 定位**唯一且位于导出映射之前**的 `function <名>(e,t={})` → 改 `={standalone:{}}`；结构校验 = 恰好两个顶层参数、第二个以 `={}` 收尾、函数体窗口含 `standalone`/`credentialStore` 令牌，第二处同名定义/定义在导出映射之后/参数形态不符 → 放弃本锚，宁可 not armed 不改错位置；调用方省略第二参即 standalone、显式传 `{}` 的 skipUserConfig 路径不受影响），失败回退调用点注入 `create:r(()=>`（括号配平跳过字面量/模板/注释）；③ 端口注入锚 = `createZCodeApp:r(`（唯一）+ `.runtime.registryService` 动态取变量名 + `},"createZCodeApp")` 收尾。三处独立判定、各自 stderr warn（形态漂移不静默），应用态由 `patchedCliSource` 发布的 `__cliPatchStatus` 标志驱动（产物子串判定在真实 bundle 上恒真——3.15.3 已含 8 处 `providerRuntimeHeadersPort:`），端口锚单独命中同样交付（认证头注入为条件 spread——上游 `kEt` 的 `n.providerRuntimeHeadersPort ?? mai(e,t)` 宿主端口在本地端口缺席时不被 shadow）。**版本自检程序**：每次 spawn 首行安装门日志即兼容矩阵——`cli-config-inject / catalog-entitled / provider-merge / cli-source-bypass / standalone-account / header-port` 六项须全 on/armed；任一项 off 即该版本锚点漂移，按对应 warn 修锚点后重跑真机派发验证。变体回归测试：`appserver-launcher.test.ts`（minified 名变化 + 无调用点 + 变量名不同的模拟版本形态用例；计数不登记，避免随套件增长漂移）。

**ADR-0132 红线修订（2026-10-16 用户授权）**：本 ADR 的元数据供给写入修订 ADR-0132 的「taiji 全程零写入 `~/.zcode/` 任何文件」——仅允许写入两条**非秘密**元数据键（`account-provider:<pid>:identity` / `:auth-source`）；凭据仍全程 ZCode 自有、taiji 零 token/apiKey 注入、其余 `~/.zcode/` 文件仍零写入；该写入为用户 2026-10-16 授权的 hack 形态（ADR-0132 的 provider 配置零写入与副本落 taiji 数据目录语义不变）。

**登记**：实装 = `packages/zcode-subagent-cli/src/appserver-launcher.ts`（安装门 + wrapper 落盘）/ `appserver-launcher-patches.ts`（三处改写 + 元数据供给）/ `packages/zcode-subagent-cli/src/preparer.ts` + `package.json`（目标家族 bigmodel-individual）/ 测试 `appserver-launcher.test.ts`（含补丁产物自读回归）+ `preparer.test.ts`；`docs/todo/engine-remote-membership-face.md` 附录的「ZCode 自身 bug」结论按本条修正。

### ADR-0144 provider API Key 明文回显 = 用户手势触发的单点只读 carve-out + 远程客户端可达性裁决（2026-10-18 交付裁决，fix-provider-save round 1 MF-1-4）

**决策**：`config.revealProviderApiKey`（WS 请求；reply `config.providerApiKeyRevealed`）是 renderer 可达的唯一 provider 明文凭据通道，形态按五条红线收尾：

1. **api_key only**：只读 auth.json 中 `type === 'api_key'` 的条目与 models.json `providers[id].apiKey`；auth.json 的 OAuth 条目**结构性不可回显**——resolver 的 readRawApiKey 对 oauth 返回 notRevealable 且**停止向低优先源回落**（OAuth token 永不出协议，与 `config.hasOAuth` 同红线；回落显示 models.json 的历史残留值会误导用户）。
2. **单点读取**：唯一读点 = `ProviderCredentialResolver.resolveProviderApiKeyRaw`（port 契约 `IProviderCredentialResolver`），源优先级由 resolver 的 sources 数组单点声明（C-proc-14 机器检查 `scripts/check-provider-credential-reads.mjs`）；handler 只做「调用 + reply 解包」，禁自建第二套解析链。
3. **手势触发 + 无广播**：renderer 唯一调用点 = 设置页编辑体眼睛按钮的显式点击（草稿非空时是纯显隐切换，不发 RPC）；reply 只回请求方，不随 provider 列表或任何广播下发（密钥不常驻前端）。
4. **非持久化**：回显值只进编辑草稿（内存），renderer 不落盘、不进持久 store；保存不回写（回显值不构成 apiKey 变更）。
5. **原值语义**：`$ENV` / `!cmd` 配置串按原值回显（不展开、不执行）——回显语义 = 用户所存值，直接保存不会把引用改成明文。

**远程客户端裁决（显式接受可达性）**：WS 鉴权 = {spawn token} ∪ {remote token} 的集合成员校验，`connection-manager` 不记录单条连接由哪个通道认证；开启远程访问（LAN 监听）时，任一持有 remote token 的已配对客户端均可调用本 RPC 取回明文 Key。**裁决 = 接受，不在本轮改鉴权模型**：

- remote token 的既有定级即「LAN 完全控制凭据」（[registry](../architecture/data-source-registry.md) #52）：持有者可驱动同一 agent、经权限审批弹窗执行宿主侧能力（含读 `<piAgentDir>/auth.json`）并读取全部会话内容。明文回显通道**不新增能力类别**，只缩短一条路径；
- 通道级收窄（spawn-token-only）需 connection-manager 记录每连接认证通道 + 新增通道准入表 + 测试，收益是「已完全控制的凭据再少一条读取捷径」，与引入的鉴权簿记/回归测试不成比例；
- 远程访问默认关（ADR-0120：argv flag 不传即关态、纯回环监听），开态是用户显式动作；LAN `ws://` 明文传输是 ADR-0120 的既有登记取舍（remote token 本身同样明文过该链路），不在本通道单独收尾。

**重审触发**：引入「受限远程客户端」（非完全控制级 token / 通道级 capability）时本条必须重审——届时应改为 spawn-token-only 或独立 capability 门控，并同批补 auth-channel 簿记与测试。

**残余风险（不掩饰）**：ADR-0118 §3c 曾以「renderer 被注入后可直读凭据文件」为由把 localFile 读通道收窄到会话产物子树；本通道是同一威胁模型下的**有意有界例外**——renderer XSS 仍可调用本 RPC 取回明文 Key。边界依据：单 provider、只读、无写入/删除能力、OAuth 不可达、无广播、非持久化，暴露面限于「攻击者已能执行 renderer 任意脚本」的既有完全沦陷场景；对应收益 = 用户无需离开设置页即可确认/复制已存 Key（原先须手翻 auth.json）。纵深防线沿用既有 CSP + markdown 分通道净化，不在本通道内新增。**carve-out 不外溢**：本裁决仅适用 provider api_key；其他凭据家族（TTS Key 等）维持「不回传出站」原红线（入站 configure 由用户显式粘贴承载，registry #49）。

**已接受的显示态残留**：外部轮换 api_key 而 `apiKeySet` 保持 true、`authMethod` 不变时，广播只携带布尔（`ProviderInfo` 无凭据指纹），编辑体无法察觉回显基线已过期——继续把旧值当作「所存值」展示；保存永不回写（`resolveApiKeyChange()` 对回显基线返回 undefined），恢复动作 = 关闭重开编辑体（重新回显按需读盘）。结构性消除需给 `ProviderInfo` 增凭据指纹（如 `apiKeyVersion` / `credentialUpdatedAt`）并在指纹变化时作废回显，禁止用时间推测代替。

**登记**：数据源 = [data-source-registry.md](../architecture/data-source-registry.md) #65（provider 凭据与明文回显读通道）；约束 = 复用 C-proc-14（单点读取机器检查）与 C-data-01（单写 owner），**未新增约束族**；行为红线由 `packages/runtime/src/services/auth/__tests__/provider-credential-resolver.test.ts`「回显原值」组（oauth 不回落 / `$ENV` 原值 / custom 源）与 `packages/runtime/src/transport/settings-message-handler-reveal-apikey.test.ts`（reply 形状 + 单 reply）锁定。

### ADR-0145 引擎 spawn 权收归 runtime + EngineTransport 双实现 + prompt response 唯一送达回执（2026-10-18 设计落地，relay-spawn-transport）

**决策**：

1. **进程拓扑**：托管态（runtime 存活）下引擎进程 spawn 权收归 runtime（subagent control server）；extension 只做控制客户端（`RuntimeEngineTransport`）。standalone（无 control env）继续 local spawn（`LocalEngineTransport`）。选择谓词单源 = SDK `isControlEnvActive`（`TAIJI_SUBAGENT_CONTROL_SOCKET` 非空 → runtime；空串/缺失 → local）；托管态连接失败显式报 `engine_transport_unavailable`，不静默回落 local。
2. **传输契约**：`EngineTransport`（open/writeFrame/onFrame/onExit/close）定义在 extension ↔ engine 接缝，local 与 runtime 两实现共用；engine-protocol 语义（握手 / 请求-应答关联 / 反向路由 / 崩溃重建）留在 `EngineClient`。回执不放进 transport（transport 不理解 pi 协议），留在引擎的 run 生命周期。
3. **送达回执语义**：`prompt` response 是唯一成功回执（pi 语义锚点 = PS-81，`docs/pi-semantics.json`；探针 `pi-semantics-prompt-response.test.ts`）；stdout 活性只用于零输出判定（prompt 写入后 30s 完全零输出 → `engine_prompt_not_delivered`）；pi 显式拒绝 → `engine_prompt_rejected`；stdin 不可用/EPIPE → 立即失败。**不加重试**（prompt 可能已产生副作用）。
4. **实时流**：引擎以 fd3 raw mirror 保留 GUI live 流（runtime 注入 `TAIJI_ENGINE_RAW_MIRROR`；引擎 tap `child.stdout` 原始字节）；runtime 侧 `SubagentMirrorHub` + `SubagentTee` 翻译，seq 空洞 → `degraded:true`（停止发布 live 帧，reload 从 pi session/JSONL 恢复）；tee 是权威数据的派生视图，不是第二权威。
5. **relay 退役**：relay 代理脚本与其协议探针/常量/接线整体删除——`packages/runtime/src/infra/relay/**`、SDK `relay-env.ts`/`relay-frames.ts`、core `./relay-env` 子入口、extension 的 relay 测试、bundle/verify 的 relay 资产拷贝与校验。
6. **控制连接复用键**：extension 进程级共享 control 客户端按 `(socketPath, rootSessionId)` 复用（引用计数，归零 dispose）。一条控制连接只服务一个根会话——连接上首个 `engine_open` 固定 `rootSessionId`，通道关闭不重置，异根 open 以 `engine_open_failed{session}` 拒绝；无 run 上下文的探针以 spawn 期 temp 根独立成连接，不占用真根连接。实现 = core `transport/control-shared.ts`（`controlClientKey`）+ `transport/control-client.ts`（共享表/refcount）+ runtime `control-server.ts`（连接级根绑定）。
7. **raw mirror seq 口径**：写侧 seq 按 `recordId` 在引擎进程内单调递增（跨 run 接续；丢弃也递增；首帧为 0），读取侧 record 生命周期 = 通道（= 引擎进程），两侧口径一致（读取侧坏帧/丢弃则表现为后续帧空洞）。任一 record 首帧非 0 或后续非 `last+1` → 该 record `degraded:true`，停止发布 live 帧；磁盘镜像与 reload 不受影响，其它 record/channel 不受影响。实现 = `packages/pi-subagent-cli/src/raw-mirror.ts`（`RawMirrorSeqRegistry`）+ runtime `mirror.ts`（`isMirrorSeqContinuous`）。
8. **down 方向每帧恰好投递一次**：`stdin.write` 返回 false 只表示内核缓冲已满，该帧已被 Node 受理——不入队重写；背压期（`downAwaitingDrain` 或队列非空）到达的帧只入队，drain 时按 FIFO 各写出一次。上限判定只在真正入队时执行（per-channel 32MB/4096 帧 + 连接聚合 256MB），越界显式 `engine_backpressure_overflow` 并只关触发通道。实现 = runtime `control-server.ts` `writeDown`/`flushPendingDown`。
9. **degraded 可见性（本轮实现边界）**：`markDegraded()` 只改 tee/查询态，不发布推送帧；`degraded` 在 `session.getSubagentStreamState` 拉取时落到 core 流状态机（拉取触发 = 订阅建立 / chunk 失步）。语义 = 重开/刷新后 visible；drawer 已开且 seq 空洞后无新 chunk 时提示条不即时出现。即时推送面未实现，偏差明细登记 impl-plan DC-8，由后续批次承接。
10. **非缺省引擎首轮 probe→run 换代接受双 spawn**：per-root 键选型下，非缺省引擎新会话首轮 probe 以 spawn 期 temp 根建连并 spawn 引擎；run 携带真根时换代——旧通道只发 control `engine_close`、不先发 engine-protocol dispose，runtime `ENGINE_CLOSE_GRACE_MS`（3s）走满后按进程组终止旧引擎并 spawn 真根引擎。接受为启动延迟成本（非功能错误；缺省 pi 免探不受影响），度量基线 = 启动延迟 +20% 重审；优化选项 = probe 携带权威根 / 换代前先 dispose。偏差明细登记 impl-plan DC-12。

**依据**：事故根因 = relay 的 `drain` 早于 `accept`（stdin 无监听即 resume，大 prompt 静默丢失且无回执）+ 两个进程所有权；用户裁决的修复方向 M1（显式状态机 + 任务文本截断）→ M2（回执与零输出判定）→ M3（spawn 权收归 runtime，relay 删除）。设计文档 relay-spawn-transport（设计档案已随 .tmp 清理，不入库）。

**登记**：实装 = `packages/runtime/src/infra/subagent-control/**`（control server / channel / mirror / tee / sweep）、`packages/subagent-core/src/execution/engine/client/transport/**`、`packages/pi-subagent-cli/src/{prompt-ack,raw-mirror}.ts`、SDK `protocol/control-protocol.ts` + `control-env.ts`；约束 C-proc-09 scope / C-proc-18 计数源 / C-proc-25 kill 链 / C-ext-27 子入口已同批更新；文档 = `architecture/subagent-engine-protocolization.md`、`architecture/env-propagation-boundary.md`、`TROUBLESHOOTING.md` #6-#9、`extensions/subagents/engine-development-guide.md`。

### ADR-0146 result-collect 批量收取：collectKey 类型化提交选项（取代附录 C② meta 预留）+ 端口层挂起分流 + collected 终局枚举 + timeout 缺省 3_600_000（2026-10-17 交付，result-collect phase 2 设计定版）

**决策**：agent 经 `collect_results` 工具一次阻塞等待、批量收取并行后台任务（bash/subagent/workflow/managed）终态；被收取的通知不再注入对话流。四项架构裁决：

1. **collectKey 走类型化提交选项，`DeliveryEnvelope.meta` 删除**——取代 phase 1 统一投递附录 C② 预留的「关联 = meta.collectKey（envelope additive meta 透传，内核零读取）；meta 的 port 端点承载随 collect 立项实装」口径（显式推翻）：meta 是「内核零读取」的无名透传位，而 collectKey 恰恰要被端口层读取消费，无名透传会把消费关系藏进签名之外；类型化选项 `DeliveryDeliverOptions.collectKey: string[]` 把「谁读它」构造性写进签名。改道后 meta 预期消费方清零（全仓 grep 六处申报落点均不带 meta），零调用方预留通道删除——真出现第二个附带数据消费方时再按其真实形态建通道。内核 msg.meta 透传链退役评估另登记 docs/todo（runtime 投递路径 notify-once D2 仍活跃，不随删）。
2. **挂起分流在端口层、不进投递内核**——deliver 入口按「collectKey 键集 ∩ 在途等待集」分流命中即挂起（纯内存缓冲）；内核是跨投递路径共享组件（runtime 文本投递 + pi 通知投递），collect 是 pi 通知投递路径的消费语义，进内核 = 通用组件承载特定消费方语义。挂起不独立持久化（投递日志即耐久层，受理前落盘），崩溃恢复走既有差集重放按 push 重投，零丢失由日志层构造性保证。
3. **ack outcome 词表扩 `collected` 新枚举值**——不复用 `delivered`：语义不同（delivered = 注入对话流；collected = 随工具结果到达），复用会让「对话流里该有一条通知」的推断失效（排查误判源）；outcome 词表既有 discarded 先例。
4. **collect_results timeout 缺省 3_600_000（小时级）**——对「超时默认原则」（AGENTS.md 规则 19：任务级缺省不限时）的显式偏离：① collect 超时不是墙钟判死——超时返回是等待器诚实返回（任务不受影响、stillOpen 列出、恢复 push、可续 collect），不在规则 19 反对的「执行体自作主张杀任务」语义域；② 缺省必须有限：等待原语的孤儿形态（无到达边沿）+ 不限时缺省 = agent 永久挂死无信号，违反事实驱动「失败显式上报」；③ 量级按被保护对象校准——collect 等待一批任务级对象（长任务常超 10 分钟），按规则 19 对任务级兜底的小时级量级取 3_600_000，显式 timeout_ms 可调紧。

**依据**：phase 1 附录 C 自述「collect 设计时复评以上四点」预期内的复评结论——meta 无名透传与「端口层读取消费」的冲突是结构性证据；三候选方案（A 端口挂起区 + 提交选项 / B 工具轮询 + 抑制渲染 / C 复活旧中枢）中 B 被 append-only 契约与时间平抑红线双击穿、C 与 phase 1 收敛方向对冲（方案对比否决记录见设计档案）。

**登记**：实装 = `extensions/shared/delivery-port/src/types.ts`（collectKey 选项 + handle collect 面 API 类型 + meta 删除，commit e2e4d7f04）+ `delivery-port.ts`/`journal.ts`（挂起分流/四态快照/collected 终局/键集落盘，commit abc9168ea）+ `extensions/universal/pending-notifications/src/index.ts`（collect_results 工具，commit 9b5277e78）+ 四生产方申报链（commit d29c93a81）；设计档案 result-collect（已随 .tmp 清理，不入库），本条即该四项决策的现行登记处；docs/FEATURE-PRIORITIES.md 通知系统条目同步。
### ADR-0147 LLM 出站代理注入点：pi extension 安装 undici 全局分流分发器，按主机名规则匹配（2026-10-18 设计裁决，llm-network-proxy）

**决策**：LLM 出站代理（境外服务商经 HTTP/SOCKS5 代理出站、境内直连，按服务商配置分流）的注入点 = pi extension 在 pi 进程内构造自定义 undici 分发器并 `setGlobalDispatcher` 安装，按「请求目标主机名」后缀匹配规则决定走代理或直连，分流点同步计数。外部 undici 包写入的全局分发器槽与 Node 内置 `globalThis.fetch` 读取的槽一致（`Symbol.for` 注册表跨实例共享，Node 24.11.1 + undici 7.28.0 实测；归档探针 = `scripts/network-proxy-drift-probe.mjs`，pi 升级复跑）。

**不采用**：① spawn 注入 `HTTPS_PROXY` 环境变量——路由语义受 env 变量表达力限制（无结构化规则、无快速添加数据源）、请求量观测无实现位（env 路由在 pi 进程内完成，taiji 侧无统一计数点）、且需放宽 `ENV_WHITELIST_PREFIXES` env 传播边界（安全边界改动）、依赖 pi 自装分发器的未承诺行为；② extension 自建本地中转网关 + 改服务商 baseURL 指向网关——把网络层代理上移成应用层网关，需自建转发服务器全套（鉴权头桥接 / 流式透传 / 错误归因），与用户已有自建网关用法重复，且 pi `registerProvider` 覆盖语义与 taiji provider 管理冲突。

**登记**：实装 = `extensions/universal/network-proxy/`（分流分发器 + 配置热重载 + 计数落盘）+ `packages/shared/src/network-proxy.ts`（配置 schema 与校验）；验收工具 = `scripts/network-proxy-mocks/`（mock 代理 / 最小 SOCKS5 服务，自签证书 mock LLM 端点）；漂移探针 = `scripts/network-proxy-drift-probe.mjs`。设计过程产物 llm-network-proxy（已随 .tmp 清理，不入库，git 不可追溯），本条即该裁决的现行登记处。

### ADR-0148 代理凭据与 pi API key 同安全模型：明文 + 文件 0600，不引入跨进程加密（2026-10-18 设计裁决，llm-network-proxy）

**决策**：LLM 网络代理的代理服务器凭据（用户名/密码）明文存 ext-config 文件，文件创建时显式 `mode 0o600`（目录维持 0755）——与 pi 自身 `auth.json` 存 API key 的文件级安全模型一致（实测 pi 与 taiji 两侧 `auth.json` 均为 0600、所在目录均为 0755，pi 的保护在文件级不在目录级）。不引入加密：Electron safeStorage 是 main 进程 API，runtime（Node 子进程）不可用，为非服务端凭据引入跨进程加密通道复杂度不成比例。runtime 侧写入路径须携带 mode：`packages/runtime/src/utils/fs-utils.ts` 的 `atomicWrite` 基建以 umask 默认产 0644，为该配置落盘增加 mode 透传（或写后 chmod），此文件固定 0600；锁文件独立于配置文件，mode 差异不影响锁语义。

**登记**：实装落点 = `packages/runtime/src/services/network-proxy-config.ts`（写侧，mode 0600）+ `packages/runtime/src/utils/fs-utils.ts`（atomicWrite mode 透传）+ `extensions/universal/network-proxy/`（读侧，`llm-shared` 的 `saveConfig` 已带 0o600——`loadConfig` 为读侧函数，不涉及 mode）。设计过程产物同 ADR-0147（不入库），本条即该裁决的现行登记处。

### ADR-0149 请求统计 = 追加式 JSONL + 读侧聚合，截断保尾 5MB/1MB（2026-10-18 设计裁决，llm-network-proxy）

**决策**：「经代理 / 直连」请求量统计的落盘形态 = 追加式 JSONL（`<piAgentDir>/network-proxy-stats.jsonl`，每行一个 `{ ts, host, proxied, direct }` 增量片段，pi 进程每 turn 结束 flush）+ runtime 读侧按时间范围与重置水位聚合（多 pi 进程并发写安全的前提 = 单行 O_APPEND 单次 write 原子性，由并发追加写单测锁定——实现改分片 write 或非追加通道即红灯）。重置 = runtime 追加一行 `{ type: "reset", ts }` 水位标记，读侧只累计最后一个标记之后的增量行。物理清理 = 文件超 5MB 触发截断、保尾最近 1MB（约最近一万条增量记录），由 runtime 读聚合入口持文件锁原子重写，extension 写侧保持纯追加不做截断（避免多进程重写竞争）；「累计」视图语义因此 = 截断保尾窗口内的累计，统计卡对超窗历史收缩显式标注。坏行（无法解析的行）读侧跳过并记 warn，不因损坏行失败。

**不采用**：单一 JSON 累加重写（主会话与 subagent 多 pi 进程并存，重写互相覆盖）；经 select 通道推送（低频聚合数据套高频事件流机制，复杂度不匹配）。

**登记**：实装落点 = `extensions/universal/network-proxy/`（写侧 flush）+ `packages/runtime/src/services/network-proxy-config.ts`（读聚合 + 截断）。设计过程产物同 ADR-0147（不入库），本条即该裁决的现行登记处。

### ADR-0150 分流器未命中流量委托 pi 原生分发器，不自建默认 Agent（2026-10-18 设计裁决，llm-network-proxy）

**决策**：LLM 网络代理分流分发器的未命中分支（规则与 noProxy 均不命中的流量）委托**安装前捕获的原分发器引用** `dispatch`——即 pi 启动时自装的 `EnvHttpProxyAgent`。未命中流量因此保持 pi 未装本扩展时的确切行为：独立 pi 用户的 env 代理路由（`HTTPS_PROXY` / pi settings `httpProxy`）、连接调优（`connect.autoSelectFamilyAttemptTimeout: 2000`）与防崩溃 error listener 全部不丢失。**不自建默认 `Agent` 兜底**：undici 全局分发器槽在模块加载时即初始化为默认 `Agent`，pi 启动即自装 `EnvHttpProxyAgent`，「捕获引用为空」无已发生证据——为它保留自建 Agent 分支是不可达路径的实现与测试义务；若该前提被未来 pi 版本打破，委托调用直接 TypeError 暴露（fail-fast），不静默降级为「看起来正常的直连」。

**登记**：实装落点 = `extensions/universal/network-proxy/`（分流分发器）；未命中委托语义的回归断言 = 验收场景 13（双 mock 代理对照：规则外流量经 env 代理、规则内流量经扩展代理，两代理记录目标集合无交叉）。设计过程产物同 ADR-0147（不入库），本条即该裁决的现行登记处。

### ADR-0151 session 维度存储布局反转：ext-sessions 树 + 分区键 rootSessionId + 整树软删（2026-10-17 用户裁决，session-store-layout-inversion）

**决策**：taiji 自有的全部 session 维度持久化数据（除 pi 宿主管辖的会话 jsonl 本体及其紧贴 sidecar）统一落 session 存储树 `<dataDir>/ext-sessions/<sessionId>/<domain>/`——一个 session 一棵树，树内按 domain 分层；物理布局的分区键从 domain 反转为 sessionId，使目录结构与「数据生死由 session 决定」的生命周期语义一致。pi 宿主子树（`<dataDir>/agent/`）不动。

1. **布局反转范围 = 全部 11 域**：图片附件（attachments/）、会话产物（artifacts/）、toolResult 图片缓存（image-cache/）、插件 KV（plugin-data.json）、后台任务登记（background-tasks/）、会话导出（session-view.md）、btw 线会话（btw/）、画布（canvases/<canvasId>/，1:N）、subagent 记录（subagents/{sessions,records,model-switch}/）、workflow 运行状态（workflow/runs/）、会话日志（logs/，文件名去 sid——sid 已在路径；create-rekey 场景 tee 随真实 id 迁树：`migratePiSessionLogTree` 目标同名跳过+warn、迁空删目录、fs 失败 best-effort）。旧推导函数（`getAttachmentsDir` / `getImageCacheDir` / `getSessionArtifactsDir` 等）原符号改公式返回新布局，调用方零改。**不采用**：直接挂 dataDir 根（`<dataDir>/<sessionId>/` 混排——根目录语义混杂，域名目录与 uuid 目录不可分辨）；挂 `<dataDir>/agent/` 子树（pi 宿主域，混淆「谁写谁管」所有权边界）。
2. **分区键反转（域 7/9/10）**：btw 线、subagent 记录、workflow run 的目录分区从 encodeCwd（按项目目录聚合）改为 rootSessionId（记录字段是既有的 session 关联权威：subagent = ExecutionRecord.rootSessionId，workflow = run 创建记录 rootSessionId，btw = 主会话 id），encodeCwd 目录层消除。**P7 代价（已裁决接受）**：「按项目聚合」的目录语义消失，跨 session 盘点某项目的记录需要按 rootSessionId 字段全根遍历过滤（字段级关联权威既有，events-projection 已按该字段过滤）；重审触发 = 跨 session 按项目盘点的真实需求出现时（届时评估树外二级索引或导出工具）。孤儿树（rootSessionId 指向的会话已不存在）运行期不新增回收机制——正常删除总是整树删，孤儿只来自绕过应用的外部删除，残留语义与既有域 9 同口径。**btw 孤儿补账退役**：`btw-orphan-reconcile.ts` 整文件删除——它扫旧布局两层目录、判据是「主会话文件解析落空即删线目录」，反转后线树与主树在 `<root>/` 一级同名同形（都按 sessionId 分区），该判据扫新根会误删存活线树；应用内删除总是整树回收（线随主树；closeLine 同步软删线树），补账原服务场景只剩外部删除/删除失败残留，接受（删除失败已 warn 汇总出声）。
3. **画布归属不变量（D4）**：画布落 `<root>/<ownerSessionId>/canvases/<canvasId>/`，归属即路径；一张画布有且仅有一个归属 session，画布的创建与访问校验归属（`canvas.list` 按归属过滤、跨会话访问返回 `forbidden` 结构化拒绝），session 删除级联删除其全部画布（随整树）。协议破坏性重构（裁决 14）：`canvas.mutate` 的 sessionId 必填，不做旧字段兼容。一个 session 可有多个画布（1:N）；0 张画布时托盘按钮隐藏；overlay payload 携带归属 sessionId。**领域事件流（CanvasCreated 等）data 不承载归属**——事件流文件物理上就在归属树 `<root>/<ownerSessionId>/canvases/<id>/events.jsonl` 内，重放经 loadAll 从落盘路径重建归属（服务层 withOwner 唯一收尾，`canvas-foundation.ts` CanvasDomainState = Omit<CanvasState,'ownerSessionId'>）；前序分析 §八.1 第 5 项「CanvasCreated 事件 data + sessionId」按此收窄不采用（data.sessionId 是路径+文件位置之外的第三重冗余）。领域模型登记见 [domain-model.md](../domain-model.md) 画布域；renderer canvas store 迁回 `useSessionScopedState` per-session Map 分区范式内（`stores/canvas.ts`，cleanup 挂 `triggerSessionCleanups`——[ADR-0049](#adr-0049-per-session-map-分区范式最高频引用) 例外清单从未登记 canvas store，本次反转后该判定随之失效删除）。
4. **删除级联收敛 = 整树软删（D5）**：session 删除编排收敛为四段（`session-content-cascade.ts` 实装 ①③④、`session-lifecycle.ts` 实装 ②）——① 收殓（reapBackgroundTasks 杀在途后台进程 + 写 orphaned 终态，**先于一切删除动作**，整树删除不得吞掉收殓）；② tombstone 前置登记（插件 KV 迟到写拦截，先于树删）；③ 整树软删（`<root>/<sid>/` 调 `trashDirectory` 进废纸篓——mac 走 trash CLI/Finder，非 mac 降级 `rmSync` 递归硬删）；④ pi 树内本体（主 jsonl 文件级 trash + sidecar 六段硬删——小体量元数据，主文件已走废纸篓）。**删除语义变更**：画布从无删除路径到随树软删（新增回收能力）；附件/产物/图片缓存/后台任务/导出/subagent 文件族/会话日志从硬删/逐文件 unlink/保留期清理变随树软删——删除可恢复，代价 = 废纸篓暂占磁盘（量级：长会话含大附件时单树可达百 MB 级以上；重审触发 = 「删除后磁盘未释放」成为实际困扰或单树占用异常增大，届时评估大会话可选硬删 / 应用内清空废纸篓入口）；被保留期清掉的文件仍走硬删（清理语义不变，只有「会话删除」走软删）。旧逐域删除段（subagent 文件族清单删、session-view 导出物、后台任务 registry 目录）随收敛退役。**fork 引用转移 = 回退**（分支规则实装结论）：被引用文件的指针落点 = B 的主会话 jsonl 中 subagent-record v2 条目的 sessionFile 字段，形态为绝对路径，改写落点是 pi 宿主 jsonl 本体且 runtime 无 pi 契约通道可达——按预设分支回退：树删前把被引用族拷到树外暂存、整树软删后拷回 A 树残留，B 的绝对路径引用自然可解析；A 树残留不随 B 删除消解、无保留期扫描兜底（fork 共享场景专属，与域 9 残留同口径）。
5. **存量保留策略（D6）**：不做迁移器——旧布局数据原位保留、不再读写（读侧写侧全部换根，天然不再触旧位置）；旧数据成为静置磁盘留存，需要时人工取回（手工清扫指引见 [TROUBLESHOOTING.md](../TROUBLESHOOTING.md)）。旧会话重开的分域取舍：聊天流文本正常恢复（jsonl 本体不动）；附件徽章/缩略图不可见（segments.json sidecar 留旧位置，回填降级为占位文本）；旧画布不可见；旧产物 HTML 预览/源码读取降级为占位（读通道准入前缀只认新树，旧路径 `out_of_whitelist` 回落既有通道）；toolResult 图片仍可见（base64 源在 jsonl 本体内，打开会话时按当前路径公式重落盘进新树——派生缓存自愈）；**btw 线与 subagent 会话记录对话内容级消失**（线列表/任务面板从新树扫描重建，升级时点活跃的 btw 线重启后无法继续对话）。删除升级前创建的旧会话时，旧布局衍生数据不被回收（删除编排只回收新树 + pi 树内本体）——11 项残留为显式取舍，与「不迁移」同向。
6. **豁免清单（D7，不入树的八类边界）**：① session jsonl 本体与紧贴 sidecar（pi 宿主管辖 + 会话本体元数据）；② 全局日志（`runtime-<date>.log` / `main-<date>.log` / `renderer-*` / `plugin-crash-*` / `crashes/` 等无 sessionId 的日志）；③ `<dataDir>/engines/`（引擎级：zcode sqlite 单库、journal 按 taskId）；④ `<dataDir>/gen-stats/`（模型维度）；⑤ `<agentDir>/subagents/` 根下引擎级三件（config.json / engines.json / worktrees.json）；⑥ 存于 session jsonl 内部 custom entry 的 extension 数据（goal/todo/scheduler/pending-notifications/notify-ledger 等，天然随 jsonl）；⑦ 全局配置散文件与全局域目录（config.json/plugins/secrets 等）；⑧ `<dataDir>/defaultSession/`（默认会话目录，用户裁决 2026-10-22——landing 目录选择弹层「默认会话」固定入口指向的工作区落点，推导单点 = `packages/shared/src/paths.ts` `getDefaultSessionDir`，runtime 启动 ensure 存在；它是用户的普通工作区目录〔会话的 cwd 落点〕非任何 session 的衍生数据，目录生死不由单个 session 决定，删会话不删它，故按「session 维度」判据不入树）。relay tee（`pi-relay-<date>-<recordId>.jsonl`，键为 recordId 非 sessionId）定档留全局 `<dataDir>/logs/`。「session 维度」判据：数据的生死由单个 session 决定 + 物理形态可按 session 分目录。**树内遍历规约**：各遍历点（image-cache 孤儿扫描、读通道产物前缀枚举、日志保留期清理）遇到一级目录名非合法 sessionId 形态（`isPiSessionId` 校验）一律跳过——防非会话目录被误清。
7. **防漂移对拍机检（D8）**：路径推导唯一权威 = `packages/shared/src/paths.ts`（`getSessionStoreDir` + 11 域具名函数 + 子域函数，sessionId 入参统一过 `isPiSessionId` 同域校验防路径穿越）；extension 侧镜像公式（base-tool-enhance / system-prompt 不 import shared）与引擎侧推导的字面量一致性由 `scripts/check-artifact-dir-formula-sync.mjs` 对拍机检（对照验证，differential testing）扩展覆盖（存储树根段三方对拍 + 树段形态断言），pre-commit 触发。
8. **新域接入规约（G4）**：两步——树内新增 domain 目录 + shared/paths.ts 新增一个具名推导函数；删除随整树自动覆盖，无需修改删除链、无需登记任何清单。

**依据**：现状布局下「删 session 清衍生数据」靠删除链逐域拼路径逐目录删（长度随域数量线性增长，漏挂 = 残留）、「session 用掉哪些资源」无法机械回答、画布无 session 层无法做会话隔离——根因是分区键（domain）与生命周期键（sessionId）错配。反转后回收/盘点/隔离都成为对一棵树的操作。用户裁决：根名 `ext-sessions`、subagent/workflow 入树（接受 P7）、存量不迁移、整树软删、会话日志入树、协议可破坏性重构（裁决 9-14）。

**登记**：实装 = `packages/shared/src/paths.ts`（推导 SSOT + `PI_SESSION_TREE_SEGMENTS` 纳入树根段）/ runtime 域写读点（attachment-store / session-data-store / image-cache 孤儿扫描与软上限 / btw-service / logger tee-crash-保留期 / signal-forensics）/ `apps/electron/main/utils/local-file-prefixes.ts`（读/预检通道收窄后准入 = 按现存会话枚举 artifacts 前缀）/ subagent-core path-encoding 族（直连 shared 函数族单源 import——无镜像公式、无对拍需求，漂移风险结构性消失；对拍机检覆盖的是仍持镜像的 extension 侧读点）/ subagent-workflow jsonl-run-store 与 session-lifecycle / canvas-service / `trash.ts`（`trashDirectory` 目录级软删）/ `session-lifecycle.ts` + `session-content-cascade.ts`（删除编排四段）。同步修订：ADR-0118（3c 准入前缀、决策 1/4 落点与回收）、ADR-0133（级联机制描述）、ADR-0083（btw 持久化形态）；约束登记 C-ext-21（rename-session 路径嗅探——嗅探规则「路径含 `<sep>subagents<sep>` 段」对新布局同构命中，约束表述随布局更新）。AGENTS.md「数据目录布局」节 = 树结构与新域接入规约的导航登记处；[CONTEXT.md](../CONTEXT.md) 词条（session 存储树 / 分区键 / 整树软删）；[data-source-registry.md](../architecture/data-source-registry.md) 域条目（#8/#9/#23/#35/#44/#51/#64、P1、§6 registry 行）。设计文档 session-store-layout-inversion（设计档案已随 .tmp 清理，不入库），本条即该布局决策的现行登记处。

### ADR-0152 状态机统一基建 @zhushanwen/state-machine：声明即用 + 五域迁移收敛（2026-10-20 设计落地，state-machine-infrastructure）

**决策**：「领域状态必须显式状态机」全局裁决（2026-09-21，AGENTS.md 架构偏好）立概念未立载体——run / canvas / plan / goal / permanent-session 五套手写实现各自发明机器机制（转移表形态、异常策略、穷举单测互不相同），每个新有状态领域都要重抄一遍。新建共享基建包并迁移存量：

1. **落位**：`packages/state-machine`（npm `@zhushanwen/state-machine`，零运行时依赖，changeset 发布，扩展侧可依赖——对齐 `@zhushanwen` 命名空间发布通道）。不挂 extension-protocol（跨进程协议宿主塞通用机制 = 包职责漂移）、不放 packages/shared（违反「shared 无运行期实现」约束）、不引 xstate（actor 范式全家桶运行时依赖重；仓内五套形态的收敛点是「一张表 + 一个转移函数」，错误消息带合法事件清单与穷举组合测试要贴仓内语义，外部库不可定制到位）。
2. **API 五件**：`defineStateMachine` 声明式工厂（状态含 terminal 位 / 事件词表 / 行式转移表含 guard 与 outputs 动作引用 / `errorPolicy: 'throw' | 'result'` 每实体声明 / `errorFactory` 保形既有错误类型；定义期自检——词表外行、同 (from, event) 多行混入无 guard 行即 throw）+ `transition` 纯函数内核（guard 按行序求值，多命中 = 转移表不变量破坏恒 throw，planned 只计划不执行）+ `runTransition` 事务性编排外壳（宿主按名注入动作实现，按 planned 序执行、全部成功次态才应用，任一失败上抛第一个错误——单态 fail-fast；动作名未注入立即抛 MissingActionError）+ `coerceState`（磁盘读回字符串等词表外输入统一映射入口，枚举 includes 白名单拒原型链键）+ `generateTableTests` 穷举单测生成器（testing 子出口，vitest 仅 optional peer）。表形态三裁决：terminal 显式声明不由出边派生（plan 的「终态 + enter 重启出边」形态派生判不出）；`to: null` 实体消亡（离开机器，与 terminal 吸收态是两个概念）；同 (from, event) 多行须全带 guard——「其余情况落到此行」的兜底语义由互补 guard 表达。
3. **五域迁移（只迁表与判定，域内编排一律留域内）**：run `RUN_MACHINE`（subagent-core orchestration/run-events.ts——errorPolicy throw + errorFactory 保形 `IllegalTransitionError`，terminal-actions 四处 instanceof 分类分支仍命中；appendTransition 编排与 fold 留域内）/ canvas `canvasLifecycleMachine`（runtime canvas-foundation——throw + 保形 `CanvasDomainError` 含 `lifecycle_transition_illegal` 错误码；service 层 append/快照/广播编排留域内）/ plan `PLAN_MACHINE`（extension-protocol——result：表外 `{ok:false}` 不炸 turn，调用方不落盘不执行副作用）/ goal `GOAL_MACHINE`（extensions/universal/goal——throw；`transitionStatus` 保形包装，机器是转移判定唯一权威；词表类型 GoalStatus 与机器 states 泛型互锁，终态两处声明——机器 terminal 位 + `TERMINAL_GOAL_STATUSES` 域查询用——测试锁定）/ permanent-session `permanentSessionStatusMachine`（subagent-core execution/domain——result：表外拒绝经原语转 return false，两态 CAS 语义保形；词表与 ExecutionStatus satisfies 双向锁定）。等价性判据 = 各域既有穷举/行为测试全绿，手写穷举换 `generateTableTests` 生成组。**run 与 canvas 是事务外壳边界外域**：run 的 appendTransition「内存权威先推进 + 动作失败分级容忍」与 canvas 的「events.jsonl 权威先行 + 快照/广播失败容忍」是刻意的非事务设计，外壳接管会把失败容忍反转为次态回退、制造内存态与权威流分歧——编排上收须按已接受变更单独登记（行为差异声明 + 失败路径新测试）。
4. **首个新消费者**：session 归档的归档单元（`archiveEntryMachine`，runtime services/archive）声明即用，验证 API 完整性；此后新状态机一律声明即用，不再手写转移表 + transition 函数 + 穷举单测。
5. **不做的与回归条件**：状态级 entry/exit 挂点不做（六个消费者零落地场景，行级 outputs 可全覆盖；回归条件 = 首个「多入口进入同一状态需共享同一动作」的真实场景出现时，在 runTransition 补 onEnter/onExit 注入位——加法不破坏既有声明）；`foldEvents` 通用「事件序列→终态」折叠不做（逐支核实零消费方——run 生产折叠留域内且折叠内容超出状态机判定范围，canvas 重放是逐事件全量状态重建、生命周期转移只是其中一步判定；回归条件 = 首个需要通用折叠的真实消费方出现时再加，约 10 行循环）；session 与 background-task 两个无转移表域的显式化各自独立立项（基建就绪后成本大幅下降）。session 域已落地（chat-flow-consistency D1：SESSION_TURN_MACHINE 声明式机器，登记处 = [domain-model.md](../domain-model.md)「状态机基建」表 + 「session occupancy turn 状态机」节）；background-task 仍待立项。
6. **命名撞车边界**：core 的 streaming-state-machine.ts 是 factory 形态的消费顺序深模块，不是转移表状态机，不迁不改造——按本条排除，防后续以「名字带 state-machine」为由误收。

**依据**：五套存量实现的差异全是机制差异而非语义差异（goal≈canvas、plan≈run 简化版的同构关系佐证）；缺的不是规范是共享载体——「抄一份手艺」在最近的新领域（归档单元）重复发生是直接证据。

**登记**：实装 = `packages/state-machine`（define / transition / run-transition / illegal / testing / types + README + vitest 挂 taijiTestConfig 防线）；五域与归档单元机器声明落点见决策 3/4；打包接线 = runtime tsup `noExternal` + subagent-core 档 1 `noExternal`（该包 npm dist 为 ESM-only，CJS require 链断链防御）+ extension-protocol 与 goal 的 package.json dependencies + 仓库根 extension-dependencies.json；发布位次 = 基建包先于依赖它的 extension-protocol / goal 版本进 npm（changeset 依赖图自然保证，发布 PR 人工核对一次——extension-protocol 由零依赖变有依赖，位次断链时 npm 消费者会装到缺依赖版本）。领域登记见 [domain-model.md](../domain-model.md)「状态机基建」节；[ARCHITECTURE.md](../ARCHITECTURE.md) 共享基建节。设计文档为 tech-design 工作流产物（`~/.agents/skill-data/tech-design/<slug>/state-machine-infrastructure.md`，不入库），本条即基建落位与五域迁移决策的现行登记处。

### ADR-0153 session 归档存储：镜像布局 + 簿记聚合根 + 归档态为文件位置派生态（不进运行时状态机）（2026-10-20 设计落地，session-archive）

**决策**：侧边栏「删除」语义迁移为「归档」——闲置 session 的主文件与旁挂、附件三目录整体搬入镜像布局的归档目录并做 zstd 压缩，名称与摘要明文存簿记文件供免解压查看，恢复一键解压回原路径原分组，真删除（彻底删除）移到归档列表。补齐 session 存储生命周期「在场 ↔ 销毁」之间缺的「退场但可回」一档。

1. **归档根镜像 sessions 布局（D1）**：归档根 = `<agentDir>/archive/`（`getArchiveDir()`，与 sessions/ 平级，树段登记 `PI_SESSION_TREE_SEGMENTS`）。目录内主文件与旁挂按「镜像 sessions 结构」映射（`archive/<encodeCwd>/<原主文件名>…`，恢复 = 同构目录反向映射 + 解压 + 还原文件名）；附件三目录源在 ext-sessions 存储树内、无法靠镜像推导，用显式映射（`assets/<sessionId>/{attachments,artifacts,image-cache}`，恢复反向搬回存储树原位；源目录不存在则跳过）。**拆树声明**：把存储树三域搬出树、恢复时搬回，是对 ADR-0141「物理结构 = 生命周期结构」的显式拆分——归档不是删除，残树（btw / subagents / canvases / workflow 等留置域）保留原位；树的一级结构 `<root>/<sid>/` 不变，树内遍历点（isPiSessionId 规约）不受影响。**不采用**：单 tar.zst 打包（旁挂/摘要免解压读取全要多一道解包）；原位压缩留桩（桩在 sessions/ 扫描范围内会被收进侧边栏）；ext-sessions 整树搬移（subagents 域可能被其他存活会话经绝对路径引用〔fork 共享〕，整树搬走断链，且推翻留置域裁决）。
2. **归档态不进 SessionStatus（D9 第一层）**：SessionStatus 六值全部描述「在场」状态（active/idle 由 isGenerating 派生、终态从 `.meta.json` 读入），归档 = 不在场、条目不进列表响应——往派生枚举加 `'archived'` 只得到死值（永不出现在任何 SessionSummary 实例里）。归档态的一等载体 = 簿记 status 字段与 ArchiveSummary；归档的「侧边栏消失」靠文件移出扫描根构造性成立（同 btw 线目录隔离），零扫描器改动。归档单元自身立显式状态机（staging / archived / restoring 三态 + 六事件转移表，`@zhushanwen/state-machine` 声明——基建首个新消费者，ADR-0152；状态判定唯一权威 = 读磁盘），聚合与不变量登记 [domain-model.md](../domain-model.md) session 存储归档域。
3. **簿记 = 聚合根 + 目录即事实源（D3）**：每归档单元一份 `.archive.json` 明文 JSON（名称/摘要免解压读取的前提——名称的唯一持久层在 JSONL 尾部 session_info，压缩后免解压不可得，必须随簿记冗余）。两段式写入：归档 reply 前写骨架（status: staging，含名称不含 summary），后台压缩任务完成后原子重写终态（补 summary / sha256 / compressedBytes）。归档列表 = 扫描 `archive/**/*.archive.json` 派生，**不建独立索引文件**（杜绝索引与目录漂移）；project 归属不冗余（权威源 = 随迁的 `.project.json` 旁挂，列表渲染读旁挂回填，同 SessionScanner 第五读 sidecar 模式）。
4. **压缩编码（D2）**：`zstdCompressSync` level 3（node:zlib 内建，零第三方依赖），簿记记录 `codec: "zstd-3"`；五档真实文件实测比率 3.34-16.16x（= 省 70%-94%，由 base64 截图占比决定），gzip 同数据比率低 1-3 倍且慢 5-13 倍、zstd 高档位与 -3 输出尺寸相同（无收益）。后台异步执行（点击即时返回，压缩秒级完成）。
5. **三 RPC + 原子性（D5）**：`session.archive`（同步段：前置三门 fail-fast → 活跃 session 杀 pi 前置五步复刻 delete 分支〔suppress 死亡处置先于任何杀进程〕→ 搬移 → 簿记骨架 → 广播；reply 后后台压缩任务）/ `session.unarchive`（簿记 rename `.restoring` 标记 → 冲突检测前置〔fs.rename 静默覆盖故必须前置，staging 与 archived 统一〕→ sha256 校验 → 解压回原位 → 删归档单元，簿记殿后）/ `session.purgeArchive`（彻底删除：簿记存在性门〔无簿记 `archive_not_found` 拒绝且零副作用，封闭对已恢复在场 session 的误删链〕→ 复用 ADR-0141 四段级联〔引用枚举源入参扩展：archived 态压缩体先过 sha256 校验再解压传给级联，校验不过走 keep-all 保守保留——宁保留不误删，reply 携带 keptSubagentsDir 保守保留说明〕→ 归档物处置，簿记殿后；全部步骤幂等，中途崩溃重试可达终态）。同一 session 的归档域操作（压缩任务 / unarchive / purgeArchive）按到达顺序串行执行。命名避开已承载「重开 dead session 重新 spawn pi」语义的 `session.restore`。
6. **启动自愈覆盖全部中间态**：staging 压缩未完成重做、`.restoring` 双形态归位（原路径有主文件 = 恢复已完成补删残余 / 无主文件 = 簿记归位可重试）、无簿记孤儿按首行 header 对照 sessions/ 归位、purge 中间态保持可见可重试（不自动补删——破坏性动作只经用户显式触发）、两树 `*.tmp` 残留直接清理。
7. **agent 引用只见摘要（D7）**：session-reader 扫描根增加第五根 `<agentDir>/archive`（存在才扫，对非 taiji 用户零行为变化）——归档根不收 `.jsonl`、收 `.archive.json`，独立簿记收集器（匹配键 = 簿记 sessionId 与名称）；命中归档 session 不读压缩体，返回显式「已归档 (archived) — 以下仅为摘要」标注 + 摘要 turns + 恢复指引。标注为硬契约：agent 必须能区分摘要与完整历史。

**依据**：现状「删除」是不可逆整理终点（六类旁挂永久 unlink、废纸篓里的 session 不可查不可引用无一键恢复），用户只有「真删」或「全留」两个极端（本机 4855 个 pi session 累积即此失败模式）；而实现中间态的全部前提（扫描边界、旁挂文件、恢复原语）都已具备——它是纯文件位置语义，不需要动 session 运行时状态机。

**登记**：实装 = `packages/shared/src/archive.ts`（契约 SSOT：ArchiveLedger schema + parseArchiveLedger + 错误码词表 + 三 RPC payload）+ `packages/runtime/src/services/archive/`（archive-service / archive-paths / archive-entry-machine / summary-extractor / archive-self-heal / archive-fixture〔L3 磁盘 fixture 构造，见 e2e-map E2E-ARCHIVE-01 note〕+ 测试族）+ `packages/runtime/src/infra/pi/pi-paths.ts`（getArchiveDir）+ `packages/runtime/src/services/session/session-content-cascade.ts`（引用枚举源入参扩展）+ transport 三 RPC 接线（session-message-handler + 广播帧 archiveCount + `config.archives`）+ renderer `packages/renderer/src/components/archive/` 与 sidebar 归档入口 + `extensions/universal/session-reader/` 第五根簿记收集器 + `e2e/session-archive.spec.ts`（R2 登记 E2E-ARCHIVE-01）。同步登记：[FEATURE-PRIORITIES.md](../FEATURE-PRIORITIES.md) §4（功能本体 P2、错误处理按 P0 fail-fast 例外）；[CONTEXT.md](../CONTEXT.md) 词条（归档 / 归档单元 / 簿记文件）；[domain-model.md](../domain-model.md)（session 存储归档域：聚合 + 不变量 1-4 + 转移表）；[docs/testing/e2e-map.json](../testing/e2e-map.json)（E2E-ARCHIVE-01）。设计文档为 tech-design 工作流产物（`~/.agents/skill-data/tech-design/<slug>/session-archive.md`，不入库），本条即归档存储决策的现行登记处。

### ADR-0154 目录投喂通道：extension 进程内 registerProvider 注入，models.json 零改动（2026-10-20 用户裁决，provider-catalog-sync）

**决定**：overlay-only 模型（内置目录存在但 pi 执行侧不可见的 catalog 模型，如 `minimax-cn/MiniMax-M3.1-Flash`）的补投通道 = provider-live-sync 扩展在 pi 进程内 `registerProvider` 注入：runtime 把 catalog 模型清单刷进目录缓存文件（`<数据目录>/provider-catalog-overlay.json`），扩展在文件变化时注入（pi 工厂期首注入 + 运行中 tick 检出刷新）。`models.json` 零改动——不写用户配置文件、不物化用户配置内容。注入是映射替换语义（pi extension 层 `models.map`），注入集 = 该 provider 的最终可见集合；过期不注入、撤销回落内置基线。判据模块（缓存解析 + staleness + 并集判据，纯函数零 IO）落 `extensions/shared/llm-shared/src/catalog-overlay.ts`，缓存文件读取与注入执行落 provider-live-sync 的 `catalog-bridge.ts`。约束登记 C-ext-32（registerProvider 唯一执行点 = provider-live-sync，白名单外调用由 pre-commit 拦截）。

**为什么**：pi 注册表的 extension 层是映射替换而非合并，全部症状（rename 静默跳过 / set_model 报模型缺失 / 子代理校验抛错等 8 个同根因症状）的根子是「pi 可用集合不含 overlay-only 模型」。候选通道对比：改 models.json（物化机器数据进用户配置区，刷新/清理语义与用户手编冲突）、fork pi（违反不 fork 上游红线）、CLI spawn `--model` 近似回退（掩盖而非解决）、extension 注入（唯一不触碰用户配置与上游源码的通道）——注入且映射替换语义下，注入集即最终可见集，无「双源合并」的排序/去重歧义。staleness 基准 = pi-ai 官方导出的目录生成时刻（`@earendil-works/pi-ai/providers/all` 子路径导出），过期即整体回落内置基线，不投半新半旧。

**边界**：投喂条目按 provider 挂靠——目录缓存 entries 只含用户已配置（有凭据）的 provider，provider 本身无投喂条目时（如从未配置凭据的 provider）其下模型整体不在合并视图，默认模型校验自然回退，属 provider 级配置约束而非投喂通道限制。投喂模型挂在已配置 provider 名下时可正常设为默认模型（默认模型校验基准 = models.json ⊕ 目录缓存合并视图，`provider-catalog.ts` `getMergedCatalogModels` 单点；2026-10-20 实证 spawn `--model` 直达）。models.json 手写条目被挤出属已裁决不立项的边界（映射替换语义的必然；删掉手写条目即恢复，2026-10-20 裁决，原登记文档已撤、git 可追溯）。

### ADR-0155 插件 UI 状态拉为主 + headerAction 可见性缺省反转：未推送 = 不渲染（2026-10-21 用户裁决，scheduler-quickcard-pull-based）

**决策**：插件 headerAction 状态与视图树在 runtime 增设快照存储（`PluginUiSnapshotStore`，写入点 = 两条 transient 推送链的校验出口），新增 `plugin.ui.snapshot` 拉取 RPC——renderer 在 WS connected 边沿全量恢复 + ViewHost 挂载分区缺失自举补充拉取，实时推送（transient，不入 ring）保留为失效提示。同时反转 `isVisibleHeaderAction` 缺省语义：插件从未推送运行时状态 = 不可见（旧缺省「未推送 = 显示」把未知态乐观渲染成有入口，是无任务会话定时任务按钮常驻 + 面板停「等待插件渲染…」空态的根因）。

**为什么**：两帧是纯推送且结构性可丢（transient 不入 ring、renderer 重载即失、新建会话不触发插件激活回调），按钮缺省态又是「显示」，导致渲染端无法区分「有任务」与「什么都没收到」。修推送必达化属已否方案（ADR-0097：分布式消息税）；逐点打补丁（renderer 补定时器轮询）违反 ADR-0097 功能域禁补偿逻辑——拉取快照是唯一同时消除三条丢失路径的收敛通道（C-comm-08「立即消费的 session 级状态必须主动拉取 RPC」的本域落地）。数据域登记 = data-source-registry #73。

**边界**：可见性反转是 headerAction 通用契约收紧——声明了 headerAction 但从未推送运行时状态的外部插件将不显示入口（有意行为变更，插件必须运行时声明存在才渲染；当前唯一 headerAction 插件 = scheduler-manager，无存量受影响方）。`hidden=true`（显式停用）与「无条目」（从未声明）语义分层保留。配套：scheduler-manager 补挂 `onDidCreateSession` 建镜像（session.create 不触发 didActivate，无镜像则收不到 entry 失效事件，新会话首轮创建任务后按钮漏显示）。

### ADR-0156 批量派发成员对象 + 成员表 record 权威源 + subagents 转常驻（2026-10-22 设计落地，subagent-tool-interface-refactor）

**决策**：`subagents` 批量工具三件套变更（工具数量保持 7 个，ADR-0135 拆分粒度结论续用）：

1. **批量任务改成员对象数组**：`tasks` 元素 = 成员对象 `{task, agent?, model?, thinkingLevel?}`（task 必填自包含非空白；成员级执行者/模型/思考档位实现逐成员隔离），运行级 `agent`/`model`/`thinkingLevel` 降为缺省值——成员未指定 `agent` 由工具填入运行级值，`model`/`thinkingLevel` 留空给 `$MODEL`/`$THINKING_LEVEL` 继承（运行级是缺省值，不再意味着「所有成员只能用它」）。`agents` 逗号串与 `aggregate` 从工具 schema 移除且出现即报错（typebox Object 不产 `additionalProperties`，schema 拒不了未知字段，工具适配器显式检查并给出成员对象/自行归约的正确形状——静默忽略会丢失用户意图，违反失败显式上报）；「一个执行者用于全员」用运行级 `agent` 表达、「每个成员不同」用成员级 `agent` 表达、结果归约由主 agent 自行完成。fan-out 模板 `@pi-meta` 同形状对象-only；模板自身的 `aggregate` 参数保留（`workflow_run` 直调路径不受工具 schema 约束）。模型校验三层：运行级入口校验一次、成员显式 model 逐个校验带下标、catalog 不可用 fail-closed；成员级 `thinkingLevel` 与运行级同一枚举。
2. **成员表 record 权威源**：`workflow_control {"action":"status","runId":"…"}` 返回 run 内成员表——每成员一行（`stepIndex` / `state` 四态 `running`/`completed`/`failed`/`cancelled` / `agent` / `model` / `durationMs` / `lastError` / `turns` / 运行中 `currentActivity`），按 `stepIndex` 序渲染。record（执行侧持久化事实）为唯一主源，trace 节点为派生兜底（record 查询不可用或某行无 record 时折 trace 行，不隐藏成员行、status 不失败；abort 场景兜底行显示 failed 而非 cancelled 是已注记的粒度差异）；record 查询带 `LIST_LIMIT=100` 上限（与 TUI run 视图同源口径，防 O(session 全部 record) 无界查询——设计 §3.3.3 登记过的成本项）：超 100 条的 run，超限 `stepIndex` 由全量 trace 兜底行补齐（每 `stepIndex` 仍一行），该行 live 字段（turns/lastError/currentActivity）降级为兜底缺省，属同一粒度差异形态；同一 `stepIndex` 多条 record 取当前尝试（running 优先，`startedAt` 最新）——resume 重派场景旧尝试不以终局形态冒充新尝试。**存量 record 形态登记**：`outcome` / `stepIndex` 均为后期 additive 字段，存量磁盘数据可能缺失——outcome 落地前的存量 record（`status` 已终局 idle 且无 `outcome`）按 trace 节点映射 → `record.error` → `endedAt` 回落、均缺时缺省 running（不虚构终局——假成功比持续 running 更危险）；无 `stepIndex` 的 record 不参与成员表关联（不成行）。run 行失败计数 `failed N/M` 从成员表派生（M = 去重后成员行数），替代脚本自定义 `scriptStatus` 进工具契约（session 重载后计数仍可算）；输出总字符预算 8000，超限截断保留失败行并追加省略行。不推送成员进度（成员表是显式查询），失败恢复 = 只重派失败 `taskIndex` 对应的成员对象（不新增重试工具、不让 run 自动重试——失败显式上报）。
3. **subagents 转常驻**：注册不写 `exposure` 字段（direct 常驻），defer 名单移出（ADR-0136 补记）。理由：成员对象形状与成员级模型是首调正确性的关键，deferred 不进声明集、schema 不可见时首调正确性无从谈起；预算实测登记于本条（设计验收 S8 产物为工作流产物不入库）：真实 `tools[]` 声明序列化 subagents 2984 字符 / 对照 `subagent_start` 4254 字符（倍率 0.70），源码字面量保守上界口径 5388 / 5083（倍率 1.06）——两口径均通过 S8 判据「不超过约 2 倍」；设计期预估「约 +2.6K」是声明文本口径，与实测序列化口径不同，量级判断不变。`workflow-script` 转常驻（2026-10-23 名单重划，注册零 `exposure` 字段 = direct 常驻，与上文名单句一致；终态名单见 ADR-0136 2026-10-23 补记）。（2026-10-23 更新：subagents 改名 subagent_batch 且转回常驻、workflow-script 转常驻，名单重划与改名裁决见 ADR-0136 2026-10-23 补记。）

**不采用**：保留 `agents`/`aggregate` 做兼容（混合形状是模型记忆残留，静默放行丢失用户意图）；让批量成员变成可续聊 record（one-shot 成员结果由脚本返回值承载，无 message 对端）；新增 `retry` 工具或 run 级 `retryFailedOnly` 字段（重派就是一次普通派发，拆开会把「任务知识」与「重试决策」分开）；向主 agent 推送成员进度事件（反复唤醒烧上下文，主 agent 无订阅通道）；批量走直接派发不走 workflow 管道（复制持久化/journal/GUI 视图/完成通知/abort·resume 五件事或引入第二套批机制）。

**登记**：实装 = `extensions/universal/subagent-workflow/src/interface/tool/tool-subagents.ts`（成员对象 schema、迁移检查、入口校验、常驻注册）+ `interface/tool/subagent-tool-schema.ts`（`SubagentsParams`/`SubagentsMember` 权威定义）+ `packages/subagent-core/workflows/fan-out.js`（`@pi-meta` 对象-only、成员级字段派发、partial 收尾文案）+ `packages/subagent-core/src/orchestration/run-member-view.ts`（`runMemberViews` 纯函数 + `RunMemberView`/`MemberState` 类型）+ `interface/tool/tool-workflow.ts`（status 消费 `runId` 渲染成员表）。同步登记：[CONTEXT.md](../CONTEXT.md)（Fan-out / 批量派发词条、deferred 词条）；[architecture.md](../extensions/subagents/architecture.md) §4 批量编排行；ADR-0135/0136 补记。设计文档为 tech-design 工作流产物（`~/.agents/skill-data/tech-design/<slug>/subagent-tool-interface-refactor.md`，不入库），本条即该设计关键决策（§3.3.2/§3.3.3/§3.3.4）的现行登记处。

### ADR-0157 subagent 体系对抗式审查否定性结论收编：勿重复怀疑清单（2026-10-23 用户裁决，归宿自 subagent-workflow-issues §7）

**决策**：2026-09-29 三轮对抗式架构审查对 subagent 体系（subagent-core / engine-sdk / pi·zcode 引擎 / subagent-workflow / runtime 派生视图消费链）核实的 9 条否定性结论（怀疑过、源码级查实不是问题）收编入本登记处，后续审计/审查不再重复怀疑：

1. **防御堆积假设在 notify/ui/lifecycle 三域证伪**：notify 七层防线各自覆盖不同丢失窗口，与设计三路径三桶一一对应；ui 三层错误围栏各承独立契约。
2. **reaper 与 pid-file 无误杀路径**：判据全是身份四元组（宿主死 + 引擎活 + cmdline + lstart 四道校验），无端口/时间窗启发式。
3. **run journal append 物理单写点成立**：全仓恰 1 处生产写点（terminal-actions.ts appendTransition），dispatchRunTrigger 唯一投递漏斗，无第六写点。
4. **reentry-guard check-set 竞态不成立**：acquire 同步无 await，原子性构造性保证；真实窗口是 guard 未进 domain-state 槽（reload 后新旧 guard 并存的窄窗口）。
5. **gui-mappers 现行输入域覆盖正确**。
6. **19 组包间同名文件 12 组是合法垫片/参数化收敛形态**；真差异双实现仅 best-effort / logger / data-dir / server 四组且均有文档登记。
7. **worktree reconcile 无误删路径**：判死清理有 mtime+宽限防 create 窗口误清；方向一要求双消失且查询失败保守跳过；歧义宁跳勿删。
8. **测试深路径 import 不是缺陷**（2026-09-29 用户裁决）：属 C-ext-27 已裁决设计——测试/bench/mocks 消费符号不塞 barrel，经 vitest alias + tsconfig paths 双轨解析；生产码深路径由该约束的 ESLint 门单独拦。
9. **subagents 批量 tool 无文本生成**（2026-09-29 核实）：handler 只做 args 组装与按名解析内置模板，`@pi-meta` 与 `workerData.scriptPath` 注入安全锚均有效。

**为什么**：这批结论每条都经源码级核实，价值是「勿重复怀疑」——后续审查反复翻出等同重复支付审计成本。原载体 subagent-workflow-issues.md（导航页）随剩余项全部拆分为独立登记而删除，本条是该文件 §7 的现行承载（原文 git 可追溯）。

**登记**：本条不改变任何现行行为；来源核实记录 = 原文件 git 历史（2026-09-29 登记、2026-10-11 重组为导航页、2026-10-23 收编删除）。

### ADR-0158 轮停因词表事实化：引擎收尾边沿判定 + FailureCause 替换 AgentFailureKind + 分类输入结构化（2026-10-24 设计落地，subagent-observability §3.3.1/3.3.2/3.3.3）

**决策**：subagent 轮的成败判定与死因记录锚定引擎事实，杜绝「死了被记成成功、失败被记成 schema 错」的假象（两起现场故障的根子：引擎收尾判定只信上游 willRetry、失败事实在持久化层被清洗、轮收条存的是「没报错=completed」推断）。四个组成：

1. **收尾边沿判定事实化**：引擎收尾边沿判定从「只看上游 willRetry」改为「停因事实优先」——最后一条 assistant 消息停因 ∈ {error, aborted} 或存在未消费的引擎 error 事件 → 轮失败（退出码非 0）；`agent_settled` 是 run 结束信号而非成功证据（pi 上游对成功/错误/abort/重试耗尽全部无条件发射 settled），不再是任何置 0 依据。aborted 三源判别（同一收尾边沿裁决）：用户/run 取消 → 轮收条记中止（FailureCause user.cancelled）；turn 预算耗尽 → harness.turn_budget_exhausted；其余引擎异常 → engine.*——禁止把中止一律记失败。被接管形态（pi prompt 应答 disposition=handled，引擎从未执行）经 `get_state` 的 `isStreaming` 同步查询判定（事件位仅作预筛）：不挂起、立即轮终，记 `promptDisposition=handled` 事实字段，不进成功/失败二元。
2. **FailureCause 五维词表替换 AgentFailureKind**：失败分类 = `{class: provider|harness|agent|engine|user, kind, retryable: true|false|"conditional", retryAfterMs?, raw}` 判别联合，权威落 `packages/subagent-engine-sdk/src/protocol/contract-types.ts`（引擎协议词表家址；`AgentFailureKind` 三值保留为 `@deprecated` 历史解析兼容）。kind 为封闭登记词表（class×kind 合法组合随类型判别联合构造性收敛，枚举完整性测试锚 `failure-cause-vocabulary.test.ts`）；`retryable` 三态与重试规则 verdict 同词表（conditional = 条件恢复——等限额重置窗口或人/账户先动作，执行层不自动重试）；cause 优先级严格递减 provider 事实 > harness 预算/契约 > agent 行为 > engine 崩溃。写入即冻结（收尾边沿一次产出，下游只读不可替换），观察性事实降级为轮收条 `observations`。
3. **分类输入结构化**：pi stdout 事件的 `diagnostics`/`rawStopReason` 字段停止在接收侧丢弃；openai 兼容层 errorMessage 的 status 前缀 + body 业务码为机读主通道，文案子串匹配退役为兜底；`retryable` 必须由 provider 业务码层裁决，禁止仅按 HTTP 状态码判可重试（429 不全可重试——欠费/套餐到期同样走 429）。远程 provider 码表与重试规则共用同一 remote-config 域同一配置文件（统一条目 schema，见 ADR-0163）。
4. **轮收条只存事实**：`StopReason` 停因维改存引擎原值（`ROUND_TERMINAL_STOP_REASONS` = stop/error/aborted）+ 失败分类 + 结果正文；`completed/failed` 从「存储值 + 独立写入」降为派生展示词（引擎停因 = stop 且无失败分类 → 展示「正常收尾」），写入判据「没报错 = completed」废除；宿主中断族（interrupted / interrupted-by-restart / interrupted-by-parent / reopened）保留为宿主层事实词，不新增 cancelled 停因值（「cancelled 族」是 cause 分型不是停因值）。查询入口（`subagent_manage list` 的 `lastRound` 字段，wire 承载 = shared `SubagentRecord` type-only re-export 自 sdk）、轮应答通知、renderer 失败红点判据（红 = `lastRound.failure` 非空且非 user.cancelled，legacy closed 失败注入族同判红）全部读事实字段。

**修订关系**：修订 [ADR-0080] ③④ 与 [ADR-0082] D2 的词表登记——record 域停因维从「展示排障侧推断值」改为事实词表；本轮失败事实持久化层不清空（`applyTurnEnd` 无条件清 lastError 废除，失败进轮级 `errors` 只追加，`lastError` 派生 = 最后一个非空轮失败）。

**效果**：失败轮如实记失败与分类死因（可重试、约多久恢复可分辨），通知与查询三处同真相；F-1 schema 兜底分支退役为 observations。设计文档与实施波次映射见 subagent-observability 设计（§3.3.1 判定链 / §3.3.2 分类 / §3.3.3 轮收条，工作流产物不入库，本条即现行决策登记处）。

### ADR-0159 run 终局吸收成员交付：RunOutcome 增 partially_succeeded 第五值（2026-10-24 设计落地，subagent-observability §3.3.8）

**决策**：run 级 outcome 从「`result.error` 有无」改为成员交付结算集合的派生物，`RunOutcome` 词表四值扩五值（`done/failed/cancelled/time_limited/partially_succeeded`，`packages/subagent-core/src/shared/run-vocabulary.ts` 的 `ALL_RUN_OUTCOMES` 单源；shared 镜像 `WorkflowRunOutcome`/`WorkflowDoneReason` 同批扩值 + 「部分成功」文案）。聚合规则：全部成功交付 → done；存在失败且存在非失败 → partially_succeeded；全部失败 → failed；无失败但产物契约部分满足 → partially_succeeded；run 中止 → cancelled。run 级终局（budget_limited/time_limited/cancelled）优先于成员集合派生；settling 中双终局竞窗先到事实者胜。终局事件携带 `failedMembers[].cause`（`"<class>.<kind>"` 点拼字符串；retryable/retryAfterMs 不进终局帧、由成员轮收条承载）与 `partialMembers[{taskIndex, missing[]}]`（部分交付成员 + 未满足 deliverable 清单，不进 failedMembers 无 cause）。

**消费链三处同批**：TUI `isFailedTerminal` 补排除（partially_succeeded 独立档不落失败族红档——「一半成功」不得呈现为全败）+ runtime `WORKFLOW_DONE_REASON_SET` 派生视图收窄点扩值入「runtime 双包值级等价断言」对账范围 + GUI overlay 独立档。

**修订关系**：[ADR-0082] D2 RunOutcome 四值词表谱系补记（四值 → 五值）；语义反转声明——现状成员失败完全不传导 run 终局，本决策是行为反转（用户已确认）。

**不采用**：partial 折进 failed（一半成功与全败不可分辨）；文案带 partial 而词表不变（词表与文案分叉）。

### ADR-0160 轮应答通知契约：文案事实化 + one-shot 通道放行 + 攒批窗整机制退役（2026-10-24 设计落地，subagent-observability §3.3.7）

**决策**：通知 = 债权兑现的轮应答，不是事实载体（事实只存在 record 事件流，通知是送达）。三个组成：

1. **文案事实化**：轮应答正文五分支（`packages/subagent-core/src/execution/notify/notifier.ts` buildRoundReplyContent）：被接管轮（promptDisposition=handled，回执层成功 + 引擎未执行）/ 中止轮（user.cancelled 或 aborted 停因，「本轮被中止」+ 中止来源）/ 失败轮（failure 非空非 user.cancelled——失败摘要 + cause 点拼 + 恢复指引「续聊重试或换模型」）/ 正常轮空正文（「本轮完成，无文本输出」，非异常不告警）/ 正常轮（结果正文，多轮与 one-shot 同形）。硬编码 `finished a round` 文案废除。
2. **one-shot 通道放行（主体集合以运行时 origin 为界，2026-10-24 验收实测裁决）**：背景单成员派发域（`subagent_start` / executeAndAwait 无脚本编排派发）的轮应答通道放行——该域 origin 经 notifyGateAllowsDelivery 放行轮应答（origin gate 对其原全静默不可达，即故障 A「该收的收不到」的修复）；workflow origin 单漏斗回注全静默保留（notify-host origin gate 恒拒，构造性不双发）——`subagent_batch` 批量工具运行时走内置 fan-out 模板 = workflow origin，成员轮应答静默，成员结果由该 run 的聚合 wf-done 通知一条承载（「批量 = 各成员逐条轮应答」与实现不符，不采用——照此实现会与 wf-done 双发）；run 终局通知（wf-done）覆盖全部 workflow origin run（脚本编排与批量 fan-out 同类）。
3. **攒批窗整机制退役删除**（用户裁决「删干净」）：60s 滑动窗口无上界（仍有 record 在跑就无限滑动推迟，实测压 104 秒），整机制退役——所有通知边沿即投；窗口本体（MERGE_WINDOW_MS / mergeBuffer / wantMerge / 定时器 / flushMergeBuffer）+ merge 选项与 hasRunningBackground 注入链 + core 窄端口转写字段全删。取代性由 collect_results 批量收取能力承接（挂起分流先于投递，等待期到达的通知零消息化）。保留边界（防误删）：buildBatchPayload 与 recover 重放 / collectRelease 直通 / compaction 唤醒仍产合法批形态，消费方批兼容读分支保留（存量 session 数据）。

**修订关系**：[ADR-0097] 拉为主推补充在本域的细化——通知是性能提示允许丢失，事实真相走查询入口；删除时间平抑类机制（攒批窗）的先例登记：删后数据仍一致（只是通知到达时机变化），符合「时间平抑类逻辑红线」退役判据。

**效果**：应答不再说谎、不再无上界推迟；one-shot 该收的收得到。

### ADR-0161 失联清点合并进 run 级清点：宿主重启一次性簿记（2026-10-24 设计落地，subagent-observability §3.3.4）

**决策**：宿主重启时，record 级失联清点合并进既有 run 级清点代码（startup-sweep 同一扫描入口）——同一主 session 的 run 与 record 在一次遍历里一起清点（用户裁决形态）。不做持续监控、不加定时器、无时间窗猜测。record 侧判定谓词全锚事实：① 清点对象 = 该主 session 下事件流停在「轮在途」形态（running 且轮收条未写）的 record，判定输入载体 = 启动既有 manifest 快照重建通道的产物内存态（禁止按全量事件流重放 fold 判定——重读量随历史积累单调增长）；② 活体判定 = 宿主代际归属（宿主重启标记 + pid 探活）——孤儿引擎进程即使仍存活，宿主重启后已失去事件落盘通道，判失联；进程清理归既有 sweep，清点不承担杀进程职责。命中处置（实装 `packages/subagent-core/src/orchestration/record-restart-sweep.ts`）：轮收条补写失联（停因复用 `interrupted-by-restart` + `swept` 清点附注 + evidence 指针）、pending 债结清 `lost`、从占用判据与计数摘除；record 会话本体保留——续聊即重建（resume 锚点），归档照常走 gc。

**效果**：重启后孤儿摘除、债结清、计数归零；「死但没应答」变成「已结清（失联）+ 证据指针」。

**不采用**：定时巡检（时间平抑红线——启动清点 + 活体判定就是事实源方案）；lost 会话终态（失联是债的结清形态与轮收条标注，不是会话状态——record 无终局）。

### ADR-0162 record 会话语义确认：两态保留 / 复活 = 归档唤醒 / 无任务终局（2026-10-24 用户裁决登记，subagent-observability §3.2 方案 C 撤销 + §3.3.3 会话确认）

**决策**：subagent record 的会话语义确认为项目刻意如此，登记防再质疑：① **两态保留**——record 是会话不是任务（permanent-session 模型，万物可续），running/idle 翻边 + reopened 世代推进；② **复活 = 归档唤醒是合法形态**——归档（closedReason）会话经续聊唤醒续聊，「复活边」是万物可续的组成，不是缺陷；③ **不建任务终局维度**——record 没有也不需要任务终局，失败可续聊、成功也可续聊，修复全部落在轮与债权层（[ADR-0158]/[ADR-0159]/[ADR-0160]/[ADR-0161]）。

**否决记录**：v1 设计方案 C（任务终局框架：终局维度 / lost 一等终态 / 删复活边 / retryOf 链、63 处判定收编）不采用——领域模型错位：为表达「死了」硬造终局，把归档唤醒当缺陷删掉，与「失败了也可以续聊」的产品形态直接冲突；63 处判定收编是给一个不存在的概念付迁移成本。两份审查报告的 TaskLedger/Terminal 外来词汇与项目登记的 permanent-session / 万物可续 / 债权语言冲突时，以项目登记为准（教训：报告的领域框架必须对照项目领域登记校验后才能采信）。

**效果**：后续审计/审查不再重复提议「给 record 加终局 / 删复活边」类方案；失联、失败全部由轮收条标注与债权结清承载，会话本体恒可续。

### ADR-0163 retryable 增强 extension 与可配置重试规则：message_end 改写触发 pi 原生重试 + 三层规则来源（2026-10-24 设计落地，subagent-observability §3.3.12）

**决策**：新增 pi extension `@zhushanwen/pi-retry-rules`（`extensions/universal/retry-rules/`，mandatory-extensions.json 登 infrastructure 组——恒载进孙进程白名单）：`message_end` 钩子改写已定稿消息触发 pi 原生重试循环（探针双组对照实证可行——改写组 auto_retry 全链路触发、对照组直接终局；monkey-patch pi-ai 路径已证死：getter-only 访问器 + ESM live binding 结构性无注入点）。可重试错误（限流等）不再被判死，「别死」（本条）与「死了记对」（[ADR-0158]）互补成完整闭环。

四个组成：

1. **规则结构**：`{match, verdict}` ——verdict 三态 `retryable/non_retryable/conditional`（与 FailureCause.retryable 同词表）；双匹配通道——正则匹配 errorMessage 文本（带 ReDoS 防护）+ JSON 片段 path 匹配（openai 兼容层 errorMessage 恒为 status 前缀拼法，body 内业务码经 path 提取）。`httpStatusClass` 仅作溯源标注永不参与裁决（status 层只定大类、retryable 由 provider 业务码层裁决——[ADR-0158] 硬约束由结构保证）。
2. **两层序匹配**：第一层按 verdict 排除——non_retryable 规则优先于 retryable/conditional（先排除再放行，账户类错误永不误重试）；第二层同 verdict 内用户规则 > 远程预设 > 编译期基线；命中即断。conditional 与 non_retryable 不改写（不触发重试；conditional 单独成态仅为 settings 展示解释）。
3. **三层配置来源同文件**：编译期基线 ⊕ remote-config 远程覆盖（`configs/remote/retry-rules.json`，quota-fetchers 域同款 fail-safe 链）⊕ 用户自定义规则（ext-config 单文件，runtime 读改写 / extension mtime 热重载——network-proxy 同款三端范式）——与 [ADR-0158] 分类远程码表共用同一 remote-config 域、同一配置文件、统一条目 schema（同一 provider 错误码事实一次登记覆盖分类与改写两个消费方）。settings 页挂在既有「LLM 调用重试」卡旁：展示内置预设 + 编辑自定义规则。
4. **改写落盘约束与停用通道**：改写写入的是 pi 拥有的持久状态（pi 会话记录）——硬约束 = 追加标记而非替换原文（`[taiji-retry:` 前缀为触发识别约定，保留原始 error 文本不丢失）；停用复用既有「LLM 调用重试」卡的 pi 原生 retry 配置（enabled 开关 / maxRetries 置 0——pi 重试决策点先检查配置再判词表，前置门关闭后改写不触发任何重试），停用即自然回落 [ADR-0158] 如实分类。远程误配风险登记：误配爆炸半径有界（每轮至多重试 maxRetries 次，0-20/0-10 上限结构性有界），回退 = revert commit 后客户端下个拉取周期生效；内置预设数据变更须对错误码实测锚点复核后 commit（锚点内联进基线文件头注释）。

**效果**：可重试错误不再被判死；规则可配置化让新 provider 接入不发版；settings 可见让用户掌握判定口径。

### ADR-0164 羊毛 provider = pi provider 扩展形态：三家已登录 AI IDE 额度经 registerProvider/streamSimple/refreshModels/oauth 接入，npm 独立发版 + 清单钉版本，凭据权威在 pi auth.json（2026-10-21 设计裁决，wool-provider；部分有效——D6 的宿主通道与 model.list 聚合两条已由 ADR-0166 修订）

**决策**：把用户已登录 AI IDE（WorkBuddy·腾讯 / Trae·字节 / Qoder·阿里）的内置模型额度接入为可选模型，整体路线 = 每家实装为一个 pi provider 扩展包（`@zhushanwen/pi-wool-<family>`，主仓 `extensions/universal/` 同产线、非 builtin mandatory），不新建 taiji 侧运行时形态。四项架构裁决：

1. **D1 整体路线 = pi provider 扩展**：协议转换以 `streamSimple` 函数形态实装在 pi 会话进程内（WorkBuddy 头族+指纹 / Trae 自定义 SSE+JWT / Qoder 签名+RSA 密钥交换+AES 载荷），`refreshModels` 承载动态模型目录，`oauth` 钩子族管凭据——taiji 插件系统零改动、pi 零改动（只用公开扩展 API）；无独立进程、无常驻本地监听端口（常驻入站攻击面为零；唯一例外 = WorkBuddy OAuth 授权期间的 127.0.0.1 临时回调监听，授权结束即回收）；全部出站请求统一经 `globalThis.fetch`（network-proxy 包装层覆盖，代理用户场景行为不分叉）。不采用：taiji 服务型插件 + 本地端口（pi 已有同能力官方机制时重建一套 = 重复造机制且风险落 P0 载体）、外部网关子进程（上游活跃度成单点依赖 + 用户多担 Python 环境）、主仓内置（协议对抗性漂移绑死 taiji 发版节奏）。
2. **D2 分发 = npm 独立发版 + 远端清单钉版本**：扩展包以 `@zhushanwen/pi-wool-*` 发布 npm（独立版本线），taiji 官方发布通道维护资产清单 JSON（家族 → 版本 + 完整性散列），安装经既有 extension-service 链（npm 安装 + isValidPiExtension 校验 + 失败回滚全既有）——改清单即发布扩展新版本，不需要发 taiji 版本，协议对抗性漂移由扩展版本吸收；清单不可达时阻断 + 重试，不降级直装。
3. **D3 凭据 = 扩展内实装（Qoder/Trae 本机提取逐次确认、WorkBuddy 内置浏览器 OAuth），持久化权威 = pi auth.json**：经 pi oauth 钩子族（login 返回凭据由 pi 入库，到期 pi 自动调 refreshToken），ide-extract 家族的提取动作包装为 login 等效流程（提取即登录）；taiji 主进程零凭据副本，只持久化接入标记等展示状态（settings.json 羊毛域）。跨应用读取凭据逐次确认；登录态检测 = 凭据文件存在性一次 stat（不读内容、不解密、不后台轮询）。
4. **D6 集成契约 = RPC 扩展 UI 通道 + 管理指令 + 模型选择器整合**：向导交互经 pi RPC 扩展 UI 子协议（extension_ui_request/response，session-manager 先例）；管理指令（触发提取/授权、拉账号状态、执行签到、清除凭据）走**管理专用 RPC 会话**——`SessionCreateOptions.hidden` 创建、操作级即起即收不驻留、不进用户会话列表；指令经扩展注册命令（"/" 前缀编排旁路），响应经 custom entry 回写。模型选择器整合：**pi registry 是羊毛模型唯一权威清单**，taiji 侧 model.list 聚合并入羊毛条目（数据 = taiji 侧派生缓存，标注数据时点；刷新时机 = 向导完成/手动刷新/安装完成），会话内切换经 pi set_model 由 pi 仲裁。model.list 聚合是 P0 载体上的纯增量修改，义务 = 既有 provider 管理与模型列表行为零回归。

**依据**：三家协议探针全链路出话实证（Qoder 钥匙串解密 / Trae 容器解密 / WorkBuddy OAuth）；pi custom provider 扩展机制按 node_modules 实装版 + 官方文档核实（事件流契约/refreshModels 持久化/oauth 三钩子完整）；taiji 扩展分发链与 RPC 扩展 UI 通道读码核实；上游主动对抗（校验持续加码）决定协议实装必须按家族独立成包、可独立于 taiji 发版更新。方案对比与逐项否决理由见 wool-provider 设计文档 §3.2。

**登记**：实装 = 独立仓 tai-ji-plugin 的 `packages/pi-wool-{qoder,trae,workbuddy}/` + 共享库 `packages/wool-shared/`（脚手架/管理指令协议/账号状态/SSE 工具；仓库迁移裁决见 ADR-0165）；taiji 宿主 = `packages/shared/src/wool.ts`（域类型与清单 schema）+ `packages/runtime/src/services/wool-manager.ts`（清单拉取/安装编排/管理专用会话/缓存）+ model-service 聚合并入 + `packages/renderer/src/components/settings/provider/WoolWizard/`（两族模板向导）；文档同步 = [FEATURE-PRIORITIES.md](../FEATURE-PRIORITIES.md) §4/§6、[CONTEXT.md](../CONTEXT.md) 羊毛词条、[TEST-STRATEGY.md](../TEST-STRATEGY.md) 真机验收轨、AGENTS.md extensions 列举。设计过程产物（tech-design 归档），本条即该形态决策的现行登记处。

**修订（provider-plugin-access D6，2026-10-23）**：D6 两条按 ADR-0166 改写——① 管理动作不再走管理专用 RPC 会话，迁入 taiji 插件进程（凭据经 `providers.write` 写 `models.json`，宿主保留 `providers.write/delete/credential` 受控代理与 pi 扩展安装编排）；② `model.list` 聚合并入删除——羊毛条目自身持久在 `config.providers`，与既有 provider 同管道。D1–D3 成立：pi provider 扩展形态（`registerProvider` / `streamSimple` / `refreshModels` / `oauth`）与「pi 零改动、凭据权威 = pi 可读的 models.json 条目」不变；本文「登记」段的主仓宿主实装清单（`packages/shared/src/wool.ts` / `wool-manager.ts` / `WoolWizard/` / model-service 聚合）已随 D6 拆解删除，现行落点见 ADR-0166「登记」段。

### ADR-0165 羊毛插件包迁独立仓 tai-ji-plugin：单仓多包 + npm 独立发版线 + 资产清单随 release 上传（2026-10-22 用户裁决，wool-provider）

**决策**：羊毛 provider 插件包（`wool-shared` + `pi-wool-{qoder,trae,workbuddy}` 共 4 包）从主仓 `extensions/` 迁出到独立 git 仓库 `zhushanwen321/tai-ji-plugin`（本地 `<workspace>/../tai-ji-plugin-workspace`，bare 模式 workspace：`.bare` git dir + `main` worktree）。仓库形态 = pnpm workspace 单仓多包、源码直出、changeset 管版本、npm 发布独立于 taiji 应用版本（热更新解耦的根因 = 消费级私有协议主动对抗，扩展必须独立于 taiji 发版更新——ADR-0164 的分发决策在仓库层的收口）。

**发布链收口（a5 验收发现的缺口）**：`wool-manifest.json` 由新仓 `scripts/gen-manifest.mjs` 生成（家族静态元数据内联 + version 从各包 package.json 单源读取），随 `npm-*` tag 触发的 release workflow 上传 GitHub release——taiji 宿主 `DEFAULT_WOOL_MANIFEST_URL`（releases/latest/download 语义）自此有真实供给，install 动作的清单校验不再 404。

**主仓侧**：`packages/runtime` wool-manager 与扩展包的契约 = 管理指令协议（字符串信封）+ models.json 条目（数据契约），无模块级依赖（迁移安全性的机器证据 = 迁移前 grep 全仓零 `pi-wool` import）；设置页向导、wool-manager、凭据通道全部保留在主仓（taiji 是扩展的增值前端）。AGENTS.md 扩展列举同步（21 包 + 新仓指针）；验收剧本 fixture 预置源改挂新仓。

**依据**：能读凭据的可执行代码独立成仓 = 供应链隔离边界（与「首版官方源收紧」同向）；独立 issue/PR/发布节奏解耦主仓 P0 载体的变更节奏；既有「旧独立扩展仓废弃、统一主仓」约定由本条修订——羊毛包是首个例外，其余 21 个 builtin/feature 扩展维持主仓（无独立发版诉求，不迁移）。

**形态修订（provider-plugin-access D6/D7，2026-10-23）**：羊毛的产物形态从「pi 扩展单件」改为**双产物**——taiji 插件（`@zhushanwen/plugin-wool-<family>`，管理动作：授权/提取/状态/目录刷新/签到，在插件 fork 进程内执行）+ pi 扩展成员（`@zhushanwen/pi-wool-<family>`，对话链：`registerProvider` / `streamSimple` / `refreshModels` / `oauth`）。两个包同在新仓 tai-ji-plugin，双产物版本配对唯一权威 = 主仓 `configs/remote/v2-plugins.json` 的 `{ pluginVersion, piExtensionVersion }` 成对字段（`wool-manifest.json` 只承载扩展资产解析，版本不一致时安装拒绝 `VERSION_PAIR_MISMATCH`）。主仓宿主侧保留两件编排：`providers.write/delete/credential` 受控代理（`services/provider-write-proxy.ts`）与 pi 扩展安装薄模块（`services/wool-extension-installer.ts`）；「主仓侧 wool-manager / 设置页向导 / 凭据通道全部保留」的结论按本条废止（管理域迁插件，界面由插件渲染，`WoolWizard/` 与 `wool.*` 帧退役）。D7 登记 C-ext-32 羊毛豁免（`docs/constraints.json`）：羊毛扩展自行 `registerProvider` 注册自有 provider，不参与 catalog-bridge 投喂链。

### ADR-0166 插件作为 Provider 来源：插件提供家族元数据/授权流程/模型目录/协议转换，凭据统一经 providers.* 写入 models.json（2026-10-23 设计裁决，provider-plugin-access）

**决策**：Provider 设置新增来源类型「插件 Provider」，与「自定义 Provider」「内置模板」并列；插件提供家族元数据、授权流程、模型目录与协议转换，宿主提供统一的壳、一个常驻「重新授权」入口，并把凭据统一写入 `models.json`。八条：

1. **D1 来源类型**：选中「插件 Provider」后显示由 `configs/remote/v2-plugins.json` 清单提供的家族列表（家族 id / 显示名 / 厂商 / 凭据来源 / 模型数 / 插件包名）。清单是发现通道，不是安全审核或白名单（用户仍可直接输入包名安装）。原羊毛页头独立按钮删除，能力由该来源类型吸收。
2. **D2 插件渲染区**：两个渲染挂载位——`provider.authorize`（选中家族 / 点重新授权后，替代宿主预设的授权模板）与 `provider.detail-extra`（provider 条目展开体末尾，渲染上游专有差异内容）。宿主只画容器与统一字段（凭据 / 额度 / 模型清单 / 动作按钮），流程步骤、文案、输入项由插件用 `GuiComponent` 树决定。视图归属由会话泛化为**作用域**（`scope` 联合 `{sessionId}` | `{mountId, pluginId}`，全局域键含插件维度——两插件向同一挂载位推树互不可见）。不采用宿主预设 OAuth/提取两套模板（新流程形态需改宿主发版）、插件自带 Vue / iframe（CSP 与设计系统失控）。
3. **D3 能力声明即授权**：manifest `taijiPlugin.capabilities` 声明业务能力，fork 时按声明放行内置模块——`network.http`（http/https/net/dns/tls）、`fs.read-user-data`（fs 只读导出子集 + `readPaths` 路径检查，两机制独立不互相顶替）、`crypto`、`process.spawn`（child_process）。授权时机 = 安装，运行时不做逐次审批；永久封禁 `vm` / `worker_threads` / `module` / `cluster` / `dgram` / `readline` / `v8`；`os` 移出黑名单（拼 IDE 配置路径需要 `homedir()`）。组合失效声明：`fs.read-user-data` 的路径限制仅在未同时声明 `process.spawn` 时构成实际边界。
4. **D4 凭据权威单源**：插件经 `providers.write`（`{providerId, apiKey, headers?, displayName?, models?}`）交凭据与模型目录，宿主复用既有 `setProvider` 写策略链落盘（`applyProviderWritePolicy` / `credentialWriter` 载体，不新建写入点）；`providers.delete` 供卸载清理；`providers.credential` 为受控明文回读，经 `provider-credential-resolver` 唯一读通道（C-proc-14），**作用域限本命名空间、只定向回发起调用的插件**，不广播、不落日志、不进快照，能力前提 = manifest 已声明 `network.http`（否则 `PERMISSION_DENIED`）。命名空间边界 = `providerId === ns || providerId.startsWith(ns + '-')`；`ns` 由包名纯函数推导（`deriveNamespace`：去 npm scope、去 `plugin-` 前缀），安装期与 manifest 声明值绑定校验（不匹配 `NAMESPACE_MISMATCH` 拒装），不落盘——包名是唯一事实源。插件存储（`plugin.storage.*` / `plugin.sessionData.*`）**不存凭据**（约定，不做机器强制）。
5. **D5 凭据状态权威 = 插件**：宿主只提供常驻「重新授权」按钮，不推断凭据是否失效。条目展开 / 页进入经 `plugin.invoke` 的 `getStatus` **同步拉插件本地最近已知状态**（含未上报），上游校验由插件异步执行并经 `plugin:event` 增量上报；插件未上报时宿主不显示任何失效标记（S5 负面验证）。
6. **D6/D7 羊毛迁移**：羊毛改为共享内核 + 三个 taiji 插件包 + 三个 pi 扩展成员；`WoolManager`（1421 行）、借道通道（`withManageSession` / `runManageCommand`）、`wool.*` 三帧、`wool-catalog.json` 缓存、`WoolWizard/` 宿主界面、`model.list` 羊毛聚合特例全部退役。宿主保留 `providers.*` 受控代理与 pi 扩展安装编排薄模块（双产物版本配对权威 = `v2-plugins.json` 的 `{ pluginVersion, piExtensionVersion }`，`wool-manifest.json` 只承载资产解析，版本不一致 `VERSION_PAIR_MISMATCH` 拒绝安装）。羊毛扩展自行 `registerProvider` 注册自有 provider，登记 C-ext-32 豁免（不参与 catalog-bridge 投喂链）。
7. **D8/D9 协议原语**：`GuiComponent` 新增 `text-input`（`{id, label?, placeholder?, value?, multiline?}`）与值回传通道 `plugin.uiEvent`（输入变更即回传）；`plugin.invoke`（renderer → 插件业务方法，复用 `commands-executor` 的 pending / 超时 / 并发链）与 `plugin:event`（插件 → renderer 业务状态上报）；`plugin.ui.openUrl` 仅放行 `http(s)`（经 `new URL(...).protocol` 归一化比对，不做字符串前缀匹配）。`single-select` / `form` 砍除（无真实需求方）。
8. **D11 安装器补齐**：串行锁（安装/卸载互斥）、失败回滚（暂存 → 确认停点 → 单步 rename 提交；提交失败旧版本幸存）、安装登记 `installed.json`（只记安装时间，版本直读包内 `package.json`、命名空间由包名推导，均不落盘）、scoped 包目录名解耦（`@scope/pkg` → `scope__pkg`，修「安装成功但列表无此项」）。

**不采用**：宿主新增「羊毛服务」模块绕过插件系统（第二套运行时并存）；只把界面挪进 Provider 页而编排仍借道 pi 会话（凭据视野分裂与冷起进程不消除）；做运行时权限审批（安装即授权，审批与语义重复）；让插件自己写 `models.json`（绕过写策略链，格式漂移致 pi 整表拒载）或存插件 storage 由宿主读取（明文落盘 + 凭据权威源分裂）；维护 pluginId→providerId 持久化登记（可由命名空间前缀扫描派生，第二份拷贝引入不一致）；新增 `providers.read` 元数据回读（无指名消费方）。

**依据**：羊毛管理侧模块零 pi 值依赖（`keychain-extract.ts` 仅 Node 内置模块；`manage-protocol.ts` 对 pi 只有 `import type`）；渲染链零 session 依赖（`resolveComponent` 与 `GuiComponentRenderer` 搜索 session 零命中），耦合面 = 存储分区两处 + 活推送链三处（「无活跃会话即丢弃」判断已随盖戳猜测路径删除，终态同步修正计数）；`setProvider` 是写策略载体；`provider-credential-resolver` 是凭据读取唯一通道；沙箱 `RpcIdentity.pluginId` 必有（fork 与 pluginId 一对一）；`WoolManager` 七个借道调用点已定位。插件首次可读写本机文件、发网络请求、起子进程的安全边界变更按 D3 的代价段接受（边界 = 安装动作，清单策展 + 安装知情为缓解）。

**登记**：实装（主仓）—— `packages/shared/src/protocol.ts`（`plugin.invoke` / `plugin:event` / `plugin.uiEvent` / `plugin.listAvailable` / `plugin.catalog` 帧；`wool.*` 三帧删除）、`packages/shared/src/plugin-view-scope.ts`（scope 契约）、`packages/shared/src/plugin-namespace.ts`（`deriveNamespace` / `validateNamespaceBinding`）、`packages/shared/src/plugin-capability-map.ts`（能力词 → 模块集）、`packages/plugin-sdk/src/types.ts`（`capabilities` / `readPaths` / `namespace`）、`packages/runtime/src/services/plugin-service/`（能力放行 `plugin-blocked-builtins.cjs` / `plugin-esm-loader.cjs` / `plugin-fs-guard.ts`、`installed-store.ts`、`plugin-catalog.ts`）与 `packages/runtime/src/services/plugin-service/api/`（`commands-executor.ts`、`views-api.ts`）、`packages/runtime/src/infra/installers/plugin-installer-adapter.ts`（安装器，infra 层非 plugin-service/ 目录）、`packages/runtime/src/services/provider-write-proxy.ts`（D4 三 RPC + 命名空间校验 + manifest 读取）、`packages/runtime/src/services/wool-extension-installer.ts`（pi 扩展安装编排 + 版本配对）、`packages/runtime/src/index.ts`（代理注册 + `wool-catalog.json` 存量清理）、`packages/extension-protocol/src/core/types.ts` + `packages/ui/src/rendering-protocol/primitives/TextInput.vue`（`text-input`）、`packages/core/src/transport/mock`（mock 域段）、renderer Provider 页（来源类型 / 家族卡 / 挂载位容器 / 条目扩展区 / 安装确认卡）。独立仓 tai-ji-plugin —— `packages/plugin-wool-{qoder,trae,workbuddy}/`（管理方法 + `GuiComponent` 树）、`packages/wool-shared/`（管理内核下沉）、`packages/pi-wool-*/src/index.ts` 瘦身为 provider 注册 + 协议翻译。约束登记：C-ext-32 羊毛豁免、C-proc-14 / C-proc-15 代理归属说明（`docs/constraints.json`）。插件开发文档：`docs/plugins/built-in-plugin-guide.md`（manifest 三字段 + `providers.*` 三 RPC + 凭据存储约定）。设计过程产物（tech-design 归档），本条即该决策的现行登记处。

### ADR-0167 判定基点单一权威 PR_BASE（2026-10-26 merge 流程架构审查·发现 1）

**决策**：「本 PR 增量」的 diff 基点以单一变量 PR_BASE 贯通全部机器门禁：pr-cr-fix SKILL 开局先定（= 目标 dev 分支，DEV-WORKFLOW §3；dev→main 终局 PR 才为 main）；changeset-check.mjs 新增 `--base`（显式基点解析失败 exit 2，不静默 skip 成「无检查即绿」）；pr-pre-merge.sh 的 `--base` 透传给 changeset-check（原只用于 coverage 口径校验）；coverage/metrics/select-constraints/select-affected-e2e 的命令示例与 pr-lifecycle 的 `args.base` 同步改传 PR_BASE。缺省回退 main 仅供历史形态（dev→main 终局 PR 与无参调用）。

**否决记录**：门禁继续按 main 累积口径——随发布周期推进，每个 feature PR 为整条 dev 线未发布内容重复举证（coverage 增量按 dev 全线行数、changeset WARN 反复列 dev 线包、Gate-1a.5 为非本 PR 的包起草多余 changeset），pr-lifecycle 已被迫用 prompt 散文纠偏机器判错的集合（机器判错、人工兜住），周期后段误判率必然上升。

**效果**：基点错位（政策 base=dev vs 机器 base=main）消除；DEV-WORKFLOW §10 两条过期登记（dev-merge changeset 缺口、skill --base main 待修）随本决策落地清理。

### ADR-0168 merge 管线状态机最小落地 + main 同步防护 + 发布互斥（2026-10-26 merge 流程架构审查·发现 2/3/7/8/17）

**决策**：①管线状态（.merge-state/current.json）升级为带身份的最小状态机：阶段 0 init 以 `{reset:true}` 开启新管线（pipelineId + stage=init，清上一轮 release 字段防跨轮残留）；阶段 2 pr-merge 落 mergeSha（merge commit）+ stage=merged；wait-for-ci 无参路径经 stage 门只消费 stage=merged 的 mergeSha——headSha 是 PR head（判的是阶段 2 已裁决过的 PR 侧 runs），禁止复用为阶段 3 判定对象；release 落 stage=released（终态）。②阶段 2 的 main 同步（lib/sync.mjs）加数据丢失防护：fetch/checkout 退出码逐一检查，reset --hard 前判本地 main 是否领先远端（领先 = 发布在途 bump/notes 未 push 或未知改动，fail-fast 给处置指引，绝不拨回仅 reflog 可救的 commit）。③init 以「非终态 + 12h 活跃窗」作发布互斥（两会话并发启动发布链是 bump/tag/push 写操作的并发数据丢失源）。④wait-for-ci 默认超时 600s→2400s（main push CI 含两个 30 分钟档 e2e job，旧默认常态首跑必超时）。

**否决记录**：wait-for-ci 无参继续读 headSha（PR head）——阶段 3 是合并后唯一 CI 验证点，判错对象 = 验证了个已裁决过的东西，post-merge main CI 从未进判定（PR #61 实测 head sha 与 merge commit 对应不同 runs）；无条件 reset --hard——发布流程自身制造领先窗口（阶段 4/5 commit 后 push 前），误清在途发布产物。

**效果**：跨管线字段残留（磁盘实证 pr:61 与 tag:v0.11.15 叠在同一对象）、判定对象错位、reset 数据丢失三类形态各有回归测试（merge-sync / merge-state / merge-wait-for-ci 三文件）。

### ADR-0169 验证出口收敛 quality-gates（--only）+ CI 解掩蔽全 job 化 + 内联镜像退役 + repo slug 单源对账（2026-10-26 merge 流程架构审查·发现 4/6/11/12/13）

**决策**：①merge 阶段 1 的 pre-merge-check.sh 收敛为 taiji 专用（退役 npm/frontend 通用分支——其自引保留依据「AGENTS.md §5」已不存在），类型检查与守卫测试出口改为 `quality-gates.mjs --only typecheck,test`；quality-gates 新增 `--only` 门组过滤（排除 py 门时不做 py 实体检查/不解析 base），全量单测不在阶段 1 本地重跑（同一 commit 的完整 CI 由阶段 2 PR CI 等待承担）。②CI 解掩蔽（continue-on-error + if:always() 聚合步）从 2 个 job 扩到全部：typecheck（11 检查步）与 invariants（29 检查步），前置依赖步（checkout/安装/Materialize .agents/Build dist）保持阻塞语义。③invariants job 两段 ci.yml 内联镜像（runtime CJS 禁令 + noExternal 对账，原注释自认「与 validate-runtime-bundle.sh 同步维护」）退役为直调 `validate-runtime-bundle.sh --static-only`（静态段函数化，等效性经本地对拍验证）。④仓库标识 slug 收敛：Node 消费方 import repo.mjs 的 DEFAULT_REPO、shell 消费方从 `git remote get-url github` 一手推导、check-repo-literal.test.mjs 对账白名单外零字面量（verify-plugin-contract 与 verify-taiji 场景作为 runtime 常量镜像登记在案）。⑤ci.yml run 值解析器收敛 scripts/lib/ci-yaml-runs.mjs 单实现双口径（命令清点 ' && ' / 文本对账 ' '），双侧 import 再导出。

**否决记录**：阶段 1 保留自带 tsconfig 扫描——find -maxdepth 2 只能发现 extensions 一个 tsconfig（包级在深度 3），类型检查范围结构性小于 pr-cr-fix 静态门，是「本地验证门」的第 4 份平行清单且无对账；阶段 1 本地全量 pnpm test——与阶段 2 PR CI（同一 commit 全量 test job）完全重复，只加时长不加覆盖。

**效果**：「修一轮才见下一个失败」的 CI 形态在全部 job 消除；无对账双实现（ci 内联、双解析器、散落 slug）各收敛为单一来源或红灯对账。

### ADR-0170 合并判定唯一数据源 = head SHA 的 workflow runs，check-rollup 轨删除（2026-10-26 发布门禁收敛，gate-verdict-ssot §6.1）

**决策**：pr-merge 阶段 2 的 PR CI 判定数据从 `gh pr view --json statusCheckRollup`（平台聚合的二手视图）换为 `gh run list --commit <head SHA>`（一手拉取），经 waitForRuns「有 runs 必等全部完成才裁决」；deadline 30 分钟；judgeRollup/waitForPrChecks 删除（与 wait-for-ci 双轨归一，merge-gate.test.mjs 固化半注册窗口与 PR #45 同族回归）。

**否决记录**：rollup 轨加「pass 后延迟 30s 复查」的稳定期——启发式，判定数据本身不是权威源，下一个窗口形状仍会漏（v0.11.16 实测：半注册窗口 + rollup 只含已结论的 Greptile 机器人检查，16 秒即判「全绿」合并）；点名 ci.yml job 名清单作期望集合——新增 job 漏登记 = 新的形状依赖。行为变化：机器人 check run 不再阻塞合并（CI 门禁只看本仓 workflow）。

**效果**：注册窗口这一类形状被机制整体消灭而非逐形状补防；合并前后用同一判定器，修一处两边同时受益。

### ADR-0171 「哪些包需要 changeset」收敛为 versionable-packages 单一出口（2026-10-26 发布门禁收敛，gate-verdict-ssot §6.2）

**决策**：新增 scripts/versionable-packages.mjs（@manypkg 枚举 workspace globs + config.ignore，输出 name/dir/version/private/ignored/versionable/wsDeps）；check-version-changes.sh 与 apply-version.sh 的硬编码目录枚举替换为消费该 CLI；changeset-check.mjs 方向①（漏声明）的扫描范围从 extensions/ 正则改为按 registry 包目录最长前缀匹配（仅 `<dir>/src/`、仅可版本化包）。行为对拍验收：新旧脚本同 range 输出逐字节一致。

**否决记录**：正则扩到 packages/ 前缀——形状驱动，apps/ 与未来新顶层目录继续漏（v0.11.16 六包漏声明直穿终局 PR 的结构性根因：dev 边界用的恰是四份平行枚举里最窄的 extensions/ 正则）；check-version-changes.sh 整体前置到 dev 边界——终局决策面（逐包人工定 type），搬进 dev 内环过重。

**效果**：目录布局变化自动跟随 workspace 定义；dev 边界开始拦 packages/ 漏声明；private/ignore 包不再出现在漏声明警告（与 pkgOf 口径对齐）。

### ADR-0172 测试族清单单一登记（SUITES）+ 机器对账器 + dev 边界执行（2026-10-26 发布门禁收敛，gate-verdict-ssot §6.3/§6.4）

**决策**：scripts/test-suites.mjs 登记快速守卫测试族（taste-lint / resources-plugins / builtin-ext-bundle / scripts-guards，命令文本与 ci.yml 步骤精确一致由对账器保证）；scripts/check-test-suite-wiring.mjs 断言①清单命令 ↔ ci.yml 步骤文本、②scripts/__tests__ 文件全集 − 清单引用 − 显式豁免 = 空，挂 CI Invariants + pre-commit 双接线；quality-gates 新增恒跑 gate 5 执行 devGate 族（dev 合入边界 ~+20s，过期测试当天红）。

**否决记录**：dev 集成分支触发全量 CI（push 加 dev-*）——每次合入 15-20 分钟全量（含 e2e）成本高且无门禁消费其结果，快速族前置已覆盖「终局 PR 才第一次跑」的主痛点，全量留终局 PR 是有意的分层；ci.yml 动态生成 steps——GitHub Actions 不支持运行时读仓库文件生成。

**效果**：清单漂移与零执行点测试（v0.11.16 实测 6 个）从静默分叉变红灯；CI 测试步骤解掩蔽（continue-on-error + 聚合）使一次 run 暴露全部失败。

### ADR-0173 连接目标快照与域同步收敛：supervisor 签发实例标识 + 目标快照单一权威 + 连接边沿统一域同步 + project 写通道命令化（2026-10-27 设计裁决，connection-datasync-ssot）

### ADR-0174 移动壳视图层全量重写：三目的域信息架构 + 装配层保留 + v1 能力映射对账（2026-10-25 设计落地，remote-use-mobile-v2 §6.1）

**决策**：`packages/mobile-renderer` 视图层按 spec 全量重写为三目的域信息架构（会话/进行中/设置 + 聊天详情页，五态路由状态机 + popstate 系统返回接管，不引 vue-router）；装配层（bootstrap 连接编排 / app-runtime core factory 接线 / companion-bridge 三通道 / platform 连接档案）保留并按 v2 扩展，core/ui 通道零断链。v1 视图组件直接删除（git 历史即回退通道，不保留 private 旧版）；删除以 v1→v2 老能力映射表（M-1~M-18）逐条对账为前置判据——每条迁移类能力确认 v2 承接锚点在场才删（对账档案 = `packages/mobile-renderer/MIGRATION-RECONCILIATION.md`），无锚点即阻塞。绑定 v1 视图的单测随组件同删，装配层/通道单测保留适配，视图测试按 v2 重建（三视角）。

**否决记录**：渐进修补不采用（六问题全部锚定视图层结构，修补 = 在错误信息架构上打补丁）；保留 v1 作 private 回退不采用（死代码 + 两套「当前会话」定义并存，UI 回退用 git revert 更干净）。

**效果**：audit 全部 P0/P1/P2 随重写消除（首屏白屏 / 触控 44px / 对比度达标 / 浮层焦点管理 / 删除二次确认）；v1 两 tab 空壳态、三套手写浮层、ErrorBar/断线条/Band 三层堆叠退役，概念净减；v1 视图 8 文件 + SlashBarStub + BottomTabBar + pinia 空挂载清退完成（views/ 保留 2 个 v2 现役组件，清单见 `MIGRATION-RECONCILIATION.md` 清退清单节；对账 M-1~M-18 全绿）。

### ADR-0175 ChatView 移动 variant = density 注入，桌面渲染路径字节不变（2026-10-25 设计落地，remote-use-mobile-v2 §6.2）

**决策**：`@taiji/ui` chat 组件族新增 `density` 维度（`'desktop' | 'mobile'`），经 ChatViewDeps provide 树注入；Turn/Block/ThinkingRow/ToolRow/UserBubble 等组件读 density 切换类名组合（移动档：正文 16px/1.62、气泡最大宽 82%、思考块默认收起、工具行 13px 密度）。桌面默认值 `'desktop'`、不传走原类名——桌面渲染路径字节不变（u-foundation 以桌面快照断言 + E2E-VISUAL-01 像素基线双防线证明）。移动壳 `MobileMessageStream` provide `density:'mobile'` 消费。撤回按钮（UserBubble 常显）与运行中 bash 停止在移动档保持可达（老能力映射 M-7/M-8）。

**否决记录**：移动壳自建轻量消息流不采用（真实消息类型远多于 demo 五类，自建丢桌面能力且双壳渲染漂移）；CSS 全局覆盖不采用（覆盖范围失控、无法约束到组件内部结构）。

**效果**：双壳共享同一套 chat 渲染单源；桌面零回归由 additive-only 约束 + 像素基线门禁结构性保证；逃生通道（个别组件无法 additive 时降级移动壳局部 CSS 覆盖并登记）未触发。

### ADR-0176 spec F16 表单超时条款收窄：失效事件消费，不设墙钟（2026-10-25 设计落地，remote-use-mobile-v2 §6.4 + §6.23 断连不清表单请求、时间平抑类逻辑退役）

**决策**：移动端表单/权限请求的「超时」表现全部消费既有失效信号，不新增任何墙钟——extension 域（ask-user/planReview）无超时（runtime 2026-07-16 既有裁决 + 超时默认原则：任务级正常路径禁止自带墙钟超时，「等用户回答」不是时间问题），消费 `extension:requestsInvalidated`（撤销即失效）；plugin 域消费既有真超时事件 `plugin:uiRequestExpired` / `plugin:permissionRequestExpired`（30min，env 可调）。断连不清表单分区（v1 定时清空形态退役）：分区保留作对账基线，重连后 getPendingRequests reconcile 收敛；runtime 重启分支恢复前禁提交（封「旧 runtime 静默忽略已终结 requestId」的假成功窗口），恢复恒经对账完成事件、无定时器。「表单取消回传 null」用既有 `extension.ui_response result:null`。

**否决记录**：为满足 spec F16 字面在移动壳或 runtime 加表单墙钟不采用（违反 runtime 既有裁决 + 超时默认原则——失效本来就是事件，加墙钟是把事件问题换成时间问题）；改 runtime 恢复 extension 超时不采用（改变桌面行为，超出设计范围）。

**效果**：spec F16 首句修订为「请求失效（撤销/过期）」、§19「请求超时」按「extension 域 = 失效通知、plugin 域 = 真超时事件」分流落地（修订建议见 docs/spec-revision-proposals.md，随设计包呈报用户确认后回写 Open Design 存档）；时间平抑类逻辑（断连定时清空）退役，失效链单一出口事实化。

### ADR-0177 移动端三通道呈现统一 Sheet 化：回传通道零变化（2026-10-25 设计落地，remote-use-mobile-v2 §6.5）

**决策**：移动壳三个「等用户处理」通道全部迁入 Sheet 体系：① form/planReview → FormSheet（表单逻辑复用 ui 包 form-protocol 纯函数与 createFormRequestChannel，题型渲染单列化）；② 简单 dialog 四型全集（confirm/select/input/editor，含 editor 多行预填等宽——v1 实装能力不回归）并入「待回答」数据源由 FormSheet 泛化承接，放行词表单一来源 = 自 shared `ExtensionInteractMethod` 类型派生 + 反向穷举编译锁（shared 扩型时编译红，禁手写字面量副本）；③ 权限 → PermissionSheet（编排状态机复用 createPermissionRequestController，仅呈现层换 Sheet 原语；桌面继续用 Dialog，ui 包组件不动）。三入口统一「聊天底部条 + 进行中页聚合 + 底部导航计数」（聚合口径见 ADR 语义：回合主体只看活跃会话、待办与计数聚合全部会话，权限请求归属为可选字段、无归属是一等分支）。壳侧浮层唯一出口 = Sheet 原语（sheet-manager 单例互斥，八名封闭词表），禁止手写浮层（L0 grep 机器检查）。

**否决记录**：CompanionBand/PermissionRequestDialog 与 Sheet 双形态并存不采用（两套浮层语言 = v1 三套手写浮层问题的复刻）；PermissionSheet 在 ui 包新做不采用（权限编排 factory 已共享，呈现层是壳的职责）；dialog 只映射三型丢 editor 不采用（editor 型被丢弃则请求方无限等待，多行预填语义丢失）。

**效果**：spec「答」主线成立——请求从「只活在当前会话聊天页」变为全壳可达；回传通道零变化（extension.ui_response / plugin.uiResponse / plugin.approvePermissions / plugin.denyPermissions 原样）；v1 收起/展开（minimize/restore）随单槽互斥形态退役（拖拽关闭取代）。

**背景**：冷启动侧栏项目分组丢失的架构级修复。旧形态四层缺陷叠加——① runtime 端口经「裸端口推送 + 前端备用端口猜连公式」双通道分发，dev 延迟启动期前端拿过期端口猜连至他人实例；② 端口推送无实例标识，runtime 重启后前端持有死端口/死 token 重连；③ 连接重连的域刷新由 initApp 一次性编排 + 重连分支逐域手写两套并存；④ project 表由前端 localStorage 回写 + runtime save 端点双写，无 revision 水位，双窗口并发编辑互相整表覆盖。设计过程产物 connection-datasync-ssot（tech-design 归档），本条即该形态决策的现行登记处。

**决策**：九条。

1. **实例标识与目标快照单一权威**（§6.1）：runtime 子进程每次 spawn 时 supervisor 与 token 同点签发 runtimeId（8 字节 hex）并经 env `TAIJI_RUNTIME_ID` 注入；连接目标统一为快照 `{seq, runtimeId, port, token}`——seq 随 spawn 成功单调递增（失败半途清理不消耗代数），连接目标 IPC 通道（快照读口与推送）承载快照而非裸端口。磁盘端口文件（runtime.port）不在连接目标通道内，仍写裸端口数字，消费方是 CLI 端口发现与单实例互斥判活（`packages/runtime/src/cli/port-discovery.ts` / `src/infra/single-instance-guard.ts`），renderer 连接不读它。auth 成功应答回传 runtimeId（`{ok:true, runtimeId}`），连接控制器与期望快照核对「连的是谁」，不一致 fail-fast（streak 计数 + 重拉快照，禁静默续用）。旧客户端只读 `payload.ok` 不受影响（多余字段无消费者）。
2. **删除备用端口猜连**（§6.2）：`resolveFallbackPort` 链及其唯一消费通道 `get-runtime-port-offset` IPC 同批删除；权威目标确认前不连接、不初始化——init 拉取快照为 null 即进 waiting-runtime 等待态（连接状态词表新增该态，与「连接中…」显式区分），快照经拉取或推送到达即转 connecting。HMR 重连改为重拉快照连接。
3. **唯一连接控制器按目标比较裁决**（§6.3）：4 处 runtime-port 广播点统一改推快照（同 channel 载荷升级）；`use-connection.ts` 收敛为裁决表——同 seq 不动作；seq 更高或期望未建立且未认证 → 断旧连新；auth 拒绝 → 重拉快照换凭据重连；实例变更（新 runtimeId）必经断连→connected 边沿。终端域 `getCurrentToken` 世代判据语义与调用点不变（回归项，真机验收覆盖）。
4. **连接边沿统一域同步器**（§6.4）：`connection-edge-sync.ts`（core，headless：零 DOM/零 store import）以 `DomainSyncDescriptor` 声明式登记数据域（project/sessions/workspace）与辅助刷新层；连接边沿（首次认证成功、每次重连认证成功）触发登记域同步，取代「initApp 一次性编排 + 重连分支逐域手写」两套。机制约束：并发合流（同域同时刻至多一个在途）、仅最新代提交（连接代单调计数，旧代回执丢弃并在丢弃点补发）、每域首次落定 promise（启动编排消费——initApp 等 project 域落定后才进落地页）、命令×同步交错判据（project 域在途 load 回执携带的 revision 早于 store 已提交值时按过时丢弃 + 补发，防旧快照回滚命令结果）。workspace 域失败语义由「置空」改为「失败保留旧值」（显式行为改进）。
5. **project 加载 4 值状态机 + 失败显式呈现**（§6.5）：renderer project store 显式转移表 idle→loading→loaded/failed、failed→loading（重试或连接边沿）、loaded→loading（重拉）；表外转移 fail-fast。loaded 态单条命令失败不改状态机（内存保持命令前状态 + toast）。
6. **project 写通道命令化，runtime 唯一写入口**（§6.6）：四命令（createProject/renameProject/removeProject/setActiveProject）经 runtime 串行队列执行，revision 水位校验（失配抛 `project_revision_mismatch`），成功回执 = 归一化后完整新状态 + revision 新值，并广播 `project.changed` 失效信号（各窗口据此重拉）；存量文件无 revision 字段按 0 读、首写补 1；归一化为读时修复（load 只改回执视图不写盘）。旧 `project.save` 端点 + payload/reply 映射 + core save 封装 + mock 实现 + 前端 localStorage legacy 迁移同批拆除（全仓 grep 零命中）。
7. **分组派生按加载状态降级**（§6.7）：分组区三形态——loaded 正常渲染；无数据形态（idle 或从未成功过的 loading）渲染加载占位（禁把兜底默认表渲染成「只有一个空默认组」——本次事故可见症状）；failed 整体替换为失败状态条（原因 + 重试钮）；重拉子形态（loaded→loading）保留最后已知分组（缓存视图更新时机构造性成立）。
8. **连接状态词表新增 waiting-runtime**（§6.8）：见决策 2；App.vue 非连接态四分支（waiting-runtime / restarting / failed / 过渡屏）显式分呈。
9. **加载失败期间禁用项目编辑**（§6.9）：无有效数据形态（failed / 无回执的 loading）下编辑入口不可用——区头新建「+」显式置灰带原因提示，组头动作（重命名/删除/锚定切换/默认区新建）随 §6.7 分组区三形态替换构造性不可达（入口不渲染）；store 层二次检查（入队与执行时双检 loaded + revision 非空）保底。失败窗口内首发会话归入未分组（projectId 空），数据恢复后不被追溯改动。

**不采用**：保留备用端口猜连做 dev 延迟启动兜底（猜测公式是双轨端口源，冷启分组丢失的直接触发路径）；前端 localStorage 继续做 project 写通道（双写无水位，并发互相覆盖的根因）；用时间窗/平抑逻辑掩盖瞬态（ADR-0122：删后数据仍最终一致 = 补偿补丁删之）；恢复读文件/轮询表模拟实时（存储只做恢复源）。

**依据**：ADR-0122 事实驱动原则体系（本机故障模型 = 进程生死二态，状态判定来源严格递减：同步查询 > 确定性事件 > 禁止时间推测；失败显式上报、首败即停；UI 跟随事实）的具体化；ADR-0097 拉为主推补充（拉是真理通道、推是性能提示，可靠性由通道保证，功能域代码禁出现推送补偿逻辑）在连接与项目域落地；域同步器是 ADR-0097「丢失后的收敛由域同步协议统一提供」的实现载体。

**登记**：实装——协议地基 `packages/shared/src/{protocol,ipc-channels,constants}.ts`（快照类型 / project 命令域 / IPC 通道常量 / `RUNTIME_ID_ENV`）；主进程 `apps/electron/main/supervisor/{runtime-supervisor,process-control}.ts`（快照持有与签发、4 广播点载荷升级）+ `gateway/bridge-handlers.ts`（快照 IPC 读口）+ `preload/preload.ts`；runtime `packages/runtime/src/transport/connection-manager.ts`（auth 应答回传）+ `transport/project-message-handler.ts` + `services/project/project-store.ts`（四命令 + 串行队列 + revision + 归一化）；core `packages/core/src/transport/use-connection.ts`（连接控制器裁决表）+ `connection-edge-sync.ts`（域同步器）+ `transport/api/domains/project.ts`（命令封装）；renderer `stores/project.ts`（4 值状态机 + 命令化编辑）+ `composables/features/sidebar/{useSidebar,useProjectGroups}.ts` + `components/sidebar/{SessionList,ProjectGroup,ProjectLoadStatus}.vue`。出站 env deny 登记（C-proc-09 spawn-env-contract）随 `TAIJI_RUNTIME_ID` 注入更新。无新约束族；排障条目见 [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) 连接状态词与快照排查节。真机验收（设计 §8 七场景 + P-3/P-4/P-5 探针）由 verify-taiji 场景剧本族承载（`a1-cold-start-groups` / `a2-first-port-occupied` / `a3-runtime-restart-recovery` / `a4-failure-presentation-recovery` / `a5-failure-window-edit-disabled` / `a6-dual-window-revision` / `a7-disk-invariant`）。

### ADR-0178 会话查看数据与执行就绪解耦：getHistory 四态分派 + 尾读快路径 + 后台全量精化 + 切入链并行切口（2026-10-29 设计落地，session-cold-switch-perf §3.3-1 + §3.3-4）

**决策**：查看历史的数据获取与执行进程解耦——机器上没有任何可用 pi 进程时 getHistory 仍成功返回尾读窗口。getHistory 按「runtime 重建缓存 × pi 进程在场」四态分派（分派实现层 = session 域 historyReader，对经 RPC 与 runtime 内部直调的全部调用方一致生效）：缓存命中走既有快路径；缓存 miss + 进程在场 → 尾读首屏立即返回 + 后台用在场进程全量重建；缓存 miss + 进程不在 → 尾读立即返回 + 后台全量任务登记为待启动，由并行的 switch 侧进程获取事件驱动启动（getHistory 分派自身不消费预热槽、不 spawn——查看路径永不占用执行资源；btw 线排除登记，死线重开回放与现状逐点等价）；尾读 IO 失败 → 进程在场同步等后台全量完成（等待时长 ≈ 现状），进程不在或后台失败按既有失败语义返回、不无限等待。带 cursor 的翻页保持 getCursorWindow 既有「缓存 × client」分派结构。后台全量任务（sessionId 键内存单例、并发上限 1、rebuild 段单块 + 编排段间让出 setImmediate——批内切分需改 entry 树构建语义，不属本批）完成后写缓存，推 `session.historyCacheReady` 广播事件（payload `{sessionId, snapshotLeafId, error?}`，成功失败都推，协议登记 packages/shared protocol.ts SSOT）；renderer 活跃会话收成功事件且快照未过期时重拉 getHistory（毫秒级命中缓存）经既有 reconcileHistory 合并，失败事件不重拉、顶部指示转为「加载更早失败 + 重试入口」，runtime 侧首败即停不自动重起（ADR-0122），下次 getHistory 派单按四态重新决策；会话删除汇聚链清理待启动登记与在途任务（删除后在途结果丢弃不写缓存）。切入链最小切口（§3.3-4）：13 步链只开一个口——步 9 getHistory 提前到与步 2 switchSession **并行发出**、reply 写入 chat store 独立于链短路，panel 挂载仍随 switch 返回，其余链序不动；switch 失败仍按现状在步 2 短路（「历史仍上屏」的只读显示形态登记为后续项，完整承载在终态读模型，ADR-0180）。

**否决记录**：维持「全量完成才返回」（首屏被绑在完整恢复链 = 冷切 3-10 秒无反应的根因）；renderer 直接读文件（跨层越权）；新增「全量响应」协议形态（reply 恒经预算窗口是统一契约，绕开会造第二套数据通路）；态 3 待启动登记不排除 btw 线（死线重开回放常态产生无完成时点条目，且冷线删除不经 removeSessionEntry 需另补清理接线）；翻页直接走尾读游标窗口作主路径（深层翻页单页成本随距尾距离线性增长，一次全量重建 + 每页缓存切片更优）；「switch 失败仍挂载只读 panel」（需扩展 13 步链断言与失败语义改造，超出本次最小切口射程，故障形态高发时作独立小设计补做）。

**效果**：冷切点击 500ms 内最近消息上屏（含 42MB 会话）、首屏期间界面立即切换、更早历史后台补齐不跳变；数据层与执行解耦（pi 完全不可用时尾读仍返回）。已接受代价 = 缓存逐出重切与多会话反复按需重建的重复成本，两条重审触发线：同一会话单日全量重建 ≥5 次 → 终态索引（ADR-0180）提前立项；后台重建期间其他会话 RPC p95 > 500ms → parse worker 化提前。

**登记**：实装——shared `packages/shared/src/protocol.ts`（`session.historyCacheReady` 事件类型与 payload）；runtime `packages/runtime/src/services/session/history-rebuild-cache.ts`（四态分派 + 后台任务单例 + 态 3 待启动登记 onSessionActivated 事件驱动 + onSessionDisposed 清理挂点）+ `packages/runtime/src/services/session-history.ts`（尾读 segments sidecar 回填）+ `transport/session-message-handler.ts`（RPC 入口转发）；core `packages/core/src/domain/session/use-session.ts`（selectSession 于 switch 前并行发出 historyPull + runEntryChain 步 9 仅 await 同一 promise）+ chat store（快照对账与后台重建失败态分区）+ transport 广播事件路由接线。

### ADR-0179 预热空 pi 单槽 = 执行就绪提前支付：一次性消费 + 失败即空槽 + 消费驱动补位（2026-10-29 设计落地，session-cold-switch-perf §3.3-2）

**决策**：spawn 一个空 pi 进程放入单槽，把「执行就绪」成本提前支付到查看期——预热只服务继续对话时的进程就绪，不参与查看链路（尾读 getHistory 不依赖槽），不是会话正确性的一部分。spawn 与现状 spawnRestoreClient 同一构造链产出（禁止预热用简化参数、取用后补挂——pi 每次进程启动读扩展参数，后补挂与原生挂载不可证等价）。冷恢复取用依次过三道检查：① 槽空 → 回退现状 spawn 链；② 参数签名（presetId + cwd）与目标会话不匹配 → 弃槽回退 + 后台按目标参数补位；③ 探活（pid 存在性同步检查，挂死进程由附着阶段 switch_session 失败兜底回退）→ 通过即取用，用后不回收（附着后归该会话生命周期，槽立即补位）。补位策略 = 失败即空槽 + 消费驱动补位：补位 spawn 失败槽保持空、无自动重试，下次消费必查槽即天然重试点。补位候选 = 本次消费的目标会话参数直传（markSessionViewed 唯一写入点在 switch 处理器入口、先于恢复链执行——switch 主路径与 lastViewedAtBySession 最新条目派生同一；session.restore RPC / startup-reattach / 崩溃 respawn 等非 switch 消费点不写该表，直传消费目标为更准候选，且免槽模块跨读 session-service 领地）；正常退出后冷启动该表恒空、无恢复消费 → 槽保持空、无独立启动期接线，首次发火 = 首次消费（冷切或崩溃恢复）后的补位（崩溃恢复启动经 reattach 恢复链消费触发补位为后登记的扩展行为，槽进程有 idle 自杀兜底）；补位 spawn 与 startup-reattach 恢复接管期（60s 上界）重叠时推迟让位。消费路径记录槽状态分布结构化日志（命中/不匹配/空/进程死四态），命中率持续偏低 → 按降级路径整体摘除（决策对低命中率鲁棒——不命中即回退现状，仅收益归零）。

**否决记录**：补位自动重试状态机（指数退避 + 重试上限 + disabled 态）——为无已发生证据的故障模式提前引入多个概念，消费驱动补位最终到达同一状态且无空转重试；复用回收（进程释放回槽再切别会话）——跨会话扩展状态残留不可证伪，一次性消费保证每会话拿到干净进程；通用进程池（多槽/调度/排队）——无第二使用方证据；RPC 探活——挂死进程会无限挂起卡死 switch（pi 侧 RPC 墙钟超时已随 ADR-0122 退役）。

**效果**：冷切省 spawn 段 0.6-1.1s（收益兑现概率 = 预热命中率，探针持续度量）；预热失效（进程死/环境异常）自动退回现状路径，最坏体验 = 现状。

**登记**：实装——`packages/runtime/src/services/session/warmup-pi-slot.ts`（槽模块自包含：spawn/存在性探活/三道检查取用/失败即空槽 + 消费驱动补位/reattach 让位/四态结构化日志/冷启动恒空）+ `session-lifecycle.ts`（acquireRestoreClient 单一接线点优先走槽，spawn 构造链与现状 spawnRestoreClient 同源）；范围外必要改动 = IPiEngine.pid 声明 + startup-reattach 编排活跃标记。

### ADR-0180 长期终态方向：会话读模型三拆——本方案为过渡形态（2026-10-29 设计裁决，session-cold-switch-perf §6）

**决策**：ADR-0178/0179 优化的是「完整恢复会话」这条链的时序；长期终态让绝大多数查看操作根本不走这条链——「打开会话只是一次本地数据查询，继续会话才是一次执行任务」。职责三拆：持久会话记录（唯一事实来源，现 jsonl）/ 历史查询读模型（read model，面向查询的派生数据，SQLite，可删除可重建，永不回写权威源）/ AI 执行（pi 只是执行资源，独立生命周期状态机，与「选中了哪个会话」「加载到哪页」解耦）。索引在写入时增量完成（独立索引 worker 消费权威记录增量写入读模型），非点击时全量重建；读模型允许短暂未追平，靠版本与恢复机制最终一致。历史单一查询入口——冷启动/缓存命中/加载更早/首次导入全部走同一读模型分页查询，本方案「尾读 + 全量 + 广播事件合并」的双路径一致性成本在终态不复存在。可行性依据：仓内 ext-sessions 派生视图域（projection，从事件流重算的只读查询视图）已是同族机制。**前置条款**：终态 SQLite 选型与 docs/PRODUCT.md 现行非目标「数据持久化：不引入 SQLite」直接冲突——另立终态设计时**必须先修订该非目标条目**（说明 42MB 级会话历史与用户配置数据量级不同的理由），否则两份现行文档互相矛盾；本设计自身不含 SQLite。终态可检验不变量（另立设计的验收基线）：只读独立（无 pi 可查全部历史）/ 读取有界 / 历史单一路径 / 衔接不丢不重 / 重活隔离 / 索引状态真实 / 读模型可重建。

**迁移映射**：文件尾读 → 保留为索引 worker 的首次导入/按需向前补索引算法，不再是独立首屏数据源；预热单槽 → 保留为执行就绪加速（定位同 ADR-0179），与查看无关；后台全量重建 → 仅首次导入/读模型损坏修复；`session.historyCacheReady` 广播事件 → 取消（游标、索引覆盖状态、递增版本分别表达，不再有「等全量」语义）；尾读/全量双路径合并 → 取消（持久历史只从读模型读取）；多层整会话 LRU → 降级为可选页面缓存，不再决定历史能否快速读取。

### ADR-0181 消息流滚动跟随信号源重构：跟随触发权从 RO 布局观察移交流式数据信号，RO 触发支 debounce 尾沿兜底盲区；error-reporter 聚合 RO loop 告警（2026-10-28 设计裁决，stream-follow-reshape）

**决策**：P0 域「对话发送与流式渲染」的贴底跟随触发机制重构（设计包 stream-follow-reshape，tech-design-wf 三审 3 轮收敛 must-fix 5→3→0）。三条 A/B 级拍板：**D1**——跟随触发权从 wrap ResizeObserver（观察自己刚写入的布局效果）移交数据信号通路：streaming 回合文本总长 watch（getter 锚 renderItems 派生链，内聚 isStreaming 判定）升主触发，复用 followFromRo 双 rAF 对齐 virtua 测量时机；**D2**——wrap RO 职责收窄为测量留守（tailHeight / 距底快照），触发支加 debounce 尾沿（250ms 初值，导出常量 `RO_FOLLOW_DEBOUNCE_MS`）兜底无数据信号的高度变化源（shiki/图片/显隐/折叠），scroll RO 不受门约束；**D5**——error-reporter 对「window-onerror ∧ 无堆栈 ∧ 文本规范化全等」三条件的 RO loop 告警聚合计数（60s 窗尾 1 条汇总含次数），非命中条目逐条转发不变。随批退役零消费方接口成员（`onStickChange` / `useStreamingPin.sessionId` / `onVirtuaScrollEnd`）。

**落地实况（2026-10-28 D3 真机验收）**：设计前提 P1（移除应用层 RO→follow 边后告警归零）**证伪**——底层 RO loop 事件仍以 ~2.5 条/s 发生（60s 窗 148 次，virtua 内部测量回路自持触发每帧广播上限，与回写边无关），设计登记的 PR1 降级路径按备案激活：D5 聚合兜底生效（console 148→1 条/60s 窗、renderer-error 日志增量 1 行，目标 1 替代形式「不随流式持续累积」达成、日志可诊断性恢复）；行为等价面全绿——贴底跟随+收缩窗口 15/15、盲区收敛 16/16、S9 形态四观察窗零半截、P6 成立（15.2s trace forced reflow=0，测量支单次布局读不构成强制重排，后备演进不触发）。残余告警源归因与 debounce 窗口值重审登记为后续项（实测 wrap RO 投递 ~489ms/批 > 窗口值，触发支窗尾幂等执行、重置 0 次——P2 预案形态，gap 钉住 0-30.5px 证明无视觉扰动）。

**不采用**：维持 RO 主触发仅消级联（治标）；virtua 反向滚动（上游 issue #261 高度差异闪烁正中消息流雷区 + 全域语义反转）；纯数据驱动胶囊浮现（距底是布局事实）；事件顺序精确门（RO entry 无因果来源字段，时间邻近性是唯一归属判别）。

**依据**：触发信号选在效果层而非原因层是根因（效果信号必然晚一帧、与布局系统耦合、随内容频率线性放大）；数据通路已存在且消息级直达（真机 242 delta 批大小恒 1）；覆盖盲区源无数据信号（「补 N 个 watch 无解」），debounce 时间尾沿是唯一可行的归属判别；聚合三条件带无堆栈限定使同文本带堆栈真错误不吞（不吞错纪律）。

**登记**：实装（commit f146f14aa / dc069ba51 / 69fa5df95，分支 fix-ro-follow-loop）——`packages/renderer/src/composables/panel/useMessageStreamFollowTriggers.ts`（主体重构 + dev 窗尾重置计数）、`packages/renderer/src/components/panel/MessageStream.vue`（deps 注入位 + 空挂点/实参清理）、`packages/renderer/src/composables/panel/useVirtuaFollow.ts` 与 `useStreamingPin.ts`（接口退役）、`packages/renderer/src/boot/error-reporter.ts`（D5 聚合 + emitPayload 单点化）、`packages/renderer/src/composables/panel/usePinBottomGuard.ts`（文案）。验收剧本入库：`.agents/skills/verify-taiji/scenarios/follow-{stream-quiet,stick-shrink,detach-interactions,blindzone-converge}.mjs`（覆盖矩阵同步补行）。验收终态与降级处置：`~/.agents/skill-data/dev-flow/fix-ro-follow-loop-1dc70637/`（stream-follow-reshape.ledger.md）。

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
**背景**：pi 的契约假定「消息进入 transcript 之前所有权属于前端」（steer/followUp 队列只是交接槽位，前端须自己盯它是否被取走、必要时用 `clear_queue` 收回），而 taiji 的消息所有权长期碎在四处——renderer 乐观气泡、renderer defer 队列、renderer pendingBuffer 计数、runtime 投递内核（仅服务 agent 间消息）——四处都不完整：steer 车道 fire-and-forget（入槽后无人跟踪），且车道判定源有三套（renderer 发送路由表 / runtime occupancy / extension 自身视角）互不同步，压缩、中止、进程回收三类窗口轮流暴露同一结构性缺口（消息丢失/滞留/乱序）。

**决策**：全部发送方（composer 用户消息 / session_manager send / completion-backflow / plugin / landing 首发）经 runtime **投递所有权内核**提交——纯逻辑状态机在 `packages/session-delivery`，pi 适配与对账在 `packages/runtime/src/services/session/session-delivery-registry.ts`：
1. **lane 判定单一源**：direct（pi 空闲直投）/ steer（并入当前 run 的 turn 边界）/ queued（内核 FIFO 持有）由内核按 runtime 权威 occupancy 投影（C-data-19 单写原语）+ 内核队列态判定；renderer 侧发送路由表降级为发送位按钮形态的 UI 预测，extension 不做车道判定。
2. **两阶段回执**：受理（prompt 受理 / 文本进入 pi 槽位）与送达（`message_end(user)` 命中消息标记 = 已进 transcript）显式分离，只有拿到送达回执的条目转终态，停留受理的由对账器接管。`sendChecked` 的同步 settle 时点维持**受理口径**（agent 间 send 的 `{queued:true}` 契约锚定受理时点，不因送达而阻塞工具调用），记账回调 `onSettled` 为送达口径。
3. **对账器**：五触发点（agent_settled / compaction_end / abort 完成 / pi restored / 30s watchdog）在「空闲 + pi 槽位非空」时 `clear_queue` 全收，按消息标记三分处置——reclaim（内核在途条目回队首重投）/ rebuild（带标记但内核无记录，先按标记对 transcript 全量扫描判已送达再决定重建或仅记账）/ adopt（无标记外来文本收养入队；rebuild 身份判据的尾附锚细化见 ADR-0077）。撤销（`delivery.cancel`）与投递中收回复用同一路径（pi 只有队列级原语，不新造条目级原语）。
4. **消息身份**：出站文本尾附裸标记 `<!--taiji:msg:<uuid>-->`（与 msg-id-mapper 的 `u-` 前缀标记空间互斥、正交共存），随文本进 transcript 成为逐消息精确身份；判重按 id 匹配（禁计数 FIFO / 文本匹配）；终态 tombstone 在 runtime 存活期内全量保留供 `delivery.resync` 去重，不跨 runtime 重启——reattach 场景判重锚回落 transcript 全量标记扫描。
5. **UI 单一数据源**：队列区状态帧 = `session.delivery`（内核条目**投影视图**：活跃态全量 + delivered 最近 50 条完整条目 + lane；cancelled 不投影），`queue_update` 帧降级为内核内部回执；pi 的 steer/followUp/clear_queue/get_state/get_entries/nextTurn 契约原语全部保留复用，零绕过、零重造。
6. **回执锚申报制（`DeliverySubmitOptions.receiptAnchor`，消息链路去冗余 D1）**：条目级提交选项 `'marker' | 'acceptance'`（缺省 `'marker'` = 保守语义）——`'marker'` 条目出站文本尾附裸标记、等 `message_end` 回执命中转 delivered；`'acceptance'` 条目（无回执锚点的 agent 通路文本）port.send 受理即落 delivered——「受理 = 送达」是无锚条目唯一可判事实（前提 = pi 无逐条回执原语）。申报制替代旧适配层文本反查（反查在合批/混合批次下构造性失效——G2 投递死锁根因：无标记合批第 5 环确认落空 → in-flight 永挂 → gate 恒关）；内核保持零正则、零 pi 知识，无标记判定归有身份知识的提交方。receiptAnchor 是 KernelEntry 内部字段，不进条目视图 DTO、不进 session.delivery 帧（投影面零扩散）。**来源清单（SSOT；新增无标记投递来源必须显式申报 `'acceptance'` 并回登本清单——漏申报 = 条目永挂 in-flight、该 session 投递 gate 恒关，诊断链见 [data-source-registry #15](../architecture/data-source-registry.md)）**：`'marker'` 恒申报 = runtime registry `submit`/`submitToKernel`（`withDeliveryMarker` 在自己手里）；`'acceptance'` 申报点 = `completion-backflow.ts`（agent 完成回流）/ `session-manager-handler.ts`（agent-managed send）/ subagent-core `notifier.ts` handle.send fallback（通知出站文本无标记）/ subagent-core pi-host（custom payload，经 notify-ports.ts 影子契约同步）。护栏 = 提交方行为锁单测（subagent-workflow notifier-receipt-anchor 装配测试 + runtime S1 复现单测，重构丢申报时亮红；无通用正则护栏——与内核零正则冲突，有意不做）。演进路径 = D7-33 per-id 回执契约改造后，`'acceptance'` 保守口径被逐条回执替代。

**后果**：消息「按序必达」由结构保证——任一窗口的判定误判从致命降级为一次对账回收，新发送方接入即继承（无需各自发明时序防御）。已接受代价：出站消息文本携带 ~40 字符裸标记进 LLM 上下文与 session 文件（展示层剥离 SSOT = `apply-entry-convert.ts`，live/reload 同点）；判重表不跨 runtime 重启（reattach 走一次 O(transcript) 标记扫描）；删除 session = 显式废弃未送达条目（与既有语义等价）；消息内核 outbox 不落盘——应用整体退出/崩溃时未送达消息需用户重发（不劣于既有 renderer 内存队列形态）。权威域注记见 [pi-boundary-reliability.md 附录 E](../architecture/pi-boundary-reliability.md)。登记 C-data-08、C-data-25。

### ADR-0063 session 附着不变量 I1-I5
五条硬不变量防「会话写错文件/丢数据」：I1 runtime 登记路径必须恒等于 pi 实际写目标（`session-attach-assert.ts` 附着后 get_state 对账，不一致即 throw）；I2 对话数据只许存在于 sessions 目录 + 内存（禁入 $TMPDIR）；I3 退出/切换前登记文件须含 pi 已写全部 entry（`__tests__/equivalence/attach-lifecycle.test.ts` 真实 pi 等价测试）；I4 pi 内部行为断言必须带 pi-mono 源码锚点且穷尽全部消费层；I5 会话文件身份是受治理数据。登记 C-data-10。

### ADR-0062 单一数据 owner + 绝对写规则
pi 当前持有的 session JSONL 唯一写方是 pi 进程——taiji 任何代码永不直写，能力缺口由 pi 扩展在 pi 进程内补齐。三类登记在案的合法边界形态：sidecar 家族四后缀（.meta/.preset/.project/.handoff.json，写前 existsSync 检查）、fork 文件创建型、restore-time 归一化 rename-over（inactive-only、白名单变换、每文件一次）。标量状态复制模式 = 快照拉取 + 事件只做失效（事件永不直写数据）。登记表 SSOT：[docs/architecture/data-source-registry.md](../architecture/data-source-registry.md) + `replicated-states.config.ts`（新数据 = 新配置条目）。登记 C-pi-07、C-data-01。

### ADR-0083 btw 旁路提问：派生临时会话形态
btw 旁路提问（主对话旁开 drawer 辅助对话流）的会话形态定案（2026-09-22 定案，2026-09-23 交付）：① 每条 btw 线 = 主会话当前进度的 **pi 原生 fork 全树快照**（`--fork` + `--session-dir`，含分支；不复用 session-fork.ts 单路径截断），跑在独立 pi 进程；源状态三分支（正常 / 无快照线（fork throw → 回落无 fork 新建 spawn，宿主零直写）/ 截断快照）；② 虚拟 ID 第三家族 `btw:<piSessionId>` 两段式（与 pi id 零冲突契约：真 sid 禁冒号、虚拟 id 永含冒号；派生键第二段 = owner piSessionId，INVAR-1.1 强制化 + 生产值域断言）；③ 持久化 = 目录即关联（`btw/<encodeCwd>/<mainSid>/`，注册表启动重建 hidden 复原）+ 重载链（applyEntry 全量回放；离线尾读含 btw 目录解析路径）+ 孤儿补账；仅主删级联删（deleteSession / deleteByCwd 连带）/ 显式关线，关闭/退出/闲置回收均不删；④ G4 三防线（目录隔离 / `hidden: true` / 不记工作区历史）——关联只服务生命周期与自身线列表，不进任何展示链；⑤ 派生资源边界（zcode selection side chat 先例对照）：命令族硬禁 + 派发能力保留 + 投影收窄（无 opener）+ 派生键三触发分层（失效保留 / 终结清除 / btw 驱逐同驱）+ model-only 行为契约注入；⑥ 挂起交互请求终态机（应答 / 撤回 / 失效 + 回收提醒/未读清除支），失效提示三路收敛——事件 invalidated 与快照对账差集两路写入收敛单入口 + 回放悬空对账独立路（信号源 = pi 会话文件持久层，不依赖内存簿记跨进程存活）；交互呈现现行形态 = **D8 降级启用**（V4 核实三通道抽离的 plan 通道不成立）：五类请求统一 drawer 内联确认条 + 富表单降档，三通道 per-vid 路由为未启用备手（产品意图仍为与主 agent 同形态保真，plan-store 分区化后可复评启用）。权威源：`.tmp/tech-design/btw-question.md`（设计文档，不入 git；实施记录 git 可追溯）。登记：数据面见 data-source-registry ⑧ btw 补登链；未新增约束族（机制边界由既有 C-ext-19 / C-pi-12/13 / C-data-01 等覆盖）。

### ADR-0123 codemode 常驻默认开 + 设置页可关（2026-10-03 用户裁决，codemode 设计 T1 确认点）
**决策**：codemode（pi 1.0 内置的脚本化工具调用能力）产品形态 = **常驻默认打开 + 设置页开关可关（默认显示开）**——用户零配置开箱即得。落地三支柱：① **启动迁移幂等写入**：settings.json `defaultTools` 字段缺失 → 写 `["+codemode"]`；字段存在（含坏值）→ 不碰，尊重手改——「字段缺失 = 未配置 = 默认开；字段存在 = 有人配置过 = 尊重」，与 pi `mergeDefaultTools` 缺失回落语义同构；② **开关写增量条目**：打开 = 先移除 `"-codemode"` 再按 pi 解析语义幂等补 `"+codemode"`；关闭 = 移除 `"+codemode"` 与纯名 `"codemode"` 后，数组为空时写 `["-codemode"]` 占位（防启动迁移写回、防落空数组），非空则保留其余条目原样——激活态单一事实源恒为 settings.json，禁止运行时 `setActiveTools()` 影子点亮；③ **spawn 恒带装载旗标**：pi spawn 参数恒带 `--extension builtin:codemode`（pi 1.0 起 `--no-extensions` 把内置扩展一并排除，缺旗标会「配置已开但会话未装载」）。

**依据**：pi RPC 无 per-session 工具开关参数，settings.json `defaultTools` 是唯一持久控制通道；增量条目与用户手工编辑、MCP 侧 `autoEnableCodemode` 联动正交同向叠加。否决面：launch preset `--tools` 会话级全量枚举（pi 调整默认集即静默失真，多入口重复接线）；运行时激活 API（影子状态双源漂移）；纯开关无默认写入（违背默认开裁决）。

**登记**：无新约束族。实装 = `packages/runtime/src/infra/pi/pi-codemode-settings.ts`（启动迁移 + 字段域 + 损坏 fail-fast 跳过告警）+ `packages/runtime/src/infra/pi/pi-settings-store.ts`（'tools' scope 与损坏检测单点）+ `packages/pi-rpc/src/spawn-args.ts`（恒带旗标）+ WS 通道（`packages/runtime/src/services/ports/codemode-settings.ts` / `packages/runtime/src/transport/codemode-message-handler.ts`）+ `packages/renderer/src/components/settings/system/SystemCodemodeSection.vue`。机制现状另登记于 [docs/CONTEXT.md](../CONTEXT.md)（codemode / defaultTools 词条）、[docs/FEATURE-PRIORITIES.md](../FEATURE-PRIORITIES.md) 与 [docs/architecture/data-source-registry.md](../architecture/data-source-registry.md) §6；设计文档 `.tmp/tech-design/codemode.md`（不入库，过程产物），本条即该裁决的现行登记处。

### ADR-0124 出站结果回程契约：disposition 终局 + handled 通知 + 孤儿对账 + 命令出站形态（2026-10-04 设计裁决，pi1-disposition-chat-flow D1/D2）
**决策**：出站条目的终局判定由 pi disposition 响应与投递标记回执双通道承接，终局事实一对一通知前端：
1. **disposition 接线 + handled tombstone 终局**：出站 prompt（`promptWithBusyRetry`）读响应 disposition（rpc-client 出口经 `parseInputDisposition` 归一）；extension 命令被 pi 接管（disposition=handled）的条目不进 in-flight 等待，直接写入 `DeliveryTombstone`——终态固定为 delivered，语义从「送达事实」扩为「离开系统的事实」（不新造终态形态；cancelled 保持用户撤销专用——被接管混入撤销判据面会破坏 `isUserReclaimRejection` 双信号判据与「已投递不可撤」语义），继承断线重连 resync 判重防线。
2. **终局通知**：内核经 WS 消息 `session.deliveryHandled { sessionId, clientUuid }`（一次性事件消息，非 last-value 快照）一对一通知前端；前端静默回滚三件套（移除乐观气泡 + 清空空窗计时器 + 递减在途计数），无错误提示。不采用快照消息承载（消息缺席无法区分取消/接管/丢失）与受理回执携带（受理回执必须即刻返回，等处置会让 reply 时延顶到 pi 处置时长、且把受理口径按车道割裂）。
3. **孤儿对账**：`session.delivery` 快照到达（含断线重连回放）时，本地在途气泡的 clientUuid **曾经在场**（曾出现于任一帧投影——必要条件，防连发场景误清第二条气泡）且已离开在途（终态判据双分支：不在当前投影 / 在投影呈 delivered 终态）→ 按 handled 同形态静默清除。数据源 = delivery 快照投影而非 transcript 投影（pi 1.0 首次 flush 前会话文件不存在，transcript 口径不可判定；且仍在内核排队的条目会被误清）。**操作域限定（U2 实装收窄）**：对账清除只作用于受理回执 isCommand 登记的命令条目（useChat `handledDeliveryTargets` 在册成员）——普通消息条目终局必有 message_end 回执链管气泡，孤儿清除操作普通条目会在「快照帧先于 message_end 回执到达」窗口删掉已送达气泡（direct 车道降级豁免下构成文本丢失面）；命令条目不注标出站永无回执，是唯一悬挂源，清除恒正确。「本端无取消操作」豁免条件随操作域收窄结构性消解，无需取消豁免集合——命令条目撤销后清除恒正确（cancel 成功 → 内核删条目 → 下一帧「不在投影」分支清气泡，原文已回填草稿；cancel 竞态落败 → delivered 在场 → 命令已执行，清气泡同样正确）。曾见集合随对应气泡移除、上界 = 活跃气泡数；页面刷新后退化为「不清除」（保守方向，误清零风险），悬挂残留由重开 session 恢复。
4. **命令识别 + 出站形态分型**：session 建立时经 `get_commands` 拉清单缓存；识别规则 = 文本 `/` 开头 + 首空格前段剥前导 `/` 后与清单 name 逐字精确匹配 + `source === 'extension'`（pi 侧接管判定只查扩展注册命令，匹配集与匹配口径两侧构造性一致）。识别为命令的条目出站**不尾附投递标记**（裸命令文本），终局凭据 = disposition 本身；未识别的 `/` 开头条目按普通消息带标记出站（实际被接管则 handled 仍驱动终局，纯单词漏识别则退化普通回合、与现状一致）；skill 与 prompt 模板输入恒走普通消息链路（注标出站 + message_end 回执——两类输入在 pi 侧展开开回合、不返回 handled，剥标记即无终局凭据）。清单拉取失败时全量按普通消息出站（兜底分支）。

**效果**：命令终局时效从「永等 → 30s 超时」变为「响应即终局」；普通消息出站形态与送达回执链路零变化（pi 无输入持久化回执，标记 + message_end 命中是唯一送达凭据）。实装 = `packages/runtime/src/services/session/session-delivery-registry.ts` + `packages/session-delivery/`（内核）+ `packages/shared/src/protocol.ts`（`session.deliveryHandled` 消息）+ 前端消费（useChat / store）。登记无新约束族（ADR-0074 投递所有权内核的回程通道延伸）。设计文档 `.tmp/tech-design/pi1-disposition-chat-flow.md`（不入库，过程产物），本条即该契约的现行登记处。

### ADR-0125 occupancy 事实驱动 + CP6 回落窗退役（2026-10-04 设计裁决，pi1-disposition-chat-flow D3）
**决策**：occupancy（dispatching/generating/idle 投影）回落由事实凭据驱动，2 秒定时回落窗（CP6）退役：
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

## 通信与协议

### ADR-0055 MessageBus：per-session 消息分发 SSOT
runtime→renderer 的 per-session 消息分发（`packages/runtime/src/services/message-bus/`）。每 session 维护单调 seq + 1000 条 ring buffer + stateSnapshot；renderer 切 session 时 `session.subscribe` 走「snapshot 回放 + last-value 注入 + lastSeq 基线」，此后 live push 靠 seq gap 检测触发 reconcile。ServerMessage 的 id（RPC reply）与 seq（push 事件）互斥。session 级消息已收敛为 bus.publish 单通道，global 级走 broker.broadcast。登记 C-comm-06。

### ADR-0060 route-inbound 三通道路由
入站消息分发单一真相源在 `packages/core/src/coordination/route-inbound.ts`，三出口：dispatchSession（per-session 消费者）、dispatchGlobal（无 sid 消息）、dispatchCrossSession（带 sid 但全局消费者需收的消息——extension:widget/status/notify/ui_request 等，合法消费者仅 ExtensionHost）。crossSession 不是广播；raw-message-tap 旁路已删除。事件分发面在 `core/src/transport/api/events.ts`。登记 C-comm-05。

### ADR-0046 RPC 类型配对 SSOT
协议层单点真相源——`packages/shared/src/protocol.ts` 的 ServerMessageMap + ReplyPayloadMap（K → reply payload 或 void），domain 侧经类型化 `command<K>()` 原语从协议推导，禁止手写泛型与协议脱钩。登记 C-comm-07。
协议条目退役执行记录（防未来重提）：`message.steer` / `message.follow_up` 已按投递所有权内核 u5a 退役条件删除（runtime transport 路由 + dispatcher/sessionService 转发腿 + 协议三处条目同批删，消费方统一收敛 delivery.submit，lane/intent 判定归内核）；`send.rejected` 保留（runtime bash 通道 busy 时 publish 的活生产腿，bash 通道在投递内核改造面之外）。

### ADR-0016 ServerMessageType 类型约束（部分有效）
事件/RPC 消息类型受 ServerMessageType 联合约束，emit 拼错编译期报错（原 event-bus 文件已随包重构消失，现形态 = protocol.ts 类型定义 + route-inbound 分发，约束精神不变）。

### ADR-0010 / ADR-0012 Extension UI 独立通道（0012 的 plugin bridge 部分已退役）
pi extension 的 confirm/select/input 交互走独立 `extension.ui_request`/`extension.ui_timeout` 事件，与 Tool Approval 的 tool_call_pending 语义隔离、错误隔离；该通路的现行形态 = event-adapter 直接消费 pi 事件按结构化字段路由（ADR-0111）。plugin-bridge 已整体退役（插件工具进 pi 通路暂缺，现行登记见 `docs/todo/plugin-tool-access-gap.md`）。登记 C-comm-12。

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
- **B 型机制替换**（2 项）：`interact` 控制面方法删除（续聊统一为新 run + resume 锚点；双轨 = 两套执行模型在 reducer/journal/conformance/能力门四面长期双维护，本身就是协议债）；`task.conversation` 键删除（per-run 模式开关语义消亡、职责并入 resume，双保留会造成「谁赢」的语义纠缠）。同批切换合法，条件 = 对端同仓 + ADR 登记（即本条）。
- **C 型死成员清理**（3 项）：轮次相位反向通道（新增后从未被消费）、`host/poolResolved` 通道（poolKey 恒 'shared'、回调零信息量——池抽象降级，docs/architecture/zcode-engine-appserver-resident.md）、`host/permission` 通道骨架（双侧零实装占位，「未接线死通道」）。根因不在删除在**新增**——治理 = 新增门槛：无消费方不进协议、占位先行即违宪（与能力位「声明链路实际接通的能力」哲学同源）。

**判据 1-7 证据锚点**（条文终态见 engine-protocol.ts 头注）：判据 1（引擎不消费→宿主自持）→ `task.idleTimeoutMs` 错位（六引擎映射全部不支持，实为宿主 idle GC 参数）；判据 2/3（what→task / 推导分叉→ctx）→ schemaEnv 三次搬家与 sessionRootId 事故补丁（文字判据靠人执行必然漏的两次实证）；判据 4（task/ctx 双写禁令）→ schemaEnv 双源事故——**H1b 收敛未完成**：`packages/subagent-core/src/execution/engine/client/remote-engine.ts:382` 仍 `ctx.schemaEnv ?? task.schemaEnv`——wire 层禁令断言现状纯 never、无豁免（AgentCallOpts 已单侧排除 schemaEnv，键集交集为空），双源现状登记于断言注释（wire-field-locks.test.ts）待收敛回看；判据 5（能力位双向回指）→ 先例 streamMode↔eventGranularity；判据 6（键三分类 + behavior 键必配门）→ resume↔conversation gate（error-codes.ts `assertChatConversationSupported`）与 forkSource 注释双先例，判别式 =「旧引擎静默忽略此键，宿主会发现吗？该降级是设计内吗？」（三案例归档唯一：resume→behavior、streamMode→degradable、description→advisory）；判据 7（能力位消费点/载体登记）→ steer 首个登记条目（capability-gate.ts 联合判据消费、pi-host-binding.ts 声明 unsupported，无独立 wire 执行通道——缺失如实登记，不设计）。

**演进政策三条**：① additive 面——新增可选字段/事件变体/方法/反向通道不 bump 版本，旧端忽略或 no-op 安全落空；新增须过门槛：消费方 + 降级路径 + 能力位绑定三件齐才进协议，无消费方不进协议。② 删除面——A 型同形改名默认「新增新键 + 旧键 deprecated 双读 + major 清除」；B 型机制替换/语义收窄同批切换合法（条件 = 对端同仓 + ADR 登记）；对端独立节奏出现时删除一律走 major。③ major bump——core 支持区间平移 `[1,2)→[2,3)`，遗留清单届时清理。存量不搬家（搬家本身是删改），遗留清单 = idleTimeoutMs（明确错位）/ scene、description（弱错位待核）/ schemaEnv（待 H1b 收尾，未收尾）/ steer 执行通道缺失；**重审触发条件** = 遗留清单 >5 项或任一错位引发实际派发事故 → 提前清理裁决，不等 major。

**未知成员宽容语义四行**（与编译期词表锁互补的运行时半边；词表头注与 engine-development-guide.md 引擎实装义务落地随之推进）：①未知 event.type → 旧宿主 reducer default no-op 安全落空（逐变体 noop-safe 论证标记）；②未知正向 method → 引擎回 error 帧 `engine_method_unsupported`（engine_ 前缀透传面新码，旧宿主收到不崩；引擎实装义务绑定下一引擎适配层立项随批带上 + conformance 用例，当前无消费方不实装）；③未知 host/* 反向通道 → 宿主回 `{unsupported:true}`（由 askUser 语境泛化到全通道），发送方引擎走自身降级路径；④未知可选键 → advisory 忽略、behavior 键必有门（判据 6），不存在无门依赖。配套机器锁 = **四张词表锁**（事件/方法/通道/能力位键集统一为常量 SSOT 派生或键集互锁，编译期红灯堵 schema enum 缺值与缺键 undefined 透传洞）。

**minor 协商触发条件（任一命中重开裁决；条件不到不加协商位）**：① 出现本仓之外发布的引擎适配层（第三方作者或独立 npm 分发/版本节奏）；② 单宿主需同时挂载跨协议代差引擎且无法同批升级；③ 出现「需宿主确认才可启用」的运行时可变能力（能力位从静态 manifest 变动态协商的真实需求）。

判据 1-5 是宿主→引擎字段归属判据，不适用于引擎→宿主上报（引擎→宿主新增帧/事件按上述演进政策与反向通道关联键总纲裁决）。权威源 [subagent-engine-protocolization.md](../architecture/subagent-engine-protocolization.md) §3.3「协议演进宪法」。

### ADR-0091 workflow run 显式状态机：转移表裁决 + 事件流权威投影（2026-09-21）
workflow run 生命周期治理（`packages/subagent-core/src/orchestration/run-events.ts`）四件套：① `RunLifecycle` 5 态显式状态机（`created/dispatched/running/settling/terminal`；W2 死形态清退收敛，见 [ADR-0080](#adr-0080-runrecord-状态机收敛五态机唯一权威--outcome-四值--record-意图原语即状态机2026-09-27-设计裁决)；已被 [ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 修订为四态 + interrupted 暂停态——dispatched 并入 running、interrupted 入 lifecycle 为非终局暂停态），`transition` 纯函数 + `RUN_TRANSITIONS` 转移表是唯一裁决面——表外转移 fail-fast（`IllegalTransitionError` 让位 + debug 留痕），禁止直写状态字段；约束由 API 形态结构性承载（对外只暴露 query + transition 唯一入口），非 grep 检查型、不设独立约束登记。② 事件流 journal（`RunEventJournal`，`<agentDir>/workflow-state/<runId>.events.jsonl`）是 run 态权威投影源——注册表投影 = journal fold 四相（missing/active/terminal/interrupted），文件 mtime 推导退役；abandon 是终局化动作（被动终局写 run-settled 帧 outcome='interrupted'），非静默丢失。（介质与 abandon 已被 [ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 修订：事件流更名 record 单源 `.record.jsonl` 且升格唯一事实源；abandon 全链移除，中断改落 `run-interrupted` 转移事件非终局帧）③ 终局诊断引用（stderrTeePath）随 ask-settled 登记事件流、终局投影从事件流读回——不引入第二写点、不扩 run-settled 载荷。④ run 级恢复场景的杀伤半径收窄（D9-2）：watchdog no-progress 与 cancel 收敛兜底两类调用面从全量按进程组终止 `killAll` 收窄为 `killRunTopology` 定点收割（只杀该 run 锚定的引擎孙进程，引擎宿主与同引擎并发 run 存活；零拓扑引擎降级为 stall 出声不杀——ADR-0047 静默 ≠ 卡死）；dispose（停机全灭）/ stdout-wedge（引擎级路径楔死）/ failEngine（引擎级故障，反向通道楔死）三调用面豁免保留按进程组终止——故障定位在引擎级而非 run 级，本无 run 级目标。排障姿势见 [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) §26。

### ADR-0075 workflow 域四支柱平移与 schema 通道终态（2026-09-21）
workflow/subagent 域对 pi 边界四支柱（ADR-0064）的同构落地与 schema 传输终态：① **确认式送达平移**——注册操作的终局通知必达，workflow run 成功/失败/取消一律出终局通知（持久账本 + 幂等键，C-ext-19 在 workflow 域的细化）；② **生效回执平移**——schema 强制武装回执：`armed` 事件是引擎自查断言之外的独立信号源（监控信号不与施控同源），宿主等待窗内未收到即 fail-fast；仅 native 引擎、仅 schema 任务上报，emulated 引擎恒不上报（契约义务权威源 [engine-development-guide](../extensions/subagents/engine-development-guide.md) §6 `armed` 行）；③ **契约显式化**——schema 跨进程只经 wire `task.schema` 单字段传输（env 预编码形态 `schemaEnv` 已退役，env 由引擎宿主从 task.schema 派生，resolver 产出侧负断言锁防回流）；扩展加载显式化（`ctx.extensionPaths` 白名单收窄落壳侧 pi-host，argv 镜像机制退役）。**schema 通道终态**：native schema 链保留直传（宿主对 parsedOutput 不做二次校验）、emulated 仿真为退出通道，由 `schemaEnforcement` 能力位声明分流。登记 C-ext-24 / C-ext-25 / C-ext-26。

### ADR-0094 run/record 介质归位：journal 唯一事实源 + 两条 v2 条目 + 收编统一（2026-09-26）
workflow run 与 subagent record 的运行态持久化介质收敛（承接 ADR-0091 的事件流 journal，把「权威投影源」升格为「唯一事实源」）：① **journal 唯一事实写**——run 侧既有 `<sessionDir>/workflow-state/<runId>.events.jsonl`，record 侧新增 `<recordsDir>/<sa-id>.events`（无 .jsonl 后缀——既有 .jsonl 扫描器/清理器结构性忽略该文件族；首行 `{"type":"record-journal"}` 头行自描述），两域事件行均携带单调 seq；② **主 session 每实体只写注册 + 终态两条 v2 小条目**（customType 不变、v 升格 2、kind 判别 registered/settled；终态条携带 result 全文与 engineHandle 双键；注册条携带 journalPath 锚点——session-reader workflow 发现链主源）；v1 全量快照 entry（含 eventLog/displayItems 死字节）停写；③ **state/manifest 降级为 journal fold 的物化投影**（可删可重建、读方零改动；.alive 仍是操作租约不计事实源）；record-bound 时物化一次 running manifest（zcode 运行窗口锚定，带锚定就绪检查与写失败降级）；④ **恢复统一为「journal 重放 + 收编」**——「有注册、无终态」的实体经幂等收编入口补追加终态事件（先查双面证据防重复），recoverCrashedRuns 与 abandon 的终局化同走该入口（证据落点对称）；⑤ **清理 = 显式保留窗口（默认 30 天）+ fold 终态资格判据，cap=50 废除**（多 session 分摊误清消除），统一保留维护轮承接 run/record 两域，session-file-gc 对 `*.events` 显式忽略；⑥ **runtime 读路径 = 内存投影**（entry 游标 + journal tail 双增量源单点合并，同实体冲突 journal 胜出；32MB 预检与全文重读退役为旧格式惰性兼容读专属；WS 信号形态不动）。写面检查 `scripts/check-record-write-surface.mjs` 断言面同步（R1-R7：写函数直调 / 两族条目写面白名单 / v1 快照投影构造器与载荷形态拒绝 / 死字节拒绝 / .events 直写拒绝）。条目契约单源 = `packages/subagent-core/src/execution/persistence/record-entry.ts`（subagent-record 族）与 `orchestration/workflow-record-entry.ts`（workflow-record 族）。登记 C-data-20（写面唯一入口口径刷新）。

**写面宿主扩充（2026-09-29，resume 修订 D15/D16 落地连带）**：workflow-record 条目写点宿主在原三写点（worker-message-pump.ts / lifecycle.ts / 壳 jsonl-run-store.ts）基础上新增 terminal-actions.ts（D15 终局编排单一入口的注册/终态条目写点）与 resume-run.ts（D16 resume 链注册条目写点）——条目构造仍全走 buildWorkflowRecord*EntryData 意图原语与 appendEntry 通路，写面唯一入口语义不变（宿主清单扩充非写点扩散）；`check-record-write-surface.mjs` R3 白名单同步为五写点宿主。

**v1 兼容层已整体删除（2026-09-30 裁决：项目未上线、无 v1 数据，不迁移不兼容；登记 §3.3）**：原「W4 legacy sunset 失效版本清单」的 subagent-record 侧写读面全部落地删除——
- core `record-entry.ts`：v1 快照接口 `SubagentRecordEntryData` 与写点 `toSubagentRecordEntry` 删除，`classifySubagentRecordEntryData` 收为 v2-only（`ok:true` = 当前版本条目；v1 形态归 `future-v`）；
- core `record-store-rebuild.ts`：v1 收集/重建路径删除，改为 `collectV2EntryPairs` / `v2PairToRecord`（v2 注册 + 终态条目对；身份域损坏拒绝重建）；
- core `record-store.ts`：`reportSubagentRecord`（v1 快照纠偏写点）删除；孤儿恢复改由 v2 形态承担——事件文件在者归 `adoptV2Orphans`，entry-only 形态（注册条目在、无事件文件、无子文件）归 `recoverEntryOnlyOrphans` 补写 v2 终态条目（stopReason=interrupted-by-restart）；
- runtime `journal-projection.ts`：`v1Subagents`/`v1Workflows` 源与「v1 冻结定界优先」仲裁删除（该仲裁是「投影遮蔽事件流」的方向性缺陷本体）；
- runtime `subagent-extractor.ts`：v1 快照分支删除，改按 v2 条目对重建；
- 遗留未删（非 subagent-record v1 快照面）：`workflow-extractor.ts` 的 workflow 旧形态分支与 `session-file-extraction.ts` 全文读路径（32MB 预检——冷启动旧 session 兜底）；session-reader discovery/workflows 的旧 workflow-state-link 指针 fallback（三档发现链的下两档）；
- state-marker 旧值（finalized/cancelled）上行映射等伴随面（`Atomics.wait` 同步睡重试已随 W1 D6 全量退役，无 W4 残余——state-marker.test.ts 断言锁定）。

**第六读者失效登记**：`scripts/zcode-session-db-cleanup.mjs`（zcode 引擎存量宿主行清理工具）自持 customType 白名单解析带 `data.v !== 1` 版本门——v1 条目停写后对全部新记录恒跳过、白名单恒空 → 清理面恒空，属**功能性保守降级**（漏清不误删：新记录本来就不落宿主库，白名单空集 = 零删除，语义安全）；该脚本为一次性清理工具，不随 W4 sunset 强制退役，重跑时对存量 v1 数据仍有效。

**修订注记（2026-09-30）**：事件文件头行已定 `{"type":"record-events"}` 并落盘（`RECORD_EVENTS_HEADER_TYPE`，`record-events.ts`——本文 `record-journal` 头行表述以本注记为准）；落盘键与符号旧词清理已落：`engineHandle.journalPath` → `engineHandle.eventsPath`（SDK wire 契约 + core record/manifest/entry 形状 + 读写两侧 + 扫描守卫同批）、workflow-record 注册条目锚点键 `journalPath` → `recordPath`（无 v1 数据，不留兼容读）、遗留符号清单改名完成（`JsonlEventJournal`→`JsonlEventStream`、`RecordJournalWriteFace`→`RecordEventsWriteFace`、`RecordJournalFoldState`→`RecordEventFoldState`、`journal-tail.ts`→`event-tail.ts`、`SessionJournalProjection`→`SessionEventProjection`、`journal-wiring.ts`→`event-journal-wiring.ts`）——本文 `journalPath` 锚点等旧词表述以本注记为准。

**读侧换源与 manifest 裁决（2026-09-30，②④ 批次落地）**：record 读侧身份/统计/revive 基线全部换源事件流折叠（`identityFromFold` / `receiptStatisticsFromFold` / `baselineStatisticsFromFold`——TerminalCtx 增 `foldOf` 注入位；binding 读函数零生产读路径，`.record-binding` 只剩写面与戳职责，写点退场 = 后续批次）；record 侧 manifest 裁决为**方案 A：收敛为带水位纯索引**（`eventsStamp` 水位统一收口 `withEventsWatermark`，markSettled 改先事件后投影写序；读侧不匹配即跳过回落重建）——方案 B（删除 manifest、session-reader 换源 fold）被否：session-reader 侧改动面 6 文件超阈值、其生产依赖面刻意不引 subagent-core（折叠无法复用又不许复制）、孤儿可见窗口语义等价拿不准；跨包读取面是 manifest 整体退场的挂起点。索引条目 v3 自承收条统计域（turns/totalTokens）；负缓存三消费点（reconstructAll 快路径 / scanFile / buildEntryFromIndex）增事件侧反查击穿（bound 帧追加不写 binding 也可见）。

### ADR-0080 run/record 状态机收敛：五态机唯一权威 + outcome 四值 + record 意图原语即状态机（2026-09-27 设计裁决）
workflow run 与 subagent record 的状态词表与状态机形态收敛（承接 ADR-0091 显式状态机与 ADR-0094 介质归位；权威源 `.tmp/tech-design/w2-state-machine-convergence.md`——设计文档不入 git，实施记录 git 可追溯）。七件套：

① **run 活体终局单一裁决点**：活体终局全部经五态机 `dispatchRunTrigger` per-run 串行队列裁决（表外转移 fail-fast）；两态机（`RunStatus` running|done + `state.status`/`state.reason` 快照字段）降级 v1 兼容层——活体写点删除，恢复路径写点显式清单保留（`recoverCrashedRuns` 公共快照收敛），live 读者（终局判定 / 通知载荷链 / 淘汰排序 / sweep 判据 / 投影读者等）全部换源 journal fold 与终局记录，禁止以 `state.status`/`state.reason` 为活体终局判据或载荷源。终局记录四件套（journal run-settled 帧 / manifest / 终态条目 / pending 注销）收敛为共享原语 `settleRunAccounting` 单点，活体终局 / 崩溃收编 / abandon / idle 回收四场景共用，场景差异只在触发时机、幂等判据与 outcome 取值，不在记录结构；完成通知回调仅活体路径注入，冷路径（收编/abandon/回收）不执行——中断 run 不产生 workflow-result 完成通知。

② **lifecycle 死形态清退，六态收敛五态**（created/dispatched/running/settling/terminal；已被 [ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 修订为四态 created/running/settling/terminal + interrupted 暂停态）：`interrupted` 态（无进入事件）、`host-died` 控制触发、`ask-executing` 事件、`abandon-elapsed` 控制触发与 `from:"interrupted"` 表行全部删除；`RUN_EVENT_TYPE_PROBE` 键型随词表缩窄恢复穷尽（member-pool 补键，runtime typecheck 由红转绿即修复验收锚）。

③ **outcome 升四值**（`RunOutcome` = completed/failed/cancelled/interrupted，`ALL_RUN_OUTCOMES` 单源；已被 [ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 修订为 done/failed/cancelled/time_limited——completed→done 改名、interrupted 移出 outcome 入 lifecycle 暂停态、time_limited 从 errorCode 升格独立 outcome 值）：`interrupted` 是被动终局的唯一权威表达（「崩溃 ≠ 失败」的用户可感区分）——崩溃收编 / abandon 7 天窗 / idle-gc 30 天回收三条被动终局路径写 outcome='interrupted'，细分语境由 errorCode 承载（`interrupted_abandoned` / `idle-evicted`；该三路径已被 [ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 收敛：abandon 全链移除、idle-gc 已随 ADR-0081 退役，中断改落 `run-interrupted` 转移事件）；`cancelled` 保留「用户主动取消」语义不被稀释，显示面「已取消」（主动）与「已中断」（被动）禁混用。W1 存量收编帧（outcome='failed'）读侧不映射、按 failed 显示，登记已接受代价（随 core retention 保留窗自然出清，重审触发 = 被动终局语境帧占比 >20% 或出现用户可感误报）。DoneReason ↔ outcome 映射归单点函数（`runSettledOutcomeToDoneReason` (outcome, errorCode) 联合判别，预算/超时终局细分语境不折叠）；显示语义一律走 outcome 四值，reason 诊断面的折叠是已接受过渡形态（pending 注销条目 run 侧 'failed' vs record 侧 'aborted' 对同一崩溃场景并存，W4 DoneReason 退役时收敛）。

④ **record 域不建显式转移表，意图原语族即状态机**：唯一入口 = RecordStore 意图原语 + C-data-20 写面两级拦截（eslint no-restricted-imports + grep 门）；表外拒绝 = `tryEnterRunning` CAS 失败 + 原语前置断言；词表 = 三维正交单源——lifecycle 维（`ExecutionStatus` running|idle）× 停因维（`StopReason`，展示排障面）× 结果维（outcome 四值；轮终参数收窄 `ExecutionOutcome = Exclude<RunOutcome,"interrupted">`——interrupted 只由收编/回收路径写入，类型上构造性封死）。与 run 域显式转移表的不对称是有意的（两态域转移表只有两行有效转移，CAS 比表级 fail-fast 更早更严，复制六态域机制 = 重复保险式过度工程），验收判据两域统一（「表外转移构造性不可能」），不要求机制同构；`tryTransition`/`completeRecord` 说谎签名随调用方迁移到意图原语后删除。

⑤ **manifest legacy 三态口径归类为投影持久化格式**：manifest 是 journal fold 的落盘物化投影（ADR-0094），其 running|closed|cancelled 三态是投影持久化格式（单一生产者 = 物化步，消费方经翻译函数 `manifestToSubagent` 消费），不是消费方必须在代码里理解并翻译的状态词表——状态词表套数口径以「消费方直接消费的枚举」为准，manifest 三态不计入。shared `WorkflowRunOutcome`（core↔shared 依赖方向不允许物理单源的第三份字面量）同口径归类为**投影派生输出**并升四值，值域跟随由两道锚承载：runtime extractor 值级判定集合 `WORKFLOW_RUN_OUTCOMES` 同步升四值（漏升 = interrupted 经 session 记录提取链被静默丢为 undefined）+ runtime 双包值级等价断言（core `ALL_RUN_OUTCOMES` ≡ extractor 集合 ≡ shared 词表成员）；`WorkflowRunStatus`（投影二值，同先例）与 `WorkflowDoneReason`（随 W4 sunset 收敛）按同口径登记。

⑥ **abandon 注销差集登记不修（已接受代价）**：abandon 的 journal 帧 + manifest 两件直落，终态条目可选（壳触发点不传即不补，重开 fallback 补写）、pending 注销差集残留仅存在于「旧 session 永不重开」场景（该 session 内 pending 列表多一行，无跨 session 泄漏；重开即 reconcile-sweep 自愈——sweep 的 workflow 分支判据源已改接 journal fold / manifest 终态证据，非终态/坏链/IO 故障保守按活跃处理不误注销）。为低频残留给收编路径加「跨 session 定位旧 session 文件并写入」通道 = 新增写路径与新的失败情形，收益不成比例，不修。idle-gc 回收与 abandon 对称：same-session 四件直落齐套、cross-session 两件直落 + 重开自愈，同样不新增跨 session 写通道。

⑦ **词表单源的机器保证 = TypeScript 构造性保证**（删值后引用即编译红），不新增 grep 第二道检查；构造性保证的执行时点 = CI typecheck job 全包步承载跨包阻断（runtime / core / shared / SDK / extensions 五步覆盖词表改动范围，任一消费包漏同步即 CI 红）；UI 状态→颜色映射的穷尽锁（satisfies Record / never 断言）由 type-level 测试断言锁本身存在。

本波不新增约束登记（构造性保证无需第二道 grep 检查）；既有 C-ext-26（终局通知裁决点）/ C-data-20（record 写面唯一入口）口径不变。

### ADR-0081 idle-gc 机制退役，崩溃恢复收敛为事件驱动两层 + 启动扫描（2026-09-28 设计裁决）
**idle-gc 机制退役，崩溃恢复收敛为事件驱动两层 + 启动扫描**：30 天 TTL 定时器机制（record 内存回收 + workflow run 僵尸收编）整体删除——三个必要性论据经核实全部不成立（视图按目录取数 / journal 恒 KB 级 / retention 事件驱动），且机制跑在 pi 进程内、pi 空闲态事件循环停止调度周期任务使其在生产常态下停摆。替代 = runtime 启动序列（单实例锁确立后、先于任何 pi spawn）全量枚举收编 pi 宿主形态的 running run（两件直落：journal run-settled 帧 outcome=interrupted errorCode=startup-sweep【RunErrorCode 词表新增值】+ manifest）；判僵尸依据 = 双防线——启动时点排除新 pi（runtime 启动段不 spawn）+ 事件流静止宽限窗排除旧 pi 残活的末帧新鲜形态（graceWindowMs=60s：末帧距扫描时点过近即跳过本轮，runtime 崩溃自动重启可落在旧 pi EOF 收尾窗口内）；「旧 pi 残活且末帧已超窗」形态（长 ask 静默期崩溃）不设防，按四要素登记为已接受代价（后果 = journal 双 run-settled 帧，fold / outcome 主显示链真实终局被 interrupted 遮蔽，manifest 通道被旧 pi 终局覆写为真实终局、registry 投影 errorCode 取末帧亦为真实值——失真形态随消费方各异，排障以 journal 末帧为准；重审触发 = 双 run-settled 帧实例 / EOF 退出时延实测超窗）。record 内存回收无替代（驻留有界：session 结束进程退出全清；重审触发 = 单 session 驻留过千条或内存排障定位到 record 驻留）；孤儿 `.alive` 经三条代码证据核实无拦截路径（三分支重建判 running / 覆盖写 / pid 探针放行）。

### ADR-0082 workflow run record 单源收敛、生命周期与词表重构（2026-09-28 设计裁决，workflow-run-resume-revision）
**D1/D2/D3/D4/D5/D6/D7/D9/D11/D15/D16 + 裁决点 7 锚链原子批**（承 ADR-0081 的继承关系：idle-gc 退役后的替代链 startupSweep 在本批改经 D15 入口并换源 fold，其「双 run-settled 帧已接受代价」随 [D2] 中断转移帧形态整体消亡——中断不再是终局帧；承 ADR-0094 的介质归位：run 侧 journal 更名为 record 事件流并升格唯一事实源，state 快照物化投影取消）：
- **D1 record 单源存储收敛**：删 state 快照文件，唯一事实源 = record 事件流（`<workflow-state>/<runId>.record.jsonl`，append-only）——`run-created` 携带 scriptSource 全文、`agent-settled` 携带 result 全文，lifecycle/calls 全为 fold 内存投影，判终局 = record fold 唯一判法（无第二份可分叉的投影），收编 = 追加 `run-interrupted` 转移事件、不覆盖任何文件（双源病两阻断构造性消失）。壳 JsonlRunStore 重写为 record store 单模式（save = 显式 no-op；类名沿用历史文件名）。manifest 降格为 record 终局事件的派生缓存（判读 record 唯一权威 + manifest 加速，损坏即重建）；manifest 兼容读例外：历史 manifest 词表外 outcome（[D2] 前 interrupted 族——文件名未随 [D1] 迁移故磁盘可达）经判定核穷尽 switch 漏 undefined 时统一折叠诊断兜底容器 failed（W2 D5 先例「interrupted → failed」），不落 completed 兜底——中断形态报完成是语义误报；折叠收敛在 runSettledOutcomeToDoneReason 派生单点（reconcile-sweep-settlement.test manifest 用例 + pi-host-run-store 枚举 status 用例钉住）；旧格式两件套（`.events.jsonl` journal + `<runId>.jsonl` 快照）不读、不写、不主动删（用户裁决 2026-09-28：历史数据暂无不迁移——历史 run 不进 GUI 列表、resume 一律拒绝，随裁决点 7 清理自然消亡）；startupSweep 枚举判据换源 fold record（快照删除后原快照行 status 判据失效形态静默，D16⑥）；zcode 宿主 FileRunStore record 化不做（射程外，docs/todo 登记）。
- **D2 生命周期四态 + interrupted**：lifecycle `created → running → settling → terminal`（dispatched 并入 running——两态行为相同且零消费方）；interrupted 为暂停态（running/settling → interrupted：崩溃收编 / terminate 被动失联；interrupted → running：resume），非终局、无特殊转移行。RunOutcome 重构四值 `done/failed/cancelled/time_limited`：completed→done 与 shared status 同词；interrupted 移出入 lifecycle；time_limited 从 RunErrorCode 升格独立 outcome（新写入方无码，错误处理分级改双路判定——outcome 直判）。call 级（agent-settled 载荷）随共用类型随改不拆分，call 级实际值域 = done/failed/cancelled。宿主投影三态（shared WorkflowRunStatus 'running'|'interrupted'|'done'）；settled 终态条目仅 terminal 时写、中断形态条目 status 'interrupted'；中断 run 计托盘 ended 桶（显式裁决）。
- **D3 phase 状态机**：phase-started/phase-settled 转移事件入 record（worker 模板 phase() 经 postMessage 通知壳侧——模板快照同批更新）；fold 自愈规则（agent-started 载荷 phase 字段驱动 pending→running）承接 postMessage 异步丢失窗口，不判损坏。
- **D4 事件词对齐 pi**：ask-dispatched/retrying/settled → agent-started/retrying/settled；新增 run-interrupted/run-resumed。RunErrorCode 中断来源成员 crashed/terminated/startup-sweep；interrupted_abandoned/idle-evicted/time_limited 保留为历史帧解析（无新写入方）。
- **D5 armed 删除 / D6 member-pool 消解**：占位事件与词表成员删除；绑定改 agent-started 载荷 memberRecordId 字段（首派缺省、续写携带），member-reuse-pool 退化为绑定查询辅助，登记收尾零 IO。
- **D7 resume 入口跨进程锁**：锁文件 `<workflow-state>/<runId>.resume.lock`，proper-lockfile 直用（core 既有依赖 + worktree-registry 直用先例：`realpath:false`、stale 30s 夺取、指数退避）；锁段 = 资格校验 → v2 注册条目补写（先于复活事件落 record，失败干净拒绝——裁决点 7 引用归属）→ `run-resumed` 落 record → 活体注册；锁被占 = 拒绝文案指明另一进程持有；孤儿 run 清理时顺带删残锁（裁决点 7）。跨进程双宿主同时 resume 恰一成功（单写者纪律只到进程内的并发缺口封闭）。
- **D9 abandon 全链移除**：abandonElapsedInterruptedRuns 及常量/env 通道删除——「数天后回来仍可 resume」的 run 不再被判死；无主 run 清理归裁决点 7。
- **D11 terminate 被动失联分叉**：terminate 对 resume 接管来源 run 落 `run-interrupted`（errorCode=terminated）转 interrupted 暂停态——session 切换是被动失联，语义对齐崩溃中断、可再 resume；正常 run 维持 failed 终局（现状语义有消费方；统一转 interrupted 属独立语义变更，待用户另裁）。
- **D15 终局编排单一入口**：terminal-actions.ts 承载投递域（dispatchRunTrigger 单写者链）+ finalizeRun（terminal 五步 coda）+ interruptRun（中断转移统一写点，零终局副作用）；五路收敛 = abortRun / terminateRunningRuns / recoverCrashedRuns / startupSweep（u1b 接线）/ 正常终局链（pump 消息面）；v1 兼容尾段删除（store 覆盖写语义已随 [D1] 不存在）；worker-message-pump 薄化为消息路由 + 重试矩阵。
- **D16 宿主读侧锚链**：runtime RUN_EVENT_TYPE_PROBE 词表镜像（9 键）+ projectV2Workflow 三态投影；shared 三态 + WORKFLOW_RUN_OUTCOME_ALL + 文案表（成功/失败/已取消/已超时）；renderer tray-tone interrupted 专属中性暗 + WorkflowTab call 级词表 done 贯穿；session-reader 发现链重锚（journalPath 锚点语义 = record 流路径——v2 档直读流提 calls[].sessionFile，不引 subagent-core 生产依赖【两案裁决：案 A（废除「不引 core」边界）不采用，sessionFile 从 agent-settled.result 承载】）。
- **裁决点 7 对账清理**：reapOrphanRuns（run-state-evidence 维护轮族扩展）——引用集三代解析（v2 注册/v1 快照/link 指针，壳侧 session-lifecycle 注入采集）+ 宽限窗登记（7 天 env 可调，锚 = 首判无主时刻非 mtime，与门防活跃误删）+ 三件删除（record 流 + manifest 派生缓存 + 历史遗留旧双源顺带删 + .resume.lock 残锁）。采集成本首轮实测（2026-09-29，等量级 fixture 400 session 文件 / 61.4MB，同款同步扫描形态）：单轮 37-40ms，远低于秒级预期上限；重审触发线 = 单轮 >5s 或文件数 >5000。壳侧采集器读错分通道（sessions 根 ENOENT = 空态，EACCES/EIO 真故障上抛 → core 采集失败整轮跳过的宁保留防御经生产路径可达）。
- 实施期裁决：ExecutionOutcome（execution/subagent-record 域）从 `Exclude<RunOutcome,"interrupted">` 改独立实体字面量 completed/failed/cancelled——设计未裁决该域（Out of scope 射程外），保留其写入值不变；D10/D11 状态载体落进程内注册表（worker-message-pump 的 resumedBudgetLedger「累计活跃段已耗 + 本段复活时刻」与 lifecycle 的 resumedOriginRunIds 来源标记——设计原文的 run meta 字段面不在 U2 领地；record 流是权威源，再次 resume 按 run-resumed/run-interrupted 事件重算覆盖，注册表生命周期与消费方 [本进程 runs Map] 一致、evictDoneRunsBeyondCap 连带回收）；replay 输入漂移（回放入参哈希不匹配）= failed 终局 + 含恢复指引的诊断文案（D2 四态无 running→interrupted 人工回退转移——run-interrupted 写入方仅崩溃收编与 terminate 被动）；D12 宽松面：agent-settled 无对应 agent-started 帧的残形态按 fold 自愈占位行处理（warn 留痕不拒绝——对齐 run-events fold 兜底语义），严格拒绝面限坏行/seq 断档/settled 缺 result 三项。

- **resume 恢复语义修订（2026-09-30 用户裁决）**：原三档中的档 1（从子代理会话文件复用「已跑完但未提交」的结果）整体删除——恢复只保留「已有 agent-settled 则回放、没有则重跑（能定位同一成员会话则续写，否则重开）」，随删的派生机制见 [ADR-0099](#adr-0092-resume-只复用已提交结果删除从子代理会话日志复用结果的通道2026-09-30-用户裁决)。本条 D1–D16 其余内容不变。

### ADR-0087 session-manager 通知债权模型与 watch 桥（2026-09-24 设计裁决）

managed session 完成通知从「每次 settle 无条件回流（CompletionBackflow 文本 steer）」改为**通知债权模型**：主 session 每笔经 session-manager 发出的请求产生一笔债权（唯一 `notifyId` 幂等键），该请求被消费的轮次结束时销账并经 B-ledger 通知一次；无债权的完成一律静默。**结构性不变量**：债权只在 session-manager 通道产生（create+prompt / send 成功）与消灭（settle 兑现 / exit·deleted 终结 / 主 abort 抹除），UI 续聊/插话、scheduler、孙会话回流一律不触碰。claim 记录 `{notifyId, kind: claim|lifetime, sessionId, parentSessionId, state, outcomeSnapshot?}`，键 `(parentSessionId, notifyId)` 唯一、重复 arm 拒绝；状态机 **armed → injected → fulfilled{outcomeSnapshot} → 删除**，吸收/终态 **orphaned** / **aborted**，delivery 失败腿 armed → 删除（静默 disarm）。兑现锚 = injected 后首次 `agent_settled`（reason outcome 映射 **completed/failed/stopped**；前提 = pi stdout JSONL 按序到达 PS-57 + steer 级联排空 PS-58 + marker select 长挂 PS-59，三条均登记 docs/pi-semantics.json 探针门禁、随 pi bump 重验）；主 abort 在 `handleAbort` 入口同步抹除（respond 'cancelled'，先于 await abort）。

**watch 桥（notifyId 单键寻址）**：extension 以 `{action:'watch', params:{notifyId}}` 长挂 select（不传 timeout、fire-and-forget），runtime 按（调用方 parentSid, notifyId）反查 claim——查无 fail-closed 立即 respond **'cancelled'**、已兑现 catch-up 快照、每 claim 单 watch 槽新覆盖旧；respond payload 回带 **sessionId**（optional——claim 命中路径恒携带；fail-closed 查无 claim 路径无 claim 可回带，缺席时 reason 恒 'cancelled'、extension 静默收口不消费该字段） + meta **deathSeq** / **settleSeq** / fulfills N（death 侧 = 同 deathSeq claim 数；settle 侧 = 本批兑现总笔数，同批同值）/ exitCode / stderrTail / **sessionFilePath**（Full transcript 指针行数据源）。协议面全 additive：send/create params `notifyId` optional（缺省不 arm + **willNotify:false**）、create result **lifetimeNotifyId**（runtime 生成，与 claim 键独立、同 `sm-` 形态同入站校验）、status/list result **undeliveredResults** 事实计数、pending type **'session'**。extension 响应处理 = unregister（**mapReasonToStatus** 族映射 stopped→aborted、exited/deleted/orphaned→cancelled，不扩共享词表）+ 默认 `notifyLedger.record`，两例外 = cancelled·orphaned 静默、死亡新闻槽 (sessionId, deathSeq) 去重；合批 = extension 侧 50ms trailing debounce（分拣键 **(sessionId, reason)**——跨 session 不合批的构造性来源；批身份 settleSeq/deathSeq）。

**B-ledger 确认式送达（清偿 C-ext-19 存量违规）**：通知经 notify-ledger（notifyId 幂等 + at-least-once + ack + 重放）择父 session settled 边沿投递，替换旧 backflow 的 at-most-once 内存文本通道；managed session 同时进入 pending-notifications 注册面（type 'session'，register id = notifyId，三键契约零改动）。CompletionBackflow 全链废弃（settled/exit 检测职责并入 ClaimLedger，文案构造迁 extension）。死亡无条件通知 = create 时 runtime 自动 arm lifetime 记录，非 respawn 链死亡（delete / forceQuit / 不可恢复 crash）发声三入口：delete 经死亡处置汇聚点**先于 pm.destroySession** respond **'deleted'**（防 delete→exit 双事件竞态）；forceQuit 等不经 exit 链的收敛销毁经 removeSessionEntry 汇聚点补 respond **'exited'**（finally 必经步，时点在杀进程之后）；不可恢复 crash 经 respawn 熔断终态发声——三者同 deathSeq 同批终结；另有 onSessionExit 不在册兜底腿（session 已不在内存 Map 时直接发声，与上述入口重叠窗口幂等空转）；respawn 链（普通 crash 复活、idle 回收）静默。

**持久化二期登记（D8）**：v1 债权账本 = runtime 内存（与 delivery outbox 同生命周期）；跨 runtime/父 pi 重启的债权存活登记**持久化二期**（方向：并入 B-ledger 同族持久设施或 runtime 侧 journal，复用不另造），二期同时根治父 pi 死亡窗口的通知补投。

**关键不采用**：① per-session「已通知」布尔 flag——推导性质不应物化为状态，多债权合并时语义破碎；② extension 侧轮询子会话状态——有事件源禁周期 pull（ADR-0064 轮询精简准则），且「谁的完成算数」仍绕不开债权模型；③ 扩 notify-ledger 外部通道合批——P0 设施改动连带 workflow-result 通知形态回归，合批改 extension 侧 50ms 微窗；④ 死亡新闻槽「槽释放后新 claim 自带」的时间基判定——extension 无从知晓死亡事件响应笔数，arm→watch 微窗竞态下迟到 watch 会二次发声，(sessionId, deathSeq) 槽键序无关消解。已接受代价全集（本节即登记处，四要素：量级/恢复路径/重审条件/判定）：C-1 create 失败路径死亡通知缺失（罕见 throw 窗，poll/重试恢复，月级 1 次即重审）；C-2 >50ms 跨窗拆条 + 单笔 +50ms 延迟（幂等不破，A6 口径「至多一条、总数守恒」，用户可感知多条即重审）；C-3 象限2 混装整体退化（同 bundle 不可达，once 日志观测，锚失守即重审）；C-4 arm→watch 微窗通知缺位（毫秒级×父死并发，登记如实，实测可感知即重审）；C-5 arm↔register 非原子窗口（毫秒级自愈）；C-6 放弃旧文本通道 outbox 排队补投（持久化二期根治，丢失高发即提前排期）；C-7 runtime 重启账本全失（shutdown warn 裁决做 + poll 可发现，二期根治）；C-8 宿主 JSONL 写入面线性增长（每 send 2 行 pending+每通知 ≥3 行，goal 每 turn 全量扫描，实施期测基线定阈值，compaction P-B4 实测丢 entry 即重审）；C-9 respond 失败窗口 register 残留（下次 session_start 收尾路径清理，长命 session 残留堆积即扩口对账心跳）。

过程设计文档为不入库产物（已随交付弃置）——**本 ADR 即决策现行登记处**，实施记录 git 可追溯（commit d06d9464a 起）。

### ADR-0127 extension_ui_request 通路结构化契约（2026-10-04 设计裁决，pi1-disposition-chat-flow D6）
**决策**：extension UI 交互通路按结构化字段路由，bridge 中介零驻留（plugin-bridge 已整体退役，RPC 事件 payload 是 event-adapter 对 pi 事件的直接消费，无转发注入）：
1. event-adapter 从 pi RPC 事件 payload 派生结构化字段：`method`（pi 1.0 RPC 实发全集 9 个：select / confirm / input / editor / notify / setStatus / setWidget / setTitle / set_editor_text）、`kind`。`extensionName` 不派生（U4 实装裁决：pi 1.0 extension_ui_request 九变体 payload 均无扩展名字段——dist rpc-mode.js + rpc-types.d.ts 实读核实，强加即恒 undefined 死字段；扩展归属信息仅 extension_error 事件自带 extensionPath，该事件翻译处保留该字段）。
2. **kind 词表三值（dialog / notify / widget），值值有消费点**：dialog 族 = `extension.dialog`（载荷 dialogKind ∈ select/confirm/input/editor，需回包族）；notify 族 = `extension:notify`；widget 族 = `extension:widget`。setStatus / set_editor_text 与 select 的 marker 家族（session-manager 通道 / inflight 上报）属 runtime/前端内部状态上报——**不进 kind 词表、保持特化出口**（进词表判据 = 该值物化于某族 WS 消息载荷并驱动路由，防词表死分支；亦避免与 event-adapter 内部路由字段 PiTranslatedEvent.kind 撞名）。setTitle 无出口：warn 留痕 + noop（pi 升级语义变化可诊断）。
3. transport handler 与前端按消息类型路由（取代 marker 字符串分支识别）；marker 约定 → 结构化 kind 的翻译职责收敛在 event-adapter（合法持有点内，见 ADR-0110），title 降级为纯展示。

**效果**：新通道接入 = 声明一处；kind 词表与 9 method 映射表即终态实有值（无死分支），可作实施对账底表；taiji 协议零 pi 专有方法名穿透（由 ADR-0110 方法名项检查拦截）。实装 = `packages/runtime/src/infra/pi/event-adapter.ts`（派生与分发）+ transport handler 消息类型路由 + `packages/core/src/transport/api/domains/extension.ts`（前端消费）。登记无新约束族。设计文档同 ADR-0108（不入库，过程产物），本条即该契约的现行登记处。

## 状态管理范式（renderer/core）

### ADR-0049 per-session Map 分区范式（最高频引用）
任何持有 per-session 状态的 composable/组件必须用 `useSessionScopedState` 工厂（`packages/core/src/foundation/use-session-scoped-state.ts`，内部 Map<sessionId,T> 分区）；禁止实例级状态依赖组件树隔离、禁止 watch(sessionId) 手动清空。WS handler 必须用 `updateFor(capturedSid)` 显式分区（结构性消除切换竞态）；cleanup 统一挂双壳各自的删除编排入口（桌面 `useSidebar.deleteSession` / 移动壳 `app-runtime.deleteSession`，两者均归入 core `triggerSessionCleanups` 统一执行）销毁编排，纯加状态不接线清理的 PR 打回。例外清单显式登记（useSessionEvents 订阅编排层、全局 sid 协调器类模块级 Map、Pinia factory 体内 Map、useTerminal 混合形态、TurnRenderCache shallowRef 容器、useTtsPlayer 全局单例播放状态——同一时刻每窗口只有一条消息在朗读，状态窗口级唯一而非 per-session，cleanup 走 deleteSession 统一编排调 stop）。**范围修订（ADR-0074 投递所有权内核）**：队列区状态不作为独立 cleanup 注册项——现役载体 = 投递内核的 per-session 投影（`session.delivery` 帧消费），清理点在 core `useChat.disposeSession`（随 `deleteSession → triggerSessionCleanups → disposeChat` 编排一并执行），renderer 侧注册清单不新增队列分区项。机器防线：taste-lint `no-instance-level-session-state`（error 级）。登记 C-state-01、C-state-08。

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
plan 模式重设计（GUI 投影 + skill 挂载 + 文档审阅闭环）的全部关键决策由 pi-ext ADR 家族（pi-ext-021 prompt-only readonly / pi-ext-022 session-manager state 等既有条目）与 `extensions/universal/plan/` 源码注释 + [CONTEXT.md](../CONTEXT.md) 的「计划模式 / plan-state entry / PLAN_REVIEW_MARKER / record 投影链」词条承载，不另立 ADR 编号条目。理由：决策密度已由设计期对抗式审查收敛，核心机制（marker select 通道 = Marker RPC 词条、投影链 = 既有 subagent/workflow 机制的参数化扩容）均复用已登记决策，新编号只增检索成本不增信息。本条目即「为何检索 plan 相关决策不到 ADR-XXXX 编号」的权威解释。

## 可靠性与看护

### ADR-0047 watchdog 用进程健康探测
pi 卡死检测用「进程健康探测」（每 60s ping get_state）替代「事件静默时长」——静默 ≠ 卡死（ask_user 等待/慢工具都会静默），连续 2 次失败广播 WARN、3 次（180s）才 onSilentAbort。实装 `event-interpreter-ping.ts`（PingProbe）。与「runtime watchdog 滚动重启」（默认不武装，TAIJI_RUNTIME_WATCHDOG_ARMED）是两套机制。登记 C-comm-09。

### ADR-0069 内存活性治理审计裁决（2026-09-14，维持不治为默认）
全仓内存活性审计后的用户裁决：登记不治点位「维持不治」是默认，翻案需新实测压力数据（原审计文档 docs/design/memory-leak-remediation.md 已删除、git 可追溯，各点位量级锚与重审条件见其 §2.5；裁决注释已写入各源码处）。不治 8 项：sessionMetaCache / externalMetaCache / notRepoCache / usage-stats shards（语料有界）、pi-respawn 熔断计数（熔断语义优先）、clearedSessions tombstone（有意无界防迟到写）、executingBash 断连残留（两害相权残留更轻）、session-file-utils 32MB 全量读（协议合法载荷有硬上界）。已治理面：G2 活性无界组（openPiStreams close 摘除、ws-client sweepExpiredInFlightSubscribes 挂重连路径）与 G4 杂项组（prematureTimeoutIds/deferFlushFailureCounts 纳入 disposeSession、skill-registry projectWatchers LRU(8)、ImportSessionDialog close 清扫描结果、quota fetch body cancel）。系统性防护（纯加状态不接线清理打回）已并入 ADR-0049 checklist。

### ADR-0018 extension 安装临时目录
Collection 安装先完整落 `tmp/ext-scan-{timestamp}/`（clone/cp + npm install），用户确认后拷入正式目录——取消/失败只清理临时目录，不污染 extensions/。

### ADR-0038 subagent 只 cancel 无 pause/resume
subagent 是 single-shot 子进程，控制只支持 cancel（现扩展 message/start），不实现 pause/resume——底层无长驻进程，不做假对称。

### ADR-0067 subagent「已收起」第三状态全链路清除（2026-09-16 用户裁决）
subagent 对用户的可见状态只有两桶：进行中 / 已结束（判据 = `isRunningProjection` 及其取反）——「已收起」（archived）不以第三状态呈现，全链路清除不残留：renderer 三桶视图与「已收起」过滤器删除；shared/runtime 投影链的 Intent 类型与 ExecutionRecord.intent / SubagentRecord.intent 字段删除；subagent-core markArchived 原语删除，close 的资源收尾职责由 `markSettledOut` 承接（close 终态写点：幂等、worktreeHandle 清句、`.alive` release、manifest 投影，不写任何意愿字段）；markReactivated 删除（message 续聊无翻位发生，万物可续判据不变）；通知 gate ①（archived 静默检查）删除，close 注销 reason 词 `archived` → `completed`。机制权威 [docs/architecture/subagent-permanent-session-model.md](../architecture/subagent-permanent-session-model.md)（§3.2.5/§3.2.7 已按删除后现状改写）。登记 C-data-20、C-proc-13。

### ADR-0015 statusline plugin 封装
plugin 中转渲染 statusline（`plugin:statusBarUpdate` 通道），plugin 不直写 UI。

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
run 是资源容器，窗口级资源按物理载体回收——统一规则四条：① **pi 引擎薄壳（pi-subagent-cli）per-window**：一个派发窗口（workflow run / chat record 轮次）一个薄壳实例，窗口收尾在 finalizeRun / 轮 idle 收尾链 dispose（复用既有 dispose 请求 + 按进程组终止兜底杀链，孙进程同进程组连带收割）；registry 不再缓存 pi 薄壳跨窗口单例。形态判别 = manifest `taiji.subagentEngine.processModel` 声明字段（`per-window`（缺省，轻壳是常态）| `shared-service`），不进 SDK 任务能力字段（进程形态不是任务能力）。② **zcode 零改动**：zcode 薄壳 + app-server 是懒加载单例（未装引擎包不拉起 / 首次派发才拉起 / 全 taiji 一个，多任务共享），随 taiji 停机链回收——窗口级资源是 app-server 会话对象（每任务自包含 create→run→close），close 即回收，杀薄壳无窗口资源可收只会破坏 app-server 单例。③ **workflow 成员会话 name 键复用**：name = run 内唯一的子代理身份（对齐 zcode 平台语义），同名 `agent()` 调用 = 该身份的续写轮（Continuation 续写 + resume 锚点冷续写，回喂只发增量），round 不参与路由，换名 = 隔离（无 resume 标记参数——zcode 续聊是同名默认语义非显式参数）；成员 record 只有 running / 已结束两态，跑完即结束（现状终态化不变），同名续聊 = revive 把已结束 record 拉起回 running（复用 chat 域 revive/resume 通道语义，2026-09-27 裁决反转 idle 挂起方案），run 收尾对仍在 running 的成员按 run 终态收尾；外部 message 通道对 workflow 成员的域边界拒绝不变（内部复用与外部通道严格分离）。④ **杀链与防御删减（判据：兜底只兜无法预测的物理异常，不掩盖业务 bug）**：D9-2 调用面裁决表①②（run 级回收禁杀薄壳）随共享前提消失而反转删除，killRunTopology / runTopologyKey 定点杀链删除（cancel 收敛窗满与 armed 超时兜底统一改走收尾 dispose）；崩溃重建（CRASH_REBUILD 退避 + respawn 服务同窗口）与握手重试保留（属「无法预测的瞬时故障」类）；**stdout 楔死自愈与 settled-watchdog（会话轮等待两段式守护 30min/600s）删除**——二者防护的场景核定全是 bug 而非物理异常（版本错配已由 C-proc-08 门禁修复、输出管道丢行与 pi 上游 compact 卡死进连带修复清单），进程死亡的正面感知已由 exit 事件事件驱动承担（毫秒级）；删除后「引擎活着但事件不达」的未知场景不再自动回收（人工停止），剩余保护 = 用户显式任务预算。chat 域窗口 = 轮次（轮 idle 即释放，revive 靠 respawn + session 文件冷续写）与 workflow 域窗口 = run（成员续写间歇薄壳保持）的差异合理性：workflow 续写是设计内机械行为（间隔短可预期），chat 续写是用户行为（间隔不可预期）。⑤ **引擎查询面归属（2026-09-27 裁决，两形态专项评估后定案）**：查询走各自适配包通道、宿主不直读引擎内部存储——pi 适配包内置查询面（协议分发位已预留，读 pi 数据目录 json、零新依赖，定性可选诊断面）；zcode 查询走 app-server 协议通道；「pi 库宿主进程」（进程内 AgentSession 派成员）经评估不采用——pi 扩展按一进程一任务假设写成（进程级 env schema 多成员串线 / process.exit 硬杀连带全进程），zcode 引擎自身实态也是新 session + 历史注入冷恢复，实例级续聊无语义增量。上下文膨胀宿主不处理、交引擎自带压缩（2026-09-27 裁决，无降级无换绑）。权威源：`.tmp/tech-design/pi-workflow-run-resource-model.md`（设计文档，不入 git；实施记录 git 可追溯）。约束登记随实施批补（域边界约束 C-proc 系新登记 + D9-2 相关注释清扫）。

## 前端交互结构

### ADR-0056 / ADR-0057 Composer Staging 双层
模型暂存层（stagingModel/stagingThinking 快照，enter 快照/exit 恢复，getStagingConfig 供 fork/handoff 创建新 session 传 override；优先级 Staging > preset > 默认）+ 行为策略层（StagingAction 接口收敛 enter/exit/send/abort/visual，Composer 经 activeStaging 路由）。落点 `core/domain/composer/dispatch/staging-mode.ts` / `handoff-mode.ts`。

### ADR-0053 SideDrawer per-session 控制态
isOpen/activeTab/docked 三控制态经 useSessionScopedState 按 focusedSessionId 分区；事件驱动的打开对非聚焦 session 只置 pendingOpen 标记，切回时消费——区分「用户手动关闭」与「未看过待提示」。

### ADR-0032 thinkingLevelMap key/value 语义
key = UI 档位（含 max），value = 发 pi 的实际 level（max → xhigh）；可用档位按 key 判定，传 pi 必经 resolveThinkingValue 映射（pi 不认识 max 会 clamp）。实装 `core/domain/composer/thinking-levels.ts`。

### ADR-0050 slash/skill 候选源按 variant 分支（skill 段与 slash 段 skill 项均 = taiji registry）
skill 候选两态统一 taiji 源：globalSkills ∪ projectSkills（location 取 `SkillInfo.sourcePath`），新鲜度由 `config.skillCacheInvalidated` 广播链即时驱动，不依赖 pi reload 往返；panel 态 project skill 的 cwd = sessionStore 投影的 session cwd（landing 维持 `flow.currentCwd`）。slash 段仍走 registry 声明 ∪ pi 真源合并（panel 另注入 compact），panel 态 slash 段的 skill 项**换源保留**（0.10.1 首版「过滤 skill 项、panel 的 skill 段是唯一 skill 入口」的双入口消除二次修订推翻）：pi 真源 skill 命令（reload 才刷新的滞后快照）仍剔除，registry 源 skill 项以 `/skill:<name>` 形态补入（与 landing 单列形态同构、同一追加函数）。行首 `/` 与行中 `/` skill 段双入口共存——跨入口防双插由 selectedSkillNames 已选标记（S-2）承担，不依赖入口裁剪。用户可感知后果两条：①panel `/` 浮层 slash 段列 registry 源 skill 项（首版不列致行首 `/` 肌肉记忆下 session 发起后 skill 不可见，属回归）；②taiji 独有目录（taiji 扫描集含、pi 扫描集不含，如 `~/.taiji/skills`）的 skill 进面板候选与注入，但 pi `/skill:` 命令注册表与 system prompt skills 段不含——模型不可自主调用 taiji 独有 skill（pi 只认自己扫的目录）。扫描集语义差：pi 扫 `cwd/.pi/skills`（taiji project 扫描集已补齐对齐）；taiji 独有目录不反向追齐，属既定语义差。
[2026-09-25 退役延伸] W5 skill 变更→pi reload 编排整体退役：两态 skill 候选与 composer 注入既已全部以 taiji SkillRegistry 为权威源（即时生效），pi 全量 reload（invalidate 扩展 ctx + clearExtensionCache 重建全部扩展，曾致后台任务完成通知在旧模块世界投递失败）在 skill 场景无净收益，触发链删除（reload-orchestrator / promptReload / `/__taiji_reload__`）。pi 侧 `/skill:` 注册表与 system prompt skills 段冻结在 pi spawn 时点（spawn 传 skillPaths 基线不变），新 skill 需新开 session 生效——本 ADR「模型不可自主调用 taiji 独有 skill」的降级扩展为「pi 侧 skill 视图统一滞后到 spawn 时点」。
[2026-09-25 补投机制落点] W5 退役的配套收尾：后台 bash 任务完成通知原为「单次尽力投递」（投递失败永久丢失，曾致 AI 空等已完成的任务）。补投 = 双触发面（pi 进程构造的 session_start 链 + runtime 激活链 getCommands 发 `/__taiji_bg_reconcile__` 维护命令，per-session 60s 节流）跑同一扫描：registry 严格终态（isTerminalState ∧ exited 时 reason≠killed）∧ 会话无送达痕迹（background-bash 消息）∧ 无补投标记（`background-bash:reconciled` plain entry，appendEntry 同步入账）→ 合并单条 steer 消息 + 同步写标记。幂等三配套（await 兼容规格 / in-flight 单飞检查 / 同步标记）源于两个已核实事实：桌面激活对账 handler 多次派发（startup+resume 双派发）、pi 桥接层丢弃 sendMessage promise。V2-R/V3a/V3b 真机全链 PASS。实现 extensions/universal/base-tool-enhance/src/background/（judgement/pending-reconcile/notify）。

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
widget 推送从「每 30s 无条件全量」改为**任务集指纹跳推**（稳定字段 id/name/schedule/kind/enabled/nextRunAt/locale 序列化对比，不变不推；维护不变量：指纹字段集 ⊇ widget 显示决定因素全集）。显示面**时间投影整体移除**（用户裁决全砍倒计时/时间投影）：widget 行文本只含任务名与静态调度描述，TUI 逾期标记、GUI status 逾期翻牌删除，TUI 最近任务选择按 nextRunAt 升序不用 now 过滤；连带清理 = widget 专用 i18n 词条 + widgetStatus 逾期分支（`formatRelativeTime` **保留**——`task.list`/`task.created`/`service.list` 命令层仍消费，`renderTaskLine` 拆分为 widget 静态变体 / 命令变体）；`task.list` 人侧渲染补执行状态摘要补偿失败可见性——widget 显示 = f(稳定字段, locale)，时间流逝不是状态变化，不得触发推送。widget 帧曾意外承载的两个隐藏职责显式接管：①**空闲保活心跳**（入站全帧 touch `lastActivityAt`，30s 帧掩护下 scheduler 会话永不 idle）→ 显式化为「有任务且距上次推送 >10min」的保活底线帧（方案不变量：保活间隔 ≪ idle 回收阈值 ≥3 倍余量；空任务不发——pi 清屏帧同样 touch 心跳，空任务保活 = 空会话永不回收）；②**reload 恢复时机**（现状靠 per-session ring 概率性回放，忙会话冲刷后失源）→ message-bus 中 `extension:widget`/`extension:widgetGui` 改登记 **state 类**（typeKey 载荷派生 per-widgetKey），重订阅经既有 stateSnapshot 段构造性恢复（清屏帧 gui:null 即 last-value；session 销毁随 bus.clearSession 清理；曾考虑 runtime 新建帧缓存 + sendInitialState 补发段，因与 stateSnapshot 重复建设且重连场景被 seqGate drop 而否决）。设计文档 `.tmp/tech-design/scheduler-widget-push.md`（过程产物），实施落点 = u1 extension 侧闭环（静态化+清理+跳推+保活，挂既有 onAfterTick）→ u2 runtime message-bus widget 帧 state 类化 → u3 回归测试。

### ADR-0072 pendingSend 分型清除锚点与 composer 发送布尔契约（2026-09-22 设计裁决，expectTurn 相关边界已由 ADR-0073 交付收敛）
表单假忙修复的语义裁决：`isActive ≡ isGenerating ∨ pendingSend` 的 pendingSend 桥接清除收敛为**分型锚点**——form 通路 ui_response 送达（delivered=true）后仅 cancel 型（result===null：Esc/取消按钮）即时清除；提交型（result≠null）不清，桥接「respond 完成 → message_start」窗口由 turn 事件正常清除（无 turn 期待型经 ADR-0073 expectTurn 声明即时清除）；`requests-invalidated` 广播按 sid 清除（reclaimed/plan-aborted/turn-aborted/session-destroyed 四源）；30s timeout 纯兜底（可观测三要素：上界/自愈/warn——timeout 分支 warn 已去 dev 门（ADR-0073 U5），生产 attach 可见含 sid）。原登记已知边界「无 turn 提交型每提交必命中 30s 兜底 + 源元数据通路未打通（后续候选）」已由 ADR-0073 交付解决（scheduler 提交 91ms 即时清）；剩余常态命中面 = plain dialog 提交面已由通路级即时收尾解决（sendPiResponse 应答终局无条件清 pendingSend，生产者穷尽论证：command handler 源结构性无 turn / turn 内源 pendingSend 恒空；落地 98e2aa8b5）；已知失真登记：多步链悬挂期插发直发会被误清（构造上无从区分直发与命令链置位的 pendingSend）——实测 pi 命令 dispatch 即返（void run()），直发被并行处理、message_start 即时到达覆盖，无可见假闲窗口（2026-09-23 验收 O-5）；重审触发 = 用户报告误导操作（保留）。occ-idle 不可作锚的裁决维持（会破坏 ask-user 桥接制造 isActive=false 空窗）。composer 发送布尔契约：`send()` 返回 true = 已投递或输入已可见保留（直发失败乐观气泡亦 true），false = 输入未消费须恢复（仅 B 策略专用）；steer 三早退（空段 / 空白文本 / session 非活跃——非 busy：busy 时 steer 是合法投递路径）返回 false 并 warn（60 字符截断），主链三个 clearInput-first 落点（routeSteer/sendActiveMessage/sendLandingFirstMessage；onSteer 死代码防御对齐为同范式第四落点）统一「快照空 + hasInput 短路不变量」（快照非空失败走 restoreSegments 恢复）。设计文档 `.tmp/tech-design/form-hang-fix.md`（过程产物），实施 = U1 respond 分型锚点 + invalidated 清除 / U2 steer 输入保留三落点。

### ADR-0073 expectTurn 源元数据通路与直发门终态通道（2026-09-22 设计裁决）
表单提交型「是否有 turn 跟随」的判别权归扩展作者显式声明：`uiFormInteract` options 增 `expectTurn?: boolean`（缺省 true 全兼容存量），五段通路 = 声明（scheduler 命令路径传 `expectTurn:false`）→ marker select options JSON 携带 → event-adapter `tryTranslateFormSelect` 单点**条件落键**（仅显式 false 落键、undefined 省键；legacy 归一分支不透传——旧 npm 包结构上不可能携带）→ `ExtensionUIRequest` 加员（`toExtensionUIRequest` typeof 检查）→ respond 分型严格双条件 `result≠null && expectTurn===false → clearPendingSend`（`=== false` 显式判定禁 truthy，undefined 走桥接 = fail-safe；双侧类型检查把脏值挡在帧外走桥接）。效果：/schedule 提交即时收尾（真机 91ms/48ms 两轮实测，不再命中 30s 兜底）；ask-user/plan 桥接零改动。连带裁决：D4a——plain dialog 应答收尾锚点落壳层 transport `sendPiResponse`（**先于 delivered 检查**即 clearPendingSend，cancel/提交/断连三型应答终局统一收尾（ADR-0072 收敛条目）；**两通路相位分叉属有意设计**——form 通路分型锚点在 delivered 之后（`useExtensionUI.respond` 未送达即 return，锚点不可达，未送达期间维持 busy），plain 恒清在 delivered 之前（「意图先于送达」），重审 = 两通路收尾语义统一化提案出现时整体重审，勿单独判其一为 bug；原 ui 队列落点结构性不可达 store，chat-view-deps 反向依赖禁令）；D5——timeout warn 去 dev 门（store timeout 分支恒发；该残余已由 renderer console 落盘管道解决（renderer-console-<date>.log，落地 4f85d2964/7dfe760bf；重开 = 用户 2026-09-22 裁决，30s 兜底 warn 生产可取证——warn/error 级经 main 侧 console-message 监听落盘，排障取 <dataDir>/logs/ 即得））；30s 兜底 timer 保留（语义收窄为真异常回收层）。已知边界：plain dialog 提交面（/permission 命令族）pi select API 无元数据通道、每次提交命中 30s 兜底的挂着不处理已由通路级即时收尾解决（sendPiResponse 应答终局无条件清 pendingSend——pi select 无元数据位的缺口由通路默认值「无 turn 收尾」绕开，非交互形态迁移：CompanionBand → FormOverlay 方案已否（错层反例：用交互形态重构解决收尾语义缺陷）；论证与已知失真登记见 ADR-0072 收敛条目）；/session-pick 系 tui 注册门源 RPC 模式不可触发。同批终态通道：composer 直发门读 ShellInputInstance expose 的 `getInputElement()`（禁回退 `$el`——dev 构建模板首注释使 `$el` 为注释节点、门恒 false 的 W1 F-1 教训，[HISTORICAL] 固定于 command-popover-keyboard.ts）。实施 = form-submit-busy-convergence 七单元（43ca4df7b…0f1ac2dce）+ F-1 修复 3227df0bd；设计文档 `.tmp/tech-design/form-submit-busy-convergence.md`（过程产物）。

### ADR-0088 settings 域 transport seam 按通道分工（2026-09-25 架构审查裁决）
「settings 域只经 SettingsTransport seam 访问」的边界按**通道**划分而非一刀切：WS 通道（provider/model/skill/agent/system 配置面）必须进 seam（real/mock 双 adapter 证明）；Electron main 通道（update/proxy/directory 等走 `@/api/domains/settings` IPC 的面）登记豁免，不强行纳入 seam 类型面——全部收编会把无 mock 需求的 IPC 通道强行套上双 adapter 形态，收益为零。transport.ts 头注即登记处；读到「seam 收口」时不得把 main 通道二次「收编」进 seam。

### ADR-0089 i18n 文案不作状态判定依据（2026-09-25 架构审查裁决）
任何「按展示文案判定状态/归属」的模式在 locale 切换后失效（文案是运行时渲染值，不是稳定判据）。settings 编辑体动作错误的归属/清除按 source 标签（ActionErrorSource，见 CONTEXT.md 词条）判定；本条为可复用否决条目，其他域出现文案比对模式时按本条否决。

### ADR-0090 seam 与注入通道二选一（2026-09-25 架构审查裁决，反转 W3「ui 依赖一律注入」决议）
方法已在 SettingsTransport seam 上时，ui 包组件直取 seam（ui→core 合法依赖方向），不再经 provide/inject 复刻第二条注入通道——双通道是对同一方法的双轨复刻（假接缝）。本次以删除 `SETTINGS_CONFIG_API_KEY`（detectSources 注入通道）落地；保留的注入 key（SETTINGS_TOAST_KEY/QUOTA_CONFIGURE_FACTORY_KEY/SETTINGS_CHOOSE_DIRECTORY_KEY）承载的是 seam 之外的真实依赖（壳层 toast、工厂装配、Electron dialog），不适用本条。

### ADR-0096 命令/技能获取统一走自研共享能力，禁直用 pi 注册表快照（2026-09-25 审计裁决）
pi 的 `ExtensionAPI.getCommands()` 返回 resource loader 的启动加载集（reload 才刷新的滞后快照，与 ADR-0050 对 pi 真源的定性同族）。裁决：**pi 底层内部逻辑**可用 `getCommands` 之类方法；**本项目代码与全部 extensions** 获取命令/技能一律走自研封装——自研扫描直读磁盘，技能安装即时可见，无需 reload pi 进程。共享能力抽出为独立包（落点 `extensions/shared/` 新包，与 llm-shared / ext-guards 同列；目录扫描 + overrides 语义 + `plan-exec` 类 frontmatter 标记读取 + 名称归一），项目内共用，禁止各扩展自扫目录或直用 pi 注册表形成第二实现。迁移面：`extensions/universal/plan` 的 `exec-skills.ts`（现自扫四根，作为共享包的实现种子）与 `enter.ts resolveSkills`（现用 `pi.getCommands()` 校验 `--skills`，随共享包落地迁移）。落地义务：共享包实现时补 constraints.json 约束登记 + extension-conventions 规则条目 + `check-extension-dependencies.mjs` 依赖方向校验；pi bump 时共享包的目录/overrides 语义漂移由包内测试对拍真实 pi 行为兜住（登记 pi-semantics 探针）。**消费语义闭环（0926 补）**：自研扫描用于**发现**（表单列出可用技能），执行门禁仍归 pi 注册表——steer 注入前经 resolveSkills（pi.getCommands 校验）确认 pi 实际认得该技能（闭环已存在于 plan enter.ts；共享包落地时此两段语义一并归位：扫描=发现，注册表=执行门禁）。**实施落地（0926）**：共享包 = `extensions/shared/exec-skills/`（`@zhushanwen/pi-exec-skills`，出口：`detectExecSkills` 扫描发现 / `isEnabledByOverrides` overrides 语义 / `hasPlanExecMarker` frontmatter 标记 / `normalizeSkillName`+`resolveSkills` 名称归一与执行门禁）；迁移面第三落点：plan 包 `command.ts` 的 E1 报错文案可用技能清单 `pi.getCommands()` 枚举（发现语义，与门禁同源），迁移归属批次 4 interactive 单元，随 command.ts 改动面同批切换。依赖方向校验落地 = `check-extension-dependencies.mjs` 检查项 3 双向校验——反向：包 package.json dependencies/peerDependencies 声明的 `@zhushanwen/*` / `@taiji/*` 包必须登记进 extension-dependencies.json 该条目 dependsOn，漏登记即红（覆盖 extensions/{taiji,universal} 分组包与 extensions/shared/ 库，shared 库缺条目同红）；正向：dependsOn 引用的 workspace 内包必须可解析，悬空引用即红。**重审条件与理由修正（0926 复核）**：pi 实际提供 `ctx.reload()`（agent-session.js:2210——重读 settings、`resourceLoader.reload()` 重扫 skills/prompts/agents 磁盘、重建扩展运行时，**不换 session 文件**）——不是「必须重启 pi 进程」，修正为：**该 API 粒度过粗**——重建整个扩展运行时 = 全部扩展内存态清零（plan 会话分区/工具白名单/挂起交互全打散），为「刷新一个技能列表」付出打散全部挂起交互的代价不可接受。pi 缺的是细粒度资源重扫 API（只刷 skills 注册表、不重建扩展运行时）——pi 提供该类细粒度 API 时，自研扫描整体退役、换回注册表消费。

### ADR-0097 拉为主推补充：数据同步第一原则与域同步协议收口（2026-09-26 架构裁决）
**拉是真理通道，推是性能提示**——任何数据查询必须返回当前真值（缓存优先、磁盘兜底）；推送允许丢失，丢失后的收敛由协议层统一提供（订阅快照回放 / 重连重放 / 事件边沿拉三路），**功能域代码禁止出现推送补偿逻辑**（域层新增 reconcile/冷拉/兜底定时器 = constraints 红灯，豁免须登记理由）。背景：plan 审计与项目级推拉诊断实证「推不可靠（R11）+ 拉被做贵（getPlanState 全量解析 + 目录扫描 35ms 地板价）」逼出逐域补偿（renderer 三件套手写 8 处、守卫 6 种变体、重连重拉 6-8 处）的恶性循环——可靠性必须由通道保证，不得用消费侧补丁偿付。协议收口：功能域经 `DomainSyncDescriptor` 声明式接入（key + source 参数 + read），数据源（bus-state / rpc / file-derived / memory-registry）是参数，上层不感知底层方案；拉的可靠性与性能是基建义务（缓存优先 + 负缓存 + cursor 增量管线泛化 + 逆序分块冷读 + 结构化可观测），不属于任何功能域。数据分型五类（内存注册表无缓存 / 磁盘推导走增量管线 / 外部配置 mtime 缓存 / 外部服务 TTL / 本地 UI 态不入协议）。已否方案：推送必达化（分布式消息税，重复乱序仍未消）；维持逐域修（恶性循环加码）。保留不推翻：ADR-0049 分区范式、message-bus 三分类（stream/transient 流类不在协议范围）、chat 域帧流形态（天然豁免）。设计 SSOT `.tmp/tech-design/pull-push-architecture.md`（过程产物，分波 W0 根修可观测 → W1 性能四刀 → W2 协议收口 → W3 样板迁移与补偿退役 → W4 散件收编，每波独立可回退）；constraints 守卫随 W2 登记。**事件数据直通（D8，ReplicatedState 不变量修订）**：pi `entry_appended` 事件携带完整 entry 直通派生缓存——「事件只做失效」修订为「事件携带数据、多通路共用同一派生/合并函数、拉取是校验与冷启动腿」：handleEntryAppended 透传 entry；事件直通 / getEntries 拉取 / 冷启动全量三条路径喂**同一个**单 entry 增量合并函数（等价性：append-only + 事件序=文件序下，「新 entry 经 parsePlanStateEntry 非空即胜出」≡「逆序取末条」）；拉取降级（冷启动/Entry-not-found 自愈/低频校验），300ms 防抖退役于常态路径；等价性照搬 chat 域模式（applyEntry reducer 双通路 + apply-entry-equivalence 测试守卫，规则 9）——三族各建等价性测试。已否：保持「事件只做失效」（丢了再拉的 RPC 往返+防抖延迟是常态税，新鲜度押在拉取必然成功上）；各域自写事件处理逻辑（两条写路径两套逻辑 = live ≡ reload 破裂标准形态）。前置探针：pi 事件 emit 序 = 文件追加序（反证则 D8 整体退回）。
### ADR-0098 subagent 资源引用 = 绝对路径 + 两段式暴露（承接包内 ADR-0001/0002/0003，2026-09-29 收敛）

subagent 体系的资源面决策三条现状（原记于包内 `extensions/universal/subagent-workflow/docs/adr/`，该目录已按「包内不自建 ADR 目录」规则退役，内容折入本条）：

- **引用形态 = 绝对路径**：`agentRef` / `workflowRef` 统一为绝对路径引用（原 ADR-0002），发现与解析不依赖 cwd；后续实现质量补强（发现对齐 pi skill 的 session 级节奏、M2 改 `appendSystemPrompt` 内容语义并删除 agent/schema 临时文件、`AgentCallOpts` 字段统一、砍 info action、review-fix-loop 启动期 stat fail-fast）见原 ADR-0003 各条，均已落地。
- **暴露机制 = 两段式**（原 ADR-0001）：workflow 侧「结构化参数 + 固定编排」按第一性原理推导（结构化参数是暴露问题的单一根因），subagent 侧参考竞品优化；四家（含 pi-subagent）趋同于两段式而非三段式。
- **决策记录归属**：包内不再自建 ADR / 长期设计文档源（规则见 [extension-conventions.md](../extensions/extension-conventions.md)「决策记录与设计文档归属」）；体系级决策进本文件，包内实现细节进 `docs/architecture/` 或源码注释。

现行载体：[docs/extensions/subagents/architecture.md](../extensions/subagents/architecture.md)（包拓扑 / 协议面 / 机制落点导航）+ `packages/subagent-core/src/shared/resource-discovery.ts`（7 源同名 last-writer-wins，SSOT）。
### ADR-0076 消息撤回：navigateTree 树内回退 + 系统信令旁路（2026-09-24 设计裁决）

消息撤回能力的机制裁决：**已消费层撤回 = pi `navigateTree(entryId, {summarize:false, label:'taiji:revoked'})` 树内回退**——同 session 文件、append-only、被撤内容移出活跃路径（模型视角从未发生），不 fork 新文件（用户硬约束）；label 参数经 `appendLabelChange` 落 LabelEntry 到文件尾 = 持久化锚（树重放规则 leaf=文件尾，重启/空闲回收后回退不复活；实锚与重验义务登记 pi-semantics PS-60——探针随 pi bump 门禁复验）。**「未注入」层（排队/在途）现状 `delivery.cancel` 两段式收回已覆盖**（价值审核实——设计初版误判为空白，据此砍掉 delivery.revoke 重复 RPC）。**系统信令通道 = dispatcher 新增 `sendSystemCommand` 旁路**：不经 `runBeforeSendHook`（插件 transform 不适用——信令非用户消息）、不经 `registry.submit`（无裸标记尾附/无内核条目/无车道 hold），复用 `ensureCommandAvailable` 探测（requireCommand 语义保留）；命令 `__taiji_nav__` 注册于 agent-ext（internal host commands 指定宿主，ADR-0008 navigate-tree 桥接命令的形态回归——当时因 runtime 消费方被删而删，本设计即消费方回归；不新建 session-navigator 包，简洁审 Rule of Three 反向命中）。**完成确认 = reply 后 `get_entries` 校验**（`session_tree` 是 extension 进程内专属事件不经 RPC 流——主审 R3 核实，监听方案整族不可行）：从 leafId 沿 parentId 回溯验证「路径不含被撤 entryId 且回溯链终点 === expectedParentId（null 自然终止于根）」，谓词按 entry.id 集合判定（LabelEntry.targetId 陷阱）；expectedParentId 唯一取数点 = 信令前校验（活跃路径须仍含被撤 entryId——防复活性跳转）。**撤回编排七步**：同步临界区（revoking 置位 + 空闲/workflow-running/互斥检查）→ cancel active（草稿抑制）→ 定位 entryId → 清 history-rebuild-cache 与派生态缓存 → 信令前校验 → 信令 + 结果校验 → reply；revoking 为内核 hold 第四判定输入（`piCompactingBlocked` 同型，try/finally 全路径释放硬契约）。RPC 契约 = `session.revokeMessage {sessionId, targetId}`，targetId 为消息 id 原样（live 态 `u-<uuid>` = clientUuid / 基线与重开态 pi entryId——两 id 空间构造性互斥，钉死 clientUuid 会使撤回 reply 驱动刷新后的第二次撤回全失效）；定位按形态分派：`u-` 前缀走双通道（富消息 custom entry 映射 / 纯文本裸标记**末尾锚**扫描——纯文本消息无映射 entry（renderer needsBackfill 门控不拼 `u-` 标记 + mapper 只认 `u-` 形态），内核 withDeliveryMarker 全量尾附裸标记保证末尾锚可达；恒尾附构造使末尾锚为精确逆、防内嵌字面误命中），entryId 形态直用；信令前校验幂等化（目标不在活跃路径但全文件存在 → 回 `revoked: true`——reply 丢失重试安全）。连带裁决：history 重建链增加 leafId 活跃路径裁剪（get_entries 返回全文件无过滤，增量路径不裁剪）；**派生面板口径二分准则 =「未来状态随树 / 已发生事实照实」**——注入模型上下文的面必修随树（todo/plan/goal/scheduler 四 extension 重建接活跃路径 + plan/goal/scheduler 须新增 session_tree handler 即时重建、handler 体纯重建两行体禁复刻 plan session_start 的 steer 副作用；model binding 改活跃路径逆读），subagent/workflow/usage 与 session 名照实豁免（run 真实执行过、token 真实消耗过——与工具副作用残留同口径）；SessionRecords 撤回失效契约 = 丢 cursor 强制全量重建（防抖增量通道的 null 保持基线语义会留残影）；**census 义务** = 实施期全仓 session 文件读取点普查（机器锚点 grep `getEntries(` 于 extensions/ 已验证穷尽），按二分准则归类登记 constraints.json 新约束（session 文件读者必须 branch-aware 或显式豁免）；**U8 送达回执重建保留原 id**（结构性前提：回执入流保留提交 clientUuid——现状 appendUser 换新号使 steer/queued 已送达消息 live 窗口撤回入口构造性 miss，reconcile 仅切入/重试触发窗口无界）；workflow running 前置检查（session_tree 触发 subagent-workflow terminateRunningRuns——撤回不得静默杀后台 run）；生成中撤回 = 置灰 + tooltip（自动 abort 待用户拍板）；撤回粒度常态逐条（出站 splitComposed 已把内核合批拆回逐条投递——每条独立 user entry），拆分失败降级形态整批 + 草稿**两层规则**还原（层 1 纯用户合批裸标记切条——段界标记确定性、第 2..N 段剥首个连接产物 + 段尾标记剥除；层 2 一切校验不过形态宁合不裂整条**原样**单草稿不剥标记——mapper 单标记结构使验真锚不可闭环，误剥用户字面 = 内容丢失，宁留可手删字面；分隔符启发式与全文搜索锚均已否决）。已接受代价：旧分支单调累积无清理通道（重审条件 = READ_PRECHECK_MAX_BYTES 阈值）；「撤回 ≠ 抹除」（tee 日志/provider 侧/文件保留，UI 按「模型不再可见」表述）。**版本基线 = pi 0.87.x**（升级独立立项；navigateTree/树重放核心语义实锚登记 pi-semantics PS-60——0.84.4 dist file:line 锚点（session-manager.js `_buildIndex`/`_appendEntry`/`appendLabelChange`/`branch` + agent-session.js `navigateTree` 两步形态）+ 探针 pi-semantics-session-replay.test.ts 代码形态断言，pi bump 经 check-pi-semantics.mjs 版本门禁强制重验，0.87.x 新增 compacting 入口显式拒绝——runtime 前置检查由单保险变双保险；0.87.x 起 pi 自身恢复路径会写 `context_edit` entry 并经 `entry_appended` 跨 RPC 广播，taiji entry 消费链对该类型及 0.85.0 `usage` 类型的处理义务（逐类型裁决 = 不渲染独立气泡、不复算投影——raw 树路径视角与 pi UI history 一致，context edits 只在 pi model context 投影应用）登记在 U6）。**降级路径登记**：P1（navigateTree 语义）崩塌时退回方案 D——原地截断重写 session 文件（复用 createForkedSessionFile 树回溯）+ `switch_session` 同路径进程内重载（全现役机制，文件保持线性、无 branch-aware 税，代价 = 审计移位 sidecar + 放弃文件内树资产）；context hook 过滤方案维持否决（断层语义 + 压缩摘要泄漏面）。**机制重审触发条件**：pi 将 `appendContextEdit` 暴露到 ExtensionCommandContextActions 或 RPC 命令面（C-proc-08 版本门禁复验清单登记此项）——pi 0.87.0 原生 `context_edit` 原语（append-only 投影剔除，压缩自动遵守）届时严格优于 navigateTree 与方案 D，撤回机制整体重审。实施单元 U2-U8（U1 EventAdapter 翻译随通道事实退役；U8 = 送达回执重建保留原 id）；设计文档 `.tmp/tech-design/message-revoke.md`（过程产物，两轮完整对抗审查收敛：第一轮六轮 0 must-fix 后用户实质修订基线，第二轮价值审通过 + 三审聚焦复审 r3-r11 收敛，must-fix 轨迹 4→3→5→5→3→1→1→2→2→0——问题逐轮下沉：方案级→登记完整性→派生面深水区→撤回入口 id 生命周期，全部源码钉死后收敛）。

### ADR-0077 投递身份判据形态二分：判定严格、剥除宽松（2026-09-24 架构审查裁决）

`<!--taiji:msg:...-->` 模式串同时服务「投递身份判定」与「标记剥除」，两需求的形态要求相反：**判定要准**——宽松 `[^>]*` 形态曾作为身份判据（原 `BARE_MARKER_RE`），用户文本中字面假标记（如从 transcript 复制的标记）经 rebuild 路径以假 id 重建投递，产生重复投递（现实击中，架构审查 MF-1-1）；**剥除要净**——严格 uuid 形态会漏剥残缺/历史形态标记留下脏文本。**决定**：身份判据（提取/回执对账/rebuild 分派）只允许 `DELIVERY_MARKER_ID_RE`（shared `MSG_ID_TAG_RE` source 派生的严格 uuid 双形态 ∪ 本地收养条目 `m-<base36>-<seq>` 形态，uuid 段禁手写）；宽松形态仅授权剥除面（`stripDeliveryMarkers` / `DEFER_FLUSH_MARKER_RE` 家族）；rebuild 重投另加**出站尾附锚**判据（仅处于**精确文末**的标记构成 rebuild 身份——原文串末尾锚定、不 trimEnd 尾换行，与剥除口径「剥标记不吞尾换行」（P5）同源：出站标记恒尾附，与 `withDeliveryMarker` 写侧同形；文本中部标记字面量走 adopt 收养，不丢弃不重投）。**为什么**：判据分叉的修复成本随调用点增殖上升（难逆）；「同一正则两种形态边界」无上下文会惊讶；收敛后 SSOT 形态变化自动跟随，消灭手写体静默漂移（MF-1-11 同族）。

### ADR-0078 消息协议收口：分类码定码 + 中止独立帧 + 非终结呈现通道 + respawn 发布点统一（2026-09-25 消息链路去冗余裁决）

四项协议收口终态（错误判别契约：instanceof 错误类 + 分类码词表，废除文案前缀匹配与时序推断）：

1. **分类码词表 shared 单点**：`CompactErrorCode`（`compact_busy` = dispatcher compact busy 预检拒绝 / `compact_failed` = pi 层执行失败）与 `SendPromptReason`（`'command-missing' | 'hook-blocked' | 'error'`）均定义于 `packages/shared/src/protocol.ts` / `message.ts`，消费方一律 import——五处手写词表收敛单点。SendPromptReason 的 busy/compacting/bash 退役值删除：投递所有权内核「排队取代拒绝」后运行面只产三值；收窄裁决非 breaking（plugin-sdk `private:true` 不发布 npm、词表非外部契约面 + 运行面只消费 blocked/rejected 布尔、reason 是诊断/文案面 + 仓内零处退役值比较）。WS 广播 `send.rejected`（'busy' | 'compacting' | 'processing'）保留——bash 通道 busy 预检的防御反馈词表，不经 SendPromptReason。
2. **bash 中止走独立 `message.bashAborted` 帧**：中止是终态不是错误——UI 呈现「已取消」中性形态（statusTag 中性色，非 text-danger），协议回执 `message.status{aborted}` + bashResult `cancelled:true`；不经 message.error 误导收口。
3. **非终结反馈通道 = `message.stream_warn`**：busy 拒绝（compact busy 预检）等非终结提示经 stream_warn 内联进对话流（turn 内 notice，不切断 turn 分组、不触发错误收口；`message.error` 保留给真错误——错误作为 assistant 消息插入对话流的规则不变）；分类错误的 toast 呈现标志已删（呈现职责归对话流）。
4. **respawn 恢复发布点统一（D3）**：`session.restored` 发布锚 = `SessionService.restoreSession` facade 成功尾部（四入口拓扑全汇合点：attemptRespawn timer / ensureActive 惰性 / 手动 RPC / startup-reattach；三信号判别态在 pi-respawn 编排器，经 `onRestoreSuccess` 单点调用），经编排上下文判别 + 三信号（pendingTimers 在册 / attemptInFlight / 失败计数>0）判别发布——恢复一次成型恰好一帧，删除「惰性路径成功不发 / 经编排器路径发」的双点不对称；普通懒 spawn（进程存活首启）构造性排除（三信号皆零 miss）。renderer 恢复窗口订阅 / respawnPending 分区 / respawn TTL 拣回保留（非冗余：帧丢失与 bus 订阅生命周期的独立防线）。已知判据残余洞（attempt 让位裸 return 不置标志 → 跨 fire 子态三信号皆 miss）登记 D7-41，收口靠保留的 message_start gate（真机验证：该子态无 restored 帧、gate 恰好 1 条提示条收口、不落 dead 终态页）。

**发布配套义务**：`@zhushanwen/session-delivery` 0.10.1→0.11.0（DeliverySubmitOptions.receiptAnchor 增补 + port `hasPendingMessages` / DeliveryConfig `busyPolicy` 拆除；0.x 阶段 minor 位表 breaking）；npm 发布时 `@zhushanwen/pi-subagent-workflow` 消费方同批配套发版（notifier-receipt-anchor 行为锁依赖 0.11.0 语义）。

**D7 延后登记表收编**（15 项 = 投递审计 13 项 + 本设计新增 D7-40/41；每项 = 触发条件满足才启动，不预付任何实现）：

| # | 延后项 | 触发条件 | 触发后去向 |
|---|--------|---------|-----------|
| D7-27/28 | followUp 双键分流幻影语义 + DeliveryIntent 'after-run' 透传链 | 产品裁决：恢复 intent 载体兑现双键语义 vs 承认同义删分流 | A → 独立设计补 intent 语义链；B → 纯删除 |
| D7-29 | 投递确认②计数兜底 → per-id 挂账 | R2-b04-3 dev 观测数据到位 | 与 33 合并契约专项 |
| D7-30 | TurnRenderCache 尾部快车道 + redrive 车道 | 一次真机测量（三车道 vs fullRescan 帧耗时对比） | 数据证收益才保留，否则删 |
| D7-31 | readers.ts 11 函数容差层 | 协议 W05-W07 收紧 wave | 帧类型收紧后退场 |
| D7-32 | mergeBaselineWithLive 判据②③ 内容启发式 | wire Message 透出 clientUuid | 启发式收窄为兜底 |
| D7-33 | splitComposed 合批拆批 → port 逐条投递契约 | 与 29 合并的「内核↔适配层契约收口」专项立项 | ADR-0074 acceptance 口径被 per-id 回执替代 |
| D7-34 | notifyHoldRelease 手动边沿义务散落 | occupancy 原语加边沿回调的跨模块设计 | 3 手动点收敛 |
| D7-35 | 9 个 *_unsupported 防御码家族 | 惯例一致性裁决（缺服务码 vs 必选注入） | 统一其一 |
| D7-36 | msg-id-mapper 双标记载体 | 登记决策裁决（收敛方向：backfill 改派生/写侧退役/读侧兼容） | 按裁决执行 |
| D7-37 | morph 段 TTL（R2-b04-4 防泄漏兜底，core 模块级 Map 双侧惰性清扫） | delivery 条目作废生命周期事件挂钩改造立项（事件挂钩后 TTL 降级为兜底或删除） | 与 respawn 恢复事件零耦合，非同根源，独立立项 |
| D7-38 | 双 30s watchdog flush 半边冗余（内核 delivery.ts watchdogMs 30_000 flush 复核 vs registry 对账/补投/唤醒周期器） | session-delivery 域下次改动顺带核实双周期器对象异同（车道 A 收官未顺手执行，疑非冗余） | 确冗余删半边，非冗余本条注销 |
| D7-39 | gap 判定泄漏 ring 内部知识 | bus.subscribe 返回面扩 oldestSeq/gap 的协议变更窗口 | 随协议 wave |
| D7-40 | ui↔renderer 镜像族收编 @taiji/shared（镜像守卫生效后的正式收编） | 下次 renderer 域改动立项时顺带 | 3 处镜像归 shared 单份，守卫测试删除 |
| D7-41 | 惰性恢复跨 timer fire 子态发帧（attempt 让位裸 return 不置标志 → 三信号皆 miss；根治 = 第四信号或让位腿 join+标志改造，需裁决 join 失败记账归属） | 该格 UX 收口退化——症状锚点 = 活 session 回落 dead 终态页需手动解锁，或下次 respawn 域专项 | 判据封闭或收口机制重构 |

### ADR-0115 窗口外壳 mimic_mac 形态维持（issue #24 复核 reaffirm，2026-10-01）
GitHub issue #24（Windows 10 窗口外壳四问题）复核结论：用户抱怨全部指向 win/linux 自绘路径的实现缺陷（悬停圆点消失、16px 图标溢出 12px 圆点、侧栏顶部不可拖拽、四角色差方块、默认尺寸不看屏幕），无一条指向「自绘彩色圆点放左侧模拟 mac」的形态本身——无推翻既定裁决的新证据，mimic_mac 维持（三平台左上视觉统一，数值 SSOT = [DESIGN.md §11](../DESIGN.md)）。窗口控制按钮改为各平台原生风格的方案不采用（三平台视觉从此分裂，破坏「跨平台同一工作台」气质）。实现缺陷已在同批修复：悬停同色覆盖 + 8px 图标锁定 + 非 mac 顶部拖拽条带（DESIGN.md §11 增补段）。

### ADR-0116 窗口圆角策略：应用内圆角仅 mac，不加窗口配置键（2026-10-01）
三平台窗口圆角策略定案：mac = 系统圆角 + AppShell 根节点 `rounded-[10px]` 保留；Windows 11 = 无边框窗口系统默认圆角（Electron `roundedCorners` 默认值即 `true`，实装依据 electron.d.ts 平台标注 darwin/win32）；Windows 10 与 Linux = 方角（OS 能力边界）。应用内圆角仅 mac 渲染（AppShell 根节点 setup 期 `detectPlatform()` 类绑定，非 CSS 选择器分支——避免非 mac 首次渲染 rounded 闪现，且组件测试可断言）；非 mac 四角与窗口内容同色，色差方块随应用内圆角关闭而消除。两条不采用登记防复发：① **显式声明 `roundedCorners: true`**——默认值即 `true`，显式化行为增量为零（Win11 本就圆角、Win10 键无效果、Linux 键不适用），零收益纯维护成本；② **透明窗口统一圆角**（`transparent: true`）——丢失系统贴边吸附与投影、部分 Linux 合成器直接失效，为视觉细节引入 P0 级窗口行为风险。

### ADR-0117 窗口尺寸持久化三字段裁决：{width, height, isMaximized}、仅主窗口、close 同步 flush（2026-10-01）
非 mac 平台的窗口尺寸持久化（`<getDataDir()>/window-state.json`）字段恰三件 `{width, height, isMaximized}`，四条语义裁决：① **位置（x,y）不持久化**——窗口由 Electron 默认居中放置；已接受代价：多显示器用户重启后窗口回主屏居中、不记忆用户摆放位置（位置记忆引入恢复错位问题家族——副屏拔除后窗口开在不可见区域、「相交不足一半丢弃」的阈值裁决、恢复归属歧义，收益与证据不匹配；重审触发 = 用户反馈不可忍受）。② **仅主窗口写者**——只有 bootstrap 创建的主窗口挂持久化监听与启动恢复（`isMainWindow` 门标志），create-window IPC 迁移窗口不读不挂，持久化文件全局单写者，多窗口 last-writer-wins 互踩结构性消除。③ **close 同步 flush**——关闭事件取消防抖定时器立即落盘，`isMaximized` 取退出时刻窗口实际值：「最大化→直接关闭」序列下最大化期间跳过写、无防抖数据，须以退出时刻状态落 `isMaximized: true`，重启才能按正常态尺寸 show 后恢复最大化，同时消除防抖窗口的退出竞态。④ **最大化/全屏态跳过防抖写**——字段恒记最近一次正常态尺寸；resize/move 防抖 500ms 合并写；启动读取损坏/字段非法 → 丢弃回默认尺寸 + warn 日志（不阻断启动），合法值 clamp 到当前工作区后生效。实装 `apps/electron/main/window/window-state.ts`（不 import electron，窗口经最小结构接口注入；tmp+rename 原子写）。默认尺寸公式（主屏工作区 62%/75%、cap 1440×960、下限 800×600）与 darwin 分支恒 1200×800 的零改动边界同属本条裁决，数值权威 = [DESIGN.md §11](../DESIGN.md)。

### ADR-0120 远程访问凭据走跨进程文件热读，开启信号走 argv flag（2026-10-03 用户裁决登记）

**决策**：远程访问（手机浏览器经局域网直连 runtime，词条见 [CONTEXT.md](../CONTEXT.md)）三个通道裁决：

1. **remote token 凭据通道 = `<dataDir>/remote-access.json`（0600）跨进程文件**：main 是唯一写者（`apps/electron/main/remote-access/store.ts`，原子写 = 同目录 tmp + fsync + renameSync，防读侧撕裂），runtime **每次 WS auth 握手时读文件取当前值**（`packages/runtime/src/infra/remote-access.ts` 的 `readRemoteAccessToken`，由组合根以 `remoteTokenProvider` 注入，关态不装配零 IO）——token 轮换 = main 重写文件即生效，不重启 runtime、不中断在途 turn；文件缺失/损坏 → remote 凭据成员为空、退化为仅 spawn token 可认证（fail-closed）+ 频控日志（同因首次响亮含恢复指引，读取成功即重置）。
2. **开启信号 = argv flag `--remote-access`（配套 `--mobile-dist=<path>`），新增 env 键 = 0**：listen host（`127.0.0.1` / `0.0.0.0`）是启动期一次性决策，supervisor 按 `remote-access.json` 的 enabled 在 spawn 时现读拼参（非快照）；argv 不经环境变量继承链——scripts 直跑、验证脚本、vitest e2e 池等非 supervisor 启动路径不传 flag 即天然关态，构造性免疫、无需任何剥除机制。
3. **shape 判据单源 = shared**（`packages/shared/src/remote-access.ts` 的 `isRemoteAccessConfigShape` / `REMOTE_TOKEN_HEX64` / `REMOTE_ACCESS_FILENAME`）；main 写侧从严（hex + createdAt 全验）、runtime 读侧从宽（enabled=false 早退跳过 hex）的不对称是文档化刻意差异，不上收、不参数化。

**依据**：① env 注入 remote token 不可行——env 在 spawn 时固化，「轮换即时生效」与「桌面无感（重启 runtime 会杀 pi 进程树、中断在途 turn）」不可兼得：轮换触发重启则杀在途 turn，不重启则 runtime 持有旧值永不刷新；文件热读使「轮换 = 写文件」由构造成立。② env 开启信号不可行——关态剥除只挂 supervisor spawn 一路，仓内存在多条直跑 runtime 的启动路径（`validate-runtime-bundle.sh`、verify-ws-auth 等验证脚本、e2e 池），任何一条漏剥即 fail-open（LAN 监听面）；argv 判据让该整族路径不传 flag 即关态，无需逐路径设防。③ main/runtime 共享 dataDir 是既有架构约定（`resolveRuntimeToken` 读 `<dataDir>/runtime-token` 同通道先例）；auth 是低频事件（每连接一次），每握手读 4KB 文件成本可忽略。④ 轮换不踢存量已认证连接（auth 只门禁握手是现状语义）——「怀疑泄漏」的完整处置 = 面板轮换（断新接入）+ 关开开关（重启 runtime 踢全部存量连接），登记于 CONTEXT.md「remote token」词条。

**登记**：契约 SSOT = `packages/shared/src/remote-access.ts`；配置面 = `apps/electron/main/remote-access/`（写侧）与 `packages/runtime/src/transport/connection-manager.ts`（读侧鉴权消费）；无新约束族、无新增机器检查——fail-closed 语义由 connection-manager 单测锁定（E5 dist 探测 / E10 损坏重建处置单测在位）。设计过程产物 `.tmp/tech-design/remote-use-mobile.md`（不入库、git 不可追溯），本条为通道裁决的权威登记处。

## 已否谱系（决策已过时/被推翻，一行注记防重新发现旧坑）



- **ADR-0008** navigate-tree 桥接命令——命令已删，桥接形态被 marker 通道取代。
- **ADR-0019 / ADR-0022** 冷蓝暗色视觉方向——被 ADR-0066 太极纯灰推翻。
- **ADR-0023** Overview 入口 = sidebar 按钮 + ⌘⇧O——v6 D14 nav 重构移除入口按钮，⌘⇧O 未绑；go-overview 仅经 SearchModal 可达。
- **ADR-0045** 自研虚拟滚动不引入库——决策反转：MessageStream 已切 virtua/vue `<Virtualizer>`（cw wave w3）。
- **ADR-0003**（digest）translate 宽类型——被 ADR-0037 真契约窄类型取代。
- **ADR-0007**（digest）git submodule 管理依赖——被 ADR-0011 打包内置取代。
- **ADR-0017**（digest）traffic light safe-zone v2——数值 SSOT 现为 DESIGN.md §11。
- **ADR-0061**（digest）cw store repo 级键控——被 coding-workflow 仓库方案取代。

### ADR-0086 项目 skill 实体迁 workspace 根，脱离 git 分支版本化（2026-09-25 设计裁决）
`.agents`（42 skills + workflows）不再被 git 跟踪：实体唯一一份放 workspace 根 `<workspace>/.agents/`（非 git 仓库），各 worktree 经 symlink `../.agents` 共享——任一现场改动全部 worktree 实时生效，构造性消除「skill 随分支版本化 vs 横切工具需要恒定」的根因冲突。**判据裁决（两刀）**：刀一 = 开发阶段工具 vs 产品能力（scripts/.githooks/CI 实测整体属开发工具——产品运行时源码零引用）；刀二 = 在不在代码变更传播链上——检查/测试/构建/CI 被代码变更强制拉动（拉不动 = 假红/假绿/构建崩），必须版本化锁同代、随分支流动是正确语义；skill 对代码只有操作入口引用，不同步的失效温和、可见、有人工裁决缓冲，可独立版本化。`.agents` 是唯一刀一链外 + 刀二链外 + 发现层 symlink 友好的资产（`.zcode/agents/` 过两刀但 host 桌面 app agent 发现 root lstat 零容忍，维持现状；`.githooks`/`scripts`/`.github` 卡刀二——各分支检查与该分支代码配套，统一刷平 = 2026-09-11 [HISTORICAL] 事故形态复刻，实测 8 个活工作线各领先 dev-0.10.5 17–58 commits，故不做全量基底刷平，检查/快照配套仅落活跃分支随 merge 自然传播）。**配套**：备份 = `refs/skills-snapshot` 快照 ref（`.githooks/snapshot-skills.sh`：临时 index + commit-tree 不碰工作树，空树防御防好快照被覆盖，push 超时降级链 timeout→perl→跳过，remote 自适应 github/origin）；pre-commit 第 0 段 = symlink 三分支判定（常态跳过 / 缺失幂等补建 / 真实目录等异态停手指引，bisect/detached 专用指引禁 merge）；CI（invariants + test-extensions 两 job）从 snapshot ref 物化 `.agents` 后再跑检查读点（snapshot 缺失 fail-fast 给指引）；git-cwt setup-worktree.sh 加部署段（补建/跳过/未迁移分支保留真实目录）。实体初版构成 = dev-0.10.5 侧全量 + main 侧 pi 内置版 pr-lifecycle（用户裁决 main 为最终版）− 退役 zsw 版 `.agents/workflows/pr-lifecycle.js`。已知形态：检出未迁移 ref/tag（v0.10.4 等）时 git 静默把 symlink 替换为旧内容真实目录——第 0 段③停手指引（该分支先落迁移 commit 或确认丢弃重建）。设计 SSOT `.tmp/tech-design/cross-worktree-skill-sync.md`（过程产物）；迁移 commit = 2133009f9（dev-0.10.5 试点）等 8 分支。

### ADR-0093 workflow 步骤视图数据源 = runtime 合并投影（2026-09-25 设计裁决）
WorkflowTab 步骤列表的数据源绑定从「workflow-record 全量快照（60s 节流持久化通道）」改为 runtime 合并投影：① workflow-record 供编排结构（trace 骨架：stepIndex/phase/agent）× ② subagent-record 供运行状态（迁移即写无节流），关联键 = (parentRunId, stepIndex)，在 runtime 派生缓存层合并（`packages/runtime/src/services/session/workflow-step-merge.ts`，冷热路径共用同一纯函数、单次解析两遍内存扫描）——步骤实时性不再寄生持久化通道（9.5-12.2 分钟盲区根因消除，真机实测 64-324ms 出现）。关键裁决：两态→四态映射矩阵 13 值域全覆盖——**gc 按写侧 D7 例外族语义分叉**（workflow origin 成功/失败 settle 均写 gc、由 error 区分：空→completed、非空→failed，同 `deriveOutcome` truthy 判定同构），中断族三值→failed+原文，cancelled→failed+文案，不产出第五态；一键多 record 收敛 = running 优先 + startedAt tiebreak（重试链退避窗口显示 failed 是真实状态）；无 stepIndex 的 record 不成行（旧 session 回落 trace-only）；水位维度增终态计数（settledSteps）驱动 workflowUpdate；renderer 拉取收敛（per-session in-flight 合并 + 可再武装 dirty 补充拉取，`stores/workflow.ts`）为**过渡层**——根治形态 = workflowUpdate 直接携带合并投影全量帧（独立优化紧随立项，落地后过渡层整体退役）。run 级徽标权威仍归 ①（接受「步骤全终态而 run 仍 running」≤60s 窗口，不新增第三状态词表）。schema additive 纪律：SubagentRecordEntryData / ExecutionRecord / SubagentRecord / RecordBinding 四型增可选 `stepIndex`（零迁移：旧 entry 读取归一 undefined + 序列化字节层负向单测锚定；constraints 机器检查评估结论 = 不登记，单测锚定足够）。设计文档 `.tmp/tech-design/workflow-step-visibility-data-source.md`（过程产物）；实施 = W0 四单元 + 验收缺陷修复（25410fac4 / c3cb48854 / 8e4afe05f / cb254b427 / ce0ab4e5d）。

### ADR-0099 resume 只复用已提交结果，删除从子代理会话日志复用结果的通道（2026-09-30 用户裁决）
**决策**：崩溃恢复只保留两种形态——① 该调用已有已提交结果（record 流里那条 `agent-settled`）→ 原样回放、零成本；② 没有 → 重跑（能定位到同一成员会话则续写，定位不到则重开）。删除「从子代理会话文件里把已跑完但结果未提交的结果捞回来复用」这条通道（原三档设计的档 1 补收）：`packages/subagent-core/src/orchestration/resume-run.ts` 的 `classifyResumeTierFromContent`（抽取末尾正文）、`dispatchTierCollectFrames`（合成补收用的 `agent-settled` 事件）、`planResumeTiers` 里按子代理名字取会话文件的部分，以及由它派生的时间下界、跨库身份查询、按契约判档、契约未知分支、原因枚举一并作废；`run-resumed` 的档位词由 `collect(tier-1)/continue(tier-2)/restart(tier-3)` 收敛为 `continue(tier-2)/restart(tier-3)`，档位判据换为「能否定位到该调用所属的成员会话」——定位口径沿用既有成员复用通道（`agent-started` 载荷的 `memberRecordId` + member-reuse-pool 查询），该通道自身的定位精度不在本条射程内。本条只约束**结果的来源**：交给脚本的结果必须来自已提交的调用结果；它不禁止任何功能读取子代理会话文件（读本身无害，被禁止的是把会话文件的内容当作某次调用的权威结果）。

**依据**：① 不变式判据——交给脚本的结果必须来自一次已提交的调用结果；满足它时，结果形态、归属、轮次、并发、数据格式漂移全部无需判断（这些难点只在「复用一份未提交的东西」时才出现）。② 读侧方案无法自洽：2026-09-30 两轮业务用例走查（核心组 + 边界组，独立 subagent）共查出 9 条缺口，形态是「每补一处就冒出新的前置」——按名字取会话文件 → 归属不可证（可能把别的调用甚至上一轮的对象交给脚本）→ 补「文件内自证」→ 自证不足需时间下界 → 时间下界之外仍需调用身份 → 身份查询又依赖源码注释自陈「重启后可能回落 undefined」的字段；首次派发即中断的场景则结构性取不到文件（现有测试必须预置一条同名已落定记录才能构造档 1 / 档 2）。③ 需求证据为零：本机可得的全部 run 记录 7 份 / 23 次调用中，未完成调用 0 个、`run-resumed` 0 次（有 1 次 run-interrupted，当时其调用已全部落定）。样本小（7 份，且记录会被清理）不构成「不会发生」的证明，但足以说明该能力目前由设计推演驱动而非需求驱动。④ 减法优先：删除后恢复链的判据只剩「有没有已提交结果」与「成员会话能不能定位」两条，不再解析对话日志。

**修订关系**：[ADR-0082](#adr-0082-workflow-run-record-单源收敛生命周期与词表重构2026-09-28-设计裁决workflow-run-resume-revision) 的 D1–D16 其余内容不变，被修订的是 resume 对「未提交结果」的处置。不采用的读侧方案与其两轮走查证据留档在不入库的过程产物 `.tmp/tech-design/resume-tier1-structured-result.md`（git 不可追溯），故本条为决策的权威登记处。

**条件性重审**：若「崩溃后零成本恢复」被判定为产品级要求（长任务、token 成本高的场景），唯一正确形态是写侧携带身份——调用在派发时记下它启动了哪个成员（`agent-started` 载荷补成员记录 id，或把成员登记提前到该事件写入之前），提交时带上本次调用的身份，使「哪次提交属于哪次调用」成为记录读取而非事后推断；届时应另立 ADR 与设计，不在读侧续补。

**登记**：未新增约束族，也未新增机器检查（本条为能力删除与语义收敛，事件词表与载荷形态不变；「结果只能来自已提交结果」由恢复链的实现形态承载——判据只剩「有没有 `agent-settled`」，没有第二条取结果的通路可走）。带 schema 的调用「必须给对象、否则报错」的义务**不在本层**：它已由引擎契约承载（pi 引擎 `collectOutcome` 在 `schemaExpected` 且无有效对象时强制失败并填 error；emulated 引擎失败走 `schema_emulation_failed`；义务登记见 [engine-development-guide.md](../extensions/subagents/engine-development-guide.md) §「schema 分流义务」），宿主侧不再加一层——引擎违契约应在引擎面暴露，宿主补丁会把边界故障掩盖成正常回落。

### ADR-0100 引擎路由不换目标：显式指定即严格 + 不可用显式失败（2026-09-30 用户裁决）
**决策**：一次 subagent 派发选哪个引擎，只由三层路由决定——调用参数 `engine` > agent .md frontmatter `engine` > 全局 config.json `defaultEngine`，三层全缺落内置缺省 `pi`；三层任一指定了引擎，运行期就按该引擎执行，**不换目标**。不可用一律以结构化错误显式失败：id 未注册（含 `defaultEngine` 指向已卸载引擎）→ `engine_not_found`（列已发现引擎 + 配置路径 + 安装指引）；probe 失败 → `engine_probe_failed`（逐项 check 摘要 + 恢复指引）；全局 config.json 存在但读不出来（坏 JSON / 权限）→ 派发前拒 `engine_config_unreadable`（缺省引擎是未知量，不按内置缺省 pi 执行；文件不存在仍是合法缺省）。要换引擎只能由调用方显式改传 `engine:'<id>'`。`EngineRouteResult` 只承载实际执行的引擎 id 与生效层，不存在「换了目标」的第二种值；`engineFallback` 留痕字段与 `engineRouting.strict` 配置项不存在。

**依据**：① 静默换引擎等于替调用方改写意图——沙箱类任务被静默卸除安全能力、显式 model 与引擎 provider 的绑定被打破；② 「显式指定」与「该引擎不可用」是两个独立事实，后者不改变前者——把不可用降级为「换个引擎跑」会让失败不可见，用户在非预期引擎上拿到结果；③ 引擎清单与 manifest 在派发前同步可得，不可用应前置暴露并给恢复指引，宽容回落面没有服务对象。

**登记**：设计规格权威源 [subagent-engine-protocolization.md](../architecture/subagent-engine-protocolization.md) §3.8 D4；约束 C-ext-16 描述随本裁决更新（entry 不因路由回落增 engine 系字段）；未新增约束族。

### ADR-0101 worker 诊断日志入 record 流：errorLogs 重启后可重建（2026-09-30 用户裁决）
**决策**：run 事件词表新增 `worker-log` 帧（载荷 `entry: {level, message}`）。worker 的 `console.*` 捕获与主线程 log 消息在追加 `run.state.errorLogs` 的同时**落账**，落账唯一写点 = `orchestration/terminal-actions.ts` 的 `appendRunDiagnosticEvent`（journal append 的单写者纪律不变：pump 经它写，不自己 append）。重建面 = `orchestration/run-events.ts` 的 `errorLogsFromEvents(events)`（按事件序追加 + `slice(-MAX_ERROR_LOGS)` 尾部裁剪，与活体写入同语义），壳 `jsonl-run-store.ts` 的三个重建点由「`errorLogs: []`」改用该函数。落账为 **best-effort**：写失败只 warn 留痕，不影响 run 生命周期（活体 errorLogs 已在内存，重建面少几条不改变终局语义）。

`worker-log` **不进生命周期状态机**：`foldRunEventCheckpoint` 显式跳过该事件（并推进 seq 水位），故不占 `RUN_TRANSITIONS` 表行。

**依据**：① 诊断日志的价值集中在「run 崩了/失败了之后」——重启即空等于在最需要现场时没有现场（此前 errorLogs 无任何持久面）。② 刻意不进状态机：诊断面与状态面正交，若让它走 `transition`，run 终局后迟到的诊断日志会撞上「terminal 是吸收态、任何事件 fail-fast」而把 fold 判成坏帧，进而丢掉后续判读；不占表行也避免把诊断事件写进转移表这份状态机权威。③ 单写者纪律保持：落账仍在 terminal-actions 内，pump 只经函数调用触达。④ 体量可控：`MAX_ERROR_LOGS` = 500 条上限，实测 run journal 每 run 2-20 条量级，诊断帧随 run 生命周期同清理（统一保留维护轮）。

**登记**：事件词表 `RUN_EVENT_TYPES` 由 9 增至 10（journal 事件；控制事件词表不变），`WorkflowRunEvent` 联合新增 `WorkerLogEvent`。无新约束族；机器检查面 = run-events 的词表/转移表穷尽测试（新增样本）+ 本条的诊断帧折叠与重建单测（core）+ 壳重建单测。

### ADR-0102 run 侧 v1 读面整体删除（2026-09-30 用户裁决，承 ADR-0094 同款裁决的延伸）
**决策**：workflow run 侧（workflow-record）的 v1 兼容读面整体删除——record 侧 v1 兼容层已按「项目未上线、无 v1 数据，不迁移不兼容」裁决先行删除（ADR-0094 v1 删除补记），run 侧残留读面按同款裁决收敛为 v2-only。删除面四项：① session-reader 发现链收敛单档（`discovery/workflows.ts`——删 workflow-record v1 全量快照档、workflow-state-link 旧指针档与 wf-state 快照解析族 `extractCallSessionFiles`，只认 v2 注册条目的 recordPath 锚点）；② runtime `workflow-extractor.ts` 删 v1 快照条目扫描与 legacy 双管线（workflow-state-link 指针 + state 文件投影），文件收缩为 session-file-extraction 共享骨架的消费壳，records 恒空——runtime workflow 列表唯一数据源 = events-projection 的 record 流 fold + v2 注册/终态条目；③ core `run-snapshot.ts`（`SNAPSHOT_VERSION` 快照行版本常量，写面死后仅存读面残件）整文件删除，barrel 导出移除；④ 跨包契约测试同批收敛（runtime 三文件删除/重写、session-reader 两文件收敛单档、core `SNAPSHOT_VERSION` 值锁定测试删除）。

**旧格式语义**：历史格式条目（v1 全量快照 entry / workflow-state-link 指针 entry / wf-state 快照行）不识别、不拒读、不报错——静默从各读面消失（发现链不产 runId、列表不显示、resume 一律拒绝），是历史数据处置的预期行为（不迁移、不兼容、不主动清盘文件）。session-reader 的 `readRunSnapshot` 保留（tool-handler workflow 概览快照链仍有 import；发现链收敛 v2 后该链对 v2 档不可达，随该文件后续批次清理）。

**登记**：壳 `jsonl-run-store.ts` 注释措辞同批终态化（v1 行静默消失 = 设计预期）；壳 `session-lifecycle.ts` 的 link 条目读面不在本批领地、另行批次收敛；无新约束族（数据处置口径承 ADR-0094 系）。

### ADR-0104 workflow 可视化入口语义分立：openWorkflow 改向 overlay + openWorkflowInDrawer 显式 drawer 语义（2026-10-02 设计裁决，workflow-visualization D1）
**决策**：「看 workflow」的入口从「切 drawer 到 workflow tab」改为「打开全屏 overlay」，入口函数语义分立为两个，同一函数不承担两种语义：① `openWorkflow`（`packages/core/src/domain/drawer/coordination.ts`）改向为开 overlay——汇聚点单点改向，托盘 workflow 行零改动（已传 runId）；未绑定 overlay opener 时 no-op（headless/测试安全默认，不触达 drawer）。② 新增显式 drawer 语义函数 `openWorkflowInDrawer`（= 原 openWorkflow 实现的移位保留：setWorkflowView 三步——切 workflow tab + 记录选中名 + 开 drawer），供 overlay 装载失败回落链（Guard 捕获后 openDrawerTab + openWorkflowInDrawer 注入选中态，不得经改向后的 openWorkflow，否则重入 overlay 入口）与 SubagentTab 返回按钮直调；形参双语义（收 workflowName 或 runId，由 WorkflowTab「先 runId 精确匹配、后 scriptName 取最新」兼收解析）。配套：对话流 workflow block 从只传脚本 name 改为以 (scriptName, slug) 经 workflowStore 反查 runId（slug 缺失回落「name → 最新 run」现状语义；slug 碰撞取最新不阻塞；反查名字匹配为归一形态——双侧 basename 化 + 去扩展名后比较，路径 / 带扩展名 / bare 三形态互通（实装锚 = renderer workflow-viz overlay 控制器的 findRun；L4 真机发现主 agent 常传脚本路径、record.scriptName 存 basename，严格等值恒 miss）；反查未命中的兜底 = openWorkflowInDrawer(nameOrRunId) 显空态——点击不丢反馈）；drawer WorkflowTab 保留作回落载体（overlay 装载异常与窄窗口形态）。

**依据**：不采用「两处入口组件零改动」——被现状证伪（block 只传脚本 name，同脚本并发 run 会打开错误的 run）；不采用「回落复用 openWorkflow(runId)」——改向后该函数语义已是开 overlay，回落经它调用会再次触发 overlay 入口、与装载失败形成重入，显式函数让两条通道在调用点即可区分意图；不采用「从 tool result 解析 runId」——tool result 是面向模型的文本，解析它是脆弱间接链，(scriptName, slug) 反查用的是 slug 的设计本职（区分并发 run）。

**登记**：无新约束族（调用意图经函数名区分，语义边界由 coordination.ts 的 D1/D10 注释锚点与测试钉住）；实装 = `packages/core/src/domain/drawer/coordination.ts`。设计文档 `.tmp/tech-design/workflow-visualization.md`（不入库，过程产物）；本条即该决策的现行登记处。

> **补记（2026-10-06，workflow-overlay-refine D2，header 形态修订）**：workflow-visualization（2026-10-02）交付的 overlay「双 header」形态——壳 header 与 `WorkflowLivePanel.vue` 自身 header 行（状态 pill / elapsed / args）并存——已被该设计 D2 修订为**单 header** 终态：LivePanel 自身 header 行删除（面板顶部直接从 L2TabBar 开始，run 状态要素由壳 header 单点呈现），args 整体不进 header（用户 v5 终裁：真实形态是 JSON 串、扫读价值低）。本条登记的入口语义分立与回落链不受影响；overlay 现行结构以该形态为准。

### ADR-0105 workflow DAG 静态解析器落 subagent-core（2026-10-02 设计裁决，workflow-visualization §3.2 解析位置 A 方案）
**决策**：`scriptSource → DAG JSON` 静态解析器（acorn 解析；节点/边/phase 分区/条件谓词/并行组/循环回边/调用点行号；模板名保留；不支持语法 fail-fast 结构化错误）落 **subagent-core**（workflow 编排核心包）——解析器紧邻 script-lint 与 record 写入点，与引擎 CLI 包（pi-subagent-cli / zcode-subagent-cli）无关（引擎包被边界禁止依赖 core）；解析产物作为 run 数据的派生物经 `session.getWorkflowDag(runId)` RPC 透出（runtime 读该 run record 的 `run-created` scriptSource，调 core 解析器，runId 内存缓存、仅缓存成功结果）。到达 renderer 的链路 = runtime tsup bundle（noExternal inline core）。**acorn 依赖只声明在 subagent-core**（runtime 不声明——runtime tsup 对自身 dependencies 默认 external，声明错位会致打包态断链）。

**依据**：不采用 renderer 侧解析——acorn 进 renderer 包体，且解析逻辑与引擎 lint 规则形成双份漂移；不采用 runtime 侧解析——runtime 对 workflow 脚本的语义责任就此开端，职责边界不如编排核心干净。

**登记**：无新约束族；实装 = `packages/subagent-core/src/shared/workflow-dag-parser.ts` + `packages/subagent-core/package.json`（acorn 声明）+ `tsup.config.ts` noExternal 同步。设计文档 `.tmp/tech-design/workflow-visualization.md`（不入库，过程产物）；本条即该决策的现行登记处。

### ADR-0106 事件流通道 = 拉模式 RPC + 信号水位 diff 扩维与 worker-log 滞后取舍（2026-10-02 设计裁决，workflow-visualization D4）
**决策**：workflow run 事件流原文对 renderer 的通道 = 新增 `session.getWorkflowRunEvents(runId)` 拉取 RPC（大字段 2KB 截断 + truncatedFields 标注——input/result/scriptSource/args 四个全文载荷字段；截断形态仅供展示，resume 恢复与 args 一致性校验在引擎侧读 record 原文全文字段，不经本通道）；运行中更新沿用 `workflowUpdate` 信号触发重新拉取（[ADR-0097](#adr-0097-拉为主推补充数据同步第一原则与域同步协议收口2026-09-26-架构裁决)「拉为主推补充」的应用）。信号水位 diff 扩两维——① phases 折叠（纯脚本 phase 转态发信号）② per-ask attempt 计数（重试边沿发信号，`stepStatusFingerprint` 在串各 call status 之外串入 attempts）——修复「纯脚本 phase 推进期间无信号」与「重试窗口内无信号」两个盲区。**已接受代价**：worker-log 行不纳入信号 diff 维度（无 phase 字段、不对应 call 转态、行数无上界——纳入等于把日志打印频率放大为每次信号的全量重新拉取频率），其展示滞后到下一转态信号（转态类事件秒级到达；worker-log 后无转态跟随时可能分钟级）。不做事件边沿级推送（逐条直播属体验增强非结构必需）。

**依据**：逐条事件推送被 ADR-0097 否决面覆盖（拉是真理通道、推是性能提示，可靠性由通道保证）；拉模式满足「开 overlay 即得全量、运行中信号触发刷新」，结构/实况两个展示目标不依赖逐条直播。

**登记**：无新约束族（推拉纪律承 ADR-0097）；实装 = `packages/shared/src/protocol.ts`（两 RPC 契约与错误码闭集）+ `packages/runtime/src/services/session/session-records.ts`（指纹扩维）。设计文档 `.tmp/tech-design/workflow-visualization.md`（不入库，过程产物）；本条即该决策的现行登记处。


### ADR-0107 展示容器三形态拓扑与内容归属：右抽屉 / 底抽屉 / 浮层，容器注册表为唯一权威（2026-10-03 设计裁决，display-containers §6.1/§7.1/§7.2）
**决策**：展示型内容按内容形状分进三个固定容器——右抽屉（竖长阅读型，终态 8 tab：git/doc/detail/subagent/bashTask/plan/btw + workflow 回落载体）、底抽屉（横宽输出流，本期仅 terminal 一种内容、不预设 tab 枚举——第二种横向内容出现时它才从「终端面板」升格为「容器」）、浮层（全画布：browser/workflow）。内容归属的声明处 = 容器注册表（core 纯数据 + 图标标识串，ui 层映射组件），DrawerPanel 硬编码 tabs 数组改注册表驱动；注册表为唯一权威，ui 壳组件与 core 协调函数都读它、禁止各自文字化。workflow tab 保留作 [ADR-0104](#adr-0104-workflow-可视化入口语义分立openworkflow-改向-overlay--openworkflowindrawer-显式-drawer-语义2026-10-02-设计裁决workflow-visualization-d1) 回落链载体（L1 常驻第 8 图标，主入口仍浮层；回落触发面 = 浮层装载/渲染失败，render-error 链实装已核实）。TraceInspector 临时上下文页不入 L1 注册表（slot 首位注入绕过 activeTab 体系），在老能力映射表登记保位。右抽屉默认 activeTab 从 'terminal' 改 'git'（枚举收窄后首项且高频）。控制态粒度：开合态 per-session 分区（useSessionScopedState 范式）；尺寸类（底抽屉 heightPct）= 全局布局值全局单键 `taiji:bottom-drawer-height` 持久化（对齐右抽屉宽度 `taiji:drawer-width` 先例，姊妹容器同构尺寸同粒度）、显示期 clamp 不写回持久值、拖拽区间 15%–70%。

**依据**：不采用「单抽屉优化」——terminal 半宽折行与 browser 死腔证明竖长容器承载不了形状错配的内容，容器级问题抽屉内优化无解；不采用「自由 docking 互移」——见 ADR-0109。注册表机制的证据 = 10 tab 硬编码已拥挤 + browser 死腔无人发现（归属无声明处）。

**登记**：无新约束族（拓扑经注册表数据结构自承载）；实装 = `packages/core/src/domain/drawer/registry.ts`（新）+ `packages/core/src/domain/bottom-drawer/` + `packages/core/src/domain/overlay/`，W0-W2 分波（W0 注册表先载旧 10 条行为不变）。设计文档 `.tmp/tech-design/display-containers.md`（不入库，过程产物）；本条即该决策的现行登记处。

### ADR-0108 tab 两层上限：类型层容器拥有，实例层内容拥有，二选一不叠加（2026-10-03 设计裁决，display-containers §6.3）
**决策**：任何容器内可见 tab 最多两层。L1 类型层（固定图标列表，回答「这是什么类型的东西」）由容器拥有；L2 实例层（文档式 tab 条或组件内部导航，回答「具体是哪一个」）由内容拥有；**实例层要么在组件内部、要么用容器统一实例条，二选一不叠加**。本期唯一新增实例层 = detail 多文件 tab（做在 detail 面板内顶部；keep-alive 多实例共存——切换不丢滚动位置与 diff/preview 模式态；注入语义 = 入口命中未开文件新增 tab 并激活、命中已开仅激活、不设打开上限）；PlanDocsPanel 文档切换条与 BtwPanel 线列表属组件内部导航，维持不变。

**依据**：不采用「容器层统一实例条」——与组件已有内部导航叠成三层，tab 套 tab 是公认混淆源；DESIGN.md §6.3「形态 B：icon 一级 + 各 tab 自治二级」既有方向；现状 PlanDocsPanel 证明组件内部导航够用。

**登记**：无新约束族；实装 = `packages/renderer/src/composables/features/file-tree/useDetailPane.ts`（单值→map）等，W3（顺带承接 detail 展示链 per-session 化终局解——selectedPath 全局单值串线与 DetailPane 单实例清空）。设计文档同 ADR-0107；本条即该决策的现行登记处。

### ADR-0109 固定家 + 显式双入口，否决内容自由互移（2026-10-03 设计裁决，display-containers §6.4，承 ADR-0104 模式推广）
**决策**：每种内容一个固定归属容器；个别内容多一个备用容器，靠内容标题栏上的显式动作（「浮层展开」/「收回抽屉」）切换；入口函数语义分立——`openX` 与 `openXInDrawer` 两个函数、不叫同一函数传参区分（ADR-0104 已验证模式的推广）。本期双入口只给 workflow（既有）；subagent 浮层 trace 模式（左右分栏）为 W4 后续，本期 SubagentTab 零改动，「浮层展开」动作位随 W4 trace 模式一并设计（不预埋不可见的视觉占位，display-containers §5.4）。

**依据**：不采用自由拖拽互移——①多数内容只在一种形状里是对的（browser 在竖长抽屉里的死腔即证据）；②移动要迁移运行态（终端 PTY 不能死、浏览器 view 要重挂定位），成本 = 内容数 × 容器数；③ VS Code 的视图自由移动是其最复杂、使用率最低的功能之一。用户要的不是互移，是「这个实例此刻需要更大空间」——尺寸拖拽 + 展开/收回动作已覆盖。

**登记**：无新约束族；W4 实装 subagent trace 模式时落动作位。设计文档同 ADR-0107；本条即该决策的现行登记处。

### ADR-0110 键盘栈序：Esc 固定层级序唯一属主 + 模态表面聚合双键旗标 + 局部表面执行序两档 + view 转发键清单（2026-10-03 设计裁决，display-containers §6.7）
**决策**：① Esc/⌘W 关闭序 = **固定层级序**（浮层 → 底抽屉 → 右抽屉，不按开序时间记账、状态模型不存开序）；全关后 ⌘W 才关窗口。② Esc 唯一属主 = AppShell 层栈序编排器（window keydown bubble 监听、根 setup 首位注册，isComposing 前置守卫；存量 WorkflowVizOverlay 与抽屉侧 Esc 监听拆除——现状双裸监听同按双关已核实）。焦点所有权五层分派：焦点所在内容自消费 Esc 时编排器让位（未收编模态族 / staging 活跃态与地址栏编辑态 / 底抽屉终端聚焦——xterm 5.5 Escape cancel 实装 stopPropagation 事件到不了 window、禁 capture 接管 / 浮层浏览器页面内——Esc 归页面自身语义）。③ **模态表面聚合**（AppShell 级开合态注册单一事实源）成员带旗标组：`yieldsEsc` / `yields⌘W`（两键让位各自独立）与 `shieldsView`（原生 view 遮蔽联动）。弹出层族（reka DismissableLayer 托管的 Popover/Select/ContextMenu）**只让 Esc 不让 ⌘W**——reka 不以 ⌘W dismiss，让位即死键（按键无动作且无递进）；模态族（有未提交输入保护理由）双键均让位。指针驱动瞬态表面（HoverCard/Tooltip 类）显式豁免双旗标（hover 中按 Esc 双动作登记为已知可接受边界）。④ **局部表面 Esc 消费方按相对编排器执行序两档分流**：先行档（capture 相任意节点 / document 级（树序压倒注册序）/ 元素级冒泡先达）= 消费即 preventDefault 约定；后行档（window bubble 且注册晚于编排器，全仓唯一 = SessionList escCount）= 入聚合让位登记，开合态绑删除确认态本体（SessionItem 确认态 / folderConfirmingCwd 聚合谓词），非 escCount 广播计数器（单调递增非状态本体，误绑 = 全局 Esc 死键）。⑤ `` ⌃` `` = 底抽屉开关，主进程 before-input-event **窗口级**拦截（⌘W 同款转发链；不经 shortcut-registry/globalShortcut——那是系统级全局键，会全系统占用并抢走其它应用同键；失焦时无动作）。⑥ 焦点进入浮层浏览器 WebContentsView 后，三键（⌃`/⌘W）连同 app 快捷键族（⌘K/⌘,/⌘[ 等，renderer 注册处 IPC 上报）经 **view 转发键清单**接管（双端匹配配对契约 + 键矩阵单测）；**Esc 不入清单**（页面所有权优先）。焦点契约：任一容器关闭后焦点回 composer；staging 活跃态与浮层浏览器地址栏编辑态聚焦时 Esc 优先服务输入语义（不触发容器栈序）；裸 composer 输入态无 Esc 消费面、Esc 走层级序（第 5 层，与现状一致）。

**依据**：现状 Esc 双裸监听（overlay 仅 preventDefault 不阻断传播 + PanelContainer 裸挂）同按双关——统一编排必须拆其一；⌘J 已被 fast-handoff 占用（选键历史注释明言）；VS Code `` ⌃` `` 为窗口级（肌肉记忆现成）；弹出层族 wrapper 补 preventDefault 方案被否决（反杀 reka 自身 dismiss——`if (!event.defaultPrevented) dismiss` 判定在前，须再手动关闭的组合改造逐 wrapper 侵入）；「聚合注册同步于开关动作」硬约束对 reka 托管弹层无自然钩子，降档为 flush 时序 + 注册序前提（编排器根 setup 先注册，FIFO 同相位先执行让位判定）。

**登记**：门禁项 = Esc 消费方扫描脚本化（先行档无 preventDefault / 不在任一档登记即红；reka 原语 import 纳入扫描锚点防直接组装盲区）随 W1 单测族或交付后落地；实装 = 编排器/聚合新模块 + 局部表面改造 + window-factory ⌃` 拦截，W1。设计文档同 ADR-0107；本条即该决策的现行登记处。

### ADR-0111 docked 死状态删除（2026-10-03 设计裁决，display-containers §6.6③）
**决策**：`DrawerControlState.docked` 与其全链（pin 图标 / emit 链 / toggleDrawerDock / useSideDrawer re-export / i18n key）整体删除——全仓唯一消费方是 pin 图标变色与 title 切换，无任何行为逻辑（close() 无 docked 门、无条件置 isOpen=false），死状态机械清扫，无行为回归。

**依据**：保留 = 假功能信号（用户点 pin 期待行为、实际无任何效果）；删除安全性经源码核实（单消费方）。

**登记**：无新约束族；实装 = W0 状态还债单元（与选中态迁出、瞬时参数分区同批）。设计文档同 ADR-0107；本条即该决策的现行登记处。

### ADR-0112 原生 view 层级共存守卫与显示收口（browser 浮层复活配套，2026-10-03 设计裁决，display-containers §7.4）
**决策**：WebContentsView 恒渲染于宿主全部 DOM 之上（z-index 不可穿越），配套四条守卫：① **显示收口谓词**——view 显示当且仅当「浮层开 ∧ 内容 browser ∧ 无错误态 ∧ 无相交 shieldsView 面」；错误态（页面加载失败 / create 失败 reject / render-process-gone）主动 `browserHide`（keep-alive 幂等），三触发恢复动作一律收敛到对该单一谓词求值、禁止各触发独立 show（防恢复通道竞态）。② **shieldsView 几何相交双阈值空间滞回**——进入隐藏 = 遮蔽面与 view 原始矩形相交；退出隐藏 = 与外扩矩形（外扩 N px）仍完全不相交；缓冲带内两切换条件皆假、双向状态保持（施密特结构）；显式不采用 debounce / 时间滞回（时间平抑红线——空间解可达成同一目的）；重算触发面 = resize + rect 推送链 + 成员开态内 rect 变化 + 浮层内容切换。③ **浮层随行**——浮层开着切 session 时 view 换显豁免（内容与 view 保持发起会话的，视口不空白）；`focus()` 收口：非「浮层开 ∧ 内容 browser」态只隐藏不显示（实装 `focus(sessionId)` 无条件 `_showEntry` 与「恢复现状语义」矛盾——关浮层→切走→切回的残影旁路，主进程/renderer 改动项；browserFocus 生产调用面唯一已核实）。④ **会话删除级联**——仅发起会话触发浮层关闭 + view 销毁（SessionCleanupHooks browser 分支 + browserDestroy）。错误通道：`browserCreate` IPC 失败改 reject（现状 create 失败仅主进程 warn 静默）；池满不是失败（LRU 自动淘汰）。

**依据**：仓内 view 池 hide() 残留事故前科（[HISTORICAL] 注释在案）；Toast 相交隐藏期重开浮层的 show 竞态、关浮层后切回的复显反例（逐路径推演 + 实装核实）。

**登记**：无新约束族；实装 = `apps/electron/main/browser/browser-view-manager.ts` 等主进程半边，W2；S9/S10 真机断言对账（含滞回两半边）。设计文档同 ADR-0107；本条即该决策的现行登记处。

### ADR-0113 终端多实例：实例编号贯通四层 + runtime 为注册表与序号分配事实源 + 世代判据 = token 变化（2026-10-04 交付，terminal-multi-instance）

**决策**：一个会话内可并行多个终端，主键由「会话 id」升为「实例编号」——① **编号格式** `term:<会话id>:<序号>`：序号由后台按会话维度分配、会话内单调递增、**实例关闭后不复用**（复用会让迟到 exit 帧误清新实例分区、清理到达前的旧残留串入新分区）；枚举/归属校验一律取**精确前缀 `term:<sid>:` + 序号段数字校验（`^\d+$`）**，禁按冒号切分取段；由编号反解 sid / 序号则取最后一个冒号前的余段 + 数字校验（sid 域不含冒号由格式保证；该口径把「sid 域不含冒号」从必要条件降级为防御项）。② **事实源 = runtime**：注册表 = 重键后的 `ptyMap` 派生视图（键集即存活实例全集，不建平行结构）+ 会话级序号计数器；**否决「live 键 max+1 纯函数派生」**（实例死绝后 max 回落会复用编号，竞态窗口无键隔离）；界面经新增查询帧 `terminal.list` 在**三触发点**（⌘R 刷新 / 会话激活 / 世代变更重连）对账恢复，对账范围钉死为被查会话（他会话键不参与增删）。③ **世代判据 = auth token 是否变化**（端口值不可靠——`findAvailablePort` 重启常落回原端口；`runtime-port` 广播沿是世代变更的保守超集，含无新进程的幂等分支）；**重置触发面收窄为世代变更**，同世代 WS 闪断不重置（宽触发会清空仍有效的输出历史、且派生无触发点的订阅重建义务）；重置枚举含输出分区、写队列状态机（滞留命令丢弃 + 提示）、**模块级订阅表先退订再清空**（跨世代同形键会命中幂等守卫致新世代订阅静默 no-op）；旧 token 不可得时保守判为世代变更。④ **关闭语义**：主动关闭与自然退出（exit/崩溃）同语义——切换条移除 + 三腿清理（输出分区 / 写队列实例态 / 模块级订阅退订）；「最后一个实例禁用关闭」是 **UI 供养规则而非域不变量**（唯一实例可自然退出归零至空态）；会话删除与 runtime shutdown 均级联全量杀链（新增 shutdown 步骤 `dispose-terminal-pties`，紧随 `server-stop`）。⑤ **三码互斥**：`unknown_terminal_id`（注册成员资格的否定回执，**唯一触发回收**的码）、`terminal_id_required`（缺编号 / 编号类型非法的畸形帧）、`terminal_id_session_mismatch`（编号会话段与请求会话不一致）——后两者走普通错误通道、不触发回收（同码会把仍存活的实例误判为幽灵并清理）。⑥ **ack 残窗双通道回收**：`spawn` 完成到界面建档之间可丢 `terminal.data`（首屏输出）与 `terminal.exit`（假阳幽灵条目）；回收靠「首个否定回执守卫」+「`terminal.list` 对账」两通道并列（均幂等、先到先回收、**无排序契约**），可达性不据仓内推导下断言、实施期探针留痕。

**依据**：并行长任务是终端典型用法（服务常驻 + 测试跑批），而会话是重量级对象（各带对话与模型上下文），「多开会话」不解决同一工作上下文内并行；「单终端分屏」是伪并行（一个 PTY 不可能同时跑两个交互命令）。编号唯一性与不回填的立法理由 = 迟到帧与清理窗口的竞态隔离；世代判据取 token 而非端口/沿的理由 = 两者均可证伪（端口可复用、沿含幂等分支）。

**登记**：约束登记 = C-proc-18 的 shutdown 步序 SSOT 同步为 15 步（新增终端 PTY 全量清理紧随 `server-stop`）；e2e 资产 = `E2E-TERMINAL-01`（`e2e/terminal-multi-instance.spec.ts`，L2/on-diff/serial，覆盖 T1/T2/T4/T8/T9/T10/T13；T3/T5 走 L4 真机、T6/T7/T11/T12 归单测）。设计文档 = `.tmp/tech-design/terminal-multi-instance.md`（过程产物，不入 git）；实施与验收证据 = `.tmp/dev-flow/terminal-multi-instance.*`。同族未落地项（浏览器多页面、浮层实例 tab 条）依赖本编号先例，另立项。

### ADR-0114 主区三卡化：内容区各自成卡 + 实例 tab 条范式统一 + 终端头部一行化（2026-10-04 用户裁决，drawer-cardification）

**决策**：① 对话流 / 右抽屉 / 底抽屉三块内容区各自持 float-panel 壳（surface + border + 10px 圆角 + shadow-1），卡间 8px 缝，卡内底色统一——**推翻 D2「一体化生长」裁决**（原右抽屉从主面板右缘生长、共享外壳与横跨 header）；PanelHeader / StatusBar 保持横跨工具条/状态条语义，不属任何卡。② 右抽屉 L1 栏选中态回归 §3.4 标准 tab 型（bg-elevated + neutral-fg）——原「bg-surface-hover 例外」以「drawer 与 main 同 surface」为前提，三卡化后前提消失。③ 终端面板头部一行化：实例切换条（tab 条 + 右簇「+」/收起按钮）单行承载，原第二行工具栏（清屏/终止）移除——终止与 tab 关闭叉同义，清屏功能退役（用户裁决接受）。④ 终端区收起语义 = 收起非销毁（实例保留、重开走对账恢复），入口 = 头部收起按钮 + 顶栏开关 + `⌃`` ` 三通道。⑤ 终端开关迁 PanelHeader 顶栏（右抽屉开关左边），StatusBar trailing 原生动作通道退役，StatusBar 回落「有状态项才显示」纯显隐。⑥ 实例 tab 条范式统一（§5.3.1）：终端实例 tab / detail 文件 tab / plugin L2 tab 三族同构——非激活 bg-input+border、激活 bg-elevated+border-strong、关闭叉常驻命中 ≥20px（原「hover 才显现」形态因可发现性差被用户裁决推翻）；pin 功能全链移除（L2TabBar/L2TabItem/PluginViewContainer/WorkflowLivePanel，用户裁决：不需要该功能）。⑦ TurnRail 定位从 fixed 视口垂直居中改为 absolute 于对话流容器右缘——fixed 不感知底抽屉高度，窗口矮/抽屉高时叠进终端卡（跨区缺陷）；absolute 后随对话流卡 overflow 裁剪，跨区构造性不可能。

**依据**：用户 2026-10-04 对底/右抽屉的 5 点产品反馈（三区分割缺失、开关位置、头部两行、tab 可区分性、tab 关闭叉）+ critique 补充发现（TurnRail 跨区、tab 条无横向滚动、空态黑块、最后实例禁用叉伪装可点、composer 窄宽叠字）。一体化生长的「同 surface 无缝」语言在多容器并存场景不可辨识（三区边界靠 1px 拖拽线不可发现），卡片化是分区可见性的直接解；代价 = 卡缝占 8px×2 垂直空间与推翻 D2 的回写成本，收益 = 分区心智清晰 + tab 范式全局一致 + 跨区缺陷构造性消除。

**登记**：设计 SSOT = docs/DESIGN.md §3.4/§4.1/§5.3.1/§6.1/§6.3/§6.4（2026-10-04 同批回写）；CONTEXT.md「底抽屉」词条开关入口同步。实现落点 = MainPanel（壳下沉）/ PanelContainer（三卡 + 卡缝 handle）/ DrawerPanel（卡片化）/ TerminalView + TerminalInstanceBar（head 一行）/ TerminalToggleButton（原 StatusBarTerminalToggle 迁移）/ DetailPane / L2TabBar / TurnRail。

### ADR-0118 对话流 HTML 预览与产物落点约定（2026-10-04 设计裁决，chat-html-support）

**决策**：对话流支持「agent 交付 HTML 产物 → 用户在应用内直接看渲染结果」——扩写 capability 段成精确能力契约（M0：正/负面清单；M1：交付约定与预览约束 + 每 turn 注入会话产物目录绝对路径）、新 fence info string `html-preview` + 对话流预览卡片、DetailPane 对 `.html` 新增渲染态。四条关键裁决：

1. **产物目录选在白名单既有成员内**（`<dataDir>/artifacts/<sessionId>/`）：local-file 协议白名单静态成员集（`apps/electron/main/utils/local-file-prefixes.ts`）已含 `<dataDir>` 前缀，产物落其下则预览无需新增白名单成员、renderer 不成为白名单输入方（「白名单外路径一律 403」不变量保持）。目录推导公式单点 = `packages/shared/src/paths.ts` 的 `getSessionArtifactsDir`（含 sessionId 穿越校验，规则与 `isPiSessionId` 同域：允许 `.` / `_`、禁 `:`——不用 `getImageCacheDir` 的窄集）；system-prompt 扩展侧不 import shared（包边界 + C-proc-26 / C-proc-09 门禁组合），以同公式镜像推导，两实现段名与校验正则字面量对拍机检。
2. **session cwd 动态注册方案不采用**：该方案让 renderer 首次成为 local-file 白名单的输入方（白名单防线对 renderer 的信任假设从零变为有），并连带引入新 IPC 通道、进程内集合、注册时序竞争、预检对注册完成的依赖；落点约定后这些复杂度全部无服务对象。**已接受代价**：项目目录内的 HTML 不能被应用内预览——恢复路径 = 要求 agent 把产物写到会话产物目录，或经「查看源码」在项目内直接读源码。
3. **预检通道统一落主进程 `localFile:servable`**（入参绝对路径，出参 `{servable, reason, size}`，reason ∈ `not_found` / `is_dir` / `out_of_whitelist`）：卡片（经 deps `probeArtifact?`）与抽屉渲染态共用；谓词与 `protocol.handle` 复用同一规范化管线模块（白名单成员资格先行短路 → 存在性 → 目录性——越界路径不触 fs，杜绝任意路径存在性探测通道）。**不新增 runtime 文件 RPC**：白名单成员资格只在 main 信任域可见，runtime file 族的 cwd 守门看不见白名单，两处预检会形成两套准入语义。
3b. **实施期补全：源码态读取通道 `localFile:read`**（2026-10-04，D2 一致性审查反证）——产物目录在 session cwd 之外，既有 runtime `file.read` 的 cwd 守门不可达，故 `.html` 的**源码态**读取需一条与 servable **同源**的主进程通道：同谓词模块（准入前缀成员资格先行短路，越界不触 fs）、仅 `out_of_whitelist` 时回落既有 cwd 通道；通道名 `localFile:read`（`packages/shared/src/ipc-channels.ts` 登记）。它是第 3 条「预检通道统一落主进程」原则的对称补全（**探测与读取同源**），未新增白名单成员、未新增白名单输入方。

3c. **实施期收窄：读/预检通道准入 = 会话产物子树**（2026-10-05，branch-review dmg-r1-2）——`localFile:servable` / `localFile:read` 两条 IPC 的准入前缀 = 产物子树 `<dataDir>/artifacts/**`（`computeLocalFileReadPrefixes`，`apps/electron/main/utils/local-file-prefixes.ts`），不复用协议 handler 全量白名单。理由：通道入参含模型消息文本承载的路径载荷（html-preview fence = 不可信输入），全量白名单含 `<dataDir>` 整前缀（含 `<dataDir>/agent/auth.json` 等凭据），读/预检面复用全量白名单 = 渲染进程被注入后可直读数据目录内任意文件文本。收窄后越界仍返回 `out_of_whitelist`（不触 fs），消费方回落既有通道（useDetailPane cwd 通道 / 容器降级占位）；三条调用链（容器源码态、挂载前 size 预检、抽屉产物源码读取）全部只消费产物路径，无功能回退。协议 handler（渲染面：图片 / iframe 服务）保持全量白名单不变；谓词函数与检查顺序同源不变，未新增白名单成员、未新增白名单输入方。

4. **产物回收用文件系统级判据**（对齐 `apps/electron/main/images/image-cache.ts` 先例的「判据落文件系统层、不依赖进程级在场集」形态）：① 删会话级联删目录（与既有 `cache/images` 级联同一落点 `session-lifecycle.ts`、同一幂等形态）；② 保留期扫描（默认 7 天，`TAIJI_ARTIFACTS_KEEP_DAYS` 可覆盖；runtime 会话服务内启动扫 + 每日复扫）判据 =「产物目录子树最新文件 mtime 超龄 **且** 目录名 sessionId 在三棵会话树无同名会话文件」。**枚举深度规格另写**（主树 `sessions/<encodeCwd>/*.jsonl` 两层 / subagent `subagents/<encodeCwd>/sessions/*.jsonl` 三层 / btw `btw/<encodeCwd>/<mainSid>/*.jsonl` 三层，逐层 readdir 自实现）——不得照 `image-cache.ts` 的 `isOrphanSessionDir` 单层形态（该先例与生产两层布局失配，缺陷另登记 `docs/todo/image-cache-orphan-depth-mismatch.md`）；文件名 → id 解析用同型 `sessionFileIdFromName`，解析失配（合法 sid 含 `_` / `.`）保守取向为「视为存在、不清」。

**三条配套**：① **引用语法** = 新 fence info string `html-preview`（首词匹配，内容 = 单行文件路径；空 / 多行 → 卡片降级态「路径非法」），卡片走 Vue 段组件（`HtmlPreviewCard.vue`）不进 v-html / DOMPurify 通道——「用户 HTML 白名单契约」与「预览卡片不经 sanitize 通道」不变量保持；段类型复用 mermaid 同构通道，finalize 仅由 fence 收尾 / 消息 complete 触发（静默 200ms 不提前 finalize——半截路径不产假降级卡片）。② **渲染态** = DetailPane 对 `.html` 新增「预览 | 源码」切换，渲染态为 `<iframe sandbox="allow-scripts" src="local-file:///<百分号编码 abs>?r=<n>">`（无 `allow-same-origin`，文档落 opaque origin，读不到主窗口 DOM / localStorage / cookie；`?r=n` 仅作重导航触发）；CSP meta（`packages/renderer/index.html`）新增 `frame-src 'self' local-file:`。③ **协议响应头** = `protocol.handle('local-file')` 全部响应附加 `Cache-Control: no-store`，`.html` / `.htm` 再附加内容级 CSP（`default-src 'none'` 封网络出站；`script-src 'unsafe-inline' local-file:` 保脚本与相对子资源；指令集不含 opaque origin 下恒不匹配的 `'self'`）——sandbox 管「碰不到主窗口」、文档 CSP 管「连不出网络」双保险。

**依据**：① 根因是四环缺失（能力契约 / 交付模式 / 预览链路 / 产物落点未约定），落点约定消除整类「白名单外不可读」问题，比事后放宽白名单（renderer 成为白名单输入方）代价更低；② 预览文档唯一需要的同源能力是相对子资源，而子资源经 local-file 协议加载不依赖 origin 同源，故 sandbox 可不给 `allow-same-origin`；③ 两条被否路线的击穿点——srcdoc 方案（file.read RPC + iframe srcdoc）能力死（继承主文档 CSP 致内联脚本不执行、相对子资源无基准地址，交互价值消失）；WebContentsView 方案在抽屉内可行，但与对话流内联预览方向冲突（窗口层原生覆盖视图不随虚拟滚动同步，需一整套滚动同步机制）。

**登记**：约束 C-build-06 表述随本裁决收窄——scope 由「嵌入式网页」收窄为「嵌入第三方远程网页」，理由（`X-Frame-Options` / CSP `frame-ancestors` 硬伤）仅对远程站成立，本地 HTML 由应用自有 `protocol.handle` 服务、不携带这些头（见 ADR-0054 理由边界修正补记），登记 `docs/constraints.json` C-build-06；未新增约束族（预览隔离由 sandbox + 文档 CSP 构造性保证，落在 C-build-06 的 review-electron-build 面内）。设计文档 `.tmp/tech-design/chat-html-support.md`（不入库，过程产物）；实施 = 8 单元（u-foundation / u1-prompt / u2-infra / u-artifacts / u3-detailpane / u4-card / u5-docs / u6-acceptance）。

### ADR-0119 html-preview 渲染形态 = 对话流内联容器（2026-10-04 用户裁决，chat-html-support v16）

**决策**：`html-preview` fence 段在**对话流内直接渲染**（`HtmlPreviewInline.vue` 内联容器：头部条[文件名/大小/源码-预览切换/刷新/收起展开] + sandbox iframe 原位嵌入消息流）；原「预览卡片 → 点击 → DetailPane 渲染态」两级形态**退役**——DetailPane 对 `.html` 恢复基线源码高亮，相对链接不再承载预览。安全模型零变化：sandbox 权限面、`local-file` 协议白名单、`localFile:servable` 预检、CSP `frame-src`、内容级 CSP 全部平移适用（机制规格从原 D4 抽屉渲染态整体平移到容器）。

**要点**：
1. **单渲染面原则**：内联容器是唯一渲染面。抽屉保留渲染态会造成「同一文件两个渲染入口、两套挂载序列」的双轨；内联容器的展开/源码态已覆盖抽屉渲染态的全部用户价值。`localFile:read` 通道保留（消费方 = 容器源码态 `useChatViewDeps` readArtifact 与 DetailPane 文件树/抽屉源码读取 `useDetailPane` loadPreviewContent——与设计 §6.4 D4「退役的连带回收」同口径；变更集卡入口语义是看 diff，不消费该通道）。
2. **高度策略降级裁决**：内容高度自适应（iframe 内上报）三条通道均不可行——产物文档内协作脚本不可假设、opaque origin 收不到定向 postMessage、`sandbox` 无 `allow-same-origin` 时 `contentDocument` 恒 null——降级为固定 480px（展开 720px）、超限 iframe 内滚动；升级预案（协议 handler 注入上报脚本）登记设计文档 §6.3。
3. **流式与降级形态保持**：finalize 仅由 fence 收尾/消息完成触发（静默不提前）；预检三原因降级占位形态延续（文件名 + 原因两行，恢复指引由失败路径表承载）。**S4 验收留痕口径（终态同步 R1 显式声明）**：「链接 → 抽屉源码高亮」为基线行为恢复（file-type 分发与 DetailPane code 类高亮由既有单测承载），**不作独立真机重验**——v16 重验覆盖 A3a/A3b/A5/A8 + A6；产物目录文件场景的链接正向断言受基线 forceDiff 存量缺口阻断（`docs/todo/message-link-artifact-file-force-diff-reject.md`，A20 定性 = 基线存量机制、本分支零触碰），缺口修复后补验。

**依据**：用户裁决动机 = HTML 交付物在对话流内直接可见可交互，不经点击跳转（交互式图表/自包含组件的核心价值前置呈现）；ADR-0118 方案 A 本就预期「iframe 在 DOM 流内随滚动天然正确」，本裁决是该预期的终态化；已接受代价 = 对话流 turn 虚拟化使旧 turn 容器随滚动卸载/重挂载（脚本重执行，既有虚拟化行为的固有代价，实测无可感知卡顿阈值内）。

**登记**：设计文档 v16（`.tmp/tech-design/chat-html-support.md` §6.3/§6.4）；实施 = u7-inline-refactor 单元（M1.5 批次）；验收 = v16 重跑四项（渲染/观感/安全负面/降级矩阵）+ 打包态，全部通过（2026-10-04）。S4 相对链接场景随之重定义为「链接 → 抽屉源码态（基线行为恢复）」；链接打开产物目录文件被基线 forceDiff 通道拒绝的存量缺口另登记 `docs/todo/message-link-artifact-file-force-diff-reject.md`。

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

**删除判据**：删掉某机制后数据仍最终一致 → 它是补偿补丁，删；不一致 → 事件顺序契约本身未定义，先定义契约（谁的事实、谁推送、丢了如何补拉）再删。

**元原则**：原则面前无存量豁免——与本体系冲突的既往裁决一并推翻（已删：zcode 无进展检测双 timer、notify 看门狗重投、update 停滞检测、event-tail watch 族、structured-output 强制退出等，清单见 defense-mechanism-cleanup 登记）。

**保留白名单（原则不适用域）**：产品功能定时（调度/提醒/产品轮询能力）、调用方显式配置传入的超时参数、恢复场景的文件读取、锁语义原语、事件驱动的对账与拉取通道（ADR-0097 实现本体）、构建脚本类。

**依据**：本体系收敛自 pi 1.0 适配设计包交付后的系列裁决（2026-10-05）：命令终局事件化（handled/started/断连三事件）、投递 backoff 退役、全项目防御机制清查（约 270 处登记）、event-tail 退役与推送通道方向、受理层同步上屏、scheduler 切换对账翻转为事实查询。故障模型依据 = 本地进程通信无网络类瞬态失败面，对端死亡有 OS 级信号。

**登记**：清查清单与删改记录 = `docs/todo/defense-mechanism-cleanup.md` 与 `.tmp/dev-flow/defense-scan/`（四分区清单 + 改动清单）；投递域重构与推送通道设计 = `.tmp/tech-design/` 产出（过程产物，决策以本条与 cleanup 登记为准）；AGENTS.md「防御机制第一原则」规则条目为本条的规则面投影。原「时间平抑类逻辑红线」为本体系判定层的既有条目，继续有效。

### ADR-0128 subagent 流式通道 = 增量推送 + 按需拉取（2026-10-06 用户裁决，B2 设计裁决）

**决策**：subagent 流式输出通道（relay 路径）采用「chunk 增量消息（带 msgSeq/deltaSeq 双序号）+ 按需拉取收敛」——不做周期快照、不做攒批。拉取触发 = 接入（订阅建立/记录刷新发现运行中 record/流中首条 chunk 缺前缀）与失步（deltaSeq 跳号）两类事件；恢复源 = 新增 RPC `session.getSubagentStreamState` 读取 RelayTee 既有内存状态（当前 msgSeq / 已发 delta 数 / 累积全文），产生端不保留 delta 历史。响应携带水位（记录已处理到哪的位置标记：lastDeltaSeq，这份全文含到第几条 delta），消费端凭水位去重缓冲回放。形态对标 Kubernetes ListAndWatch（接入 LIST 全量 → WATCH 增量 → 失步重新 LIST）。

**要点**：
1. **ADR-0097 豁免**：分则「功能域禁止消费侧补充拉取」红灯由本通道触发豁免——拉取对象是既有内存状态的只读视图（非新建补偿状态）；失步在活连接上按传输契约（TCP 有序可靠 + transient 直传订阅者）不会发生，拉取触发源是连接生命周期事件与防御性检查，不是高频补偿路径；豁免范围仅限 subagent 流式通道。
2. **兼容窗口不设防**：npm 移动壳跨版本窗口内旧 renderer 收未知 chunk 静默忽略、无实时流显示，定稿 entry 照常——用户裁决移动壳尚无用户、renderer/runtime 同仓同发，不为兼容窗口保留冗余推送机制，亦不设移动壳冒烟义务。
3. **无时间窗逻辑**：失步修复与失败重触发均为事件驱动（跳号 / 下一条 chunk 到达），无周期快照、无重试定时器（ADR-0122）。
4. **周期快照制不采用**（本设计前一版形态，经对抗比较后裁决）：机制面最小且对旧 renderer 兼容窗口友好，但稳态多发约 9× 全文量字节、恢复延迟受快照间隔约束——与「恢复语义对齐现状量级」的长期合理性判据冲突。

**依据**：用户裁决「只做长期合理的方案，不做短期成本控制考量的方案」（2026-10-06）；拉取收敛与 ADR-0097「拉为主、推补充」直配，恢复源 = 同步查询（ADR-0122 状态判定来源最高优先级）。

**登记**：设计文档 `.tmp/tech-design/subagent-stream-chunk-design.md`（过程产物，不入库）；实施跨 shared / runtime / core / renderer 五包 + 本登记，清单见设计文档 §5。

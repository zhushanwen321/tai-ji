# ADR 0064：pi 语义吸收层（四支柱）

- 状态：Accepted
- 日期：2026-08-28
- 关联：[pi-boundary-reliability.md](../architecture/pi-boundary-reliability.md)（程序层设计全文 + 证据基线，本文的权威源）· [ADR-0063](0063-session-attachment-invariants.md)（session 附着不变量，pi 行为断言带锚点纪律的先例）· 切片 1 决策索引见权威源附录 D（派发域先行实例，原文档 2026-09-13 收编删除，git 可追溯）· [troubleshooting.md](../troubleshooting.md)「pi 行为观察项」（人读层，与机器登记 docs/pi-semantics.json 经 PS 编号互链）

## 背景

2026-08-27 同日两起事故，同一架构空缺的两次显形（细节与实证锚点见设计 §2，此处一句话级引用）：

- **事故 A（subagent 派发）**：扩展层模型精确匹配校验与 pi CLI pattern 模糊引擎互不知晓，models-store 刷新引入小写条目后被静默换模 429 空转；完成通知依赖 pi 内存队列 at-most-once 投递，十余次仅送达一次；终态一律坍缩为 `closedReason:"gc"` 无法判读。
- **事故 B（思考等级自动变关）**：前端本地推断档位（undefined 视为支持全档）与 pi 两级门控（reasoning 缺失 = off）语义相反，回执在协议层被映射为 void 后乐观写请求值，30s 轮询兜底把真值拉回——用户看到「过一会自己变关」。

共同根因：xyz-agent 与 pi 之间缺一层「语义吸收层」——对 pi 私有语义的本地推断散布多处、跨边界承诺无受理确认、语义依赖只有人读登记没有机器守卫（2026-08-20 登记的 thinking 钳制观察项 8-27 照样出事，登记≠防御）。

## 决策

四支柱（不确定性在边界一次性吸收，域内只剩确定性）+ 轮询精简准则：

### 一、能力注册表（登记 C-pi-12）

pi 能力事实（模型全等 id / reasoning / 实际支持思考档位）只在一个点进入域内：runtime `model-capability.ts`——离线用 pi-ai 同源函数计算（零影子实现），在线经 `get_available_models` RPC 对账（覆盖 models-store 刷新漂移），结果以 view-ready `supportedLevels` 下发，renderer/扩展禁止本地推断档位。守卫：CR review（review-arch-boundary）+ `diff-probe-thinking.mjs` 探针对账（pre-commit 触发式）。

### 二、生效回执（登记 C-pi-13）

改状态 RPC（setThinkingLevel / model.switch / plugin 通道等）reply 一律回 pi 实际生效值（pi 钳制时 ≠ 请求值），协议层禁把改状态 reply 映射为 void；消费方禁乐观写请求值，以回执写显示态。「请求-生效」零距离是协议级不变量。

### 三、确认式送达（登记 C-ext-19）

结果语义（终态/完成）的跨边界通知必须走持久账本 + 幂等键通道（session-delivery 账本 + settled 边沿 courier + notifyId 幂等，at-least-once），禁止新建依赖 pi 内存队列（steer/nextTurn/followUp）的 at-most-once 通道；交互式注入（steer/followUp）仅限非结果语义。生效口径：新代码即禁、存量列迁移切片（机器守卫 `check_subagent_channels.py`）。

### 四、漂移守卫（登记 C-proc-08）

对 pi 语义的依赖机器登记（`docs/pi-semantics.json`，PS-xx 条目 probe/observe 分型，唯一机器源；人读层 troubleshooting 观察项经 PS 编号互链）+ 探针测试族（静态直读 pi dist 断言，CI 凭证无关）+ 版本门禁（`check-pi-semantics.mjs`：四包版本一致 + verifiedWith 比对）。pi 升级从「语义假设批量过期无人知」变成「pre-commit/CI 红灯清单」，报错自带恢复动作。

### 五、轮询精简准则（D9，2026-08-28 增补）

「变化时对方会主动 push 的信息，禁止用周期 pull 兜底」——自有状态对账类定时器一律禁止（回执 + 事件失效是主链路，兜底轮询掩盖主链路 bug：事故 B 的 30s 轮询即反例，已随回执接通删除）；活性探测/外部世界类允许但须论证；判定准则人读版在 troubleshooting「周期轮询/兜底定时器的合法性判定」。

## 后果

- 正面：四条问题类判据（影子推断 / 无受理确认 / 写入时坍缩 / 漂移无守卫）被结构性消除——同类问题在 CI/pre-commit 红灯而非用户事故中显形；与既有治理设施（constraints.json / pre-commit / CI invariants / 观察项登记）同构对接，是升级执行面不是另起炉灶。
- 正面：C-pi-02（pi 语义断言权威源）由 review 级升级为机器执行面（登记 + 探针 + 版本门禁），ADR-0063 I4 的锚点纪律获得自动重验载体。
- 负面：runtime 引入 pi-ai 运行时依赖（打包纪律由 C-build-01 + validate-runtime-bundle 兜底）；探针族维护成本（pi 每次 bump 需重验 verifiedWith）；G4 通道禁则依赖白名单收敛误报面（扩白名单须给职责定性注释）。

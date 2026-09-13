# pi 边界可靠性：语义吸收层终态架构与同类事故防御体系

> **一句话结论**：2026-08-27 同日的两起事故（subagent 派发 429/gc、思考等级自动变关）不是两个独立 bug，而是同一个架构空缺的两次显形——**xyz-agent 与 pi 之间缺少一层「语义吸收层」**：对 pi 私有语义的本地推断散布在扩展/core/renderer 多处且互不知晓，跨边界承诺（派发、改状态、发通知）一律没有受理确认，对 pi 语义的依赖只有人读登记没有机器守卫。本设计从终态倒推四支柱（能力注册表 / 生效回执 / 确认式送达 / 漂移守卫）+ 一套硬校验护栏与治理更新，把「同类问题」从靠人肉排查变成 CI/pre-commit 红灯。落地分两个切片：切片 1（subagent 派发域）已有独立技术方案并通过一轮对抗式审查；切片 2（思考等级/模型能力域）决策在本文 D2-D4。

- **层声明**：架构程序层 → 下一层产物为各切片技术方案。切片 1 技术方案已实施交付（原独立文档已收编本文附录 D）；切片 2 规模小（runtime 一个服务面 + renderer 三处接线 + 表单一个字段），本文 D2-D4 已设计到可实施深度，不再单独出文档；护栏与治理（D6-D8）本身就是实施清单。
- **证据基线**：本文全部现状事实取自 2026-08-27 两次排查的实证记录与三轮独立代码核查（pi 实装 `@earendil-works/pi-coding-agent@0.84.1` / `pi-ai@0.84.1` / `pi-agent-core@0.84.1` dist 直读，均已 `npm ls` 核对版本；xyz-agent 侧文件:行号经 subagent 实读核对）。事故 A 基线 session：`~/.xyz-agent/pi/sessions/2026-08-27T10-58-34-533Z_01a042df-21a5-783d-890d-61e075514b9d.jsonl`。
- **切片关系**：切片 1 = 附录 D 决策索引（原独立设计文档 subagent-dispatch-reliability.md 已于 2026-09-13 收编删除，全文 git 可追溯）。本文不重述其细节，只引用结论。
- **审查记录**：本文经一轮对抗式审查（审查报告 pi-boundary-reliability.review.md 已删除，git 可追溯；3 must-fix + 8 suggestions；49 处事实抽查 47 命中 2 偏离），must-fix 已全部落盘修订，suggestions 全部吸收（含判据适用边界、事故 B 数据流图、多包版本门禁、verifiedWith 防线分层、缓存键补维、锚点修正）。
- **2026-08-28 增补（D9 轮询精简 + 附录 C）**：经 ZCode（打包版反混淆直读）与 deepseek-harness / opencode 源码对照调研后新增。增补项中的代码落地（plugin-host 30s 空转删除、flushAll 5s×2 删除、handoff 2s 事件化、更新检查 20min→60min、skill watch polling 降级化）已随当日提交完成并测试全绿；thinkingLevel 30s 轮询删除仍随 U6 落地。本增补为删减性质 + 全部带证据锚点，未再单走一轮对抗式审查。

---

## §1 背景目标

### SCQA

- **S（情境）**：xyz-agent 深度依赖 pi 黑盒——[MANDATORY] 不改 pi 源码、不 fork、不提 PR；pi 持续升级（0.80.3→0.84.1 已踩过 clone 漂移连产 4 条 bug 的坑），pi 的远端模型目录缓存（models-store.json）周期刷新。项目已有成熟的约束治理设施（constraints.json 76 条登记 + pre-commit 21 项检查 + CI invariants 门禁 + pi 行为观察项登记）。
- **C（冲突）**：2026-08-27 一天内两起同类事故：主 agent 派发后台 subagent，小写模型串被 pi pattern 引擎静默换成无权限模型 429 空转，完成通知十余次仅送达 1 次，终态一律显示 `gc` 无法判读；用户手动添加的 GLM 模型思考等级设「最高」后过一会自动变「关」。两起事故的排查都靠人海战术直读 dist 源码完成，而 thinking 档位钳制早在 2026-08-20 就已登记进 troubleshooting.md 观察项——**登记了照样出事**。
- **Q（问题）**：为什么同类问题会反复发生？什么样的终态架构能让「对 pi 语义的假设失效」在用户可见故障之前、在 CI/pre-commit 阶段就爆炸？
- **A（答案）**：四支柱边界架构 + 防御体系：能力注册表（pi 能力事实单点进入域内）、生效回执（改状态 RPC 一律回真值）、确认式送达（异步结果一律账本化）、漂移守卫（pi 语义依赖机器登记 + 探针测试 + 版本变更门禁），配一套落到 pre-commit/CI/vitest 具体挂载点的硬校验护栏和治理文档更新。

### 问题类定义（同类判据）

满足以下任一条即属本设计要消灭的问题类：

1. **影子推断**：xyz-agent 域内代码对 pi 私有语义做本地重新实现/推断（两条规则互不知晓，语义可能相反）。
2. **无受理确认**：跨边界承诺（校验通过、RPC 返回、send 成功）与「实际生效」之间没有可验证路径。
3. **写入时坍缩**：状态/语义在写入点坍缩或缺失（占位符、字段 undefined），下游多处各自推导补全。
4. **漂移无守卫**：行为随时间变化（pi 升级、models-store 刷新）而域内假设无人重验，用户成为报警器。

**适用边界（防 scope 扩大化）**：判据前置条件是「涉及 pi 私有语义或 xyz↔pi 跨边界承诺」；纯 xyz 域内 bug、与 pi 语义无关的 UI 缺陷不属本问题类。判定新事故是否同类时，须能指认具体的 pi 语义假设点——四条判据不是万能筐。

### 设计目标（从使用者体验倒推）

- **G1-G3（切片 1，subagent 派发域）**：派发即确定（模型零宽容）、通知必达（at-least-once + 幂等）、终态一眼可判（outcome 一等字段）。定义与验收见切片 1 文档，本文不重述。
- **G4 语义单一权威**：pi 的能力事实（模型全等 id、reasoning 能力、实际支持档位）只在一个点（runtime 能力注册表）进入 xyz-agent 域内；renderer/扩展禁止各自推断。「这个模型支持什么」有且只有一个答案来源。
- **G5 失效可检测**：任何对 pi 语义的依赖登记在机器可读清单并配守卫；pi 升级或依赖面变更时，失败发生在 CI/pre-commit，报错文案自带恢复动作——不再以用户事故的形式被发现。

### Scope

- **In-scope**：`packages/runtime`（能力注册表、回执链路、rpc-client 补齐）；`packages/shared`（协议类型）；`packages/core` / `packages/ui` / `packages/renderer`（档位可用集消费方切换、表单）；`docs/` 治理资产（constraints.json、troubleshooting.md、extension-conventions.md、TEST-STRATEGY.md、ADR）；`.githooks/` + `scripts/` + `.github/workflows/ci.yml`（护栏挂载）；切片 1 两个包按切片 1 文档。
- **Out-of-scope**：pi 上游（MANDATORY 不改）；renderer 模型清单数据源重构（当前用户配置聚合保持，注册表只做能力标注与对账，不重做清单来源）；~~20+ 处既有轮询定时器的全面整改~~（2026-08-28 增补：已由 D9 处置完毕——12 处逐项处置见附录 C，其中 5 项当日落地、1 项随 U6 删除，不再列 Out-of-scope）；GUI 模型管理面之外的 pi 能力面（bash/compact 等）的注册表化。

---

## §2 现状与问题分析

> 本章结论：两起事故各自的三层根因，逐条命中 §1 问题类判据；共同根因是「pi 语义吸收层」空缺——既有治理资产（C-pi-02 纪律、观察项登记）停在人读/review 级，没有机器守卫与接线，登记≠防御。

### 2.1 事故 A：subagent 派发（2026-08-27）

三个结构性根因（实证细节与数据流图见切片 1 文档 §2）：

- **F1 模型标识没有单一权威形态**（判据 1+4）：扩展层精确匹配校验 vs pi CLI pattern 模糊引擎（canonical 双命中判歧义 → contains 模糊 → `localeCompare` 取最大），两套规则互不知晓；「通过校验」不代表「子进程按此名执行」。models-store.json 周期刷新引入小写条目家族后，昨日可用的串今日掉进 `glm-5.3-highspeed` → 429 空转。
- **F2 通知 at-most-once 且无回执**（判据 2）：steer 落点是内存队列（pi-agent-core 全文仅 2 个 drain 点），nextTurn 队列唯一消费点是用户主动 `prompt()`；投递内核重试的是「send 函数调用」而非「消息进入主会话」这一事实。基线 session 十余次完成仅 1 次送达。
- **F3 终态语义写入时坍缩**（判据 3）：done/failed/crashed 统一坍缩为 `closed + closedReason:"gc"`，下游三处同构 switch 各自重新推导成败。

### 2.2 事故 B：思考等级自动变关（2026-08-27）

**现象**：GUI 手动添加的 `GLM-5.3`/`GLM-5.3-Flash`（大写 id），思考等级设「最高」后当时显示成功，过一会自动变回「关」。用户配置本身无错。

**三层根因叠加**（全部实读核实）：

1. **pi 两级门控**（判据 1 的被推断对象）：`pi-ai/dist/models.js:548` `if (!model.reasoning) return ["off"]`——reasoning 是能力总开关，thinkingLevelMap 只是开关打开后的档位映射；第一关不过任何档位钳回 off。
2. **写入时语义缺失**（判据 3）：GUI addModel 表单无 reasoning 输入项（`packages/ui/.../ModelListSection.vue` 全文无；`use-provider-edit.ts:546-561` addModel 只构造 id/name/contextWindow/input/thinkingLevelMap 五字段）→ 手动添加的模型落盘后 reasoning 永远 undefined → pi 判 off。**同一个 undefined，pi 解释为「关」，前端 `resolveAvailableLevels` 解释为「支持全档」**（`thinking-levels.ts:66-84` docstring 明写「undefined 视为 true」）——两侧对字段缺失的语义解释恰好相反。
3. **无受理确认 + 漂移兜底造成体感**（判据 2+4）：runtime 侧其实已经做对了——`session-service.ts:624-645` set 后 get_state 读出 clamp 后的生效值并经 `session.thinkingLevelSet` 回传（`settings-message-handler.ts:397-404` 注释明写「reply 生效值而非请求值」）；但 `protocol.ts:1681` 把该 reply 类型映射为 `void`，`useModel.ts:68` 拿到 `Promise<void>` 后只能乐观写请求值。30s 周期兜底重拉（`replicated-states.config.ts:57-59`）把真值 off 拉回——于是用户看到「过一会自己变关」。**思考从第一次请求起就真是关的**，回执链路只差 renderer 最后一跳。

**事故 B 物理数据流（三进程 Journey，★=失真点）**：

```
 用户 GUI 添加模型 GLM-5.3-Flash（思考策略选 high-max）
   │  addModel 构造五字段、无 reasoning            ★B1 写入时语义缺失
   ▼
 models.json 落盘 { thinkingLevelMap:{off,high,max:xhigh}, reasoning: undefined }
   │
 composer 选「最高(max)」：resolveAvailableLevels 把 undefined 视为支持 → 显示可选
   │                                                ★B2 影子推断（与 pi 语义相反）
   │  WS session.setThinkingLevel
   ▼
 runtime session-service → pi set_thinking_level
   │  pi 两级门控：!reasoning → ["off"] → 实际生效 off
   │  runtime set 后 get_state 读出 effective=off → reply 已携带生效值 ✅
   ▼
 renderer protocol.ts 该 reply 类型映射 void → 生效值被丢弃
   │                                                ★B3 受理确认断在最后一跳
   │  useModel 乐观写请求值 max → UI 显示「最高」（假值）
   ▼
 30s 周期兜底重拉 get_state → 真值 off 覆盖显示
   → 用户看到「过一会自己变关」（B4：轮询兜底成了唯一的真相来源）
```

**本次摸底的两个决定性新事实**（改变修复形态）：

- **pi RPC 有能力面**：`get_available_models`（`rpc-mode.js:380-382`）返回 `{ models: Model[] }`，Model 含 `reasoning: boolean`（pi-ai `types.d.ts:667`）与 `thinkingLevelMap`（:672）；`get_available_thinking_levels`（:398-400）返回当前模型档位集。xyz runtime 的 rpc-client 从未封装调用（零命中）。renderer 的模型清单与档位可用集完全来自用户配置聚合（`provider-config-helper.ts:268-373` 聚合 models.json ∪ builtin-providers.json ∪ extras；runtime 无任何读 pi 合并清单的代码；档位由 `model-thinking.ts:144-152` 读 config 值 → `ThinkingLevelPopover.vue:101-104` 本地推算），**全程不经 pi**。
- **差分探针已有雏形**：`scripts/diff-probe-thinking.mjs` 直接 import pi-ai 的 `getSupportedThinkingLevels` 与 xyz 的 `resolveAvailableLevels` 逐模型比对——证明 runtime 侧可以零复制地复用 pi-ai 同源函数；但该脚本无任何自动调用方（不在 package.json scripts、CI、hook）。

### 2.3 同构性论证：四条判据逐条命中

| 判据 | 事故 A（subagent） | 事故 B（思考等级） |
|---|---|---|
| 1 影子推断 | 扩展 model-resolver 精确 find vs pi pattern 引擎（选择规则互不知晓） | `resolveAvailableLevels`（undefined=支持）vs pi 两级门控（undefined=off），语义恰好相反 |
| 2 无受理确认 | 校验通过 ≠ 按此名执行；send 成功 ≠ 消息存在 | RPC 返回 ≠ 生效（effective off 被 void 丢弃）；表单保存 ≠ 字段存在（reasoning 静默缺失） |
| 3 写入时坍缩 | `closedReason:"gc"` 占位，三处同构推导 | reasoning 字段不写即 undefined，两侧按相反语义补全 |
| 4 漂移无守卫 | models-store 19:20 刷新 → 昨日成功今日 429 | thinking 钳制 2026-08-20 已登记观察项 #4，无接线，8-27 照样出事 |

### 2.4 根因：缺「pi 语义吸收层」，登记≠防御

既有治理资产覆盖的是「知道」而不是「防御」：C-pi-02 规定「pi 语义断言权威源 = node_modules 实装版」但 enforcement 只有 review；troubleshooting.md「pi 行为观察项」以标准格式登记了 5 条 pi 私有语义风险（含 thinking 钳制），但没有任何机器检查在「假设失效」时报警。EventAdapter 被声明为「pi 协议唯一适配点」（C-comm-04），但它只适配传输格式；**语义适配（这个模型支持什么、这条消息是否真的会到达、这个状态是否真的生效）散布在扩展、core、renderer、runtime 多处，无登记、无守卫、pi 升级时无人知道哪些假设已过期**。两起事故的排查成本（人海直读 dist）正是这层空缺的价格。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**主 agent 派发体验**（切片 1，引用）：模型入参非全等 → start 同步期拒单 + 问句式纠错候选；放行即全等回显；完成通知最迟当前 run 结束后一个 settled 边沿必达；list/通知里 outcome 直接可读 completed/failed/cancelled。

**用户设置思考等级体验**（切片 2）：

```
设置页添加模型 GLM-5.3-Flash，思考策略选「high-max」
  → reasoning 字段随表单自动写入 true（不再静默缺失）
  → 档位预览由 runtime 用 pi-ai 同源函数算出 [off, high, max] 随模型信息下发

composer 思考等级选「最高」
  → runtime 转发 pi → pi 钳制（如有）→ 回执携带生效值
  → UI 显示的是 pi 实际生效档位；若被钳（如 mimo 族设 max → high），
    UI 显示 high 而非 max——所见即真值，不存在 30s 后「自己变回去」

对 reasoning=false 的模型，档位选择器只有「关」可选（置灰其余），
  与 pi 行为构造性一致——不存在「选了但 pi 不认」的窗口
```

**维护者视角**（防御体系）：

```
pi 版本 bump PR → pre-commit/CI：check-pi-semantics 发现 verifiedWith ≠ 实装版本
  → 红灯，报错列出须重验的语义条目与对应探针测试命令
  → 逐条跑探针（静态直读 dist + 行为断言），全绿后更新 verifiedWith 即过

models-store 远端目录刷新引入大小写孪生条目
  → 切片 1 孪生守卫在 start 同步期拒单并报「registry 含歧义大小写变体」
  → runtime 能力注册表对账（get_available_models vs 配置聚合）记录 drift 日志

有人新写代码用 deliverAs:"steer" 发终态通知 / 新增改状态 RPC 不回生效值
  → pre-commit 通道禁则检查 / CR 约束（C-ext-19 / C-pi-13）拦截
```

### 3.2 方案对比

**程序级**（怎么防同类问题）：

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **P-absorb 语义吸收层四支柱 + 护栏（选）** | 不确定性在边界一次性吸收，域内只剩确定性；消的是问题类而非病例；与既有治理设施（constraints.json / pre-commit / CI invariants / 观察项）同构对接，是「升级执行面」不是另起炉灶 | 两个切片 + 护栏基建，约 1-1.5 周量级，可分单元交付 | 能力注册表引入 runtime→pi-ai 直接依赖（打包纪律已有 C-build-01 + validate-runtime-bundle 兜底）；护栏误报面需按 §3.3 D7 逐条设计收敛 |
| P-patch 逐事故补丁 | 无结构变化 | 每起事故最小 diff | 问题类原样保留：下一处影子推断/无回执通道继续繁殖；排查成本每次都由用户和人肉支付（8-20 登记观察项、8-27 照样出事即为实证） |
| P-fix-pi 改 pi / fork | 上游修了才是最「根本」 | — | 违反 [MANDATORY] 纪律；fork 维护成本与升级脱节，已否决（切片 1 D3 同款结论） |

**切片 2 域：能力注册表形态**：

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **CR-hybrid 同源函数离线计算 + pi RPC 在线对账（选）**：runtime 引入 `@earendil-works/pi-ai` 依赖，用 pi 自己的 `getSupportedThinkingLevels(model)` 对配置模型算档位（离线可用、与 pi 逐字节同语义——diff-probe-thinking.mjs 已实证可 import 可用）；session 附着后经 `get_available_models` RPC 取 pi 合并清单对账（覆盖 models-store 刷新引入的漂移）；结果以 view-ready 字段随模型信息推 renderer（符合 C-data-03「投影只发生一次」），`resolveAvailableLevels` 退役 | pi 语义只有一个实现副本（pi-ai 自身），xyz 侧零影子逻辑；pi 升级时语义自动跟随（限单包同步 bump 场景；多包版本一致性由 D6 门禁机器保证——防 runtime 内嵌 pi-ai 与 pi 子进程静默分裂），配 D6 版本门禁双保险 | runtime 加依赖 + tsup noExternal + 打包验证（既有纪律流程）；modelService 加一个服务面；renderer 三处接线 | ⛔ pi-ai 在 runtime CJS bundle 下的可用性须实测（diff-probe 仅在 node ESM 下验证过）——实施期门，降级路径 = 退化为纯在线 RPC 对账 + 设置页仅在任一 session 存活时可编辑档位（可用性妥协，语义保真不变） |
| CR-align 前端语义对齐修补（把 resolveAvailableLevels 的 undefined 分支改得跟 pi 一致） | 影子实现原样保留：pi 哪天改门控顺序/加第三级，前端同步漂移；恰恰复刻判据 1+4 | 几行 diff | 长期架构最差——今天修的就是这个模式本身 |
| CR-rpc-only 纯在线（只靠 get_available_models，不引入 pi-ai） | 无新依赖 | 设置页/无存活 session 时无 pi 进程可查（短命进程方案有 C-pi-10 withEphemeralPi 先例但每次起进程成本高）；models-store 未刷新时与配置编辑场景错位 | 可用性缺口真实存在；对账仍是单源，配置态与运行态谁权威要再发明规则 |

**切片 2 域：回执**：

| 方案 | 长期架构 | 短期成本 | 风险 |
|---|---|---|---|
| **EC-echo 回执接通（选）**：`protocol.ts:1681` ReplyPayloadMap 从 `void` 改为 `{ sessionId, level }`（runtime 本就在回传），useModel 弃乐观写、消费 effective；并上升为通用约束「改状态 RPC 一律回生效值」（登记 C-pi-13） | 「请求-生效」零距离成为协议级不变量；乐观写反模式被规则化禁止 | 类型 + 两个消费点的小 diff | 其他改状态 RPC 需普查（实装命令名为 model.switch 与 plugin 通道——设计初稿误写 setModel/cycleModel，实装无此二名），普查清单列 U6 |
| EC-keep 保持乐观写 + 轮询兜底（现状） | 30s 窗口内显示假值是构造性的 | 零 | 事故 B 的体感来源原样保留 |

### 3.3 关键决策与权衡

**D1：四支柱总览——边界吸收不确定性，域内只剩确定性（选定）**

| 支柱 | 一句话 | 归属 | 对应切片/单元 |
|---|---|---|---|
| 能力注册表 | pi 能力事实（模型全等 id/reasoning/支持档位）单点进入域内，离线同源计算 + 在线 RPC 对账 | runtime modelService | U5（切片 2）；切片 1 U1 的全等裁决消费同一注册表语义 |
| 生效回执 | 改状态 RPC 一律回 pi 实际生效值，消费方禁乐观写请求值 | shared 协议 + runtime + renderer | U6（切片 2）；切片 1 的 start 全等回显是同原则实例 |
| 确认式送达 | 异步结果一律「持久账本 + at-least-once + 幂等键」，禁新建依赖 pi 内存队列的 at-most-once 通道 | session-delivery + 扩展 | 切片 1 U2 为第一实例；通用化约束登记 C-ext-19 |
| 漂移守卫 | pi 语义依赖机器登记 + 探针测试族 + 版本变更门禁 | docs/pi-semantics.json + scripts + runtime 测试 | U7 |

- **被否**：四支柱各自的最小替代品均已在上表域级对比中否决（影子对齐/乐观写/at-most-once 分流/人读登记）。
- **证据**：§2 两起事故四条判据命中表；四支柱分别对应判据 1/2/3-4 的结构性消除。
- **效果**：G4/G5 的载体；切片 1 的三项改造是同一原则在 subagent 域的先行实例化。

**D2：能力注册表 = runtime 单点服务面，离线同源 + 在线对账（选定）**

- **采用**：runtime modelService 新增能力面（实现形态：新模块 `packages/runtime/src/services/model-capability.ts` 挂入 modelService）。①**离线计算**：引入 `@earendil-works/pi-ai` 依赖（版本与 pi-coding-agent 锁同 0.84.1），对配置聚合清单的每个模型调 pi 同源 `getSupportedThinkingLevels({reasoning, thinkingLevelMap, ...})` 算出支持档位——reasoning 缺失的模型得到 `["off"]`，与 pi 行为逐字节一致；②**在线对账**：session 附着后调 `get_available_models`（rpc-client 需新增封装）取 pi 合并清单，与配置聚合比对（配置有而 pi 无 / reasoning 不一致 / 大小写孪生检出），drift 项记 runtime 日志 + 事件上报；③**下发**：`ProviderInfo.models[]` 增加 view-ready 字段 `supportedLevels`（runtime 算好，renderer 零推导），composer 档位选择器与 ThinkingLevelPopover 改读它。缓存键 = pi 版本 + models.json mtime + builtin-providers.json mtime（发版更新内置目录而用户配置不变时，档位不得陈旧）；在线对账结果不缓存落盘（每附着一次对一次）。**格局声明**：pi 系包此前刻意保持「根 package.json 声明、runtime 不可 import」（pi-paths-config-dir-contract.test.ts 头注自述）——本决策是该格局的首次反转，runtime 由此出现 pi 系包运行时依赖；`packages/runtime/package.json` 的 pi-ai pin 与根 pin 的双副本一致性不能靠 pnpm（多版本共存合法、frozen-lockfile 不报错），由 D6 版本门禁的多包一致性校验兜底。
- **被否**：CR-align / CR-rpc-only（见 §3.2）；❌ renderer 继续读 config 字段自算——影子推断正是判据 1 本体。
- **证据**：✅ pi-ai `getSupportedThinkingLevels` 可 import 且行为权威（diff-probe-thinking.mjs:16-18 实证）；✅ `get_available_models` 存在且属性面含 reasoning（rpc-mode.js:380-382，pi-ai types.d.ts:667/672）；✅ renderer 当前纯配置推算链路（model-thinking.ts:144-152 → ThinkingLevelPopover.vue:101-104）；✅ 内置目录 1220 个模型 100% 自带 reasoning+thinkingLevelMap（审查期实测）——「D2 上线致 builtin 模型批量变仅关」的攻击面不存在，用户手加模型缺 reasoning 显示「仅关」是 P-S5 覆盖的预期行为；⛔ **实施期门 P-C1**：pi-ai 打入 runtime CJS bundle 后行为等价（§5 检查点含体积阈值与版本一致性断言；失败降级见 §3.2 CR-hybrid 风险栏）。
- **效果**：G4；同时消灭判据 1（同源函数无影子）与判据 4 的模型能力面（对账 + D6 版本门禁）。

**D3：生效回执接通并上升为协议约束（选定）**

- **采用**：① `packages/shared` protocol.ts 把 `session.setThinkingLevel` reply 从 `void` 改为 `{ sessionId, level }`（runtime 侧 `settings-message-handler.ts:397-404` 已在回传 effective，无需改）；② `useModel.setThinkingLevel` 删除乐观写（useModel.ts:68），消费回执值；③ renderer 档位可用集改读 D2 下发的 `supportedLevels`，`resolveAvailableLevels`（thinking-levels.ts）连同「undefined 视为 true」语义一起删除——它存在的唯一理由是前端自算，理由消失后保留即漂移源；**删除边界严格限于 resolveAvailableLevels 及其调用方**——同文件其余导出（resolveThinkingKey/resolveThinkingValue/highestAvailableLevel/isSameThinkingScheme 等共 9 个）是 xyz 自有的 UI 档位↔请求值映射协议，不是 pi 语义影子，全部保留（renderer shim `panel/thinking-levels.ts`、core index re-export、thinking-level-sync.ts、Popover 的 resolveThinkingKey 调用均不动）；④ 普查同族改状态 RPC（实装命令名：model.switch 与 plugin 通道——无 setModel/cycleModel，同口径入口 plugin-rpc-setup.ts），凡 reply 为 void 的改状态命令一律补齐生效值回执；⑤ 登记约束 C-pi-13，CR 维度 review-type-safety 把「改状态 RPC reply=void」列为拦截项。
- **被否**：保留乐观写 + 缩短轮询周期——窗口只是变小不是消灭，且轮询越密成本越高，方向相反；❌ 让 pi 改 set_thinking_level 返回 data——不改上游。
- **证据**：✅ 回执链路现状（session-service.ts:637-644 set→get_state→effective→return；protocol.ts:1681 void；useModel.ts:66-69 乐观写）；✅ pi 侧响应确实无 data（rpc-mode.js:387-389），runtime 的 set+get_state 补读已是唯一正确姿势且已实装。
- **效果**：事故 B 的判据 2 环闭合；「过一会自己变关」的体感构造性消失（显示值从第一毫秒起就是真值）。

**D4：addModel reasoning 显式化（选定）**

- **采用**：① ModelListSection.vue 表单加 reasoning 开关，默认按思考策略自动推导（选非 all-levels 策略 → 自动置 true，用户可显式关）；② use-provider-edit.ts addModel 构造字段加 reasoning（显式 boolean，不再允许 undefined 出厂）；③ save/写盘白名单已支持 reasoning（`provider-config-helper.ts:584-589` `!== undefined` 判定），无需改 runtime 写侧；④ 存量数据不修（用户手工补 models.json 的临时方案已由排查给出），但 D2 注册表上线后，reasoning 缺失模型的档位 UI 会正确显示「仅关」，误导面被构造性消除。
- **被否**：表单不加字段、只在文档里提醒用户手工补——把系统缺陷转嫁给用户纪律，判据 3 原样保留；❌ 强制扫存量 models.json 自动补写——静默改用户配置，违反零宽容同族原则。
- **证据**：✅ addModel 五字段（use-provider-edit.ts:546-561）、表单无 reasoning（ModelListSection.vue 全文件）、写盘白名单已含 reasoning（provider-config-helper.ts:584-589，「GUI 再保存会抹掉手工字段」的担忧不成立——白名单回传，不抹）。
- **效果**：新添加模型不再携带「无主的隐式语义」出厂；与 D2 合起来，判据 3 在模型能力域闭合。

**D5：确认式送达通用化——at-most-once 内存通道禁止用于结果语义（选定）**

- **采用**：切片 1 的 B-ledger（账本 + settled 边沿 courier + notifyId 幂等）是确认式送达的第一实例；本决策把原则通用化并登记约束 C-ext-19：**任何「终态/结果」语义的跨边界通知（subagent 完成、scheduler 触发、未来 webhook）必须走持久账本 + 幂等键通道（session-delivery），禁止新建依赖 pi 内存队列（steer/nextTurn/followUp）的 at-most-once 通道**。event handler 的即时消息注入（sendUserMessage steer/followUp，extension-conventions :130-152 的合法交互手段）不在禁令内——禁令对象是「结果语义的一次性通知」，不是交互式 steer。**存量口径（按审查修正）**：scheduler 的触发注入现状底层即 `deliverAs:'steer'/'followUp'`（extensions/universal/scheduler/src/index.ts:97-99——虽已用 session-delivery 投递内核，但无账本、无幂等键），按本口径属违规存量。C-ext-19 生效口径为「**新代码即禁、存量列迁移切片**」：scheduler 账本化迁移登记为附录 B 待办（后续切片，复用切片 1 U2 的账本设施）；迁移合入前 G4 禁则不扫 scheduler 目录（避免无承载红灯），迁移单元合入时同步扩面。
- **被否**：通用化到「所有消息都走账本」——交互式 steer 的语义就是「尽量插入当前思考流」，账本化反而制造重复注入；禁令必须精确对准结果语义。
- **证据**：切片 1 §2.2 F2 三条丢失路径全实证；extension-conventions 既有 deliverAs 条文（:141-148）。
- **效果**：判据 2 在异步通知域的规则化；未来新扩展不会再凭直觉踩进 steer 窄窗。

**D6：漂移守卫体系——pi 语义依赖的机器登记 + 探针 + 版本门禁（选定）**

- **采用**：三层——
  1. **登记层**：新增 `docs/pi-semantics.json`（机器可读）。条目 schema：`{ id: "PS-xx", claim, piAnchor: [{pkg, distPath, symbol, note}], guard: {type:"probe", test:<路径>} | {type:"observe", note:<处置>}, verifiedWith: "0.84.1" }`。初始内容 = 附录 A（两起事故 + 既有观察项 5 条全部收录，probe/observe 分型）。人读层保留在 troubleshooting.md「pi 行为观察项」，二者经 id 互链（观察项正文引 PS 编号），不双写机制描述（json 是唯一机器源，md 是人读处置建议）。
  2. **守卫层**：新增 `scripts/check-pi-semantics.mjs`（零依赖 node，✗ file:line 明细 + exit 0/1，同 check-extension-dependencies.mjs 范式）：① registry schema 合法；② 每条 guard.probe 指向的测试文件存在；③ **版本门禁（多包一致性，按审查修正）**——先校验四者全等：pi-coding-agent 实装版本 === pi-ai 实装版本 === pi-agent-core 实装版本 === `packages/runtime/package.json` 的 pi-ai pin（读 node_modules 各包 package.json + runtime package.json）；任一不等 → 失败，报错列出不一致项与恢复动作（「同步 bump 各 pin 后重装并重跑探针」）。四者一致但与条目 verifiedWith 不等 → 失败，报错列出待重验条目与重验命令（跑探针族，全绿后批量更新 verifiedWith）。verifiedWith 保持单值（pi-mono 三包同步发版），附录 A schema 不变。**防分裂的关键性**：pnpm 允许多版本共存且 frozen-lockfile 不报错——pi bump PR 漏改 runtime pin 时，离线计算与探针 import 旧版 pi-ai、pi 子进程已是新版，判据 1 会在守卫眼皮底下复活；单包门禁对此全程绿灯，故多包校验是必选项而非增强项。
  - **防线分层声明（防橡皮图章）**：verifiedWith 是提醒机制，探针族（CI 自动跑，与 verifiedWith 取值无关地红）才是机器防线——「顺手全改 verifiedWith 不跑探针」在探针覆盖到的语义上仍然红；剩余盲区 = probe 误分型（语义实际由非 dist 代码决定却被标成 probe，双防线同废），由 P-D1 分型评审与 review 纪律兜底。可选软门禁（本期内建）：check-pi-semantics 读 staged diff，`verifiedWith` 变更行数超阈值且无探针文件变更时输出 WARN（不阻断）。
  3. **探针层**：新增 `packages/runtime/src/infra/pi/__tests__/pi-semantics-*.test.ts` 探针族，仿 `pi-paths-config-dir-contract.test.ts` 范式（静态直读 pi dist 做行为契约断言，dist 不可达时 skip 不 fail，不进 REAL_PI_TESTS 池，CI 凭证无关可跑）。每个 probe 型条目对应一个断言文件。另把既有 `scripts/diff-probe-thinking.mjs` 接线自动化（见 D7-G3）。
- **被否**：只扩充 troubleshooting 观察项不配机器守卫——2026-08-20 登记 thinking 钳制、8-27 照样出事，人读登记无防御力已被实证；❌ 「只在 pi 版本 bump PR 人工跑脚本、不挂 pre-commit/CI 门禁」——人工纪律无效即上述同一实证，且探针是纯静态读 dist（毫秒级），省下的成本可忽略，否；~~每次提交全量跑探针~~ 不构成负担（毫秒级），挂总闸。
- **证据**：✅ 探针范式先例（pi-paths-config-dir-contract.test.ts 头注 :16-32）；✅ 守卫测试防漏登记先例（session-manager-e2e-fixture-unit.test.ts:29-78 双向 diff）；⛔ 实施期门 P-D1：附录 A 中标注 probe 的条目逐条写出可行断言（个别条目如「localeCompare 取最大」只能静态断言代码形态而非行为——允许降级为「锚点存在性 + 关键代码片段哈希/正则」断言，失真即红）。
- **效果**：G5 的直接载体；pi 升级从「语义假设批量过期无人知」变成「PR 红灯清单」。

**D7：硬校验护栏清单（选定；全部落到具体挂载点）**

| # | 护栏 | 类型 | 挂载点 | 落地要点 |
|---|---|---|---|---|
| G1 | `check-pi-semantics.mjs`（D6 守卫层） | machine | pre-commit 总闸（install-hooks.sh heredoc，i18n 段后插入，**不设独立 SKIP_\*** 遵循 R1 后惯例）+ CI `invariants` job 等价一步 | 新增 scripts/ 脚本 + docs/pi-semantics.json；constraints.json 登记 C-proc-08 |
| G2 | pi 语义探针测试族 `pi-semantics-*.test.ts` | machine | `packages/runtime` vitest 主池（不进 REAL_PI_TESTS）；CI `test-runtime` 自动覆盖（凭证无关） | 仿 pi-paths-config-dir-contract.test.ts；初始覆盖附录 A 全部 probe 条目 |
| G3 | `diff-probe-thinking.mjs` 接线 | machine | pre-commit：staged 含 `thinking-levels.ts` / `use-provider-edit.ts` / `builtin-providers.json` / `model-capability.ts` 时触发；CI invariants 同步 | U6 删除 resolveAvailableLevels 后，探针比对对象改为「registry 计算路径 vs pi-ai 同源函数」（防 registry 自身漂移），脚本改目标不退役 |
| G4 | subagent-workflow 通道禁则 | machine | pre-commit（staged 为 `extensions/universal/subagent-workflow/**` 时）：禁 `deliverAs:\s*["'](steer\|nextTurn)["']` 出现在 courier 模块白名单（U2 落地后 = `execution/notify-ledger.ts` 单文件）之外；禁 `"--model"` 字面量出现在 `shared/model-ref.ts` / `session-runner.ts` 白名单之外；测试文件中的模拟串按白名单注释豁免（实施细节） | 实现为新的 `.githooks/check_subagent_channels.py`（exit 0/2 范式）；切片 1 U1/U2 合入后启用，避免过渡期红；扫描面扩到 scheduler 目录的时机绑定 D5 存量口径（scheduler 账本化迁移单元合入时同步扩面，见附录 B 待办） |
| G5 | real-pi 对账用例 `thinking-level-effective-e2e.test.ts` | machine | REAL_PI_TESTS 池（须登记进 `packages/runtime/vitest.config.ts:22-34`，守卫测试强制）；开发机跑（凭证门控 REAL_PI_READY） | 真实 pi：reasoning:false 模型 set high → 断言回执=get_state=off；正常模型 → 回执=请求值。这是「config ≡ pi effective」的端到端保险丝 |
| G6 | 改状态 RPC reply=void 拦截 | review | constraints.json 登记 C-pi-13，dimensions: type-safety（review-type-safety agent 消费）；protocol.ts 改状态区段加注释指约束 | 机器化（静态判定「改状态」语义）不可靠，诚实停在 review 级 |
| G7 | constraints.json 四条新登记 | governance | C-pi-12（能力注册表单点，authority=本文 §3.3 D2 + 未来 ADR-0064）、C-pi-13（生效回执，authority=本文 D3）、C-ext-19（确认式送达，authority=本文 D5 + extension-conventions 新增节）、C-proc-08（漂移守卫，authority=本文 D6） | enforcement 的 machine hook 必须真实存在才可通过 render-constraints 校验——**登记与对应护栏同 commit 或护栏先行** |

- **护栏设计通则**：全部机器护栏遵循既有范式（python 检查器 `.githooks/check_*.py` exit 0/2；node 检查器 `scripts/check-*.mjs` exit 0/1 + ✗ file:line 明细 + 报错自带恢复动作）；新增检查一律不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）；CI 侧挂 `invariants` job 作为「本地 hook 被绕过时的等价拦截点」（ci.yml:312-425 既有模式）。注意 ci.yml:3-17 paths-ignore 含 `docs/**`——pi-semantics.json 变更单独不触发 CI，靠 pre-commit 与「pi 版本/探针文件变更触发 CI」覆盖，登记为已知边界。
- **被否**：给每条新护栏配独立 SKIP_*——逃生口繁殖正是既有纪律要收敛的（install-hooks.sh:649-650 注释）；❌ 把 G4/G6 做成全仓 grep 一刀切——交互式 steer 与合法 --model 拼装存在，误报面必须靠白名单收敛。

**D8：治理与文档更新清单（选定）**

AGENTS.md 文档索引涉及的资产，逐一定性「改/不改/怎么改」：

| 文档 | 动作 | 内容 |
|---|---|---|
| `docs/constraints.json`（+`render-constraints.mjs` 重生成 md） | **改** | 新增 C-pi-12/C-pi-13/C-ext-19/C-proc-08（见 D7-G7）；顺带修既有漂移：C-build-01 的 scope 含精确路径 `tsup.config.ts`，而实装文件在 `packages/runtime/tsup.config.ts`（另 packages/extension-protocol、session-delivery 各一），按 select-constraints 全等匹配规则该 scope 永不命中——改为 `packages/**/tsup.config.ts` 不支持（glob 只允许 `<prefix>/**`），故改 scope 为三个精确路径全列 |
| `docs/adr/0064-pi-semantic-absorption-layer.md` | **新增** | 按 ADR-0063 模板（H1 + 状态/日期/关联 bullet + 背景 + 决策条）记录四支柱决策；authority 供 C-pi-12/13 引用 |
| `docs/TROUBLESHOOTING.md` | **改** | 「pi 行为观察项」5 条既有条目加 PS 编号互链；新增观察项：pattern 引擎大小写选择（PS-01）、reasoning 总开关（PS-02）、set_thinking_level 无 data（PS-03）、steer/nextTurn 消费窗（PS-05/06）、settled 复位序（PS-07）、appendEntry custom 不进上下文（PS-09）；「历史排查规则」新增 2 条：① `closedReason:"gc"` 是统一终态占位非故障（判读指引）；② 模型名大小写漂移致 429（昨天能用今天炸的排查路径） |
| `docs/extensions/extension-conventions.md` | **改** | 新增「模型引用解析 [MANDATORY]」节：扩展域内字符串→模型身份只允许经 `shared/model-ref.ts assertCanonicalModelRef`（切片 1 U1 产物）；禁裸串拼 `--model`；「Event handler 消息注入」节补「可靠性分级」段：结果语义通知必须走 session-delivery 账本通道（引 C-ext-19），交互注入（steer/followUp）仅限非结果语义 |
| `TEST-STRATEGY.md` | **改** | §4 回归基线表加一行（pi 语义守卫探针族，来源=本事故对）；「等价性测试双轨」节登记 G5 用例归属（完整基线/凭证机）；文末按惯例追加 topic 段 `[from: pi-boundary-reliability]` |
| `docs/extensions/logging-conventions.md` | **改**（轻量） | delivery warn 出口接 extensionLogger 的口径一句（切片 1 U4 对接点） |
| `docs/architecture/context.md` + `docs/extensions/glossary.md` | **改**（轻量） | 术语各加 4 条：语义吸收层 / 能力注册表 / 生效回执 / 确认式送达（账本·销账·courier 归并后者） |
| workspace `AGENTS.md` | **改**（最小） | 文档索引表加一行本设计；「外部依赖 pi」段加一句指向 C-proc-08 版本门禁纪律（不新增大段规则，约束细节活在 constraints.json） |
| `docs/architecture/feature-map.md` | **按既有纪律** | 启动本 Phase 时更新地图（滚动快照；原 `docs/feature-map/` 目录已并入，git 可追溯） |
| `docs/design-evolution.md` | **不改** | UI 视觉设计专用，架构演变归 ADR |
| `docs/release-notes.md` | **不改** | 写作规范文档；发布时按规范撰写即可 |
| `docs/extensions/development-guide.md` | **不改** | 通用开发流程，无涉本主题 |

**D9：轮询/兜底定时器精简——只保留「push 结构性不可用」的探测（选定；2026-08-28 增补）**

- **采用**：以「信息变化是否有 push 通道？无 push 是结构性的还是偷懒？」为判定准则，对全部驻留周期定时器做处置（逐项清单与证据见附录 C）：①**自有状态对账类**（变化 100% 经我方请求/事件路径）禁止周期轮询，正确机制是回执 + 事件失效——thinkingLevel 30s 兜底轮询在 U6 回执接通后**删除**（非降频）；②**活性探测类**保留，但后续优先「升级式触发」（事件静默超时再探）替代无条件周期；③**协议规定 pull**（OAuth 设备码）保留，参数须合规（服务端 interval + slow_down +5s——已核实 device-code-flow.ts 合规，未改）；④**外部信息类**（更新检查）降频到与下游缓存同档（20min→60min，已落地）；⑤**有事件通道却用轮询**（handoff 2s 轮询 exited）事件化（已落地）；⑥**无消费者空转**（plugin-host 30s 刷 lastActiveAt）与**防假设性 bug 的写穿兜底**（sessionData/recent-workspaces 5s flushAll）删除（均已落地）。
- **被否**：全部保留现状（「事件为主、轮询兜底」哲学）——对照调研证明它被滥用为「不信任主链路的代偿」：ZCode 无引擎探活/无 WS 心跳/无 /health 轮询，deepseek-harness runtime 核心仅 1 个 setInterval，两者靠「被动信号 + 有界预算 + 便宜重建」达到同等可靠性；❌ 一刀切全删——pingPi 覆盖的 pi 半死态（ADR-0047 实证）与 WS 心跳（WS 通道必需）是真实需求，pi 无 stream_idle_timeout 类自报能力。
- **证据**：附录 C 对照表（含 ZCode/DSH/opencode 逐项 file:line 锚点）；pi 侧源码实证 `setThinkingLevel` 状态真变必发事件（agent-session.js:1280-1299，isChanging=false 仅在值未变时不发，不构成对账缺口）；fs.watch 缺陷复测（2026-08-28，Node v24.11.1 / macOS 25，已 watch 目录下 10 轮「新建子目录+写文件」21/21 事件到达，nodejs/node#52601 不再复现）；rpc-client onExit 已多播（rpc-client.ts:144 注释自述单槽历史）。
- **效果**：驻留周期定时器从 12 处收敛到 4 处保留 + 2 处待改造（附录 C 全清单），每处都有「为什么 push 不可替代」的登记答案；新增定时器按 troubleshooting.md「周期轮询/兜底定时器的合法性判定」过闸。

### §4 验收

以下场景全部真实环境（xyz-agent GUI + 真实 pi 0.84.1 + 真实 LLM 后端 + 真实文件系统），无 mock。切片 1 验收 S1-S5 沿用切片 1 文档 §4，不在此重复。

**P-S1 思考等级端到端保真（回溯 G4 + 事故 B）**
场景：设置页新添加一个模型（思考策略选 high-max 预设），保存后回到 composer 对其设「最高」，连续使用 5 分钟。
通过标准：保存后读 `~/.xyz-agent/pi/agent/models.json`，该模型含 `"reasoning": true`；composer 档位选择器展示的可用档与 pi `get_available_thinking_levels` 实值一致（reasoning:false 模型仅「关」可选）；设「最高」后 UI 立即显示 pi 生效档（无 30s 后回跳）；pi session 文件 `thinking_level_change` entry 值与 UI 显示一致。

**P-S2 回执保真负面路径（回溯 D3）**
场景：对 mimo 族模型（支持止于 high）设「最高（max）」。
通过标准：UI 显示 clamp 后真值 high 而非请求值 max（第一毫秒起）；runtime 日志可见 set→get_state→effective 链路（U6 交付的 debug 级链路日志）；pi session 文件 thinking_level_change entry 值与 UI 显示一致；全程无乐观值闪现。

**P-S3 漂移守卫演练（回溯 G5）**
步骤：① 把 `docs/pi-semantics.json` 任一条目的 verifiedWith 改成旧版本号 → 跑 `node scripts/check-pi-semantics.mjs`；② 故意篡改一个探针断言（如把两级门控断言反向）→ 跑 runtime 探针测试；③ 恢复。
通过标准：①② 均非零退出/测试红，报错文案含具体条目 id、pi 锚点与恢复动作（跑哪个命令、更新哪个字段）；恢复后全绿。

**P-S4 护栏拦截演练（回溯 D7）**
步骤：① 在 subagent-workflow 白名单外文件 staged 一行 `deliverAs: "steer"` → commit；② 在白名单外 staged 一处 `"--model"` 字面量 → commit；③ 撤销。
通过标准：两次 pre-commit 均红且报错指向白名单与约束 id；撤销后正常通过。

**P-S5 能力注册表对账（回溯 G4，反向验证）**
场景：往 models.json 手工加一个 reasoning 缺失的假模型条目 + 确认本机 models-store 含大小写家族条目，启动 app 打开设置页与 composer。
通过标准：假模型档位显示「仅关」（与 pi 行为一致，不出现可选高档位的误导）；runtime 日志出现配置↔pi 清单对账记录；无崩溃无静默。

**回归底线**：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` + runtime/renderer test 全绿；real-pi 池（G5 含其中）在凭证机全绿；打包三阶段验证 + `validate-runtime-bundle.sh` 绿（pi-ai 入 bundle 的 P-C1 门在此收口）。

---

## §5 下一层拆分

交付顺序：切片 1（U1-U4，已有独立文档，不重复列出）与 U7 可立即并行启动；U5→U6 有依赖（U6 消费 U5 的 supportedLevels 下发）；U8 各项随对应单元同 PR 收尾。

| 单元 | 内容 | 依赖 | 可独立验收 |
|---|---|---|---|
| **U5 能力注册表** | runtime 新增 `model-capability.ts`（pi-ai 同源计算 + get_available_models 对账 + drift 日志）；rpc-client 封装 `get_available_models`；`packages/runtime/package.json` 加 `@earendil-works/pi-ai` + `tsup.config.ts` noExternal 登记；ProviderInfo.models 增 `supportedLevels` 字段（shared 类型） | 无（P-C1 打包门在其内） | P-S5 |
| **U6 回执与表单** | protocol.ts ReplyPayloadMap 修型 + 改状态 RPC 普查补齐回执；useModel 弃乐观写；core **函数级**删除 resolveAvailableLevels 及其调用方（thinking-levels.ts 其余 9 个导出保留；连带项：renderer shim `panel/thinking-levels.ts` 与 core index re-export 保持——W3/W4 归位计划不动，thinking-level-sync.ts 与 Popover 的 resolveThinkingKey 不动，thinking-levels.test.ts 改锚删对应用例）；档位消费切 supportedLevels；ThinkingLevelPopover 接线；ModelListSection 加 reasoning 开关 + addModel 自动推导；session-service set→get_state→effective 链路补 debug 日志一条（P-S2 可观察点）；**删除 thinkingLevel 30s 兜底轮询**（D9 定案：回执接通后其覆盖场景只剩「不受支持的外部双写者」；删除点在回执链路验收 P-S1/P-S2 通过之后，验收锚点 = G5 e2e + set 被钳/切模型被钳/restore 附着三个手工场景） | U5 | P-S1/P-S2 |
| **U7 漂移守卫与护栏** | `docs/pi-semantics.json`（附录 A 初始内容）+ `scripts/check-pi-semantics.mjs` + 探针测试族 + diff-probe 接线 + `check_subagent_channels.py`（G4，切片 1 U1/U2 合入后启用）+ G5 real-pi 用例登记 REAL_PI_TESTS；pre-commit 块插入 install-hooks.sh heredoc（i18n 段后）+ `pnpm prepare` 重部署 + CI invariants 挂步 | 无（G4 依赖切片 1 U1/U2） | P-S3/P-S4 |
| **U8 治理文档** | constraints.json 四条登记 + render 重生成 + ADR-0064 + troubleshooting 观察项/规则 + extension-conventions 两节 + TEST-STRATEGY 三处 + context.md/glossary 术语 + AGENTS.md 索引行 + C-build-01 scope 漂移修正 | 对应护栏/单元同 commit 或护栏先行（render-constraints 存在性校验） | 文档评审 + select-constraints --check PASS |

**为什么这样拆**：U5/U6/U7/U8 沿依赖边与风险边切分——U5 是唯一引入新依赖（pi-ai）与打包风险的单元，独立合入便于 P-C1 门单独收口、单独回滚；U6 是协议/前端消费切换，依赖 U5 的下发面但自身零新依赖；U7 全部是「新增文件 + 挂载点接线」型改动，不改既有逻辑，可与一切并行；U8 是文档与登记，随对应单元同 PR 落地以满足 render-constraints 的 hook 存在性校验。切片 1（U1-U4）与本程序零代码耦合，按自身节奏交付。

**文件改动地图（程序级，切片 1 的地图见切片 1 文档）**：

```
packages/runtime/src/services/model-capability.ts        [U5 新增]
packages/runtime/src/services/model-service.ts           [U5 挂面]
packages/runtime/src/infra/pi/rpc-client.ts              [U5 get_available_models 封装]
packages/runtime/src/infra/pi/__tests__/pi-semantics-*.test.ts  [U7 新增]
packages/runtime/src/__tests__/equivalence/thinking-level-effective-e2e.test.ts [U7 新增+登记]
packages/runtime/package.json / tsup.config.ts           [U5 依赖与 noExternal]
packages/shared/src/**/protocol.ts                       [U6 ReplyPayloadMap]
packages/core/src/domain/composer/thinking-levels.ts     [U6 删 resolveAvailableLevels + undefined 语义；其余导出保留]
packages/core/src/domain/composer/model-thinking.ts      [U6 切 supportedLevels]
packages/core/src/domain/settings/use-provider-edit.ts   [U6 addModel reasoning]
packages/ui/src/features/settings/common/ModelListSection.vue   [U6 表单开关]
packages/renderer/src/composables/features/model/useModel.ts    [U6 弃乐观写]
packages/renderer/src/components/panel/ThinkingLevelPopover.vue [U6 接线]
scripts/check-pi-semantics.mjs                           [U7 新增]
scripts/diff-probe-thinking.mjs                          [U7 改目标+接线]
.githooks/check_subagent_channels.py                     [U7 新增]
.githooks/install-hooks.sh                               [U7 heredoc 插块]
.github/workflows/ci.yml                                 [U7 invariants 挂步]
docs/pi-semantics.json                                   [U7 新增]
docs/constraints.json (+constraints.md 生成)             [U8]
docs/adr/0064-pi-semantic-absorption-layer.md            [U8 新增]
docs/TROUBLESHOOTING.md / docs/extensions/extension-conventions.md
TEST-STRATEGY.md / docs/architecture/context.md / docs/extensions/glossary.md
docs/extensions/logging-conventions.md / AGENTS.md       [U8]
```

**待验证检查点（诚实标注）**：
- ⛔ P-C1 pi-ai 打入 runtime CJS bundle 的行为等价 + 体积阈值 + 版本一致性（D2）：三阶段打包验证 + validate-runtime-bundle.sh 之外，断言 bundle 增量 < 100KB（pi-ai dist 全量 5.7MB 含全部 provider 实现，主入口 import 在 CJS 输出下 tree-shake 效果未验；超标则评估子路径 import `@earendil-works/pi-ai/dist/models.js`）；并断言四包版本一致（D6 门禁同款校验的打包期形态）。降级 = 纯在线对账 + 设置页可用性妥协。
- ⛔ P-D1 附录 A 各 probe 条目的断言可行性（D6；个别条目允许降级为锚点+代码形态断言）。
- ⛔ P-D2 在线对账的触发面（每附着一次 vs 设置页打开时 withEphemeralPi 短命进程，C-pi-10 先例；以性能实测定）。
- ~~轮询降频检查点~~ 已由 D9 定案为删除（U6 内，见上表）。

---

## 附录 A：pi 语义依赖初始登记（docs/pi-semantics.json 的种子内容）

（所有条目 verifiedWith 初值均为 `"0.84.1"`；校验口径 = D6 守卫层③的四者一致 + verifiedWith 比对。**行号权威声明（2026-08-28 实施核对）**：piAnchor 的 file:line 以 docs/pi-semantics.json 为唯一机器权威（探针直读 dist 校验）；本表是人读快照，个别行号与 json 实测有出入时以 json 为准，不四重维护。）

| id | 语义断言 | pi 锚点（0.84.1 实装） | 守卫 | 实证来源 |
|---|---|---|---|---|
| PS-01 | `--model` 是 pattern 非精确 ID：canonical 双命中判歧义作废 → contains 模糊 → localeCompare 取最大；findExactModelReferenceMatch 的 id 匹配为 toLowerCase 相等 | pi-coding-agent dist/cli/args.js:245；dist/core/model-resolver.js resolveCliModel:291-463（内嵌 tryMatchModel 自 :104 起）、findExactModelReferenceMatch :97 | probe（代码形态断言）+ 切片 1 D1 孪生守卫（运行时） | 事故 A 探针 P-A0（node 复现与基线 session model_change 逐字一致） |
| PS-02 | 思考能力两级门控：`!model.reasoning → ["off"]`，thinkingLevelMap 仅在开关打开后生效 | pi-ai dist/models.js:548-550 | probe（import pi-ai 直调断言 reasoning undefined/false → ["off"]） | 事故 B 实机探针复现钳制 |
| PS-03 | `set_thinking_level` RPC 响应无 data（仅 success）；生效值须 set 后 get_state 补读 | pi-coding-agent dist/modes/rpc/rpc-mode.js:387-389；rpc-types.d.ts 同分支 | probe（静态断言响应构造） | 事故 B + 本轮核查 |
| PS-04 | 同档位切换不发 thinking_level_changed（isChanging=false）；钳制后同值亦不发。2026-08-28 补充实证：setThinkingLevel（agent-session.js:1280-1299）在 effective ≠ previous 时必发事件——isChanging=false 仅覆盖「值未变」场景，**不构成对账缺口**（D9 删 30s 轮询的依据） | dist/core/agent-session.js:1275-1295 | probe | 事故 B（30s 兜底轮询的存在理由） |
| PS-05 | steeringQueue 全文仅 2 个 drain 点（turn 边界 / 手动 continue()），run 收尾后无残留补触发 | pi-agent-core dist/agent.js:321、:243 | probe | 事故 A F2 |
| PS-06 | `_pendingNextTurnMessages` 唯一 drain 点 = 用户驱动 `session.prompt()`（声明 :95 / 入队 :1078-1080 / 注入清空 :880-883） | pi-coding-agent dist/core/agent-session.js | probe | 事故 A 审查 MF-1 |
| PS-07 | `_emitAgentSettled` 先复位 `_isAgentRunActive` 再发事件（边沿回调内 isIdle 恒真） | dist/core/agent-session.js:327-331 | probe | 事故 A D5 |
| PS-08 | sendCustomMessage `{triggerTurn:true}` 走 `_runAgentPrompt` 起轮直达（四分支 :1068-1098，直达 :1089-1090） | 同上 | probe | 事故 A（基线 session 唯一成功样本路径） |
| PS-09 | plain appendEntry（type=custom）不进 LLM 上下文；进上下文的是 custom_message | dist/core/session-manager.js:165-186（sessionEntryToContextMessages 对非 custom_message 返回 []） | probe | 事故 A 审查期实测 |
| PS-10 | `get_available_models` RPC 返回 Model 全属性（reasoning:boolean、thinkingLevelMap 等）；get_state 不含 models 清单 | rpc-mode.js:380-382、:344-363；pi-ai types.d.ts:660-672 | probe | 本轮核查 |
| PS-11 | models-store.json 远端目录周期刷新可引入新条目（含大小写家族），匹配行为随时间漂移 | pi 远端目录缓存机制（文件 mtime/checkedAt 可复核） | observe（运行时防御 = 切片 1 孪生守卫 + U5 对账 drift 日志） | 事故 A |
| PS-12 | thinking 档位按模型族钳制就近回落；xhigh/max 仅部分模型族支持 | pi-ai dist/models.js clampThinkingLevel:560-578；ThinkingLevel 枚举 types.d.ts:23 | probe（同源函数断言 mimo 族 max→high） | 既有观察项 #4（2026-08-20）+ 事故 B |
| PS-13 | interactive 挂起窗口 SIGINT re-raise 被 ignoreSigint 吞掉（subagent-workflow 信号收割边界） | dist/modes/interactive/interactive-mode.js:3193-3223 | observe（处置建议已在观察项 #1） | 既有观察项 #1 |
| PS-14 | session 延迟首写：首条 assistant 前 jsonl 不落盘，新 session crash 窗口内内存记账丢失 | dist/core/session-manager.js:724-752 | observe（既有兜底已生效，观察项 #2） | 既有观察项 #2 |
| PS-15 | pi-ai/compat 是上游自声明临时入口，ModelManager 迁移完成后删除 | pi-ai dist/compat.js 头注释 | observe + pi 升级 PR 必查两项（exports 含 ./compat、changelog 提及迁移）——checklist 并入 C-proc-08 报错文案 | 既有观察项 #3 |
| PS-16 | fork 路径 spawn 透传 preset model 可压过 fork 源 model_change 终态 | runtime forkSession 链路 + pi 恢复语义 | observe（待产品裁决，观察项 #5） | 既有观察项 #5 |

## 附录 B：与既有治理资产的关系

- **C-pi-02（pi 语义断言权威源）**：本设计不改动其表述，给它补上机器执行面（D6 登记 + 探针 + 版本门禁）——从「review 时人工核对」升级为「版本不符即红」。
- **C-data-03 / C-data-04**：能力注册表的 view-ready 下发与「事件只做失效不直写」完全同构，是既有数据治理原则在模型能力域的实例，不发明新模式。
- **C-comm-04（EventAdapter 唯一适配点）**：本设计把它从「传输格式适配」扩到「语义适配」——能力注册表是语义面的唯一入口，两者并列登记（C-pi-12 authority 会互相引用）。
- **troubleshooting.md 观察项**：人读层保留并加 PS 互链；机器层（pi-semantics.json）是唯一守卫源，两边机制描述不双写。
- **切片 1 文档**：D1-D6 技术决策不变；其中 D1（全等裁决）与 D4/D5（账本/ courier）分别是本设计支柱一/三的 subagent 域先行实例。
- **已登记待办（不进本设计交付，防丢）**：scheduler 触发注入的账本化迁移（D5 存量口径：现状 `extensions/universal/scheduler/src/index.ts:97-99` 底层 deliverAs steer/followUp、无账本无幂等键；复用切片 1 U2 账本设施，迁移合入时 G4 扫描面同步扩到 scheduler 目录）；**subagent-workflow 内 workflow 完成通知的账本化迁移**（interface/helpers.ts notifyDone 存量 steer、结果语义，2026-08-28 审查补登记；复用 U2 账本设施，迁移合入时移除 g4-allow 豁免）；renderer subagent pane 消费 outcome 字段的 UI 升级（切片 1 已保证向后兼容输出；附带：packages/shared/src/subagent.ts 的「三处同构」注释已随 U3 失效，GUI 升级切片须同步更新）；pingPi 60s 升级式触发改造（事件静默超时再探，替代无条件周期，D9 ②）；Electron 30s /health 周期探测按需化（WS watchdog 触发探测 → 重启决策，D9 ②，对齐 ZCode/DSH「请求超时 + 便宜重建」范式）；重试路径普查补三件套（尝试预算上限 / 稳定窗清零 / 尊重 retry-after，D9 对照 DSH MCP 监督）。**已随 2026-08-28 落地**：plugin-host 30s 空转删除、handoff 2s 事件化、5s flushAll×2 删除、更新检查 20min→60min、skill watch polling 降级化（明细见附录 C）。**核查后无需改**：WS 断线重连已是有界指数退避（packages/core/src/transport/ws-client.ts:43-50，1s 起步 ×2 退避、30s 封顶、60s 总预算后进 failed 态），与 opencode 同档，从待办移除。

## 附录 C：轮询/定时器处置全清单（2026-08-28，D9 执行台账）

12 处常规定时机制的逐项处置。判定准则（四类框架）的人读版在 [troubleshooting.md](../troubleshooting.md)「周期轮询/兜底定时器的合法性判定」；本表是处置事实与证据锚点的登记处。

### C.1 结构性保留（活性探测 / 一次性握手，共 6 项）

| 机制 | 锚点 | 类 | 处置 | 依据 |
|---|---|---|---|---|
| pingPi 60s 探活 | `packages/runtime/src/services/session/event-interpreter.ts:37`（PING_INTERVAL_MS），pingTick :770 | 活性探测 | **保留**；待改造为升级式触发（事件静默超时再探，替代无条件周期）——已登记附录 B 待办 | 死掉的 pi 无法主动 push 自己的死亡，探测结构性不可替代；ZCode 同域无周期 ping（30s 请求超时 + dispose + 惰性重建），证明「无条件周期」可降为「触发式」 |
| WS 15s ping + 45s watchdog | renderer 侧 `packages/core/src/transport/ws-client.ts:42`（HEARTBEAT_INTERVAL_MS，keepalive only）；runtime 侧 `packages/runtime/src/transport/connection-manager.ts:30`（HEARTBEAT_TIMEOUT_MS，静默即 close） | 活性探测 | **保留**（现状已达标，无改造项） | 断线重连已是有界指数退避（ws-client.ts:43-50）；与 opencode SSE 心跳 10s/15s + 客户端 1s→30s 退避同档 |
| Electron 30s /health 探针 | `apps/electron/main/supervisor/liveness-probe.ts:31`（LIVENESS_INTERVAL_MS） | 活性探测 | **保留**；待改造为按需化（WS watchdog 触发探测 → 重启决策）——已登记附录 B 待办 | 同上：runtime 卡死无法自报；ZCode 无 /health 轮询（wakaru-test/host/entry.js:5158，靠请求超时兜底），证明周期可降触发式 |
| pi 启动有界等待 | `packages/runtime/src/infra/pi/process-manager.ts:26`（EPHEMERAL_READY_TIMEOUT_MS=5s）、`packages/runtime/src/infra/relay/relay-registry.ts:39`（HANDSHAKE_TIMEOUT_MS=10s） | 一次性握手 | **保留** | 一次性有界等待 ≠ 周期轮询；ZCode 反例：启动握手无超时上限是其弱点，有界等待方向正确 |
| 快照重拉退避 1/5/15s | `packages/runtime/src/services/session/replicated-states.config.ts:63`（SCALAR_STATE_BACKOFF_SCHEDULE） | 协议补偿 | **保留**；重试三件套（预算上限/稳定窗清零/retry-after）普查待做——已登记附录 B 待办 | 补偿 pi session 延迟首写（PS-14）与快照暂不可读；失败驱动 + 有界退避 + 成功归零，形态已合规 |
| OAuth 设备码轮询 | `packages/runtime/src/services/auth/device-code-flow.ts` | 协议规定 pull | **保留**（核查后未改，已合规） | RFC 8628 §3.5 规定客户端轮询；实现已尊重服务端 intervalSeconds 与 slow_down +5s；opencode 实现同档 |

### C.2 外部世界类（保留，降频已落地，1 项）

| 机制 | 锚点 | 处置 | 依据 |
|---|---|---|---|
| 应用更新检查 20min → **60min** | `packages/renderer/src/composables/features/settings/useAppUpdate.ts:62`（CHECK_INTERVAL_MINUTES） | **已落地降频**（2026-08-28） | GitHub Releases 无 push 通道，轮询结构性合理；频率 = 外部约束：未认证 API 限额 60 次/小时 → 1h 一次配额宽裕；与 release-checker 1h 缓存 TTL 同档；ZCode 同功能为启动时 + 1h（其 main/index.js:17712），对齐 |

### C.3 事件化 / 删除（已落地，4 项）

| 机制 | 原锚点 | 处置 | 依据 |
|---|---|---|---|
| handoff 2s 退出轮询 | `packages/runtime/src/services/handoff-service.ts`（原 HANDOFF_EXIT_POLL_MS=2_000） | **已事件化**（2026-08-28）：onExit 多播订阅命中即 reject | 轮询存在的唯一理由是 onExit 曾单槽（rpc-client.ts:144 注释）；多播化后理由消失。TC8b 改事件路径验证 |
| plugin-host 30s memory monitor | `packages/runtime/src/services/plugin-service/plugin-host.ts`（原 MEMORY_MONITOR_DEFAULT_INTERVAL_MS） | **已删除**（2026-08-28） | 无消费者空转：WorkerHandle.lastActiveAt 只写不读（全仓 grep 零读取方），属「有数据无消费者」空转类 |
| flushAll 5s 周期 ×2 | `session-data-store.ts`、`workspace/recent-workspaces-store.ts`（原 FLUSH_INTERVAL_MS=5_000） | **已删除**（2026-08-28） | 落盘保障已由 per-write debounce 500ms + 退出前 flushAll（plugin-shutdown.ts:64-77 / index.ts shutdown 链）双保险覆盖，周期 flush 是第三重冗余 |
| skill watch stat-polling | `packages/runtime/src/services/skill-registry.ts:117`（WATCH_OPTIONS.usePolling） | **已显式降级化**（2026-08-28）：默认原生事件，`XYZ_AGENT_SKILL_WATCH_POLLING=1` 回退 | 2026-07-27 设 polling 的依据（nodejs/node#52601，实测触发率 ~40%）在当前 Node v24.11.1 / macOS 25 复测不再复现（10 轮新建子目录+文件 21/21 事件全到）；真实 watcher 测试 W5a/W5b 在原生事件路径下转绿 |

### C.4 待删除（随 U6 落地，1 项）

| 机制 | 锚点 | 处置 | 依据 |
|---|---|---|---|
| thinkingLevel 30s 兜底轮询 | `packages/runtime/src/services/session/replicated-states.config.ts:59`（THINKING_LEVEL_POLL_INTERVAL_MS）、:123（pollIntervalMs） | **删除**（非降频），随 U6 与回执链路一同落地 | 自有状态对账类：pi 全部写入路径经 xyz 自身 set/restore，回执接通后覆盖完备；pi 侧实证（PS-04 补充：agent-session.js:1280-1299 effective≠previous 必发事件，isChanging=false 仅「值未变」）证明 pi 不会静默改值；剩余覆盖仅「不受支持的外部双写者」，不构成保留理由。验收锚点 = G5 e2e + set 被钳/切模型被钳/restore 附着三手工场景 |

### C.5 对照证据锚点（外部实现）

| 对照源 | 关键证据 |
|---|---|
| ZCode（~/GitApp/ZCode 打包版反混淆直读） | 无 engine ping（30s 请求超时 → dispose+SIGTERM+惰性重建，wakaru-test/host/entry.js:5158、chunk_LG.js:137-149）；renderer↔host MessagePort 零心跳；无 /health 轮询；更新检查启动+1h（main/index.js:17712）；fs.watch+150ms debounce 无轮询兜底；重试线性 1s×n ≤5 + 120s 窗口 2 次崩溃熔断 |
| deepseek-harness | runtime core 全仓仅 1 个 setInterval（ELU busy-budget 采样 25ms，60s busy/600s wall）；MCP 重连 500ms→30s ×10 + 30s 稳定窗清零 |
| opencode | SSE 心跳 10s/15s + 客户端 1s→30s 指数退避重连；OAuth 严格 RFC 8628（server interval / first-poll 前 sleep / slow_down +5s） |

## 附录 D：切片 1（subagent 派发域）技术方案决策索引（2026-09-13 收编）

> 原独立设计文档 `subagent-dispatch-reliability.md`（D1-D6 / U1-U4 / S1-S5，四轮对抗审查收敛，已全部实施交付）收编为决策索引；全文与审查轨迹 git 可追溯。现行机制锚点：模型裁决 `packages/subagent-core/src/shared/model-ref.ts`、通知账本 `packages/subagent-core/src/execution/notify-ledger.ts`、投递内核 `packages/session-delivery/src/delivery.ts`。

| # | 决策 | 被否方案（要点） |
|---|------|----------------|
| D1 | 模型裁决收拢为 `assertCanonicalModelRef` 单函数——全等放行 + registry 孪生守卫，模糊匹配只做报错建议绝不采纳 | 大小写宽容采纳（采纳即改写，翻译层随 registry 刷新漂移）；现状双层规则（扩展精确 + pi pattern 模糊——429 空转实证）；只做全等不做孪生守卫（恒等式静默破产面） |
| D2 | spawn 前置守卫——`--model` 只接已裁决的 ModelRef | 给 pi CLI 参数做引号/转义优化（pattern 引擎是 pi 私有语义，赌行为） |
| D3 | 不改 pi，以上游缺陷为设计常量 | 提 PR / fork（项目 MANDATORY 纪律禁止） |
| D4 | 通知存在性与可达性分离——持久账本先行，投递尽力，回执销账（at-least-once） | 内存销账（重启即全量重放）；delivery 单打独斗（retry 重试的是函数调用不是事实——十余次完成仅 1 条落盘反证）；纯拉取（无触发器 G2 失效） |
| D5 | courier 单通道化——投递时机统一收敛 settled 边沿直达，删除 steer 与 nextTurn 通道 | steer 通道（消费窗极窄且回执为零）；nextTurn 队列（初稿选型审查证伪：注入点只在 `session.prompt()` 内，主 agent 长 streaming 时无限期滞留 + 超时重放重复涌入） |
| D6 | outcome 一等字段在 completeRecord 唯一写入点定形 | 各消费点本地推导（三处同构 switch 已产 bug）；改 closedReason 语义（波及 30 余处消费点与历史兼容） |

三项改造同构于一个原则：**派发契约的两个承诺（start 时承诺可执行的模型、完成后必达通知）都必须有受理确认与单一权威**——即四支柱「能力注册表 / 确认式送达」在派发域的实例化。

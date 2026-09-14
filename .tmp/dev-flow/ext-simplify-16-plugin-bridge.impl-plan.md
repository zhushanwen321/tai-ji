# ext-simplify-16 plugin-bridge 实施计划

基线: a8718fcd5（设计文档 v1.2 终版；本计划文档 commit 即流水线基线） | 来源设计: docs/design/ext-simplify-16-plugin-bridge.md | 日期: 2026-09-14
审查证据: docs/design/ext-simplify-16-plugin-bridge.review.md——对抗式审查 r1（NEEDS-FIX 1 MF + 4 S）全修 → 聚焦复审 R2 **PASS（0 must-fix）**；残留 1 suggestion（bridge-rewrite :238 E2 讹写）已并入 u3 清单。

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|------------------|
| 背景/目标 | 开篇 SCQA + §1 背景 + §2 设计目标与非目标 |
| 终态/机制 | §3 现状位置图 + §4 物理数据流（4.1 拦截注入链 / 4.2 sync 链）+ §5 终态 + §6 决策 D1-D6 + §6.7 执行项总表 + §6.8 探针 P1-P3 |
| 验收场景表 | §7 验收（A1/A2/A3/N1/N2/A4 + 「已核实非过度」不触碰清单） |
| 下一层拆分 | §8.1 迁移路径 + §8.2 下一层拆分清单（u1/u2/u3） |
| 待验证检查点 | §8.3 CP1-CP3 |

## 1 目标快照（逐字摘录设计 §2）

**目标**：
1. M21 裁决落地：注入映射收窄为 string-only，删除结构化透传死分支（D1）；
2. 协议死面双端删除：`commands` 字段、`Tool not found` error 形态分支（D2/D3）；
3. Bridge* 回包形状单源化：三处定义 → extension-protocol 一处（D4）；
4. `details` ok 变体去重、三失败 kind 保留（D5）；
5. `getSessionId` 删不可达防御（D6）；
6. bridge-rewrite §3.2「类型零丢失」承诺同步降格登记（登记即债务修复即清账）。

**非目标**（不动清单）：select+marker 通道机制与三条硬约束；sync/准入闸/失败折叠；协议层 `injectedMessages: unknown[]` 类型（不收紧）；SDK worker 通道专属类型（`BridgeSyncRequest`/`BridgeSyncResponse`/`BridgeState`/`BridgeToolExecuteRequest`）；runtime `bridge-handler`/`bridge-interop` 的路由与塑形逻辑。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|----------------------|------|------|----------|
| u1 | D1 收窄 string-only（删 InjectedTextContent/InjectedImageContent :99-109 + isTextContent/isImageContent :111-117 + 透传分支 :463-467，content 映射恒两路：string→`{type:'text',text}` / 非 string→JSON.stringify）+ D3 isToolNotFound 删 error 形态分支（:123，保留函数与形态②判定）+ D5 details ok 变体去重（:176-184 ok 改 `{kind:'ok'}` 无载荷；:360-365 内联构造同步；:174 失实「session-manager 同款」注释如实化）+ D6 getSessionId 删 try/catch 直呼（:164-172，删错位辩护注释、保留下游语义注释）+ D2 桥侧尾巴（:257 注释、两测试文件 fixtures 的 `commands: []`、:191-198 守护用例删除） | extensions/taiji/plugin-bridge/src/index.ts · extensions/taiji/plugin-bridge/src/__tests__/forwarding.test.ts · extensions/taiji/plugin-bridge/src/__tests__/sync-and-registration.test.ts | 无 | plain | ① `cd extensions/taiji/plugin-bridge && pnpm typecheck && pnpm test` 全绿 ② bridge 包 rg 零命中：`commands`/`isTextContent`/`InjectedImageContent`/`InjectedTextContent` ③ forwarding.test.ts 含 N2 失配序列化用例（非 string content → JSON.stringify 进 text 段）与 D1 string-only 断言（原 :295-313 透传用例重写） |
| u2 | D2 commands 协议/runtime 侧删除（types.ts:46/:49、plugin-types.ts:99-105、bridge-interop.ts:148/:152、bridge-handler.ts:91、runtime fixtures）+ D4 三形状单源化到 extension-protocol（runtime plugin-types 改 re-export；plugin-sdk 两形状改 re-export + package.json 增 workspace 依赖 + `pnpm install` 刷 lockfile；协议 :33-35 手工同步矛盾注释清理）+ plugin-types.ts:3-5 头注释 D28 叙事同步（runtime-internal 仅剩 IPluginServiceDeps）+ bridge-interop.ts:254-258 退役文档引用注释修正（指向 git `7a3797d0b` 原文，注明已退役于 `fadd8b8b4`） | packages/extension-protocol/src/extensions/plugin-bridge/types.ts · packages/runtime/src/services/plugin-service/plugin-types.ts · packages/runtime/src/services/plugin-service/bridge-interop.ts · packages/runtime/src/transport/bridge-handler.ts · packages/runtime/test/bridge-marker-channel.test.ts · packages/runtime/test/plugin-hooks-integration.test.ts · packages/plugin-sdk/src/types.ts · packages/plugin-sdk/package.json · pnpm-lock.yaml | 无（与 u1 并行安全：bridge 不读 `.commands`，测试 fixtures 是无类型 JSON 字面量） | plain | ① P2：`cd packages/extension-protocol && pnpm typecheck` + `cd packages/runtime && pnpm typecheck` 全绿（三包 import 链无断裂 = CP1 通过） ② runtime 增量测试绿（bridge-marker-channel + plugin-hooks-integration + plugin-service 相关） ③ 协议/runtime/sdk 侧 rg 零命中 `commands`（bridge sync payload 语义域；plugin-sdk 的 PluginContributesCommand/manifest commands 域与 bridge-interop 的 commands-executor 注释**不在删除面**，勿误伤） ④ CP2：`node scripts/bundle-extensions.mjs` 复核过 |
| u3 | 文档同步：bridge-rewrite §3.2「类型零丢失」降格（string 注入零转换；非 string 失配形态序列化保信息）+ §3.3-D7 commands 死代码裁决回写关闭登记（字段本体已删）+ :208 miss 形态描述修正（`{error: 'Tool not found: ...'}` → 实装 `{content: 'Tool not found: <name>', isError: true}`）+ :238 E2 行 `isError` 讹写修正（r2 残留 suggestion）+ 该文档变更历史登记 | docs/design/bridge-rewrite-pi-0.84.md | u2（同批或紧随：文档描述 u1/u2 终态） | plain | ① 四处表述与 u1/u2 落地终态一致 ② pre-commit doc-symbol-drift 守卫过 |

## 3 DAG 图

```mermaid
graph TD
    u1["u1 bridge 扩展（D1/D3/D5/D6/D2尾巴）"] --> G3["阶段3 一致性审查+全量"]
    u2["u2 协议/runtime/sdk（D2/D4+CP1/CP2）"] --> u3["u3 bridge-rewrite 文档同步"]
    u2 --> G3
    u3 --> G3
```

u1 ⊥ u2 文件级零交集真并行；u3 串行于 u2 之后（文档表述依赖 u2 落地形态）；u1 与 u3 亦零交集。

## 4 测试与验收计划

**增量（单元开发期）**：
- u1：`cd extensions/taiji/plugin-bridge && pnpm typecheck && pnpm test`
- u2：`cd packages/extension-protocol && pnpm typecheck`；`cd packages/runtime && pnpm typecheck`；`cd packages/runtime && pnpm vitest run test/bridge-marker-channel.test.ts test/plugin-hooks-integration.test.ts`；plugin-sdk 无独立 script，其类型链由 runtime/protocol typecheck 经 import 覆盖；u2 改 package.json 后跑 `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` 刷 lockfile
- 全量（阶段 3 尾）：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` + `cd packages/runtime && pnpm test` + `node scripts/bundle-extensions.mjs`（CP2）
- **L0**：pre-commit 全套（doc-symbol-drift 由 u3 领地触发）+ N1 rg 断言（主 agent 直跑）

**分层策略**：遵循 TEST-STRATEGY.md；本设计验收面以真机桌面为主链路（bridge 是 runtime↔pi 通道，pi CLI 裸跑无 runtime PluginService 对端，CLI 腿不适用——与 13 号双环境不同，16 号仅桌面腿）。

### 验收计划表

| # | 验收项（场景表行） | 方式(L0-L4) | 成本(1-10) | 收益(1-10) | 组 | 依赖 | 优化判定 |
|---|--------------------|-------------|------------|------------|----|------|----------|
| A1 | fixture 插件（probe_echo 工具 + before_agent_start hook）经 bridge 同步注册，模型调用返回 echo——D2/D3/D5 删除面零回归 | L4 桌面 dev 实例（`XYZ_DEV_BACKGROUND=1 pnpm dev`）+ fixture 插件写入实例 plugins 目录（configDir/plugins，PluginService 发现）+ CDP 驱动 | 7 | 9 | 核心 | u1+u2 committed | 驱动脚本化（CDP 执行 JS + JSONL/工具结果断言） |
| A2 | hook 注入 string，下一轮 prompt 前模型可见 `TOKEN_INJECT:*`；session JSONL plugin-inject CustomMessage.content 为 `[{type:'text',text:'TOKEN_INJECT:*'}]` | L4 同 A1 环境 | 3 | 9 | 核心 | A1（同会话链） | 可合并（并入 A1 会话）；JSONL grep 机器可判 |
| A3 | sync 快照消费 + 桥侧 sync debug 日志 `synced N plugin tool(s)`（XYZ_AGENT_DEBUG=1）——D2 消费方透明性 | L3（A1 环境内日志取证） | 2 | 7 | 核心 | u2 | 可合并（A1 环境）；「负载无 commands 键」由 N1+u2 单测兜底（设计 §7 A3 定案） |
| CP3 | details 收敛后 plugin 工具条目会话重开渲染无异常 | L4 并入 A1/A2（重开 session 核对） | 1 | 6 | 非核心 | A1 | 可合并 |
| N1 | 负面 rg：`commands` 在协议/runtime/plugin-sdk/bridge 四包的类型、构造点、注释、测试 fixtures 全部零命中；`isTextContent`/`InjectedImageContent` 零命中；`startsWith("Tool not found")` 仅形态②一处；getSessionId 调用点无 try/catch 包裹 | L0 rg（主 agent 直跑） | 1 | 9 | 核心 | u1+u2 | 可脚本化 |
| N2 | 失配序列化单测（非 string content → JSON.stringify text 段） | L1（u1 单测） | 1 | 6 | 非核心 | u1 | 单测兜底（生产不可达路径，设计明示不设真机场景） |
| A4 | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连绿 + runtime plugin-service 相关测试绿 | L2 | 4 | 8 | 核心 | u1+u2+u3 | 阶段 3 尾统一跑（与 Gate A 合并） |

**提速结论**：可脚本化 2 项（A1 驱动 / N1）；可合并 3 项（A2/A3/CP3 全部并入 A1 单环境单会话链）；L0 守卫 = pre-commit 全套 + N1 rg。核心组预计 **1 轮**桌面验收派发（A1 环境承载 A1/A2/A3/CP3 四项取证）+ N1/A4 主 agent 直跑，无独立非核心轮次。

## 5 合理偏差登记表

（阶段 3 一致性审查 reasonable[] 5 条登记，2026-09-14）

| # | 条目 | 理由 | 文档同步 |
|---|------|------|----------|
| R1 | 协议 types.ts:33-38 矛盾注释未按设计 §6.4 字面「删除」，改为正向 SSOT 声明 | 单源化后此处正是声明 SSOT 的位置，正向声明比留白更有导航价值；「runtime 是实现侧权威」矛盾表述已消失，设计目标完整达成 | 无需回写设计（v1 已登记 u2 同族裁决） |
| R2 | bridge-interop.ts blocked 注释族（:262-266）与 :254-256 一并改退役文档指针，超出设计 §8.2 u3 点名的单处 | 同一注释族内同一退役文档引用同款处理，避免半改半不改 | impl-plan v1 u2 自行裁决清单补记此条 |
| R3 | 计划外扩展 bridge-sync.test.ts 经独立核实干净 | diff 仅三处 D2 删除面断言跟随，无越权 | v1 已登记扩入 u2，闭环 |
| R4 | D6 返回类型 `string \| undefined` → `string` | 有实装依据（pi dist `getSessionId(): string`），已删 catch 路径的类型层幽灵精确清除 | v1 已登记（主 agent 抽验补修） |
| R5 | 测试强化：D1 拆两面用例且 N2 兼任透传分支回归哨兵；D5 断言强化为 toEqual 整形断言 | 抓回归能力高于设计要求 | v1 已登记 |

## 6 状态表

| Unit | 状态(pending/in-progress/committed/blocked) | 轮次 | 证据指针 |
|------|----------------------------------------------|------|----------|
| u1 | committed | 2 | 3d175e18e；包内 typecheck+test 33/33 绿；N1 bridge 侧零命中；D6 返回类型收紧（主 agent 抽验补修） |
| u2 | committed | 4 | e519206e8；CP1 双包 typecheck 绿（回退方案未触发）；runtime 三测试文件 61/61；CP2 bundle exit 0；三形状唯一定义点 rg 核实 |
| u3 | committed | 1 | bb085f57b；docs/design/bridge-rewrite-pi-0.84.md 五处落地 + 主 agent 追加 §3.4 E1/E4/E6 同款讹写清偿（见 v1 u3 记录） |

## 7 残留风险与变更历史

- **CP1 回退方案**（设计 §8.3 预设）：plugin-sdk 增 workspace 依赖后若 typecheck 链断裂，回退 = SDK 侧维持本地定义，D4 收窄为 runtime 侧单源化并登记（u2 执行时首验）。SDK 实测无 scripts、无构建步骤（main=src/index.ts 源码直消）、private 包，预判零风险。
- **P3 备查**（不在执行面）：forwardToolExecute 把通道异常折叠为「cancelled.」文案——已登记移交 code-simplify 备选，本次不顺手改。
- **D2「同批同 PR」兑现方式**：u1/u2 各自独立 commit、同分支合入（注释与 fixture 不参与运行时，批间无行为窗口；co-deployed 无版本偏斜）。
- **不触碰红线**：设计 §7「已核实非过度」清单与 §2 非目标为 u1/u2 领地内禁改区（三条硬约束头注释、sync 循环、守卫族、SDK worker 通道四类型、plugin-sdk manifest commands 域〔终态 :251/:289/:834/:885 附近，以域命名判定不锚行号〕、bridge-interop 的 commands-executor 相关注释 :39/:71）。
- v0（2026-09-14）：计划建立，基线 a8718fcd5。计划期补登两条（grep 机械核实）：① forwarding.test.ts:49 `commands: []` 字面量——设计 §6.2 清单未列，按 N1「fixtures 全部零命中」补进 u1；② runtime fixtures 精确行号核实——bridge-marker-channel.test.ts :58/:176、plugin-hooks-integration.test.ts :188-193（含用例名与注释，均 u2 领地）。
- v1（2026-09-14）：u1/u2 committed（3d175e18e / e519206e8，同批同 PR 兑现 D2）。执行记录与计划外裁决：
  - **领地遗漏补登**：bridge-sync.test.ts（走真实 RuntimeServer→BridgeHandler→getSyncPayload 生产链的集成测试，:227-236/:267 断言生产回包含 commands）设计 §6.2 与本计划 v0 均未列——u2 dev 按领地铁律停下上报，主 agent 实跑核实（2 failed/14 passed）后批准扩入 u2（fix 轮次 2）；其 :386-390 自含形状断言残留同批清理（轮次 3，N1 口径）。
  - **u1 轮次 2**（主 agent 抽验）：getSessionId 返回类型 `string | undefined` → `string`（pi 实装 `getSessionId(): string` 恒返回 string，`| undefined` 是已删 catch 路径的类型层幽灵）。
  - **u2 轮次 4**（提交门拦截）：plugin-types.ts 新注释中协议包内部路径字面量 `extensions/plugin-bridge/types.ts` 触发一层路径残留检查（check-extension-dependencies.mjs 第 5 节，2026-08-22 分组防回退守卫）——改写为包名+模块名指称（仓内既有惯例），检查器本体未动。
  - u1 自行裁决三项均属设计语义内：D3 调用点双形态注释随分支同域清理；D1 重写+N2 拆两用例；D5 断言强化为 `toEqual({ kind: "ok" })`。**〔阶段 6 补记〕第四项：D1 兜底路实装为 `JSON.stringify(content) ?? String(content)`，较设计的「JSON.stringify 兜底」多一层 undefined/null 防御（JSON.stringify(undefined) 返回 undefined 会使 content text 段破约）——设计「非 string 序列化保信息」语义内强化，代码注释自证理由。** u2 自行裁决五项（:262 同文档指针一并修正、:46 保留 getCommands 指引、SDK 头「零依赖」叙事如实化、SDK 双行 re-export（ToolExecuteHandler 本地引用需要）、plugin-types 节头保留）均登记无设计冲突。
  - **u3 轮次 1 + 主 agent 追加**：u3 五处落地（§3.2 降格 / §3.3-D7 关闭登记 / :208 形态 / :238 E2 行 / 变更历史 v4.5，rg 证据 V1-V3 全过）。其领地内观察项——§3.4 表格 E1/E4/E6 行与 E2 同款 `isError: '<文案>'` 速写讹写——主 agent 采信后亲验实装（bridge-handler.ts:105 / bridge-interop.ts:172 均为 `{content, isError: true}`；E4 桥侧 cancelledResult 为 `isError: true` + content 数组、文案实为 `Plugin tool <name>: cancelled.`），裁决一并清偿（E2 修而 E1/E4/E6 不修 = 表格内部自相矛盾且与 :191 注记互斥），变更历史 v4.5 补 ④ 记。
- v2（2026-09-14）：**阶段 3 一致性审查 + Gate A + 修复批次**。
  - **一致性审查**（单全局 reviewer，diff a8718fcd5..HEAD = 15 文件 +211/-155 ≤500 行门槛）：映射有效；六决策 D1-D6 + u3 六处全部落地完整；覆盖矩阵无 unclaimed 区；N1 断言族 reviewer 代跑全过；计划外扩展 bridge-sync.test.ts 独立核实干净。结论：reasonable 5（§5 登记表 R1-R5）/ unreasonable 5（全部 P3 注释/缩进级）/ doc_errors 1（设计 §7 N1 行缺豁免括注——主 agent 亲修：补「bridge sync payload 语义域」限定与各包既有 commands 域豁免清单，对齐 impl-plan u2 验收③口径）。
  - **修复批次**（5 条 unreasonable，合并单批派发 u-dev——每条已被 reviewer 精确定义、总量 ~10 行、仓级 pre-commit extensions typecheck 互锁使并行 commit 无收益，替代 MANDATORY 按组并行规则的登记裁决）：①plugin-sdk types.ts 删重复 @internal 注释行 ②头注释「零依赖」矛盾消除（补 D4 括注） ③plugin-bridge index.ts content 块缩进恢复对齐 ④「类型零丢失」注释术语降格对齐 ⑤bridge-interop.ts 漂移行号 :450-457 语义锚定。修后主 agent diff 行级核验 + 定向复审（合并单发，同批决策）——复审 5 处全 pass（#3 经 `git diff -w` 证明纯空白零 token 变更；#4 与 bridge-rewrite §3.2 降格口径三方一致），另报 2 条 P3 补充修复续聊原 agent 清偿：⑥intercept 测试文件头同源失效行号 :450-457 语义锚定（grep 全仓零残留核验）⑦「见文末历史段」→「见下方历史段」指向修正。相关测试 bridge-interop-intercept 7/7 绿。
  - **Gate A 全量**（主 agent 直跑，输出落盘 .tmp/dev-flow/ext-simplify-16-plugin-bridge.gate-a-*.log）：extensions 三连 exit 0（26 包全过，plugin-bridge 33/33）；runtime 全量 5940/5940（首跑 5939/5940——logger-tee-rotation.test.ts 行数边界断言 9 vs ≥10，单独重跑 3/3 绿 + 改动面与 infra/logger 零交集归因为并发时序 flake，重跑全绿确认）；`node scripts/bundle-extensions.mjs` exit 0（CP2）。SKIP_* / test.skip / 规则跳过：零。
- v3（2026-09-14）：**阶段 5 真机验收全 PASS + 收尾**。桌面端单轮派发（XYZ_DEV_BACKGROUND=1 XYZ_AGENT_DEBUG=1 pnpm dev，CDP 9473，mimo-v2.5-pro，Playwright CDP 驱动，fixture 插件 bridge-probe-16 写入 `~/.xyz-agent-dev/plugins/`）：
  - A1 PASS：probe_echo 真实调用（UI 工具徽标 + 回复 ECHO-16）；JSONL toolCall→toolResult `details:{kind:"ok"}` + isError 缺省——D5/D3 终态零回归。
  - A2 PASS：模型逐字复述 TOKEN_INJECT-16-df9eda（两轮 prompt 各注入一次）；JSONL 2 条 plugin-inject CustomMessage content 均 `[{"type":"text","text":"TOKEN_INJECT-16-*"}]`——D1 string 路由逐字节不变（主 agent 抽验 JSONL 关键行确认）。
  - A3 PASS：`synced 1 plugin tool(s)` debug 日志（无插件会话 synced 0 对照）；staged bundle grep "commands" = 0（产物级佐证）。
  - CP3 PASS：切走再切回（JSONL reload 同一路径，GUI 无显式关闭按钮）9 项 DOM 断言全过，无渲染回归。
  - N1/A4 主 agent 直跑：N1 四断言全过（sync 链 commands 零命中/plugin-sdk 残余 3 处均 manifest 豁免域/startsWith 仅形态②/getSessionId 无 try/catch）；A4 = Gate A 证据。
  - 验收 agent 自行裁决 4 项（全登记）：fixture 位置迁 `~/.xyz-agent-dev/plugins/`（dev 的 XYZ_AGENT_DATA_DIR 被 main.ts:137 钉死，实例子目录仅 Electron userData——以运行时真实扫描点为准）；trusted 被宿主强制降 sandbox，改用预写 permissions.json 免审批（bridge 链路与信任级无关）；CP3 等价操作口径；A3 产物级补强。
  - 收尾：dev 进程树按 PID 精确终止（10 PID 两轮核对，打包版太极.app 未受波及——终态 pgrep 3 PID 经主 agent 核实为打包版 Helper）；fixture 与 /tmp 临时文件清理；产物 8 文件落 .tmp/dev-flow/ext-simplify-16-plugin-bridge.acceptance/（gitignored，一次性场景不沉淀 e2e spec）；零 git 写操作。
  - **收尾检查**：功能分级登记零触发（纯内部简化，无新功能/无挂掉后果变化）；文档资产零同步（TEST-STRATEGY 分层无变化 / TROUBLESHOOTING 无新排障规则 / ARCHITECTURE 进程拓扑无变化——bridge 形状单源化属实现层）。
- v4（2026-09-14）：**阶段 6 design-code-sync 终态同步收敛（1 轮）**。终态全量审查（基线 eaf0d986a）：**0 must-fix**，6 条 finding（1 suggestion contested + 5 info）——代码↔设计（D1-D6 全落地，反引号标识符/git 指针机械核实零悬空）/ 现实↔impl-plan（状态表/残留风险/变更历史逐项实证）/ impl-plan 内部 / 注释口径四关系全 checked。全部当轮修：F1 退役文档裸引 6 处统一「git `7a3797d0b` + 退役于 `fadd8b8b4`」指针形态（代码/测试侧 5 处 fixer + bridge-rewrite:169 主 agent；ext-simplify-16 文档内 :53 已有完整指针自消解、:311 变更历史属快照不动，review.md 属历史快照不动）；F2 设计 §6.4 补终态括注指向 R1；F3 impl-plan v1 补记 u1 兜底序列化强化；F4 bridge-interop 行号锚去除留符号名；F5 状态表 u3 补 hash；F6 §7 红线行号去化。contested 2 条均 suggestion/info 级按默认口径处理（suggestion 级 contested 按 doc-right 修，F4 info 级 contested 按流水线「行号语义锚定」口径修）。验证：runtime 两测试文件 22/22 绿 + plugin-sdk tsc 绿 + 裸引 grep 零命中。**Step 5 退役判定：退役 0 个**（无被整体取代文档；review.md 按本系列惯例原位保留且被 ext-simplify-index.md 引用；impl-plan/验收产物在 .tmp 合规位置）。

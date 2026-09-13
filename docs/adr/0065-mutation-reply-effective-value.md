# ADR 0065：mutation reply 生效值契约与乐观写裁决标准

- 状态：Accepted
- 日期：2026-09-08
- 关联：[state-truth-sync-architecture.md](../architecture/state-truth-sync-architecture.md) §3.3 D8（本文的权威源）· [ADR-0064](0064-pi-semantic-absorption-layer.md)（生效回支柱二，登记 C-pi-13——本文是其人肉纪律的机器化）· [constraints.json](../constraints.json) C-pi-15（本 ADR 的约束登记）· 事故 B（2026-08-27，见 ADR-0064 背景）

## 背景

「改状态操作」指修改某状态字段值（模型/档位/预设/名称等）并期望 renderer store 副本随之更新的 RPC。这类操作有一个结构性竞态：**请求值 ≠ 生效值**——后端可能变换请求值（pi 钳制不支持的档位、pattern 引擎静默换模），也可能原样落盘。

对同一竞态，两个域做出了**相反裁决**（state-truth-sync §2.5 R3 的实证）：

- `useModel.ts`（model.switch / session.setThinkingLevel）：弃乐观写，以 reply 生效值唯一写 store——因为 pi 会变换请求值，乐观写 = 显示假值。
- `usePiPresets.ts`（preset CRUD）：乐观写 + reply 权威覆盖 + 失败回滚——因为 runtime 原样存储，乐观写无假值风险且有体验收益。

相反裁决并存的原因是没有「何时可乐观」的裁决标准。事故 B（设最高档过一会自动变关）正是乐观写请求值 + pi 钳制后无人回读的直接后果。C-pi-13 已登记「改状态 RPC 一律回生效值」，但它是 review 级人肉纪律——§2.4 元教训：人读登记挡不住复发（2026-08-20 登记的钳制观察项 8-27 照样出事）。

## 决策

### 一、裁决标准（两分支）

新增/修改任何 mutation RPC 时，先回答一个问题：**后端会不会变换请求值？**

| 分支 | 判据 | 前端写 store 规则 | reply 契约 | 代表实例 |
|---|---|---|---|---|
| **分支一：后端可变换** | 值最终由 pi 进程内状态决定，pi 可能钳制（thinking 档位）或静默换模（pattern 引擎同族匹配）；请求值只是意图 | **禁乐观写**。reply 生效值是唯一写 store 路径；RPC 失败不写 store（显示保持旧真值） | reply **必须**携带生效值字段（类型必需、不 optional）——它是显示态的唯一合法来源 | `model.switch` / `session.setThinkingLevel`（消费侧 `useModel.ts`） |
| **分支二：后端原样存储** | 值由 runtime 自有存储决定（JSON 落盘 / sidecar），落盘值 = 请求值（至多做规范化保护，保护失败即整体报错） | **允许乐观写 + reply 权威覆盖 + 失败回滚**。乐观写换即时响应，reply（或广播全量刷新）覆盖收敛，失败回滚保一致 | reply 应携带回显值字段（落盘后的权威态）；ack 型豁免见下方豁免清单 | `preset.create/update`（消费侧 `usePiPresets.ts`）、`session.setSubagentDefaultEngine` |

两个既有域恰好各居一侧——本 ADR 不改任何运行时行为，只把它们从「相反结论」变成「同一条规则的两个合法实例」。

判据的判别方法：读 runtime handler 的写路径。若最终写点经过 pi（set_model / set_thinking_level RPC 后 get_state 读回生效）→ 分支一；若最终写点是本地存储（preset-service 的 JSON 落盘、sidecar 原子写）→ 分支二。判断不了按分支一从严处理（禁乐观写无害，多一次回执等待；反向则复发事故 B）。

### 二、机器强制（两层）

1. **shared 协议类型层**（`packages/shared/src/protocol.ts`）：mutation reply 提取具名 `XxxMutationReply` interface，生效值字段类型必需不 optional，编译期强制。
2. **runtime 契约测试**（`packages/runtime/src/__tests__/mutation-reply-contract.test.ts`）：登记全部 mutation RPC 清单（`MUTATION_RPC_REGISTRY`），静态扫描 `ClientMessageType` 联合中的 mutation 形态与清单双向比对——**新增 mutation 不入清单即测试红**；清单内逐项断言 reply 契约（生效值字段 / 回显字段 / 豁免理由）。

### 三、mutation 清单与豁免登记（2026-09-08 现状盘点）

契约测试覆盖域 = **session 配置状态 / model / preset 三域**（D8 列举域）。逐项归类（runtime handler 行为均已实读核实）：

**分支一（effective-value 契约）**：

| RPC | reply | 生效值字段 | runtime 证据 |
|---|---|---|---|
| `model.switch` | `model.switched` | `provider` + `modelId`（get_state 读回拆解） | settings-message-handler `handleModelSwitch`：switchModel 返回 'provider/id' 生效复合串 |
| `session.setThinkingLevel` | `session.thinkingLevelSet` | `level`（pi 钳制后生效档） | settings-message-handler `handleSessionSetThinkingLevel`：setThinkingLevel 返回 effective |

**分支二（echo-value 契约，reply 携带回显字段）**：

| RPC | reply | 回显字段 | 说明 |
|---|---|---|---|
| `preset.create` | `preset.create` | `preset` | 原样存储回显；内置预设保护字段（id/builtin/order/name）规范化差异不回显，消费方以 preset.list 重拉为精确形状（W-TR-1 已知近似） |
| `preset.update` | `preset.update` | `preset` | 同上 |
| `session.setSubagentDefaultEngine` | `session.subagentDefaultEngineSet` | `engineId` | 写 config.json 后确认回显 |

**分支二（ack 豁免清单——reply 无回显字段，豁免理由逐条登记）**：

| RPC | 豁免理由 |
|---|---|
| `preset.setDefault` | ack 占位 reply；分支二原样存储 + 乐观写 + 失败回滚已闭环，无变换面（消费侧 usePiPresets.setDefault） |
| `preset.delete` | 删除语义无生效值可回显（成功 ack 即终态：值 = 不存在，幂等） |
| `preset.recordUsage` | 记账类 fire-and-forget，无显示副本语义 |
| `session.rename` | wire reply 实际回显 `{ sessionId, name }`（session-message-handler handleSessionRename）+ `broadcastSessionList` 全量广播；类型层登记 void（ack 消费）——权威覆盖由广播通道承担，豁免 reply payload 消费 |
| `session.setProject` | 同 rename：wire 回显 + broadcastSessionList 全量刷新 |

**非配置状态 mutation（excluded，排除理由登记）**：`session.switch`（视图路由非改状态值）、`session.create` / `session.delete` / `session.deleteByCwd` / `session.import` / `preset.import`（实体生命周期，终态语义走 session.created/deleted 等广播通道，无「生效值」概念）、`session.importCandidates`（导入候选预览，只读探测非状态写入，与契约测试 registry 9 项 non-mutation 清单一一对应）、`session.fork`（分叉创建新 session，与 session.create 同族：reply session.created 复用实体创建形态 + forkNotice/broadcastSessionList 广播；新 session 生效配置经 D6 继承链（staging override > 源生效值 > …）+ 读回播种承接，非 mutation 回执语义）、`session.handoff`（交接创建新 session，同族：reply message.status ack，完成经 session.handoffComplete 独立广播；承接配置经 D6 继承链）。

### 四、范围边界

以下**不在本契约覆盖域**（显式声明，非遗漏）：

- `config.*` 设置面板域（setTerminalConfig / setDefaultModel / setScopedModels 等）：reply 形态为「ack + 广播推回」或「read-back 型」，设置面板无乐观写模式，不在 D8 的「显示 ≡ 生效」事故面。若未来某 config mutation 出现乐观写需求，扩域方式 = 扩契约测试的域谓词清单（扩域本身是一次显式决策）。
- session 生命周期/承接创建族（`session.fork` / `session.handoff`）：谓词经 fork/handoff 动词命中后以 excluded 显式归类——二者是实体创建（与 session.create 同族）而非改状态值，reply 分别为 session.created 实体创建形态与 message.status ack，完成态走 forkNotice / handoffComplete 广播通道；新 session 的生效配置由 D6 继承链（fork：staging override > 源当前生效值 > 源 preset > 全局默认；handoff：staging override > 源当前生效值 > 全局默认）+ post-create 读回播种承接，不经 mutation 回执。
- session 视图路由族（`session.restore`）：行为近 `session.switch`（视图路由 + 读回播种），不改配置状态值、无乐观写面——显式声明 excluded，防未来 restore 语义演化时静默绕过谓词。
- 消息流注入（`message.*`）、动作类（`session.subagentAction` / `workflowAction` / `compact` / `forceQuit` / `session.abortHandoff`）、文件写（`session.writeImage` 等）、extension/plugin/git/worktree/quota/terminal 域。

### 五、新 mutation 接入检查单

新增（或修改）mutation 类 RPC 时：

1. **判是否 mutation**：谓词（契约测试动词表）命中后先问「这是不是改状态值」——实体生命周期（create/fork/handoff/import 族，终态走广播通道）或动作类（abort/compact/forceQuit 等）→ 以 excluded 登记排除理由即完成归类；是改状态值 → 进第 2 步。
2. **判分支**：读/定 runtime 写路径最终写点——经 pi（分支一）或本地存储（分支二）；判不了按分支一。
3. **分支一**：handler 内 set→读回生效值→reply 生效字段；shared 协议具名 `XxxMutationReply`（生效值字段必需不 optional）；ReplyPayloadMap 登记 payload 消费型（禁 void）；消费侧禁乐观写，reply 是唯一写 store 路径。
4. **分支二**：reply 携带回显字段（落盘权威态）；若确需 ack 型，必须在豁免清单登记理由（参照上表豁免项）；消费侧乐观写 + reply 权威覆盖 + 失败回滚。
5. **入清单**：到 `packages/runtime/src/__tests__/mutation-reply-contract.test.ts` 的 `MUTATION_RPC_REGISTRY` 登记条目（type / branch / 契约 / 理由）——漏登记测试即红，这一步是强制的最后一道闸。
6. **过 C-pi-15 review**（review-type-safety）：检查单 1-5 的执行情况。

## 后果

- 正面：G2（改状态即见生效值）从人肉纪律升级为「类型编译期 + 契约测试运行时」双机器强制；新 mutation 诞生即被套上契约，事故 B 形态复发的上游被拦截。
- 正面：`useModel` / `usePiPresets` 两种模式获得统一解释，消灭「两种相反裁决哪个对」的 review 争议——先判分支再选模式。
- 负面：新增 mutation 多一道清单登记手续（漏登记红——这是刻意的，强制显式决策）；豁免清单需要随 RPC 演进维护（豁免项消失要同步清理，契约测试双向比对兜底）。
- 已知近似：`preset.create/update` reply 回显请求值而非规范化后落盘值（W-TR-1 取消二次读）；消费方已有 preset.list 重拉兜底，升级为「读回落盘值」需改 runtime 行为，不在本 ADR 范围。

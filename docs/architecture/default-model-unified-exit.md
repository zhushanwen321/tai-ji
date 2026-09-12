# 默认模型统一出口：聚合校验 + 语义对齐 + 对账闭环 + 交互补齐

> **结论**：xyz-agent 的默认模型（default provider/model）从「设置 → 展示 → 持久化 → pi 生效」全链路存在结构性缺陷，核心根因是**校验基准只认 models.json 不认 auth.json catalog 凭据**（用户设置的默认模型在纯 catalog 场景被静默替换为 builtin 列表首模型）。对抗式审查（2026-08-12，含运行时 binary 实测；当日升级 0.84.1 后探针复测）修正了两个关键事实：① **pi `set_model` RPC 原生写默认模型**（切换即改全局默认是 pi 语义，xyz-agent 侧覆写是冗余同步而非根因）；② 设置页默认 pill 可点、fallback toast、空态区分**已落地**（commit e2aff464f，handoff P2 批次 1）。本文据此修订为四件套：**runtime 层默认模型校验基准聚合化**（对齐 listProviders 双源聚合语义）、**切换语义与 pi 对齐 + 可见性确认**（不再尝试剥离 pi 原生行为）、**pi 实际模型对账闭环**（get_state 为唯一真值源回写 session.modelId 缓存）、**剩余交互补齐**（导入/OAuth 引导设默认、模型能力 gate）。按「runtime 聚合 → 对账 → 前端引导 + 能力 gate」分三阶段实施。

---

## §1 背景目标

### SCQA

- **S（情境）**：xyz-agent 经 runtime 聚合 pi 的两套 provider 体系（catalog 内置凭据存 `auth.json` / custom 自定义存 `models.json`），默认模型两字段存 `settings.json`（`defaultProvider` + `defaultModel`）。用户设置默认模型后，新 session 启动时 runtime 经 `--model` 参数注入 pi 子进程。
- **C（冲突）**：用户在 Settings 里看到默认模型是 `mimo-v2.5-pro`，但新建 session 实际启动用的是 `mimo-v2-pro`——因为默认模型校验只认 `models.json`，纯 catalog 用户（凭据在 `auth.json`、`models.json` 为空的合法常态）必然落入 catalog 兜底分支，直接取 builtin 列表第一个模型，**不比对用户在 settings.json 里的选择**，且不写回、不提示。
- **Q（问题）**：怎么让「用户设置的默认模型」成为全链路唯一真值源——设置页能直接设、切换/导入/OAuth 等所有路径都收敛到同一语义、pi 实际用哪个前端能感知、模型能力（image）按实际模型正确 gate？
- **A（答案）**：四件套配套收口——① 校验基准从「models.json 单源」改为「双源聚合」（catalog ∪ auth ∪ custom），settings 用户意图优先，命中即返回；② 切换语义与 pi 原生行为对齐（pi `set_model` 写默认是已实测的原生语义，xyz-agent 不再尝试剥离，改为确保前端可见 + 设置页显式入口；③ 新增对账机制：session 启动/恢复后读 pi `get_state` 的 model 字段（实测存在）回写 `session.modelId` 缓存，消除「显示模型 ≠ pi 实际」漂移；④ 导入/OAuth 成功引导设默认、模型能力（image）按当前模型 gate（4 条图片通路统一收口）。

### 系统是什么

默认模型链路涉及三层（详见 provider 双体系聚合架构 `provider-config-pi-alignment.md`，已退役——git 历史 `eb884da68` 前版本可查）：

1. **数据文件**（`<dataDir>/pi/agent/`）：`models.json`（custom provider 全配置 + catalog override）、`auth.json`（凭据）、`settings.json`（`defaultProvider` + `defaultModel` + `enabledModels` 白名单）。**xyz-agent 与 pi 共用这三个文件**（`pi-settings-store.ts` 直读写同一路径）。
2. **runtime 读写与编排层**：
   - `pi-provider-store.ts`（`infra/pi/`）— models.json/settings.json 磁盘读写 + `findValidDefaultModel()` 校验/兜底/auto-fix
   - `provider-config-helper.ts`（`services/`）— `listProviders()` 双源聚合、`pickEnabledDefaultModel()` 凭据优先重选
   - `model-service.ts` — `switchModel()`（pi set_model RPC + 持久化 + 广播）
   - `settings-message-handler.ts` — config 域 RPC handler + `reconcileDefaultModelAfterProviderChange()`
   - `session-lifecycle.ts` / `rpc-client.ts` — session 创建时 `--model` 参数注入 pi 子进程
3. **pi 子进程**：per-session 独立进程。**版本基线：运行时 binary = 0.84.1**（`apps/electron/resources/pi/`，打包产物，2026-08-12 从 0.80.3 升级）；`node_modules` devDep 源码 = 0.84.1（仅 extensions 开发期类型参考，**不是运行时行为依据**——本文 pi 行为断言均以 binary 实测为准）。

### 设计目标（从使用者体验倒推）

| # | 使用者 / 维护者要能做到 | 现状（2026-08-12 实证） |
|---|---|---|
| G1 | 设置页设的默认模型 = 新 session 实际启动模型（三头一致：UI / settings.json / pi） | ❌ `findValidDefaultModel` catalog 兜底绕过 settings（根因） |
| G2 | Settings 页能直接设默认模型 | ✅ **已落地**（e2aff464f：默认 pill 可点 → ModelSelectPopover → setDefaultModel，testid=`provider-default-pill`） |
| G3 | 导入凭据 / OAuth 授权后可引导设默认 | ❌ 导入成功仅 toast（`useProviderImport.onImportConfirm` 零默认模型引用）；OAuth `onAuthorized` 回调是空函数（`ProviderPage.vue:269`） |
| G4 | 默认模型被系统 fallback 修正时用户可见 | ✅ **已落地**（e2aff464f：`onDefaultsWithSource` 消费 `config.defaults` broadcast，source ≠ `default-set` 且值变化时 toast） |
| G5 | 切换 session 模型的副作用（默认随之更新）**可见、可预测**，且设置页有显式入口（不依赖切换副作用作为唯一路径） | ⚠️ 部分：pi `set_model` 原生写默认（实测 0.84.1，与 0.80.3 行为一致）+ xyz-agent 侧冗余覆写；toast 已覆盖 `model-switch` source；剩余 = 语义确认 + 文档化 + 验收 |
| G6 | 不支持图片的模型（如 mimo-v2-pro，input 仅 text）在 UI 上禁用图片上传/粘贴并有提示 | ❌ 零 gate：粘贴/拖拽/菜单/命令 popover 4 条通路全部恒可用 |

### scope

- **当前层 → 下一层**：当前层 = 默认模型全链路统一出口的技术方案设计；下一层 = 可实现的接口签名 / RPC payload 变更 / 文件改动地图 / 测试任务。属**技术方案设计类**（准则 5/6/7 全 P0，验收要求真实环境跑通）。
- **in-scope**：
  - runtime：`findValidDefaultModel` 聚合化（校验基准 = 双源聚合）、catalog 兜底比对 settings、fallback 语义修正
  - runtime：切换语义与 pi 对齐（确认/保留 xyz-agent 侧显式同步、修正广播 source 协议漂移）
  - runtime：pi 实际模型对账（`get_state` 为真值源，session 启动/恢复后回写缓存）
  - runtime：`DefaultModelSource` 协议收敛（`'provider-change'` 字面量漂移修复）
  - renderer：导入/OAuth 成功引导设默认（G3）、模型能力 gate（G6，4 条图片通路统一收口）
- **out-of-scope**：
  - 剥离 pi 的 set_model 写默认行为（pi 原生语义，xyz-agent 不修改 pi 源码；「切换即设默认」作为产品语义接受并做可见性）
  - models.json / auth.json 存储结构改造（只动校验/编排语义）
  - model-switch extension 的 `switch_model` tool 行为接管（其「记账不生效」状态由对账机制暴露而非拦截）
  - 多 provider 并存的「智能默认」策略（按场景/cost 自动选默认）——model-switch extension 的职责

---

## §2 现状与问题分析

### 2.1 根因一：默认模型校验基准错位（G1 核心根因）

**真实复现**（feat-optimize-ui 分支，dev 环境实证）：

```
[用户] Settings 导入 xiaomi-token-plan-cn 凭据（存 auth.json，models.json 无条目）
[用户] 默认模型 mimo-v2.5-pro（settings.json: defaultProvider=xiaomi-token-plan-cn, defaultModel=mimo-v2.5-pro）
[新建 session] session-lifecycle.create → rpc-client.start()
   → getDefaultModel() → findValidDefaultModel()
      ├─ 主路径：models.providers['xiaomi-token-plan-cn'] = undefined（catalog provider 无 override 条目）
      ├─ D fallback：pickFirstModelProvider 扫 models.json = 空
      └─ E catalog 兜底：builtin-providers.json 遍历 → 命中 xiaomi（auth.json 有凭据）
          → 返回 { provider: 'xiaomi-token-plan-cn', modelId: bp.models[0].id }  ← 不比对 settings.defaultModel！
   → args.push('--model', 'xiaomi-token-plan-cn/mimo-v2-pro')  ← 实际启动 mimo-v2-pro
[composer 显示] settingsStore.defaultModel = 'xiaomi-token-plan-cn/mimo-v2.5-pro'  ← UI 显示 v2.5-pro
```

**三头**：UI / settings.json 显示 `mimo-v2.5-pro`；pi 实际启动 `mimo-v2-pro`（`packages/runtime/src/generated/builtin-providers.json` 实证：xiaomi-token-plan-cn models[0]=mimo-v2-pro，input 仅 `['text']`，连图片能力都丢了）；且 `wasFixed:false` 不写回 → 磁盘无自愈痕迹，前端无提示。

**根因**：`findValidDefaultModel()`（pi-provider-store.ts:287-351）的校验基准是「models.json 单源」——主路径只查 `models.providers[defaultProvider]`。但 `models.json` 与 `auth.json` 分离是 **pi 原生语义**：catalog provider 的模型定义在 builtin 目录（`builtin-providers.json`），凭据在 `auth.json`，`models.json` 只为 custom 条目和 catalog override 存在。纯 catalog 用户 `models.json` 为空是**合法常态**，却在这条路径上成为「默认模型校验失败」条件。三个出口（模型列表 `listProviders` 已聚合、可用性 `deriveEnabled` 已聚合、默认模型校验**未聚合**）——缺的正是默认模型这一块。

### 2.2 根因二：切换即改默认——pi 原生语义，非 xyz-agent 单方行为（G5）

**对抗式审查实证**（binary 实测：0.80.3 首测，0.84.1 升级后复测一致 + 源码链）：

- **pi 原生**：`set_model` RPC → `AgentSession.setModel`（agent-session.js:1194-1207）→ `settingsManager.setDefaultModelAndProvider()`（settings-manager.js:455-464）→ **写 settings.json 的 defaultProvider/defaultModel**。实测：probe6 场景（`--model` 启动后 `set_model` 到 mimo-v2.5）→ settings.json 被 pi 覆写为 `{defaultProvider: xiaomi-token-plan-cn, defaultModel: mimo-v2.5}`。
- **xyz-agent 侧**：`model-service.switchModel()`（model-service.ts:85-105）在 pi RPC 成功后也 `setDefaultModel` 持久化 + 广播 `config.defaults`（source: `'model-switch'`）——与 pi 行为**方向一致**（冗余但无害，值相同；若 pi 未来版本不再写默认，xyz-agent 侧仍保证语义）。

**结论修正**（相对初版文档）：初版把根因归为「xyz-agent 单方无条件覆写默认」并设计剥离动作——**审查实测推翻**：切换改默认是 pi 原生语义，xyz-agent 无法在不改 pi 的前提下剥离（`set_model` 后恢复旧默认会与 pi 内存态冲突，pi 下次 save 再覆写，竞态不可控）。因此 G5 重新定义为**可见性 + 显式入口**（见 §3.2 决策二），而非「切换不写默认」。

**仍成立的问题**：切换副作用曾是唯一设默认路径（无显式入口）；现已部分修复（pill 可点 + toast），剩余工作 = 确认语义一致性 + 验收。

### 2.3 根因三：pi 实际模型前端零感知（对账缺失）

- `event-adapter.ts` 全文 grep `model` 零命中；shared 对话 `Message` 类型无 model 字段（`BgNotifyRecord.model` 是 subagent 通知子记录，非对话消息流）。
- 前端模型显示链 = runtime 的 launch `--model` / `set_model` 回写缓存 → broadcast → sessionStore——**全部是「自己记的账」**。
- pi 进程内模型与缓存漂移的场景：pi 自身 fallback 生效（`--model` 被拒时 findInitialModel 5 级兜底）、settings.json 变更后既有 session 不重启、未来 extension 真切模型。
- **可对账**：pi `get_state` RPC 响应含 `model` 字段（实测：`{id, provider, name, api, input, ...}`，provider/id 分字段，回写需拼 `${provider}/${id}`）——对账真值源已实证。

### 2.4 根因四：剩余交互缺失（G3 + G6）与协议漂移

**2026-08-12 已落地**（commit e2aff464f，handoff P2 批次 1，本文不再列为待办）：

| 已落地项 | 位置 | 状态 |
|---|---|---|
| 默认 pill 可点 → 设默认 | `ProviderPage.vue:86-105`（ModelSelectPopover + provider-filter + `onSetDefaultModel` + testid） | ✅ |
| 空态区分「无模型」vs「无搜索结果」 | ModelSelectPopover 空态拆分 | ✅ |
| fallback 修正 toast | `ProviderPage.vue:340-355`（`onDefaultsWithSource`，source ≠ default-set 且值变时 toast） | ✅ |

**剩余问题**：

| 现象 | 实证 |
|---|---|
| **G3 导入凭据不引导设默认** | `useProviderImport.onImportConfirm`（L62-139）成功仅 toast + 复位；文件内零 defaultModel/setDefaultModel 引用 |
| **G3 OAuth 授权后不引导设默认** | `ProviderPage.vue:269` `useProviderOAuth(() => { void 0 })`——onAuthorized 空回调 |
| **G6 能力 gate 缺失** | 4 条图片通路全部恒可用：① 粘贴（`Composer.vue:383` `pasteImage: handleImagePaste`）；② 拖拽（`composer-shell.ts:193-194` `useComposerDragDrop` onDrop → pasteImage）；③ 菜单（`AddMenuPopover.vue:58` image 菜单项）；④ 命令 popover（`useCommandPopoverTrigger.ts:132` `insertImageBadge`）。`useImageAttachment.ts` 是无状态纯函数（不读模型 store），gate 无法在其内部实现 |
| **协议漂移：source 字面量** | `reconcileDefaultModelAfterProviderChange`（settings-message-handler.ts:52）广播 source 用 `'provider-change'`，不在 `DefaultModelSource` 联合类型（protocol.ts:545-549）内 |

**协议漂移为何编译未拦截**（归因修正）：`ServerMessage<T extends ServerMessageType = ServerMessageType>`（protocol.ts:1152-1166）泛型默认参数 `T=union` 时 payload 退化为全域联合；`ServerMessageMapBase & {[K in Exclude<...>]: Record<string, unknown>}` 的占位成员（protocol.ts:1142-1148）兜住非法值——**type 与 payload 的联动约束在 union 实例化下丢失**（最小复现 TS2322，但全仓 tsc 0 错误）。修复方向（改合法枚举值）不变；可选加固：broadcast 调用点把泛型钉到具体 type 恢复联动校验。

### 2.5 物理数据流（现状）

```
[设置页 pill（✅ 已可点）]   [使用页 ModelSelectPopover]   [导入 / OAuth]
        │ config.setDefaultModel      │ model.switch           │ 不引导设默认 ✗
        ▼                             ▼                        │
   settings.json { defaultProvider, defaultModel } ◄───────────┘
        ▲                             ▲
        │ pi set_model 原生覆写（0.84.1 实测）│ xyz-agent switchModel 冗余覆写
        │
        ▼
   getDefaultModel() = findValidDefaultModel()
      ├─ 主路径：只校验 models.json（catalog 凭据常态 → 必然落兜底）
      ├─ D: pickFirstModelProvider（只扫 models.json）
      └─ E: catalog 兜底 → bp.models[0].id（✗ 不比对 settings.defaultModel）
        │
        ▼
   rpc-client.start() → args.push('--model', 'provider/modelId') → pi 子进程
        │
        ▼
   pi: options.model →（无则）restoreModelFromSession → findInitialModel（settings 默认 + auth 校验）
        │
        ▼
   pi 实际模型 ──get_state.model 可读（实测）──✗──（无对账回写）──→ 前端 session.modelId（可能漂移）
```

**断裂点**：E 分支绕过 settings（§2.1）、对账缺失（§2.3）、G3 引导缺失 + G6 gate 缺失（§2.4）。

### 2.6 术语定义（锚定上述例子）

| 术语 | 定义 | 就是上面例子的 |
|---|---|---|
| **默认模型** | `settings.json` 的 `defaultProvider` + `defaultModel` 组合，新 session 无 override 时使用的模型 | §2.1 的 `xiaomi-token-plan-cn/mimo-v2.5-pro` |
| **catalog 兜底** | 校验失败时从 builtin-providers.json 选「凭据可解析」的 provider 的 models[0] | §2.1 E 分支返回 mimo-v2-pro |
| **wasFixed** | 校验发现默认失效并已重选（写回 settings.json）与否 | §2.1 E 分支 wasFixed:false（不写回） |
| **per-session 模型** | 某 session 实际使用的模型（pi 进程内 + `session.modelId` 缓存） | §2.2 session 切到 anthropic 后 pi 进程模型 |
| **对账（reconcile）** | 把 pi 实际模型（get_state 真值）回写 xyz-agent 缓存，消除显示漂移 | §2.3 缺失的机制 |
| **source** | `config.defaults` 广播的来源标签，区分用户动作 vs 系统修正 | protocol.ts `DefaultModelSource` |

---

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径 · 设置页设默认后三头一致（G1 + G2）**

```
[用户] Settings → xiaomi 卡片 → 点默认 pill（✅ 已可点）→ 弹层选 mimo-v2.5-pro → 确认
[renderer] config.setDefaultModel('xiaomi-token-plan-cn', 'mimo-v2.5-pro')
[runtime] settings-message-handler → settings.json 写回 → broadcast config.defaults { source: 'default-set' }
[renderer] settingsStore.defaultModel 更新 → pill / composer 联动
[新建 session] rpc-client → getDefaultModel() → findValidDefaultModel 聚合校验
   → settings.defaultProvider 在双源聚合（catalog 凭据已配）、defaultModel 在 models 中 → 命中，原样返回
   → --model xiaomi-token-plan-cn/mimo-v2.5-pro → pi 实际启动 v2.5-pro  ✅ 三头一致
```

**成功路径 · 导入/OAuth 后引导设默认（G3）**

```
[用户] Settings → 导入 xiaomi 凭据 → 成功（当前无默认或默认非新 provider）
[renderer] toast「凭据导入成功」+ 引导按钮「设为默认模型」→ 打开 ModelSelectPopover（provider-filter 限定该 provider）
[用户] 确认 → config.setDefaultModel → 同上链路
```

**失败路径 · fallback 修正可见（G4，✅ 已落地）**

```
[用户] 删除默认 provider
[runtime] removeProvider → 默认失效 → 重选 fallback → broadcast config.defaults { source: 'provider-deleted' }
[renderer] onDefaultsWithSource → toast「默认模型已因 provider 变更改为 xxx」✅ 已实现
```

**失败路径 · 切换副作用可见 + 显式入口（G5）**

```
[用户] session A 切到 anthropic → model.switch → pi set_model（原生写默认，0.84.1 实测）
[renderer] toast「默认模型已更新为 anthropic/...」（model-switch source，✅ 已实现）+ 设置页 pill 联动
[用户] 想改回 → 设置页点 pill 直接设（✅ 已实现），不依赖切换副作用
```

**失败路径 · 能力 gate（G6）**

```
[用户] 当前 session 模型 mimo-v2-pro（input:['text']）→ composer 图片上传按钮禁用 + 提示「当前模型不支持图片」
[用户] 粘贴/拖拽图片 → 拦截 + 提示「切换支持图片的模型（如 mimo-v2.5）」→ 恢复指引直达模型选择
```

**恢复指引**（准则 6，贯穿原则）：任何「默认模型不对 / UI 与实际不符」问题，第一检查点：
1. `~/.xyz-agent/pi/agent/settings.json` 的 `defaultProvider` / `defaultModel` 是否如用户所设（注意：切换过 session 模型后，该值会被 pi 原生覆写为切换值——这是预期行为）；
2. runtime 日志 `[provider-store]` 是否有 `defaultModel ... falling back` / `auto-fixed` warn（聚合化后新增 catalog miss 的 warn）；
3. `config.defaults` WS payload 的 `source` 字段（区分用户设置 vs 系统修正 vs 切换）；
4. 新建 session 后查 runtime 日志（`<dataDir>/logs/runtime-*.log`）的 pi 子进程启动行（含 `--model` 参数）——**注意**：`logs/pi-*.jsonl` 是 pi stdout 事件流 tee，不含 `--model`（审查 S-6 修正）；
5. 对账落地后直接验证 `get_state.model` 与 composer 显示一致。

### 3.2 多方案对比

#### 决策一：默认模型校验基准（G1 根因）

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 聚合校验（选）**：`findValidDefaultModel` 校验基准改为双源聚合（catalog ∪ auth ∪ custom，与 `listProviders` 语义对齐）——settings 的 defaultProvider 在聚合、defaultModel 在该 provider models、enabled、凭据已配 → 命中返回用户值；miss 才走 fallback 链 | 对齐「models.json 空 = 合法常态」的 pi 原生语义；与 listProviders / deriveEnabled 三出口语义统一；**消除「模型列表里有但默认校验不认」的第三类不一致** | 中：重构 findValidDefaultModel 内部逻辑（~80 行） | 实现位置决定是否引入双实现漂移（见 D1） | ✅ |
| B 短期止血：E 分支先比对 settings.defaultModel 在该 catalog provider 的 models 中，命中返回 | 最小（~10 行） | 低 | 只修 E 分支一处；其他 miss 形态（provider 被删、模型下线）仍走旧逻辑；语义仍是「models.json 优先」而非「用户意图优先」 | ❌ 作为 A 的过渡步骤，不单独实施 |
| C 委托 pi：spawn 不传 --model，让 pi findInitialModel 决定 | 零改动 | 零 | 失去默认模型确定性控制（getDefaultModel 守卫、UI 一致性全失效）；pi 的 settings 校验是「尽力而为」，模型缺失时报错路径在前端不可控 | ❌ 已否定 |

**推荐 A**。

#### 决策二：切换语义与 pi 对齐（G5 重定义）

**审查修正**：初版设计「model.switch 不再写默认（语义分离）」被实测推翻——pi `set_model` 原生写默认（§2.2），xyz-agent 无法在不改 pi 的前提下剥离。G5 从「切换 ≠ 改默认」改为「切换会改默认（pi 原生语义，**必须可见**）+ 显式入口存在」。

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 接受 pi 语义 + 可见性确认（选）**：保留 xyz-agent switchModel 的显式持久化 + 广播（与 pi 方向一致，作为「pi 未来不写默认」时的语义保证）；toast 已覆盖 model-switch source（✅ 已落地）；本设计只做**语义确认 + 验收固化**，不改行为 | 与 pi 原生语义一致，无对抗；切换可见性已实现 | 极低（≈0 代码改动，验收为主） | 「切换即设默认」对用户的惊喜语义——靠 toast + pill 联动消解；若未来产品要真正分离（切 session 不写默认），需 pi 上游支持（不在本设计 scope） | ✅ |
| B set_model 后 xyz-agent 恢复旧默认 | 表面达成「切换不写默认」 | 中 | **竞态不可控**：pi 内存 globalSettings 已更新，xyz-agent 只改磁盘，pi 下次 saveSettings 会再覆写磁盘；且与 pi 进程内模型状态矛盾（pi 认为默认已变） | ❌ |
| C 保留现状不做任何事 | 零 | 零 | G5 的「显式入口」已由 e2aff464f 补齐，剩余仅是语义确认与文档化——C 与 A 差距仅在验收投入 | ❌（A 的成本已接近 C，选 A） |

**推荐 A**。交付物从「删代码」变为「确认 + 文档化 + 验收场景固化」。

#### 决策三：pi 实际模型对账（G5 关联 / 漂移消除）

**审查修正**：初版设计「恢复时扫描 JSONL model_change entry」被推翻——① pi 恢复模型真值源是 `getSessionContextSettings`（session-manager.js:145-164）：**assistant message 的 provider/model 也是记账点**且路径后到者胜，model_change 不是唯一记账点；② JSONL **延迟写**（实测：无 assistant 消息的 session 无文件，AGENTS.md 规则 6 同源）；③ model-switch extension 的 `switchToModel` 只 `appendEntry('model_change')` **不真切模型**（index.ts:312-335 源码实证）——扫 model_change 会把假切换当真值回写缓存，制造新漂移。**对账真值源改为 `get_state`**（实测 0.84.1 响应含 `model` 对象，与 0.80.3 一致）。

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A get_state 对账（选）**：session 启动（initializeManagedSession 后）与恢复后各调一次 `get_state`，读 `model` 字段（`{provider, id}` 分字段，拼复合串）回写 `session.modelId` 缓存 + 与现值不一致时广播 `session.state_changed`；`set_model` 切换后现有回写保留（响应已知成功，值一致，无需额外调用） | pi 是真值源，xyz-agent 缓存是镜像，镜像在「启动 / 恢复」两个关键点追平；不引入轮询/事件流改造；get_state 已有调用点（rpc-client 读 thinkingLevel 处复用） | 中：get_state 调用 + 字段解析 + 回写广播 ~40 行 | get_state 是 RPC（有往返延迟，session 启动路径上可接受）；pi 版本升级后 model 字段形状漂移——解析处做容错（字段缺失时跳过对账，不阻塞） | ✅ |
| B 事件流补 model 字段（message_start 等带 model） | 实时，无对账延迟 | 高：event-adapter + shared Message 类型 + 前端消费三处改动；pi 事件流是否带 model 需验证 | pi 事件字段非协议承诺，升级可能漂移 | ❌ 当前不引入；作为 A 之上的未来增强 |
| C 不做对账 | 零 | 零 | 漂移不暴露（§2.3 后果持续）；能力 gate（G6）建立在错误模型上时反而误导用户 | ❌ |

**推荐 A**。

#### 决策四：能力 gate 的统一落点（G6）

**审查修正**：初版把 gate 落在 `useImageAttachment.ts` / `AddMenuPopover.vue` 两处——被推翻：图片入口实测 **4 处**（粘贴 / 拖拽 / 菜单 / 命令 popover），且 `useImageAttachment` 是无状态纯函数（不读模型 store），gate 无法在其内部实现。**gate 统一收口在 composer 编排层**。

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 统一能力查询 + 编排层 gate（选）**：① 数据：`ModelInfo` 补 `input?: Array<'text'\|'image'>`（model-mapper 透传，单点）；② 查询：新增 `useModelCapability` composable（读 `settingsStore.models` 当前 session 模型的 input，兜底 `settingsStore.providers`）；③ 消费：Composer 粘贴/拖拽入口拦截（`Composer.vue` paste handler + `composer-shell` drop handler）+ `AddMenuPopover` image 菜单项禁用 + `useCommandPopoverTrigger` 图片命令禁用；统一提示文案（带恢复指引：切换支持图片的模型） | 能力元数据进入模型列表，未来所有能力类 feature（多模态、reasoning 等）可挂；gate 单一入口，新通路自动继承 | 中：shared 类型 + model-mapper + composable + 4 消费点；ModelInfo 构造点（model-mapper / mock / fixture）同步扩展 | ModelInfo 是共享类型，构造点遗漏会类型错误（tsc 兜底）；mock 数据需补 input 字段（漏了测试会暴露） | ✅ |
| B 仅提示不禁用 | 低 | 低 | 用户操作后才知道不行，与 G6「禁用」目标不符 | ❌ |
| C 不做 | 零 | 零 | mimo-v2-pro 用户粘贴图片 → pi 报错 → 无恢复指引 | ❌ |

**推荐 A**。gate 位置说明：不在 `useImageAttachment` 内部（无状态纯函数、无 store 依赖，塞入会破坏其可测性），统一在调用它的编排层（Composer / composer-shell / AddMenuPopover trigger）做。

#### 决策五：G3 引导的交互形态

**审查修正**：初版「pill 点击弹模型选择」已落地（e2aff464f），决策五改为 G3 引导入口设计。

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 复用 ModelSelectPopover + provider-filter（选）**：导入/OAuth 成功后，若有引导需求（当前无默认 或 默认 provider ≠ 新导入 provider），toast 附带「设为默认模型」按钮 → 打开 ModelSelectPopover（provider-filter 限定新 provider）→ 选中调 setDefaultModel | 复用已落地的 pill 交互组件（e2aff464f 加的 provider-filter prop + trigger slot 正是为此设计）；零新组件 | 低：useProviderImport / useProviderOAuth 加引导状态 + ProviderPage 挂 dialog | 「无默认时自动设首个模型」vs「引导手动确认」二选一——**选引导**：自动设默认是隐含副作用（曾踩坑 2026-08-09：兜底写回覆盖用户配置），显式确认语义更安全 | ✅ |
| B 自动设默认（导入后无确认直接设首个模型） | 少一步交互 | 低 | 隐含覆盖用户可能已设的其他默认；与「用户意图优先」原则冲突 | ❌ |
| C 独立「默认模型」设置区块 | 最清晰 | 高 | 与 provider 卡片默认 pill 双入口维护成本 | ❌ |

**推荐 A**。

### 3.3 关键决策与权衡

#### 决策 D1：聚合校验的实现位置（防双实现漂移）

- **选择**：抽共享纯函数模块 `default-model-resolver.ts`（`services/` 层，与 provider-config-helper 同构：`configStore` / `authStorage` 参数注入），实现双源聚合校验 + fallback 链；`pi-provider-store.findValidDefaultModel` 保留磁盘读写纯函数定位，聚合校验委托 resolver（经 config-service facade 调用链）。
- **被否**：① store 内自实现轻量聚合（~50 行）——与 `listProviders`（provider-config-helper.ts:116-196，含 catalog 判定 / override models 合并 / auth 凭据判定 / enabled 派生）构成双实现，制造**第五个潜在不一致源**（本设计目标正是消除不一致）；② 直接把 listProviders 当校验基准——listProviders 返回 ProviderInfo（含显示名等），校验只需 id/models/enabled，且 store 层不应反向依赖 services 层。
- **证据**：resolver 是纯函数（无副作用、无 broadcast），与 provider-config-helper 的 `pickEnabledDefaultModel` 同模式；调用方（rpc-client `getDefaultModel`、session-lifecycle 守卫、config-service facade）经 config-service 委托，改动面 ~5 个 import 点。
- **探针 P5**：resolver 与 listProviders 对同一磁盘状态返回一致的「可用 provider/models」视图（单测断言）。

#### 决策 D2：catalog 兜底分支的语义修正

- **选择**：兜底遍历时**先比对 settings.defaultModel**——若 defaultProvider 在 catalog 且凭据可解析且 `settings.defaultModel` 存在于该 provider 的 models 中 → 返回 settings 值（wasFixed:false，不写回）；miss（settings 的 model 不存在 / settings 无 defaultProvider）→ 才取 `models[0]`（wasFixed:false，不写回）。
- **被否**：兜底命中后写回 settings.json（2026-08-09 回归教训：兜底写回覆盖用户配置，已定为不写回）。
- **证据**：settings 是用户显式意图，只要它仍有效（模型存在 + 凭据在）就必须被尊重；只有「用户意图失效」才轮得到系统兜底。不写回保持既有决策。

#### 决策 D3：对账的时机与容错

- **选择**：对账点 = session 启动后 + session 恢复后（各一次 `get_state`）；`set_model` 切换后不额外调用（响应成功即值一致）；get_state 的 model 字段缺失/解析失败时**跳过对账不阻塞**（pi 版本容错）。
- **被否**：轮询对账（每 N 秒 get_state——RPC 噪音，且启动/恢复两点已覆盖主要漂移面）；JSONL model_change 扫描（MF-3/MF-4：非唯一记账点 + 延迟写 + extension 假记账，见决策三审查修正）。
- **证据**：漂移场景枚举（§2.3）全部发生在「进程启动 / 恢复 / 切换」边界——启动与恢复两点对账覆盖进程生命周期内的模型确定；切换后值已知。扩展真切的模型（未来）会发生在进程内，前端感知依赖事件流（B 方案）——当前无此路径，对账不覆盖也正确。

#### 决策 D4：协议收敛（DefaultModelSource）

- **选择**：`reconcileDefaultModelAfterProviderChange` 的广播 source 从字面量 `'provider-change'` 改为按调用场景映射的枚举值：`provider-updated`（setProvider/toggle/import 后）或 `provider-deleted`（delete/remove 后）。`'model-switch'` 保留（决策二后仍是真实来源：pi 原生写默认 + xyz-agent 广播）。
- **被否**：把 `'provider-change'` 加进联合类型（冗余值，语义重叠）。
- **可选加固**（不阻塞）：broadcast 调用点泛型钉到具体 type（`broadcast<'config.defaults'>(...)`）恢复 type/payload 联动校验——修掉「union 实例化丢失约束」的机制洞（§2.4 归因）。

#### 决策 D5：能力 gate 的数据源与兜底

- **选择**：`ModelInfo` 补 `input?: Array<'text'|'image'>`（model-mapper 透传 `ProviderInfo.models.input`），`useModelCapability` 优先读 `settingsStore.models` 当前模型 input；input 缺失（旧数据）时**默认放行**（不 gate，避免误伤存量模型）。
- **被否**：只读 `settingsStore.providers` 不扩 ModelInfo（composer 的当前模型匹配走 models 而非 providers，跨 store 查询破坏局部性）；input 缺失时默认禁用（存量模型无能力元数据，误禁图片会阻断既有用户工作流）。
- **证据**：`model-mapper.ts:54-55` 注释「ModelInfo 类型无此字段」是写路径显式丢弃（单点补回）；ProviderInfo.models.input 已被设置页能力编辑消费（core use-provider-edit.ts:407），字段语义成熟。

### 探针清单（准则 7，实施期门槛）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| **P1** | `get_state` 响应含 model 字段及形状 | **✅ 已实证（0.84.1 binary 实测，0.80.3 同）**：`state.model = {id, provider, name, api, input, ...}`（provider/id 分字段，回写拼复合串） | ✅ |
| **P2** | pi `set_model` 写 settings.json 默认 | **✅ 已实证（0.84.1 binary 实测，0.80.3 同）**：set_model 后 settings.json 被覆写；源码链 agent-session.js:1194-1207 → settings-manager.js:455-464 | ✅ |
| **P3** | model-switch extension 的 switch 是否真切模型 | **✅ 已实证（源码）**：`switchToModel` 只 `appendEntry('model_change')`，无 pi 切模型 API（index.ts:312-335）——记账不生效 | ✅ |
| **P4** | pi 事件流（message_start 等）是否带 model 字段 | 未测（B 方案升级依据，不阻塞 A 实施） | ⛔ 可选 |
| **P5** | 聚合校验 resolver 与 listProviders 视图一致 | resolver 与 listProviders 对同一磁盘状态返回一致「可用 provider/models」（单测断言） | ⛔ Phase 1 |
| **P6** | 聚合校验后三头一致 | 设默认 mimo-v2.5-pro → 新建 session → 断言 `--model` 参数 = settings.json 值 = UI pill 值 | ⛔ Phase 1 |
| **P7** | 对账回写生效 | 启动/恢复后 `get_state.model` 与 `session.modelId` 一致；人工改 pi 进程模型（模拟 extension 真切）后恢复 → 缓存追平 | ⛔ Phase 2 |

> pi 行为断言基线：运行时 binary 0.84.1（`apps/electron/resources/pi/pi-darwin-arm64`，2026-08-12 从 0.80.3 升级，探针 P1/P2 复测通过）。源码参考 `node_modules/@earendil-works/pi-coding-agent` 0.84.1（**仅类型参考，非运行时行为依据**）；未来 binary 升级（`scripts/prepare-pi-resources.sh`）后需重跑 P1/P2 探针确认行为未变。

---

## §4 验收（真实场景，非单测）

> 验收环境：feat-optimize-ui worktree `pnpm dev` + Playwright 连 9222（dev renderer）；runtime 日志 `~/.xyz-agent-dev/logs/`。每个场景回溯 §1 目标编号。

### 场景 1（验证 G1 + G2）：设置页设默认后三头一致

```
[准备] dev 环境：xiaomi 凭据已导入 auth.json；settings.json 无默认（或任意旧值）
[1] Settings → xiaomi 卡片 → 点默认 pill → 弹层选 mimo-v2.5-pro → 确认
[2] 断言（实时）：settingsStore.defaultModel = 'xiaomi-token-plan-cn/mimo-v2.5-pro'；pill 文案跟随
[3] 断言（磁盘）：cat settings.json → defaultProvider=xiaomi-token-plan-cn, defaultModel=mimo-v2.5-pro
[4] 新建 session → 断言 runtime 日志（runtime-*.log）pi 子进程启动行含 --model xiaomi-token-plan-cn/mimo-v2.5-pro
[5] 新 session composer 显示 mimo-v2.5-pro（= 启动值 = 磁盘值）✅ 三头一致（G1）
[6] 断言 get_state.model 与 composer 显示一致（对账落地后）✅
```

### 场景 2（验证 G3）：导入凭据后引导设默认

```
[准备] 清空全部 provider（models.json providers 空 + auth.json 无凭据）
[1] Settings → 导入 xiaomi 凭据 → 成功
[2] 断言：toast「凭据导入成功」出现；「设为默认模型」引导按钮可见（当前无默认）
[3] 点引导 → ModelSelectPopover 弹出且 provider-filter 限定 xiaomi → 选 mimo-v2-pro → 确认
[4] 断言：settings.json defaultModel=mimo-v2-pro；pill 显示
[5] 新建 session → --model xiaomi-token-plan-cn/mimo-v2-pro ✅
```

### 场景 3（验证 G4 + G5）：fallback 修正可见 + 切换副作用可见

```
[准备] 默认 = xiaomi-token-plan-cn/mimo-v2.5-pro
[1] Settings → 删除 xiaomi provider
[2] 断言：toast「默认模型已变更为 xxx」（source='provider-deleted'，✅ 已落地行为回归验证）
[3] 新建 session → 启动模型 = 新默认（fallback 重选结果）
[4] 活跃 session 切模型到 anthropic/claude-haiku-4-5
[5] 断言：toast「默认模型已更新」（model-switch source）；settings.json 两字段 = anthropic（pi 原生覆写，预期行为）
[6] 断言：设置页 pill 跟随显示 anthropic ✅（G5：副作用可见 + 显式入口存在）
```

### 场景 4（验证 G6）：模型能力 gate

```
[准备] 当前 session 模型 = mimo-v2-pro（input:['text']；注意口径：composer 模型 = session.modelId，非默认模型——landing 态两者一致）
[1] 断言：composer 图片上传按钮禁用（或点击给出提示）
[2] Cmd+V 粘贴图片 → 断言：拦截提示「当前模型不支持图片」+ 恢复指引（可跳转模型选择）
[3] 拖拽图片 → 断言：同 [2] 拦截
[4] 命令 popover 图片项 → 断言：禁用
[5] 切模型到 mimo-v2.5（input:['text','image']）→ 图片上传按钮恢复可用 → 粘贴成功 ✅
[6] 反向：ModelSelectPopover 每个模型可见能力标记（如「图片」徽标，若实现）
```

### 场景 5（验证对账）：pi 实际模型回写缓存

```
[准备] 一个活跃 session，前端显示模型 M1
[1] 直接改 settings.json 默认模型为 M2（模拟外部变更）→ 不重启 session → 断言：当前 session 模型不变（per-session 独立性）
[2] 重启 session（恢复）→ 断言：get_state.model 回写 session.modelId，composer 显示与 pi 实际一致（日志对照）
[3] 边界：新建 session 不发任何消息 → 立即关闭重开 → 断言：恢复正常且模型一致（无 JSONL 场景，对账走 get_state 不受延迟写影响）
[4] 断言：provider 增删时 config.defaults 广播 source ∈ {provider-updated, provider-deleted}（无 'provider-change' 字面量）
```

---

## §5 下一层拆分（实施路径）

### 实施路径：三阶段，每阶段独立可验收 / 可回滚

```
Phase 1 运行时聚合校验（决策一 + D1/D2 + D4 协议收敛）  →  Phase 2 对账闭环（决策三 + D3）  →  Phase 3 前端引导 + 能力 gate（决策五 + 四）
```

依赖顺序理由：Phase 1 是纯 runtime 修复（G1 根因），先行让「设什么用什么」成立；Phase 2 依赖 Phase 1 的校验语义（对账的「pi 真值」与「xyz-agent 期望值」只有在校验正确后才可比对）；Phase 3 的引导与 gate 依赖前两阶段语义稳定（gate 基于 session 模型真值，对账后更准）。

### Phase 1：运行时聚合校验（runtime 包，无 renderer 改动）

- **改动文件**：
  - `packages/runtime/src/services/default-model-resolver.ts`（**新增**）— 双源聚合校验 + fallback 链（决策一 A + D1）
  - `packages/runtime/src/infra/pi/pi-provider-store.ts` — `findValidDefaultModel` 委托 resolver（保留读盘纯函数定位）；catalog 兜底先比对 settings.defaultModel（决策 D2）
  - `packages/runtime/src/transport/settings-message-handler.ts` — reconcile 广播 source 改合法枚举值（决策 D4）
  - `packages/shared/src/protocol.ts` — `DefaultModelSource` 注释更新（'provider-change' 修复后无新增成员；可选加固：broadcast 泛型钉死）
- **验证**：探针 P5/P6 + 既有 vitest（`npx vitest run` 于 `packages/runtime`，testCwd 指定）——findValidDefaultModel 相关用例更新（新增「catalog 凭据 + settings 命中」「settings model 不存在于 catalog → 兜底 models[0]」用例）
- **验收门槛**：场景 1 的 [1]-[6] 全绿

### Phase 2：对账闭环（runtime 包）

- **改动文件**：
  - `packages/runtime/src/services/session/session-service.ts` — `initializeManagedSession` / 恢复流程后调 `get_state` 读 model 回写 `session.modelId`（不一致时广播 `session.state_changed`）；get_state 字段缺失时跳过不阻塞（决策 D3）
  - `packages/runtime/src/infra/pi/rpc-client.ts` — get_state 响应类型补 `model` 字段（形状见探针 P1）
- **验证**：探针 P7 + 单测（get_state 返回 mock 模型 → 断言回写 + 广播）
- **验收门槛**：场景 5 全绿（含 [3] 无 JSONL 边界）

### Phase 3：前端引导 + 能力 gate（renderer / shared / core 包）

- **改动文件**：
  - `packages/shared/src/provider.ts` — `ModelInfo` 补 `input?: Array<'text'|'image'>`
  - `packages/runtime/src/services/model-mapper.ts` — toModelInfo 透传 input（单点）
  - `packages/renderer/src/composables/features/model/useModelCapability.ts`（**新增**）— 当前 session 模型能力查询（决策四 A + D5）
  - `packages/renderer/src/components/panel/Composer.vue` — 粘贴入口 gate（`pasteImage` handler）
  - `packages/renderer/src/composables/panel/composer-shell.ts` — 拖拽入口 gate（`useComposerDragDrop` onDrop 链路）
  - `packages/renderer/src/components/panel/AddMenuPopover.vue` — image 菜单项禁用 + 提示
  - `packages/renderer/src/composables/panel/useCommandPopoverTrigger.ts` — 图片命令禁用
  - `packages/renderer/src/composables/features/settings/useProviderImport.ts` / `useProviderOAuth.ts` — 导入/OAuth 成功引导设默认（决策五 A）
  - `packages/renderer/src/components/settings/provider/ProviderPage.vue` — 引导 dialog 挂载（复用 ModelSelectPopover provider-filter）
- **验证**：场景 2 / 4 全绿 + 既有 ModelSelectPopover / ProviderPage 测试更新（引导、gate 新增用例；mock model fixture 补 input 字段）
- **验收门槛**：场景 1-5 全绿

### 回归关注（跨阶段）

- **provider-arch-hardening.md 衔接**：该文档的 ProviderId 品牌类型 / reconcile helper 已落地——Phase 1 不得破坏品牌类型边界（`defaultProvider as ProviderId` 反序列化提升点保留）；resolver 复用 `deriveEnabled`（provider-catalog）语义
- **mock 对齐**：`api/mock/index.ts` 的 setDefaultModel mock 已有；ModelInfo 补 input 后 mock model fixture 需同步（漏了测试会暴露）
- **测试框架**：vitest（`packages/runtime` / `packages/renderer` 各自 vitest.config.ts），禁 node:test；wave design 填 `testCwd`
- **pi 版本**：运行时 binary 0.84.1 行为基线（2026-08-12 升级，P1/P2 复测通过）；未来 binary 升级后重跑探针 P1/P2
- **行号引用**：本文行号以 2026-08-12 feat-optimize-ui HEAD 为准；实施前如有漂移以实际代码为准

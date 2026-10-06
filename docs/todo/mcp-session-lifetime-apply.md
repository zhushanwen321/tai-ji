# TODO：MCP 会话内生效与 pi 升级跟随（I2 / I4 / 方案 D / type 闭集 / subagent 旗标——pi-mcp-management 增量裁决观察项）

状态：观察中——五项均按「触发条件出现才重评」管理，触发前不行动；前三项为待裁决取舍（同触发链），第四项为 pi 升级维护义务，第五项为 subagent 能力扩展观察项。源自 pi-mcp-management 设计增量裁决（§3.1 增量表 I2/I4、§3.2 方案 D、§3.3 D4、§5 U1 辐射面），随该设计交付登记。

## 背景

pi-mcp-management 已交付「写文件、新会话生效」的 MCP 管理模型：设置页 MCP 分区读写 `<数据目录>/agent/mcp.json`（唯一读写层 `packages/runtime/src/infra/pi/pi-mcp-store.ts`），配置由新启动的会话读取，运行中会话不感知。生效语义 = 新会话读取是有意裁决（与扩展启停、settings.json 同一模型），不追求会话内即时生效。本文件登记该裁决的观察项与维护义务：各登记项写明触发条件与届时重评落点，登记本身不构成行动项。

## 1. I2：会话内即时生效（自建扩展通道）——不做

裁决依据：pi 扩展 API `registerMcpServer`/`unregisterMcpServer` 只作用于扩展自注册的服务器（会话级、不落盘、文件配置同名优先），对文件配置的服务器无启用/禁用 API；唯一会话内重载通道 `session.reload()` 重建全部扩展（taiji 全部扩展的状态与标记通道清零），代价与收益不成比例——自建扩展买到的「即时生效」只覆盖新增场景，启停/删除等操作依旧要新会话。

**触发条件**（满足其一开始重评）：
- 用户反馈「切会话生效麻烦」成为高频诉求；
- 上游补 MCP RPC 命令（与下条方案 D 同触发）。

**重评前置**：`session.reload()` 对 taiji 扩展族的副作用实证（设计期仅代码推演、未实机复现）——届时先做该实证再评估方案。

## 2. I4：项目级 `.pi/mcp.json` 界面管理——不做

裁决依据：面向「项目要求的服务器」场景，无已发生的需求证据。现行语义（已交付）：taiji 会话基座恒带 `--approve`（运行态信任会话目录），每个会话都会读取并合并 `<会话cwd>/.pi/mcp.json`，同名条目**整条覆盖**用户级；设置页清单与连接测试只反映用户级文件——该覆盖偏差已由设置页页头覆盖说明显式化，UI 不编造合并态。

**触发条件**：用户反馈「清单改了不生效 / 清单里没有的服务器出现」的覆盖困惑成为诉求。

**届时升级路径**：设置页清单消费 `pi mcp list --json` 输出的 scope 字段，做项目级条目只读展示；届时连接测试需携带会话 cwd 重评（现行 cwd 恒 = taiji 数据目录，项目级不被读取）。

## 3. 方案 D：等上游补 MCP RPC 命令——不采用为方案，保留为触发条件

裁决依据：pi 1.0 RPC 命令面无任何 MCP 专属命令，无时间表；不作为本功能的实现路径。

**定位**：I2 与 I4 的重评触发条件之一。上游补 MCP RPC 命令时，I2（会话内生效）与 I4（项目级管理）一并重评；届时在既有 mcp 读写层（`pi-mcp-store.ts`）上接 RPC 通道，不另起抽象。

## 4. D4：type 三值闭集 pi 升级跟随（维护义务，非观察项）

义务内容：taiji 保存校验的 `type` 合法值闭集（`"stdio"` / `"http"` / `"streamable-http"`，落点 `packages/runtime/src/infra/pi/pi-mcp-store.ts` 的 `MCP_TYPE_VALUES`）对齐的是 pi 实装校验器 `validateMcpServerConfig` 的 type 分支条件，非文档化承诺。pi 版本升级若扩展 `type` 合法枚举（`sse` → `streamable-http` 的演化史证明该枚举会变），taiji 闭集不同步即误拦 pi 实际接受的粘贴条目。

**执行点**：pi 升级 PR 必查 pi `validateMcpServerConfig` 的 type 分支条件与 taiji 闭集一致性（对齐 C-proc-08 版本门禁的探针重验惯例）。落地形态 = 并入 `scripts/check-pi-semantics.mjs` 探针族；当前尚未并入，pi 升级 PR 人工必查，并入后本条改为机器门禁承载。

## 5. U1：subagent 模板 `builtin:mcp` 旗标重评

现状：主 agent spawn 模板恒带 `--extension builtin:mcp`（`packages/pi-rpc/src/spawn-args.ts`），subagent 模板**不加**该旗标——默认 subagent 完全无法使用 MCP 工具。该损失为本期有意裁决接受：无 MCP 消费用例证据、装载后 N 个并行 subagent × M 个启用服务器的连接与启动延迟放大、按「不加投机性功能」原则不预付。

**触发条件**：需要 MCP 工具的 subagent 用例真实出现时重评（与 I2/I4 同处观察）。届时装载后 `mcp__*` 工具对未声明 `tools` 白名单的默认 subagent 即可达（pi 工具过滤仅在白名单存在时生效、白名单不被扩展突破），需同步评估是否给相关 agent 定义引入 `tools` 白名单约定以收窄暴露面。

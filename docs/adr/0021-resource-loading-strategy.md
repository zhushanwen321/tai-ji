# 0021: Agent / Skill 资源加载策略

**状态**: Accepted　**日期**: 2026-06-19　**关联**: [ADR-0020](archive-digest.md#adr-0020)（核心 flow，archive-digest）、PRODUCT.md（复用 pi 能力）

## 背景

xyz-agent 复用 pi 的 agent/skill 能力，但 `infra/pi/` 桥接层把 pi 的 `agentDir` 重定向到隔离的 `~/.xyz-agent/pi/agent/`。结果：用户在 `~/.pi/`、`~/.claude/`、`~/.agents/` 已积累的 agent/skill **全部不可见**，要用就得复制一份——与「从别的 agent 快速切换过来、零迁移成本」的核心目标直接冲突。

事实核实（pi-mono + xyz-agent 源码）：
- pi **原生只认 4 类资源**（extensions / skills / prompts / themes），**不扫 subagent `.md`**——subagent 是 `examples/extensions/subagent/` 那个 extension 扫 `getAgentDir()/*.md` 注册的，写死单目录
- pi skill 自动扫 4 根：`~/.pi/agent/skills/`、`~/.agents/skills/`（全局）+ `{cwd}/.pi/skills/`、`{cwd}/.agents/skills/`（往上找祖先）
- pi 原生支持 `additionalSkillPaths` / `additionalExtensionPaths`（官方扩展机制）
- xyz-agent 现状：agent 靠自写 `listAgentFiles/writeAgentFile` 扫 `~/.xyz-agent/pi/agent/agents/`；skill 靠 `pi-provider-store` 的 `getSkillPaths/addSkillPath`

agent 和 skill 的加载模式同构（多来源扫描 + 启用/禁用 + 全局/项目双维度），本 ADR 一并裁决。

## 决策

### 1. 主策略：discovery.json 单一真相源 + 路径注入（零复制）

外部已有资源**不复制**。xyz-agent 写一个 `discovery.json` 作为唯一真相源，subagents extension 从它读路径注入 pi。

**文件位置**：`<agentDir>/subagents/discovery.json`（xyz-agent 的 agentDir = `~/.xyz-agent/pi/agent/`）

```json
{
  "version": 1,
  "skillDirs": ["~/.pi/agent/skills", "~/.claude/skills", "~/.agents/skills", ".agents/skills"],
  "agentDirs": ["~/.pi/agent/agents", "~/.claude/agents", "~/.agents/agents", ".agents/agents"]
}
```

> **强制目录不进 discovery.json**：xyz-agent 自己的运行时目录（`~/.xyz-agent/skills` · `~/.xyz-agent/agents` 全局 + `.xyz-agent/skills` · `.xyz-agent/agents` 项目）由桥接层**硬编码注入**——pi 的 `agentDir` 已重定向到 `~/.xyz-agent/pi/agent/`，pi 原生实际扫的就是这些，**不可关、不可拖**，优先级最高。discovery.json 只存用户勾选的**可选外部目录**。
>
> **可选目录靠前覆盖靠后（可拖排序）**：`skillDirs` / `agentDirs` 数组顺序即优先级——xyz-agent 完全控制 discovery.json，数组靠前的胜出。UI 暴露为**可拖动排序**的列表（见 §5）。skill 与 agent **统一此模型**（重定向后 pi 原生的复杂 5 路优先级被桥接层屏蔽，对外只暴露「强制 + 可选拖动」）。

`skillDirs` / `agentDirs` = **目录级管道**（决定哪些目录的数据流进来，对应 UI「层 A·加载路径配置」）。全局来源（`~/.pi` · `~/.claude` · `~/.agents`）+ 项目来源（`.agents/`）在全局 settings 勾选，写 discovery.json，**靠前覆盖靠后、可拖排序**。**无文件级开关**——目录里的资源全开（目录在=启用），UI 实体列表只读预览，同名多来源时合并显示、来源 badge 按优先级排序、第一个标「生效」（见 §5）。

**数据流（三条，单一文件两处读 + 一处写时过滤）**：

| 数据 | 谁读 discovery.json | 喂给谁 |
|------|---------------------|--------|
| `skillDirs` | subagents 的 `resources_discover` 处理器 | 主 agent 的 resourceLoader（skill） |
| `skillDirs` | subagents 的 session-factory | 子 agent 的 `additionalSkillPaths`（skill） |
| `agentDirs` | 主进程 AgentRegistry 多目录扫描 | agent `.md` 发现（子 session 自动继承解析结果，无需读文件） |

> **关键修正（基于 pi-mono 源码核实）**：argv `--skill`（来源 B）和 `resources_discover` 动态注入（来源 C）在子进程**丢失**——子 session 不读 argv、不装 extensionRunner。所以子 agent 的 skill 必须由 session-factory 从 discovery.json 读 `additionalSkillPaths`，不能依赖 argv。主 agent skill 走 `resources_discover`（subagents extension 监听，喂主进程 resourceLoader）。两条路各管各的，数据源同一个 discovery.json——主子一致、零重复。
>
> **pi install 装的 skill（来源 A）正交**：存 `<agentDir>/settings.json` 的 enabledSkills，子进程读同一文件自动继承，**不进 discovery.json**，UI 只读呈现（见 §5）。

### 1.1 加载优先级与覆盖顺序（skill / agent 统一）

**前提修正**：之前误以为「pi 原生强制扫 `~/.pi/agent/skills` 等标准目录」。核实——xyz-agent 桥接层把 pi 的 `agentDir` **重定向到 `~/.xyz-agent/pi/agent/`**，所以 pi 原生 auto-discovery 实际扫的是 `~/.xyz-agent/pi/agent/skills/`（≈ `~/.xyz-agent/skills`），**不是** `~/.pi/`。外部目录（`~/.pi` · `~/.claude` · `~/.agents` · `.agents`）对 xyz-agent 全是「需注入才加载」的可选源。这**统一了 skill 与 agent**——两者都是「强制 = xyz-agent 目录 / 可选 = 外部目录」，不再有「skill pi 原生强制 / agent 全靠 discovery」的差异。

**统一优先级模型**（从高到低）：

| 层 | 目录 | 性质 | UI |
|----|------|------|----|
| 1 强制·项目 | `.xyz-agent/skills` · `.xyz-agent/agents` | xyz-agent 项目运行时，桥接层硬编码，最高 | 只读·不可关不可拖 |
| 2 强制·全局 | `~/.xyz-agent/skills` · `~/.xyz-agent/agents` | xyz-agent 全局运行时，桥接层硬编码 | 只读·不可关不可拖 |
| 3 可选 | `~/.pi` · `~/.claude` · `~/.agents` · `.agents` + 自定义 | discovery.json `skillDirs`/`agentDirs`，用户勾选 | 可勾选·**可拖排序** |

> **强制项目 > 强制全局**：遵循 PRODUCT「项目覆盖全局」的数据隔离原则。

**同名覆盖规则**（skill / agent 一致）：
- 强制目录 > 可选目录（强制永远胜出）
- 同层内：可选目录按 `skillDirs`/`agentDirs` **数组顺序**，靠前覆盖靠后（xyz-agent 完全控制数组，可拖排序）
- entity 列表展示：同名多来源时**合并为一个条目**，来源 badge 按优先级排序，**第一个标「生效」**，其余标来源路径（见 §5）

> **pi 原生 5 路优先级被屏蔽**：pi 原本的 argv > settings > auto-discovery > resources_discover 复杂顺序，因 xyz-agent 完全控制 pi 启动参数（agentDir 重定向 + discovery.json 注入），对外只暴露上述「强制 + 可选拖动」模型。pi install 装的 skill（settings.json enabledSkills）仍子进程自动继承、不进 discovery.json，UI 只读呈现（见 §5）。

### 2. 全局来源（三目录扫描注入）

| 来源 | 路径 | 说明 |
|------|------|------|
| Pi | `~/.pi/agent/skills/` · `~/.pi/agent/agents/` | pi 默认目录（agentDir 重定向后非原生扫，可选注入） |
| Claude Code | `~/.claude/skills/` · `~/.claude/agents/` | Claude Code 用户目录（纳入 = 覆盖另一半目标用户） |
| 公共 | `~/.agents/skills/` · `~/.agents/agents/` | 行业约定，多 agent 共享 |

### 3. 项目来源

| 性质 | 路径 | 说明 |
|------|------|------|
| 强制 | `.xyz-agent/skills/` · `.xyz-agent/agents/` | xyz-agent 项目运行时目录，桥接层硬编码，最高优先（§1.1 层 1） |
| 可选 | `.agents/skills/` · `.agents/agents/` | 行业约定目录，用户勾选才加载，可拖排序（§1.1 层 3） |

同名冲突统一走 §1.1 规则：强制 > 可选，可选内按 `agentDirs`/`skillDirs` 数组顺序（靠前胜出）。skill 与 agent 一致。

### 4. `.xyz-agent/` 的双重角色

`~/.xyz-agent/`（全局）+ `.xyz-agent/`（项目）是 xyz-agent 的**运行时根目录**，兼两职：
- **强制资源加载**：`skills/` · `agents/` 子目录由桥接层硬编码注入 pi（§1.1 层 1-2，最高优先、不可关）——放在这里的资源永远生效，是「我的核心 agent/skill」的权威落点。
- **运行时配置**：`config.json`、pi bridge 状态等。

外部 agent 目录（`~/.pi` · `~/.claude` · `~/.agents` · `.agents`）放**可选、可替换**的资源——用户勾选才加载，可拖排序，关掉不影响核心运行时。

### 5. 配置粒度：只到目录级，无文件级开关（目录在=全开）

**决策**：UI 不提供单个 skill/agent 的启用/禁用开关。配置粒度收敛到**目录级**——勾选哪些目录加载，目录里的资源就全开。「目录在 = 启用」是行业心智（Claude Code、pi 都这样），放弃黑名单/白名单的文件级控制。

**为什么砍掉文件级开关**：
- 黑名单/白名单引入额外认知成本（「目录里新增的文件默认全开」需用户确认），收益却低——绝大多数用户的需求是「我要加载 pi 的 skill」而非「我要加载 pi 的 skill 但禁掉其中某一个」。
- 少数需要细粒度控制的场景（如禁用某 skill），由 pi 自己的 `/skills` 命令或直接从目录移除文件解决，不必在 xyz-agent 的 UI 里再造一套。

**配置入口（全局 settings 唯一配置面，决策 `global_configures_project`）**：
- **强制目录**（`~/.xyz-agent/` 全局 + `.xyz-agent/` 项目）：UI 只读展示「强制·不可关」，置顶，不进 discovery.json。
- **可选加载路径**：勾选 `~/.pi/agent/` · `~/.claude/` · `~/.agents/`（全局绝对路径）+ `.agents/`（项目相对路径），可加自定义路径。**可拖动排序**——拖动改变 discovery.json 数组顺序，靠前覆盖靠后（§1.1 层 3）。
- **项目路径也在全局 settings 配**——一次配好，所有项目按此约定加载；项目抽屉不再有配置入口（只读展示生效结果）。
- 勾选 + 排序状态写 discovery.json 的 `skillDirs` / `agentDirs`，触发注入/扫描重跑。

**pi install 装的 skill（来源 A，settings.json enabledSkills）**：子进程自动继承，**不在 discovery.json**，UI **只读呈现**（标来源 `pi-install`，开关锁死，改它去 pi 自己的 `/skills` 命令）——否则用户困惑「为什么这个 skill 关不掉」。

**实体列表来源 badge（覆盖可视化）**：扫到的同名资源合并为一个条目，来源 badge 按 §1.1 优先级排序（强制 > 可选，可选内按数组顺序），**第一个标「生效」**，其余标来源路径。单来源条目即生效，不额外标注。这让用户在列表里直接看到「这个 agent/skill 从哪来、如果有多个谁生效」。

**项目级 agent 的硬约束（AgentRegistry 单例）**：AgentRegistry 在主进程 ModelConfigHub 内，是 **app 级单例**，一个 app 多项目并发时项目级 `agentDirs` 无法 per-session 切。
- **UI 诚实标注**（决策 `ui_limit`）：项目抽屉 agent 段标「会话启动时生效，切换项目需重开会话」。
- skill 不受此约束（session-factory per-session 读 discovery.json，切项目自动换）。

## 理由

1. **零复制是核心价值**：用户选择 xyz-agent 的前提是「不丢掉我在别处积累的 agent/skill」。复制方案（A）数据源分裂、外部更新不同步，直接否决。
2. **skill 走 pi 原生最稳**：`additionalSkillPaths` 是官方扩展点，未来 pi 升级不会破坏；比 symlink / 自写扫描都可靠。
3. **subagent 只能自写**：pi 不扫 subagent `.md` 是既定事实，xyz-agent 已有 `listAgentFiles`，扩成多目录是最低增量。
4. **`.agents/` 项目目录对齐行业**：Claude Code、各主流 agent 都认 `.agents/`，pi 还原生自动扫它——选它做项目主目录，切换成本最低。
5. **放弃 symlink（B）**：只为骗过 pi 单目录 extension，但既然 enabled 必须自己写时过滤，symlink 的「透明」是假的，还背跨平台（Windows 需开发者模式）+ 悬空风险。

## 代价与风险

- **subagent 维护成本**：走自写 extension，需维护多目录扫描 + 同名去重（.agents/ 胜出，比 skill 的原生路径重）。因 §5 放弃文件级开关，不必维护 enabled 过滤。
- **目录切换非实时**：改加载路径（`agentDirs`/`skillDirs`）需重跑注入/扫描，UI 给「下次会话生效」反馈；agent 受单例约束（见下），切换项目需重开会话。
- **去重逻辑**：双目录扫描需处理同名资源去重（.agents/ 胜出），实现需测试。
- **项目级 agent 受单例约束**：AgentRegistry 是 app 级单例，项目 `agentDirs` 只在会话启动时生效，切换项目需重开会话（决策 `ui_limit`）；skill 不受影响，per-session 切换。
- **强制目录覆盖可选目录**：放在 `~/.xyz-agent/` · `.xyz-agent/` 的资源（强制）永远覆盖同名可选资源（§1.1）。用户想确保某资源生效，放强制目录；想可替换/可关，放可选目录。可选目录内部靠拖动排序决定胜负。

> 落地步骤已删除：实现由代码承载（源码内 // ADR-0021 锚点可回链），git 历史可追溯（2026-09-13 ADR 瘦身）

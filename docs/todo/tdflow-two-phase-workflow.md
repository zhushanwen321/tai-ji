# tdflow：两阶段工作流设想（tech-design × dev-flow 参数化编排）

> **状态**：设想登记（2026-09-14，方向已与用户对齐），待后续重构实施。
> **连带裁决**：本设想落地时一并裁决 plan 包存废（倾向退役）；goal 桥修复不受本项影响、已独立实施（见 `docs/design/goal-bridge-cross-extension.md`）。

---

## 一、设想（需求原貌）

plan 的期望形态 = **综合 tech-design（设计+审查）与 dev-flow（规划+开发）能力的两阶段工作流引擎**，tech-design / dev-flow 降格为可替换的「阶段参数」，引擎提供流程骨架。四点期望：

1. **进入 plan**：一次性入口。
2. **阶段语境注入**：告知 agent 当前在 plan mode、纪律约束（不写代码只写文档）。曾考虑「标志位拦截写工具」，已论证放弃（见 §三注）。
3. **模板参数化**：设计阶段可加载用户指定模板（如 tech-design）；设计完成后进入审查，审查器也可由用户指定（如 tech-design 的三个 reviewer agent）；审查模式可选轮数（fixed-N）或 must-fix 清零（zero-mf）。
4. **两阶段 + 双确认门**：
   - 一阶段（设计）：需求 → 按模板出设计文档 → 对抗审查循环 → **人工确认门 1**；
   - 二阶段（规划）：按模板出执行计划（如 dev-flow 阶段 1 的 impl-plan）→ 计划对抗审查（新增能力）→ **人工确认门 2** → 提醒是否进入执行。

## 二、调研结论（2026-09-14）

### 宿主矩阵（决定性约束）

工作流实际横跨三个宿主，实现层的可用性：

| 形态 | zcode | pi CLI | taiji app |
|------|-------|--------|-----------|
| skill（`~/.agents/skills/`） | ✅ | ✅（pi.skills 通路） | ✅（pi 内核） |
| pi extension | ❌ 无此运行时 | ✅ | ✅ |

pi extension 方案对 zcode 零受益——而用户的主力工作流在 zcode 跑。

### 能力现状映射（真实缺口只有两块）

| 期望能力 | 现状 |
|---------|------|
| 一阶段设计+审查循环+zero-mf 终止 | **已完整存在**：tech-design skill 全流程（五段骨架 + 三 reviewer 并行 + 修复循环至 0 must-fix） |
| 二阶段规划（impl-plan） | **已存在**：dev-flow 阶段 1（产物 `.tmp/dev-flow/<name>.impl-plan.md`，DAG+单元表+验收计划表） |
| 两 skill 一次性入口与串联 | **缺口①**：目前需手动先 `/tech-design` 再 `/dev-flow` |
| 计划对抗审查 | **缺口②**：设计文档有三审，impl-plan 只有自检——无对抗审查环节 |
| 双确认门 | 缺口（现状靠自然对话交付，无强制停点） |

## 三、方案对比

| 方案 | 流程硬度 | 宿主覆盖 | 成本 | 主要代价 |
|------|---------|---------|------|---------|
| **A. meta-skill 编排（推荐）** | 软（指令级强制停点）——与 tech-design/dev-flow 现有硬度一致，实践无失守记录 | **三宿主全覆盖** | 一个 SKILL.md + 计划审查 rubric | 无 setActiveTools 硬收窄 |
| B. plan extension 重构为两阶段引擎 | 硬（代码状态机 + ctx.ui 确认门） | 仅 pi + taiji | 重写 plan 包 + extension 读 skill 的新桥 | zcode 零受益；inner-platform 风险（extension 内重实现 skill 模板发现） |
| C. pi workflow（workflow.js） | 中（代码循环） | 仅 pi + taiji | 每组合一个 workflow.js | workflow 是一次性脚本，**做不了暂停等用户确认**——确认门会把 workflow 拆两段，回到手动串联 |

**注（写工具拦截的取舍）**：曾期望「plan mode 下标志位拦截写工具」。已论证放弃：① 流程本身要写文档，「拦截写」只能拦「写非文档」= 按文件路径/类型分类的白名单拦截器，是复杂新机制而非标志位；② 现 plan extension 自己也只做到工具粒度收窄（bash 仍在白名单、写约束靠提示词）；③ 实证（大量 tech-design 会话）表明指令级「只写文档不改代码」在实践中够用，从未发生乱写源码。

## 四、推荐形态：tdflow meta-skill

```
~/.agents/skills/tdflow/
  SKILL.md               # 两阶段骨架 + 确认门纪律 + 参数
  flow/
    design.md            # 一阶段：包装 design-skill（默认 tech-design）全流程
    plan.md              # 二阶段：包装 plan-skill 的计划阶段（默认 dev-flow 阶段 1）
    impl-plan-review.md  # 新增：计划对抗审查 rubric + reviewer 派发
```

- **调用**：`/tdflow <需求>`（全默认）；`/tdflow design=<skill名> plan=<skill名> review=<zero-mf|fixed-N> <需求>`。参数收敛到三个（两个 skill 名 + 审查模式），**不做通用 DSL**（防 inner-platform）。
- **确认门**（两道，指令级强制停点）：门 1 = 设计文档就绪后停下（列路径 + 审查收敛轨迹），等用户确认，禁止自行进二阶段；门 2 = 计划就绪后提示「是否进入执行」，确认后衔接 plan-skill 执行阶段（dev-flow 阶段 2+ 的 subagent 开发循环）。
- **审查模式**：默认 zero-mf（继承 tech-design 7.4 终止条件）；fixed-N 可选，沿用 dev-flow 防不收敛纪律（同单元 dev→fix 超 2 轮 / 审查 ≥3 轮未收敛即升级用户），不新造机制。
- **计划审查 rubric**（缺口②的填补，维度草案）：DAG 依赖正确性 / 单元边界与领地划分 / 验收计划表可证伪性 / 与设计文档对齐度（文件改动地图反向核对）/ 状态恢复路径完备性。reviewer 以 subagent 派发（tech-design 三 reviewer 同款形态）。
- **中断恢复**：状态落在产物上（设计文档存在性 + impl-plan 状态表 + git log）——dev-flow 已验证的「文档即状态机」模式，不引入新状态存储。

## 五、连带处置

**裁决（2026-09-14 用户澄清）**：暂缓的仅本设想的重构本身；goal 桥修复（`docs/design/goal-bridge-cross-extension.md`，三审 0 must-fix）**已独立实施**，plan 包在重构落地前维持现状（桥修好是当下正确形态）。

**待本设想落地时一并裁决**：

1. plan 包退役（npm deprecate + 仓库移除或标 deprecated）vs 保留（残余价值：独立 pi 用户开箱即用 + complete 执行分发）。判定依据：用户实际使用数据（两形态从未用过）+ 外部 npm 用户量。
2. goal 桥随 plan 的去留：plan 退役后桥的 plan 消费方消失——桥实现可随包移除或保留（goal 侧 slot 挂载本体无害，`GoalInitFn` 仍可供未来消费者使用）；D6 的 pi 官方机制观察项继续有效；`pi.__workflowRun` 死通道登记（pi-ext-020 加注）与桥无关、独立有效。
3. ext-simplify-06 / 03 设计文档中 plan/goal 桥表述的回写（goal 桥实施已同步其 u3 清单中的桥表述部分；plan 存废裁决后的剩余回写在此执行）。

## 六、实施件清单（重构时）

| 件 | 内容 | 依据 |
|----|------|------|
| tdflow SKILL.md + flow/*.md | 四份编排文档 | §四 |
| impl-plan 审查 rubric | 计划对抗审查维度 + reviewer 派发协议 | §四（缺口②） |
| plan 包处置 | 按裁决退役/保留 + goal 桥联动 | §五 |
| 登记回写 | ext-simplify-index / 06 / 03 / pi-ext-020 加注 | §五 |

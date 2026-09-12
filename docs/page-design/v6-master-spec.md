# v6 重构完整规格（2026-08）

> **状态**：权威整合主文档（Master Spec）。整合自 28 份 v6 过程文档 + `.tmp/v6/` 可运行 demo（2026-08-02 最新）。token 值真值固化见 [`v6-tokens.css`](./v6-tokens.css)（自 demo 固化，随仓库提交）。
> **性质**：视觉语言层 + 前端架构重构的完整设计。授权大刀阔斧，不考虑兼容性。
> **取代关系**：本文档是 v6 的单一权威源。`v6-spec-*.html` 降级为**视觉标注参考**，与本文档冲突时以本文档 + demo 为准。（`v6-design.md` / `v6-summary.md` 已删除（2026-09-13 收口，残值已并入本文档并标注来源，git 可追溯）；`v6-review-*.md` / `v6-fix-plan.md` 等审查/修复文档已删除，裁决收敛进本文档 §9；v3 期 `design-system.md` 已删除（2026-09-13 收口，活跃裁决并入本文档 §3.2/§5.1/§5.13/§6.1）。）
> **真相源优先级**：本文档（决策与范式） > [`v6-tokens.css`](./v6-tokens.css)（token 值真值，随仓库提交） > `.tmp/v6/` demo（组件实现活验证） > `v6-spec-*.html`（视觉标注稿，部分已滞后） > 过程文档（审查/修复计划，已收敛进本文档）。
>
> **2026-08-02 修订**：新增 §3.5 实践原则（8 条，demo 迭代沉淀）；§5.6 状态指示圆点范式范围限缩（SessionList 改用 §3.5.2）；§9 新增 D12/D13/D14 裁决（SessionList 信号编排 / TurnRail 滚动条二合一 / Project 一级导航）。
> **2026-08-02 审查修订**：spec↔demo 全量对照后修正——P0 内部矛盾统一（TurnRail thumb 色阶 / pulse-accent 时长 / badge 图标 / ChangeSetCard vs GitPanel badge 边界）；P1 跟 demo（send-slot 圆角矩形 / comp-box has-input 兑淡 / UiInput surface-2 / UiCheckbox focus 双环 / composer-bar 6 元素）；demo 新增 landing 页 + useTheme composable + ProjectSwitcher 增删 + 6 太极主题 SystemPage 接通，spec 同步记录；P2 笔误修正（7 tab 补 browser / tab 名统一 / keyframes SSOT 约束 / install-ok soft 底统一等）。
> **2026-08-02 二次审查修订**：修正 4 处与 demo 真值不符的事实性错误——(1) §6.4 nav 项计数 12→11（demo `SettingsOverlay.vue` NAV 数组实为 11 项）；(2) §5.9 pulse-accent 描述由「opacity 明灭」改为「box-shadow 扩散涟漪」（`base.css:87` 实际是 box-shadow 0%→70%→100%，非 opacity）；(3) §6.1 TurnRail failed 节点色阶——demo 实际用 `warn`（TurnRail.vue:179/195/205），非 spec 声称的 `danger`，改为标注「demo 待对齐 §5.6B」；(4) §4.8 COLOR_TOKENS 计数 18→19（数组实含 19 个，漏算 `--neutral-ico`）；另补 §5.9 SSOT 约束的 3 处现存违反位置 + §6.1 thumb 色阶交叉引用 §3.5.6。
> **2026-08-02 三次审查修订（subagent 四路并行审查）**：修正 15 处——P0：§3.4 例外计数两类→三类、§10.1 HTML spec 18→15 份+补登 3 个 demo html、附录 A mock 8→9 + 补 common/icons 子目录、§5.1 `.btn-secondary` 补 `solid`、§6.1 TurnMeta pill `bg-surface-2`→`bg-elevated`；P1：§5.11 install-ok 改为如实记录 demo 透明底现状+目标态、§7.2 A4 状态修正（pi 已实现非未消费）、§9 序言修正来源归因（D12-D14 非 review/fix-plan 来源）、§6.1 ChangeSetCard 补 superseded 例外、§6.5 SearchModal 三源→二源；P2：§6.1 ThinkingBlock 60 字符→CSS ellipsis、§6.5 MermaidRenderer 标注 demo 未实现、§10.2 真相源链删除已删除文档层级、§8.4 阶段 C 补说明 refactor 不含。
> **2026-09-09 修订（reduce-gradient-decoration）**：移除 `--shadow-drawer`（§4.7 token 列表 / §5.5 drawer-main 分隔 / §6.3 一体化生长描述）——drawer-area `overflow-hidden` 裁剪后代 box-shadow，该投影自布局收紧后从未实际可见（死样式）；同时 main-panel 移除浮层投影（`--shadow-2`），分隔由 border + 色差 + 圆角承载，`--shadow-1` 描边保留。§4.1「唯一带 border + shadow」自本修订起指 `--shadow-1` 描边环。

---

## §1 背景

### 1.1 项目

xyz-agent：基于 Electron + Vue 3 + Node.js Runtime 的 AI Agent 桌面工作台。通过子进程 RPC 调用 pi（AI coding agent CLI）。用户画像：每天 6h+ 与 AI Agent 协作的开发者。

### 1.2 为什么要 v6 重构

**视觉层**：v3 冷蓝暗色设计系统工程化程度不弱于竞品（token SSOT、10 主题预设、20 波视觉验收），但观感「不够现代、不够简洁」。根因不是色相，而是五个「克制」缺失（竞品 Codex/Claude/Linear/分析结论）。v6 不是换色，是把五原则更彻底地应用到全部页面。

**架构层**：renderer 内部复杂度欠债——useChat 违反 per-session 隔离 ADR-0049、stores 间互相 import、Sidebar 上帝组件、settings 与 v6 全屏形态根本冲突。这些欠债影响可维护性，且阻碍 plugin 扩展体系落地。

**扩展层**：项目有两套扩展机制（pi extension 已实现 / plugin-sdk 借鉴 VSCode 但 renderer 零消费），需要统一为可承重的 plugin 渲染体系。

### 1.3 授权与时序

- 用户原话：**全面大胆重构，大刀阔斧，不用考虑成本/兼容性，整体不合理可全部重写**
- 时序：**先架构后视觉**。阶段 0（测试）→ A（整体架构）→ B（renderer 局部）→ C（v6 视觉层）
- 视觉线与架构线可并行（仅 3 个交叉点：设置全屏 / Drawer 二级 tab / token 变更）

### 1.4 文档现状（为什么需要整合）

v6 过程文档已积累 28 份（30000+ 行），存在三类问题：
1. **SSOT 与 spec 互相否定**（review 发现）：如 settings shell spec 回退到 modal，而 v6-design 决策是全屏。
2. **demo（2026-08-02）比 HTML spec 更新**：demo 引入太极阴阳 6 主题、字号上移一档、状态色水墨化、整体明度抬亮，spec 仍是旧冷蓝单主题。
3. **过程文档（review/fix-plan）的裁决已收敛**，但散落各处，无单一查阅入口。

本文档解决这三个问题：裁决已定稿、token 以 demo 为准、过程结论已吸收。

---

## §2 目标

### 2.1 视觉目标

对标 Codex / Claude / Linear / Figma / Notion / Raycast / Stripe 的极简专业风格。一句话哲学：

> **冷蓝暗色不变，shell 三栏不变，对标极简专业——「层级代替边框、圆角升档、正文提亮、内容收窄、彩色降噪」五原则更彻底地应用到全部页面。**

> **v2 演进（2026-08-02）**：色相从「冷蓝」演进为「太极阴阳 6 主题预设」（默认太极·玄，纯灰系）。五原则不变，色相成为可切换的表层。

### 2.2 架构目标

- renderer 六层清晰（Shell / Workspace / Feature / **ExtensionHost** / **RenderingProtocol** / Foundation）
- per-session 状态隔离内建（ADR-0049 工厂范式一等公民）
- stores 零互相 import，事件消费逻辑归 composable 层
- plugin 渲染体系落地（4 视图维度 × 3 自定义级别 × 16 挂载点，见 §7）

### 2.3 扩展目标

- plugin-sdk 作为进程架构主干（生命周期/Worker 隔离/懒激活）
- GuiComponent 作为 pi extension + plugin 共享的统一渲染协议
- pi extension 开箱即用（ANSI 兜底永留）
- tasks(goal/todo) 作为第一个 builtin plugin 验证机制能否跑通

### 2.4 验收基准

| 维度 | 基准 |
|---|---|
| 视觉 | demo（`.tmp/v6/`）目标态为 SSOT；三层背景肉眼可辨；impeccable AI slop test 通过；正文全部过 WCAG AA |
| 架构 | runtime 三层契约名实相符；shared 无运行期实现；IPC 仅 OS 特权；renderer stores 零互相 import |
| 测试 | coverage 启用进 CI；E2E 双轨进 CI；对话流/session 生命周期/设置持久化有 E2E 覆盖 |
| 扩展 | builtin tasks plugin 跑通；core 零 tool name 硬编码特判 |

---

## §3 设计原则

### 3.1 视觉五原则（不可变）

| # | 原则 | 具体含义 |
|---|------|---------|
| 1 | **层级代替边框** | 静态容器只用一个表面色，不叠加 border；靠 bg 层级浮起分隔。border 仅保留给浮起可交互容器（popover/dialog/composer）和 focus 态 |
| 2 | **圆角升档** | `--radius-sm` 6px（全局默认档）；卡片 10px；浮层/composer 12px；徽章/pill 999px 胶囊 |
| 3 | **正文提亮** | `--neutral-dim` 抬亮一档；正文位置统一用 `--neutral-mid`（过 WCAG AA ≥4.5:1）；仅装饰/极弱位置保留 dim/faint |
| 4 | **内容收窄** | assistant 居中 720px（整 turn 居中，UserBubble 列内右浮）；设置内容列同 720px 左对齐；Composer 非 landing 对齐同列 |
| 5 | **彩色降噪** | 保留 git 语义色（M/A/D 降为极小圆点或单字）+ accent + 真 failure 的 danger，其余降灰阶。从色块/pill 降级为极小圆点或单字 badge |

### 3.2 impeccable 禁令（违反必返工）

- **禁 >1px 彩色侧边条**做选中/强调/分隔（改用 bg 实色块 + 蓝字）。**豁免**：编辑式 admonition（`.note` / `.warn` callout）的左色条是文档内联提示的分类标记（note=accent / warn=danger），不是卡片选中手段，不属此禁令〔2026-09-13 自 design-system.md 边界澄清并入〕
- **禁嵌套卡片**（一个表面色容器不叠加 border；嵌套层级不超过 3 层明度递进）
- **禁 AI slop**：uppercase tracking-wider 装饰文字、emoji（用内联 SVG）、无意义渐变、装饰性 pill
- **禁自创组件样式**：必须用 SSOT class（`.btn-*`）或 token；**class 名正确不代表 CSS 值正确，需逐字核对视觉值**
- **禁硬编码视觉值**：颜色/间距/圆角全部 token 化（stage 底色等声明项例外）

### 3.3 架构原则

| # | 原则 | 含义 |
|---|------|------|
| 1 | **插件隔离优先（No DOM Access 铁律）** | 插件代码绝不进 renderer 进程，经结构化数据或声明式元数据驱动 |
| 2 | **声明式优先于编程式** | contribution 在 manifest 声明，支持懒激活、静态分析 |
| 3 | **数据驱动渲染** | 插件提供数据，renderer 统一渲染，插件无法直接影响 DOM |
| 4 | **单一渲染协议** | pi extension 和 plugin 共用 GuiComponent |
| 5 | **API 稳定性分层** | stable/proposed/internal，主干化即冻结点，Object.freeze 防篡改 |
| 6 | **per-session 隔离内建** | useSessionScopedState 工厂一等公民，默认隔离 |

### 3.4 选中态二分规则（D8 裁决，统一全局）

v6 审查发现「被选中」出现三种视觉语言，统一为二分：

| 类型 | 适用组件 | 范式 |
|---|---|---|
| **tab 型** | SegmentedTab / drawer L1-L2 tab / AskUserOverlay au-tab / plugin seg-tab | `bg-bg-elevated` + `text-neutral-fg`（中性浮起） |
| **列表项型** | SessionItem / FileTree / SearchModal sm-item / au-opt / wf-call / CommandPopover 项 / SettingsNavItem | `bg-surface` + `text-accent`（实色块 + 蓝字，无 ring 无左条） |

**accent-soft 仅留瞬时高亮**（fresh 新增项 / is-current popover 项），不作持久选中态。

**三类已登记例外**（demo 落地取舍，非范式违反）：
- **drawer L1 icon tab**：active 用 `bg-surface-hover`（非 bg-elevated）。理由：drawer 与 main 同 surface（D2 一体化），bg-elevated 会过亮；surface-hover + 蓝字足够区分。
- **TurnRail mini-map 节点**：active 用 `bg-accent-soft + inset accent-ring`（第三种视觉语言）。理由：mini-map 是「当前位置指示器」语义（非持久选中），且节点极小（224px 浮层内），accent-soft 染底 + ring 提供最强可见性。属瞬时高亮的延伸。
- **SearchModal sm-item**：用 `bg-surface-hover` + accent 蓝字/蓝 icon（非列表项型默认的 bg-surface）。理由：dialog 底 = surface，sel 用 bg-surface 会同色淹没，改 surface-hover 靠蓝字区分（Linear/Raycast 范式）。

### 3.5 实践原则（2026-08-02 demo 迭代沉淀）

> 以下 8 条来自 `.tmp/v6/` demo 多轮迭代的实际教训，是 §3.1 视觉五原则在具体场景的展开。涉及状态指示的已在 §5.6 / §9 对齐。

#### 3.5.1 Token 语义归位，不要「就近借色」

实色背景上的前景元素（文字/图形）必须用该色的 `-fg` 变体，不从 neutral 谱系借。

**事故**：drawer unread badge 圆点用 `--neutral-fg`，玄主题下 accent(`#cfcfd4`) 与 neutral-fg(`#dedee2`) 亮度差仅 ~4%，圆点融进胶囊底不可见。`--accent-fg`（`#1a1a1c` 深字）才是 accent 实色上的正确前景色，6 个主题预设都配了对。

**检查**：看到 `background: var(--accent)` + 前景元素，前景应该是 `--accent-fg`，不是 `--neutral-fg`。

#### 3.5.2 信号编排：空间分离 + 异常优先 + 常态归零

多个独立状态维度表达时：
- **空间分离**：不同维度放不同位置（左/右），物理上不可能重叠
- **异常优先**：只异常态（running/waiting/error）出现视觉元素；最常见态（done）不占任何视觉
- **一态一手段**：同一状态只用一种视觉手段（dead 已用 `opacity:0.5` 表达，不再加 badge）

SessionList 列表行遵循本条（左未读圆点 + 右异常态 badge，done 无 badge），具体 badge 矩阵见 §5.6A。ForkGroup 分支行不显示状态（§3.5.4）。非列表主行场景（GitPanel 行级状态等）仍用 §5.6B 的 7px 圆点范式。

#### 3.5.3 视觉对齐看「内容外缘」，不看「容器外缘」

对齐两个区块时对比的是用户实际看到的内容边界，不是 DOM 容器的 border-box。**双重 padding 是最常见的对齐陷阱**。

**事故**：Composer `.comp-wrap` 左右 20px padding 把内层 `.comp-box` 压成 680px，而对话流 `.ms-assistant-col` 直接 720 无内层 padding，导致 composer 比对话流窄一圈。修法：去掉外层水平 padding，box 外缘铺满。

**检查**：用 `getBoundingClientRect()` 测最内层可见元素的 left/right，不测容器。

#### 3.5.4 去掉只服务于「习惯」的元素

一个视觉元素如果存在理由只是「其他组件都有」或「以前这样」，而信息已由别的方式承载，删掉。

**实例**：
- ChangeSetCard 的 chevron 箭头——header 整行可点击展开/收起，箭头不提供额外信息，占 20px 缩进 + 视觉噪音。删掉后标题和其他 block 左缘对齐（之前缩进 32px）
- ForkGroup 分支行的状态点 / 未读 ring / stop 按钮——fork 分支只需表达「有分支」，状态归主 session 行。全删，单行 = 序号 + 标题 + 时间

**判断**：遮住这个元素，用户会丢失什么信息？什么都没丢 = 噪音。

#### 3.5.5 固定元素必须移出滚动容器

「固定在可视区」的元素（rail / FAB / 自定义滚动条）不能放在 `overflow: auto` 的内容流里——`position: absolute` 在滚动容器内是相对**内容区**定位，会随内容滚动。

**事故**：TurnRail 原是 `.ms-scroll` 子元素，滚动时跟着内容跑。修法：加一层 `.ms-shell`（不滚动）作定位锚点，TurnRail 移成 `.ms-scroll` 的兄弟。

**通用**：要么 `position: sticky`，要么提到滚动容器外。

#### 3.5.6 滚动条是「环境噪音」，不是「信息」

滚动条目标是「需要时能找到，不需要时不存在」。全局 `::-webkit-scrollbar` 从 8px 改 **4px** + 透明 track + 圆角胶囊 thumb + hover 提亮（`neutral-faint` → hover `neutral-dim`）。进一步：对话流原生滚动条完全隐藏，TurnRail 的 spine（6px 暗条）+ thumb 物理合并成滚动条（spine=track，thumb=可视区，可拖拽，滚动联动）。

**TurnRail thumb 色阶**（accent 谱系递进）：thumb 默认 `accent-soft`（accent × 10% 透明，弱）+ `border-left: 2px solid var(--accent)` → hover `color-mix(accent 22%)`（中）→ 拖拽 active `color-mix(accent 30%)`（强），三档均在 accent 谱系内递进（对话流内的滚动条与 TurnRail 同语义，用 accent 色而非 neutral）。

#### 3.5.7 分层概念翻译成已有视觉语言

引入新抽象层（Project / Workspace / Worktree）时用已有 token 和范式，不新造视觉系统。同语义的元素用同色，让用户形成「色 = 维度」的直觉：
- **worktree chip + fork 序号 pill + git-branch 图标** → 都用 `--reasoning`（低饱和紫）= git 分支维度
- **主 checkout** → 无 chip（常态归零，仅 worktree 需要标记分支维度）

#### 3.5.8 静态 demo 的「展示级」边界

demo 阶段功能做到「可见 + 可交互 + 数据 mock」即够。不接 runtime 链路（模型不真筛、附件不走 file picker、命令不真执行），但前端交互必须真——popover 能开能关、选中改 label、chip 能注入能删、query 筛选 + 键盘导航。

**反模式**：要么不做（按钮没反应），要么做满（接 demo 用不上的 RPC）。展示级是中间正确的点。

---

## §4 Design Tokens

> **真相源**：[`v6-tokens.css`](./v6-tokens.css)（2026-08-02 太极·玄定稿值，自 .tmp/v6 demo 固化、随仓库提交）。以下值与该文件逐字对齐。
> 本节取代 `v6-design.md §2` / `v6-summary.md §3`（两文档已删除，残值并入本文档）与 `v6-spec-tokens.html`（滞后于 demo，仅存作标注规范参考）。

### 4.1 背景层级（阶梯上抬 + 加宽级差，暗端防糊）

```css
--bg:           #131316;   /* 画布色（侧栏/drawer/settings 内容区底）*/
--bg-sunken:    var(--bg); /* 同画布色（语义变更：不往黑推，靠主面板 surface 浮起分隔）*/
--bg-input:     #17171a;   /* 输入框/凹陷区（比 bg 更深）*/
--bg-card:      #1b1b1e;   /* 设置分组卡片（介于 bg 与 surface）*/
--surface:      #1f1f22;   /* 主面板/drawer 浮起表面 */
--surface-2:    #27272a;   /* 次级表面（header 浮起分层 / SegmentedTab 内项 active）*/
--bg-elevated:  #2b2b2e;   /* tab 型选中态浮起 / popover 浮层 */
--surface-hover:#303033;   /* hover 态 */
```

**三层明度**（D2 一体化后）：
- **stage 最深底**：`--bg-stage` `#0a0a0c`（tokens.css 新增，ShellView .stage 引用；三层明度在玄主题下完整保留）。**亮色（皓族）**：`--bg-stage` `#dbd9d4`（TAIJI_PAPER 未定义独立 stage，复用宣纸族最深暖灰；style.css `[data-theme=light]` 覆盖，避免泄漏暗色 #0a0a0c 形成黑框）
- **画布层**：`--bg` `#131316`（aside/drawer/settings 内容区）
- **surface 浮起**：`--surface` `#1f1f22`（main-panel + drawer 一体化共享，唯一带 border + shadow）

### 4.2 文字 neutral 谱系（上抬，dim ~4.4:1）

```css
--neutral-fg:    #dedee2;  /* 主前景 */
--neutral-mid:   #96969c;  /* 正文（过 AA）*/
--neutral-dim:   #74747a;  /* 次要（提亮一档）*/
--neutral-faint: #46464c;  /* 极弱/装饰 */
--neutral-ico:   #86868c;  /* 图标默认色 */
--neutral-ico-hover: #dedee2;
```

### 4.3 边框 / 分隔（v6 慎用，静态容器不叠加）

```css
--border:        rgba(255,255,255,0.07);
--border-strong: rgba(255,255,255,0.13);
--hairline:      rgba(255,255,255,0.05);  /* demo 新增：行分隔 / drawer L1 栏底线 */
```

### 4.4 主色 / 状态色（太极·玄默认：水墨降饱和，克制放开档）

```css
/* 主色（玄 = 纯灰系）*/
--accent:        #cfcfd4;
--accent-hover:  #e0e0e4;
--accent-soft:   color-mix(in oklch, var(--accent) 10%, transparent);  /* 派生 */
--accent-ring:   color-mix(in oklch, var(--accent) 30%, transparent);  /* 派生 */
--accent-fg:     #1a1a1c;  /* accent 实色上的文字（玄主题用深字）*/

/* 状态色（水墨降饱和：饱和度/明度 +15~20%，保留水墨感不艳）*/
--success: #78a87e;  --warn: #b79c54;  --danger: #bf6b6b;
--info:    #6d99a5;  --reasoning: #8e85ab;
--danger-fg: #f0f0f2;  /* danger 实色上的文字（玄主题用浅字）*/

/* soft 派生（自动跟随，主题切换无需单独覆盖）*/
--success-soft:   color-mix(in oklch, var(--success) 12%, transparent);
--warn-soft:      color-mix(in oklch, var(--warn) 14%, transparent);
--danger-soft:    color-mix(in oklch, var(--danger) 12%, transparent);
--info-soft:      color-mix(in oklch, var(--info) 12%, transparent);
--reasoning-soft: color-mix(in oklch, var(--reasoning) 12%, transparent);
```

### 4.5 diff 着色（柔化 12%）

```css
--diff-add-bg:     color-mix(in oklch, var(--success) 12%, transparent);
--diff-del-bg:     color-mix(in oklch, var(--danger) 12%, transparent);
--diff-add-strong: color-mix(in oklch, var(--success) 45%, transparent);
--diff-del-strong: color-mix(in oklch, var(--danger) 45%, transparent);
```

### 4.6 字体 / 字号 scale（2026-08-02 整体上移一档 + 自适应）

```css
--font-sans: system-ui, 'PingFang SC', 'Helvetica Neue', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;
--font-mono: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace;

/* 字号 scale（base 13→14 上移，calc 自适应）*/
> 2026-08-25：--font-sans 改系统栈，supersede ADR-0019 的 Inter 字体子决策（chat-visual-font-optimize）
--font-scale-u: 1;   /* 用户档位（TokenDebugPage 选：紧凑0.92/标准1.0/偏大1.08/大1.16）*/
--font-scale-mq: 1;  /* 视口档位（媒体查询：≥2100px ×1.08 / <1400px ×0.95）*/
--text-2xs: calc(11px * var(--font-scale-u) * var(--font-scale-mq));
--text-xs:   calc(12px * var(--font-scale-u) * var(--font-scale-mq));
--text-sm:   calc(13px * var(--font-scale-u) * var(--font-scale-mq));
--text-base: calc(14px * var(--font-scale-u) * var(--font-scale-mq));
--text-md:   calc(15px * var(--font-scale-u) * var(--font-scale-mq));
```

### 4.7 圆角 / 间距 / 阴影 / z-index / 动效

```css
/* 圆角 */
--radius-sm: 6px;   --radius: 8px;   --radius-lg: 12px;   --radius-card: 10px;

/* 间距（4px 栅格）*/
--space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
--space-6:24px; --space-8:32px; --space-12:48px; --space-16:64px;

/* 阴影 */
--shadow-1: 0 0 0 1px rgba(0,0,0,0.2);
--shadow-2: 0 8px 24px rgba(0,0,0,0.4);
--shadow-glow: 0 0 0 3px color-mix(in oklch, var(--accent) 25%, transparent);

/* z-index 语义化 */
--z-sticky: 1;  --z-popover: 10;  --z-overlay: 20;  --z-modal: 1000;

/* 动效 */
--ease: cubic-bezier(0.4,0,0.2,1);
--duration-fast: 120ms;  --duration: 200ms;  --duration-slow: 320ms;

/* 组件尺寸 */
--content-max-w: 720px;  --composer-btn-size: 30px;
--bash-output-max-height: 240px;  --bar-fill-soft: 55%;
--panel-bg: var(--surface);  /* panel 内 sticky 浮层底色契约 */
```

### 4.8 主题系统（太极阴阳 6 预设）

demo 引入完整多主题系统（spec 无，demo 重大扩展）。机制：改 CSS 变量（resetToken 清空 → writeToken 批量写入），派生色自动跟随。

**切换链路**（demo 已接通）：`useTheme.ts` composable（全局共享）持有 `THEMES`（6 主题定义）+ `currentThemeName` ref + `applyTheme(name, theme)` 函数。SystemPage「配色主题」GroupCard 渲染 6 主题列表行（`theme-row` + `theme-swatches` 四色缩略图），**点击即时切换**（调 applyTheme，不走 draft/save），选中态 `bg-surface + accent 字`（列表项型）。TokenDebugPage 也从 useTheme import 同一份数据（保持调试功能）。

**applyTheme 机制**：先对所有 COLOR_TOKENS(19) + EFFECT_TOKENS(6) 逐个 `removeProperty`（清 inline 值落回 `:root` 默认），再按新主题 entry `setProperty` 写入（entry 没给的 key 保持默认）。每主题覆盖 26 个变量（bg 阶梯 8 + neutral 6 含 ico-hover + accent 3 + 状态 6 + border 3）。

> COLOR_TOKENS(19) = bg 8 + neutral 5(fg/mid/dim/faint/ico) + accent 1 + 状态 5(success/warn/danger/info/reasoning)；EFFECT_TOKENS(6) = border 3 + accent-hover + neutral-ico-hover + danger-fg。主题 entry 覆盖的 neutral 是 6（含 `--neutral-ico-hover`，该变量虽在 EFFECT_TOKENS 数组里，但主题 entry 会覆盖它）。`--accent-fg` 同理：不在两组数组中，但 6 个主题 entry 均包含，write 时 `setProperty` 直接覆盖（当前不残留；若未来新增不含 accent-fg 的主题，需补入 EFFECT_TOKENS reset）。

**阴 · 暗色族（3 个）**——背景近中性，色相只做「依稀相」(S≤6%)，靠明度阶梯说话：
| 主题 | accent | 特色 |
|---|---|---|
| **太极·玄（默认）** | `#cfcfd4` 纯灰 | 暗端防糊，阶梯上抬+加宽级差 |
| 太极·黛蓝 | `#9ca9c9` 依稀蓝相 | S≈8% |
| 太极·暖墨 | `#cbc3b3` 暖相 | 宣纸暖 |

**阳 · 亮色族（3 个）**——宣纸为底，彩色只做小面积 accent（朱印点睛）：
| 主题 | accent | 特色 |
|---|---|---|
| **太极·皓** | `#36332f` 墨黑 | 亮·宣纸墨黑 |
| 太极·青墨 | `#3d6b6b` 花青 | 亮·宣纸花青 |
| 太极·朱印 | `#9c4335` 朱砂 | 亮·宣纸朱砂（danger 错开玫红 `#b23855` 防撞色）|

**设计原理**：暗底彩色必须提亮才可读（提亮即荧光），故靠明度阶梯说话而非色相；亮底允许低饱和低明度「颜料 accent」。亮色族共用同一套宣纸阶梯，只换 accent 颜料不换纸。

---

## §5 Design System（组件范式）

> **真相源**：`.tmp/v6/src/styles/base.css`（SSOT 全局范式）+ demo 组件实现。

### 5.1 `.btn` SSOT（base + 4 variant × 尺寸 + focus + disabled + svg）

```css
/* base */
.btn { inline-flex; items-center; gap: var(--space-2); white-space: nowrap;
  border-radius: var(--radius); font-weight: 500;
  transition: all var(--duration-fast) var(--ease); user-select: none; }
.btn:disabled { pointer-events: none; opacity: 0.5; }
.btn:focus-visible { outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0,0,0,0.4); }  /* 双环 */
.btn svg { width: 16px; height: 16px; flex-shrink: 0; }

/* 4 variant */
.btn-default   { background: var(--accent); color: var(--accent-fg); }       /* Primary */
.btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--neutral-fg); }
.btn-ghost     { background: transparent; color: var(--neutral-fg); }        /* hover: bg-surface-hover */
.btn-danger    { background: transparent; color: var(--danger); }            /* hover: bg-danger-soft */

/* 尺寸 */
.btn-sm   { height: 36px; padding: 0 12px; font-size: var(--text-sm); }
.btn-md   { height: 32px; padding: 0 12px; font-size: 12px; }  /* 过渡兼容，新代码用 btn-dense */
.btn-dense{ height: 32px; padding: 0 12px; font-size: var(--text-xs); }  /* 新代码首选 */
.btn-icon { width: 40px; height: 40px; padding: 0; }
.btn-icon-sm { width: 28px; height: 28px; padding: 0; }
```

**focus 裁决**（全局统一）：
- Button / Switch / Checkbox = accent 双环（`0 0 0 2px accent` + `0 0 0 4px black/0.4`）
- Input / Textarea = **inset 单环**（`inset 0 0 0 1px var(--accent-ring)`）
- 链接/行级可点元素 = inset 单环（与 Input 一致）
- composer-box focus = 3px 外环（对齐真实代码，非 inset 单环）

> Button 外环 vs Input inset 单环是**故意不统一**：Button 是操作型原语，外环 + offset（shadcn 惯例）表达可点击焦点；Input 是容器型原语，inset 表达边界聚焦。两语境不合并。〔2026-09-13 自 design-system.md P1-2 裁决并入〕

> Input 的 `error` prop 只触发 `border-danger` 边框态，**不自带错误文案**——「下方错误文案」归表单层（FormMessage 惯例）承载，防止 Input 内嵌文案形成表单分层破洞。〔2026-09-13 自 design-system.md P1-3 裁决并入〕

### 5.2 控件范式（独立 .vue 组件，用 scoped + token）

| 控件 | 规格 |
|---|---|
| `UiInput` | h40（dense h32）；`bg-surface-2`（浮起分层，比凹陷 bg-input 更符合层级范式）；focus = inset 单环；error class `.error` |
| `UiSwitch` | 36×20；translateX=18px；focus 双环；无 hover 变色 |
| `UiCheckbox` | **内联 class 范式（非独立 .vue）**：16×16；checked=`accent` 实心 + `accent-fg` 勾；unchecked=`border-strong` 空心；`:focus-visible` 双环（`0 0 0 2px accent` + `0 0 0 4px rgba(0,0,0,0.4)`）；disabled opacity 0.5 |
| `SelectTrigger` | **未实现**（demo 无此组件）。目标态：去 border，`bg-bg-input`，圆角 8px。当前分支/模型选择走 popover（GitPanel/Composer） |

### 5.3 SegmentedTab 新范式（§3.1）

```
外层容器: bg-bg-input rounded-lg(12px) p-[3px]
内项: 无边框
active(tab 型): bg-bg-elevated text-neutral-fg, 6px 圆角（中性浮起，去 accent-soft 蓝染底）
hover: text-neutral-fg
```

### 5.4 列表项选中态（§3.2）

```
列表项 active: bg-surface 实色块 + text-accent 蓝字，无 ring 无左条
```

### 5.5 分隔策略（层级 > 留白 > hairline > 边框）

- 静态容器只用一个表面色，**不叠加 border**
- border 仅保留：浮起可交互容器（popover/dialog/composer）+ focus 态
- drawer 内 header 分隔：去 `border-b`，改 `bg-surface-2` 浮起分层
- drawer 与 main 间：D2 一体化（同 surface）+ SplitterResizeHandle 透明化（仅 hover/drag 显 accent）。〔2026-09-09〕弱投影 `--shadow-drawer` 已移除——drawer-area `overflow-hidden` 裁剪后代 box-shadow，从未实际可见
- 行分隔 hairline：`--hairline`（0.05）

### 5.6 状态指示统一（§3.3 + §3.5.2）

状态信号按场景分两套范式：

**A. 列表主行（SessionList）—— 左未读点 + 右异常态 badge**

遵循 §3.5.2「空间分离 + 异常优先 + 常态归零」：

| 位置 | 元素 | 何时出现 |
|---|---|---|
| 左侧 | 未读圆点（8px `--accent` 实心，不脉动） | 仅 `unread` 时；常态空 8px 占位保 label 对齐 |
| 右侧 | 状态 badge（紧凑胶囊） | 仅异常态；done / dead 无 badge |

右侧 badge 矩阵：

| 状态 | badge 形态 | 颜色 | 动画 |
|---|---|---|---|
| running | 脉动小条 `▎` + 耗时 | `--accent` / `--accent-soft` 底 | 脉动（`pulse-accent` 1.8s） |
| waiting | `…` 胶囊 | `--warn` / `--warn-soft` 底 | 无 |
| error | `!` 胶囊 | `--danger` / `--danger-soft` 底 | 无 |
| done | **无 badge**（仅耗时文字） | — | — |
| dead | **无 badge**（整行 `opacity:0.5` 表达） | — | — |

hover 时右侧整单元（badge/耗时）`visibility:hidden` 让位 ghost 操作，`label` 位置稳定不跳。

**B. 非列表主行（GitPanel 行级状态等）—— 7px 圆点**

- `7px; border-radius: 999px` + 语义色：done=`--success`(90% opacity) / running=`--accent` / waiting=`--warn` / error=`--danger`

**C. ForkGroup 分支行 —— 不显示状态**

单行 = 序号 pill（`--reasoning` 紫）+ 标题 + 时间。状态归主 session 行，分支行只表达「有分支」（§3.5.4）。

**通用（全场景）**：
- **工具失败**（exit≠0）：图标统一 `--neutral-ico`，行尾加 mono `exit N` 中性标签（`bg-bg-elevated` 胶囊）
- **彩色边界**：保留 = 真 failure danger / 待行动 accent / git 语义色（降极小圆点）；降中性 = workflow done / GoalCard badge / ±stats / 目录改动数
- **GitPanel 行级 badge 中性化**：M/A/D 统一 `neutral-dim`，仅 U（冲突）染 `danger + font-weight 700`
  > **场景区分**：GitPanel 行级 badge 因信息密度高需中性化降噪；**ChangeSetCard 文件 badge 保留彩色**（M=info / A=success / D=danger），因对话流场景信息密度低，彩色辅助辨识收益大于降噪收益。两条不矛盾，是同一原则在不同信息密度场景的取舍。

### 5.7 图标 scale（§5.3）

| 用途 | size |
|---|---|
| trace | 12px |
| block header / header | 14px |
| 操作按钮 | 16px |

lucide-vue 内联 SVG，stroke-width 默认 **1.75**（特殊图标如 checkbox 勾/install icon 可加粗到 2-3）。block icon：thinking=Brain / tool-bash=SquareTerminal / tool 兜底=SquareFunction / subagent=Bot / workflow=Workflow。

### 5.8 GroupCard（设置分组卡片）

```
.group-card { background: var(--bg-card); border-radius: 10px; padding: 10px; }  /* 去 border */
.group-head { background: var(--surface-2); padding: 10px 16px; border-top: 1px rgba(255,255,255,0.04); }  /* 首张 border-top:0 */
```

### 5.9 动效（全局 keyframes）

`spin` / `pulse-accent`（1.8s **box-shadow 扩散涟漪**：`0%` accent-ring 实色 → `70%` 扩散至 5px 透明 → `100%` 收回）/ `pulse-dot` / `blink` / `shimmer`（骨架屏）。`@media (prefers-reduced-motion: reduce)` 把所有 animation/transition 压到 `0.01ms !important`。

**SSOT 约束**：keyframes 只在 `base.css` 定义一次。组件通过 `animation-name` 引用，**禁止在 scoped style 里重复 `@keyframes` 定义**。已清理（2026-08-04 修复批次：scoped 重复定义删除，组件改引全局 pulse-dot/spin；通用名 keyframes 仅 base.css 定义一次，组件仅保留带前缀私有动画）。

### 5.10 加载态 / 骨架屏

demo 用 `@keyframes shimmer`（1.4s ease-in-out infinite，linear-gradient 扫光）+ 组件内 `.shimmer` 类，5 处消费形成范式：

- **骨架行**：`height 10px + radius 999px`（胶囊条），3 行堆叠模拟列表（间距用标准 scale）
- **骨架卡片**：`bg-card` 卡片 + 内部 shimmer 扫光
- **loading 防闪**（SearchModal）：`LOADING_DELAY_MS=200`，开扫 200ms 后才显 spinner，防连续输入闪烁
- **ToolBlock running**：双环 loader（13px，外环 opacity 0.35 + 内环实心，`spin 1.4s`，accent 色），name 染 accent
- **TaijiLogo 旋转**：8s（reduced-motion 停），`currentColor` 适配主题

### 5.11 内联反馈条（v6 不做全局 toast）

**v6 用内联反馈条替代全局 toast**（demo 故意未做全局 toast 系统）。范式：
- **成功反馈**（`.install-ok` / `.success-note` / `.page-notice`）：语义色文字（success/warn）+ `border-top hairline` 分隔 + 语义 icon + 文案（原因 + 下一步），2-3s 自动消失。**目标态**加 `*-soft` 底统一；**demo 现状**（`.install-ok`/`.install-err`）是透明底仅靠语义色文字区分，实施时按目标态补 `*-soft` 底
- **错误反馈**（`.install-err` / `.inline-error`）：danger 色 + TriangleAlert icon，**常驻**可重试，不自动消失。目标态加 danger-soft 底
- **页级横幅**：`*-soft` 底常驻，用于页级错误/成功提示

### 5.12 焦点管理 + 键盘快捷键

#### 焦点管理三要素（modal/dialog 可访问性范式）

| 要素 | 实现 |
|---|---|
| **focus trap** | Tab 首末循环、焦点逃逸拉回（SettingsOverlay）；打开时首项 focus |
| **焦点归还** | 记录触发器 `triggerEl`，关闭时 `onUnmounted focus()` 归还 |
| **安全默认焦点** | 确认弹窗 onMounted 焦点落「安全选择」（warn→继续编辑 / danger→取消）；Esc = 安全选择 |

#### 全局键盘快捷键

| 快捷键 | 动作 |
|---|---|
| `Esc` | 关闭所有 overlay（search/settings/askUser/confirm/quickComposer），退出 staging/fork/handoff 模式 |
| `⌘/Ctrl+K` | 打开 SearchModal（命令面板） |
| `⌘/Ctrl+B` | 切 sidebar 折叠 |
| `⌘/Ctrl+N` | 新建任务 |
| `⌘/Ctrl+,` | 打开 Settings |
| `Enter`（Composer） | 发送；`Shift+Enter` 换行 |
| `⌘/Ctrl+Enter`（GitPanel） | 提交 |
| `↑↓`（SearchModal/nav） | 键盘导航 + Enter 确认 |
| `Tab`（SettingsOverlay） | 焦点陷阱；nav 内 `↑↓/Home/End` 移动 |

**IME 守卫**：Composer 的 `isComposing` 期间不拦截回车（中文/日文输入法 composing 态不发送）。

**composer-bar popover 锚点范式**：absolute 相对 composer-bar，`bottom: calc(100% + 6px)`，`z-modal`，`bg-elevated + border-strong + shadow-2 + radius-lg`。popover open 时触发按钮 `.bar-btn--active` = `accent-soft 底 + accent 字`（锁高亮）。

### 5.13 标签族语义四分 + 空状态三要素〔2026-09-13 自 design-system.md 并入〕

四者形态相近，按语义强制区分，禁止混用：

| 原语 | 语义 | 形态 |
|---|---|---|
| Pill | 分类/状态标签（`running` `done`、分支名） | 圆角 999，soft 底，mono 字 |
| Chip | 引用实体（@mention） | 圆角 999，带前缀图标 |
| Badge | 计数角标 | 小圆，accent/danger 底 |
| Status Dot | 极简状态 | 6-8px 圆点，状态色 |

空状态三要素：图标（subtle）+ 一句说明 + 一个 Primary 入口；禁止纯「暂无数据」。

---

## §6 分区设计（逐视图：v6 方案）

> 详细视觉标注见 `v6-spec-*.html`（实现细节参考），本节给架构关键决策。

### 6.1 对话流（assistant 居中 720）

- **MessageStream**：整 turn 居中 `max-w-content-max-w`(720) + `margin:0 auto`；UserBubble 列内右浮（max-w-76%）；隐藏原生滚动条由 TurnRail 接管
- **TurnMeta**：pill 默认可见（`bg-elevated` 浮起，解决主面板 surface 上「面上面」不可见）；删 turn 间 `hr` 改加大 turn gap；**重试中态**：RetryIndicator 不放 composer，重试期间 TurnMeta label 切「重试中 N/M」+ warn 色 spinner（区别 streaming 的 accent）〔2026-09-13 自 v6-design.md 并入〕
- **Block·tool**：状态矩阵 collapsed/expanded × running/done/failed；running 双环 loader（13px）；exit≠0 加 mono 标签；**failed 统一不切 icon**（保留原 tool icon，toolName 降 `neutral-mid` 表达，无红框——与 subagent/workflow block 一致）；unfinished 显「未结束」标签〔2026-09-13 自 v6-design.md 并入〕
- **Block·thinking**：收起态 1 行 CSS ellipsis（`text-overflow: ellipsis` 视觉截断，非硬字符数限制）；expanded body 用 `neutral-mid`（过 AA）
- **Block·bash**：区分 BashOutputBlock（composer `!` 前缀，不可折叠，exit 标签色 0=`success` / N=`warn` / timeout=`dim`）vs tool-bash（嵌 tool 块，`bg-bg-input` 无 border）〔exit 标签色 2026-09-13 自 v6-design.md 并入〕
- **TurnSummary hover actions 方案 A**：3 个扁平 icon button（Copy / GitFork / HandHelping），无 split-button、无 MD/+Q badge；fork/handoff 点击 = `+Q` 带提问变体进 composer，composer 直接 Enter = 无内容变体〔2026-09-13 自 v6-design.md 并入〕
- **Block·subagent/workflow**：collapsed only，点击 → drawer tab
- **UserBubble**：删 border，仅 `bg-surface-hover`；删 pending 态（迁 QueueBubble 内嵌）
- **Composer**：6 区（QueueBubble / staging chip / inline chip bar / landing meta / input / composer-bar）；宽度对齐 720 居中
  - **variant 双形态**：`variant="panel"`（正常态，固定 workspace 底部）vs `variant="landing"`（landing 态，垂直水平居中 + meta-row slot）；landing 触发：新建任务按钮设 `landingMode=true`，发送消息后 `landingMode=false` 切回 panel
  - **landing meta-row**（仅 `variant="landing"` 时渲染，comp-box 内顶部）：ghost chip 行 = directory chip(Folder icon + mono 目录名，空 cwd 时 accent 色) + `meta-sep`(1px border 竖线) + branch chip(GitBranch icon + mono 分支名) + meta-sep + preset chip(Zap icon + 预设名)；chip 样式 h-auto gap-1.5 px-2 py-1 text-xs neutral-mid，hover bg-surface-hover + neutral-fg
  - **landing 页布局**（LandingView）：`flex items-center justify-center` 垂直水平居中；问候语 h1（22px font-650 neutral-fg，按时段「上午好呀/下午好呀/晚上好呀，有什么想让我帮忙的吗」）+ landing Composer（max-w 720px）
  - **inline chip 四色**（无底无边 + `font-weight 600` + 前缀 icon 13px + × 删除按钮 hover 染 danger-soft）：`file`=success 绿 / `image`=reasoning 紫 / `slash`=reasoning 紫 / `@`=accent 蓝；四色 chip 都有 × 删除按钮
  - **composer-bar 6 元素**：`+`添加 / spacer / 上下文容量(hover popover) / 模型(click popover, 分组+搜索+选中 check) / 思考强度(click popover, 6 档圆点) / send-slot(30×30 accent 圆角矩形 radius 8px + 倾斜箭头)；bar-btn h28 icon 14px；popover 锚点范式见 §5.12
  - **contenteditable + slash 触发**：光标位置检测 `/` 或 `#`（行首或空格后）触发 CommandPopover；选中插入 chip + 移除触发文本；IME 守卫见 §5.12
  - **comp-box 态**：`.has-input`(2px `color-mix(surface-hover 40%)` 透明微环) / `.focused`(border-accent + 3px accent-ring 外环) / `.staging`(border-accent + 3px ring + bg-accent-soft，独立于焦点)
- **ContextBar**（composer 上方，goal/todo 摘要 + plugin foot 挂载点）：与 composer 同宽同中线居中；常态归零（无 goal/todo 时整条隐藏）；slim bar 24px `text-2xs neutral-dim`；点击展开 popover（goal 全文 + 3px 进度条 + todo checklist）
- **TurnRail**（右侧 turn 导航 + 自定义滚动条接管）：spine(`surface-hover` 6px 暗条 340px，点击翻页) + thumb(`accent-soft + 2px accent border-left`，按滚动比例定位 min-h 24px，可拖拽，hover/active 三档色阶详见 §3.5.6)；hover 展开 mini-map(6px→224px，turn 节点两行：user 行 + agent 状态图标行，含**折展 toggle** ChevronUp/Down，active 节点常驻可见 toggle)；active 节点见 §3.4 例外
  > **failed 节点色阶待统一**：§5.6B 规定 error=`--danger`，但 demo `TurnRail.vue` 当前 failed 节点用 `--warn`（`.warn` class，行 179/195/205）。demo 未对齐范式，实施时应按 §5.6B 改为 `--danger`
- **ChangeSetCard**：去 border 改 `bg-surface` + 10px 圆角；5 态 badge 中 accumulating/ready/partially-reviewed/resolved 4 态用 `*-soft` 底 + 实色字，superseded 例外用 `bg-elevated + neutral-dim`（中性降级态，非彩色语义）
- **PanelHeader**：去 `border-b`，用 `bg-elevated` 浮起分层
- **goal/todo 回归对话流**（D3）：移除 tasks tab + `HIDDEN_TOOL_NAMES`，走 GuiComponent 统一渲染
- **通知族二分**（2026-08-19 裁决，2026-09-13 自 design-system.md §2.5 并入）：对话流「非对话内容行」按**可交互性**二分，两形态不得混用——

  | 形态 | 判据 | 样式 |
  |---|---|---|
  | 通知卡片 | 可交互（含链接/关闭按钮的 transient 反馈，如 ForkNotice） | bg-soft（语义色 12% 透明）单手段分隔无 border + `--radius` + `px-3 py-1.5` + text-sm |
  | 横线分隔行 | 静态元信息（无可交互入口，如 SystemNotice / 压缩中提示） | 无底色无框，两侧 `h-px` 横线 + 居中 text-xs + 12px 图标 |

  共同约束：宽度一律 `mx-auto max-w-[var(--content-max-w)]` 与对话流内容列同体系；动效 `notice-in` 200ms（-4px translateY 淡入）+ `motion-reduce:animate-none`；通知卡片内文字链接用 accent 色 + hover 下划线，**不用 hover 底色**（soft 底卡片内再叠 hover 底 = 卡中卡）。裁决背景：ForkNotice 早期实现为 border + bg-info-soft 双分隔 + 全宽（848px vs turn 720px），critique 后收敛。

### 6.2 侧栏（5 tab + 容器）

- 底色 `var(--bg)`；SegmentedTab 见 §5.3；SessionItem 选中态见 §5.4
- **Project 一级导航**（D14）：nav 下方 ProjectSwitcher。**折叠态** = 当前 project 名 + ChevronDown（点击展开列表）；**展开态** = project 列表（popover 范式 bg-elevated + border-strong + shadow-2），每行 project 名 + hover 显删除按钮（Trash icon，danger 色，点击 window.confirm 后 removeProject），底部「+ 新建项目」按钮（点击变 input，Enter 创建 + 设活跃）；选中态 `bg-surface + accent 字`（列表项型）。session 按 workspace（目录）分组，worktree chip 用 `--reasoning` 紫（§3.5.7）
- **4 内置 tab**（sessions/files/subagents/workflows）+ **第 5 独立 plugin tab**（Puzzle icon，plugin view 收口于此）
- 组标题去 uppercase；ForkGroup 去 border 改缩进，分支行单行（序号 pill + 标题 + 时间，不显示状态，§3.5.4）；FileTree 缩进 10px gap 4px
- SessionList 状态信号见 §5.6A（左未读点 + 右异常 badge）；非列表行场景（GitPanel 等）用 §5.6B 的 7px 圆点
- **Brand 区**（顶部）：TaijiLogo 28px 旋转（8s，reduced-motion 停，currentColor 适配主题）+ 产品名(base 600) + 版本号(2xs mid) + 可升级按钮（accent + 7px danger 红点角标）
- **NavItem**：primary(accent 实色 32px) / ghost(透明) 双层级 + `<kbd>` 快捷键标签（`border-strong` 例外保留，物理按键语义）
- **UserArea**（footer 钉底）：`margin-top:auto` + 20px accent 纯色头像（去装饰渐变）+ 用户名 + 设置齿轮(24px)
- **QuickComposer**（workspace 快捷新建 spotlight）：SessionList group head hover「+」触发；spotlight 卡片 560px 宽 `bg-elevated + border-strong + shadow-2 + radius-lg`，backdrop `rgba(0,0,0,0.45)`（比 modal 0.8 轻）；预选 cwd chip + branch 去重；Enter 创建 / Esc 取消

### 6.3 右侧 Drawer（D2 一体化 + 7 tab）

- **一体化生长**：drawer 与 main 共享 `--surface` 浮起体，从 main 右缘生长挤占 main 宽度；去 border-l。〔2026-09-09〕原「保留弱投影 `--shadow-drawer`(0.16) 分隔」已移除（overflow-hidden 裁剪，从未可见）。主面板:drawer 默认宽度比 1:1，可拖拽调整〔2026-09-13 自 v6-design.md 并入〕
- **形态 B**：icon 一级 + 各 tab 自治二级
  - detail：多文件 tab（点文件新开/切换/关闭）—— **阶段 B 衔接点**（useDetailPane 单值→map 重构）
  - terminal：多实例 tab + 新增按钮占位 —— **阶段 B 衔接点**（单 PTY→多 PTY）
  - git/doc：无二级 tab
  - browser：内嵌网页预览（无二级 tab）
  - subagent（新增）：嵌套只读对话流（无 composer）
  - workflow（新增）：phase 分组 + agent call 列表
- **tasks tab 移除**（D3）：goal/todo 回归对话流
- **GitPanel MVP 三功能**（v6-design 决策 #16 授权，2026-09-13 自 v6-design.md 并入）：per-file stage/unstage toggle / BranchSelectPopover 分支切换 / CreateBranchModal 新建分支 / commit 快捷键 `⌘/Ctrl+Enter`（见 §5.12 快捷键表）；零后端改动的纯前端能力
- **L1 icon 栏结构**：`surface` 同色 + `border-bottom: 1px hairline`（0.05，方案 G 弱分隔）+ icon 30×30（active 见 §3.4 例外）+ spacer + unread badge（accent 胶囊 + 6px `accent-fg` 脉动点 + mono 计数）+ pin 按钮（pinned 染 accent）+ close 按钮
- **SplitterHandle**：6px 宽视觉 + 10px 命中区（margin 负值扩展）；1px transparent → hover `border-strong` → active `accent + 2px`；`cursor: col-resize`

### 6.4 设置页（D1 全屏覆盖重构）

- **FullSettingsOverlay**：手写 `fixed inset-0 bg-bg z-modal`（不用 reka Dialog）；无遮罩/无模糊（纯不透明全屏）
- 左 nav `w-220px bg-sunken` 无 border-r；右内容区底色 `--bg`（卡片才能浮起），内容列 `max-w-content-max-w`(720) **左对齐**（非居中）
- nav 选中态见 §5.4（列表项型）；nav-brand `uppercase 0.08em`（例外）
- **11 个 nav 项**（provider/skill/agent/extension/system-prompt/terminal/preset/worktree/update/system/token-debug），每项 icon + label + 可选 count badge（中性圆点 `bg-surface` + `neutral-dim` mono）；hover 右侧显 chevron（链接提示）。注意：`skill` 项的 key 是 `'skill'`，但 demo 渲染的是 `ResourcesPage`（技能资源管理页），无独立 `SkillPage` 组件
- 11 个 page 分组卡片 `bg-card` + 10px 圆角 + 去 border；行分隔 hairline 0.05；每行 label 下加 12px `neutral-mid` 描述
- **ProviderEdit**：展开就地编辑（手风琴，取代 ProviderEditModal 双层 modal）
- 表单 label 去 uppercase tracking-wider
- **交互状态机**（有编辑态的页面）：dirty 快照 diff（净零翻转恢复 clean）/ 保存流（mock 延迟 + 已保存反馈）/ 离开守卫（dirty 拦截切页 + 放弃先还原快照防重入）/ beforeunload

### 6.5 Overlays

- **SearchModal**：手写覆盖层；命令/文件聚合（session 源待接入，demo 现有 2 group：建议命令 + 最近打开）；选中态见 §3.4 例外（surface-hover + 蓝字，dialog 底 surface 上 bg-surface 会淹没）；分组 header 去 uppercase；高亮 `<span class="sm-hit">` font-semibold 不染蓝（颜色继承父元素）；loading 防闪 200ms（见 §5.10）；default 态尾部 clock icon 表最近/历史
- **AskUserOverlay**：内联（非 modal），companion-band 统一交互出口（B3）
  - **多问题切 tab**（au-tab：无 border / 全圆角 6px / active=bg-elevated+500 / 已答 tab 显 7px success 绿点）
  - **单选 radio**：16px，unchecked=`border-strong` 空心，checked=`accent` 实心 + `inset 2px bg-input` 形成环
  - **多选 checkbox**：16px 方块，checked=`accent` 实心 + `accent-fg` 勾 10px
  - **Other 选项**：末尾追加，选中后 label 下方展开 Input（surface-2 内嵌，自动聚焦）
  - **auto-advance**：单选最后问题选完自动提交；非最后自动下一题；多选不自动推进
  - **context 降中性**：`bg-surface-hover`（去 reasoning 软底彩色，v6 降噪）
- **ConfirmDialog**：圆角 12px；danger 三角 icon 降 size-4
- **MermaidRenderer**：保持现状（主产品已有，demo 未实现该组件）

### 6.6 Plugin 渲染（4 维度 × 3 级别 × 16 挂载点）

详见 §7。

---

## §7 Plugin 渲染体系（架构层）

> 详见 `docs/architecture/renderer-target-architecture.md`（架构 SSOT）。本节给摘要。

### 7.1 统一架构判定

- **plugin-sdk** 作进程架构主干（生命周期/Worker 隔离/JSON-RPC/懒激活/Disposables）
- **GuiComponent** 作 pi extension + plugin 共享的统一渲染协议（7 原语 + custom 逃生口）
- 兼容铁律：pi extension 开箱即用（ANSI 兜底永留）

### 7.2 4 视图维度 × 3 自定义级别

| 维度 | 挂载点 | 级别 | 当前状态 |
|---|---|---|---|
| **A 结构容器** | A1 侧栏第 5 tab / A2 drawer tab(proposed) / A3 工具条按钮 / A4 底栏状态 | L1 | A1/A2/A3 panels 声明未消费；A4 pi 已实现（extension:status），plugin 未接入 |
| **B 对话流+companion** | B1 tool result / B2 消息卡 / B3 companion(统一出口：dialog+ask-user) | L2/L1 | **已实现**（5 闭环） |
| **D 命令配置** | D1 slash / D2 settings 区段 | L1 | D1 已实现（双轨待统一） |
| **E 独立 view** | E1 独立 view 路由 | L3 | 未实现（仅 built-in） |

| 级别 | 含义 | external 可用 |
|---|---|---|
| L1 元数据+数据驱动 | plugin 给 {id,icon,title,data,command}，renderer 固定宿主 | ✅ |
| L2 结构化原语树 | plugin 给 GuiComponent 组合，renderer 原语渲染器 | ✅ |
| L3 预编译组件 | plugin 给 Vue 组件，编译期打包 | ❌ 仅 built-in |

> **mobile-renderer plugin 子集**（远程化预留）：mobile-renderer（`feat-remote-use` 分支）布局与桌面完全不同（底部 tab/抽屉式，无 drawer/无 sidebar 第 5 tab/无 panel header 按钮组），16 挂载点是**桌面拓扑专属**。mobile 只支持 **B 维度**（对话流 GuiComponent，message-stream 已 copy）+ **D 维度**（slash command），不支持 A 维度（结构容器注入）和 E 维度（独立 view）。mobile 不含 ExtensionHost 层，plugin 渲染降级为 message-stream 内嵌的 GuiComponentRenderer。完整 mobile plugin 拓扑待 `packages/core` 抽取后定义。

### 7.3 16 挂载点 Tier 分层

- **Tier 1（12 活注入点）**：M1/M2/M4/M5/M7/M8/M9/M10/M11/M12/M14/M16
- **Tier 2（4 边缘）**：M3（不改结构）/ M6（drawer proposed）/ M13（低优浮层）/ M15（降级仅致命错误）
- **关键阻塞**：6 个声明式空壳变闭环，差 2 个 API（`commands.register` / `views.update`）

### 7.4 7 原语 v6 视觉

| 原语 | v6 视觉 |
|---|---|
| card | 去边框靠 bg 层级（bg-card→surface→surface-2）；header 去 border-b 改 bg 浮起；圆角 8-10px；variant 靠 dot+badge |
| stats-line | severity 收窄（danger 保留，ok/warn 降中性）；border-l hairline 保留 |
| progress-bar | fill 柔化 color-mix；done 降中性；圆角 6px |
| list-tree | 缩进 16px 留白档；icon 12px；status 7px 圆点替换文字 |
| columns | gap-3(12px) 标准 scale |
| tab-bar | 强制迁移 SegmentedTab 范式（去 accent-soft 去底线） |
| ansi-text | ANSI 16 色→v6 语义色映射（丢弃 bg 只用 fg）；暗/亮双主题 |

**原语扩展路线**（盲区补齐）：按需补 `rows`（垂直 stack，解跨栏 footer）/ `kv-list` / `table`，不放开 custom。

### 7.5 Builtin Plugin 第一实践：tasks(goal/todo)

经核实为首选——v6 已定决策顺势落地 + 管线就绪（extension 已产 GuiComponent）+ 独立性高 + 验证信号纯。subagent/workflow 暂缓（耦合虚拟 session），search 不纳入（核心导航）。

---

## §8 落地改动点（前端整体架构重构）

> 结合 [`v6-architecture-refactor.md`](../architecture/v6-architecture-refactor.md)（现状审查+缝补）+ [`renderer-target-architecture.md`](../architecture/renderer-target-architecture.md)（终态架构）。
> 时序：阶段 0 → A → B → C。

### 8.1 阶段 0：测试基础设施（最先，为重构护航）

- 启用 coverage + 设观察门槛
- E2E 进 CI（mock 轨 + real 轨独立 job）
- 补建 dev-smoke 闸门
- 重写 TEST-STRATEGY.md

### 8.2 阶段 A：整体架构（3 项）

| 项 | 动作 | 优先级 |
|---|---|---|
| **A1 runtime 缝补** | 补全 ISessionStore port（2 处真业务直连）+ logger 豁免声明 + pi-paths 归 kernel | 暖身（最机械） |
| **A2 shared 瘦身** | git-status-parser/ignore-parser 下沉 runtime（机械移动） | 中 |
| **A3 IPC 收敛** | proxy 命名修正 + 业务持久化（writeSessionImage/Segments）迁 WS | 中 |

### 8.3 阶段 B：renderer 局部重构（重点）

| 项 | 动作 |
|---|---|
| **B1 useChat 状态隔离** | per-session 状态迁 useSessionScopedState 工厂；删 reset*ModuleState（6 个） |
| **B2 stores 契约修复** | 抽独立事件消费层；stores 零互相 import、零 store→composable 倒置 |
| **B3 routeInbound 路由表** | 104 行 if-else → 声明式路由表 + seq gap 中间件 + error envelope 下沉；归 T&C 层（见 renderer-target §2.2）；远程化合并后补 5 类分支（busy/idle/presence/deleting/deleted）纳入路由表 |
| **B4 Composer 合并** | 20 个 composable → 3 个（Input/Dispatch/Context）；useContenteditableInput 873 行拆解 |
| **B5 Sidebar 拆分** | 全局快捷键 88 行抽出 + tab 计数抽出 + session handler 抽出 |
| **B6 chat store 重组** | 流式消息状态机内聚；消除 *Impl（6 个） |
| **B7 settings 重构** | 目录按域分层 + 数据文件移出 + 全屏覆盖形态（D1）+ ProviderEdit 嵌入式（R4） |
| **B8 ui/ 双名清洗** | bg-accent 98 处双义消除 + ui/ 内 shadcn 命名清洗 |
| **B9 composables 分层** | features(41)/panel(37) 按域分子目录；顶层只留全局基础设施；T&C 层（useConnection 等）独立分组不进 features/panel 桶；⚠️ sync 兼容（改 COPY_MAP 文件路径需同步 sync-mobile-from-renderer.sh，见 refactor B9） |

### 8.4 阶段 C：v6 视觉层（token 反写 → 分视图）

> 阶段 C 属 v6 视觉线，`v6-architecture-refactor.md`（架构线）不含此阶段（架构线止于阶段 B）。C1-C8 由本文档定义。

| 波次 | 内容 |
|---|---|
| C1 | token 反写（style.css + tailwind.config.ts 同步 demo tokens.css 值） |
| C2 | 对话流（MessageStream/Block/Composer 6 区/ChangeSetCard） |
| C3 | 侧栏（SegmentedTab/SessionItem/FileTree/第 5 plugin tab） |
| C4 | Drawer（一体化 + 形态 B + 7 tab + GitPanel MVP） |
| C5 | 设置页（FullSettingsOverlay + 11 page + GroupCard） |
| C6 | Overlays（SearchModal/AskUserOverlay/ConfirmDialog） |
| C7 | Plugin 渲染（7 原语 v6 视觉 + ExtensionHost + builtin tasks） |
| C8 | 横切清理（正文提亮/彩色降噪/uppercase 清除/z-index）+ 全量验收 |

### 8.5 plugin-sdk 必修致命缺陷（主干化前置）

1. **sandbox ESM 漏洞**（import 绕过 require 拦截）→ vm 模块或真进程隔离
2. **panels 渲染链路 + UI 接口统一**（§7 目标态）
3. **API 稳定性分层 + Object.freeze**

---

## §9 已裁决清单（全部定稿，无待确认）

> 裁决来自 v6-review/fix-plan（D1-D11 + R1-R26 共 37 项）+ 2026-08-02 demo 迭代新增（D12-D14）。以下收录影响实施的关键裁决子集（非全量罗列），已全部定稿。实施时直接遵循。

### 9.1 结构裁决

| # | 裁决 | 决定 |
|---|---|---|
| D1 | 设置形态 | 全屏覆盖（FullSettingsOverlay） |
| D2 | Drawer 模型 | 一体化生长 + 保留弱投影(0.16) |
| D3 | tasks tab | 移除（goal/todo 回归对话流，删 HIDDEN_TOOL_NAMES） |
| D4 | plugin 范围 | 补登记架构授权（v6-design 决策 #15） |
| D8 | 选中态冲突 | 按组件类型二分（tab 型 bg-elevated / 列表项型 bg-surface+蓝字） |
| D12 | SessionList 状态信号 | **2026-08-02**：左未读圆点 + 右异常态 badge（running 脉动小条 / waiting … / error !），done 无 badge 常态归零，dead 由整行 opacity 表达。详见 §5.6A / §3.5.2 |
| D13 | TurnRail 二合一 | **2026-08-02**：TurnRail spine+thumb 物理合并成对话流滚动条（详见 §3.5.5/§3.5.6），原生 `::-webkit-scrollbar` 在 `.ms-scroll` 隐藏 |
| D14 | Project 一级导航 | **2026-08-02**：方案 D——ProjectSwitcher 放 nav 下方（独立区），无状态聚合（折叠态=当前 project 名 + 展开列表，展开态=增删 project），session 按 workspace（目录）分组，worktree chip 用 `--reasoning` 紫。详见 §3.5.7 / §6.2 |

### 9.2 数值裁决

| # | 裁决 | 决定 |
|---|---|---|
| R1 | composer focus | 3px 外环（对齐代码） |
| R2 | git M badge | info 蓝（对齐代码） |
| R4 | ProviderEdit | 展开就地编辑（手风琴） |
| R9 | thinking body | neutral-mid（过 AA） |
| R10 | 列宽 | 整 turn 居中、气泡列内右浮 |
| R11 | block icon | 14px |
| R13 | SegmentedTab 圆角 | 12px（radius-lg） |
| R14 | drawer 投影 | 弱投影 0.15-0.18 |
| R22 | 圆角升档 | tr-git/fg-pill 等升 6px；tt-close 保留 3px 例外 |

### 9.3 文档裁决

| # | 裁决 | 决定 |
|---|---|---|
| D5 | 对话流共享 CSS | 抽取 v6-spec-base.css |
| D7 | 文档 chrome | 不豁免 impeccable（spec 自身也禁 uppercase/彩条） |
| D9 | SSOT 链 | 全部同步更新（README/design-system/design-evolution） |

---

## §10 文档体系与取代关系

### 10.1 v6 文档分类（28 份 → 整合后）

| 类别 | 文件 | 整合后状态 |
|---|---|---|
| **权威主文档** | **本文档（v6-master-spec.md）** | ✅ 单一权威源 |
| 可运行参考 | `.tmp/v6/`（demo 项目） | ✅ token 真值与组件实现 |
| 设计 SSOT | `v6-design.md` | 已删除（2026-09-13，残值并入本文档 §5/§6 并标注来源，git 可追溯） |
| 设计总览 | `v6-summary.md` | 已删除（2026-09-13，纯索引/摘要无独立残值，git 可追溯） |
| 架构 SSOT | `../architecture/renderer-target-architecture.md` / `../architecture/v6-architecture-refactor.md` | ✅ 保留（架构细节本文档 §7-§8 摘要引用） |
| HTML spec（15 份） | `v6-spec-*.html` | 降级为视觉标注参考（部分已滞后于 demo） |
| HTML demo（3 份） | `v6-demo.html` / `v6-drawer-tabs-demo.html` / `v6-plugin-max-demo.html` | 降级为早期 HTML 探索稿（已被 `.tmp/v6/` Vue demo 取代） |
| 过程文档 | `v6-review-*.md` / `v6-fix-plan.md` / `v6-review-action-plan.md` | 已删除（裁决已收敛进本文档 §9；UI 演变叙事合并至 `../design-evolution.md`） |
| 共享 CSS | `v6-spec-base.css` | ✅ 保留（对话流四文件共享） |
| 输入提案 | `visual-modernization-2026-07.md` | 已删除（内容已被 v6-design 取代，无独立保留价值） |

### 10.2 真相源优先级

```
本文档（v6-master-spec.md，决策与范式）
  > .tmp/v6/ demo（token 真值与组件实现，2026-08-02 最新）
  > v6-spec-*.html（视觉标注稿，部分滞后）
```

> 原第 4 级「过程文档（review/fix-plan）」已删除，裁决收敛进本文档 §9，无独立真相源层级。

**冲突处理原则**：本文档与任何降级文档冲突时，以本文档为准；token 值与 HTML spec 冲突时，以 demo 为准（demo 比 spec 新，含太极主题/字号上移/水墨状态色等演进）。

---

## 附录 A：demo 项目结构（`.tmp/v6/`）

完整 Vue 3 可运行参考实现，27 张截图覆盖全部视图。技术栈：原生 CSS + tokens + 迷你组件（刻意不绑 Tailwind/xyz-ui，真实实施按本文档 §8.4 阶段 C 映射到项目技术栈）。

```
.tmp/v6/src/
├─ styles/tokens.css（token SSOT，太极玄定稿）
├─ styles/base.css（.btn SSOT + 全局重置 + keyframes）
├─ views/ShellView.vue（三栏布局 + 三层明度 + 折叠态 + landing 条件渲染）
├─ composables/useStore.ts（状态管理 + landingMode + projects 增删）
├─ composables/useTheme.ts（6 太极主题定义 + applyTheme 切换机制，全局共享）
├─ mock/*.ts（9 个 mock 数据文件）
├─ components/
│  ├─ shell/（PanelHeader/SplitterHandle/TrafficLight/AppNavControls）
│  ├─ sidebar/（Sidebar/SegmentedTab/SessionList/ProjectSwitcher[增删project]/PluginPanel/FileTreeView/...）
│  ├─ chat/（MessageStream/TurnRail[滚动条二合一+折展toggle]/LandingView[landing页]/ToolBlock/ThinkingBlock/ChangeSetCard/...）
│  ├─ drawer/（SideDrawer/GitPanel/DiffView/DetailPane/TerminalView/BrowserPane/...）
│  ├─ settings/（SettingsOverlay/GroupCard/ProviderPage/SystemPage[6太极主题]/TokenDebugPage/...11 page）
│  ├─ overlays/（SearchModal/AskUserOverlay/ConfirmDialog）
│  ├─ composer/（Composer[variant双形态+landing meta-row]/CommandPopover/QueueBubble/QuickComposer）
│  ├─ common/（预留共享控件层，当前为空；UiInput/UiSwitch/SettingRow/SettingsNavItem 等暂在 settings/ 下）
│  └─ icons/（TaijiLogo 图标组件）
└─ SETTINGS-DESIGN-CONTEXT.md（设置页实现基准）
```

## 附录 B：impeccable AI slop 检测清单

实施时逐项检查：
- [ ] 产品 UI 无 uppercase tracking-wider 装饰文字
- [ ] 无 emoji（产品 UI，终端输出/示意 SVG 豁免）
- [ ] 无 >1px 彩色侧边条（选中/强调/分隔；拖拽临时态豁免）
- [ ] 无嵌套卡片（静态容器 bg+border 双重分隔）
- [ ] 无无意义渐变（logo/avatar/装饰）
- [ ] 无硬编码色值（应用 token；stage 底色/模拟外部网页豁免）
- [ ] class 名正确 ≠ CSS 值正确（逐字核对视觉值）

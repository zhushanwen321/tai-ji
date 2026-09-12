# xyz-agent UI 设计演变史

> 记录 UI 设计系统从初始到当前形态的完整演变过程。每个阶段记录：方向、为什么转向、关键决策、标志文档。
>
> 当前态权威文档：
> - 范式 SSOT：[docs/page-design/v6-master-spec.md](page-design/v6-master-spec.md)（v6 单一权威源，整合自 28 份过程文档 + demo）
> - 值 SSOT：[docs/page-design/v6-tokens.css](page-design/v6-tokens.css)（hook 守卫；原 design-tokens.md 已删除）
> - 视觉规格：`docs/page-design/v6-spec-*.html`（部分已滞后，以 master-spec + demo 为准）
>
> 已删除过程文档（2026-09-13 收口，残值并入 v6-master-spec.md，git 可追溯）：v6-design.md（五原则原始定稿）、v6-summary.md（索引/摘要）、design-system.md（v3 原语层，活跃裁决并入 master-spec §3.2/§5.1/§5.13/§6.1）

---

## 阶段 0：Warm & Soft（2026-05 ~ 06 初）

xyz-agent 最初的设计方向是「温润」——暖奶油底色 + 赤陶（terracotta）accent + serif 字体 + 亮色优先。定义在项目根 `DESIGN.md`（Warm & Soft 设计系统，现已 DEPRECATED）。

**问题**：早期 UI 被反馈「扁平、不立体、不舒服」。诊断出三个根因：
1. 色调分层失败——bg/surface 明度差仅 2%，面板与背景不可辨
2. 无窗口整体感——独立 Header + Sidebar + Content 造成视觉割裂
3. 暖棕色暗色主题在屏幕上「显脏」，长时间使用不适

**标志文档**：项目根 `DESIGN.md`（Warm & Soft 完整设计系统定义，保留作历史标本）

---

## 阶段 1：中间态——Unified Window + Neutral Gray → Cool-Warm（2026-05-23）

一次快速迭代尝试解决问题。三根支柱：

1. **窗口一体感**——移除独立 Header/StatusBar，sidebar 与窗口控件/品牌融合，content 填满剩余空间（参考 Codex、Cherry Studio）
2. **中性纯灰暗色主题**——所有 neutral 色相=0、饱和度=0（纯灰），背景分层只靠明度差（bg L=12% < surface L=16% < hover-bg L=19%）
3. **锐利几何**——近零圆角（2-3px），accent 左边框做消息角色标识

但纯灰方案很快被推翻：用户测试后认为纯灰过于冰冷，缺乏品牌温度。同日转向 **Cool-Warm**：微暖中性色（hue=50, chroma=0.006-0.01）+ 赤陶 accent（`oklch(68% 0.10 28)`）回归 PRODUCT.md 的品牌定位。

impeccable 审查同时介入，禁止了 side-stripe border（AI slop 标志），改为 top border；ThinkingBlock/ToolCallCard 从默认展开改为默认折叠（信息过载）。

**标志文档**：项目根 `DESIGN.md`（Warm & Soft 完整设计系统定义，保留作历史标本）

---

## 阶段 2：v3 冷蓝暗色确立（2026-06-18）

Warm & Soft 被整体推翻。[ADR-0019](adr/0019-visual-direction.md) 裁决视觉方向收敛到**冷蓝暗色**，[ADR-0022](adr/0022-default-theme-direction.md) 裁决**暗色冷蓝为真默认**。

这次是系统级重建：
- 色相：微冷蓝（`--bg #1a1b1f` / `--accent #4f8ef7`），取代暖色系
- 架构：三栏 shell（sidebar 透明融合 + main float-panel 浮起 + 全屏 base 平铺），取代独立窗口块
- 字体：Inter（无衬线），取代 serif
- 组织方法：L0-L4 递归骨架（recursive-skeleton），每个设计单元 = spec.md + draft HTML
- 验收：W01-W20 共 20 波视觉验收全部 PASS

v3 确立了设计 tokens SSOT（原 `design-tokens.md`，2026-09 已收口为 `v6-tokens.css`）和组件原语层（原 `design-system.md`，2026-09-13 已删除，活跃裁决并入 v6-master-spec.md）。

**标志文档**：
- [ADR-0019](adr/0019-visual-direction.md)（视觉方向裁决）
- [ADR-0022](adr/0022-default-theme-direction.md)（默认主题裁决）
- [v6-tokens.css](page-design/v6-tokens.css)（值 SSOT；原 design-tokens.md 已删除，git 可追溯）
- ~~design-system.md~~（原语层；2026-09-13 已删除，git 可追溯）

---

## 阶段 3：v6 视觉现代化（2026-07-30 ~ 07-31）

v3 的设计系统工程化程度不弱于竞品（token SSOT、20 波验收），但观感「不够现代、不够简洁」。根因不是色相，而是**五个「克制」缺失**：

| # | 杠杆 | v3 现状 | 竞品标杆 |
|---|------|---------|----------|
| 1 | 圆角尺度 | 3px 默认，方硬工程面板感 | 8-16px |
| 2 | 分隔方式 | border + bg 双重分隔，满屏 hairline | 背景明度层级分隔 |
| 3 | 灰度分布 | 大面积中等灰 | 正文亮、meta 少而淡 |
| 4 | 列宽留白 | 无 max-width，宽屏一行 2000+px | 内容列 640-760px 居中 |
| 5 | 彩色克制 | 大绿勾/警示三角/紫思考/蓝选中高密度共存 | 彩色只给真正需要注意的对象 |

visual-modernization 提案（v6 输入基线，内容已合并进 v6-master-spec）提出了五条设计原则：

1. **层级代替边框**——静态信息容器只用表面色，不叠加 1px 边框；边框仅留给浮起可交互容器和 focus 态
2. **圆角升档**——默认 3px → 6-8px；卡片 8-10px；浮层 12px；徽章胶囊化
3. **正文提亮、meta 减量**——正文提亮一档，工具行参数从全绝对路径改为文件名加亮
4. **内容列收窄**——对话流 max-width 720px 居中
5. **彩色降噪**——状态指示极小化（图标 → 圆点），exit≠0 中性化表达

v6-design.md（2026-09-13 已删除，git 可追溯）在此基线上确立最终决策（D1-D14），成为范式 SSOT。后续整合为 [v6-master-spec.md](page-design/v6-master-spec.md)（单一权威源）。

实施过程经历了两轮严格审查：
- **第一轮**（v6-review-2026-07-31）：5 路并行逐字审查 349 条断言。结论：「五原则的魂保住了，形散了」——发现"被选中"出现三种视觉语言、两份定稿互相否定等问题
- **修复计划**（v6-fix-plan）：62 个任务，D1-D14 裁决逐条修复
- **第二轮复审**（v6-review-round2）：核验修复执行率九成，但留下 6 个新分裂点和 12 处"修了一半"的后遗症

审查过程中发现的核心张力：**五原则的「魂」（设计意图）反复与「形」（具体实现）分裂**。每次修复都会在某个文件里修对，又在另一个文件里引入新的不一致。这成为后续维护的持续关注点。

**标志文档**：
- [v6-master-spec.md](page-design/v6-master-spec.md)（v6 单一权威源，整合自 28 份过程文档 + demo）
- ~~v6-design.md~~（五原则原始定稿，D1-D14 决策；2026-09-13 已删除，git 可追溯）
- ~~v6-summary.md~~（索引/摘要；2026-09-13 已删除，git 可追溯）
- `v6-spec-*.html`（15 个视觉规格稿）

---

## 阶段 4：太极 V3 纯灰换色（2026-08-02）

用户想把产品做成符合**太极/阴阳鱼/圆/相生相克/周而复始**概念的风格。v6 的冷蓝 accent 与太极概念无关。

换色决策经三轮对比后确定方向（决策记录现居 [ADR-0066](adr/0066-taiji-pure-grey-color-direction.md)；原 2026-08-02-taiji-v3-color-decision.md 已删除，git 可追溯）：

1. **色相方案**：墨青 / 墨朱 / 纯太极 → 选定**纯太极**（纯灰系）。墨青基底仍冷、太极纯粹感不够；墨朱红久盯会燥且与 danger 语义冲突
2. **克制梯度**：浅 / 中 / 重 / 极简 → 选定**重克制 V3**（`--accent #cfcfd4`）。V4 极简灰度完全零色相，导致 M/A/D 变更集 badge 无法靠颜色分辨，语义损失过大

关键决策：**只换色相，不推翻 v6 范式**。明度阶梯沿用 v6 校准结果（多轮对比度校验），只把色相从「冷蓝灰」换成「纯灰」。状态色保留极弱色相作语义辨识。

太极概念的三层拆解中，V3 只覆盖「色」层。「形」（圆/环，需加大圆角或 S 曲线分割）和「动」（周而复始，需太极旋转 loader）是独立工作线，不在本次换色范围。

换色已落地到 `v6-tokens.css`（V3 纯灰值 SSOT，hook 守卫）和 `.tmp/v6/` Vue demo（taiji 预设）。

**标志文档**：
- [ADR-0066](adr/0066-taiji-pure-grey-color-direction.md)（换色决策与被否方案；原配色决策文档已删除，git 可追溯）
- [v6-tokens.css](page-design/v6-tokens.css)（V3 纯灰值 SSOT）

---

## 当前态

**设计系统权威链**：

```
v6-master-spec.md（v6 单一权威源：决策与范式）
  ↑ 整合自 v6-design.md（已删除）+ demo，冲突时以此为准
v6-tokens.css（值 SSOT：色/字/距/影/动效登记对照面；原 design-tokens.md 已删除）
  ↑ token 层以此为准
v6-spec-*.html（视觉标注参考）
  ↑ 已被 master-spec 取代，部分滞后
.tmp/v6/ demo（token 真值与组件实现的活验证层）
```

**色相**：太极 V3 纯灰（`--bg #131316` / `--accent #cfcfd4`）
**范式**：v6 五原则（层级代边框 / 圆角升档 / 正文提亮 / 内容收窄 / 彩色降噪）
**字体**：Inter
**架构**：三栏 shell（base 平铺 + sidebar 透明融合 + main float-panel 浮起）

---

## 演变中的关键教训

1. **「魂」与「形」的分裂是持续风险**——v6 审查发现五原则的意图很容易在具体实现中走样（"被选中"出现三种视觉语言）。修复一个文件可能在另一个引入新不一致。范式文档 + 审查机制缺一不可

2. **色相是最容易改的层，范式是最难稳定的层**——从 Warm & Soft 到冷蓝到太极纯灰，色相换了三次，但每次都声明"不推翻范式"。v6 五原则是色相无关的，这让它能跨色相方案存活

3. **竞品分析驱动方向，但不定义差异化**——竞品分析（Codex/Claude/OpenCode）推动了从暖到冷、从方到圆的转向，但 xyz-agent 的差异化（turn meta pills、结构化 trace 流、变更集卡片、侧栏四 tab）始终被刻意保留

4. **自称 SSOT 的文件可能是错的，标过时的文件可能是对的**——v6 审查发现 settings 的五份新 spec 与旧 spec 互相否定，README 分类与代码现实有偏差。文档的"权威性"需要代码级引用验证，不能只看文档自述

# demo 复刻波待立项数据通道

状态：已关闭，仅余 2 项待立项（2026-10-12 通道 3/4 落地关闭——本文件主体 = 下方 2 项待立项数据通道；已裁决与登记型条目收编于文末「已裁决/登记即关闭」，完整历史 = 本文件 git 历史）。复刻 = Open Design 项目 f7a69696 的 taiji-vue-app 高保真 demo 为唯一视觉权威；登记来源：ui-replica 会话（令牌地基 Wave1 + M0-M9 十模块复刻 + 视觉对比修复三轮 + review-fix-loop）。

## 待立项数据通道（2 项）

### 1. 会话导出 JSONL

demo 有 mock 导出项，real 任何入口均无该功能；需新增 JSONL 导出数据通道（2026-10-10 用户十项裁决 #4 会话右键菜单信息架构落地时的残留缺口，R6.2 项目锚定分组复刻沿用该登记）。

### 2. 悬停详情卡消息计数

demo 悬停详情卡末行 = 「时间 · 消息数」两段（Sidebar.vue `cardSess.upd · cardSess.msgs`），real 末行仅相对时间——SessionSummary 无消息数字段，按「零新数据通道」约束未补（SessionItem.vue 注释在案）。待 SessionSummary 消息计数数据通道立项后对齐。

## 已裁决/登记即关闭

### 待立项通道关闭（2026-10-12 落地）

- **通道 3 · composer image 徽章真图缩略图（已落地）**：行内 image badge 与上下文行 image chip 的 lead 均为 16px 真图缩略（demo `.ichip .thumb` / `.ctxchip .thumb` 四值：16px / r-3.5px / object-fit cover / flex none）。数据通道 = 既有 local-file:// 协议复用（未新开通路）：暂存图落盘 attachments/tmpdir（白名单内），URL 构造收敛 `@taiji/shared` `localFileUrl` 单点；加载失败回退 ImageIcon 占位不留破图。落点 = dom-core chip-commands `makeImageThumb`（行内 badge）+ renderer ContextChipsBar（上下文档）+ core context-chips 派生带 path。
- **通道 4 · 模型弹层 .pt 行尾标签（已落地）**：模型弹层命中 `config.defaults.defaultModel` 的行渲染行尾「默认」标签（demo `.pt` 四值：margin-left auto / font-mono / fs-xs→`--text-3xs` / dim），i18n key `panel.modelSelect.defaultTag` zh/en 双侧。落点 = ModelPickerPanel `defaultModel` prop（双匹配与 isRowSelected 同构）+ ModelSelectPopover / ModelThinkingAggregate 数据面透传；ScheduleForm 直挂面不传（无 demo 权威，行为不变）。demo mock 的「高速/视觉」tag 是 mock 专属人肉标注（real 无数据源），不做编造，空 tag 为合法态。

### 复刻波残差收编（2026-10-11，原「待用户裁决」编号条目）

- **原条目 1 · 朱印主题行内代码对比度 3.92:1（已关闭，2026-10-10 用户裁决「demo 适配实际可读性标准」）**：3.92:1 是旧公式（字色 = code-c 本色）的遗留值；demo 与 real 均已演进到 R4.1 公式（字色 = neutral-fg 85% 混 code-c 15%），六主题在该公式下全部 ≥4.5:1（WCAG AA 正文线）。contrast 单测统一线由 4:1 提升至 4.5:1 实测全绿，差异化下限与 3.9 豁免废除——无需改任何色值。
- **原条目 2 · M8 扩展宿主面（StatusBar/L2TabBar/CompanionBand）（登记保留）**：demo 产品页无此面（HostFace 为存档页）。2026-10-10 真机核实渲染条件：StatusBar 由 pi 扩展调用 `setStatus` API（status-set 事件链）贡献条目，当前全仓零调用方 → 设计内零 DOM（PanelContainer 挂载位 = 主面板底部 26px 横带，见该文件 249 行）；demo 亦无此面对照。已顺手清掉 X1 登记的四死类（StatusBar/Card elevated 头/TabBar 激活项/FindBar 的 `bg-elevated` → `bg-bg-elevated`，模块地图 X1 全部关闭）。待有扩展真实消费或 demo 权威后单开波次。
- **原条目 4 · 指标槽密度档位登记（登记保留）**：composer 底栏「三步聚合」密度现行档位 = fit 0 平铺四 chip（容量/TTFT/速度/缓存纯文本触发器）；fit 1 起指标聚合为单图标聚合按钮（hover 弹聚合页四卡，右簇先压）；fit 2 左簇聚合、fit 3 模型+思考聚合；容量顶缘细条（>80% 渲染）保留。口径 = composer-density.ts 状态机与 demo workbench.css 密度段（B1 裁决）双向一致。
- **原条目 5 · 会话右键菜单信息架构差异（已裁决落地，2026-10-10 用户十项裁决 #4）**：悬停 ghost 钮收敛为 3 个（重命名/删除/归入项目），「标记完成」「引用到输入区」迁右键菜单（SessionItemContextMenu，Portal 恒渲染），demo 侧同构落地（.si-acts 3 钮 + 菜单裁剪为归档/导出 + 移动到项目）。残留缺口 = 导出 JSONL，已上移为待立项通道 1。
- **原条目 6 · R6.2 项目锚定分组复刻（已关闭，2026-10-11 用户指令「src 做成 demo 形态」驱动落地）**：real 已按 demo 方案 A 终态复刻——顶部 ProjectSwitcher 卡片网格退役（切换路径唯一化到组头点击；D7/D8 拖拽排序与 shared `Project.userOrder` 字段随之退役，projects.json 存量遗留键零转换容错）；会话列表改锚定分组（组头 +「当前」chip + 缩进左线 + 0fr↔1fr 高度动画；平铺 = 锚定聚焦 / 目录 = 浏览态；组序 = lastUsedAt 倒序 + 默认项目固定最后，锚定切换不重排）；新建项目入口 = 区头「+」钮（同日追加裁决，demo 侧 Sidebar.vue/workbench.css/探针 29 项/spec 树已同步）。**real 侧语义差异有登记**：① 默认项目组头不渲染重命名/删除钮（demo 允许——real 的 nameless 身份是未归类/孤儿 session 兜底聚合判据，删/改即瓦解聚合，store 层动作入口有同源拦截）；② 目录模式目录标签行保留 real 功能钮（目录内新建 / cwd 批量删除两段确认；MF-2 拦截检查改为按项目分组判定）——demo mock 无对应物，沿「导航计数徽标保留」功能性信息先例；③ 历史遗留缺口 = 导出 JSONL、悬停卡消息数段，均已上移为待立项通道。**同日五条修正裁决（demo/spec/src 三面同步，demo 探针 anchor-groups 29/29）**：① 区头「+」紧贴模式分段（gap 2px）；② 点「+」→ 列表顶部草稿输入行（非区头内联输入，空名/Esc 丢弃）；③ 侧栏-主面板缝 8→4px + 列表容器右 padding 归零（视觉右边距对齐左边距，AppShell gap-1 拓扑门禁同步）；④ 会话行状态点右移到时间左边（名称贴左贴近项目左线，session-icon testid 语义变为状态元素本体）；⑤ 悬停三钮缩宽 18px、absolute inset-0 覆盖右槽 58px（点+时间 opacity 让位），名称槽左缘截断构造性不受遮；子会话 chip 在槽外不参与覆盖。
- **原条目 7 · composer 指标聚合页布局差异（已关闭，2026-10-10 双重裁决）**：composer-bar-spec（demo 侧专项 spec，taiji-composer-bar-spec.md）3.2 明确「real 为 300px 宽聚合页把容量/TTFT/速度/缓存四张完整卡纵向拼装，信息不降级」——四卡形态获 spec 认可；用户本轮裁决「先空着」一致。该 spec 另产生 real 侧新需求 B1（宽度退化次序翻转：右簇指标先压、左簇后压）已单开实施。
- **原条目 10 · ⌘K 搜索弹层输入聚焦焦点环（已裁决落地，2026-10-10 用户裁决 #8「输入面无缝」）**：SearchModal 输入补 focus-visible:outline-none（与 shadow-none/ring-0 三通道同压，光标即反馈）；spec R1.3 豁免面不扩充（搜索弹窗不豁免）。
- **原条目 12 · 插件视图行形态（.pv-row 六要素）vs real 恒空态挂载点（已裁决，2026-10-10 用户：暂不复刻）**：demo 侧栏插件 tab 有行形态列表——`.pv-row` 六要素 = 16px 图标（--mid）+ fw-mid 主标题（fs-md/fg）+ dim 副标题（fs-sm）+ 右缘状态 pill（`.pst` 胶囊：on=success-soft 底 success 字 / off=card-inset 底 dim 字）+ hover 底（--hover）+ 行容器（r-md 圆角 / 9×10px padding / 9px gap / 左右 4px 外距 / pointer），见 demo workbench.css 插件视图段（M8 入口）。real 对应面 = `packages/ui/src/extension-host/PluginViewContainer.vue` 空态分支（`plugin-view-empty`：LayoutGrid + 「暂无插件视图」占位）——当前全仓无 sidebar.tab 贡献方时容器恒走该空态，行形态无消费方（demo 的六要素行为 mock 数据形态）。裁决 = 暂不复刻；有真实插件贡献场景时再按上述六要素单开波次复刻。本条为登记型，运行时逻辑不动。
- **原条目 13 · composer 锚点保护态 btw 左距微差与裁决日期口径差（已关闭，2026-10-10 用户裁决：不处理）**：① composer 最窄档（fit 3 顶格仍溢出 → 锚点保护，病理窄宽）下「+ ↔ btw」左距 real 4px vs demo 8px——该档位无真实使用场景，不为它增加第三档条件类；② 「文件名 ellipsis 改向」裁决日期 demo 侧注释记 2026-10-11、仓外 spec requirements.md 记 2026-10-10，一天口径差不统一。
- **原条目 14 · composer 行内徽章精修（方案 C）的编辑器层债与范围外项（2026-10-11 登记，staging banner 已落地销项）**：OD 定稿 spec = 项目 `specs/composer/composer-chips.md`，real 已全部落地（`63ea988d4` 徽章实体化 + `a82e33ba1`/`1b9f3b998`/`de45f6f53`/`7e52cbc98` 两轮对抗审查修复 + staging banner 形态落地——banner 驱动位 = 既有 `staging.activeStaging`，旧呈现通道随 demo「图标是唯一染色点」裁决退役，handoff 入口接线不属形态波未做）。① image 缩略图已上移为待立项通道 3；② **编辑器层两债**（spec 第五节标注「真实接入时」）——换行行首/行尾的单侧 margin 悬挂（demo 仅 `:first-child` 静态覆盖，需行盒计算动态裁剪）与光标高度锁定（原生光标取整行高，需锁 15-16px 字号高），demo 亦未做，保持等价、随编辑器波处理；③ **触发弹层锚定细节**——demo 弹层锚光标坐标（上方约 190px 预算不足翻转下方），real 五路触发（`/` `$` `@` `#` + skill）链路自有锚定，交互行为差异不在样式复刻范围。
- **原条目 15 · composer 域两轮对抗审查的登记型差异（2026-10-11 十项全部裁决关闭）**：用户裁决——① `/` 仅行首弹命令浮层、行中空白后走 skill 浮层：real 口径正确，OD spec composer-chips.md §4 已按此改准；② 空候选 Enter 吞键不发送：保留（防误发），spec 已补口径；③ 浮层打开时点击编辑器即收：保持 real 关闭行为；④ 删除徽章只清尾侧 ZWSP：行为等价不改代码，spec 已改写为两实装等价口径；⑤ banner 文案 truncate：维持（i18n 长文案防溢出，有意差异）；⑥ 盒体 has-input 微环与流式 accent 发光：裁决**降一档亮度**已实施（composer-shell boxClass——steer 档 3px glow→2px accent-ring、has-input 档 40%→25%，bash 特殊模式档不动）；⑦ 模型弹层 `.pt` 行尾标签已上移为待立项通道 4；⑧ 托盘聚合钮运行数角标：保留（功能性信息，沿「导航计数徽标保留」先例）；⑨ spec composer-bar.md §4.3 B1「有意的分叉」过期文本：已改写为「已按 4.2 目标次序落地收敛」；⑩ CommandPopover pop-head 不补：取舍与再议条件自包含锚定在 CommandPopover.vue 头注。

### 早期裁决与登记（复刻波内既有）

- **主题 label 名实漂移（已关闭：取「改 label 文案」选项）**：demo 玄主题行文案实为「太极 · 玄（暗 · 青玉 · 默认）」（原登记「demo 亦沿用旧名」前提有误）。`useTaijiThemes.ts` 玄主题 label 与头注释的色相描述 = 青玉，与 swatch 首格 `#7fb89c` 名实一致；appearance-page 单测断言同步。其余五主题 label（依稀蓝相/宣纸暖相/宣纸墨黑/宣纸花青/宣纸朱砂）与 DESIGN.md「阴 · 暗色族 / 阳 · 亮色族」描述一致，不在漂移面。
- **导航计数徽标保留**：demo 设置导航无徽标，real 保留（功能性信息），形态已按 demo .bdg 对齐。
- **外观设置行距差 8.6%**：根因 = html font-size 14px 全局 rem 缩放 + line-height 1.5/1.55，属全局基建；单点补丁破坏字号缩放一致性，不修。
- **底抽屉默认高 35% vs demo 280px@900≈31%**：real 高度为持久化用户值（含显示期 clamp），默认值差异不构成回归，维持。
- **markdown 表格网格 / 底抽屉 tab 描边**：像素取证证伪（1x 缩略截图伪影），代码已与 demo 逐值一致。
- **裸 border 灰白线（系统性）**：从根源修复 = shared preset `borderColor.DEFAULT = var(--border)`，15 处消费点随之修正。
- **bg-card / text-muted / text-fg 失效类名**：preset 无映射的死类。本波改动范围内已清零（含 ProviderPage 包裹 GroupCard 时顺带核实的 ScopedModelSection bg-card）；ui 包 settings 域其余文件仍有残留（W2 报告登记 5 处已顺手清零，ModelListSection/ScopedModelSection 等原语层待 ui 包波次清扫）。
- **侧栏三件套逐值对齐（2026-10-10 用户反馈驱动）**：会话行（字重 `--fw-mid` 600 替代 font-semibold 700；选中态 = demo `.si.on` Tier B 无底无框仅文字提亮，覆盖 2026-10-06 accent 底+竖条形态）、hover 详情卡（demo `.sess-pop`：mouseenter 立即开替代 700ms 延迟、行首 13px 图标 + mono 12px 值、末行时间 meta、定位/120ms `--duration-fast --ease-out` 对齐 openCard 公式）、footer 三钮（**32px `.tbtn`**——`.app` 作用域 `--hb-chrome-btn` 继承值、fallback 24 永不生效，2026-10-10 聚合员勘误 + 15px 图标 + stroke 1.6）、快捷面板（chip 12px、头 11px、`--sel-bg/--sel-edge` Tier A 选中 token 新增、左对齐 bottom 锚 8px、hover 开 + 260ms 延迟关、主题序对齐 demo THEME_PRESETS）。连带发现并从根源修复 **PopoverContent 封装 fallthrough 断链**：封装模板单根 = PopoverPortal(Teleport)，消费方传的 data-testid/事件监听被 Vue 在 Teleport 边界静默丢弃（ImportSessionDialog 的 import-dir-menu 同类隐患一并治愈）——`inheritAttrs:false` + `$attrs` 显式转发到内部 reka PopoverContent；preset boxShadow 补第三档 `3: var(--shadow-3)`。面板 testid 丢失曾致真机排查大面积假阴性（面板实际正常渲染），排查时以 reka 原生 `id^="reka-popover-content-"` 为准。
- **capbar 常态渲染 vs spec R2.3（已修复对齐，review-fix-loop 第 1 轮 MF-1-40 落地）**：渲染门控已按 spec R2.3 / demo ComposerBar（`v-else-if contextPct>80`）对齐——≤80% 不渲染（ComposerCapacityBar.vue 门控 `hasPercent && percent > CAPACITY_BAR_WARN_THRESHOLD`），capacityBarClass 无 accent 常态档（仅 >80 warn / >95 danger 两档，context-usage-display.ts；与浮层卡内 usageBarClass 的 70/90 阈值差为在册有意差异）。spec 基线文档 taiji-ui-requirements-spec.md 不在本仓，其 S3 行（capbar 冲突）同步标记已解决，待主会话在 spec 侧同步。
- **文件树长文件名展示契约互斥（已关闭，2026-10-10 用户裁决 #7「不做横向滚动，用省略号+悬停展示」；demo 同日 20:00 改向同口径）**：real 宽度模型从 max-content 整树横滚切换为 100% 容器宽（FileView itemProps），FileTreeRow 名称段 = ellipsis 截断 + title 悬停展示全名，与 demo `.fname` 现行契约同构（demo 早期 `.fname-scroll/.fname-roll` marquee 方案已废弃、源树无该类定义，real 侧 marquee 双层结构随改向卸载）。旧互斥登记与「待裁决期间禁止补 truncate」约束作废。
- **spec R8.3 footer 钮尺寸文本与 demo 权威矛盾（已关闭，spec v1.1 已含 R8.3 32px 勘误）**：demo 权威 = workbench.css `.app{--hb-chrome-btn:32px}`，`.tbtn{width:var(--hb-chrome-btn,24px)}` 的 fallback 24 因变量恒有值永不生效；real 侧按 32px 对齐已随本波 MF-1-4 落地，spec 文本修订（R8.3 尺寸 24px→32px）已由主会话在 spec 侧完成。R6.2 状态列 real 未复刻标注已随原条目 6 登记。
- **UsageLedger 用量摘要行展示级 21/24px 字号不入 --text-* 档（登记保留）**：settings 用量摘要数字行 = demo ledger 展示级字面大字号（总 Token lead 24px / 其余格 21px，UsageLedger.vue 全仓仅有的 21/24px 使用点），超出字号 scale 档位上限（style.css `--text-*` 仅 10–15px 六档，全档随全局/分区字号缩放），刻意跳过归档、维持 demo 字面 px（不随缩放链，展示级大字非正文可读性字号）；同 22px 问候语先例（Landing.vue，spec §3.1 出处登记在案）。UsageLedger.vue 文件头注释已补值级出处。

## 关联

- [e2e-visual-shell-baseline-stale.md](e2e-visual-shell-baseline-stale.md)：本波后 shell/composer 两张基线再次红（有意变更），push 后 CI 通道重录。
- [mobile-token-mirror-divergence.md](mobile-token-mirror-divergence.md)：Wave1 已同步 accent 族到 mobile 镜像（parity 断言强制），bg/neutral 等仍分叉如前述登记。

<template>
  <!-- split-justified: trace 块转发壳（thinking/text 已迁 ThinkingRow/TextRow，tool/agentgraph/run-group 待 W2/W3 迁出）；script 超 300 为壳内残余分支存量，五类型全部迁出后回归预算 -->
  <!--
    展示组件 · trace 块转发壳（message-stream 折叠区内的单个块，Turn 层唯一渲染单元入口）。
    壳职责：根元素持 .trace-blk / .trace-blk--text 类名契约（下方块间节奏注释——容器选择器
    前锚，类名丢失只会静默丢间距，无类型错误可查）+ data-testid（block-tool-<id> /
    block-thinking-<id>）+ 按 type 分派行组件。转发壳不引入新 DOM 层（壳根 = 原 Block 根
    div，Row 根 = 原分支根 div），视觉像素不变。
    - thinking → ThinkingRow（折叠状态机 / 尾行视口 / 时长 / 扫光 / 展开区）。
    - text → TextRow（markdown / error 追加行 / 行尾时刻 / turn-actions 锚行；#turn-actions
      插槽经壳透传，锚行开关经 hasTurnActions 由壳 $slots 判空传入）。
    - tool / agentgraph（subagent / workflow 子分支）/ run-group 暂住壳内（W2/W3 迁出，
      迁后五类型全部转发）：
      - tool：默认 1 行收起（streaming/running 也收起），点击展开详情。failed 终态默认展开（streaming 中失败不 remount，只图标染 danger）。
      - workflow：list-checks ICON + WORKFLOW. prefix + 状态动词 + workflow 名，详情区走 list-tree GUI / 文本。
      - subagent：渲染委托给 BlockSubagent（users ICON + SUBAGENT. prefix + 去卡片化）。
      - run-group：run 类型分组组块——组头「类型名[ · 序号] + N 步 · 耗时 + 含 M 次失败」，
        展开后成员行（嵌套递归渲染普通 tool 收起态，SFC 文件名自引用）。
      - 展开块限高：bash 输出 / 非 bash 工具输出统一走 BlockScrollBox（240px 块内滚动 +
        渐隐提示 + 行区间信息条；bash 命令头保持在滚动区外 = 恒吸顶）；GUI 协议输出自管理高度不包。
      - failed：无鲜红全展开（红框已删），行文字保持中性灰、图标常驻染 danger（demo
        .line.subagent.failed .sicon 形态），错误摘要进 body 文本。
    审批按钮 DEFERRED（G-018），v1 不渲染。failed 救生按钮不做（agent 自处理，design.md 决策 3）。
  -->
  <!-- 块间节奏（MF-1-3，demo workbench.css 机制同构）：间距唯一权威 = Turn.vue trace 容器
       scoped——过程行块 py 5px 与块间 margin 两档均在容器侧（.trace-blk--text 正文块无 py，
       与 demo .line 仅过程行挂 padding 一致）。trace-blk--text 是正文类型标记，供容器侧
       选择器前锚。
       [M3b demo 复刻] 块级 running 容器染色（chat-flow-polish P0-1 accent 左标 + soft 底）已删：
       demo 运行态只落在行级（呼吸弧 accent 图标 + 文字扫光，workbench.css .run-ic/.shine），
       .blk 容器无任何 running 形态——行级信号已足，块级染色是 demo 不存在的自行发明。 -->
  <div class="trace-blk" :class="type === 'text' ? 'trace-blk--text' : ''" :data-testid="testId">
    <!-- thinking 行 → ThinkingRow（折叠状态机 / 尾行视口 / 时长 / 扫光 / 展开区，W1 迁出） -->
    <ThinkingRow
      v-if="type === 'thinking'"
      :content="content"
      :thinking-id="thinkingId"
      :collapsed="collapsed"
      :working="working"
      :thinking-start="thinkingStart"
      :thinking-end="thinkingEnd"
      :message-timestamp="messageTimestamp"
      :session-id="sessionId"
    />

    <!-- 正文行 → TextRow（markdown / error 追加行 / 行尾时刻 / turn-actions 锚行，W1 迁出；
         #turn-actions 插槽经壳透传，锚行开关 = 壳 $slots 判空） -->
    <TextRow
      v-else-if="type === 'text'"
      :content="content"
      :streaming="streaming"
      :status="status"
      :error="error"
      :message-timestamp="messageTimestamp"
      :session-id="sessionId"
      :has-turn-actions="!!$slots['turn-actions']"
    >
      <template #turn-actions>
        <slot name="turn-actions" />
      </template>
    </TextRow>

    <!-- ── run 组块（run 类型分组，demo specs/chat/history-load-and-run-grouping.md §3）：
         连续同类型（探索 / 改动 / 执行命令）的工具行折成一行组头。组资格只看工具类型不看状态，
         组头计数三条口径（N=成员数 / 耗时=已完成成员合计 / M=组内失败数）与 hasRunning 由 core
         groupToolRuns 一次算好（header），本组件零解析。类型判定表见 core RUN_GROUP_TOOLS。
         展开态：挂载一律收起（2026-10-15 裁决 ①A：无论什么时候分组的 block 默认折叠、不展开
         内部 tool call，running 成员也不例外——回看与直播形态一致，进行中信号由组头动效图标 +
         「N 步」计数承担）；用户手动开合后以手动为准（本地 ref）。**不做 status 驱动的自动开合**——
         展开/收起翻转会让流式中的块高度突变，破坏贴底跟随（同 Block toolCollapsed 挂载快照的既有取舍）。
         失败不隐瞒：成员含 error 时行尾 traceFailed 段（M = 组内口径，与 TraceCompactorRow 全局
         failedCount 分账）。展开后成员保持各自 1 行收起态（嵌套普通 tool Block 复用既有行形态与
         PR-1 行高不变量），要看某个成员的输出需再点那一行（两步路径）。展开态住组件本地 ref、
         不进 store 不持久化（turn 级展开态现状也不持久化，不为更低层的 UI 态单开先例）。 -->
    <div v-else-if="type === 'run-group' && group" class="trace-run-group" data-testid="run-group">
      <div
        data-testid="run-group-header"
        class="group/bgroup flex min-w-0 cursor-pointer select-none items-baseline gap-[8px] [font-weight:var(--fw-mid)] text-neutral-mid"
        role="button"
        tabindex="0"
        :aria-expanded="groupExpanded"
        :title="groupExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
        @click="toggleGroup"
        @keydown.enter.prevent="toggleGroup"
        @keydown.space.prevent="toggleGroup"
      >
        <!-- running 态 loader（呼吸弧 + accent），其余走组类型对应的静态图标（切换走 tico 交叉过渡，
             同 tool/thinking 行）。组头文字（「N 步 · 耗时」计数/耗时口径）是稳定标识，不跑文字扫光。
             行文字不染 accent（demo 运行态 = 仅呼吸弧图标 accent，文字保持行层级 mid，
             workbench.css .tool .t-name），与普通 tool 行运行态同款。 -->
        <RunningBlockIcon v-if="group.hasRunning" :kind="RUN_GROUP_RUNNING_ICON[group.base]" />
        <component :is="BLOCK_ICON_LUCIDE[RUN_GROUP_ICON[group.base]]" v-else :class="[BLOCK_ICON_CLASS, 'self-center']" />
        <span class="shrink-0 whitespace-nowrap text-left transition-opacity duration-[var(--duration-fast)] group-hover/bgroup:opacity-80">{{ t(RUN_GROUP_LABEL_KEY[group.base]) }}</span>
        <!-- 同名组序号（demo `.rg-seq`）：第二个「探索」起显示「 · 2」，同类型的多段在回看时可区分 -->
        <span v-if="group.seq > 1" class="shrink-0 whitespace-nowrap font-mono text-neutral-dim">· {{ group.seq }}</span>
        <!-- 里程碑徽标（demo spec §3.6 `.rg-badge`，位于序号与统计段之间）：core 结构派生的信号
             聚合上组头（当前 = 首个改动），无则不渲染。视觉 = accent 低饱和 pill（字 accent /
             边 accent-ring 30% / 底 accent-soft 10%，SessionItemDisplay agent badge 同族），
             pop 200ms 入场动效见 scoped `.trace-run-group .rg-badge`。 -->
        <span
          v-for="mile in group.miles"
          :key="mile"
          data-testid="run-group-mile"
          class="rg-badge shrink-0 whitespace-nowrap rounded-full border border-accent-ring bg-accent-soft px-[7px] font-mono text-[length:var(--text-xs)] text-accent"
        >{{ t(RUN_GROUP_MILE_LABEL_KEY[mile]) }}</span>
        <span class="min-w-0 truncate text-left font-mono text-neutral-dim transition-opacity duration-[var(--duration-fast)] group-hover/bgroup:opacity-80">{{ groupStatText }}</span>
        <!-- 失败段 chip 化（demo failtag 形态：workbench.css .failtag = 11px fw-mid danger +
             danger-soft 底 + r-xs 4px + 1px 6px 内边距） -->
        <span v-if="group.header.failedCount > 0" data-testid="run-group-failed" class="shrink-0 rounded-[var(--radius-xs)] bg-danger-soft px-1.5 py-px text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-danger">{{ t('panel.message.traceFailed', { count: group.header.failedCount }) }}</span>
      </div>
      <Transition name="block-expand">
        <div v-if="groupExpanded" class="mt-0.5 flex min-w-0 flex-col">
          <Block
            v-for="m in group.members"
            :key="m.flatIndex"
            :type="m.block.kind"
            :tool="m.block.kind === 'tool' || m.block.kind === 'agentgraph' ? (m.block.ref as ToolCall) : undefined"
            :session-id="sessionId"
          />
        </div>
      </Transition>
    </div>

    <!-- tool_call 块：默认 1 行收起（streaming/running 也收起），header 含摘要，点击展开详情。
         subagent（pi-subagents 的 "subagent" tool）渲染委托给 BlockSubagent（独立样式：users ICON +
         SUBAGENT. prefix + 去卡片化）——subagent 逻辑已抽离到 BlockSubagent.vue。
         workflow（pi-workflow 的 "workflow" tool）：list-checks ICON + WORKFLOW. prefix + list-tree GUI。 -->
    <div v-else class="trace-tool">
      <!-- ── subagent 块：委托 BlockSubagent ── -->
      <BlockSubagent v-if="isSubagent" :tool="tool!" :session-id="sessionId" />

      <!-- ── workflow 块：collapsed only 单行（icon + workflow prefix + name · slug），点击开 workflow overlay（workflow-visualization U6/D1 入口改向）；
           name 下多阶段 chips（phases 折叠快照，§3.1-2④：只表达 phase 名与最新一轮状态，不经 DAG 通道）── -->
      <div v-else-if="isWorkflow" class="trace-workflow" data-testid="workflow-block">
        <div
          data-testid="tool-block-header"
          class="group/wf flex min-w-0 cursor-pointer select-none items-baseline gap-[8px] [font-weight:var(--fw-mid)] text-neutral-dim"
          @click="openWorkflowDrawer"
        >
          <!-- running 态 loader（呼吸弧 + accent），其余走 list-checks ICON（瞬时切换，tico
               交叉过渡已移除，见 thinking 行 [HISTORICAL]）；failed 图标染 danger（与普通 tool 行同款，demo .line.subagent.failed .sicon 形态家族） -->
          <RunningBlockIcon v-if="isRunning" kind="workflow" />
          <component :is="BLOCK_ICON_LUCIDE.workflow" v-else :class="[headerIconClass, 'self-center']" />
          <span :class="[BLOCK_LABEL_CLASS, 'transition-opacity duration-[var(--duration-fast)] group-hover/wf:opacity-80']">{{ t('panel.message.workflow') }}</span>
          <!-- name 染对话流专属名称色 --name（2026-10-06 裁决）；slug 降行层级灰（与「子代理」等标签同色 --neutral-mid） -->
          <span v-if="workflowFields.nameShort" class="shrink-0 whitespace-nowrap font-mono text-[color:var(--name)] transition-opacity duration-[var(--duration-fast)] group-hover/wf:opacity-80" :title="workflowFields.name">{{ workflowFields.nameShort }}</span>
          <template v-if="workflowFields.slug">
            <span class="text-neutral-faint">·</span>
            <span class="min-w-0 shrink-0 truncate font-mono text-neutral-mid transition-opacity duration-[var(--duration-fast)] group-hover/wf:opacity-80">{{ workflowFields.slug }}</span>
          </template>
        </div>
        <!-- mini phase 管道 chips：数据源 = WorkflowRunRecord.phases 折叠（getWorkflows 同批透出，
             反查经 core lookupWorkflowRun 桥接——ui 不 import renderer store）；settledAt 有值 =
             已收束（success 点）、缺省 = 进行中（accent 点），fold 无 failed 语义不造第三态 -->
        <div
          v-if="workflowChips.length"
          class="mt-1 flex flex-wrap items-center gap-1.5 pl-6"
          data-testid="workflow-block-chips"
        >
          <span
            v-for="p in workflowChips"
            :key="p.phase"
            class="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm border border-hairline px-1.5 py-px font-mono text-[length:var(--text-3xs)] text-neutral-mid"
            :data-testid="`workflow-chip-${p.phase}`"
            :data-state="chipState(p)"
            :title="chipTitle(p)"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="p.settledAt !== undefined ? 'bg-success' : 'bg-accent'"
            />
            <span class="min-w-0 truncate">{{ p.phase }}</span>
          </span>
        </div>
      </div>

      <!-- ── 普通 tool 块：1 行收起（header 含 toolName+argPath 摘要+状态），点击展开详情。
           group/tool 命名分组承载行尾时刻槽的悬停/键盘聚焦两翼显现（D2）── -->
      <div v-else class="group/tool">
        <div
          data-testid="tool-block-header"
          class="tool-header flex min-w-0 cursor-pointer select-none items-baseline gap-[8px] [font-weight:var(--fw-mid)] text-neutral-mid"
          :title="toolExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
          @click="toggleTool"
        >
          <!-- running 态 loader（呼吸弧 + accent），其余走 BLOCK_ICON_LUCIDE[iconKind]
               （瞬时切换；tico 交叉过渡已随 Vue 3.5.39 out-in 调度 bug 移除，见 thinking 行
               [HISTORICAL]）。
               [M3b demo 复刻]（workbench.css .tool/.run-ic）：行文字恒行层级 mid 不随状态染色
               （demo .tool .t-name 恒 mid，无 accent/danger 文字态），状态色只落在图标——
               running = accent 呼吸弧、failed = danger（.line.subagent.failed .sicon）。 -->
          <RunningBlockIcon v-if="isRunning" :kind="toolRunningKind" />
          <component :is="headerBlockIcon" v-else :class="[headerIconClass, 'self-center']" />
          <span class="shrink-0 normal-case tracking-normal transition-opacity duration-[var(--duration-fast)] group-hover/tool:opacity-80">{{ toolName }}</span>
          <!-- running + 有流式输出：单行尾行视口（同 thinking header 结构：leading-normal
               字体无关行高 + mr-auto 短行左贴/溢出钉右 + 纵向状态机滑入）；否则静态 shortenForHeader。
               [M3b demo 复刻] 摘要/尾行走 mono（demo .tool .cmd = font-mono 命令语境），字号随
               trace 容器行主体统一档（15px），mono 字族承担命令语境区分。 -->
          <span
            v-if="isRunning && toolTailLines.length > 0"
            class="flex h-[1lh] min-w-0 flex-1 self-center justify-end overflow-hidden font-mono normal-case leading-normal tracking-normal text-neutral-dim transition-opacity duration-[var(--duration-fast)] group-hover/tool:opacity-80"
            :class="{ invisible: toolExpanded && isBashTool }"
          >
            <span class="text-sweep mr-auto flex flex-col items-end self-start" :style="toolScrollStyle">
              <span v-for="(line, i) in toolDisplayLines" :key="i" class="whitespace-nowrap">{{ line }}</span>
            </span>
          </span>
          <!-- N1（ui-optimize-unified 决策 8）：edit/write 行 = 工具名 + basename chip，
               与 UserBubble 文件 badge 同语义（openFileDetail 双通道 + @click.stop 防行展开 +
               title 完整路径 + ellipsis）。
               [M3b demo 复刻] chip 形态对齐 demo .tool .fchip（workbench.css:372）：card-inset
               凹陷底 + hairline 边 + fg-2 字 + mono + 1px 8px 内边距，字号随 trace 容器行主体
               统一档（15px）；demo chip 无图标（FileText 移除）。hover 提亮为 real 保留 affordance
               （demo 无 hover 形态）。
               [MF-1-24]（demo workbench.css:372-386 同款）：max-w-[320px] 上限（长文件名不再
               吃满整行）+ 内层 fchip-roll 双 span 轻方案——静态 truncate 截断，hover 时容器
               text-overflow:clip + 内层 roll 滚到文末停（forwards）、短名 min(0px,…) 取 0
               不滚、reduced-motion 停（动画与 media 查询在本文件 scoped 尾部）。 -->
          <span
            v-else-if="argPath && isFileWriteTool"
            data-testid="tool-file-chip"
            class="tool-file-chip inline-flex min-w-0 max-w-[320px] cursor-pointer items-center gap-1 truncate rounded-sm border border-hairline bg-bg-input px-2 py-px font-mono normal-case tracking-normal [font-weight:var(--fw-text)] text-[color:var(--neutral-fg-2)] transition-[color,border-color,opacity] duration-[var(--duration-fast)] hover:border-border-strong hover:text-neutral-fg hover:[text-overflow:clip] group-hover/tool:opacity-80"
            role="button"
            tabindex="0"
            :title="argPath"
            @click.stop="openFileDetail(argPath)"
            @keydown.enter.stop.prevent="openFileDetail(argPath)"
            @keydown.space.stop.prevent="openFileDetail(argPath)"
          >
            <span class="fchip-roll inline-block whitespace-nowrap">{{ fileChipBasename }}</span>
            <!-- 统计段：edit 工具 diff 增删行数（core parseDiffStat 数据层；write 工具/历史会话
                 缺省不渲染）。mono dim，与行尾耗时槽同档灰阶。 -->
            <span
              v-if="fileChipDiffStat"
              data-testid="tool-file-chip-diffstat"
              class="shrink-0 tabular-nums text-neutral-dim"
            >+{{ fileChipDiffStat.additions }} −{{ fileChipDiffStat.deletions }}</span>
          </span>
          <span v-else-if="argPath" class="min-w-0 font-mono normal-case tracking-normal text-neutral-dim truncate transition-opacity duration-[var(--duration-fast)] group-hover/tool:opacity-80" :class="[{ invisible: toolExpanded && isBashTool }, isRunning ? 'text-sweep' : '']">{{ shortenForHeader(argPath) }}</span>
          <!-- tool 块行尾槽（[M3b demo 复刻] demo .dur/.ts）：耗时常驻显形（demo .dur 无显隐
               门控，fs-md 12px mono dim——running 也保持 dim，accent 只在呼吸弧图标），
               时刻保留 D2 悬停化（demo .ts opacity 0→1 hover 显形）；耗时与时刻间无分隔点
               （demo 两 span 裸相邻，行 gap 8px 承担间距）。 -->
          <span v-if="tool?.startTime" class="ml-auto shrink-0 flex items-center gap-2 self-center font-mono tabular-nums" data-testid="tool-time-slot">
            <span v-if="toolDuration" class="text-[length:var(--text-xs)] text-neutral-dim">{{ toolDuration }}</span>
            <span class="text-[length:var(--text-2xs)] text-neutral-dim opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/tool:opacity-100 group-focus-within/tool:opacity-100">{{ formatClock(tool.startTime) }}</span>
          </span>
        </div>
        <Transition name="block-expand">
          <!-- 内容区：统一 group 包裹，copy 按钮浮在左上角复制全部内容 -->
          <!-- bash 展开恒渲染容器（命令块必显，D2：空输出/running 无输出不再「header 摘要消失 + 内容空白」假展开） -->
          <div v-if="toolExpanded && (displayContent || guiComponent || isBashTool)" class="group/content relative mt-1">
            <!-- copy 按钮：hover 显示，复制 copyContent（bash=命令+输出，其余=输出） -->
            <div class="absolute top-0 left-0 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/content:opacity-100">
              <Button
                variant="ghost"
                size="icon"
                class="size-5 rounded-sm text-neutral-dim hover:text-neutral-fg"
                :title="t('panel.message.copy')"
                @click.stop="copy(copyContent, `tool-${tool!.id}`)"
              >
                <Check v-if="copied === `tool-${tool!.id}`" class="size-3 text-success" />
                <CopyIcon v-else class="size-3" />
              </Button>
            </div>
            <!-- bash 整体容器：v6 §5 扁平凹槽（无 border + bg-input 深于父级，深度差即边界） -->
            <div v-if="isBashTool" class="rounded-sm bg-bg-input">
              <!-- 命令头：保持在凹槽内、BlockScrollBox 之外 = 不随输出滚动（恒吸顶是布局的免费性质，
                   无需「移入滚动区首位 + sticky + 底色遮盖」三件套，见设计 D6 接入点②） -->
              <div v-if="argPath" class="border-b border-hairline pl-4 py-1.5 font-mono text-[length:var(--text-sm)] text-neutral-fg">
                {{ argPath }}
              </div>
              <!-- 输出文本区内容守卫：均空时不渲染（只剩命令块，无空白假展开）；
                   限高滚动 + 行区间信息条由 BlockScrollBox 统一承担（含原 max-h-80 的 JSON 分支） -->
              <BlockScrollBox v-if="displayContent || outputRaw || parsedJsonOutput" surface="recessed">
                <div :class="toolResultClass">
                  <AnsiText v-if="outputRaw" :content="outputRaw" />
                  <!-- JSON output（如 bash 执行 cw 命令的结构化输出）格式化缩进 -->
                  <pre v-else-if="parsedJsonOutput" class="m-0 whitespace-pre">{{ parsedJsonOutput }}</pre>
                  <span v-else>{{ displayContent }}</span>
                </div>
              </BlockScrollBox>
            </div>
            <!-- 非 bash：meta 条 + 输出 -->
            <template v-else>
              <div v-if="filteredMetaItems.length" class="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 font-mono text-[length:var(--text-xs)]">
                <span
                  v-for="(item, idx) in filteredMetaItems"
                  :key="idx"
                  class="text-neutral-dim"
                >{{ item.text }}</span>
              </div>
              <!-- GUI 协议输出自管理高度，不包 BlockScrollBox（设计 D6 接入点③） -->
              <div v-if="guiComponent" :class="toolResultClass">
                <GuiComponentRenderer :component="guiComponent" />
              </div>
              <!-- [tool-detail-rich] read/write/edit 经壳注入组件富渲染（diff / 行号代码块）。
                   水平滚动自管理（BlockScrollBox 仅 overflow-y）；壳未注入（mock 壳）或非三类
                   工具 → 走下方纯文本兑底。 -->
              <BlockScrollBox v-else-if="hasRichDetail">
                <component :is="chatViewDeps.toolDetailRenderer" :tool="tool!" :session-id="sessionId" />
              </BlockScrollBox>
              <!-- 文本 / ANSI / JSON 输出：统一块内滚动（G5/D6） -->
              <BlockScrollBox v-else>
                <div :class="toolResultClass">
                  <AnsiText v-if="outputRaw" :content="outputRaw" />
                  <pre v-else-if="parsedJsonOutput" class="m-0 whitespace-pre">{{ parsedJsonOutput }}</pre>
                  <span v-else>{{ displayContent }}</span>
                </div>
              </BlockScrollBox>
            </template>
            <!-- [D6-⑨ u7] toolResult 图片（bash/非 bash 分支共用的统一出口；路径引用渲染
                 + 帽满占位/降级 badge，见 ToolResultImages） -->
            <ToolResultImages
              v-if="tool?.images?.length"
              :session-id="sessionId"
              :images="tool.images"
            />
            <!-- bash meta 条（耗时等，内容区内） -->
            <div v-if="isBashTool && filteredMetaItems.length" class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 font-mono text-[length:var(--text-xs)]">
              <span
                v-for="(item, idx) in filteredMetaItems"
                :key="idx"
                class="text-neutral-dim"
              >{{ item.text }}</span>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy as CopyIcon } from '@lucide/vue'
import type { GuiComponent } from '@zhushanwen/extension-protocol'
import { extractGui } from '@zhushanwen/extension-protocol'
import type { MessageStatus, ToolCall } from '@taiji/shared'
import { SUBAGENT_TOOL_NAMES, WORKFLOW_TOOL_NAMES, displayWorkflowName } from '@taiji/shared'
import type { FlatBlock, RunGroupBase, RunGroupMile } from '@taiji/core/domain/chat'
import { lookupWorkflowRun, openWorkflow } from '@taiji/core/domain/drawer'
import { AnsiText, GuiComponentRenderer } from '../../rendering-protocol'
import ThinkingRow from './ThinkingRow.vue'
import TextRow from './TextRow.vue'
import BlockSubagent from './BlockSubagent.vue'
import BlockScrollBox from './BlockScrollBox.vue'
import ToolResultImages from './ToolResultImages.vue'
import RunningBlockIcon from './RunningBlockIcon.vue'
import type { BlockIconKind, RunningIconKind } from './block-icon'
import { BLOCK_ICON_CLASS, BLOCK_ICON_LUCIDE, BLOCK_LABEL_CLASS, getBlockIcon } from './block-icon'
import { MS_PER_SECOND, formatClock, formatDuration, formatJsonIfValid, shortenForHeader, tailLines, stripAnsi } from './format-utils'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import { useToolMeta } from './composables/useToolMeta'
import { useCopy } from './composables/useCopy'
import { TAIL_WINDOW_LINES, useTailScroll } from './composables/useTailScroll'
import { useLiveToolDuration } from './composables/useLiveToolDuration'
import { useChatViewDeps } from './chat-view-deps'

const { t } = useI18n()
const { copied, copy } = useCopy()
// N1 文件 chip 的 drawer 双通道经壳依赖注入（与 UserBubble 同一契约面；inject 强契约，
// 须在 provide ChatViewDepsKey 的容器内渲染）
const chatViewDeps = useChatViewDeps()

const props = defineProps<{
  type: 'thinking' | 'tool' | 'text' | 'agentgraph' | 'run-group'
  /** thinking / text 内容 */
  content?: string
  /** thinking 块 id（thinking 类型时由父组件透传，用于 data-testid 精确锚定；其他类型忽略） */
  thinkingId?: string
  /** thinking 起止毫秒时间戳（ThinkingBlock.startTime/endTime 透传，N6 思考行时长数据源；
   *  任一缺失不渲染时长——持久化重载链路 thinking part 无时间戳，维持现状展示） */
  thinkingStart?: number
  thinkingEnd?: number
  /** tool_call 数据（type==='tool' 时必填） */
  tool?: ToolCall
  /** run 组块数据（type==='run-group' 时由 Turn.vue 透传；组块数据契约 base/seq/members/header/hasRunning/miles）。
   *  base/seq 与 header 三条口径（count/durationMs/failedCount）由 core groupToolRuns 一次算好；
   *  miles = 里程碑徽标（§3.6，core 结构派生），空/缺省 = 无则不显示。 */
  group?: {
    base: RunGroupBase
    seq: number
    members: FlatBlock[]
    header: { count: number; durationMs: number; failedCount: number }
    hasRunning: boolean
    miles?: RunGroupMile[]
  }
  /** thinking 块初始折叠态（来自 ThinkingBlock.collapsed，默认收起） */
  collapsed?: boolean
  /** working 态（turn 进行中）：thinking 各态默认折叠（collapsed 初值 true），working→false
   *  未手动操作过的块回落收起（SSOT §3.3.3）。
   *  折叠态 working=true 时渲染尾部行窗口 + 双轴尾部追踪（W4 D4），
   *  working=false 保持头部 60 字符静态预览。
   *  tool 块不因 working 强制展开（streaming 态也 1 行收起，header 自带状态指示）。 */
  working?: boolean
  /** streaming 态（所属 assistant 正在流式）：驱动 text 分支颜色——streaming→text-neutral-mid，
   *  complete/缺省→text-neutral-fg（单调，不随兄弟 message 到达翻转）。
   *  由 Turn.vue 传 assistant.status === 'streaming'。thinking/tool/agentgraph 分支不消费此 prop。 */
  streaming?: boolean
  /** 所属 assistant 消息终态（text 分支 error 形态判定，SSOT §3.3.2）：
   *  status==='error' → 追加形态（content 崩溃前正文原色 + error 独立 danger 行）。
   *  [M2 形态统一] 纯 error 形态已消灭——错误文本只住 error 字段，content 恒为崩溃前
   *  正文（手动追加的错误消息 content 为空），渲染只有追加形态一种。thinking/tool 分支不消费。 */
  status?: MessageStatus
  /** 错误文本（assistant Message.error 字段，status==='error' 时有值——收口兜底保证非空）。 */
  error?: string
  /** 所属 assistant message 时刻（epoch ms，行尾时刻显示） */
  messageTimestamp?: number
  /** 所属 session（透传给 MarkdownRenderer 供文件路径打开 DetailPane 用） */
  sessionId?: string | null
}>()

const isFailed = computed(() => props.tool?.status === 'error')
const isRunning = computed(() => props.tool?.status === 'running')

/** running 工具耗时实时跳动（tick 生命周期 + 终态 startTime/endTime 换算拆至 useLiveToolDuration） */
const toolDuration = useLiveToolDuration(computed(() => props.tool), isRunning)
/* end_not_received（流结束未收到 tool_call_end，进程崩溃/WS 断连）原单独分支已并入
 * completed 的 neutral-mid 置灰（同为非 running 非失败的中性态，无需视觉区分）。 */
const toolName = computed(() => props.tool?.toolName ?? 'tool')
const isBashTool = computed(() => toolName.value === 'bash')
const result = computed(() => props.tool?.output)
/** 展示用内容：output 优先，failed 时兜底 tool.error（如 read ENOENT 输出为空但 error 有值） */
const displayContent = computed(() => result.value || (isFailed.value ? (props.tool?.error ?? '') : ''))
/** 输出区容器 class（bash 凹槽 / 非 bash / GUI 分支共用）：
 *  - py-1.5：bash 凹槽内的竖向留白（既有形态；非 bash 输出区无此留白）
 *  - hover:text-neutral-fg：非 bash 失败态提升可读性（既有形态，bash 无） */
const TOOL_RESULT_CLASS = 'tool-result font-mono text-[length:var(--text-sm)] leading-snug whitespace-pre-wrap pl-4 select-text text-neutral-mid'
const toolResultClass = computed(() => [
  TOOL_RESULT_CLASS,
  {
    'py-1.5': isBashTool.value,
    'hover:text-neutral-fg': !isBashTool.value && isFailed.value,
  },
])

/** JSON output 格式化（合法 JSON → 2 空格缩进；非 JSON 回退 null 原样渲染）——实现拆至 format-utils（本文件行数预算，无行为差异）。 */
const parsedJsonOutput = computed(() => formatJsonIfValid(displayContent.value))
/** 复制用内容：bash 包含命令+输出，其余同 displayContent */
const copyContent = computed(() => {
  if (isBashTool.value && argPath.value) {
    return displayContent.value ? `${argPath.value}\n${displayContent.value}` : argPath.value
  }
  return displayContent.value
})
/** 原始 ANSI 文本（未经 stripAnsi）。有此字段时用 AnsiText 渲染着色，无则回退 output 纯文本。 */
const outputRaw = computed(() => props.tool?.outputRaw)

/* ── tool 尾行视口（同 thinking，2026-08 抖动修复重写）──
 * isRunning + 有流式输出时，bash 用 outputRaw 去 ANSI 取尾行；其余 tool 用 displayContent 取尾行。
 * 无流式输出或非 running 保持静态 shortenForHeader(argPath)。 */
const toolTailLines = computed(() => {
  if (!isRunning.value) return []
  // bash：outputRaw 缺失（无 ANSI 输出）时回退 displayContent（D3 尾行取数）
  const raw = isBashTool.value ? (outputRaw.value ?? displayContent.value) : displayContent.value
  if (!raw) return []
  // 尾部窗口先行：tailLines 是尾部扫描 O(窗口)，先取尾再对窗口内 2 行 stripAnsi。
  // 反序（先全文 strip 再取尾）是 O(全文) 正则替换产出全文新串，每条 tool output 推送
  // 命中一次，架空 tailLines 的尾部扫描优化（format-utils.ts 2026-08 注释）。
  // 等价性：ANSI_RE 只匹配 \x1b[0-9;]*m——字符类不含 \n，strip 不增删换行、单次匹配
  // 不跨行，行边界 strip 前后不变，两序逐字节一致（对拍 format-utils.test.ts）。
  const tail = tailLines(raw, TAIL_WINDOW_LINES)
  return isBashTool.value ? tail.map(stripAnsi) : tail
})
const { displayLines: toolDisplayLines, contentStyle: toolScrollStyle } = useTailScroll(toolTailLines)

/** 补充细节条 meta 项（耗时 + 工具特化行数/字符数 + 失败错误摘要），逻辑拆到 useToolMeta */
const { metaItems } = useToolMeta({
  tool: computed(() => props.tool),
  toolName,
  isFailed,
})

/**
 * [tool-detail-rich] 富渲染路由谓词（壳注入 toolDetailRenderer 后，read/write/edit 三类
 * 非失败工具展开区改走富渲染，其余工具维持纯文本）：
 * - read：output 即文件内容，有值即可渲染（失败态在上方短路——错误信息不走代码渲染）；
 * - edit：pi details.patch（unified patch；details.diff 是展示格式不可用）存在才路由
 *  （历史会话缺字段回退纯文本）；
 * - write：input.content（写入全文）存在才路由（git diff 由壳组件内懒加载）。
 */
const hasRichDetail = computed(() => {
  if (!chatViewDeps.toolDetailRenderer || isFailed.value) return false
  const name = toolName.value
  if (name === 'read') return !!displayContent.value
  if (name === 'edit') return typeof props.tool?.details?.patch === 'string'
  if (name === 'write') {
    const input = props.tool?.input as Record<string, unknown> | undefined
    return typeof input?.content === 'string'
  }
  return false
})

/** bash 展开后去掉行数统计（命令+output 已完整展示，行数无参考价值） */
const filteredMetaItems = computed(() => {
  if (!isBashTool.value) return metaItems.value
  return metaItems.value.filter((item) => item.kind !== 'lines')
})

/* ── 块类型路由：subagent / workflow ── */
const isSubagent = computed(() => SUBAGENT_TOOL_NAMES.has(toolName.value))
const isWorkflow = computed(() => WORKFLOW_TOOL_NAMES.has(toolName.value))

/** 普通 tool header 的块类型 ICON（running 用 RunningBlockIcon，其余走 BLOCK_ICON_LUCIDE） */
const headerBlockIcon = computed(() => {
  const kind = getBlockIcon(toolName.value, props.tool?.status ?? 'completed', false, false)
  // running 态走模板的 RunningBlockIcon 分支（v-if isRunning），不走此 computed
  return kind === 'running' ? BLOCK_ICON_LUCIDE['tool-other'] : BLOCK_ICON_LUCIDE[kind]
})

/** 工具名 → 运行中动效 kind（RunningBlockIcon 消费；grep/find 探索单列透镜扫掠，
 *  未命中工具走 tool-other 字形呼吸兜底。与 block-icon TOOL_ICON_MAP 同构但独立声明——
 *  本表键值语义是「动效档」而非「图标档」，两表各自服务动效/静态 SSOT） */
const TOOL_RUNNING_KIND: Record<string, RunningIconKind> = {
  read: 'tool-read',
  bash: 'tool-bash',
  edit: 'tool-edit',
  write: 'tool-edit',
  grep: 'tool-grep',
  find: 'tool-grep',
}
const toolRunningKind = computed<RunningIconKind>(() => TOOL_RUNNING_KIND[toolName.value] ?? 'tool-other')

/** header 图标状态色（[M3b demo 复刻] workbench.css）：状态色只落图标不落行文字——
 *  running 走模板 loader 分支（accent 呼吸弧，行文字恒 mid），failed 图标染 danger
 *  （demo .line.subagent.failed .sicon，常驻非 hover——原 hover:text-warn 形态废弃）。
 *  failed 分支显式整类重写而非在 BLOCK_ICON_CLASS 上追加 text-danger：两个 text 色
 *  工具类同特异性，追加后由样式表序裁决、覆盖不成立。行文字层级 = static
 *  text-neutral-mid（D5 工具行档 + demo .tool .t-name 恒 mid 双依据）。 */
const headerIconClass = computed(() => (isFailed.value ? 'size-[15px] shrink-0 text-danger [stroke-width:1.6]' : BLOCK_ICON_CLASS))

/** workflow 顶层 input 安全读取（拍平 schema：action/name/slug/args/runId 都在顶层；runId 仅 schema 描述——run 动作调用时刻 runId 尚未由引擎生成、不可得，组件不读该字段，run 定位经 (name, slug) 反查，见 openWorkflowDrawer 注释与设计 §5 检查点④核实结论） */
const workflowInputObj = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  return input && typeof input === 'object' ? input : {}
})

/** workflow 标题行字段：name / slug（collapsed only，spec §11）。
 *  nameShort：ref 是绝对路径（input.name），标题行展示 basename 去 .js 短名
 *  （`/a/b/batch.js` → `batch`）——全路径太长挤占单行；drawer 选中仍用全路径 name。
 *  短名派生单点 = shared displayWorkflowName（与 tray 行同源）。 */
const workflowFields = computed(() => {
  const input = workflowInputObj.value
  const name = typeof input.name === 'string' ? input.name : ''
  const slug = typeof input.slug === 'string' ? input.slug : ''
  const nameShort = displayWorkflowName(name)
  return { name, nameShort, slug }
})

/**
 * 点击 workflow 块 → 开 workflow overlay（workflow-visualization U6/D1 入口改向）。
 * 传 (name, slug, sessionId)：反查 runId 的动作在 renderer opener 内单处执行（slug 缺失
 * 回落「name → 最新 run」现状语义、碰撞取最新）；sessionId = 本块所属 session（发起 pane
 * 的 session，D11⑤）。name 为空串时由 opener 兜底（反查不命中 → drawer workflow tab 空态，
 * 与现状「仅切 tab」归宿一致）。
 */
function openWorkflowDrawer(): void {
  openWorkflow(workflowFields.value.name, {
    slug: workflowFields.value.slug || undefined,
    sessionId: props.sessionId ?? undefined,
  })
}

/** chips 数据源：反查本块对应 run 的 phases 折叠（响应式——lookup 实现读 store 分区，依赖
 *  在本 computed 求值期间收集）。未绑定 lookup / 反查不命中 / 旧 run 无 phases → 不渲染。 */
const workflowChips = computed(() => {
  const name = workflowFields.value.name
  const sid = props.sessionId
  if (!name || !sid) return []
  return lookupWorkflowRun(sid, name, workflowFields.value.slug || undefined)?.phases ?? []
})

/** chip 状态词表（两态：fold 快照只有起止——settledAt 有值 = 已收束、缺省 = 进行中）。 */
function chipState(p: { settledAt?: number }): string {
  return p.settledAt !== undefined ? 'settled' : 'running'
}

/** chip 状态提示（数据点标题；phase 名即正文，title 只承载状态语义）。 */
function chipTitle(p: { settledAt?: number }): string {
  return p.settledAt !== undefined ? t('panel.workflowViz.chipSettled') : t('panel.workflowViz.chipRunning')
}

/**
 * 从 tool.details.__gui__ 提取结构化渲染组件（extension GUI 协议，spec §9.1）。
 * extension RPC 模式把 GuiComponent 放进 details.__gui__.component，前端用 extractGui
 * 统一校验版本后路由到 GuiComponentRenderer。无 __gui__ 时 undefined（走 AnsiText/纯文本兜底）。
 * 注：ToolCall 的结构化扩展数据存在 details 字段（pi tool_execution_end result.details）。
 *
 * streaming __gui__ 仅在 running 态有效——tool_call_end 后若 details 无 __gui__，
 * 不应回退到过期的 streaming detail（如 extension streaming 推了进度组件但最终返回纯文本）。
 * 否则已完成工具会错误显示 streaming 过程中的临时 GUI 组件。
 */
const guiComponent = computed<GuiComponent | undefined>(() => {
  // tool_call_end 的 details（复数，最终态）优先
  const fromEnd = extractGui(props.tool?.details)?.component
  if (fromEnd) return fromEnd
  // streaming 态 fallback：仅在 tool 仍在 running 时用 detail（单数）。
  // tool_call_end 后 detail 残留不应被当作渲染源（最终态无 __gui__ → 不渲染 GUI 组件）。
  if (isRunning.value) {
    const streamingDetail = props.tool?.detail
    if (typeof streamingDetail === 'object' && streamingDetail !== null) {
      return extractGui(streamingDetail)?.component
    }
  }
  return undefined
})

/**
 * tool 折叠：默认 1 行收起（含 streaming/running 态——header 行已含摘要+状态指示，
 * 1 行即可观察进度，点击才展开详情）。failed 终态默认展开（错误输出立即可见）。
 * mount 快照：toolCollapsed 仅在挂载时求值，Block key 不含 status（running→error 不 remount），
 * 故 streaming 中失败的工具不展开（只 header 染 danger），仅终态挂载（重开/回看）才展开（§3.3.1 选项 A）。
 * 被否：watch(tool.status) 强制展开——streaming 高度突变破坏跟底/回到底部浮层（P0 级风险）。
 */
const toolCollapsed = ref(!isFailed.value)
const toolExpanded = computed(() => !toolCollapsed.value)

function toggleTool(): void {
  toolCollapsed.value = !toolCollapsed.value
}

/* ── run 组块：图标 / 组名 / 统计段 / 展开态 ─────────────────────────────── */

/** 组类型 → 块图标：与同语义工具行同图标（探索 = 只读档 book-open / 改动 = pencil /
 *  执行命令 = square-terminal），三档都复用既有 BlockIconKind，不新开图标（组头即该段语义的标题）。
 *  排掉 'running'——组头运行态走 loader 分支（hasRunning），静态档永远不是 running 图标。 */
const RUN_GROUP_ICON: Record<RunGroupBase, Exclude<BlockIconKind, 'running'>> = {
  explore: 'tool-read',
  edit: 'tool-edit',
  exec: 'tool-bash',
}

/** 组类型 → 组头名（ui locale：探索 / 改动 / 执行命令） */
const RUN_GROUP_LABEL_KEY: Record<RunGroupBase, string> = {
  explore: 'panel.message.runGroupExplore',
  edit: 'panel.message.runGroupEdit',
  exec: 'panel.message.runGroupExec',
}

/** 组类型 → 组头运行中动效 kind（RunningBlockIcon；组头动效 = 组类别同款——探索扫描 /
 *  改动描线 / 命令光标闪烁，与成员行各自动效同源，不新开动画） */
const RUN_GROUP_RUNNING_ICON: Record<RunGroupBase, RunningIconKind> = {
  explore: 'tool-read',
  edit: 'tool-edit',
  exec: 'tool-bash',
}

/** 里程碑 → 徽标文案（ui locale）。当前唯一信号 firstEdit（首个改动）——信号来源与「语义里程碑
 *  不关键词派生」的裁决见 core RunGroupMile 类型注释。 */
const RUN_GROUP_MILE_LABEL_KEY: Record<RunGroupMile, string> = {
  firstEdit: 'panel.message.runGroupMileFirstEdit',
}

/**
 * 组头统计段「N 步 · 耗时」：耗时只在 ≥1s 时显示（不足 1s 的秒数对回看没有信息量，demo `.rg-stat`
 * 同口径）。耗时口径 = 组内已完成成员合计（core 侧算好），running 成员不计入。
 */
const groupStatText = computed(() => {
  const g = props.group
  if (!g) return ''
  const steps = t('panel.message.runGroupSteps', { count: g.header.count })
  return g.header.durationMs >= MS_PER_SECOND ? `${steps} · ${formatDuration(g.header.durationMs)}` : steps
})

/* ── run 组展开态：组件本地 ref，不进 store、不持久化——turn 级展开态（useTurnExpansion /
 *    turn-expansion store）现状也不持久化，不为一个更低层的 UI 态单开持久化先例。
 *    初值 = 恒收起（2026-10-15 裁决 ①A：原「组内有 running 成员则展开」例外已删——无论什么时候
 *    默认折叠，回看与直播形态一致），此后只由用户点击翻转。**不做 status 驱动的自动开合**：
 *    展开/收起翻转会让流式中的块高度突变、破坏贴底跟随（同 toolCollapsed 挂载快照的既有取舍，
 *    见该处注释的「被否」一条）。 ── */
const groupCollapsed = ref(true)
const groupExpanded = computed(() => !groupCollapsed.value)

function toggleGroup(): void {
  groupCollapsed.value = !groupCollapsed.value
}

/**
 * 从 input 提取可读参数摘要（header 单行展示）。覆盖高频工具：
 * bash→command、read/write/edit→path、grep→pattern、todo_write→tasks 数量等。
 * 未覆盖的工具返回空串（header 只显 toolName）。
 */
const argPath = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.command === 'string') return input.command
  if (typeof input.path === 'string') return input.path
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.pattern === 'string') return input.pattern
  if (Array.isArray(input.tasks)) return `${input.tasks.length} todos`
  return ''
})

/* ── N1（ui-optimize-unified 决策 8）：edit/write 工具行文件 basename chip ──
 * edit/write = pi builtin 写文件工具（shared BUILTIN_TOOLS；block-icon 同族归并 tool-edit），
 * header 摘要从完整路径 shortenForHeader 升级为 basename chip；read/bash 等其他工具行不变。 */
const isFileWriteTool = computed(() => toolName.value === 'edit' || toolName.value === 'write')

/** chip 显示名：路径末段（UserBubble file badge 的 fileBasename 同款口径，仅按 / 切分） */
const fileChipBasename = computed(() => {
  const parts = argPath.value.split('/')
  return parts[parts.length - 1] ?? argPath.value
})

/** edit 工具 diff 增删行数统计（core computeToolCallFill 解析 details.diff；write 工具
 * details 恒 undefined、历史会话缺字段 → undefined 不渲染统计段，形态回退现状） */
const fileChipDiffStat = computed(() => props.tool?.diffStat)

/** 点击 chip → 开 drawer detail tab（与 UserBubble badge 同语义双通道：selectFile 同 tick
 * 注入 detail tab 实例 + openDrawer 切 tab 开抽屉，缺一不可——见壳层 useDetailPane 注释） */
function openFileDetail(path: string): void {
  chatViewDeps.onFileClick(path)
  chatViewDeps.openDrawer('detail', { filePath: path })
}


/** data-testid 锚点：按块类型拼接可定位 id，供 E2E 精确断言特定块。
 *  格式：block-tool-${tool.id}（type==='tool'/'agentgraph' 且有 tool）/ block-thinking-${thinkingId}（type==='thinking'）。
 *  agentgraph（subagent/workflow）数据结构同 tool（ToolCall 有 id），故共用 block-tool 前缀。
 *  无 id（text / thinking 无 id）时回退 undefined（不输出 data-testid 属性，避免污染选择器）。 */
const testId = computed(() => {
  if (props.type === 'tool' || props.type === 'agentgraph') {
    const id = props.tool?.id
    return id ? `block-tool-${id}` : undefined
  }
  if (props.type === 'thinking') {
    return props.thinkingId ? `block-thinking-${props.thinkingId}` : undefined
  }
  return undefined
})
</script>

<style scoped>
/* 块展开/收起过渡（chat-flow-polish P0-2）：消除 v-if 瞬时切换的生硬感。
   opacity + 轻微 translateY（从 header 方向淡入），120ms；保持 v-if 卸载折叠块的长输出
   （不做 grid 恒渲染，避免 streaming 中折叠块长 bash 输出恒挂载的性能代价）。
   escape hatch：Vue Transition 类用 scoped 表达（enter-from/leave-to 同时设 opacity+transform）。 */
.block-expand-enter-active,
.block-expand-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease),
    transform var(--duration-fast) var(--ease);
}
.block-expand-enter-from,
.block-expand-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 执行中文字扫光（ui-optimize-unified 决策 10 / N13）：扫光对象 = 执行中工具行正在发生的
   内容文字（执行命令/摘要；思考行同款规则在 ThinkingRow.vue 各持一份——scoped 样式只
   作用于本组件模板元素，Row 拆分后壳内副本不再命中思考行），稳定标识（工具名/时间戳/计数）
   不扫。机制 = background-clip:text + 透明字色，base（--sweep-base，缺省 dim 档 =
   尾行视口/摘要常态字色）与 peak（--neutral-fg）
   全令牌化，六主题免逐个定值。周期 2.6s：前 55% 扫程（peak 自元素左外 -25% 移至
   右外 125%），后 45% 停帧。keyframes（text-sweep）在 renderer style.css 动画区
   全局定义——scoped 内定义会被编译器哈希改名而失效（同全局动画区先例理由）。
   prefers-reduced-motion 由 style.css 全局兜底（duration 0.01ms 停终态帧 position 0%，
   元素内恒 base 段 = 常态字色，「退回常态字色」构造性成立，无需额外覆盖）。
   escape hatch 理由：多属性组合类 + 变量参数化 + 停帧几何推导，Tailwind 任意值
   内联需 6 类 × 5 消费点且 motion-reduce 变体逐点易漏。 */
.text-sweep {
  --sweep-base: var(--neutral-dim);
  background-image: linear-gradient(100deg, var(--sweep-base) 42%, var(--neutral-fg) 50%, var(--sweep-base) 58%);
  background-size: 250% 100%;
  background-repeat: no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: text-sweep 2.6s cubic-bezier(0.45, 0, 0.25, 1) infinite;
}

/* 工具行文件 chip hover 滚动（MF-1-24，demo workbench.css .fchip-roll 轻方案原样移植）：
   静态截断由容器 truncate（ellipsis）承担，hover 时容器 text-overflow:clip（模板
   hover:[text-overflow:clip] 任意属性类）+ 内层 .fchip-roll 从原位滚到文末停（forwards），
   短名 min(0px, 304px-100%) 取 0 不滚（304 = max-w 320 - 左右 padding 16）。
   escape hatch：keyframes + 后代选择器组合（Tailwind 无法表达 hover 触发的位移动画）。
   keyframes 在 scoped 内定义 + 同块引用自洽（Vue SFC 编译器对 scoped keyframes 同块重写
   动画名；仅本组件单消费点，无跨组件引用失效问题）。 */
.tool-file-chip:hover .fchip-roll { animation: fchip-roll-x 2.4s var(--ease-out) 0.35s forwards; }
@keyframes fchip-roll-x { to { transform: translateX(min(0px, calc(304px - 100%))); } }
@media (prefers-reduced-motion: reduce) { .tool-file-chip:hover .fchip-roll { animation: none; } }

/* run 组头里程碑徽标入场（demo spec §3.5/§3.6 workbench.css .rg-badge + rg-badge-pop 同参）：
   opacity 0→1 + scale 0.6→1，200ms --ease-out-soft，backwards 填充（挂载帧即取 from 态，
   无闪烁）。徽标挂 v-for 上——首个改动完成、组首次渲染时元素插入，动画自然播一次。
   escape hatch 同 fchip-roll-x：keyframes + 后代选择器（Tailwind 无法表达 scale+opacity
   组合的入场帧），仅本组件单消费点。reduced-motion 显式停播（demo 同档；全局 0.01ms
   兜底只会瞬切终态，此处显式声明降级语义）。 */
.trace-run-group .rg-badge { animation: run-group-badge-pop 200ms var(--ease-out-soft, var(--ease-out)) backwards; }
@keyframes run-group-badge-pop { from { opacity: 0; transform: scale(0.6); } }
@media (prefers-reduced-motion: reduce) { .trace-run-group .rg-badge { animation: none; } }

</style>


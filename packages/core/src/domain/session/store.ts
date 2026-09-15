/**
 * Session store —— session 列表（core 域迁移版）。
 *
 * 来源：packages/renderer/src/stores/session.ts（pinia setup store）原样迁移为纯 factory。
 * 迁移约束（IF1）：不依赖 pinia；状态/操作函数语义逐条等价；消费方自行 .value（无 pinia unwrap）。
 * renderer 旧 store 保留，待消费方迁移（strangler 逐域绞杀 §11.2）完成后删除。
 *
 * 依赖方向：无（domain 间禁止互相 import；跨域协调由上层编排）。
 *
 * 注：session 的派生 5 态（D6 derivedStatus）不在此 store，由 useSidebar 派生
 * （它需同时读 chat store 的消息分区 + 全局 isStreaming，跨 store 协调属 composable 职责）。
 */
import { computed, ref } from 'vue'
import type { SessionGroup, SessionSummary, SessionViewSnapshot } from '@taiji/shared'

/**
 * 创建 session 列表 store（纯 factory，无 pinia 依赖）。
 *
 * 返回形状与原 pinia setup store 一致（ref/computed 原样返回）：
 * 消费方迁移时 storeToRefs 语义由显式 .value 取代。
 */
export function createSessionStore() {
  /**
   * 分组视图（按 cwd，对齐后端 SessionGroup[]，D7）。
   * 由 useSidebar.loadSessions 从 sessionApi.list() 填入；SessionList 按此渲染组标题 + 组内项。
   */
  const groups = ref<SessionGroup[]>([])

  /**
   * 扁平索引（groups.flatMap 展平），供 active/applySnapshot 等按 id 查找。
   * 派生自 groups：单一真源（groups）→ 扁平视图（list），避免两处分别维护导致漂移。
   */
  const list = computed<SessionSummary[]>(() =>
    groups.value.flatMap((g) => g.sessions),
  )

  /**
   * 当前导航/启动语义的 session ID。不驱动 UI 高亮——UI 高亮由
   * useSidebar.focusedSessionId（panel store activePanelId → sessionId 派生）负责。
   * activeId 仅用于：removeFromList 删 active 回退判断、deleteSession 回退、
   * useNewTaskFlow landing/预建写入、AppShell 导航栈回溯。
   */
  const activeId = ref<string | null>(null)

  /**
   * 列表加载错误（S5：loadSessions 失败时设错误消息，SessionList 据此显示「加载失败，点击重试」）。
   * null = 无错误（未加载或加载成功）；非空字符串 = 加载失败的错误消息。
   */
  const listLoadError = ref<string | null>(null)

  const active = computed<SessionSummary | null>(
    () => list.value.find((s) => s.id === activeId.value) ?? null,
  )

  /**
   * 应用 owner 快照——session store 数据写入口（W13 收敛为唯一入口：原标签更新 /
   * 模型状态局部更新 / 整表载入三个写入口全部删除，D7：renderer 零派生）。
   *
   * 两种快照粒度，均以 runtime owner 实例为权威：
   * - 整表：config.sessions 广播 / session.list RPC 的全量分组投影，直接替换 groups 真源
   *   （整表语义，含分组增删与重排——单条快照无法表达）；
   * - 单 session：session.renamed / state_changed 广播 + 乐观更新本地入参，按 D1b 整字段
   * 覆盖合并进既有条目（未知 id 静默跳过）。
   *
   * 乐观更新形态：本地入参只带乐观字段（如 rename 先显示 { label }），权威确认经 runtime
   * 广播回流（config.sessions 整表 / state_changed 单条），同一入口重复写入幂等。
   *
   * [W15 守卫] 磁盘占位值守卫已在 mergeViewSnapshot 落地（扫描来源快照的 modelId:''/
   * tokenCount:0 占位值不覆盖实例/广播真值——#2 空串覆盖事故的最后防线，详该函数注释）。
   * 历史：三入口时代 setGroups 整表覆盖曾把实例广播入列表的真值抹回磁盘扫描的空串
   * （updateSessionState 局部更新正是当时为避开此坑而设），W13 收敛单入口 + 本守卫
   * 后按来源分流根治。
   */
  function applySnapshot(id: string, snapshot: SessionViewSnapshot): void
  function applySnapshot(listSnapshot: { groups: SessionGroup[] }): void
  function applySnapshot(
    idOrList: string | { groups: SessionGroup[] },
    snapshot?: SessionViewSnapshot,
  ): void {
    if (typeof idOrList !== 'string') {
      // [HISTORICAL] dead 态穿越刷新（fix-respawn-pi §12.2#1；随 W13 单入口收敛，守卫自
      // 原 setGroups 移植至此——整表快照的唯一消费点）：runtime 在 pi 死亡时先广播
      // session.exited（markDead 置 dead），同一回调末尾紧接全量广播 config.sessions
      // （磁盘 outcome：done/stopped 等），两者数十 ms 内先后到达。dead 是运行时进程态
      // （比磁盘 outcome 新），全量覆盖会把 dead 冲回终态 → panel 的 dead 占位 UI 与
      // 「重新打开」入口永不渲染（dead 恒不可达）。故已 dead 的 session 在新列表中
      // status 非 dead 时保留 dead，仅显式 revive（restoreSession 成功后）清除。
      // 新列表中不存在的 session 不保留（首 turn 无文件死亡的终结语义：随列表消失）。
      const deadIds = new Set(
        groups.value
          .flatMap((g) => g.sessions)
          .filter((s) => s.status === 'dead')
          .map((s) => s.id),
      )
      if (deadIds.size === 0) {
        groups.value = idOrList.groups
        return
      }
      groups.value = idOrList.groups.map((g) => ({
        ...g,
        sessions: g.sessions.map((s) =>
          deadIds.has(s.id) && s.status !== 'dead' ? { ...s, status: 'dead' } : s,
        ),
      }))
      return
    }
    const target = list.value.find((s) => s.id === idOrList)
    if (!target) return
    mergeViewSnapshot(target, snapshot)
  }

  /**
   * D1b 合并：view 快照字段整字段覆盖到 SessionSummary 条目——显式提供的字段（值 !==
   * undefined）直接覆盖，含显式空值（owner 声明空即空，''/0 与真值一视同仁）；undefined =
   * 快照未涉及，保留现值。SessionViewSnapshot 的 view-ready 字段中 session store 只托管
   * 列表展示字段（label/status/modelId/thinkingLevel/tokenCount）；
   * pendingMessageCount/commands 等归各自消费 store（W15+ 收敛对象），不在本 store 落盘
   *（usagePercent/inputTokens/contextLimit 已随 D1 协议收敛从 SessionViewSnapshot 删除）。
   *
   * [W15 守卫] 磁盘占位值守卫（#2 空串覆盖事故最后防线）：仅 source === 'scan' 的快照生效——
   * 扫描读不出 modelId/tokenCount，其 ''/0 是占位值而非权威空值，target 已有非空真值时跳过
   * 覆盖。与 owner 快照空值语义**按来源分流、不混用**（D1b 两条规则并存）：owner 快照
   * （缺省来源）的显式空值是权威声明（如 sessionName 空 = 未命名，wire 形态 label:''），
   * 必须整字段覆盖（TC-4b 锁定）；守卫只拦扫描占位，不拦 owner 权威空。历史踩坑：setGroups
   * 全量覆盖曾把真值抹成空串（见 applySnapshot 注释），本守卫是该事故路径的结构性收口。
   */
  function mergeViewSnapshot(target: SessionSummary, snapshot: SessionViewSnapshot | undefined): void {
    if (!snapshot) return
    // W15：来源分流——仅扫描来源快照的占位空值触发守卫（判定不依赖魔法值，靠显式标记）。
    const isScan = snapshot.source === 'scan'
    if (snapshot.label !== undefined) target.label = snapshot.label
    if (snapshot.status !== undefined) target.status = snapshot.status
    // 守卫条件 = 快照值是占位空 && target 有非空真值可保；target 本身也是占位（同为 ''/0）时
    // 覆盖与否等值，走覆盖分支保持行为单一。
    if (snapshot.modelId !== undefined && !(isScan && snapshot.modelId === '' && target.modelId !== '')) {
      target.modelId = snapshot.modelId
    }
    if (snapshot.thinkingLevel !== undefined) target.thinkingLevel = snapshot.thinkingLevel
    if (snapshot.tokenCount !== undefined && !(isScan && snapshot.tokenCount === 0 && target.tokenCount !== 0)) {
      target.tokenCount = snapshot.tokenCount
    }
  }

  /** 更新 session 归属 project（乐观更新，setProject RPC 后调用；广播全量覆盖幂等）。 */
  function updateProjectId(id: string, projectId: string): void {
    const target = list.value.find((s) => s.id === id)
    if (target) target.projectId = projectId || undefined
  }

  /**
   * 从分组移除 session；移空组时连同组移除（不留空组标题）。
   * 若移除的是 active，回退到列表首项。
   */
  function removeFromList(id: string): void {
    groups.value = groups.value
      .map((g) => ({ ...g, sessions: g.sessions.filter((s) => s.id !== id) }))
      .filter((g) => g.sessions.length > 0)
    if (activeId.value === id) {
      activeId.value = list.value[0]?.id ?? null
    }
  }

  /**
   * 标记 session 为 dead 态（进程已退出）。
   * dead session 在侧栏置灰，panel 显示「进程已退出」占位，点击不触发 restore。
   *
   * [W13 单入口薄壳，goal-audit 问题 3] 内部经 applySnapshot(id, { status }) 局部快照
   * 写入（D7：status 是 applySnapshot 托管字段，此前直写 target.status 是唯一旁路写）。
   * 语义成立性论证：dead 的数据源是 runtime 广播的 session.exited（handleSessionExited
   * 调本方法）——owner 权威信号的事件形式，折算为局部快照经单一入口写入，与
   * applySnapshot 既有「乐观更新本地入参」形态（rename 先显示 { label }，权威经广播
   * 回流收敛）同型，非 renderer 凭空派生，故不需登记表例外条目。
   */
  function markDead(id: string): void {
    applySnapshot(id, { status: 'dead' })
  }

  /**
   * 重置 session 为 idle（重开进程后调，useSidebar.restoreSession 编排）。
   * 同为 applySnapshot 薄壳；dead→idle guard（读判定，非写旁路）保留原语义——
   * 非 dead（如 runtime 广播的 active/streaming 真态）不被本地 revive 覆盖。
   */
  function revive(id: string): void {
    if (list.value.find((s) => s.id === id)?.status === 'dead') {
      applySnapshot(id, { status: 'idle' })
    }
  }

  /** 设置列表加载错误消息（loadSessions 失败时调，null 清空） */
  function setListLoadError(msg: string | null): void {
    listLoadError.value = msg
  }

  /** 追加单个新建 session（按 cwd 归组：命中已有组则入尾，否则新建组在末尾） */
  function appendSession(s: SessionSummary): void {
    const group = groups.value.find((g) => g.cwd === s.cwd)
    if (group) {
      group.sessions.push(s)
    } else {
      groups.value = [...groups.value, { cwd: s.cwd, sessions: [s] }]
    }
  }

  // ── 方法访问层（ADR-0059 决策 2）──
  // createUseSession 经这些 getter/action 访问响应式字段，不直访内部 ref（store 封装原则）。
  // 方法内部在 setup 闭包里 .value 访问自己的 ref——pinia setup store 会 unwrap 对外暴露的
  // ref/computed（外部拿到值非 ref），但方法闭包持原始 ref，.value 在 pinia/raw 双模式下都正常。
  // 故 createUseSession 经 cast 接缝注入 pinia store 后，方法访问仍正确工作。
  function getActiveId(): string | null {
    return activeId.value
  }
  function setActiveId(id: string | null): void {
    activeId.value = id
  }
  function getList(): SessionSummary[] {
    return list.value
  }

  return { groups, list, activeId, active, listLoadError, applySnapshot, setListLoadError, appendSession, updateProjectId, removeFromList, markDead, revive, getActiveId, setActiveId, getList }
}

/**
 * session 归档域文案（session-archive 设计 D10/D11 renderer 侧）。
 * summary 子树 = u-renderer-summary 摘要视图组件（ArchiveSummaryView）；entry/main
 * 子树 = u-renderer-entry 归档列表视图（ArchiveListView）+ 主区摘要视图宿主
 * （ArchiveMainView）+ 归档视图编排（useArchiveView）。
 */
export default {
  summary: {
    // banner [已归档] pill（D11）
    archivedPill: '已归档',
    // banner [恢复完整会话] accent 钮（D11；staging 态恢复合法——统一冲突检测含 staging，V6）
    restore: '恢复完整会话',
    // 双 tab（D11：用户摘要 / agent 引用视图）
    tabUserSummary: '用户摘要',
    tabAgentReference: 'agent 引用视图',
    // tablist 容器 aria-label
    tablistLabel: '归档摘要视图',
    // agent 文本块标签（对话流 Assistant 块范式，mono meta 行）
    agentLabel: 'Assistant · 摘要',
    // staging 态压缩信息占位（D10「压缩中」同词）
    compressing: '压缩中',
    // staging 全区占位（D11）
    generating: '摘要生成中',
    generatingHint: '后台压缩完成后自动刷新',
    // turn 无 agent 文本占位（D11 字面）
    turnNoAgentText: '（此 turn 以工具调用结束，无文本回复 —— 摘要跳过该段）',
    // 纯图片/附件 user 消息占位（D11 字面）
    userAttachment: '[图片/附件消息]',
    // name 空串的未命名会话回退（簿记 name 提取失败为合法形态，D3）
    unnamed: '未命名会话',
    // archived 态 turns 空数组（合法簿记形态）的摘要流空态
    empty: '（无对话记录）',
  },
  // 归档列表视图（D10，ArchiveListView）
  entry: {
    // 头部标题（「已归档 (N)」的标题段；N 为同行 mono 计数）
    header: '已归档',
    // 头部返回钮 title/aria-label（切回会话列表）
    back: '返回会话列表',
    // 空态（D10 字面：列表区居中提示）
    empty: '暂无归档会话',
    // 拉取失败 + 重试入口
    loadFailed: '归档列表加载失败（{error}）',
    // 彻底删除（悬停 danger 钮，两段确认）
    purge: '彻底删除',
    purgeConfirm: '确认彻底删除？',
    // ── 时间筛选（互斥四档 + 全部；mono 短码 label 跨语言同形，title 为全称）──
    filterAll: '全',
    filterAllTitle: '全部归档',
    filter1d: '1d',
    filter1dTitle: '归档距今 1 天内',
    filter23d: '2-3d',
    filter23dTitle: '归档距今 2-3 天',
    filter47d: '4-7d',
    filter47dTitle: '归档距今 4-7 天',
    filterOlder: '7d+',
    filterOlderTitle: '归档距今超过 7 天',
    // 筛选行容器 aria-label
    filterTablistLabel: '按归档时间筛选',
    // 头部总体积（title 说明口径：压缩后体积 = 磁盘实际占用；压缩中条目按原文件计）
    totalSizeTitle: '当前筛选结果的磁盘占用（压缩后体积，压缩中的条目按原文件计）',
    // 筛选档下无结果的空态（区别于「暂无归档会话」全量空态）
    filterEmpty: '该时间范围内暂无归档',
    // ── 批量清理（筛选行内联 danger 钮，两段确认；待发态文案精简为「N 项」——垃圾桶图标承载删除语义）──
    batchPurgeAria: '删除所筛 {count} 项',
    batchPurgeLabel: '{count} 项',
    batchPurgeConfirm: '确认删除 {count} 项？',
    batchPurging: '删除中…',
    batchPurgeSuccess: '已彻底删除 {count} 个归档会话',
    batchPurgeKept: '已彻底删除 {count} 个归档会话；{kept} 条的子代理记录因数据不可读已保守保留',
    batchPurgePartial: '已彻底删除 {ok} 个、失败 {failed} 个；列表已刷新，可重试剩余项',
    // 恢复编排 toast（useArchiveView；成功后切回会话列表）
    restoreSuccess: '已恢复「{name}」，已回到原项目分组',
    restoreFailed: '恢复失败：{msg}',
    // 彻底删除编排 toast（keep-all 保守分支 = warning 出声，D5 步骤 7 失败显式上报）
    purgeSuccess: '已彻底删除「{name}」',
    purgeFailed: '彻底删除失败：{msg}',
    purgeKeptSubagents: '已彻底删除「{name}」；子代理记录因归档数据不可读已保守保留（{dir}）',
    // 行 aria-label（屏幕阅读器读出归档语义 + 名称）
    rowAria: '已归档会话 {name}',
  },
  // 主区摘要视图宿主（ArchiveMainView）
  main: {
    // view:'archive' 无选中条目的占位（恢复/删除后编排清空、异常直达）
    noSelection: '在侧栏归档列表中选择一个会话查看摘要',
  },
  // §5.2 失败路径表「界面表现 + 恢复指引」两列的渲染落点（error envelope code 分流；
  // 未命中码回退操作级通用模板 + runtime message）
  error: {
    generating: '归档失败：会话正在生成中（archive_generating）。请等待生成完成后再归档',
    alreadyArchived: '归档失败：该会话已有归档记录（archive_already_archived）。请先在归档列表恢复或彻底删除该条，再归档',
    restoreConflict: '恢复失败：原路径已存在同名会话文件（archive_restore_conflict）。请先处理该同名会话（删除或归档它），再恢复本条',
    corrupted: '恢复失败：归档数据校验失败（archive_corrupted）。压缩包已损坏无法恢复；归档原件保留，可提交问题反馈',
    notFound: '彻底删除失败：归档记录不存在（archive_not_found）。归档列表数据可能已过期，重新打开归档列表后重试',
    ioError: '操作失败：{msg}（archive_io_error）。session 状态以磁盘为准，启动自愈会归位，重试或检查磁盘',
  },
}

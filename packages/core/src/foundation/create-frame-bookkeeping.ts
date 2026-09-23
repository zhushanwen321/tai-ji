/**
 * createFrameBookkeeping —— 「live 帧流 × RPC 恢复腿」写入仲裁簿记原语（recency 序号表 +
 * suppressed 抑制表，per-instance 工厂）。
 *
 * 【登记】质量审查结构收敛批产物：原 useGenStats / useContextUsage 各持一份逐字同构的
 * 两表簿记（liveFrameSeqs recency 序号表 + suppressedSids 抑制表）收敛于此，与同族
 * createInflightDedup（in-flight 去重，C-data-18）配套使用——三件套覆盖「RPC 恢复腿 +
 * live 帧」状态源的全部簿记：
 *  - recency 序号表：合法帧落地时 bumpSeq；RPC 发起时 seqAt 捕获 seqAtIssue（编入
 *    createInflightDedup 的 meta）；reply 落地时 hasNewerFrame 判定「发起后已有更新帧」
 *    → 跳过写入（帧即真相，陈旧 reply 不得回滚 newer 帧值）。session cleanup 不清此表
 *    ——序号是单调 recency 计数，清零会让在途条目的 seqAtIssue 比对出现假性「已覆盖」，
 *    误跳过合法写入。
 *  - suppressed 抑制表：deleteSession 清掉分区后 suppress（在途 RPC resolve / 迟到帧
 *    不得把分区僵尸式写回）；重新进入该 sid 视图时 release（新生命周期）。
 *
 * 语义域约束：本原语只承载上述两表的通用簿记语义。消费方的帧校验（model 匹配 / 0 帧
 * 哨兵）、分区写入形状、dev 漂移检测等属各自语义域，不在原语内（useGenStats /
 * useContextUsage 的差异部分）。
 */

/** 两表簿记的共享原语实例 API */
export interface FrameBookkeeping {
  /** 合法帧落地于 sid：bump recency 序号（applyReply 的 skip 判定基准） */
  bumpSeq(sid: string): void
  /** sid 当前 recency 序号（无帧史 = 0；RPC 发起时捕获入 in-flight meta） */
  seqAt(sid: string): number
  /** recency 守卫：RPC 发起（seqAtIssue）后该 sid 已有更新帧落地 → true（reply 应弃写） */
  hasNewerFrame(sid: string, seqAtIssue: number): boolean
  /** sid 分区已被清理（迟到帧 / 在途 reply 一律弃写） */
  isSuppressed(sid: string): boolean
  /** sid 分区已清理：登记抑制（deleteSession cleanup 编排内调用） */
  suppress(sid: string): void
  /** sid 重新进入视图：解除抑制（新生命周期） */
  release(sid: string): void
}

export function createFrameBookkeeping(): FrameBookkeeping {
  /** per-instance live 帧序号表：sid → 单调 recency 序号（cleanup 不清，见模块头注） */
  const liveFrameSeqs = new Map<string, number>()
  /** 已清理 sid 抑制表（release 于重新进入视图时解除） */
  const suppressedSids = new Set<string>()

  return {
    bumpSeq: (sid) => {
      liveFrameSeqs.set(sid, (liveFrameSeqs.get(sid) ?? 0) + 1)
    },
    seqAt: (sid) => liveFrameSeqs.get(sid) ?? 0,
    hasNewerFrame: (sid, seqAtIssue) => (liveFrameSeqs.get(sid) ?? 0) !== seqAtIssue,
    isSuppressed: (sid) => suppressedSids.has(sid),
    suppress: (sid) => {
      suppressedSids.add(sid)
    },
    release: (sid) => {
      suppressedSids.delete(sid)
    },
  }
}

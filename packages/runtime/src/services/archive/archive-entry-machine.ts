import { defineStateMachine } from '@zhushanwen/state-machine'

/**
 * 归档单元（ArchiveEntry）状态机声明——session-archive 设计 D9 第二层逐行直译
 * （「归档单元自带显式状态机；归档态不进 SessionStatus」），基建首个消费者
 * （state-machine-infrastructure D6-M1，验证 defineStateMachine API 完整性）。
 *
 * 语义锚点（D9）：
 * - 创建行不占表——「（无单元）→ staging」由 `initial: 'staging'` 承载（archive
 *   动作创建实体，D5 同步段完成搬移 + 簿记骨架）。
 * - 回滚拆双事件行——行式表的 to 必须是显式词表值或 null，「回滚到原态」的单
 *   事件形态无法表达，故 `restore_rollback_to_staging` / `restore_rollback_to_archived`
 *   各占一行（冲突/校验失败回滚的原态两支）。
 * - `to: null` = 实体消亡、离开本机器（restore_done 恢复完成清除 / purge 彻底
 *   删除）——与 terminal 吸收态是两个概念；三态全部非终态，无 terminal 声明。
 * - 表外转移一律 fail-fast（如对 restoring 再 archive、对无单元 compress_done），
 *   errorPolicy: 'throw'；非法转移的对外错误码（archive_not_found 等）由服务层
 *   RPC 通道承载，不在机器声明 errorFactory（u-archive-service 单元接线）。
 * - 词表外运行时输入（磁盘读回的簿记 status 字符串）经 coerceState 统一映射，
 *   消费点在服务层读簿记边界（本文件只声明机器，不含 IO）。
 * - 事件命名沿用本域 snake_case 风格（D9 与姊妹设计 §5.1 示例同一版）。
 */
export const archiveEntryMachine = defineStateMachine({
  name: 'archive-entry',
  states: {
    staging: {},
    archived: {},
    restoring: {},
  },
  initial: 'staging',
  events: {
    compress_done: {},
    unarchive: {},
    restore_done: {},
    restore_rollback_to_staging: {},
    restore_rollback_to_archived: {},
    purge: {},
  },
  transitions: [
    // 后台压缩任务提交簿记终态
    { from: 'staging', on: 'compress_done', to: 'archived' },
    // 簿记 rename 为 .restoring 后缀
    { from: ['staging', 'archived'], on: 'unarchive', to: 'restoring' },
    // 恢复完成，归档单元清除——实体消亡
    { from: 'restoring', on: 'restore_done', to: null },
    // 冲突/校验失败回滚（原态 = staging 支）
    { from: 'restoring', on: 'restore_rollback_to_staging', to: 'staging' },
    // 冲突/校验失败回滚（原态 = archived 支）
    { from: 'restoring', on: 'restore_rollback_to_archived', to: 'archived' },
    // 彻底删除——实体消亡
    { from: ['staging', 'archived'], on: 'purge', to: null },
  ],
  errorPolicy: 'throw',
})

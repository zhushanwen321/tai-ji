/**
 * Workflow 提取器 —— 主 session 文件的 workflow record 读取骨架（冷启动 / getWorkflows RPC 路径）。
 *
 * [ADR-0095] run 侧 v1 读面已删除：本文件不再从 entry 派生 WorkflowRunRecord——
 * runtime workflow 列表唯一数据源 = events-projection 的 record 流 fold + v2 注册/
 * 终态条目（实时与重开同源，D5 冷热同代码）；历史格式（workflow-record v1 快照条目 /
 * workflow-state-link 指针 + state 文件）不再识别，历史 run 从本提取器数据面退空即
 * 预期行为（项目未上线无历史数据，不迁移不兼容，同 record 侧裁决）。
 *
 * 保留面 = session-file-extraction 共享骨架的消费壳（读失败分级：ENOENT → 空数组；
 * >32MB → oversize 降级标记）——renderer 侧栏 stale 守卫与「会话过大」显示依赖该
 * 语义，records 恒空数组。
 */

import { extractRecordsFromSessionFile, type SessionFileExtraction } from './session-file-extraction.js'
import type { WorkflowRunRecord } from '@taiji/shared'

/**
 * 从主 session JSONL 文件提取 WorkflowRunRecord[]（冷启动 / getWorkflows RPC 路径）。
 *
 * 读取/预检/降级语义走 ./session-file-extraction.ts 共享骨架（与 subagent-extractor
 * 同一实现）。读失败分级（renderer 侧栏 stale 守卫的契约前提，由骨架承担）：
 * ENOENT → 空数组（pi session 文件延迟写入的合法窗口）；其他读错误 → 原样上抛
 * （RPC 报错，renderer catch 保留旧分区 + 重试态，不与「真实删空」混淆）。
 * records 恒空（[ADR-0095] v1 读面删除，workflow 列表数据源 = events-projection
 * 投影；scan 保留骨架注入口位，不再挂派生器）。
 *
 * [G3 / crash-resilience D5⑤] READ_PRECHECK 预检（> 32MB 降级空列表 + oversize 标记
 * + warn 留痕）语义见骨架文件。
 */
export function extractWorkflowsFromSessionFile(filePath: string): SessionFileExtraction<WorkflowRunRecord> {
  return extractRecordsFromSessionFile(filePath, {
    warnTag: 'workflow-extractor',
    subject: 'workflow',
    scan: () => [],
  })
}

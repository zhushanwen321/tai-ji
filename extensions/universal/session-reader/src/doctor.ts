/**
 * doctor action（u8：design 2026-09-10 §6.2/§6.3/§6.4/§7B 要点 2/4/5/8 + §6.11 U14b 段）。
 *
 * 从 tool-handler.ts 机械提取（max-lines 拆分轮，零行为变更）：环境判定 + 根表渲染 +
 * 旧布局残留 glob 探测。SessionReadSignals（u3 信号包超集）在域内定义，tool-handler
 * re-export 供 index.ts 生产消费。原 u8 的扫描缓存机已删除（ext-simplify-04 U3）：
 * 每次调用实扫，无缓存命中语义；TTL/mtime 判定随 metadata 缓存留在 tool-handler 侧。
 */
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { detectEnvironment, type DetectedEnvironment } from './discovery/env.js'
import { resolveSessionRoots, type SessionRoot, type SessionRootSignals } from './discovery/roots.js'
import type { SessionReadParams, ToolResult } from './tool-handler.js'

/**
 * doctor 所需环境信号：u3 信号包（SessionRootSignals）的超集，index.ts execute 补采
 * env/bundleUrl。env 属宿主信号（detectEnvironment 契约），与根信号分属两个注入接口，
 * 在 handler 层合流；两字段可选——缺省时 doctor 按「空 env / bundleUrl 缺失」降级
 *（kind=standalone-pi、distribution=null），根表照常输出。
 */
export interface SessionReadSignals extends SessionRootSignals {
  /** process.env 快照（doctor 环境判定，design §6.2；缺省按空 env 降级） */
  env?: Record<string, string | undefined>
  /** extension 模块 import.meta.url（doctor 发行形态判定；缺省 distribution=null 不猜） */
  bundleUrl?: string
}

/** doctor 根表来源标签列宽（最长 `[subagent]` 10 字符 + 1 对齐间距，§5.1 表格形态）。 */
const DOCTOR_ROOT_LABEL_PAD = 11

/** 旧布局残留条目（§6.11 U14b doctor 侧独立 glob 探测）。 */
/** 旧布局残留探测单条命中（doctor 与 u14b 启动探测同源判据，§6.11）。 */
export interface PiLayoutLeftover {
  path: string
  kind: 'backup' | 'unmigrated'
}

/**
 * 旧布局残留独立 glob 探测（§6.11 v9.1）。基点 = dirname(agentDir)（xyz-agent 下 =
 * `<dataDir>`，纯 pi 下 = `~/.pi`）；`pi/`（未迁移）与 `pi.backup-v2-` 前缀目录（迁移备份）
 * 都不在任何候选根推导式内（[legacy] 够不到带时间戳的备份名与 pi/ 层），故须独立探测。
 *
 * 形态判据（与 u14b 启动探测 / u14a 脚本 0a 同源）：目录下含 `agent/` 或 `sessions/`
 * 子目录才算残留——防纯 pi 宿主下任意来源的 `~/.pi/pi/` 目录误报。读探测，每次现查
 * 不入缓存（两次 readdir 成本可忽略，缓存只服务扫盘贵的根）。
 */
async function detectPiLayoutLeftovers(
  agentDir: string,
): Promise<{ base: string; hits: PiLayoutLeftover[] }> {
  const base = dirname(agentDir)
  if (agentDir.length === 0) return { base, hits: [] }
  let names: string[]
  try {
    names = (await readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return { base, hits: [] }
  }
  const hits: PiLayoutLeftover[] = []
  for (const name of names) {
    const isUnmigrated = name === 'pi'
    const isBackup = name.startsWith('pi.backup-v2-')
    if (!isUnmigrated && !isBackup) continue
    const dir = join(base, name)
    // 形态判据：含 agent/ 或 sessions/ 子目录（迁移备份必含其一——备份即原 pi/ 改名）
    if (!existsSync(join(dir, 'agent')) && !existsSync(join(dir, 'sessions'))) continue
    hits.push({ path: dir, kind: isBackup ? 'backup' : 'unmigrated' })
  }
  return { base, hits }
}

/**
 * doctor：环境判定 + 根表 + 事实型诊断 + legacy 非空告警 + 旧布局残留探测。
 *
 * 诊断结论只陈述事实（「最高优先级 main 根 N 文件」），禁止「真的没有 session」类
 * 归因断言（§7B 要点 5 / §3.3 教训）；env/bundleUrl 信号缺失时环境判定按降级输出，
 * 根表照常（§7B 要点 2 同款降级哲学）。
 */
export async function doDoctor(
  params: SessionReadParams,
  signals: SessionReadSignals,
): Promise<ToolResult> {
  const environment = detectEnvironment({
    env: signals.env ?? {},
    ...(signals.bundleUrl !== undefined ? { bundleUrl: signals.bundleUrl } : {}),
    agentDir: signals.agentDir,
  })
  const roots = await resolveSessionRoots(signals, {
    // subagent 根默认只 stat（§6.3 成本控制：只列路径与可扫性）；includeSubagents:true
    // 才扫。无缓存——每次实扫（原缓存机已删，ext-simplify-04 U3，§7B 要点 8 新态）。
    subagents: params.includeSubagents === true ? 'scan' : 'stat',
  })
  const leftovers = await detectPiLayoutLeftovers(signals.agentDir)
  return renderDoctor(roots, environment, leftovers)
}

/**
 * doctor action 的 details 契约（与兄弟 action 命名接口同构：tool-handler WorkflowDetails /
 * search-across CrossSearchDetails 先例）——消费侧测试直 import 本类型，不再自建局部镜像。
 */
export interface DoctorDetails {
  environment: DetectedEnvironment
  roots: SessionRoot[]
  leftovers: PiLayoutLeftover[]
  globBase: string
}

/**
 * 渲染 doctor 输出（§5.1 形态）：环境判定 + evidence + 会话根表（来源标签/路径/存在/
 * 文件数/扫描耗时/去重注记）+ 事实型诊断 + legacy 非空告警 + 旧布局残留（命中才出现）。
 */
function renderDoctor(
  roots: SessionRoot[],
  environment: DetectedEnvironment,
  leftovers: { base: string; hits: PiLayoutLeftover[] },
): ToolResult {
  const lines: string[] = []

  // 环境判定行 + evidence（§6.2：判定可被证据推翻，非黑盒断言；evidence 恒非空）
  lines.push(
    `环境判定：${environment.kind === 'xyz-agent' ? 'xyz-agent（托管）' : 'standalone-pi'}` +
      ` · 发行形态：${environment.distribution ?? '未知（不猜）'}`,
  )
  if (environment.dataDir !== undefined) lines.push(`数据目录：${environment.dataDir}`)
  lines.push('依据：')
  for (const e of environment.evidence) lines.push(`  - ${e}`)

  // 会话根表（按优先级）
  lines.push('')
  lines.push('会话根（按优先级）：')
  roots.forEach((r, i) => {
    lines.push(`  ${i + 1}. ${`[${r.kind}]`.padEnd(DOCTOR_ROOT_LABEL_PAD)} ${r.path}`)
    if (r.dedupedInto !== undefined) {
      const keptIndex = roots.findIndex((k) => k.kind === r.dedupedInto) + 1
      lines.push(`     与 ${keptIndex} 同路径，已去重`)
      return
    }
    const facts = [r.exists ? '存在' : '不存在']
    if (r.fileCount === undefined) {
      // 仅 subagents:'stat' 的 subagent 根（doctor 默认形态）——其余根恒有计数（实扫）；
      // 被去重根已在上方提前返回
      facts.push('未扫描（subagent 根默认不扫，includeSubagents:true 开启）')
    } else {
      facts.push(`${r.fileCount} 文件`, `扫 ${Math.round(r.scanMs ?? 0)}ms`)
    }
    facts.push(r.source === 'main' ? 'main' : 'subagent')
    lines.push(`     ${facts.join(' · ')}`)
  })

  // 事实型诊断（§7B 要点 5）：列表内首个 main 根即最高优先级 main 根（去重只移除后位根，
  // 首位根恒有计数——实扫）。0 文件也是事实——首条 assistant 前 jsonl 不落盘
  //（PS-14），不做归因。
  lines.push('')
  const firstMain = roots.find((r) => r.source === 'main')
  if (firstMain === undefined) {
    lines.push('诊断：无候选根（agentDir 为空，未派生任何根）。')
  } else {
    lines.push(
      `诊断：最高优先级 main 根 [${firstMain.kind}] ${firstMain.path}：${firstMain.fileCount ?? 0} 文件。`,
    )
  }

  // legacy 非空告警（§6.1/§5.1：判据 = 非空才告警；与主根同路径被去重 → 不告警）
  const legacy = roots.find((r) => r.kind === 'legacy')
  if (legacy !== undefined && legacy.dedupedInto === undefined && (legacy.fileCount ?? 0) > 0) {
    lines.push(
      `告警：[legacy] 根 ${legacy.path} 非空（${legacy.fileCount} 文件）——该位置已作为候选根纳入 find。`,
    )
  }

  // 旧布局残留（§6.11：命中才列，附同一迁移指引）
  if (leftovers.hits.length > 0) {
    lines.push('')
    lines.push(`旧布局残留探测（基点 ${leftovers.base}）：`)
    for (const h of leftovers.hits) {
      lines.push(
        `  - ${h.path}（${h.kind === 'backup' ? '迁移备份 pi.backup-v2-*' : '未迁移旧布局 pi/'}）`,
      )
    }
    lines.push('  👉 关闭应用后运行 scripts/migrate-pi-layout-v2.mjs 完成迁移。')
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: {
      environment,
      roots,
      leftovers: leftovers.hits,
      globBase: leftovers.base,
    } satisfies DoctorDetails,
  }
}

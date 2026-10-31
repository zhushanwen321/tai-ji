/**
 * startup-records-fixture —— startup-readiness-and-current-state 验收族（dev-flow D3）
 * 的共享 fixture 库：受控构造「未迁移形态会话 + subagent record 事件文件」。
 *
 * 服务 startup-a2a6 / startup-a3a4 / startup-a5 三个剧本（设计 §4.1 场景 A2-A6 的
 * u-foundation 波次段）。只提供磁盘 fixture 原语（会话 jsonl / project 绑定 sidecar /
 * record 事件文件 / mtime 对账触发改写），不定义业务断言。
 *
 * 关键事实（源码核对，勿凭示例硬写）：
 * - 主会话文件落点 `<dataDir>/agent/sessions/<encodeCwd(cwd)>/<sid>.jsonl`，首行
 *   session header `{type:'session', id, cwd, timestamp}`（type:'session' 是
 *   isSessionHeaderEntry 的判定键——缺 type 按 noHeader 降级、会话不进扫描面；
 *   packages/runtime/src/infra/pi/session-file-utils.ts 的 parseSessionHeader /
 *   scanSessions 与 scanPiSessions 的扫描发现面）——encodeCwd 公式 =
 *   shared/session-store-paths.ts:70 `--` + 去首斜杠 + `[/\\:]`→`-` + `--`。
 * - project 绑定 sidecar `<sid>.jsonl.project.json` = `{"projectId": "..."}`
 *   （lib-conn-datasync 先例同款）；projects.json = `{projects:[{id,name,lastUsedAt}]}`。
 * - record 事件文件落点 `<dataDir>/ext-sessions/<sid>/subagents/records/<sa-id>.events`
 *   （subagent-core path-encoding getSubagentRecordsDir → shared
 *   getSessionSubagentRecordsDir；rootSessionId 分区键）。首行头行
 *   `{"type":"record-events","id":"<sa-id>"}`；事件行信封 = `{type, seq(≥1 严格递增),
 *   ts}`，词表 record-events.ts RECORD_EVENT_TYPES。
 * - fold 语义（record-events.ts foldRecordEvents + events-projection.ts
 *   projectV2Subagent）：record-created 定身份；lastEvent.type === 'record-round-idle'
 *   → status 'idle'（stopReason 取帧值）；'record-round-started' 在尾 → 'running'。
 *   注册条目（会话 jsonl 内 custom entry）非必需——recordFolds 的 identity 即投影
 *   身份锚（mergeSubagentHalf v2Ids 并集）。
 * - 查询真理通道失效（session-records.ts rebuildProjectionIfSourceChanged）：查询
 *   透传 scanSessions meta 时对账会话文件 mtime，变化即 dispose 旧投影 + 重建
 *   （attach 全量冷读）——A5「推送丢失 → 查询补全」的检测路径。
 */
import fs from 'node:fs'
import path from 'node:path'

/** shared/session-store-paths.ts:70 encodeCwd 的同式副本（fixture 自含，不 import 仓内 TS）。 */
export function encodeCwd(cwd) {
  return '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
}

/** 受控 projects.json 种子（读现有合并，幂等追加）。 */
export function seedProjects(dataDir, projects) {
  const file = path.join(dataDir, 'projects.json')
  let parsed = { projects: [] }
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (existing && Array.isArray(existing.projects)) parsed = existing
  } catch {
    /* 无文件/坏 JSON：以骨架起 */
  }
  const known = new Set(parsed.projects.map((p) => p.id))
  for (const p of projects) {
    if (!known.has(p.id)) parsed.projects.push({ id: p.id, name: p.name, lastUsedAt: Date.now() })
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`)
}

/**
 * 写「未迁移形态会话」fixture：主会话 jsonl（header 一行）+ project 绑定 sidecar。
 * 返回会话文件绝对路径。
 */
export function seedSessionFile(dataDir, { sessionId, cwd, projectId }) {
  const dir = path.join(dataDir, 'agent', 'sessions', encodeCwd(cwd))
  fs.mkdirSync(dir, { recursive: true })
  const sessionFile = path.join(dir, `${sessionId}.jsonl`)
  if (!fs.existsSync(sessionFile)) {
    // header 判定键 = entry.type === 'session'（session-file-utils.ts
    // isSessionHeaderEntry——缺 type 的首行按 noHeader 降级、会话不进扫描面）
    const header = { type: 'session', id: sessionId, cwd, timestamp: new Date().toISOString() }
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`)
  }
  if (projectId !== undefined) {
    fs.writeFileSync(`${sessionFile}.project.json`, `${JSON.stringify({ projectId })}\n`)
  }
  return sessionFile
}

/**
 * 写 record 事件文件族（可独立于会话文件调用——活跃会话的 pi 已写会话文件时只补
 * records 半边）。records 形态：[{ id, status: 'idle' | 'running', task? }]。
 * 返回 { recordsDir, files }。
 */
export function seedRecordEvents(dataDir, sessionId, records) {
  const recordsDir = path.join(dataDir, 'ext-sessions', sessionId, 'subagents', 'records')
  fs.mkdirSync(recordsDir, { recursive: true })
  const files = []
  for (const rec of records) {
    const file = path.join(recordsDir, `${rec.id}.events`)
    const ts = Date.now() - 60_000
    const lines = [JSON.stringify({ type: 'record-events', id: rec.id })]
    lines.push(
      JSON.stringify({
        type: 'record-created',
        seq: 1,
        ts,
        id: rec.id,
        agent: 'general-purpose',
        task: rec.task ?? `startup-fixture ${rec.id}`,
        slug: `fixture-${rec.id}`,
        origin: 'tool',
        rootSessionId: sessionId,
        depth: 0,
        mode: 'background',
        startedAt: ts,
      }),
    )
    if (rec.status === 'running') {
      lines.push(JSON.stringify({ type: 'record-round-started', seq: 2, ts: ts + 1_000, round: 1, epoch: 1 }))
    } else {
      lines.push(
        JSON.stringify({
          type: 'record-round-idle',
          seq: 2,
          ts: ts + 1_000,
          round: 1,
          stopReason: rec.stopReason ?? 'stop',
        }),
      )
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
    files.push(file)
  }
  return { recordsDir, files }
}

/** 一站式：会话文件 + records（未激活会话的完整投影源）。 */
export function seedRecordSession(dataDir, { sessionId, cwd, projectId, records }) {
  const sessionFile = seedSessionFile(dataDir, { sessionId, cwd, projectId })
  const { recordsDir } = seedRecordEvents(dataDir, sessionId, records)
  return { sessionFile, recordsDir }
}

/**
 * A5 注入原语：向既有 record 事件文件追加一行事件（推送丢失形态 = journal 写入方
 * 落盘、marker 推送缺席）。seq 续文件内最大值 +1。
 */
export function appendRecordEvent(dataDir, sessionId, recordId, event) {
  const file = path.join(dataDir, 'ext-sessions', sessionId, 'subagents', 'records', `${recordId}.events`)
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0)
  let maxSeq = 0
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed.seq === 'number' && parsed.seq > maxSeq) maxSeq = parsed.seq
    } catch {
      /* 坏行跳过 */
    }
  }
  const next = { ...event, seq: maxSeq + 1, ts: event.ts ?? Date.now() }
  fs.appendFileSync(file, `${JSON.stringify(next)}\n`)
  return { file, line: next }
}

/**
 * 更新会话文件 mtime（A5 注入的第二半边：真实写侧是「事件文件 + 会话文件」同点
 * 双写——终态条目也进会话 jsonl，mtime 随之推进；查询通道 mtime 对账由此触发投影
 * 重建。这里以 utimes 模拟同点双写对 mtime 的推进，不动文件内容）。
 */
export function touchSessionMtime(sessionFile, atMs = Date.now() + 5_000) {
  const now = new Date(atMs)
  fs.utimesSync(sessionFile, now, now)
  return fs.statSync(sessionFile).mtimeMs
}

/** 解析 runtime 日志中的常驻事件循环滞后遥测行（60s 一行；maxMs 单位 ms）。 */
export function parseTelemetryLines(runtimeLogText) {
  const out = []
  for (const m of runtimeLogText.matchAll(/\[event-loop-telemetry\] delay histogram window (\{.*\})/g)) {
    try {
      out.push(JSON.parse(m[1]))
    } catch {
      /* 非法行跳过 */
    }
  }
  return out
}

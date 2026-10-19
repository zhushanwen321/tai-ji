/**
 * isInsideSessionTrees 纯函数单测（会话 JSONL 导出的路径安全校验边界）。
 *
 * 锁定不变量：只放行 pi 宿主三树（<piAgentDir>/sessions|subagents|btw）内的绝对路径。
 * PI_SESSION_TREE_SEGMENTS 末位 ext-sessions 基址是 <dataDir> 不是 piAgentDir（shared
 * paths.ts 消费注意）——本函数不消费该段：候选 <piAgentDir>/ext-sessions/... 必须
 * 拒绝（不是宿主树段，逐段 join 的误放行形态）；存储树路径判定待真实导出需求
 * （如 btw 线导出）出现时经 getSessionStoreDir 显式加入。
 *
 * 运行：cd apps/electron/main && npx vitest run test/session-export-ipc.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn() },
}))

import { isInsideSessionTrees } from '../sessions/session-export-ipc.js'

const AGENT_DIR = '/Users/tester/.pi/agent'
const DATA_DIR = '/Users/tester/.taiji'

describe('isInsideSessionTrees（pi 宿主三树判定）', () => {
  it('宿主三树内路径放行（sessions / subagents / btw）', () => {
    expect(isInsideSessionTrees(`${AGENT_DIR}/sessions/--Users-tester-proj--/2026s_sid.jsonl`, AGENT_DIR)).toBe(true)
    expect(isInsideSessionTrees(`${AGENT_DIR}/subagents/--Users-tester-proj--/sessions/sa-1.json`, AGENT_DIR)).toBe(true)
    expect(isInsideSessionTrees(`${AGENT_DIR}/btw/--Users-tester-proj--/main-sid/line.jsonl`, AGENT_DIR)).toBe(true)
  })

  it('树外路径拒绝（越界 / homedir 本身 / 相对路径）', () => {
    expect(isInsideSessionTrees('/etc/passwd', AGENT_DIR)).toBe(false)
    expect(isInsideSessionTrees(`${AGENT_DIR}/sessions-exfil/steal.jsonl`, AGENT_DIR)).toBe(false)
    expect(isInsideSessionTrees(AGENT_DIR, AGENT_DIR)).toBe(false)
    expect(isInsideSessionTrees('sessions/relative.jsonl', AGENT_DIR)).toBe(false)
  })

  it('前缀相似目录不误放行（treeRoot + sep 边界）', () => {
    expect(isInsideSessionTrees(`${AGENT_DIR}/subagents-evil/x.jsonl`, AGENT_DIR)).toBe(false)
  })

  it('大小写不敏感卷语义（casefold 命中同一树）', () => {
    expect(isInsideSessionTrees(`${AGENT_DIR.toUpperCase()}/Sessions/sid.jsonl`, AGENT_DIR)).toBe(true)
  })

  it('ext-sessions 段不参与判定：错误基址形态 <piAgentDir>/ext-sessions/ 拒绝', () => {
    // 该段基址是 <dataDir>；把它 join 到 piAgentDir 下是历史实现的死段误放行形态
    expect(isInsideSessionTrees(`${AGENT_DIR}/ext-sessions/sid/btw/line.jsonl`, AGENT_DIR)).toBe(false)
    // 存储树真实基址（<dataDir>/ext-sessions/）同样不在本函数语义内（宿主树判定）
    expect(isInsideSessionTrees(`${DATA_DIR}/ext-sessions/sid/btw/line.jsonl`, AGENT_DIR)).toBe(false)
  })
})

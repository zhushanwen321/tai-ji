#!/usr/bin/env node
/**
 * check_edge_fade_scope.mjs — EdgeFade 渐焦遮罩消费范围门禁（2026-10-21 用户裁决）。
 *
 * EdgeFade（滚动容器顶缘渐焦：多层 backdrop-blur + 沉色 + 滚动容器顶部 mask）仅允许
 * 对话流及其同族场景使用——唯一挂载点 = MessageStream.vue（drawer subagent / 旁路提问 /
 * workflow agent 等同族流均经其复用）；其余场景（列表 / 面板 / 文件树等）一律禁止。
 *
 * 判定：白名单外文件出现 `ui/edge-fade` import 或 `<EdgeFade` 标签即红。
 *
 * 用法：
 *   node .githooks/check_edge_fade_scope.mjs <file...>   # pre-commit：只查传入文件
 *   node .githooks/check_edge_fade_scope.mjs             # 无参：全仓扫描
 *
 * 白名单：下方 ALLOWLIST（唯一登记处）。新增条目须附裁决理由，禁止整类放宽。
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ALLOWLIST = new Set([
  // 组件本体与导出入口
  'packages/renderer/src/components/ui/edge-fade/EdgeFade.vue',
  'packages/renderer/src/components/ui/edge-fade/index.ts',
  // 对话流本体（同族场景经此复用获得遮罩）
  'packages/renderer/src/components/panel/MessageStream.vue',
])

const MARKERS = [
  /from\s+['"][^'"]*ui\/edge-fade['"]/,
  /<EdgeFade\b/,
]

function scan(files) {
  const hits = []
  for (const f of files) {
    if (ALLOWLIST.has(f)) continue
    let text
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    if (MARKERS.some((re) => re.test(text))) hits.push(f)
  }
  return hits
}

const args = process.argv.slice(2)
let files = args
if (files.length === 0) {
  files = execSync('git ls-files "packages/**/*.vue" "packages/**/*.ts" "apps/**/*.vue" "apps/**/*.ts"', {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
}

const hits = scan(files)
if (hits.length > 0) {
  console.error('[FAIL] EdgeFade 渐焦遮罩出现在白名单之外的文件（2026-10-21 裁决：仅对话流及同族场景可用，唯一挂载点 MessageStream.vue）：')
  for (const f of hits) console.error(`  - ${f}`)
  console.error('[FIX] 移除该文件的 <EdgeFade> 接线与 import；确属对话流同族新场景时，将文件加入本脚本 ALLOWLIST 并附裁决理由。')
  process.exit(1)
}

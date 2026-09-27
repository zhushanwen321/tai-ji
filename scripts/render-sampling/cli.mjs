// 采样管道 CLI 冒烟入口：连接 → 新建会话 → 注入样本 → 等渲染 → DOM/截图/console 落盘。
// 用途：① 管道自身健康检查（采样前先跑本脚本确认管道绿，再写场景断言——预飞纪律）；
//      ② 简单场景的现成端到端（样本注入 + 全量产物落盘，断言另写）。
//
// 用法：
//   node scripts/render-sampling/cli.mjs --cdp-port <port> --sample <md 路径> --out <产物目录> [--name a1] [--style-probe '.md-table-wrap']
// 端口来源：node apps/electron/scripts/dev-instance.mjs --print（禁硬编码）。
// 产物：<name>-dom.json / <name>-console.log / <name>-fullpage.png。

import { readFileSync } from 'node:fs'
import process from 'node:process'

import {
  captureConsole,
  clickSendOrSubmit,
  connectPage,
  injectToComposer,
  newSession,
  saveArtifacts,
  sampleDomShape,
  waitForRenderSettled,
} from './lib.mjs'

function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const cdpPort = arg('--cdp-port')
const samplePath = arg('--sample')
const outDir = arg('--out')
const name = arg('--name') ?? 'sample'
const styleProbe = arg('--style-probe')

if (!cdpPort || !samplePath || !outDir) {
  console.error('用法: node scripts/render-sampling/cli.mjs --cdp-port <port> --sample <md 路径> --out <产物目录> [--name a1] [--style-probe <selector>]')
  process.exit(1)
}

const { browser, page } = await connectPage({ cdpPort, urlPattern: arg('--url-pattern') ?? 'localhost:1' })
const consoleCapture = captureConsole(page)

await newSession(page)
await injectToComposer(page, readFileSync(samplePath, 'utf8'))
const sendResult = await clickSendOrSubmit(page)
console.log('send:', sendResult)

const settled = await waitForRenderSettled(page)
console.log('render settled:', JSON.stringify(settled))

const domShape = await sampleDomShape(page, {
  styleProbeSelectors: styleProbe ? [styleProbe] : [],
})
await saveArtifacts(outDir, name, { page, domShape, consoleLines: consoleCapture.flush() })
console.log(`artifacts saved: ${outDir}/${name}-*`)

await browser.close()

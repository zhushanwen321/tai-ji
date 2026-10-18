/**
 * raw mirror fixture 引擎（u-m3-mirror 集成测试专用；设计 relay-spawn-transport §3.4.4）。
 *
 * 模拟真引擎的 fd3 镜像写入行为的最小子集：
 * - argv: [recordId] [--gap]——recordId 缺省 rec-mirror-fixture；--gap 时第二帧 seq 跳号
 *   （模拟写侧丢弃：seq 0/2，读取侧应判 degraded）；
 * - 启动即在 fd3 写 `{v:1, recordId, seq, b64}` 帧（两帧：message_start + text_delta，
 *   保持 assistant 流 in-flight 供 getSubagentStreamState 断言 found:true）；
 * - stdin 收到 `__exit__` 行退出（engine_close 有界等待路径的准出）；
 * - fd3 属引擎进程（跨 run 复用语义）：`autoClose:false`，文件描述符由进程退出回收。
 *
 * 运行期不写任何数据目录（socket/pid 文件由 server 侧测试注入 mkdtemp 管理）。
 */
import { createWriteStream } from 'node:fs'

const recordId = process.argv[2] ?? 'rec-mirror-fixture'
const gap = process.argv.includes('--gap')

const mirror = createWriteStream('', { fd: 3, autoClose: false })
const emit = (seq, line) =>
  mirror.write(
    `${JSON.stringify({ v: 1, recordId, seq, b64: Buffer.from(line, 'utf8').toString('base64') })}\n`,
  )

emit(0, JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } }))
emit(
  gap ? 2 : 1,
  JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '镜像内容' } }),
)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk.includes('__exit__')) process.exit(0)
})
process.stdin.resume()

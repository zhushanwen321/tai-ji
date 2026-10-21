/**
 * 本地 mock LLM（OpenAI chat-completions 兼容 HTTP 服务）——verify-taiji 的**零 token
 * LLM 通道**（与 faux 通道并列的第二条通道）。
 *
 * 为什么需要它（事实链，实测）：
 * - faux 演员靠 pi extension 注册 `api: 'faux'` 的 provider；subagent/workflow 的**孙进程**
 *   由 `pi-subagent-cli` 以 `--no-extensions` spawn、扩展集只剩宿主白名单
 *   （`extensions/universal/subagent-workflow/src/host/pi-host.ts` 的
 *   `GRANDCHILD_EXTENSION_PKG_SEGMENTS`），faux 扩展进不去 → 孙进程报
 *   `Model "faux/..." not found`（探针 `scripts/probes/faux-grandchild.mjs`）。
 * - 但孙进程继承 `PI_CODING_AGENT_DIR`（`packages/runtime/src/infra/subagent-control/engine-launch-env.ts`
 *   显式注入），因此它读同一份 `<agentDir>/models.json`——**自定义 openai-completions
 *   provider 不需要任何 extension**，baseUrl 指向本机就成立。先例（语义来源，不 import）：
 *   `dev-0.11.11/scripts/verify-provider-live-sync.mjs` 的 createServer 段。
 *
 * 职责边界（API-CONTRACT §0）：只做「HTTP 服务 + 请求记录 + 脚本出队」，不实现任何产品语义。
 * 零第三方依赖（仅 node:*），可从任意 cwd 使用。
 *
 * 剧本形态与 faux 对齐（便于复用 `fixtures/faux-responses/*.json`）：
 *   step = { text?, thinking?, toolCalls?: [{ name, args }], stopReason? }
 *   - 数组 = 统一队列（每次请求按序消费一个 step）；
 *   - 对象 = model-keyed（按请求体 `model` 字段选队）——**这是区分主 agent（mock-1）与
 *     subagent 成员（mock-sub-a / mock-sub-b）的关键**：让同一份剧本文件服务整棵进程树。
 *
 *   ⚠️ **游标语义（审查 C M11 实测纠正）**：游标是 **per-model 单游标、由 mock server 进程持有**，
 *   **不是 per-pi-进程**（早期注释写「每个 pi 进程各持一条游标」是错的：多个 pi 打同一个 server，
 *   自然共享同一个游标）。
 *   后果：**同一模型被两个 session 使用时，第二个 session 的第一轮会拿到第一个 session 的第二条 step**。
 *   多 session 互不污染的正确做法（二选一）：
 *     a) 用 `model-keyed` 给每个 session 分配不同模型（`session.create.modelOverride`）；
 *     b) 每个 session 用独立实例（独立 mock server），`instance.mockLlm.reset()` 在每组之前归零。
 *   faux 通道同理（脚本文件是共享的，队列在 pi 进程内 → faux 才是 per-进程）。
 *
 * 出队耗尽 / 未知模型 = HTTP 404 + 结构化 body（pi 侧报错可读，便于归因），**不**伪造回复。
 */
import { createServer } from 'node:http'

/** 缺省 basePath（models.json 的 baseUrl 尾部；OpenAI 客户端会再拼 /chat/completions）。 */
const DEFAULT_BASE_PATH = '/v1'

/** 单条 SSE 帧（OpenAI chat.completion.chunk 形态）。 */
function chunkFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * 剧本形态归一：返回 `(model: string) => step[]` 的取队函数（游标由调用方持有）。
 * @param {unknown} script
 * @returns {(model: string) => { queue: unknown[] } | { error: string }}
 */
function selectQueue(script, name) {
  if (Array.isArray(script)) {
    return (model) => ({ queue: script, key: '<array>', model })
  }
  if (script !== null && typeof script === 'object') {
    const map = script
    return (model) => {
      // 实测事实（2026-10-21 探针）：pi-ai 的 openai-completions 请求体里 `model` **只有裸
      // id**（`model: model.id`，见 pi-ai dist/api/openai-completions.js 的 buildParams），
      // **不带** `provider/` 前缀。因此匹配顺序 =
      //   ① 全形精确（兼容按 `provider/id` 写 key 的剧本，如 fixtures/faux-responses/*.json）
      //   ② 裸 id 等于请求 model（key 形如 `mockllm/mock-1`，请求 model = `mock-1`）← 主路径
      //   ③ 请求 model 本身是全形时再试其裸 id（pi 侧若未来改回全形仍可用）
      const bare = typeof model === 'string' && model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
      const key =
        (Object.prototype.hasOwnProperty.call(map, model) ? model : undefined) ??
        Object.keys(map).find((k) => {
          const kBare = k.includes('/') ? k.slice(k.indexOf('/') + 1) : k
          return kBare === model || kBare === bare
        })
      if (key === undefined) {
        return {
          error:
            `mock-llm[${name}]: script 是 model-keyed 对象但没有模型 "${model}" 的队列` +
            `（keys: ${Object.keys(map).join(', ') || '<empty>'}）`,
        }
      }
      const queue = map[key]
      if (!Array.isArray(queue)) {
        return { error: `mock-llm[${name}]: script["${key}"] 不是 step 数组（实际 ${typeof queue}）` }
      }
      return { queue, key, model }
    }
  }
  return () => ({ error: `mock-llm[${name}]: script 必须是 step 数组或 model-keyed 对象（实际 ${typeof script}）` })
}

/**
 * step → 待流式写出的 SSE 帧序列（content / thinking / tool_calls 分片 + finish）。
 *
 * 顺序与 faux 的 toAssistantMessage 一致：thinking → text → toolCalls。
 * toolCalls 走 OpenAI 的 `delta.tool_calls`（首片带 id/name，末片带 arguments 全文），
 * 参数 JSON 整体下发（不切分）——pi-ai 的 parseStreamingJson 对单帧全文与分片等价。
 */
function planFrames(step, { id, model, indexBase }) {
  const out = []
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  const frame = (delta, finish = null) => out.push(chunkFrame({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] }))

  frame({ role: 'assistant', content: '' })
  if (typeof step.thinking === 'string' && step.thinking.length > 0) {
    frame({ reasoning_content: step.thinking })
  }
  if (typeof step.text === 'string' && step.text.length > 0) {
    frame({ content: step.text })
  }

  const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : []
  toolCalls.forEach((tc, i) => {
    const index = indexBase + i
    frame({
      tool_calls: [
        {
          index,
          id: tc.id ?? `call_mock_${Date.now().toString(36)}_${index}`,
          type: 'function',
          function: { name: String(tc.name ?? ''), arguments: '' },
        },
      ],
    })
    frame({
      tool_calls: [{ index, function: { arguments: JSON.stringify(tc.args ?? {}) } }],
    })
  })

  // stopReason 与 faux 的推导同口径（error/toolUse/stop）；OpenAI 词表映射：
  // toolUse → tool_calls，error → 顶层 delta 之外的 error 帧（pi-ai 无对应 finish_reason，
  // 直接以 content 呈现错误文本并 stop，保持「不伪造成功」）。
  const stopReason =
    step.stopReason ?? (step.error !== undefined ? 'error' : toolCalls.length > 0 ? 'toolUse' : 'stop')
  if (stopReason === 'toolUse') {
    frame({}, 'tool_calls')
  } else if (stopReason === 'length') {
    frame({}, 'length')
  } else {
    if (stopReason === 'error' && typeof step.error === 'string') {
      frame({ content: `\n[mock-llm step error] ${step.error}` })
    }
    frame({}, 'stop')
  }
  return out
}

/**
 * 起一个 mock LLM 服务。
 *
 * @param {object} opts
 * @param {number} [opts.port=0]       0 = OS 分配；显式端口便于跨进程复用时用
 * @param {string} [opts.host='127.0.0.1']
 * @param {unknown} opts.script        数组（统一队列）或 model-keyed 对象
 * @param {string} [opts.name='mock-llm'] 诊断前缀
 * @param {number} [opts.tps]          可选：内容按字符切块节流（对齐 TAIJI_FAUX_TPS 语义）
 * @returns {Promise<{port:number, host:string, baseUrl:string, basePath:string, requests:Array,
 *   script:unknown, close:()=>Promise<void>, reset:()=>void, pending:()=>Record<string,number>}>}
 */
export async function createMockLlm(opts = {}) {
  const script = opts.script ?? []
  const name = opts.name ?? 'mock-llm'
  const host = opts.host ?? '127.0.0.1'
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH
  const tps = Number.isFinite(opts.tps) && opts.tps > 0 ? opts.tps : 0
  const pick = selectQueue(script, name)

  /** 每个模型一条游标（model-keyed 下各队独立；数组形态只有一个游标）。 */
  const cursors = new Map()
  /** 每次请求的请求体（断言「孙进程真的打到了 mock」的铁证）。 */
  const requests = []
  /** 活跃 socket（close 时必须真正断开，否则 keep-alive 让进程不退出）。 */
  const sockets = new Set()

  const server = createServer((req, res) => {
    // —— 只认 chat/completions；其余路径 404（探活/误配可见）——
    const url = req.url ?? ''
    if (!url.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'not_found', message: `mock-llm: 未知路径 ${url}` } }))
      return
    }

    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('error', () => {
      /* 客户端提前断开：不崩、不写 SSE */
    })
    req.on('end', () => {
      // SSE 写失败（客户端 abort / ECONNRESET）不能冒泡成 uncaught
      res.on('error', () => {
        /* keep-alive 关闭竞态下的 EPIPE 属正常 */
      })

      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'invalid_json', message: 'mock-llm: 请求体不是 JSON' } }))
        return
      }

      const model = typeof body.model === 'string' ? body.model : ''
      const messages = Array.isArray(body.messages) ? body.messages : []
      const selected = pick(model)
      if (selected.error !== undefined) {
        requests.push({ model, at: Date.now(), status: 404, error: selected.error, messageCount: messages.length, messages })
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: {
              type: 'mock_llm_no_script',
              message: selected.error,
              model,
              availableModels: Array.isArray(script) ? '<array queue>' : Object.keys(script ?? {}),
            },
          }),
        )
        return
      }

      const { queue, key } = selected
      const cursor = cursors.get(key) ?? 0
      if (cursor >= queue.length) {
        const message =
          `mock-llm[${name}]: 模型 "${model}" 的剧本已耗尽（已消费 ${cursor}/${queue.length} 步）` +
          '——同 session 后续 turn 会命中本错误，属预期（补脚本或减少轮次）'
        requests.push({
          model,
          at: Date.now(),
          status: 404,
          error: message,
          messageCount: messages.length,
          messages,
          stepIndex: cursor,
        })
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { type: 'mock_llm_script_exhausted', message, model, consumed: cursor, total: queue.length },
          }),
        )
        return
      }
      cursors.set(key, cursor + 1)
      const step = queue[cursor] ?? {}

      requests.push({
        model,
        at: Date.now(),
        status: 200,
        queueKey: key,
        stepIndex: cursor,
        messageCount: messages.length,
        // messages 全量留档（判据：孙进程 prompt 里带了 task 文本）——体积由调用方按需切片
        messages,
        // 便于断言「这一轮是主 agent 还是 subagent」的摘要
        summary: messages
          .slice(-3)
          .map((m) => ({ role: m?.role, text: typeof m?.content === 'string' ? m.content.slice(0, 200) : '[...]' })),
      })

      const id = `chatcmpl-mock-${Date.now().toString(36)}-${cursor}`
      const frames = planFrames(step, { id, model, indexBase: 0 })
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })

      let closed = false
      const stop = () => {
        closed = true
      }
      res.on('close', stop)

      if (tps === 0) {
        for (const f of frames) res.write(f)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // 节流形态：按「近似 token = 4 字符」切帧间隔，制造可观测的流式窗口。
      ;(async () => {
        const perCharMs = 1000 / (tps * 4)
        for (const unit of frames) {
          if (closed) return
          // 一帧内部的 content 也按字符切分（更细的 delta 粒度）
          const m = /^data: (\{.*\})\n\n$/s.exec(unit)
          let payload = null
          if (m) {
            try {
              payload = JSON.parse(m[1])
            } catch {
              payload = null
            }
          }
          const text = payload?.choices?.[0]?.delta?.content
          if (typeof text !== 'string' || text.length <= 1) {
            res.write(unit)
            continue
          }
          for (const ch of text) {
            if (closed) return
            const clone = JSON.parse(JSON.stringify(payload))
            clone.choices[0].delta.content = ch
            res.write(chunkFrame(clone))
            await new Promise((r) => setTimeout(r, perCharMs))
          }
        }
        if (closed) return
        res.write('data: [DONE]\n\n')
        res.end()
      })().catch(() => {
        /* 写失败（客户端断开）不冒泡 */
      })
    })
  })

  server.on('connection', (sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })

  // 启动期错误（端口占用等）→ reject 给调用方；**listen 成功后必须摘掉**，
  // 否则后续运行时错误会 reject 一个没人 await 的 promise（unhandled rejection）。
  await new Promise((resolve, reject) => {
    const onListenError = (err) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onListenError)
      resolve()
    }
    server.once('error', onListenError)
    server.once('listening', onListening)
    server.listen(opts.port ?? 0, host)
  })
  // listen 之后的 server 级错误：只记不抛（不带 listener 会变成 uncaught 杀死进程）
  const runtimeErrors = []
  server.on('error', (err) => {
    runtimeErrors.push({ at: Date.now(), message: err instanceof Error ? err.message : String(err) })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const baseUrl = `http://${host}:${port}${basePath}`

  return {
    port,
    host,
    baseUrl,
    basePath,
    /** 每次请求的请求体记录（含 model / messages / stepIndex / status）。 */
    requests,
    /** listen 之后的 server 级错误（诊断用；正常恒空）。 */
    errors: runtimeErrors,
    /** 原始剧本（诊断用）。 */
    script,
    /** 各队列已消费步数（断言「子演员队列真的被消费」用）。 */
    pending() {
      const out = {}
      for (const [k, v] of cursors) out[k] = v
      return out
    },
    /**
     * 游标归零（同一实例内复用剧本，例如跨 scenario 步骤）。
     *
     * 多 session 场景在「换受测会话」之前调用，避免 A 消费的 step 影响 B 的首轮
     * （游标 per-model 共享，见文件头游标语义）。
     */
    reset() {
      cursors.clear()
      requests.length = 0
    },
    /** 真正关掉 server 与所有 keep-alive 连接（否则进程不退出）。 */
    async close() {
      for (const sock of sockets) {
        try {
          sock.destroy()
        } catch {
          /* already gone */
        }
      }
      sockets.clear()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

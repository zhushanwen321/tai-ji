/**
 * useTtsPlayer —— TTS 朗读播放器（renderer 全局单例，ai-voice-tts 设计 D11）。
 *
 * 职责（设计 §7.5 四要点）：全局唯一朗读任务态 + 唯一 Audio 实例 + 调 core 域 tts.speak +
 * 发送前本地拦截（cleanTextForSpeech 判空判长，不发 RPC）+ 取消（客户端任务作废，reply 迟到
 * 丢弃）+ settings-tts-test 伪 id 互斥 + 错误码 → toast（§5.4 表）。
 *
 * 全局单例（D11）：同一时刻每窗口只有一条消息在朗读，状态本身窗口级唯一——不按 per-session
 * Map 分区（语义错误：切 session 后旧 session 的播放态应继续存在且全局唯一）。本例外已登记
 * 进 ADR-0049 例外清单（全局协调器类）与数据源登记表 §4 ⑧ EX-B 清单。
 * 切 session 不打断播放（本模块无任何 session 监听）；播放中删除 session 的停播编排归
 * useSidebar.deleteSession 统一调 stop()（D11，消费方装配）。
 *
 * 取消语义（§7.5 要点 2）：command() 不暴露取消句柄，取消 = 客户端任务作废——job 身份比对
 * （currentJob !== job 即已作废），reply 迟到直接丢弃：不播放、无 toast；runtime 不受打扰
 * 照常合成写缓存（已付不浪费，重读命中缓存）。合成超时传 0（任务级不限时）由 core 域
 * tts.speak 承担，本模块不感知墙钟。
 *
 * 消费方：u5 装配（useChatViewDeps 绑 onSpeak/speakStateOf → 本模块；TurnSummary 按钮三态）+
 * u4 设置页「保存并测试」（按 SETTINGS_TTS_TEST_MESSAGE_ID 调 speak/stop，按钮态经
 * speakStateOf 查询）。
 *
 * i18n key 清单（key 登记 = u4 唯一写入者，文案在 locale 文件；本模块只传 key 与命名参数，
 * 单测断言 key 存在性）：
 * - panel.message.speakEmpty            清洗后无文本（本地拦截 + runtime tts_empty_text 同键）
 * - panel.message.speakTooLong{count}   超 MAX_SPEAK_CHARS（本地拦截 + runtime 同键；count = 字符数）
 * - panel.message.speakNotConfigured    tts_not_configured（未配置，指引去设置页）
 * - panel.message.speakAuthFailed       tts_auth_failed（鉴权失败，指引检查 Key）
 * - panel.message.speakQuotaExceeded    tts_quota_exceeded（额度不足，指引含「不要重试」）
 * - panel.message.speakVendorError{detail} tts_vendor_error（厂商错误摘要截 200 字符，§5.4）
 * - panel.message.speakNetworkError     tts_network_error（网络异常，指引查网络与 Base URL）
 * - panel.message.speakFailed           兜底（传输层断开/超时/未知码/play 失败，D8 catch-all）
 */
import { ref } from 'vue'
import { MAX_SPEAK_CHARS, cleanTextForSpeech } from '@taiji/shared'
// 直连 core 域（useQuotaQuery 同先例：features 层 composable 直 import transport 域，不经 @/api 门面）。
// mock 轨差异（VITE_MOCK）由消费方装配面承担——TtsPage 配置读写经 @/api tts 门面（u4 聚合）。
import * as ttsApi from '@taiji/core/transport/api/domains/tts'
import i18n from '@/i18n'
import { useToast } from '@/composables/useToast'

// i18n.global.t 的类型窄化（对齐 useQuotaQuery 的非 setup composable 模式：这里只需 key + 命名参数）
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

const { error: toastError } = useToast()

/** 朗读任务三态（§5.1 按钮状态机数据面；查询接口 speakStateOf 的返回值）。 */
export type SpeakStatus = 'idle' | 'loading' | 'playing'

/** 设置页「保存并测试」固定伪 messageId（§7.5 要点 4：与对话朗读共享全局互斥，消费方 u4）。 */
export const SETTINGS_TTS_TEST_MESSAGE_ID = 'settings-tts-test'

/** 进行中的朗读任务（D11 单例本体；null = idle，即窗口当前无朗读）。 */
interface TtsJob {
  /** 递增 id：取消判定的身份锚（currentJob 经 ref 读出是响应式代理，与局部原始对象
   *  引用不等——身份比对必须走原始值字段，不能比对象引用）。 */
  id: number
  sessionId?: string
  messageId: string
  status: 'loading' | 'playing'
}

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，登记见数据源登记表 §4 ⑧）：窗口级
// 唯一朗读任务态——同一时刻只有一条在播，状态本身全局唯一（per-session 分区语义错误，D11）；
// 播完/停止/失败即清空，无常驻数据本体。
const currentJob = ref<TtsJob | null>(null)

/** 播放代次：每次真正起播递增；取消/顶替再递增——迟到的 onended/playing 推进按代次失效。 */
let playbackSeq = 0

/** 任务 id 发放器（配合 TtsJob.id 作取消判定的身份锚）。 */
let nextJobId = 0

/** 唯一 Audio 实例（懒构造：不在模块加载期触碰 DOM API，测试环境可先装桩再触发首播）。 */
let audio: HTMLAudioElement | undefined

/** local-file:// URL（照 markdown-sanitize.ts toLocalFileUrl 既有拼法：整段路径 encodeURIComponent；
 *  不直接 import 该函数——那会把整条 markdown 渲染管线拉进播放器的 import 图）。 */
function localFileUrl(filePath: string): string {
  return `local-file:///${encodeURIComponent(filePath)}`
}

function getAudio(): HTMLAudioElement {
  if (!audio) audio = new Audio()
  return audio
}

/** 读取错误码：command() 的错误 reject 形态 = Error 携带 code（pending.resolveEnvelope 透传
 *  envelope code；transportUnavailableError 同形）。非此形态返回 undefined 走兜底文案。 */
function readErrorCode(e: unknown): string | undefined {
  if (e instanceof Error && 'code' in e && typeof e.code === 'string') return e.code
  return undefined
}

function errorMessageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** tts_vendor_error toast 内厂商错误摘要截断上限（§5.4「截断 200 字符」）。 */
const VENDOR_DETAIL_MAX_CHARS = 200

/** 错误 → toast 文案（§5.4 表逐码映射；未知码/传输层失败/play 失败 → speakFailed 兜底，D8）。 */
function toastForError(e: unknown, cleanedLength: number): string {
  switch (readErrorCode(e)) {
    case 'tts_not_configured':
      return t('panel.message.speakNotConfigured')
    case 'tts_auth_failed':
      return t('panel.message.speakAuthFailed')
    case 'tts_quota_exceeded':
      return t('panel.message.speakQuotaExceeded')
    case 'tts_vendor_error':
      return t('panel.message.speakVendorError', { detail: errorMessageOf(e).slice(0, VENDOR_DETAIL_MAX_CHARS) })
    case 'tts_network_error':
      return t('panel.message.speakNetworkError')
    case 'tts_text_too_long':
      // runtime 侧防御路径（本地拦截后理论不可达，双端同 MAX_SPEAK_CHARS）：以本地清洗长度为计数
      return t('panel.message.speakTooLong', { count: cleanedLength })
    case 'tts_empty_text':
      return t('panel.message.speakEmpty')
    default:
      return t('panel.message.speakFailed')
  }
}

/** 作废当前任务（点击停止与新朗读重入共用）：代次递增使 in-flight 回调失效 + 停播 + 回 idle。
 *  不打断 runtime 合成（command 无取消通道，§7.5 要点 2）——已付合成照常写缓存。 */
function cancelCurrent(): void {
  playbackSeq += 1
  if (audio) audio.pause()
  currentJob.value = null
}

async function runSpeak(sessionId: string | undefined, messageId: string, rawText: string): Promise<void> {
  // ① 发送前本地拦截（§7.5 要点 1）：判空/判长本地完成、不发 RPC——status 从未离开 idle
  const cleaned = cleanTextForSpeech(rawText)
  if (cleaned === '') {
    toastError(t('panel.message.speakEmpty'))
    return
  }
  if (cleaned.length > MAX_SPEAK_CHARS) {
    toastError(t('panel.message.speakTooLong', { count: cleaned.length }))
    return
  }
  // ② 全局互斥（D11 + §5.1「点了别条」出口）：旧任务客户端作废（无提示），新任务重入 loading。
  //    settings-tts-test 与对话朗读同走此路径，天然双向互斥（§7.5 要点 4）。
  cancelCurrent()
  const jobId = ++nextJobId
  currentJob.value = { id: jobId, sessionId, messageId, status: 'loading' }
  const isCurrent = (): boolean => currentJob.value?.id === jobId
  try {
    // ③ 合成请求：清洗后文本发出（runtime 幂等重洗兜底）；timeout 0 在 core 域 tts.speak 内
    const { filePath } = await ttsApi.speak({ sessionId, text: cleaned })
    // ④ reply 迟到/已取消 → 直接丢弃：不播放、无 toast（验收 2；runtime 照常写缓存不浪费）
    if (!isCurrent()) return
    const a = getAudio()
    const seq = ++playbackSeq
    // 播完自然回 idle（§7.5 要点 5）；onended 单槽（唯一实例单播放语义，新播覆盖旧槽）
    a.onended = () => {
      if (seq === playbackSeq && isCurrent()) currentJob.value = null
    }
    a.src = localFileUrl(filePath)
    // ⑤ playing 态由 play() resolve 驱动（验收 5）；play 期间被 pause（stop）会 reject → 走 catch
    await a.play()
    if (seq !== playbackSeq) return
    const cur = currentJob.value
    if (cur?.id !== jobId) return
    cur.status = 'playing'
  } catch (e) {
    // 取消/顶替后的一切迟到失败静默（无 toast）；仍属本任务才呈现（回 idle + toast，D8）
    if (!isCurrent()) return
    currentJob.value = null
    toastError(toastForError(e, cleaned.length))
  }
}

/** 朗读指定消息文本（u5 装配：onSpeak(sid, msg) → speak(sid, msg.id, msg 正文)；u4 测试播放：
 *  speak(undefined, SETTINGS_TTS_TEST_MESSAGE_ID, 样句)。已有任务在播时新朗读顶替旧任务。 */
function speak(sessionId: string | undefined, messageId: string, text: string): void {
  void runSpeak(sessionId, messageId, text)
}

/** 停止当前朗读（点击停止 / useSidebar.deleteSession 停播编排同源复用，D11）。 */
function stop(): void {
  cancelCurrent()
}

/** 查询某消息的朗读态（u5 speakStateOf 装配 + u4 测试按钮态；非当前任务恒 idle）。 */
function speakStateOf(messageId: string): SpeakStatus {
  const job = currentJob.value
  return job !== null && job.messageId === messageId ? job.status : 'idle'
}

/** 全局单例播放器入口（useToast 同范式：模块级单例状态 + 工厂函数返回方法集）。 */
export function useTtsPlayer() {
  return { speak, stop, speakStateOf }
}

/** 测试专用：清空单例（任务态 / Audio 缓存 / 代次），用例间隔离（__resetSoundCachesForTest 先例）。 */
export function __resetTtsPlayerForTest(): void {
  currentJob.value = null
  audio = undefined
  playbackSeq += 1
}

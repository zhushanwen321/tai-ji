/**
 * 启用语音朗读总开关（ai-voice-tts 设计 §5.2 通用配置；§5.1「关闭后朗读按钮报
 * 语音服务未配置」的行为面）。
 *
 * 存储落点说明：u1 协议形状（SanitizedTtsConfig / TtsConfig / tts.configure payload）
 * 未承载全局开关字段——本开关属 renderer 侧功能偏好，落 localStorage（与主题/字号等
 * UI 偏好同类），不进 runtime tts.json。消费方：本设置页（TtsPage）+ u5 朗读按钮装配
 * （关闭时点朗读 → toast「语音服务未配置」，同 panel.message.speakNotConfigured 文案）。
 */
import { ref } from 'vue'

const STORAGE_KEY = 'taiji.tts.enabled'

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {
    // localStorage 不可用（隐私模式等）：按默认开启
    return true
  }
}

/**
 * 模块级单例（u5 装配与设置页读同一份状态，改开关即时生效于朗读按钮）。
 *
 * @data-owner #45
 * （data-source-registry 主表：语音朗读总开关，localStorage 权威源）
 */
const enabled = ref(readEnabled())

export function useTtsSpeechEnabled() {
  function setEnabled(v: boolean): void {
    enabled.value = v
    try {
      localStorage.setItem(STORAGE_KEY, String(v))
    } catch (error) {
      // 写盘失败仅内存生效，不阻断开关交互
      console.warn('[tts] persist speech-enabled failed', error)
    }
  }
  return { enabled, setEnabled }
}

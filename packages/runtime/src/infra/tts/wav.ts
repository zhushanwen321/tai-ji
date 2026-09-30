/* eslint-disable no-magic-numbers -- RIFF/WAV 头按格式规范逐字节写入：字面量均为布局偏移量与块长度（领域格式数据，非逻辑魔数），语义由行内注释与规范名承载 */
/**
 * PCM → WAV（RIFF）44 字节头封装（ai-voice-tts 设计 D9 / §7.4 步骤 6）。
 *
 * 纯函数：无 IO、无厂商知识——PCM 字节与实际采样率/声道数由 driver 回报
 * （TtsSynthesisChunk），本模块只负责按事实值写头。
 *
 * ⚠ numChannels 必须按实际声道数写：双声道 PCM 是左右声道交织字节流，
 * 头按 mono 写会被播放器按单声道解帧——变速且时长翻倍（设计 §7.3 synthesizeChunk 注释）。
 */

/** 标准 PCM WAV 头字节数（16-bit PCM、无扩展 fmt 块）。 */
export const WAV_HEADER_BYTES = 44

/** 16-bit 小端 PCM 的位深（三家 driver 归一产物恒 16-bit PCM，设计 D9）。 */
const BITS_PER_SAMPLE = 16

/** PCM 裸流封装 44 字节 WAV 头（RIFF/WAVE/fmt/data 标准布局，小端）。 */
export function wrapPcmAsWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const blockAlign = (channels * BITS_PER_SAMPLE) / 8
  const header = Buffer.alloc(WAV_HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  // RIFF chunk size = 4（'WAVE'）+ 24（fmt 块全长）+ 8（data 块头）+ 数据字节数
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt 块长度（PCM 无扩展字段）
  header.writeUInt16LE(1, 20) // audioFormat = 1（线性 PCM）
  header.writeUInt16LE(channels, 22) // numChannels：按 driver 回报实际声道写
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28) // byteRate
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

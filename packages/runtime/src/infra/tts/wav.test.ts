/**
 * WAV 头封装单测（ai-voice-tts 设计 D9 / §7.4 步骤 6）。
 * 重点：头字节事实值（RIFF 布局 / 采样率 / 位深 / 数据长度）与 channels 回报值逐字节核对——
 * 双声道用例钉死「numChannels 按回报值写」，防 mono 写死致播放变速/时长翻倍。
 */
import { describe, expect, it } from 'vitest'
import { wrapPcmAsWav, WAV_HEADER_BYTES } from './wav.js'

const PCM_16BIT_MONO = Buffer.from([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80])

describe('wrapPcmAsWav', () => {
  it('mono 24kHz：标准 44 字节头 + 标记字节 + 数据本体完整保留', () => {
    const wav = wrapPcmAsWav(PCM_16BIT_MONO, 24_000, 1)
    expect(wav.length).toBe(WAV_HEADER_BYTES + PCM_16BIT_MONO.length)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ')
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data')
    expect(wav.readUInt32LE(4)).toBe(36 + PCM_16BIT_MONO.length)
    expect(wav.readUInt32LE(16)).toBe(16) // fmt 块长度
    expect(wav.readUInt16LE(20)).toBe(1) // linear PCM
    expect(wav.subarray(WAV_HEADER_BYTES)).toEqual(PCM_16BIT_MONO)
  })

  it('mono 头事实值：sampleRate=24000 / numChannels=1 / byteRate=48000 / blockAlign=2 / bits=16', () => {
    const wav = wrapPcmAsWav(PCM_16BIT_MONO, 24_000, 1)
    expect(wav.readUInt32LE(24)).toBe(24_000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(28)).toBe(24_000 * 1 * 2)
    expect(wav.readUInt16LE(32)).toBe(2)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(PCM_16BIT_MONO.length)
  })

  it('双声道（channels=2）：numChannels 写 2，byteRate/blockAlign 按双声道计（变速防线用例）', () => {
    const wav = wrapPcmAsWav(PCM_16BIT_MONO, 24_000, 2)
    expect(wav.readUInt16LE(22)).toBe(2)
    expect(wav.readUInt32LE(28)).toBe(24_000 * 2 * 2)
    expect(wav.readUInt16LE(32)).toBe(4)
    expect(wav.readUInt16LE(34)).toBe(16)
  })

  it('空 PCM：数据长度 0 的合法空 WAV 头', () => {
    const wav = wrapPcmAsWav(Buffer.alloc(0), 16_000, 1)
    expect(wav.length).toBe(WAV_HEADER_BYTES)
    expect(wav.readUInt32LE(40)).toBe(0)
    expect(wav.readUInt32LE(4)).toBe(36)
  })
})

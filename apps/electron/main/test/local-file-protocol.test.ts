import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { expandLocalFilePath } from '../utils/path'

describe('local-file protocol path expansion', () => {
  it('E1: expands ~ prefix to homedir', () => {
    const result = expandLocalFilePath('~/Code/foo.png')
    expect(result).toBe(`${homedir()}/Code/foo.png`)
  })

  it('E1b: leaves absolute paths unchanged', () => {
    const result = expandLocalFilePath('/var/tmp/foo.png')
    expect(result).toBe('/var/tmp/foo.png')
  })
})

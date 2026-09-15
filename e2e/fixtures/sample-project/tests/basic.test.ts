import { describe, it, expect } from 'vitest'
import { main } from '../src/index.js'

describe('sample-project', () => {
  it('greets', () => {
    expect(main()).toBe('Hello, world!')
  })
})

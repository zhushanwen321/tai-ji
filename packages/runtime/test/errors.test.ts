import { describe, it, expect } from 'vitest'
import { toErrorMessage, isEnoent, isNotFound, errorWithCode } from '../src/utils/errors.js'

describe('toErrorMessage', () => {
  it('extracts .message from an Error', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('stringifies a non-Error thrown value', () => {
    expect(toErrorMessage('plain string')).toBe('plain string')
    expect(toErrorMessage(42)).toBe('42')
    expect(toErrorMessage(null)).toBe('null')
    expect(toErrorMessage(undefined)).toBe('undefined')
  })

  it('stringifies an object (no [object Object] ambiguity for arrays)', () => {
    expect(toErrorMessage([1, 2])).toBe('1,2')
  })

  it('handles subclass of Error', () => {
    class MyError extends Error {
      constructor(msg: string) { super(msg); this.name = 'MyError' }
    }
    expect(toErrorMessage(new MyError('sub'))).toBe('sub')
  })

  it('returns the message even when .message is empty', () => {
    expect(toErrorMessage(new Error(''))).toBe('')
  })
})

describe('isEnoent', () => {
  it('returns true for an error with code ENOENT', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    expect(isEnoent(err)).toBe(true)
  })

  it('returns false for an error with a different code', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    expect(isEnoent(err)).toBe(false)
  })

  it('returns false for a plain Error without a code', () => {
    expect(isEnoent(new Error('no code'))).toBe(false)
  })

  it('returns false for non-object values', () => {
    expect(isEnoent(null)).toBe(false)
    expect(isEnoent(undefined)).toBe(false)
    expect(isEnoent('ENOENT')).toBe(false)
    expect(isEnoent(42)).toBe(false)
  })

  it('returns false for an object without a code property', () => {
    expect(isEnoent({ message: 'x' })).toBe(false)
  })

  it('returns false for an object whose code is a non-matching string', () => {
    expect(isEnoent({ code: 'ENOTDIR' })).toBe(false)
  })

  it('returns true for a plain object with code ENOENT (duck-typed)', () => {
    // NodeJS.ErrnoException is structural — a plain object with code works
    expect(isEnoent({ code: 'ENOENT' })).toBe(true)
  })
})

describe('isNotFound', () => {
  it('returns true when Error message contains "not found" (lowercase)', () => {
    expect(isNotFound(new Error('session not found'))).toBe(true)
    expect(isNotFound(new Error('the resource was not found in tree'))).toBe(true)
  })

  it('is case-sensitive: capitalized "Not Found" does NOT match', () => {
    // 生产代码用 `.includes('not found')`（区分大小写）；此处钉住该行为。
    expect(isNotFound(new Error('Session Not Found'))).toBe(false)
  })

  it('returns false when Error message does not contain "not found"', () => {
    expect(isNotFound(new Error('permission denied'))).toBe(false)
    expect(isNotFound(new Error('boom'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isNotFound('not found')).toBe(false)
    expect(isNotFound(42)).toBe(false)
    expect(isNotFound(null)).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
    expect(isNotFound({ message: 'not found' })).toBe(false)
  })

  it('returns false for an Error with empty message', () => {
    expect(isNotFound(new Error(''))).toBe(false)
  })
})

describe('errorWithCode', () => {
  it('creates an Error with a string code', () => {
    const err = errorWithCode('denied', 'PERMISSION_DENIED')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('denied')
    expect(err.code).toBe('PERMISSION_DENIED')
  })

  it('creates an Error with a numeric code (JSON-RPC -32xxx)', () => {
    const err = errorWithCode('parse error', -32700)
    expect(err.message).toBe('parse error')
    expect(err.code).toBe(-32700)
  })

  it('exposes .code as a readable property', () => {
    const err = errorWithCode('x', 'E_FOO')
    expect(err.code).toBe('E_FOO')
    // code is a real own property, not undefined
    expect(Object.prototype.hasOwnProperty.call(err, 'code')).toBe(true)
  })
})

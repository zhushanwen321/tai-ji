import { describe, it, expect } from 'vitest'
import { parseSkillMd } from '../src/services/scanners/skill-scanner.js'

describe('parseSkillMd argumentHint extraction', () => {
  it('extracts argument-hint from frontmatter', () => {
  const content = [
    '---',
    'name: test-skill',
    'argument-hint: "[filename]"',
    '---',
    'This is a test skill.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBe('[filename]')
  })

  it('returns undefined argumentHint when field is absent', () => {
  const content = [
    '---',
    'name: test-skill',
    '---',
    'This is a test skill.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBeUndefined()
  })

  it('returns undefined when argument-hint has empty value (regex requires 1+ chars)', () => {
  const content = [
    '---',
    'argument-hint:',
    '---',
    'This is a test skill.',
  ].join('\n')

  const result = parseSkillMd(content)
  // The regex (.+?) requires at least one char, so bare key produces undefined
  expect(result.argumentHint).toBeUndefined()
  })

  it('extracts argument-hint from middle of frontmatter', () => {
  const content = [
    '---',
    'name: my-skill',
    'description: "A skill that does things"',
    'argument-hint: "<file-path>"',
    'triggers:',
    '  - "do things"',
    '---',
    'Body text.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBe('<file-path>')
  })

  it('returns undefined argumentHint for content without frontmatter', () => {
  const content = 'Just a plain markdown file with no frontmatter at all.'

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBeUndefined()
  })

  it('extracts argument-hint with quoted value', () => {
  const content = [
    '---',
    'argument-hint: "[query string]"',
    '---',
    'Skill body.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBe('[query string]')
  })

  it('extracts argument-hint at first line of frontmatter', () => {
  const content = [
    '---',
    'argument-hint: "<target>"',
    'name: top-hint-skill',
    '---',
    'Body.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.argumentHint).toBe('<target>')
  })
})

describe('parseSkillMd description and triggers', () => {
  it('extracts body description from first non-heading non-empty line after frontmatter', () => {
  const content = [
    '---',
    'name: demo',
    '---',
    '',
    '# Skill Title',
    '',
    'This is the actual description.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.description).toBe('This is the actual description.')
  })

  it('extracts triggers from frontmatter description with quoted trigger words', () => {
  // Use Unicode left/right double quotes which the trigger regex matches
  const content =
    '---\n' +
    'description: Use when user says \u201Canalyze code\u201D or \u201Crun analysis\u201D\n' +
    '---\n' +
    'Body.'

  const result = parseSkillMd(content)
  expect(result.triggers).toContain('analyze code')
  expect(result.triggers).toContain('run analysis')
  })

  it('returns empty triggers when no quoted phrases in description', () => {
  const content = [
    '---',
    'description: A simple skill without trigger patterns.',
    '---',
    'Body.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.triggers).toEqual([])
  })

  it('prefers frontmatter description for triggers; body description value still wins for description field', () => {
  // description 字段永远取正文（frontmatter 的 fmDesc 只影响 triggers 来源）
  const content = [
    '---',
    'name: demo',
    'description: Use \u201Calpha mode\u201D for speed',
    '---',
    '"beta mode" body line.',
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.description).toBe('"beta mode" body line.')
  // triggers 只从 frontmatter description 提取，正文的引号词不进
  expect(result.triggers).toEqual(['alpha mode'])
  })

  it('truncates body description to 200 characters', () => {
  const longLine = 'x'.repeat(300)
  const content = [
    '---',
    'name: long',
    '---',
    longLine,
  ].join('\n')

  const result = parseSkillMd(content)
  expect(result.description).toHaveLength(200)
  expect(result.description).toBe('x'.repeat(200))
  })
})

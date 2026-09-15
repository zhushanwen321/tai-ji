// paths.test.ts —— 引擎路径 SSOT 单测（随 paths.ts 迁 SDK 包，迁移执行归 W10，
// impl-plan §2.10 处置清单①「随 SDK 原语迁移」行）。

import { describe, expect, it } from 'vitest';

import {
  resolveEngineDir,
  resolveEnginesRoot,
  resolveJournalPath,
  resolvePoolDir,
  sanitizeSeg,
} from '../paths.js';

describe('engine paths SSOT', () => {
  it('engines 根锚定 dataDir 顶层', () => {
    expect(resolveEnginesRoot('/data')).toBe('/data/engines');
  });

  it('池目录 = engines/<engineId>/<poolKey>', () => {
    expect(resolvePoolDir('/data', 'zcode', 'home-reviewer')).toBe('/data/engines/zcode/home-reviewer');
    expect(resolveEngineDir('/data', 'zcode')).toBe('/data/engines/zcode');
  });

  it('journal 路径带 taskId 文件名', () => {
    expect(resolveJournalPath('/data', 'zcode', 'pool1', 'sa-123')).toBe(
      '/data/engines/zcode/pool1/journal-sa-123.jsonl',
    );
  });

  it('路径段安全编码：穿越/分隔符/空白折叠为连字符', () => {
    expect(sanitizeSeg('a/b\\c')).toBe('a-b-c');
    expect(sanitizeSeg('..')).toBe('default');
    expect(sanitizeSeg('  ')).toBe('default');
    expect(sanitizeSeg('home-reviewer')).toBe('home-reviewer');
    expect(sanitizeSeg('中文名')).toBe('default');
    expect(sanitizeSeg('x'.repeat(200))).toHaveLength(80);
  });

  it('engineId 也走安全编码，防注入路径段', () => {
    expect(resolvePoolDir('/data', '../../etc', 'p')).toBe('/data/engines/etc/p');
  });
});

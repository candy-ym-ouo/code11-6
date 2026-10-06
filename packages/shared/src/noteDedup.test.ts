import { describe, expect, it } from 'vitest';
import {
  findNoteDuplicate,
  normalizeNoteBody,
  noteAlreadyInStory,
  SIMILAR_MIN_LEN,
} from './noteDedup';

describe('normalizeNoteBody', () => {
  it('折叠空白与标点差异', () => {
    expect(normalizeNoteBody(' 箱子是我 10 岁那年搬的！')).toBe(normalizeNoteBody('箱子是我10岁那年搬的。'));
  });

  it('统一全角半角（NFKC）', () => {
    expect(normalizeNoteBody('Ｔｅｓｔ　１２３')).toBe(normalizeNoteBody('Test123'));
  });

  it('不区分中英文大小写', () => {
    expect(normalizeNoteBody('ABC')).toBe(normalizeNoteBody('abc'));
  });
});

describe('findNoteDuplicate', () => {
  it('归一化后完全相同判定为 exact', () => {
    const dup = findNoteDuplicate('箱子是我十岁那年搬的！', [{ body: ' 箱子 是我 十岁 那年搬的。' }]);
    expect(dup?.kind).toBe('exact');
  });

  it('包含关系且足够长判定为 similar', () => {
    const dup = findNoteDuplicate('木头上还有我刻的印子', [
      { body: '箱子是我十岁那年搬的，木头上还有我刻的印子' },
    ]);
    expect(dup?.kind).toBe('similar');
  });

  it('相同片段前后多写几个字仍判定为 similar', () => {
    const dup = findNoteDuplicate('木头上还有我刻的印子，在右下角', [
      { body: '箱子是我十岁那年跟着搬家的，木头上还有我刻的印子' },
    ]);
    expect(dup?.kind).toBe('similar');
  });

  it('短内容的包含不判重，避免「是的」误伤', () => {
    const dup = findNoteDuplicate('是的', [{ body: '是的，箱子确实在储藏间' }]);
    expect(dup).toBeNull();
  });

  it('无关内容不判重', () => {
    const dup = findNoteDuplicate('锁扣后来找铁匠配过', [{ body: '箱子是我十岁那年搬的' }]);
    expect(dup).toBeNull();
  });

  it('空候选安全跳过', () => {
    expect(findNoteDuplicate('一段足够长的补充内容用于测试', [{ body: '   ' }])).toBeNull();
  });

  it('similar 阈值常量为正数', () => {
    expect(SIMILAR_MIN_LEN).toBeGreaterThan(0);
  });
});

describe('noteAlreadyInStory', () => {
  it('正文已包含补充内容时判定为已并入', () => {
    expect(noteAlreadyInStory('木头上还有我刻的印子', '箱子是我十岁那年搬的，木头上还有我刻的印子。')).toBe(true);
  });

  it('补充句尾多几个字、但主体已在正文中也算重复', () => {
    expect(noteAlreadyInStory('这件家具是外公在木器社打的东西', '外公在木器社打的。')).toBe(true);
  });

  it('短内容不做包含判定', () => {
    expect(noteAlreadyInStory('印子', '木头上还有我刻的印子')).toBe(false);
  });

  it('正文为空时不命中', () => {
    expect(noteAlreadyInStory('一段足够长的补充内容用于测试', null)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { bodySimilarity, normalizeNoteBody, noteBodyHash, SIMILAR_BODY_THRESHOLD } from './noteText';

describe('normalizeNoteBody', () => {
  it('去掉空白与标点，统一大小写与全半角', () => {
    expect(normalizeNoteBody(' 我记得，这只 箱子！\n')).toBe('我记得这只箱子');
    expect(normalizeNoteBody('ABC１２３')).toBe('abc123');
    expect(normalizeNoteBody('箱子。')).toBe(normalizeNoteBody('箱子'));
  });

  it('纯标点归一化为空串', () => {
    expect(normalizeNoteBody('。。。！！')).toBe('');
  });
});

describe('noteBodyHash', () => {
  it('仅标点/空白不同的内容判定为重复', () => {
    expect(noteBodyHash('箱子是我 10 岁那年跟着搬的。')).toBe(noteBodyHash('箱子是我10岁那年跟着搬的'));
  });

  it('不同内容 hash 不同', () => {
    expect(noteBodyHash('箱子是外公打的')).not.toBe(noteBodyHash('箱子是外婆陪嫁的'));
  });
});

describe('bodySimilarity', () => {
  it('相同内容为 1', () => {
    expect(bodySimilarity('箱子是我十岁跟着搬的', '箱子是我十岁跟着搬的')).toBe(1);
  });

  it('复述（语序微调/少量增删）超过阈值', () => {
    const a = '这只樟木箱是外公在县城木器社亲手打的';
    const b = '樟木箱是外公在县城木器社亲手打的，我记得很清楚';
    expect(bodySimilarity(a, b)).toBeGreaterThanOrEqual(SIMILAR_BODY_THRESHOLD);
  });

  it('无关内容低于阈值', () => {
    const a = '这只樟木箱是外公在县城木器社亲手打的';
    const b = '搪瓷缸是爸妈结婚那年发的福利';
    expect(bodySimilarity(a, b)).toBeLessThan(SIMILAR_BODY_THRESHOLD);
  });

  it('过短或空内容不误判', () => {
    expect(bodySimilarity('', '任何内容')).toBe(0);
    expect(bodySimilarity('好', '好')).toBe(1);
    expect(bodySimilarity('好', '坏')).toBe(0);
  });
});

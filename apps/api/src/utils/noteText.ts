import { sha256Hex } from './crypto';

/**
 * 归一化补充正文，用于「两段文字是不是同一内容」的判定：
 * 统一全半角与大小写、去掉标点符号与空白——家人口语化输入里，
 * 「我记得，这只箱子。」和「我记得这只箱子」应当视为同一段记忆。
 */
export function normalizeNoteBody(body: string): string {
  return body
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

/** 归一化正文的 sha256，精确去重的依据。 */
export function noteBodyHash(body: string): string {
  return sha256Hex(normalizeNoteBody(body));
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

/**
 * 字符二元组 Jaccard 相似度（0~1）。中文没有空格分词，bigram 对
 * 「语序微调 / 少量增删字」的复述稳定，对无关内容区分度高。
 */
export function bodySimilarity(a: string, b: string): number {
  const na = normalizeNoteBody(a);
  const nb = normalizeNoteBody(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const sa = bigrams(na);
  const sb = bigrams(nb);
  let intersection = 0;
  for (const gram of sa) if (sb.has(gram)) intersection += 1;
  return intersection / (sa.size + sb.size - intersection);
}

/** 判定为「疑似重复」的相似度阈值。 */
export const SIMILAR_BODY_THRESHOLD = 0.6;

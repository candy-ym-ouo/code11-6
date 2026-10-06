/**
 * 家人补充内容的查重工具（前后端共用）。
 *
 * 「重复」在家庭场景里的判定不能太严格：长辈打字时常常多几个空格、换个标点、
 * 全角半角混用。因此先把内容归一化（NFKC + 去首尾空白 + 折叠空白/标点），
 * 再比较是否相同；服务端另外对归一化结果取哈希，作为数据库唯一索引的依据。
 */

/** 归一化：全角半角统一、所有空白折叠、去掉标点差异。 */
export function normalizeNoteBody(body: string): string {
  return body
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，。！？；：、,.!?;:…~\-—'"“”‘’（）()【】\[\]{}«»]/g, '')
    .toLocaleLowerCase('zh-CN');
}

/**
 * 重复判定结果。
 * - exact：归一化后完全相同（同一作者也算，防止手抖点两次提交）
 * - similar：一方完整包含另一方且较长端达到最小长度（避免「是的」这类短回复误伤）
 * - inStory：内容其实已经写进正文
 */
export type NoteDuplicateKind = 'exact' | 'similar' | 'inStory';

export interface NoteDuplicate {
  kind: NoteDuplicateKind;
}

/** 触发「近似重复」的最小归一化长度（约 10 个汉字），短于这个长度只做精确判定。 */
export const SIMILAR_MIN_LEN = 10;

/**
 * 检测候选内容与一组既有补充是否重复。
 * @param candidates 待比较的补充内容（应排除已驳回的：驳回表示「不要这条」，
 *                   之后家人重新写出同样的内容应当允许）
 */
/** 两条补充是否共享足够长的连续片段（近似重复的判定依据）。 */
export function isSimilarNote(a: string, b: string): boolean {
  const x = normalizeNoteBody(a);
  const y = normalizeNoteBody(b);
  return Math.min(x.length, y.length) >= SIMILAR_MIN_LEN && longestCommonSubstring(x, y) >= SIMILAR_MIN_LEN;
}

export function findNoteDuplicate(
  candidate: string,
  candidates: { body: string }[],
): NoteDuplicate | null {
  const key = normalizeNoteBody(candidate);
  if (key.length === 0) return null;

  for (const existing of candidates) {
    const other = normalizeNoteBody(existing.body);
    if (other.length === 0) continue;
    if (other === key) return { kind: 'exact' };
    // 双方都达到最小长度、且共享足够长的连续片段才判近似：
    // 既覆盖「整句照搬又在句尾补一句」，也避免「是的」这类短回复误中长补充。
    if (isSimilarNote(key, other)) {
      return { kind: 'similar' };
    }
  }
  return null;
}

/** 与正文判重时要求的最长连续重合片段长度（8 个汉字在家庭叙事里已足够特异）。 */
const STORY_OVERLAP_LEN = 8;

/**
 * 两个字符串的最长公共连续片段长度（O(n*m)，补充正文都很短，可接受）。
 * 用于「近似重复」：允许新补充在相同片段的前后多写几个字
 * （如「木头上还有我刻的印子，在右下角」对「……木头上还有我刻的印子」）。
 */
function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  // dp[i][j]：以 a[i-1]、b[j-1] 结尾的公共片段长度
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a.charAt(i - 1) === b.charAt(j - 1)) {
        cur[j] = (prev[j - 1] ?? 0) + 1;
        if ((cur[j] ?? 0) > best) best = cur[j] ?? 0;
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 待并入的补充是否其实已经包含在正文纯文本里（采纳时的二次保险，防止并发重复采纳）。
 * 判定有两种命中：
 *  - 补充整体（≥10 字）已被正文包含；
 *  - 补充与正文存在较长的连续重合片段（长辈常会在句尾多加一两个字，
 *    如正文「外公在木器社打的」对补充「外公在木器社打的东西」）。
 */
export function noteAlreadyInStory(noteBody: string, storyText: string | null | undefined): boolean {
  const key = normalizeNoteBody(noteBody);
  if (key.length < SIMILAR_MIN_LEN) return false;
  const story = normalizeNoteBody(storyText ?? '');
  if (story.length === 0) return false;
  if (story.includes(key)) return true;
  return longestCommonSubstring(key, story) >= STORY_OVERLAP_LEN;
}

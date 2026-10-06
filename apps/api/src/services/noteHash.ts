import { createHash } from 'node:crypto';
import { normalizeNoteBody } from '@heirloom/shared';

/** 补充内容指纹：归一化后取 sha256 hex，供部分唯一索引兜底重复提交。 */
export function hashNoteBody(body: string): string {
  return createHash('sha256').update(normalizeNoteBody(body), 'utf8').digest('hex');
}

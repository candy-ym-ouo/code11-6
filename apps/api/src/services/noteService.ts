import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { conflict, forbidden, notFound } from '../http/errors';
import { cleanStory, escapeHtml } from '../utils/sanitize';
import { bodySimilarity, normalizeNoteBody, noteBodyHash, SIMILAR_BODY_THRESHOLD } from '../utils/noteText';
import * as audit from './auditService';
import { itemWithAccess, type FamilyContext } from './permissionService';
import { toNoteDto } from '../serializers';
import { appendItemVersion, lockItemForUpdate, toVersionSnapshot } from './itemService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface PossibleDuplicate {
  id: string;
  authorName: string;
  excerpt: string;
}

const AUTHOR_SELECT = { select: { id: true, displayName: true, avatarColor: true } } as const;

export async function listNotes(userId: string, ctx: FamilyContext, itemId: string) {
  await itemWithAccess(userId, ctx, itemId);
  const notes = await prisma.itemNote.findMany({
    where: { itemId },
    include: { author: AUTHOR_SELECT },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  });
  return notes.map(toNoteDto);
}

export async function createNote(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  input: { type: 'story' | 'comment' | 'correction'; body: string },
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  const family = await prisma.family.findUniqueOrThrow({ where: { id: ctx.familyId } });

  const allowed = access.canComment || (ctx.role === 'viewer' && family.allowViewerComment);
  if (!allowed) throw forbidden('你没有权限在这里补充内容');
  if (item.status !== 'published') throw conflict('只有已发布的条目才能补充故事');

  // ---- 重复检测 ----
  const bodyHash = noteBodyHash(input.body);
  const existing = await prisma.itemNote.findMany({
    where: { itemId, status: { in: ['pending', 'accepted'] } },
    include: { author: AUTHOR_SELECT },
  });
  // bodyHash 为 null 的旧数据不参与精确判重，但仍参与下方的近似判重
  const sameHash = existing.filter((n) => n.bodyHash !== null && n.bodyHash === bodyHash);

  // 同一家人重复提交相同内容（双击、网络重试）：幂等返回已提交的那条，不产生重复记录
  const ownPending = sameHash.find((n) => n.status === 'pending' && n.authorId === userId);
  if (ownPending) return { note: toNoteDto(ownPending), created: false, possibleDuplicates: [] as PossibleDuplicate[] };

  const othersPending = sameHash.find((n) => n.status === 'pending');
  if (othersPending) {
    throw conflict(`「${othersPending.author?.displayName ?? '家人'}」已经提交过相同内容，正等家人确认`);
  }
  if (sameHash.some((n) => n.status === 'accepted')) {
    throw conflict('相同内容之前已经被采纳过了');
  }
  // 内容已在正文里（采纳后正文可能被手工整理过，hash 对不上时兜底）
  const normalizedBody = normalizeNoteBody(input.body);
  if (normalizedBody.length > 0 && normalizeNoteBody(item.storyText ?? '').includes(normalizedBody)) {
    throw conflict('正文里已经有这段内容了');
  }

  // ---- 近似重复检测：不阻断，提示提交人与审核人 ----
  const possibleDuplicates: PossibleDuplicate[] = existing
    .filter((n) => n.status === 'pending')
    .map((n) => ({ note: n, score: bodySimilarity(input.body, n.body) }))
    .filter((x) => x.score >= SIMILAR_BODY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => ({
      id: x.note.id,
      authorName: x.note.author?.displayName ?? '家人',
      excerpt: x.note.body.slice(0, 40),
    }));

  // 记录提交时条目的版本，采纳时据此发现「基于旧版正文」的冲突
  const lastVersion = await prisma.itemVersion.findFirst({
    where: { itemId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  let note;
  try {
    note = await prisma.$transaction(async (tx) => {
      const created = await tx.itemNote.create({
        data: {
          itemId,
          authorId: userId,
          type: input.type,
          body: input.body,
          bodyHash,
          baseVersion: lastVersion?.version ?? 0,
        },
        include: { author: AUTHOR_SELECT },
      });
      await audit.record(
        {
          familyId: ctx.familyId,
          actorId: userId,
          action: 'note.create',
          targetType: 'item',
          targetId: itemId,
          diff: { noteId: created.id, type: input.type, bodyHash } as Prisma.InputJsonValue,
          ...meta,
        },
        tx,
      );
      return created;
    });
  } catch (err) {
    // 并发提交撞上 item_notes_pending_dedupe_idx：同一家人幂等返回，不同家人提示已有人提交
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existingNote = await prisma.itemNote.findFirst({
        where: { itemId, bodyHash, status: 'pending' },
        include: { author: AUTHOR_SELECT },
      });
      if (existingNote?.authorId === userId) {
        return { note: toNoteDto(existingNote), created: false, possibleDuplicates: [] as PossibleDuplicate[] };
      }
      if (existingNote) {
        throw conflict(`「${existingNote.author?.displayName ?? '家人'}」已经提交过相同内容，正等家人确认`);
      }
    }
    throw err;
  }
  return { note: toNoteDto(note), created: true, possibleDuplicates };
}

export async function acceptNote(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  noteId: string,
  meta: ActorMeta,
) {
  const { access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canEdit) throw forbidden();

  const note = await prisma.itemNote.findFirst({
    where: { id: noteId, itemId },
    include: { author: AUTHOR_SELECT },
  });
  if (!note) throw notFound('补充内容不存在');

  return prisma.$transaction(async (tx) => {
    // 行锁串行化正文修改：并发采纳/编辑/回滚互斥，后到的基于最新正文合并，不会覆盖已采纳内容
    await lockItemForUpdate(tx, itemId);
    const current = await tx.item.findUniqueOrThrow({ where: { id: itemId } });
    if (current.status === 'trashed') throw conflict('回收站中的条目不能采纳补充，请先恢复');

    // 原子翻转：并发采纳/驳回同一条补充时只有一个能成功
    const decidedAt = new Date();
    const flipped = await tx.itemNote.updateMany({
      where: { id: noteId, status: 'pending' },
      data: { status: 'accepted', decidedBy: userId, decidedAt },
    });
    if (flipped.count === 0) throw conflict('该补充内容已被其他家人处理过了');

    const addition = `<p><strong>${escapeHtml(note.author?.displayName ?? '家人')}：</strong>${escapeHtml(note.body)}</p>`;
    const merged = cleanStory(`${current.storyHtml ?? ''}${addition}`);
    const updatedItem = await tx.item.update({
      where: { id: itemId },
      data: { storyHtml: merged.html, storyText: merged.text || null },
    });
    const version = await appendItemVersion(tx, itemId, toVersionSnapshot(updatedItem), userId, noteId);

    // 冲突检测：写这条补充之后正文又变过（被编辑/回滚/采纳了别的补充）
    const stale = note.baseVersion > 0 && note.baseVersion < version - 1;

    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'note.accept',
        targetType: 'item',
        targetId: itemId,
        diff: {
          noteId,
          noteType: note.type,
          noteAuthorId: note.authorId,
          decision: 'accepted',
          version,
          staleBase: stale,
          bodyHash: note.bodyHash,
        } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    const updatedNote = await tx.itemNote.findUniqueOrThrow({ where: { id: noteId }, include: { author: AUTHOR_SELECT } });
    return { note: toNoteDto(updatedNote), version, stale };
  });
}

export async function rejectNote(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  noteId: string,
  reason: string,
  meta: ActorMeta,
) {
  const { access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canEdit) throw forbidden();
  const note = await prisma.itemNote.findFirst({ where: { id: noteId, itemId } });
  if (!note) throw notFound('补充内容不存在');

  return prisma.$transaction(async (tx) => {
    // 原子翻转：与并发的采纳/驳回互斥，只有先到的决定生效
    const flipped = await tx.itemNote.updateMany({
      where: { id: noteId, status: 'pending' },
      data: { status: 'rejected', rejectReason: reason, decidedBy: userId, decidedAt: new Date() },
    });
    if (flipped.count === 0) throw conflict('该补充内容已被其他家人处理过了');

    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'note.reject',
        targetType: 'item',
        targetId: itemId,
        diff: {
          noteId,
          noteType: note.type,
          noteAuthorId: note.authorId,
          decision: 'rejected',
          reason,
        } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    const updated = await tx.itemNote.findUniqueOrThrow({ where: { id: noteId }, include: { author: AUTHOR_SELECT } });
    return toNoteDto(updated);
  });
}

export async function deleteNote(
  actor: { id: string; role: string },
  ctx: FamilyContext,
  itemId: string,
  noteId: string,
) {
  const note = await prisma.itemNote.findFirst({ where: { id: noteId, itemId } });
  if (!note) throw notFound('补充内容不存在');
  const isAuthor = note.authorId === actor.id;
  const canDeleteAny = actor.role === 'owner' || actor.role === 'admin';
  if (!isAuthor && !canDeleteAny) throw forbidden('只能删除自己写的内容');
  await prisma.itemNote.delete({ where: { id: noteId } });
}

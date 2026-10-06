import { Prisma } from '@prisma/client';
import { findNoteDuplicate, isSimilarNote, normalizeNoteBody, noteAlreadyInStory } from '@heirloom/shared';
import { prisma } from '../db';
import { conflict, forbidden, notFound } from '../http/errors';
import { cleanStory, escapeHtml } from '../utils/sanitize';
import * as audit from './auditService';
import { createItemVersion, lockItem } from './itemService';
import { itemWithAccess, type FamilyContext } from './permissionService';
import { toNoteDto } from '../serializers';
import { hashNoteBody } from './noteHash';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const NOTE_AUTHOR_SELECT = { id: true, displayName: true, avatarColor: true } as const;

export async function listNotes(userId: string, ctx: FamilyContext, itemId: string) {
  await itemWithAccess(userId, ctx, itemId);
  const notes = await prisma.itemNote.findMany({
    where: { itemId },
    include: {
      author: { select: NOTE_AUTHOR_SELECT },
      decider: { select: NOTE_AUTHOR_SELECT },
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  });
  return notes.map(toNoteDto);
}

/** 重复提交的冲突信息：前端据此提示「与谁、哪一条」重复。 */
interface DuplicateDetails {
  reason: 'duplicate_note' | 'already_in_story';
  kind?: 'exact' | 'similar';
  existingNoteId?: string;
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

  // 应用层查重：与所有「未驳回」的补充比较。驳回表示「不要这条」，
  // 之后有家人重新写出同样的内容应当允许。
  const existing = await prisma.itemNote.findMany({
    where: { itemId, status: { not: 'rejected' } },
    select: { id: true, body: true },
    orderBy: { createdAt: 'asc' },
  });
  const dup = findNoteDuplicate(
    input.body,
    existing.map((e) => ({ body: e.body })),
  );
  if (dup) {
    // findNoteDuplicate 只告诉我们命中了哪一类；这里再按同一套归一化定位具体哪一条，
    // 让 409 响应能指出「与哪条补充重复」。
    const key = normalizeNoteBody(input.body);
    const match = existing.find((e) => {
      const other = normalizeNoteBody(e.body);
      return other === key || (dup.kind === 'similar' && isSimilarNote(key, other));
    });
    throw conflict(
      dup.kind === 'exact' ? '已经有家人提交过几乎完全相同的内容，请勿重复提交' : '这条内容与已有的补充高度重合，先看看上面那条吧',
      { reason: 'duplicate_note', kind: dup.kind === 'exact' ? 'exact' : 'similar', existingNoteId: match?.id } satisfies DuplicateDetails,
    );
  }
  if (noteAlreadyInStory(input.body, item.storyText)) {
    throw conflict('你补充的内容已经写在正文里了，不需要再提交一次', {
      reason: 'already_in_story',
    } satisfies DuplicateDetails);
  }

  try {
    const note = await prisma.$transaction(async (tx) => {
      const created = await tx.itemNote.create({
        data: {
          itemId,
          authorId: userId,
          type: input.type,
          body: input.body,
          bodyHash: hashNoteBody(input.body),
        },
        include: { author: { select: NOTE_AUTHOR_SELECT } },
      });
      await audit.record(
        {
          familyId: ctx.familyId,
          actorId: userId,
          action: 'note.create',
          targetType: 'item',
          targetId: itemId,
          diff: { noteId: created.id, type: input.type } as Prisma.InputJsonValue,
          ...meta,
        },
        tx,
      );
      return created;
    });
    return toNoteDto(note);
  } catch (err) {
    // 部分唯一索引兜底：两位家人几乎同时提交相同内容时，后来者在这里被挡住
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('已经有家人提交过几乎完全相同的内容，请勿重复提交', {
        reason: 'duplicate_note',
        kind: 'exact',
      } satisfies DuplicateDetails);
    }
    throw err;
  }
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

  return prisma.$transaction(async (tx) => {
    // 1) 锁住条目行：采纳与采纳之间、采纳与编辑/回滚之间严格串行。
    //    后到的事务拿到的 item 一定包含前一个事务已提交的正文，
    //    合并基于最新正文进行，绝不会覆盖已经采纳的内容。
    await lockItem(tx, itemId);

    // 2) 原子抢占：只允许 pending → accepted，杜绝重复采纳
    //    （两位家人同时点「采纳」、或同一请求重试时只有一个能成功）。
    const claimed = await tx.itemNote.updateMany({
      where: { id: noteId, itemId, status: 'pending' },
      data: { decidedBy: userId, decidedAt: new Date() },
    });
    if (claimed.count === 0) {
      const current = await tx.itemNote.findFirst({ where: { id: noteId, itemId } });
      if (!current) throw notFound('补充内容不存在');
      if (current.status === 'accepted') {
        throw conflict(
          current.versionId ? '该补充内容已被采纳并生成版本，不能重复采纳' : '该补充内容已被采纳',
          { reason: 'already_decided', decision: current.status, versionId: current.versionId },
        );
      }
      throw conflict('该补充内容已被驳回，不能再采纳', {
        reason: 'already_decided',
        decision: current.status,
      });
    }

    const note = await tx.itemNote.findFirstOrThrow({
      where: { id: noteId },
      include: { author: { select: { displayName: true } } },
    });

    // 3) 基于锁内读到的最新正文合并，并做二次查重（提交后可能已被编辑写进正文）。
    const latestItem = await tx.item.findUniqueOrThrow({ where: { id: itemId } });
    if (noteAlreadyInStory(note.body, latestItem.storyText)) {
      // 抛出后整个事务回滚：第 2 步的「抢占」也一并撤销，家人可在正文核对后
      // 自行驳回或保留这条待处理补充，系统不替它悄悄做决定。
      throw conflict('该补充内容已在正文中，未重复并入', {
        reason: 'already_in_story',
      } satisfies DuplicateDetails);
    }

    const addition = `<p><strong>${escapeHtml(note.author.displayName)}：</strong>${escapeHtml(note.body)}</p>`;
    const merged = cleanStory(`${latestItem.storyHtml ?? ''}${addition}`);
    const updatedItem = await tx.item.update({
      where: { id: itemId },
      data: { storyHtml: merged.html, storyText: merged.text || null },
    });

    // 4) 采纳即生成版本，并把决策记录关联到这个版本。
    const version = await createItemVersion(tx, updatedItem, userId, 'note', noteId);
    const updatedNote = await tx.itemNote.update({
      where: { id: noteId },
      data: { status: 'accepted', versionId: version.id },
      include: {
        author: { select: NOTE_AUTHOR_SELECT },
        decider: { select: NOTE_AUTHOR_SELECT },
      },
    });

    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'note.accept',
        targetType: 'item',
        targetId: itemId,
        diff: {
          noteId,
          version: version.version,
          versionId: version.id,
          noteAuthor: note.author.displayName,
          appendedLength: merged.text.length - (latestItem.storyText ?? '').length,
        } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );

    return { note: toNoteDto(updatedNote), version: { id: version.id, version: version.version } };
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

  return prisma.$transaction(async (tx) => {
    // 原子决策：只有 pending 可以被驳回，已采纳的决策不可推翻
    const claimed = await tx.itemNote.updateMany({
      where: { id: noteId, itemId, status: 'pending' },
      data: { status: 'rejected', rejectReason: reason, decidedBy: userId, decidedAt: new Date() },
    });
    if (claimed.count === 0) {
      const current = await tx.itemNote.findFirst({ where: { id: noteId, itemId } });
      if (!current) throw notFound('补充内容不存在');
      throw conflict(
        current.status === 'accepted' ? '该补充内容已被采纳并生成版本，不能再驳回' : '该补充内容已经做出过处理',
        { reason: 'already_decided', decision: current.status },
      );
    }
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'note.reject',
        targetType: 'item',
        targetId: itemId,
        diff: { noteId, reason } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    const result = await tx.itemNote.findFirstOrThrow({
      where: { id: noteId },
      include: {
        author: { select: NOTE_AUTHOR_SELECT },
        decider: { select: NOTE_AUTHOR_SELECT },
      },
    });
    return toNoteDto(result);
  });
}

/** 已采纳的内容是决策记录的一部分，谁都不能删除；其余仅作者本人或管理员可删。 */
export async function deleteNote(
  actor: { id: string; role: string },
  ctx: FamilyContext,
  itemId: string,
  noteId: string,
) {
  const note = await prisma.itemNote.findFirst({ where: { id: noteId, itemId } });
  if (!note) throw notFound('补充内容不存在');
  if (note.status === 'accepted') throw conflict('已采纳的补充已并入正文并生成版本，不能删除');
  const isAuthor = note.authorId === actor.id;
  const canDeleteAny = actor.role === 'owner' || actor.role === 'admin';
  if (!isAuthor && !canDeleteAny) throw forbidden('只能删除自己写的内容');
  await prisma.itemNote.delete({ where: { id: noteId } });
}

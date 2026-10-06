-- 家人补充：重复/冲突检测与决策留痕
-- item_notes.body_hash     归一化正文的 sha256，用于重复提交检测
-- item_notes.base_version  提交补充时条目的最新版本号，用于「基于旧版正文」冲突检测
-- item_versions.note_id    标记该版本由哪条补充的采纳产生

-- AlterTable
ALTER TABLE "item_notes" ADD COLUMN "body_hash" TEXT,
ADD COLUMN "base_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "item_versions" ADD COLUMN "note_id" TEXT;

-- CreateIndex
CREATE INDEX "item_notes_item_id_status_body_hash_idx" ON "item_notes"("item_id", "status", "body_hash");

-- CreateIndex
-- 同一条目下相同内容只允许存在一条待确认补充（不论谁提交的）：
-- 并发提交时由数据库兜底，后到的插入撞唯一约束，应用层转为幂等返回或 409 提示
CREATE UNIQUE INDEX "item_notes_pending_dedupe_idx" ON "item_notes"("item_id", "body_hash")
  WHERE "status" = 'pending' AND "body_hash" IS NOT NULL;

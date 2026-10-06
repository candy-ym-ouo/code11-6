-- 家人补充：重复检测（部分唯一索引）、采纳决策记录、版本溯源。

-- 历史数据回填需要 sha256（contrib 随 PostgreSQL 发行，embedded 发行版同样自带）
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "VersionSource" AS ENUM ('create', 'edit', 'note', 'revert');

-- AlterTable: 补充内容指纹（归一化后 sha256）与决策记录
ALTER TABLE "item_notes" ADD COLUMN "body_hash" TEXT;
ALTER TABLE "item_notes" ADD COLUMN "version_id" TEXT;

-- 历史数据回填：SQL 无法做 NFKC 与全量标点归一化，仅去空白后取 sha256；
-- 与应用层归一化略有差异，但只用于让 NOT NULL 与唯一索引成立，
-- 应用层写入前仍会做一次内容查重。
UPDATE "item_notes"
SET "body_hash" = encode(digest(regexp_replace("body", '\s', '', 'g'), 'sha256'), 'hex');

ALTER TABLE "item_notes" ALTER COLUMN "body_hash" SET NOT NULL;

-- AlterTable: 版本来源
ALTER TABLE "item_versions" ADD COLUMN "source" "VersionSource" NOT NULL DEFAULT 'create';
ALTER TABLE "item_versions" ADD COLUMN "note_id" TEXT;

-- 历史版本无法精确溯源，按审计动作推断
UPDATE "item_versions" v SET "source" = 'note'
WHERE EXISTS (
  SELECT 1 FROM "audit_logs" a
  WHERE a."action" = 'note.accept'
    AND a."target_type" = 'item'
    AND a."target_id" = v."item_id"
    AND abs(extract(epoch from (a."created_at" - v."created_at"))) < 2
);

-- 采纳时先写版本再回写 note，因此版本删除不能连带删除决策记录
ALTER TABLE "item_notes"
  ADD CONSTRAINT "item_notes_version_id_fkey"
  FOREIGN KEY ("version_id") REFERENCES "item_versions"("id") ON DELETE SET NULL;

ALTER TABLE "item_versions"
  ADD CONSTRAINT "item_versions_note_id_fkey"
  FOREIGN KEY ("note_id") REFERENCES "item_notes"("id") ON DELETE SET NULL;

-- CreateIndex
CREATE INDEX "item_notes_body_hash_idx" ON "item_notes"("body_hash");
CREATE INDEX "item_versions_note_id_idx" ON "item_versions"("note_id");

-- 同一条目下，未驳回的补充不得与已有补充在归一化后重复。
-- 驳回表示「不要这条」，之后家人重新提出同样内容应当允许。
CREATE UNIQUE INDEX "item_notes_dup_partial"
  ON "item_notes"("item_id", "body_hash")
  WHERE "status" <> 'rejected';

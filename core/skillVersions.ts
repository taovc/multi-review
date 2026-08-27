import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'

// Skill content is versioned as immutable snapshots (skill_versions). skills.content stays a mirror of the
// current version for the UI; reviews record skill_version_id so a result can be attributed to exact text.

export function skillContentSha(content: string): string {
  return createHash('sha256').update(content || '').digest('hex')
}

// Returns the current version id for a skill row, creating version 1 from its content when none exists yet
// (skills created before versioning, or rows inserted by paths that forgot to version).
export function ensureSkillVersion(db: any, schema: any, skill: { id: string; name?: string | null; content: string; source?: string | null; currentVersionId?: string | null; createdAt?: string }): string {
  if (skill.currentVersionId) return skill.currentVersionId
  const latest = db.select().from(schema.skillVersions).where(eq(schema.skillVersions.skillId, skill.id)).orderBy(desc(schema.skillVersions.version)).get()
  if (latest) {
    db.update(schema.skills).set({ currentVersionId: latest.id }).where(eq(schema.skills.id, skill.id)).run()
    return latest.id as string
  }
  const id = nanoid()
  db.insert(schema.skillVersions).values({
    id, skillId: skill.id, skillName: skill.name ?? null, version: 1, content: skill.content || '', contentSha: skillContentSha(skill.content || ''),
    source: skill.source || 'manual', createdAt: skill.createdAt || new Date().toISOString(),
  }).run()
  db.update(schema.skills).set({ currentVersionId: id }).where(eq(schema.skills.id, skill.id)).run()
  return id
}

// Record new content for a skill: inserts the next version (unless the content is byte-identical to the
// current one), mirrors it into skills.content and points current_version_id at it.
export function addSkillVersion(db: any, schema: any, skillId: string, content: string, source: string = 'manual'): { id: string; version: number; unchanged: boolean } {
  const skill = db.select().from(schema.skills).where(eq(schema.skills.id, skillId)).get()
  if (!skill) throw new Error('skill not found')
  const currentId = ensureSkillVersion(db, schema, skill)
  const current = db.select().from(schema.skillVersions).where(eq(schema.skillVersions.id, currentId)).get()
  const sha = skillContentSha(content)
  if (current && current.contentSha === sha) {
    if (skill.content !== content) db.update(schema.skills).set({ content }).where(eq(schema.skills.id, skillId)).run()
    return { id: current.id, version: current.version, unchanged: true }
  }
  const latest = db.select().from(schema.skillVersions).where(eq(schema.skillVersions.skillId, skillId)).orderBy(desc(schema.skillVersions.version)).get()
  const version = (latest?.version ?? 0) + 1
  const id = nanoid()
  db.insert(schema.skillVersions).values({ id, skillId, skillName: skill.name ?? null, version, content, contentSha: sha, source, createdAt: new Date().toISOString() }).run()
  db.update(schema.skills).set({ content, currentVersionId: id }).where(eq(schema.skills.id, skillId)).run()
  return { id, version, unchanged: false }
}

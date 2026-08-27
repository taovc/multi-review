import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { addSkillVersion, ensureSkillVersion, skillContentSha } from '../core/skillVersions'

const d = getDb(':memory:')
const now = new Date().toISOString()
d.insert(schema.projects).values({ id: 'P', name: 'p', slug: 'p', repo: 'o/r', defaultBranch: 'main', createdAt: now }).run()
d.insert(schema.skills).values({ id: 'S1', projectId: 'P', name: 'skill', content: 'v1 text', source: 'manual', createdAt: now }).run()

// A pre-versioning skill gets version 1 lazily, and the link is stable across calls.
const v1 = ensureSkillVersion(d, schema, d.select().from(schema.skills).where(eq(schema.skills.id, 'S1')).get()!)
assert.equal(ensureSkillVersion(d, schema, d.select().from(schema.skills).where(eq(schema.skills.id, 'S1')).get()!), v1)
let versions = d.select().from(schema.skillVersions).where(eq(schema.skillVersions.skillId, 'S1')).all()
assert.equal(versions.length, 1)
assert.equal(versions[0]!.version, 1)
assert.equal(versions[0]!.contentSha, skillContentSha('v1 text'))

// Identical content → no new version, but skills.content is mirrored.
const same = addSkillVersion(d, schema, 'S1', 'v1 text', 'manual')
assert.equal(same.unchanged, true)
assert.equal(same.version, 1)

// New content → version 2 becomes current; version 1 text is preserved untouched.
const v2 = addSkillVersion(d, schema, 'S1', 'v2 text', 'optimized')
assert.equal(v2.version, 2)
assert.equal(v2.unchanged, false)
const skill = d.select().from(schema.skills).where(eq(schema.skills.id, 'S1')).get()!
assert.equal(skill.content, 'v2 text')
assert.equal(skill.currentVersionId, v2.id)
versions = d.select().from(schema.skillVersions).where(eq(schema.skillVersions.skillId, 'S1')).all()
assert.equal(versions.length, 2)
assert.equal(versions.find((v) => v.version === 1)!.content, 'v1 text', 'old version text is immutable')
assert.equal(versions.find((v) => v.version === 2)!.source, 'optimized')

// Deleting the skill keeps its versions (past reviews stay attributable) and the name snapshot survives.
d.delete(schema.skills).where(eq(schema.skills.id, 'S1')).run()
const survivors = d.select().from(schema.skillVersions).where(eq(schema.skillVersions.skillId, 'S1')).all()
assert.equal(survivors.length, 2)
assert.equal(survivors[0]!.skillName, 'skill')
console.log('skill-versions: all ok')

import { and, eq } from 'drizzle-orm'

// Pending prompts of a run as the UI consumes them (input JSON decoded). Shared by the session detail endpoints.
export function pendingPromptsFor(db: any, schema: any, runId: string) {
  return db.select().from(schema.permissionRequests)
    .where(and(eq(schema.permissionRequests.runId, runId), eq(schema.permissionRequests.status, 'pending'))).all()
    .map((p: any) => ({ id: p.id, kind: p.kind, toolName: p.toolName, input: p.input ? JSON.parse(p.input) : null, suggestions: !!p.suggestions, title: p.title, description: p.description, createdAt: p.createdAt }))
}

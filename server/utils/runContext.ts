import { eq } from 'drizzle-orm'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { resolveLang } from '~core/agent/lang'
import { getAgentSettings } from '~core/agent/settings'
import type { SessionTurnCtx } from '~core/runs/session'
import { resolveGlobalAgentDefaults } from './globalAgentConfig'

// Build the turn context of a session run: provider/model/effort defaults (the project's review config for worktree
// runs, the runtime/project defaults for cwd runs), paths from the runtime config, the UI locale.
export function buildSessionTurnCtx(event: any, run: any, o: { message: string; permissionMode?: SessionTurnCtx['permissionMode']; allowDanger?: boolean; ultracode?: boolean; projectId?: string | null; lang?: string | null }): SessionTurnCtx {
  const d = db()
  const cfg = useRuntimeConfig()
  const projectRow = run.projectId ? d.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)).get() : null
  let defaults: SessionTurnCtx['defaults']
  if (projectRow && run.workspaceType !== 'cwd') {
    const rc = resolveReviewConfig(d, projectRow)
    defaults = { provider: rc.provider, model: rc.model, effort: rc.effort || undefined, codexServiceTier: rc.codexServiceTier, translateModel: rc.translateModel }
  } else {
    const g = resolveGlobalAgentDefaults(d, cfg, o.projectId ?? run.projectId ?? null)
    defaults = { provider: g.provider, model: g.model, effort: g.effort, codexServiceTier: g.codexServiceTier ?? null }
  }
  return {
    db: d, schema, runId: run.id, message: o.message, defaults,
    project: projectRow ? { id: projectRow.id, repo: projectRow.repo, localPath: projectRow.localPath, defaultBranch: projectRow.defaultBranch } : null,
    reposDir: cfg.reposDir as string, worktreeLocation: cfg.worktreeLocation as string,
    assetsDir: resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets'),
    lang: resolveLang(o.lang ?? run.lang ?? getCookie(event, 'mr-locale')),
    permissionMode: o.permissionMode, allowDanger: !!o.allowDanger, ultracode: !!o.ultracode,
    chrome: getAgentSettings(d, schema).chrome, // every Claude session may start Claude in Chrome (the Codex host ignores it)
  }
}

export function getRunOr404(id: string) {
  const run = db().select().from(schema.runs).where(eq(schema.runs.id, id)).get()
  if (!run || run.kind !== 'session') throw createError({ statusCode: 404, statusMessage: 'session 不存在' })
  return run
}

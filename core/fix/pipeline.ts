import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reviewQueue } from '../queue'
import { cockpitBus } from '../events'
import { prepareWorktree, removeWorktree, type Worktree } from '../git/worktree'
import { fetchTimeline, fetchReviewComments, fetchPrDiff } from '../github/gh'
import { buildFixBrief } from './brief'
import { runFixAgent, type FixSteps } from '../agent/fixer'
import { startDevServer, type DevServer } from './devserver'

const pexec = promisify(execFile)

// db/schema 由调用方注入（core 不直接依赖运行时 db），同 ReviewJobCtx 的约定。
export type FixJobCtx = {
  db: any
  schema: any
  fixId: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  localPath: string
  reposDir: string
  model: string
  steps: FixSteps
}

export function enqueueFix(ctx: FixJobCtx) {
  reviewQueue.add(() => runFixJob(ctx))
}

async function runFixJob(ctx: FixJobCtx) {
  const { db, schema, fixId, steps } = ctx
  const now = () => new Date().toISOString()

  // 事件只走实时总线（不落库；events 表 FK 到 reviews，且 fix 日志本就临时）
  const emit = (kind: string, message?: string) => {
    cockpitBus.emit({ reviewId: fixId, ts: now(), kind, message })
  }
  const setStatus = (status: string, extra: Record<string, unknown> = {}) => {
    db.update(schema.fixes).set({ status, updatedAt: now(), ...extra }).where(eq(schema.fixes.id, fixId)).run()
    cockpitBus.emit({ reviewId: fixId, ts: now(), kind: 'status', message: status })
  }
  const setStage = (stage: string) => {
    db.update(schema.fixes).set({ stage, updatedAt: now() }).where(eq(schema.fixes.id, fixId)).run()
    emit('stage', stage)
  }
  const fixRow = () => db.select().from(schema.fixes).where(eq(schema.fixes.id, fixId)).get()
  const gone = () => {
    const r = fixRow()
    return !r || r.status === 'discarded'
  }

  const sh = (args: string[]) => pexec('git', ['-C', wt!.path, ...args], { maxBuffer: 64 * 1024 * 1024 })
  let wt: Worktree | null = null
  let dev: DevServer | null = null
  let costUsd = 0
  let testsResult: string | null = null

  try {
    setStatus('running')

    // 1) 收集评论 → brief
    setStage('Lecture des commentaires de la PR')
    const [timeline, reviewComments, diff] = await Promise.all([
      fetchTimeline(ctx.repo, ctx.prNumber).catch(() => []),
      fetchReviewComments(ctx.repo, ctx.prNumber).catch(() => []),
      fetchPrDiff(ctx.repo, ctx.prNumber).then((d) => d.diff).catch(() => ''),
    ])
    const brief = buildFixBrief({ prNumber: ctx.prNumber, timeline, reviewComments, diff })

    // 2) worktree SANS merge de la branche par défaut (push propre)
    setStage('Préparation du worktree')
    wt = await prepareWorktree({
      localPath: ctx.localPath,
      reposDir: ctx.reposDir,
      reviewId: fixId,
      branch: ctx.branch,
      defaultBranch: ctx.defaultBranch,
      mergeDefault: false,
      onStep: (m) => emit('stage', m),
    })
    db.update(schema.fixes).set({ worktreePath: wt.path, baseHeadSha: wt.headSha, updatedAt: now() }).where(eq(schema.fixes.id, fixId)).run()
    if (gone()) {
      if (wt) await removeWorktree(ctx.localPath, ctx.reposDir, fixId)
      return
    }

    // 3) deps (tests / testsUI en ont besoin) — install paresseux
    let installed = false
    const ensureInstall = async () => {
      if (installed) return
      setStage('Installation des dépendances (pnpm install)')
      await pexec('pnpm', ['install'], { cwd: wt!.path, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 })
      installed = true
    }

    // 4) dev server pour Tests UI (best-effort : stakimo-app peut ne pas démarrer headless)
    let devUrl: string | undefined
    let mcpConfigPath: string | undefined
    if (steps.testsUI) {
      try {
        await ensureInstall()
        setStage('Démarrage du dev server (validation UI)')
        const port = 4100 + (ctx.prNumber % 800)
        dev = await startDevServer({ cwd: wt.path, port, onLog: (m) => emit('tool', `dev ${m}`) })
        devUrl = dev.url
        mcpConfigPath = writeMcpConfig(ctx.reposDir)
      } catch (e) {
        emit('stage', `Validation UI ignorée : ${(e as Error).message}`)
        devUrl = undefined
        mcpConfigPath = undefined
      }
    }

    // 5) agent : corrige + simplify inline (+ valide UI via MCP si dispo)
    if (steps.fix || steps.simplify || (steps.testsUI && devUrl)) {
      setStage('Correction par l’agent')
      const r = await runFixAgent({
        cwd: wt.path,
        brief,
        steps,
        model: ctx.model,
        devUrl,
        mcpConfigPath,
        onTool: (n, i) => emit('tool', `${n} ${i}`),
        onText: (t) => emit('text', t.slice(0, 200)),
      })
      costUsd = r.costUsd
    }
    if (dev) {
      dev.stop()
      dev = null
    }
    if (gone()) {
      if (wt) await removeWorktree(ctx.localPath, ctx.reposDir, fixId)
      return
    }

    // 6) tests de non-régression (Node)
    if (steps.tests) {
      await ensureInstall()
      setStage('Tests (pnpm test)')
      try {
        await pexec('pnpm', ['test'], { cwd: wt.path, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 })
        testsResult = 'passed'
        emit('stage', 'Tests OK')
      } catch (e: any) {
        testsResult = `failed: ${String(e?.stderr || e?.stdout || e?.message || '').slice(0, 400)}`
        emit('stage', 'Tests en échec')
      }
    }

    // 7) commit local (Node ; l’agent n’a pas le droit git)
    setStage('Commit local')
    await sh(['add', '-A'])
    const dirty = (await sh(['status', '--porcelain'])).stdout.trim()
    if (!dirty) {
      setStatus('ready', { stage: 'Aucun changement produit', fixHeadSha: wt.headSha, filesChanged: 0, additions: 0, deletions: 0, costUsd, testsResult })
      emit('done', 'Aucun changement produit')
      await wt.cleanup() // rien à pousser → on nettoie
      return
    }
    await sh(['commit', '-m', `fix: address review comments (PR #${ctx.prNumber})`])
    const fixHeadSha = (await sh(['rev-parse', 'HEAD'])).stdout.trim()
    const numstat = (await sh(['diff', '--numstat', `${wt.headSha}..HEAD`])).stdout.trim()
    let additions = 0, deletions = 0, filesChanged = 0
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [a, d] = line.split('\t')
      filesChanged++
      additions += Number(a) || 0
      deletions += Number(d) || 0
    }
    setStatus('ready', { stage: 'Prêt à pousser', fixHeadSha, filesChanged, additions, deletions, costUsd, testsResult })
    emit('done', `Prêt · ${filesChanged} fichier(s) · $${costUsd.toFixed(3)}`)
    // NE PAS cleanup : worktree gardé jusqu’au push/discard
  } catch (e) {
    setStatus('error', { error: (e as Error).message })
    emit('error', (e as Error).message)
    if (wt) await removeWorktree(ctx.localPath, ctx.reposDir, fixId)
  } finally {
    dev?.stop()
  }
}

// Config MCP chrome-devtools pour la validation UI (commande configurable via env).
function writeMcpConfig(dir: string): string {
  const raw = process.env.CHROME_DEVTOOLS_MCP_CMD || 'npx -y chrome-devtools-mcp@latest'
  const [command, ...args] = raw.split(' ')
  const cfg = { mcpServers: { 'chrome-devtools': { command, args } } }
  const p = join(dir, `mcp-${nanoid()}.json`)
  writeFileSync(p, JSON.stringify(cfg))
  return p
}

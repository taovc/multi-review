// Types UI partagés par FixModal / FixDrawer (sans dépendre d'un module core côté client).
export type FixSteps = { fix: boolean; simplify: boolean; tests: boolean; testsUI: boolean }

export type Fix = {
  id: string
  projectId: string
  prNumber: number
  branch: string
  status: 'queued' | 'running' | 'ready' | 'pushing' | 'pushed' | 'error' | 'discarded'
  stage: string | null
  filesChanged: number | null
  additions: number | null
  deletions: number | null
  testsResult: string | null
  costUsd: number | null
  error: string | null
}

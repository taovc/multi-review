import { getDb } from '~core/db/client'

// Get the singleton db using the dbPath from the runtime config
export function db() {
  const cfg = useRuntimeConfig()
  return getDb(cfg.dbPath as string)
}

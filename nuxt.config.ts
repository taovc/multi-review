import { fileURLToPath } from 'node:url'

const coreDir = fileURLToPath(new URL('./core', import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxtjs/i18n'],
  css: ['~~/assets/css/main.css'],
  ssr: true,
  // 跟随系统偏好，支持手动切换（持久化）；极简单色风
  colorMode: { preference: 'system', fallback: 'light', storageKey: 'mr-color-mode' },
  // 三语：中文（原始） + 法语 + 英语。无 URL 前缀（内部工具），按浏览器语言自动选择并持久化
  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'fr',
    langDir: 'locales',
    lazy: true,
    locales: [
      { code: 'fr', name: 'Français', language: 'fr-FR', file: 'fr.json' },
      { code: 'en', name: 'English', language: 'en-US', file: 'en.json' },
      { code: 'zh', name: '中文', language: 'zh-CN', file: 'zh.json' },
    ],
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'mr-locale',
      redirectOn: 'root',
      fallbackLocale: 'fr',
    },
    bundle: { optimizeTranslationDirective: false },
    // 部分提示文案含 <b>/<br> 等内联标签（由我们维护的静态文案，模板里用 v-html 渲染）
    compilation: { strictMessage: false },
  },
  typescript: { strict: true },
  alias: { '~core': coreDir },
  runtimeConfig: {
    // agent / inference
    inferenceProvider: process.env.INFERENCE_PROVIDER || 'claude',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'sonnet',
    codexModel: process.env.CODEX_MODEL || '',
    recheckModel: process.env.RECHECK_MODEL || process.env.ANTHROPIC_MODEL || 'sonnet',
    // 发评论时把中文翻成英文——机械活，用快模型，不跟审核的重模型/effort 走
    translateModel: process.env.TRANSLATE_MODEL || 'sonnet',
    // 助手(global)默认 effort：它不属于任何 project，读不到 project.effort，用这个中心默认兜底（按会话可覆盖）
    globalEffort: process.env.GLOBAL_EFFORT || 'high',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    // github (defaults to local `gh` CLI auth; token optional)
    githubToken: process.env.GITHUB_TOKEN || '',
    defaultRepo: process.env.DEFAULT_REPO || '',
    // local infra
    dbPath: process.env.DB_PATH || './data/cockpit.db',
    reposDir: process.env.REPOS_DIR || './data/worktrees',
    maxConcurrency: Number(process.env.MAX_CONCURRENCY || 3),
    // PR 自动化引擎（自动审核 / 自动修复的常驻轮询）。AUTOMATION_ENABLED=false 整体关停。
    automationEnabled: process.env.AUTOMATION_ENABLED !== 'false',
    automationIntervalMs: Number(process.env.AUTOMATION_INTERVAL_MS || 45000),
    // 引擎由定时器驱动、没有发起请求的用户上下文，故无法从 cookie 取 locale；用这个中心默认决定自动审核/修复的工作语言。
    automationLang: process.env.AUTOMATION_LANG || 'zh',
    public: {
      appName: 'Multi Review',
    },
  },
  nitro: {
    // Electron 打包：用 node-server 产物（.output/server/index.mjs），由主进程 spawn
    preset: process.env.NITRO_PRESET || 'node-server',
    alias: { '~core': coreDir },
    experimental: { asyncContext: true },
  },
  vite: {
    optimizeDeps: { exclude: ['better-sqlite3'] },
  },
})

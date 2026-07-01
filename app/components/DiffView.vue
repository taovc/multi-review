<script setup lang="ts">
// GitHub 式 split diff：unified diff → 左旧 / 右新 两列对比。
// 不做字符级 diff，按行配对（一段连续 del 和 add 逐行配对，多出的单边留空）——和 GitHub split 同思路。
const props = defineProps<{ diff: string; truncated?: boolean }>()

type Side = 'ctx' | 'del' | 'add' | 'empty'
type Row =
  | { hunk: true; text: string }
  | { hunk?: false; lo: number | null; lt: string; ltype: Side; ro: number | null; rt: string; rtype: Side }
type FileDiff = { path: string; rows: Row[] }

const files = computed<FileDiff[]>(() => parse(props.diff || ''))

function parse(diff: string): FileDiff[] {
  const out: FileDiff[] = []
  let cur: FileDiff | null = null
  let oldLn = 0
  let newLn = 0
  let dels: string[] = []
  let adds: string[] = []

  // 把累积的 del/add 段配对成行（del 在左、add 在右，逐行配；多出的单边留空）
  const flush = () => {
    if (!cur) { dels = []; adds = []; return }
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) {
      const d = i < dels.length ? dels[i]! : null
      const a = i < adds.length ? adds[i]! : null
      cur.rows.push({
        lo: d != null ? oldLn++ : null, lt: d ?? '', ltype: d != null ? 'del' : 'empty',
        ro: a != null ? newLn++ : null, rt: a ?? '', rtype: a != null ? 'add' : 'empty',
      })
    }
    dels = []
    adds = []
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      flush()
      const m = line.match(/ b\/(.+)$/)
      cur = { path: m ? m[1]! : line.replace('diff --git ', ''), rows: [] }
      out.push(cur)
      oldLn = 0; newLn = 0
      continue
    }
    if (!cur) continue
    // 文件元信息行跳过
    if (/^(\+\+\+|---|index |new file|deleted file|rename |similarity |old mode|new mode|Binary )/.test(line) || line.startsWith('\\')) continue
    if (line.startsWith('@@')) {
      flush()
      const m = line.match(/-(\d+)(?:,\d+)?\s+\+(\d+)/)
      oldLn = m ? Number(m[1]) : 0
      newLn = m ? Number(m[2]) : 0
      cur.rows.push({ hunk: true, text: line })
      continue
    }
    if (line.startsWith('+')) { adds.push(line.slice(1)); continue }
    if (line.startsWith('-')) { dels.push(line.slice(1)); continue }
    // 上下文行（以空格开头，或空行）
    flush()
    const text = line.startsWith(' ') ? line.slice(1) : line
    cur.rows.push({ lo: oldLn++, lt: text, ltype: 'ctx', ro: newLn++, rt: text, rtype: 'ctx' })
  }
  flush()
  return out
}

// 单元格底色
const BG: Record<Side, string> = {
  ctx: '',
  del: 'bg-error/10',
  add: 'bg-success/10',
  empty: 'bg-elevated/40',
}
</script>

<template>
  <div class="text-xs font-mono">
    <div v-for="f in files" :key="f.path" class="mb-4 border border-default rounded overflow-hidden">
      <div class="bg-elevated px-3 py-1.5 text-toned font-sans text-[11px] border-b border-default sticky top-0">{{ f.path }}</div>
      <div v-for="(r, i) in f.rows" :key="i">
        <!-- hunk 头：整行横跨 -->
        <div v-if="r.hunk" class="text-dimmed bg-elevated/50 px-3 py-0.5 whitespace-pre-wrap break-all">{{ r.text }}</div>
        <!-- 普通行 -->
        <div v-else class="border-t border-default/40">
          <!-- 桌面(md+)：GitHub 式 split，左旧 / 右新 两列 -->
          <div class="hidden md:grid grid-cols-[2.5rem_1fr_2.5rem_1fr]">
            <div class="text-right pr-1.5 text-dimmed select-none tabular-nums" :class="BG[r.ltype]">{{ r.lo ?? '' }}</div>
            <div class="px-2 whitespace-pre-wrap break-all" :class="[BG[r.ltype], r.ltype === 'del' ? 'text-error' : 'text-toned']">{{ r.lt }}</div>
            <div class="text-right pr-1.5 text-dimmed select-none tabular-nums border-l border-default/40" :class="BG[r.rtype]">{{ r.ro ?? '' }}</div>
            <div class="px-2 whitespace-pre-wrap break-all" :class="[BG[r.rtype], r.rtype === 'add' ? 'text-success' : 'text-toned']">{{ r.rt }}</div>
          </div>
          <!-- 手机：unified 单列，避免两列代码各挤半屏。ctx 只显一次(左)，del/add 各成一行 -->
          <div class="md:hidden">
            <div v-if="r.ltype !== 'empty'" class="grid grid-cols-[2.5rem_1fr]" :class="BG[r.ltype]">
              <div class="text-right pr-1.5 text-dimmed select-none tabular-nums">{{ r.lo ?? '' }}</div>
              <div class="px-2 whitespace-pre-wrap break-all" :class="r.ltype === 'del' ? 'text-error' : 'text-toned'">{{ r.lt }}</div>
            </div>
            <div v-if="r.rtype === 'add'" class="grid grid-cols-[2.5rem_1fr] bg-success/10">
              <div class="text-right pr-1.5 text-dimmed select-none tabular-nums">{{ r.ro ?? '' }}</div>
              <div class="px-2 whitespace-pre-wrap break-all text-success">{{ r.rt }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <p v-if="truncated" class="text-dimmed text-xs mt-2">{{ $t('prDrawer.diffTruncated') }}</p>
    <p v-if="!files.length" class="text-dimmed text-sm py-4">{{ $t('fix.noDiff') }}</p>
  </div>
</template>

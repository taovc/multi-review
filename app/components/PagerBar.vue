<script setup lang="ts">
// Shared pager footer: "N total · page x / y" on the left, Nuxt UI pagination on the right (only when there is more
// than one page). `page` is 1-based, like UPagination.
const props = defineProps<{ total: number; perPage: number; page: number; disabled?: boolean }>()
const emit = defineEmits<{ 'update:page': [page: number] }>()
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.perPage)))
</script>

<template>
  <div v-if="total" class="flex items-center justify-between gap-3 mt-3 text-xs text-dimmed">
    <span>{{ $t('project.pagination.summaryPages', { total, page: Math.min(page, pageCount), pages: pageCount }) }}</span>
    <UPagination
      v-if="pageCount > 1"
      :page="Math.min(page, pageCount)" :total="total" :items-per-page="perPage" :sibling-count="1" :disabled="disabled"
      size="xs" color="neutral" variant="ghost" active-variant="outline"
      @update:page="(p: number) => emit('update:page', p)"
    />
  </div>
</template>

// Minimal monochrome: use neutral (black/grey) as the primary color, not the default green primary
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'neutral',
      neutral: 'neutral',
    },
  },
})

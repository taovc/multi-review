// Minimal monochrome: neutral (black/grey) as the primary color instead of the default green; the grey ramp is
// Tailwind `gray` (a faint cool cast) — plain `neutral` read as dull, `slate` as blue.
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'neutral',
      neutral: 'gray',
    },
  },
})

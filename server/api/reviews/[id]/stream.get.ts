// SSE: pushes a review's progress events live (stage / tool / status / done / error). The channel is the bare reviewId.
// createSseHandler is auto-imported by Nitro from server/utils.
export default createSseHandler((id) => id)

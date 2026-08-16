// SSE: live progress of a fix task (stage / tool / text / status / done / error). Channel = the bare fixId.
export default createSseHandler((id) => id)

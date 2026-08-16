import { globalChan } from '~core/global/pipeline'

// SSE: live progress for a global session (chat/tool/text/done/error). Channel = g:<sessionId>.
export default createSseHandler(globalChan)

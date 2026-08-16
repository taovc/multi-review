import { featureChan } from '~core/feature/pipeline'

// SSE: live progress of a feature task (stage/tool/text/chat/error). Channel = f:<taskId>.
export default createSseHandler(featureChan)

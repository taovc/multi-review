import { runChannel } from '~core/host/recorder'

// SSE: live progress of a fix task (stage / tool / text / status / done / error) plus the session host's RunEvents. Channel = run:<fixId>.
export default createSseHandler(runChannel)

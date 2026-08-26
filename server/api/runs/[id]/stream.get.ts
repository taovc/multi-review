import { runChannel } from '~core/host/recorder'

// SSE: the normalized RunEvent stream of one run (channel run:<id>). Payload = { kind: 'run', data: RunEvent, ts, message }.
export default createSseHandler(runChannel)

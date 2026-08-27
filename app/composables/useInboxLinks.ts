// Cross-page hand-offs: the inbox asks the global chat drawer to open a given session.
export const useOpenGlobalSession = () => useState<string | null>('globalChat.openSession', () => null)

// Minimal declaration: qrcode 1.5.x ships no types of its own and we only use toDataURL.
declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    margin?: number
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    color?: { dark?: string; light?: string }
  }
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>
  const _default: { toDataURL: typeof toDataURL }
  export default _default
}

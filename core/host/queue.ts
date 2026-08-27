// Push-based async iterable: the SDK's streaming-input mode consumes it; the host pushes user messages in.
export class PushQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: Array<(r: IteratorResult<T>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as unknown as T, done: true })
  }

  get isClosed(): boolean { return this.closed }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
      return: (): Promise<IteratorResult<T>> => { this.close(); return Promise.resolve({ value: undefined as unknown as T, done: true }) },
    }
  }
}

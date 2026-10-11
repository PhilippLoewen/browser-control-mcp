/**
 * Runs tab structure writes one at a time.
 *
 * Tree Style Tab acknowledges a command before it has finished re-arranging
 * the tree, and the extension handles server messages concurrently. Without
 * serialization, a write could start while the previous one is still being
 * applied and act on a stale tree. One lock is shared by the message
 * handlers of all configured ports.
 */
export class WriteLock {
  private tail: Promise<void> = Promise.resolve();

  /** Run the given write after all previously started writes have settled. */
  public run<T>(write: () => Promise<T>): Promise<T> {
    const result = this.tail.then(write);
    // A failed write must not block the writes queued after it.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Resolves once all writes started so far have settled. */
  public idle(): Promise<void> {
    return this.tail;
  }
}

/** Exclusive named locks shared by page and worker test contexts. */
export class MemoryLocks {
  private pending = new Map<string, Promise<void>>();
  private held = new Set<string>();

  isHeld(name: string): boolean {
    return this.held.has(name);
  }

  request<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(name) ?? Promise.resolve();
    const next = previous.then(async () => {
      this.held.add(name);
      try {
        return await work();
      } finally {
        this.held.delete(name);
      }
    });
    const tail = next.then(() => {}, () => {});
    this.pending.set(name, tail);
    void tail.then(() => {
      if (this.pending.get(name) === tail) this.pending.delete(name);
    });
    return next;
  }
}

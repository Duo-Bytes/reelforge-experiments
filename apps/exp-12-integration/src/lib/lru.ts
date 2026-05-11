/**
 * Tiny LRU using insertion order of Map. get() bumps the entry to the end so
 * the oldest key is always Map.keys().next().value.
 */
export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    private capacity: number,
    private readonly onEvict: (key: K, value: V) => void,
  ) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      const oldestValue = this.map.get(oldest) as V;
      this.map.delete(oldest);
      this.onEvict(oldest, oldestValue);
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    for (const [k, v] of this.map) this.onEvict(k, v);
    this.map.clear();
  }

  resize(newCapacity: number): void {
    this.capacity = newCapacity;
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      const oldestValue = this.map.get(oldest) as V;
      this.map.delete(oldest);
      this.onEvict(oldest, oldestValue);
    }
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}

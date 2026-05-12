/**
 * Order-preserving LRU cache built on top of a Map. The most recently used
 * entry is at the tail; the least recently used is at the head. set() bumps
 * existing entries to the tail.
 */
export class LRUCache<K, V> {
  private map = new Map<K, V>()

  constructor(
    public capacity: number,
    private onEvict: (key: K, value: V) => void,
  ) {}

  get size() { return this.map.size }
  has(key: K) { return this.map.has(key) }
  keys() { return Array.from(this.map.keys()) }

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    // bump to tail
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key: K, value: V) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldestKey = this.map.keys().next().value as K
      const oldestVal = this.map.get(oldestKey)!
      this.map.delete(oldestKey)
      this.onEvict(oldestKey, oldestVal)
    }
  }

  delete(key: K) {
    const v = this.map.get(key)
    if (v === undefined) return false
    this.map.delete(key)
    this.onEvict(key, v)
    return true
  }

  clear() {
    for (const [k, v] of this.map) this.onEvict(k, v)
    this.map.clear()
  }
}

/**
 * Typed pub/sub event bus for cross-page communication.
 * No framework dependencies — pure TypeScript.
 */

type Handler<T = unknown> = (data: T) => void;

interface EventBusMap {
  // Navigation
  "route:changed": { path: string; params: Record<string, string> };

  // Sessions
  "session:started": { sessionId: string };
  "session:ended": { sessionId: string };
  "sessions:refreshed": { count: number };

  // Devices
  "device:updated": { deviceId: string };
  "devices:refreshed": { count: number };

  // Stats
  "stats:updated": Record<string, unknown>;

  // UI
  "sidebar:toggle": { collapsed: boolean };
}

class EventBus {
  private listeners = new Map<string, Set<Handler>>();

  on<K extends keyof EventBusMap>(event: K, handler: Handler<EventBusMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const set = this.listeners.get(event)!;
    set.add(handler as Handler);
    return () => set.delete(handler as Handler);
  }

  once<K extends keyof EventBusMap>(event: K, handler: Handler<EventBusMap[K]>): () => void {
    const unsub = this.on(event, (data) => {
      unsub();
      handler(data);
    });
    return unsub;
  }

  emit<K extends keyof EventBusMap>(event: K, data: EventBusMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[bus] error in handler for "${event}":`, err);
      }
    }
  }

  off<K extends keyof EventBusMap>(event: K, handler?: Handler<EventBusMap[K]>): void {
    if (!handler) {
      this.listeners.delete(event);
      return;
    }
    this.listeners.get(event)?.delete(handler as Handler);
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const bus = new EventBus();
export type { EventBus };

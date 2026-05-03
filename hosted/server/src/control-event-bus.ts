/**
 * ControlEventBus — pub/sub for gesture/control events
 *
 * Mirrors the AudioTapBus pattern: callback + AsyncIterable subscription.
 * Subscribers receive ControlEvent objects from iOS publisher gestures.
 */

import type { ControlEvent } from "./app-types.js";

interface EventSubscriber {
  id: string;
  queue: ControlEvent[];
  waiting: ((event: ControlEvent | null) => void) | null;
  closed: boolean;
}

const MAX_EVENT_QUEUE_SIZE = 500;

export class ControlEventBus {
  private subscribers = new Map<string, EventSubscriber>();
  private callbacks = new Map<string, (event: ControlEvent) => void>();

  /**
   * Subscribe with a callback — synchronous dispatch.
   * Returns unsubscribe function.
   */
  onEvent(callback: (event: ControlEvent) => void): () => void {
    const id = crypto.randomUUID();
    this.callbacks.set(id, callback);
    return () => { this.callbacks.delete(id); };
  }

  /**
   * Subscribe with AsyncIterable — for pipeline stages that consume events.
   */
  subscribe(): { id: string; stream: AsyncIterable<ControlEvent> } {
    const id = crypto.randomUUID();
    const sub: EventSubscriber = { id, queue: [], waiting: null, closed: false };
    this.subscribers.set(id, sub);

    const stream: AsyncIterable<ControlEvent> & AsyncIterator<ControlEvent> = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (sub.queue.length > 0) {
          const value = sub.queue.shift()!;
          return { value, done: false };
        }
        if (sub.closed) {
          return { value: undefined as any, done: true as const };
        }
        return new Promise<{ value: ControlEvent; done: false } | { value: undefined; done: true }>((resolve) => {
          sub.waiting = (event) => {
            if (event === null) {
              resolve({ value: undefined as any, done: true as const });
            } else {
              resolve({ value: event, done: false });
            }
          };
        });
      },
      async return() {
        return { value: undefined as any, done: true as const };
      },
    };

    return { id, stream };
  }

  unsubscribe(id: string) {
    const sub = this.subscribers.get(id);
    if (sub) {
      sub.closed = true;
      if (sub.waiting) {
        sub.waiting(null);
        sub.waiting = null;
      }
      this.subscribers.delete(id);
    }
  }

  /**
   * Publish a control event to all subscribers.
   */
  publish(event: ControlEvent) {
    for (const sub of this.subscribers.values()) {
      if (sub.closed) continue;
      if (sub.waiting) {
        const resolve = sub.waiting;
        sub.waiting = null;
        resolve(event);
      } else {
        if (sub.queue.length >= MAX_EVENT_QUEUE_SIZE) {
          sub.queue.shift();
        }
        sub.queue.push(event);
      }
    }

    for (const cb of this.callbacks.values()) {
      try { cb(event); } catch {}
    }
  }

  subscriberCount(): number {
    return this.subscribers.size + this.callbacks.size;
  }
}

/**
 * In-process mailbox for one-time delivery secrets. Raw tokens never enter PostgreSQL,
 * outbox payloads or logs; the outbox stores only the token row id.
 *
 * A process restart drops pending secrets. Expired records are pruned whenever a token is
 * inserted or looked up, and callers also prune superseded tokens when issuing a new link.
 */
export interface TokenDelivery {
  rawToken: string;
  expiresAt: Date;
}

export interface TokenDeliveryRegistry {
  put(id: string, delivery: TokenDelivery): void;
  /** Read a delivery while keeping it available for outbox retries until send succeeds. */
  take(id: string, now?: Date): TokenDelivery | undefined;
  remove(id: string): void;
  prune(now?: Date): number;
}

export function createTokenDeliveryRegistry(): TokenDeliveryRegistry {
  const deliveries = new Map<string, TokenDelivery>();

  function prune(now = new Date()): number {
    let removed = 0;
    for (const [id, delivery] of deliveries) {
      if (delivery.expiresAt.getTime() <= now.getTime()) {
        deliveries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    put(id, delivery) {
      prune();
      deliveries.set(id, delivery);
    },
    take(id, now = new Date()) {
      const delivery = deliveries.get(id);
      if (delivery === undefined) {
        prune(now);
        return undefined;
      }
      if (delivery.expiresAt.getTime() <= now.getTime()) deliveries.delete(id);
      prune(now);
      // Return an expired entry once so the dispatcher can classify it as `expired`, rather
      // than misclassifying it as an invalid payload after pruning the registry.
      return delivery;
    },
    remove(id) {
      deliveries.delete(id);
    },
    prune,
  };
}

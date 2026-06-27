type AbortHandler = ((event: AbortEvent) => void) | null;

type AbortEvent = {
  target: AbortSignal;
  type: 'abort';
};

function createAbortError(reason: unknown): unknown {
  if (reason !== undefined) {
    return reason;
  }

  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

export class AbortSignal {
  aborted = false;
  onabort: AbortHandler = null;
  reason: unknown;

  private readonly listeners = new Set<(event: AbortEvent) => void>();

  addEventListener(
    type: string,
    listener: ((event: AbortEvent) => void) | null,
  ) {
    if (type !== 'abort' || !listener) {
      return;
    }

    this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: ((event: AbortEvent) => void) | null,
  ) {
    if (type !== 'abort' || !listener) {
      return;
    }

    this.listeners.delete(listener);
  }

  dispatchEvent(event: AbortEvent): boolean {
    this.onabort?.(event);

    for (const listener of this.listeners) {
      listener(event);
    }

    return true;
  }

  throwIfAborted(): void {
    if (this.aborted) {
      throw createAbortError(this.reason);
    }
  }

  static abort(reason?: unknown): AbortSignal {
    const controller = new AbortController();
    controller.abort(reason);
    return controller.signal;
  }

  static timeout(milliseconds: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), milliseconds);
    return controller.signal;
  }

  static any(signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }

      signal.addEventListener('abort', () => controller.abort(signal.reason));
    }

    return controller.signal;
  }

  _abort(reason?: unknown): void {
    if (this.aborted) {
      return;
    }

    this.aborted = true;
    this.reason = createAbortError(reason);
    this.dispatchEvent({
      target: this,
      type: 'abort',
    });
  }
}

export class AbortController {
  readonly signal = new AbortSignal();

  abort(reason?: unknown): void {
    this.signal._abort(reason);
  }
}

export default {
  AbortController,
  AbortSignal,
};

interface ReadableStreamDefaultReadResult<T> {
  done: boolean;
  value?: T;
}

interface ReadableStreamDefaultReader<T> {
  read(): Promise<ReadableStreamDefaultReadResult<T>>;
}

interface ReadableStream<T> {
  getReader(): ReadableStreamDefaultReader<T>;
}

interface Response {
  readonly body: ReadableStream<Uint8Array> | null;
}

declare class TextDecoder {
  decode(
    input?: BufferSource | Uint8Array,
    options?: {
      stream?: boolean;
    },
  ): string;
}

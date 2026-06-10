export type SseEvent = {
  data: string;
  event: string;
  id?: string;
};

type ConsumeSseStreamInput = {
  onEvent: (event: SseEvent) => void | Promise<void>;
  response: Response;
};

export async function consumeSseStream({
  onEvent,
  response,
}: ConsumeSseStreamInput): Promise<void> {
  if (!response.body) {
    throw new Error('Streaming response body is unavailable.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let currentEvent = 'message';
  let currentId: string | undefined;
  let currentData: string[] = [];

  const flushEvent = async () => {
    if (currentData.length === 0 && !currentId && currentEvent === 'message') {
      return;
    }

    await onEvent({
      data: currentData.join('\n'),
      event: currentEvent,
      id: currentId,
    });

    currentEvent = 'message';
    currentId = undefined;
    currentData = [];
  };

  while (true) {
    const { done, value } = await reader.read();

    buffer += decoder.decode(value ?? new Uint8Array(), {
      stream: !done,
    });

    while (true) {
      const newlineIndex = buffer.indexOf('\n');

      if (newlineIndex === -1) {
        break;
      }

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      if (!line) {
        await flushEvent();
        continue;
      }

      if (line.startsWith(':')) {
        continue;
      }

      const separatorIndex = line.indexOf(':');
      const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
      let fieldValue =
        separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);

      if (fieldValue.startsWith(' ')) {
        fieldValue = fieldValue.slice(1);
      }

      switch (field) {
        case 'data':
          currentData.push(fieldValue);
          break;
        case 'event':
          currentEvent = fieldValue || 'message';
          break;
        case 'id':
          currentId = fieldValue || undefined;
          break;
        default:
          break;
      }
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim().length > 0) {
    let trailingLine = buffer;

    if (trailingLine.endsWith('\r')) {
      trailingLine = trailingLine.slice(0, -1);
    }

    const separatorIndex = trailingLine.indexOf(':');
    const field =
      separatorIndex === -1 ? trailingLine : trailingLine.slice(0, separatorIndex);
    let fieldValue =
      separatorIndex === -1 ? '' : trailingLine.slice(separatorIndex + 1);

    if (fieldValue.startsWith(' ')) {
      fieldValue = fieldValue.slice(1);
    }

    if (field === 'data') {
      currentData.push(fieldValue);
    } else if (field === 'event') {
      currentEvent = fieldValue || currentEvent;
    } else if (field === 'id') {
      currentId = fieldValue || currentId;
    }
  }

  await flushEvent();
}

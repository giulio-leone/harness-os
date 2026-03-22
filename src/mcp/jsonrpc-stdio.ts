export type JsonRpcId = number | string | null;

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorPayload;
}

export type JsonRpcEnvelope =
  | JsonRpcMessage
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

interface JsonRpcStreamEndpoints {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export class JsonRpcStreamTransport {
  private buffer = Buffer.alloc(0);
  private chain = Promise.resolve();
  private listening = false;
  private outputMode: 'framed' | 'jsonl' = 'framed';

  constructor(
    private readonly onMessage: (message: JsonRpcEnvelope) => Promise<void>,
    private readonly endpoints: JsonRpcStreamEndpoints,
  ) {}

  start(): void {
    if (this.listening) {
      return;
    }

    this.endpoints.input.on('data', this.handleChunk);
    this.listening = true;

    const readable = this.endpoints.input as NodeJS.ReadableStream & {
      resume?: () => void;
    };

    readable.resume?.();
  }

  stop(): void {
    if (!this.listening) {
      return;
    }

    const readable = this.endpoints.input as NodeJS.ReadableStream & {
      off?: (event: string, listener: (chunk: Buffer | string) => void) => void;
      removeListener?: (
        event: string,
        listener: (chunk: Buffer | string) => void,
      ) => void;
    };

    if (typeof readable.off === 'function') {
      readable.off('data', this.handleChunk);
    } else {
      readable.removeListener?.('data', this.handleChunk);
    }

    this.listening = false;
  }

  sendRequest(id: JsonRpcId, method: string, params?: unknown): void {
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      id,
      method,
    };

    if (params !== undefined) {
      message.params = params;
    }

    this.writeEnvelope(message);
  }

  sendNotification(method: string, params?: unknown): void {
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      method,
    };

    if (params !== undefined) {
      message.params = params;
    }

    this.writeEnvelope(message);
  }

  sendResult(id: JsonRpcId, result: unknown): void {
    this.writeEnvelope({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  sendError(id: JsonRpcId, error: JsonRpcErrorPayload): void {
    this.writeEnvelope({
      jsonrpc: '2.0',
      id,
      error,
    });
  }

  private readonly handleChunk = (chunk: Buffer | string): void => {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, chunkBuffer]);
    this.drainBuffer();
  };

  private drainBuffer(): void {
    while (true) {
      const framedEnvelope = extractFramedEnvelope(this.buffer);
      let body: string;

      if (framedEnvelope !== null) {
        this.outputMode = 'framed';
        body = framedEnvelope.body;
        this.buffer = this.buffer.subarray(framedEnvelope.nextOffset);
      } else {
        const bareEnvelope = extractBareJsonEnvelope(this.buffer);

        if (bareEnvelope === null) {
          return;
        }

        this.outputMode = 'jsonl';
        body = bareEnvelope.body;
        this.buffer = this.buffer.subarray(bareEnvelope.nextOffset);
      }

      let message: JsonRpcEnvelope;

      try {
        message = JSON.parse(body) as JsonRpcEnvelope;
      } catch (error) {
        console.error(`Failed to parse JSON-RPC message: ${getErrorMessage(error)}`);
        continue;
      }

      this.chain = this.chain
        .then(() => this.onMessage(message))
        .catch((error: unknown) => {
          console.error(getErrorMessage(error));
        });
    }
  }

  private writeEnvelope(message: JsonRpcEnvelope): void {
    const body = JSON.stringify(message);

    if (this.outputMode === 'jsonl') {
      this.endpoints.output.write(`${body}\n`);
      return;
    }

    const header = `Content-Length: ${Buffer.byteLength(
      body,
      'utf8',
    )}\r\n\r\n`;

    this.endpoints.output.write(header);
    this.endpoints.output.write(body);
  }
}

export class StdioJsonRpcTransport {
  private readonly transport: JsonRpcStreamTransport;

  constructor(
    private readonly onMessage: (message: JsonRpcMessage) => Promise<void>,
  ) {
    this.transport = new JsonRpcStreamTransport(
      async (message) => {
        if (!isJsonRpcMessage(message)) {
          console.error(
            `Unexpected JSON-RPC response envelope on stdio server input: ${JSON.stringify(message)}`,
          );
          return;
        }

        await this.onMessage(message);
      },
      {
        input: process.stdin,
        output: process.stdout,
      },
    );
  }

  start(): void {
    this.transport.start();
  }

  stop(): void {
    this.transport.stop();
  }

  sendNotification(method: string, params?: unknown): void {
    this.transport.sendNotification(method, params);
  }

  sendResult(id: JsonRpcId, result: unknown): void {
    this.transport.sendResult(id, result);
  }

  sendError(id: JsonRpcId, error: JsonRpcErrorPayload): void {
    this.transport.sendError(id, error);
  }
}

export function isJsonRpcMessage(message: JsonRpcEnvelope): message is JsonRpcMessage {
  return 'method' in message;
}

export function isJsonRpcSuccessResponse(
  message: JsonRpcEnvelope,
): message is JsonRpcSuccessResponse {
  return !('method' in message) && 'result' in message;
}

export function isJsonRpcErrorResponse(
  message: JsonRpcEnvelope,
): message is JsonRpcErrorResponse {
  return !('method' in message) && 'error' in message;
}

function parseContentLength(header: string): number {
  const match = header.match(/Content-Length:\s*(\d+)/i);

  if (match === null) {
    throw new Error('Missing Content-Length header in JSON-RPC envelope');
  }

  return Number.parseInt(match[1], 10);
}

function findHeaderBoundary(
  buffer: Buffer,
): { headerEnd: number; separatorLength: number } | null {
  const crlfBoundary = buffer.indexOf('\r\n\r\n');

  if (crlfBoundary !== -1) {
    return {
      headerEnd: crlfBoundary,
      separatorLength: 4,
    };
  }

  const lfBoundary = buffer.indexOf('\n\n');

  if (lfBoundary !== -1) {
    return {
      headerEnd: lfBoundary,
      separatorLength: 2,
    };
  }

  return null;
}

function extractFramedEnvelope(
  buffer: Buffer,
): { body: string; nextOffset: number } | null {
  const headerBoundary = findHeaderBoundary(buffer);

  if (headerBoundary === null) {
    return null;
  }

  const { headerEnd, separatorLength } = headerBoundary;
  const header = buffer.subarray(0, headerEnd).toString('utf8');

  let contentLength: number;

  try {
    contentLength = parseContentLength(header);
  } catch (error) {
    console.error(getErrorMessage(error));
    return null;
  }

  const messageEnd = headerEnd + separatorLength + contentLength;

  if (buffer.length < messageEnd) {
    return null;
  }

  return {
    body: buffer
      .subarray(headerEnd + separatorLength, messageEnd)
      .toString('utf8'),
    nextOffset: messageEnd,
  };
}

function extractBareJsonEnvelope(
  buffer: Buffer,
): { body: string; nextOffset: number } | null {
  const source = buffer.toString('utf8');
  const leadingWhitespace = source.match(/^\s*/)?.[0].length ?? 0;

  if (leadingWhitespace >= source.length) {
    return null;
  }

  const firstCharacter = source[leadingWhitespace];

  if (firstCharacter !== '{' && firstCharacter !== '[') {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = leadingWhitespace; index < source.length; index += 1) {
    const character = source[index];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (inString) {
      if (character === '\\') {
        escaping = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{' || character === '[') {
      depth += 1;
      continue;
    }

    if (character === '}' || character === ']') {
      depth -= 1;

      if (depth === 0) {
        const endIndex = index + 1;

        return {
          body: source.slice(leadingWhitespace, endIndex),
          nextOffset: Buffer.byteLength(source.slice(0, endIndex), 'utf8'),
        };
      }
    }
  }

  return null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

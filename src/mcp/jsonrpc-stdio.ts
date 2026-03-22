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

export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

export class StdioJsonRpcTransport {
  private buffer = Buffer.alloc(0);
  private chain = Promise.resolve();

  constructor(
    private readonly onMessage: (message: JsonRpcMessage) => Promise<void>,
  ) {}

  start(): void {
    process.stdin.on('data', (chunk: Buffer | string) => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = Buffer.concat([this.buffer, chunkBuffer]);
      this.drainBuffer();
    });

    process.stdin.resume();
  }

  sendResult(id: JsonRpcId, result: unknown): void {
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  sendError(id: JsonRpcId, error: JsonRpcErrorPayload): void {
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      error,
    });
  }

  private drainBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');

      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.subarray(0, headerEnd).toString('utf8');

      let contentLength: number;

      try {
        contentLength = parseContentLength(header);
      } catch (error) {
        console.error(getErrorMessage(error));
        this.buffer = Buffer.alloc(0);
        return;
      }

      const messageEnd = headerEnd + 4 + contentLength;

      if (this.buffer.length < messageEnd) {
        return;
      }

      const body = this.buffer.subarray(headerEnd + 4, messageEnd).toString('utf8');
      this.buffer = this.buffer.subarray(messageEnd);

      let message: JsonRpcMessage;

      try {
        message = JSON.parse(body) as JsonRpcMessage;
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

  private writeMessage(
    message: JsonRpcSuccessResponse | JsonRpcErrorResponse,
  ): void {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(
      body,
      'utf8',
    )}\r\n\r\n`;

    process.stdout.write(header);
    process.stdout.write(body);
  }
}

function parseContentLength(header: string): number {
  const match = header.match(/Content-Length:\s*(\d+)/i);

  if (match === null) {
    throw new Error('Missing Content-Length header in JSON-RPC envelope');
  }

  return Number.parseInt(match[1], 10);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

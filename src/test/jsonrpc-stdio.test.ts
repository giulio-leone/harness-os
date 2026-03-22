import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  JsonRpcStreamTransport,
  type JsonRpcEnvelope,
} from '../mcp/jsonrpc-stdio.js';

test('JsonRpcStreamTransport accepts LF-only framed envelopes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let resolveEnvelope: ((message: JsonRpcEnvelope) => void) | undefined;
  const receivedEnvelope = new Promise<JsonRpcEnvelope>((resolve) => {
    resolveEnvelope = resolve;
  });
  const transport = new JsonRpcStreamTransport(
    async (message) => {
      resolveEnvelope?.(message);
    },
    { input, output },
  );
  const request = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
    },
  };
  const body = JSON.stringify(request);

  transport.start();
  input.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\n\n${body}`);

  const envelope = await receivedEnvelope;
  assert.equal('method' in envelope && envelope.method, 'initialize');

  transport.stop();
});

test('JsonRpcStreamTransport accepts bare JSON envelopes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let resolveEnvelope: ((message: JsonRpcEnvelope) => void) | undefined;
  const receivedEnvelope = new Promise<JsonRpcEnvelope>((resolve) => {
    resolveEnvelope = resolve;
  });
  const transport = new JsonRpcStreamTransport(
    async (message) => {
      resolveEnvelope?.(message);
    },
    { input, output },
  );
  const request = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
    },
  };

  transport.start();
  input.write(JSON.stringify(request));

  const envelope = await receivedEnvelope;
  assert.equal('method' in envelope && envelope.method, 'initialize');

  transport.stop();
});

test('JsonRpcStreamTransport replies with json lines after bare JSON input', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunk = new Promise<string>((resolve) => {
    output.once('data', (chunk: Buffer | string) => {
      resolve(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    });
  });
  let transport!: JsonRpcStreamTransport;

  transport = new JsonRpcStreamTransport(
    async (message) => {
      if ('method' in message) {
        transport.sendResult(message.id ?? null, { ok: true });
      }
    },
    { input, output },
  );

  transport.start();
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
      },
    }),
  );

  const chunk = await outputChunk;
  assert.equal(chunk, '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');

  transport.stop();
});

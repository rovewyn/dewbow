import { setTimeout as delay } from 'node:timers/promises';
import { isRecord, makeAck, robotTopic } from './messages.js';
import type { StreamFrame } from './messages.js';
type Log = (message: string) => void;
type Handler = (frame: StreamFrame, signal?: AbortSignal) => Promise<ReturnType<typeof makeAck>>;

export interface Credentials { clientId: string; clientSecret: string }

interface StreamOptions {
  signal: AbortSignal;
  handle: Handler;
  log?: Log;
  gatewayUrl?: string;
  retryDelayMs?: number;
}

function parseFrame(raw: unknown): StreamFrame {
  if (typeof raw !== 'string') throw new Error('Expected a text frame');
  const frame: unknown = JSON.parse(raw);
  if (!isRecord(frame) || !isRecord(frame.headers)
    || typeof frame.type !== 'string' || typeof frame.data !== 'string'
    || typeof frame.headers.messageId !== 'string' || !frame.headers.messageId
    || typeof frame.headers.topic !== 'string') {
    throw new Error('Invalid Stream frame');
  }
  return {
    type: frame.type,
    headers: { messageId: frame.headers.messageId, topic: frame.headers.topic },
    data: frame.data,
  };
}

async function receiveConnection(
  url: string,
  handle: Handler,
  signal: AbortSignal,
  log: Log,
): Promise<void> {
  signal.throwIfAborted();
  const socket = new WebSocket(url);
  const connectionAbort = new AbortController();
  const callbackSignal = AbortSignal.any([signal, connectionAbort.signal]);
  const tasks = new Set<Promise<void>>();
  let handshakeTimer: NodeJS.Timeout | undefined;
  const stop = () => socket.close();
  await new Promise<void>((resolve, reject) => {
    signal.addEventListener('abort', stop, { once: true });
    handshakeTimer = setTimeout(() => {
      socket.close();
      reject(new Error('Stream handshake timed out'));
    }, 10_000);
    socket.addEventListener('open', () => {
      clearTimeout(handshakeTimer);
      log('Stream connected. Send the robot a text message.');
    });
    socket.addEventListener('error', () => {
      clearTimeout(handshakeTimer);
      reject(new Error('Stream connection failed'));
    });
    socket.addEventListener('close', () => {
      clearTimeout(handshakeTimer);
      signal.removeEventListener('abort', stop);
      connectionAbort.abort();
      resolve();
    });
    socket.addEventListener('message', (event) => {
      try {
        const frame = parseFrame(event.data);
        if (frame.type === 'SYSTEM') {
          if (frame.headers.topic === 'ping') {
            socket.send(JSON.stringify({ ...makeAck(frame, 200, 'OK'), data: frame.data }));
          } else if (frame.headers.topic === 'disconnect') {
            socket.close();
          }
        } else if (frame.type === 'CALLBACK') {
          // Bound pending work; leave excess deliveries unacknowledged for possible retry.
          if (tasks.size >= 32) return;
          const task = (async () => {
            const ack = frame.headers.topic === robotTopic
              ? await handle(frame, callbackSignal) : makeAck(frame, 404, 'Unknown topic');
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(ack));
          })().catch(() => log('Callback processing failed.'));
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
        }
      } catch {
        log('Ignored a malformed Stream frame.');
      }
    });
  }).finally(async () => {
    clearTimeout(handshakeTimer);
    signal.removeEventListener('abort', stop);
    connectionAbort.abort();
    socket.close();
    await Promise.allSettled(tasks);
  });
}

export async function runStream(credentials: Credentials, options: StreamOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const handle = options.handle;
  while (!options.signal.aborted) {
    try {
      const response = await fetch(
        options.gatewayUrl ?? 'https://api.dingtalk.com/v1.0/gateway/connections/open',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            clientId: credentials.clientId, clientSecret: credentials.clientSecret, ua: 'dewbow-team/0.1.0',
            subscriptions: [{ type: 'CALLBACK', topic: robotTopic }],
          }),
          redirect: 'error',
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
        },
      );
      const connection: unknown = await response.json();
      if (response.status !== 200 || !isRecord(connection)
        || typeof connection.endpoint !== 'string' || typeof connection.ticket !== 'string') {
        throw new Error('Gateway rejected the connection');
      }
      const url = new URL(connection.endpoint);
      const localSocket = options.gatewayUrl && new URL(options.gatewayUrl).hostname === '127.0.0.1' && url.protocol === 'ws:' && url.hostname === '127.0.0.1';
      if (url.protocol !== 'wss:' && !localSocket) throw new Error('Invalid socket protocol');
      url.searchParams.set('ticket', connection.ticket);
      await receiveConnection(url.href, handle, options.signal, log);
    } catch {
      if (!options.signal.aborted) log('Stream connection failed; retrying.');
    }
    if (!options.signal.aborted) {
      await delay(options.retryDelayMs ?? 3000, undefined, { signal: options.signal }).catch(() => {});
    }
  }
}

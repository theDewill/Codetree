import type { Citation, Message, Model } from './types';
let token: string | undefined;
export function setAccessToken(value?: string) { token = value; }
export function headers() { return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }; }
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { ...init, credentials: 'same-origin', headers: { ...headers(), ...init.headers } });
  const result = await response.json().catch(() => ({ error: 'The API returned an unreadable response.' }));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result as T;
}
export async function streamChat(
  input: Record<string, unknown>, signal: AbortSignal,
  callbacks: { meta: (value: { sources: Citation[]; userMessage: Message; model: Model }) => void; delta: (text: string) => void; done: (message: Message) => void },
) {
  const response = await fetch('/api/v1/chat', { method: 'POST', credentials: 'same-origin', headers: headers(), body: JSON.stringify(input), signal });
  if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Could not start a response.'); }
  if (!response.body) throw new Error('Streaming is unavailable in this browser.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', finished = false, streamError = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replaceAll('\r\n', '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const event = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === 'meta') callbacks.meta(parsed);
      if (event === 'delta') callbacks.delta(parsed.text);
      if (event === 'error') streamError = parsed.error;
      if (event === 'done') { finished = true; callbacks.done(parsed); }
    }
    if (done) break;
  }
  if (streamError) throw new Error(streamError);
  if (!finished) throw new Error('The connection ended before the response completed.');
}

import { WebSocket } from 'ws';
import type { ChatMessage, BridgeHealth } from './types.js';

export interface CdpClientOptions {
  debugPort?: number;
  host?: string;
  autoCreateTarget?: boolean;
}

export class MerlinCdpClient {
  private debugPort: number;
  private host: string;
  private autoCreateTarget: boolean;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pendingCallbacks = new Map<number, (res: any) => void>();
  private activeStreamCallbacks = new Map<string, (chunk: string, done: boolean, error?: string) => void>();
  private targetId: string | null = null;
  private targetUrl: string | null = null;
  private isConnected = false;
  private startTime = Date.now();

  constructor(opts: CdpClientOptions = {}) {
    this.debugPort = opts.debugPort ?? 9222;
    this.host = opts.host ?? '127.0.0.1';
    this.autoCreateTarget = opts.autoCreateTarget ?? true;
  }

  public async getHealth(): Promise<BridgeHealth> {
    return {
      status: this.isConnected ? 'ok' : 'degraded',
      chromePort: this.debugPort,
      cdpConnected: this.isConnected,
      merlinTargetFound: Boolean(this.targetId),
      targetId: this.targetId,
      targetUrl: this.targetUrl,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000)
    };
  }

  public async connect(): Promise<boolean> {
    try {
      const listRes = await fetch(`http://${this.host}:${this.debugPort}/json/list`, { signal: AbortSignal.timeout(2500) });
      if (!listRes.ok) return false;
      const targets: any[] = await listRes.json();

      // Find an existing Merlin target or fallback page
      let target = targets.find(t => 
        (typeof t.url === 'string' && t.url.includes('getmerlin.in')) ||
        (typeof t.title === 'string' && t.title.toLowerCase().includes('merlin'))
      );

      if (!target && this.autoCreateTarget) {
        // Create background Merlin tab
        const newRes = await fetch(`http://${this.host}:${this.debugPort}/json/new?https://www.getmerlin.in/chat`, {
          method: 'PUT',
          signal: AbortSignal.timeout(4000)
        });
        if (newRes.ok) {
          target = await newRes.json();
        }
      }

      // If still no target, attach to first page tab
      if (!target) {
        target = targets.find(t => t.type === 'page');
      }

      if (!target?.webSocketDebuggerUrl) return false;

      this.targetId = target.id ?? null;
      this.targetUrl = target.url ?? null;

      await this.openWebSocket(target.webSocketDebuggerUrl);
      return true;
    } catch {
      this.isConnected = false;
      return false;
    }
  }

  private openWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (this.ws) {
          this.ws.removeAllListeners();
          this.ws.close();
        }

        this.ws = new WebSocket(url);

        this.ws.on('open', async () => {
          this.isConnected = true;
          try {
            await this.send('Runtime.enable');
            await this.send('Page.enable');
            await this.send('Runtime.addBinding', { name: '__merlin_stream_sink' });
            resolve();
          } catch (e) {
            reject(e);
          }
        });

        this.ws.on('message', (data: any) => {
          try {
            const msg = JSON.parse(data.toString());
            // Check for pending request responses
            if (msg.id && this.pendingCallbacks.has(msg.id)) {
              const cb = this.pendingCallbacks.get(msg.id)!;
              this.pendingCallbacks.delete(msg.id);
              cb(msg);
              return;
            }

            // Check for stream binding events
            if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__merlin_stream_sink') {
              const payload = JSON.parse(msg.params.payload || '{}');
              const streamId = payload.streamId || 'default';
              const handler = this.activeStreamCallbacks.get(streamId);
              if (handler) {
                if (payload.error) {
                  handler('', true, payload.error);
                  this.activeStreamCallbacks.delete(streamId);
                } else {
                  if (payload.chunk) {
                    handler(payload.chunk, Boolean(payload.done));
                  }
                  if (payload.done) {
                    if (!payload.chunk) handler('', true);
                    this.activeStreamCallbacks.delete(streamId);
                  }
                }
              }
            }
          } catch {
            // ignore malformed frame
          }
        });

        this.ws.on('error', () => {
          this.isConnected = false;
        });

        this.ws.on('close', () => {
          this.isConnected = false;
        });
      } catch (e) {
        this.isConnected = false;
        reject(e);
      }
    });
  }

  public send(method: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('CDP WebSocket is not connected'));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pendingCallbacks.has(id)) {
          this.pendingCallbacks.delete(id);
          reject(new Error(`CDP request timed out: ${method}`));
        }
      }, 30000);

      this.pendingCallbacks.set(id, (res) => {
        clearTimeout(timer);
        if (res.error) reject(new Error(res.error.message || 'CDP Error'));
        else resolve(res.result);
      });

      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Executes a prompt / conversation via in-browser fetch inside the real Chrome session.
   */
  public async executeChat(
    messages: ChatMessage[],
    model = 'gpt-4',
    onChunk?: (chunk: string) => void
  ): Promise<{ text: string; model: string }> {
    if (!this.isConnected) {
      const ok = await this.connect();
      if (!ok) throw new Error('Cannot connect to Chrome via CDP on port ' + this.debugPort);
    }

    const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const isStreaming = Boolean(onChunk);

    let fullText = '';
    const streamPromise = new Promise<string>((resolve, reject) => {
      this.activeStreamCallbacks.set(streamId, (chunk, done, err) => {
        if (err) return reject(new Error(err));
        if (chunk) {
          fullText += chunk;
          if (onChunk) onChunk(chunk);
        }
        if (done) resolve(fullText);
      });
    });

    // In-browser script executed natively in the page context
    const script = `
      (async () => {
        try {
          const streamId = ${JSON.stringify(streamId)};
          const messages = ${JSON.stringify(messages)};
          const requestedModel = ${JSON.stringify(model)};
          const isStreaming = ${isStreaming};

          let streamStore = null;
          let chatStore = null;

          if (window.webpackChunk_N_E) {
            window.webpackChunk_N_E.push([[Math.random()], {}, (require) => {
              try { streamStore = require(21388)?.g; } catch {}
              try { chatStore = require(84244)?.Y; } catch {}
            }]);
          }

          if (!streamStore || !chatStore) {
            window.__merlin_stream_sink(JSON.stringify({
              streamId,
              error: 'Merlin web client store not found. Ensure https://www.getmerlin.in/chat is loaded.'
            }));
            return { ok: false };
          }

          const prompt = messages.length === 1
            ? (messages[0].content || '')
            : messages.map(m => \`\${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System'}: \${m.content}\`).join('\\n\\n');

          const legacyOrAuto = ['gpt-4', 'merlin/default', 'auto', 'default'];
          const streamArgs = {
            prompt,
            type: 'APPEND'
          };
          if (requestedModel && !legacyOrAuto.includes(requestedModel.toLowerCase())) {
            streamArgs.modelOverride = requestedModel;
          }

          let targetChildId = null;
          let sentLength = 0;

          const unsub = chatStore.subscribe((state) => {
            if (!targetChildId) return;
            const node = state.chatRef?.get(targetChildId);
            if (!node) return;
            const text = (node.contentV2 || []).filter(c => c.type === 'TEXT').map(c => c.text).join('');
            if (isStreaming && text.length > sentLength) {
              const delta = text.slice(sentLength);
              sentLength = text.length;
              window.__merlin_stream_sink(JSON.stringify({ streamId, chunk: delta }));
            }
          });

          const startRes = await streamStore.getState().startStream(streamArgs);
          targetChildId = startRes?.message?.childId;

          // Poll until node reaches terminal state (SUCCESS / ERROR) or 60s timeout
          const maxLoops = 240; // 60s
          let finalNode = null;
          for (let i = 0; i < maxLoops; i++) {
            await new Promise(r => setTimeout(r, 250));
            finalNode = targetChildId ? chatStore.getState().chatRef?.get(targetChildId) : null;
            if (finalNode?.status === 'SUCCESS' || finalNode?.status === 'ERROR') {
              break;
            }
            const streamStatus = streamStore.getState().status;
            if (i > 8 && streamStatus === 'idle' && finalNode?.contentV2?.length) {
              break;
            }
          }

          unsub();

          if (finalNode?.status === 'ERROR') {
            const errMsg = finalNode.error?.message || 'Chat generation failed';
            window.__merlin_stream_sink(JSON.stringify({ streamId, error: errMsg }));
            return { ok: false, error: errMsg };
          }

          const fullText = (finalNode?.contentV2 || []).filter(c => c.type === 'TEXT').map(c => c.text).join('');
          if (!isStreaming) {
            window.__merlin_stream_sink(JSON.stringify({ streamId, chunk: fullText, done: true }));
          } else {
            if (fullText.length > sentLength) {
              window.__merlin_stream_sink(JSON.stringify({ streamId, chunk: fullText.slice(sentLength) }));
            }
            window.__merlin_stream_sink(JSON.stringify({ streamId, done: true }));
          }

          return { ok: true, model: finalNode?.modelId || requestedModel };
        } catch (fatal) {
          window.__merlin_stream_sink(JSON.stringify({ streamId: ${JSON.stringify(streamId)}, error: fatal.message }));
          return { ok: false, error: fatal.message };
        }
      })()
    `;

    // Dispatch in Chrome runtime
    const evalRes = await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true
    });

    // Wait for the stream sink to collect output
    const text = await streamPromise;
    const resolvedModel = evalRes?.result?.value?.model || model;
    return { text, model: resolvedModel };
  }
}

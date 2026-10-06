import http from 'node:http';
import { MerlinCdpClient } from './cdp.js';
import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk } from './types.js';

const PORT = Number(process.env.MERLIN_BRIDGE_PORT || 4340);
const HOST = process.env.MERLIN_BRIDGE_HOST || '127.0.0.1';
const CHROME_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222);

const cdp = new MerlinCdpClient({ debugPort: CHROME_PORT });

// Initialize connection in background
void cdp.connect().then(ok => {
  if (ok) console.log(`[merlin-bridge] Connected to Chrome CDP on port ${CHROME_PORT}`);
  else console.log(`[merlin-bridge] Waiting for Chrome CDP on port ${CHROME_PORT}...`);
});

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);

  // Health, readiness, and status checks
  if (url.pathname === '/health' || url.pathname === '/ready' || url.pathname === '/status') {
    const health = await cdp.getHealth();
    res.writeHead(health.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }

  // OpenAI models list
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'gpt-4', object: 'model', created: Date.now(), owned_by: 'merlin' },
        { id: 'claude-sonnet-5.5', object: 'model', created: Date.now(), owned_by: 'merlin' },
        { id: 'glm-5.3-flash', object: 'model', created: Date.now(), owned_by: 'merlin' },
        { id: 'gpt-6-luna', object: 'model', created: Date.now(), owned_by: 'merlin' },
        { id: 'gemini-3.8-flash', object: 'model', created: Date.now(), owned_by: 'merlin' },
        { id: 'merlin/default', object: 'model', created: Date.now(), owned_by: 'merlin' }
      ]
    }));
    return;
  }

  // Chat completions endpoint
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let bodyText = '';
    req.on('data', chunk => { bodyText += chunk; });
    req.on('end', async () => {
      try {
        const body: ChatCompletionRequest = JSON.parse(bodyText || '{}');
        const messages = body.messages || [];
        const model = body.model || 'gpt-4';
        const stream = Boolean(body.stream);

        if (!messages.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Missing messages array', code: 400 } }));
          return;
        }

        const completionId = `chatcmpl_merlin_${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        if (stream) {
          // SSE streaming mode
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          try {
            await cdp.executeChat(messages, model, (deltaText) => {
              const chunk: ChatCompletionChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: { content: deltaText },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            });

            // Send final stop chunk and [DONE]
            const finalChunk: ChatCompletionChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } catch (err: any) {
            // Emits structured SSE error then terminates
            res.write(`data: ${JSON.stringify({ error: { message: err.message, code: 503 } })}\n\n`);
            res.end();
          }
        } else {
          // Non-streaming JSON mode
          const result = await cdp.executeChat(messages, model);
          const response: ChatCompletionResponse = {
            id: completionId,
            object: 'chat.completion',
            created,
            model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: result.text },
              finish_reason: 'stop'
            }],
            usage: {
              prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
              completion_tokens: Math.ceil(result.text.length / 4),
              total_tokens: Math.ceil((JSON.stringify(messages).length + result.text.length) / 4)
            }
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        }
      } catch (err: any) {
        // Circuit breaker failover
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: err.message || 'Merlin bridge error',
            type: 'merlin_unavailable',
            code: 503
          }
        }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found', code: 404 } }));
});

server.listen(PORT, HOST, () => {
  console.log(`[merlin-bridge] Listening on http://${HOST}:${PORT}`);
});

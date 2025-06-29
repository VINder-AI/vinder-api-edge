import { kv } from '@vercel/kv';
import { NextResponse } from 'next/server';

export const runtime = 'edge';

const ASSISTANT_ID = 'asst_8Iw8xHDNqFYSLva0KmRChr4C';

async function addMessage(apiKey: string, threadId: string, content: string) {
  const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v1',
    },
    body: JSON.stringify({
      role: 'user',
      content,
    }),
  });
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Message addition failed: ${res.status} ${error}`);
  }
}

export async function POST(req: Request) {
  try {
    const { input, sessionId } = await req.json();
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    if (!sessionId) throw new Error('Session ID required');

    let threadId = await kv.get<string>(sessionId);

    if (!threadId) {
      const threadRes = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'OpenAI-Beta': 'assistants=v1',
        },
      });
      if (!threadRes.ok) {
        const error = await threadRes.text();
        throw new Error(`Thread creation failed: ${threadRes.status} ${error}`);
      }
      const threadData = await threadRes.json();
      threadId = threadData.id;
      await kv.set(sessionId, threadId, { ex: 60 * 60 * 24 });
    }

    await addMessage(apiKey, threadId, input || "");

    const runRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v1',
      },
      body: JSON.stringify({
        assistant_id: ASSISTANT_ID,
        stream: true,
      }),
    });

    if (!runRes.ok) {
      const error = await runRes.text();
      throw new Error(`Run creation failed: ${runRes.status} ${error}`);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const reader = runRes.body?.getReader();
          if (!reader) throw new Error('No response body');

          let buffer = '';
          let runCompleted = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n');
            buffer = events.pop() || '';

            for (const event of events) {
              if (event.includes('[DONE]')) {
                runCompleted = true;
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                continue;
              }

              if (event.startsWith('data: ')) {
                try {
                  const jsonStr = event.replace('data: ', '').trim();
                  if (!jsonStr) continue;

                  const data = JSON.parse(jsonStr);
                  if (data.event === 'thread.message.delta') {
                    const payload = JSON.stringify({ delta: data.data.delta });
                    controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                  }
                } catch (error) {
                  console.error('Error parsing event:', error);
                }
              }
            }
          }

          if (!runCompleted) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (error) {
          console.error('Stream error:', error);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('API error:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error', 
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
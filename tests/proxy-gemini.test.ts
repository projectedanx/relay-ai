// tests/proxy-gemini.test.ts
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  translateToGemini,
  translateFromGemini,
  translateStreamGemini,
} from '../src/proxy-gemini.js';

describe('translateFromGemini thoughtSignature', () => {
  it('encodes part-level thoughtSignature into tool_use id', () => {
    const anthropic = translateFromGemini({
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{
            functionCall: { name: 'pplx_usage', args: {} },
            thoughtSignature: 'sig_gemini_native',
          }],
        },
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }, 'gemini-3.5-flash');

    const toolUse = anthropic.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse.id).toContain('::ts::sig_gemini_native');
  });

  it('accepts snake_case thought_signature on the part', () => {
    const anthropic = translateFromGemini({
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{
            functionCall: { name: 'bash', args: { command: 'ls' } },
            thought_signature: 'sig_snake',
          }],
        },
      }],
    }, 'gemini-3.5-flash');

    const toolUse = anthropic.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse.id).toBe(`${anthropic.id}_tc0::ts::sig_snake`);
  });

  it('parses stringified functionCall args into tool_use input object', () => {
    const anthropic = translateFromGemini({
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{
            functionCall: { name: 'Skill', args: '{"skill":"superpowers:using-superpowers"}' },
            thoughtSignature: 'sig_skill',
          }],
        },
      }],
    }, 'gemini-3.5-flash');

    const toolUse = anthropic.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse.input).toEqual({ skill: 'superpowers:using-superpowers' });
  });
});

describe('translateToGemini thoughtSignature round-trip', () => {
  it('echoes thoughtSignature at part level, not inside functionCall', () => {
    const response = translateFromGemini({
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{
            functionCall: { name: 'pplx_usage', args: {} },
            thoughtSignature: 'sig_roundtrip',
          }],
        },
      }],
    }, 'gemini-3.5-flash');

    const toolUse = response.content.find((b: any) => b.type === 'tool_use');
    const gemini = translateToGemini({
      messages: [
        { role: 'user', content: 'hey' },
        { role: 'assistant', content: [toolUse] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '{"ok":true}' }],
        },
      ],
      tools: [{ name: 'pplx_usage', description: 'usage', input_schema: { type: 'object', properties: {} } }],
    });

    const modelParts = gemini.contents.find((c: any) => c.role === 'model')?.parts ?? [];
    const fcPart = modelParts.find((p: any) => p.functionCall?.name === 'pplx_usage');
    expect(fcPart?.thoughtSignature).toBe('sig_roundtrip');
  });

  it('cleans MCP tool schemas for Gemini compatibility', () => {
    const gemini = translateToGemini({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        name: 'Skill',
        description: 'Load a skill',
        input_schema: {
          type: 'object',
          properties: { skill: { type: 'string' } },
          required: ['skill'],
          additionalProperties: false,
          $defs: { skillName: { type: 'string' } },
        },
      }],
    });

    const params = gemini.tools[0].functionDeclarations[0].parameters;
    expect(params.type).toBe('object');
    expect(params.additionalProperties).toBeUndefined();
    expect(params.$defs).toBeUndefined();
    expect(params.properties.skill.type).toBe('string');
    expect(params.required).toEqual(['skill']);
    expect(params.description).toContain('No extra properties allowed');
  });
});

describe('translateStreamGemini thoughtSignature', () => {
  async function collectStreamEvents(upstream: Readable): Promise<object[]> {
    const out = translateStreamGemini(upstream, 'gemini-3.5-flash');
    const events: object[] = [];
    return new Promise((resolve, reject) => {
      let buf = '';
      out.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
      out.on('end', () => {
        for (const line of buf.split('\n')) {
          const payload = line.startsWith('data:') ? line.slice(5).trimStart() : '';
          if (!payload) continue;
          try { events.push(JSON.parse(payload)); } catch { /* skip */ }
        }
        resolve(events);
      });
      out.on('error', reject);
    });
  }

  async function runGeminiStream(chunks: object[]): Promise<object[]> {
    const lines = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('');
    return collectStreamEvents(Readable.from([Buffer.from(lines)]));
  }

  it('encodes part-level thoughtSignature from a single SSE chunk', async () => {
    const events = await runGeminiStream([{
      candidates: [{
        content: {
          parts: [{
            functionCall: { name: 'pplx_usage', args: {} },
            thoughtSignature: 'sig_stream',
          }],
        },
      }],
    }]);

    const start = events.find((e: any) => e.type === 'content_block_start') as any;
    expect(start?.content_block?.id).toContain('::ts::sig_stream');
  });

  it('waits for a deferred part-level thoughtSignature before emitting tool_use', async () => {
    const events = await runGeminiStream([
      {
        candidates: [{
          content: {
            parts: [{ functionCall: { name: 'pplx_usage', args: {} } }],
          },
        }],
      },
      {
        candidates: [{
          content: {
            parts: [{
              functionCall: { name: 'pplx_usage', args: {} },
              thoughtSignature: 'sig_late',
            }],
          },
        }],
      },
    ]);

    const starts = events.filter((e: any) => e.type === 'content_block_start') as any[];
    expect(starts).toHaveLength(1);
    expect(starts[0]?.content_block?.id).toContain('::ts::sig_late');
  });

  it('emits message_start even when upstream sends no content', async () => {
    const events = await collectStreamEvents(Readable.from([Buffer.from('')]));
    expect(events.some((e: any) => e.type === 'message_start')).toBe(true);
    expect(events.some((e: any) => e.type === 'message_stop')).toBe(true);
  });

  it('parses SSE data lines without a space after the colon', async () => {
    const raw = `data:${JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'Hello' }] },
      }],
    })}\n\n`;
    const events = await collectStreamEvents(Readable.from([Buffer.from(raw)]));
    expect(events.some((e: any) => e.type === 'message_start')).toBe(true);
    const textDelta = events.find((e: any) => e.type === 'content_block_delta' && e.delta?.text === 'Hello');
    expect(textDelta).toBeDefined();
  });

  it('does not surface Gemini internal thought parts to Claude Code', async () => {
    const events = await runGeminiStream([{
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'internal reasoning only' },
            { text: 'Hello!' },
          ],
        },
      }],
    }]);

    expect(events.some((e: any) => e.delta?.type === 'thinking_delta')).toBe(false);
    const textDelta = events.find(
      (e: any) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta',
    ) as any;
    expect(textDelta?.delta?.text).toBe('Hello!');
  });

  it('requests includeThoughts: false in translateToGemini', () => {
    const gemini = translateToGemini({ messages: [{ role: 'user', content: 'hey' }] });
    expect(gemini.generationConfig).toEqual({ thinkingConfig: { includeThoughts: false } });
  });
});

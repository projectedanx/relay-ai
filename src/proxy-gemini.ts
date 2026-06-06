// src/proxy-gemini.ts — Anthropic ↔ Gemini Native API translation
//
// Gemini's OpenAI-compatible endpoint strips thought_signature from responses,
// creating an unresolvable loop (required on echo-back, never returned).
// The native generateContent API returns thought_signature correctly.
import { Readable } from 'node:stream';
import { cleanJsonSchemaForGemini } from './gemini-schema.js';
import { resolveUpstreamTools, isToolSearchTool } from './tool-search.js';
import {
  collectAnthropicBlocksFromGeminiParts,
  mapGeminiUsage,
  parseGeminiPart,
} from './gemini-parts.js';
import type {
  AnthropicMessage,
  AnthropicMessageRequest,
  AnthropicRequestContentPart,
  AnthropicRequestMessage,
  AnthropicToolDefinition,
  GeminiApiResponse,
  GeminiPart,
  GeminiUsageMetadata,
} from './proxy-types.js';
import {
  attachSseLineReader,
  encodeToolUseId,
  extractSseDataPayload,
  serializeToolResultContent,
  splitToolUseId,
  sseChunk,
  stripToolUseIdSuffix,
} from './proxy-shared.js';

/** Fallback when thought_signature echo-back is unavailable (CLIProxyAPI compat). */
export const GEMINI_SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

export function isGeminiUrl(url: string): boolean {
  return url.includes('generativelanguage.googleapis.com');
}

export function geminiNativeUrl(model: string, stream: boolean): string {
  const base = 'https://generativelanguage.googleapis.com/v1beta/models';
  return stream
    ? `${base}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    : `${base}/${encodeURIComponent(model)}:generateContent`;
}

function buildToolNameMap(messages: AnthropicRequestMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages ?? []) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool_use') {
          const rawId = stripToolUseIdSuffix(part.id);
          map.set(part.id, part.name);
          map.set(rawId, part.name);
        }
      }
    }
  }
  return map;
}

const cleanedToolSchemaCache = new Map<string, Record<string, unknown>>();

function geminiToolDeclaration(tool: AnthropicToolDefinition) {
  let parameters = cleanedToolSchemaCache.get(tool.name);
  if (!parameters) {
    if (tool.input_schema && Object.keys(tool.input_schema).length > 0) {
      parameters = cleanJsonSchemaForGemini(tool.input_schema);
    } else {
      parameters = { type: 'object', properties: {} };
    }
    cleanedToolSchemaCache.set(tool.name, parameters);
  }
  const description =
    typeof tool.description === 'string'
      ? tool.description
      : isToolSearchTool(tool)
        ? 'Search deferred tools by name or regex pattern'
        : undefined;
  return {
    name: tool.name,
    description,
    parameters,
  };
}

function anthropicPartToGemini(part: AnthropicRequestContentPart, toolNameMap: Map<string, string>): GeminiPart | null {
  if (part.type === 'text') {
    return part.text?.trim() ? { text: part.text } : null;
  }

  if (part.type === 'thinking') {
    const tp: GeminiPart = { thought: true, text: part.thinking };
    if (part.signature) tp.thought_signature = part.signature;
    return tp;
  }

  if (part.type === 'tool_use') {
    let { thoughtSignature } = splitToolUseId(part.id);
    if (!thoughtSignature) thoughtSignature = GEMINI_SKIP_THOUGHT_SIGNATURE;
    return {
      functionCall: { name: part.name, args: part.input ?? {} },
      thoughtSignature,
    };
  }

  if (part.type === 'tool_result') {
    const rawToolId = stripToolUseIdSuffix(part.tool_use_id);
    const name = toolNameMap.get(part.tool_use_id) ?? toolNameMap.get(rawToolId) ?? rawToolId;
    return {
      functionResponse: {
        name,
        response: { content: serializeToolResultContent(part.content) },
      },
    };
  }

  // tool_reference blocks are metadata for tool search — upstream tools come from resolveUpstreamTools.
  if (part.type === 'tool_reference') {
    return null;
  }

  if (part.type === 'image') {
    const src = part.source;
    if (src.type === 'base64') {
      return { inlineData: { mimeType: src.media_type, data: src.data } };
    }
    if (src.type === 'url') {
      return { fileData: { fileUri: src.url } };
    }
  }

  return null;
}

export function translateToGemini(body: AnthropicMessageRequest): Record<string, unknown> {
  const { messages, system, tools, temperature, max_tokens, top_p } = body;
  const toolNameMap = buildToolNameMap(messages ?? []);
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];

  for (const msg of messages ?? []) {
    const parts: GeminiPart[] = [];
    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else {
      for (const part of msg.content ?? []) {
        const geminiPart = anthropicPartToGemini(part, toolNameMap);
        if (geminiPart) parts.push(geminiPart);
      }
    }

    if (parts.length > 0) contents.push({ role, parts });
  }

  // Keep internal reasoning server-side; tool calls still carry thought_signature.
  const generationConfig: Record<string, unknown> = { thinkingConfig: { includeThoughts: false } };
  if (max_tokens !== undefined) generationConfig.maxOutputTokens = max_tokens;
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (top_p !== undefined) generationConfig.topP = top_p;

  const data: Record<string, unknown> = { contents, generationConfig };

  if (system) {
    const sysParts =
      typeof system === 'string'
        ? [{ text: system }]
        : system.map(s => ({ text: s.text }));
    data.systemInstruction = { parts: sysParts };
  }

  const upstreamTools = resolveUpstreamTools(tools, messages ?? []);
  if (upstreamTools.length > 0) {
    data.tools = [{ functionDeclarations: upstreamTools.map(geminiToolDeclaration) }];
  }

  return data;
}

export function translateFromGemini(response: GeminiApiResponse, model: string): AnthropicMessage {
  const messageId = 'msg_' + Date.now();
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const { content, hasToolUse } = collectAnthropicBlocksFromGeminiParts(parts, messageId);

  const finishReason = candidate?.finishReason;
  let stop_reason = 'end_turn';
  if (finishReason === 'MAX_TOKENS') stop_reason = 'max_tokens';
  else if (hasToolUse) stop_reason = 'tool_use';

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason,
    stop_sequence: null,
    model,
    usage: mapGeminiUsage(response.usageMetadata),
  };
}

interface PendingGeminiToolCall {
  blockIndex: number;
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
  emitted: boolean;
}

export function translateStreamGemini(
  upstreamBody: NodeJS.ReadableStream,
  model: string,
): Readable {
  const messageId = 'msg_' + Date.now();
  const output = new Readable({ read() {} });

  const streamState = {
    messageId,
    contentBlockIndex: -1,
    hasTextBlock: false,
    hasThinkingBlock: false,
    messageStarted: false,
    stopReason: 'end_turn',
  };

  let lastUsage: ReturnType<typeof mapGeminiUsage> | null = null;
  const pendingByName = new Map<string, PendingGeminiToolCall>();
  let toolCallCount = 0;
  let toolIndex = 0;
  let thinkingSignature = '';

  const emit = (eventType: string, data: Record<string, unknown>) => {
    output.push(sseChunk(eventType, data));
  };

  const startMessage = () => {
    if (streamState.messageStarted) return;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant',
        content: [], model, stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    streamState.messageStarted = true;
  };

  const closeBlock = () => {
    if (streamState.hasThinkingBlock) {
      // Claude Code requires signature_delta before content_block_stop on thinking
      // blocks; without it the client stops reading and the stream deadlocks.
      emit('content_block_delta', {
        type: 'content_block_delta', index: streamState.contentBlockIndex,
        delta: {
          type: 'signature_delta',
          signature: thinkingSignature || GEMINI_SKIP_THOUGHT_SIGNATURE,
        },
      });
      emit('content_block_stop', { type: 'content_block_stop', index: streamState.contentBlockIndex });
      streamState.hasThinkingBlock = false;
      thinkingSignature = '';
    }
    if (streamState.hasTextBlock) {
      emit('content_block_stop', { type: 'content_block_stop', index: streamState.contentBlockIndex });
      streamState.hasTextBlock = false;
    }
  };

  const flushPendingToolCall = (pending: PendingGeminiToolCall) => {
    if (pending.emitted) return;
    const encodedId = encodeToolUseId(pending.id, pending.thoughtSignature);
    startMessage();
    emit('content_block_start', {
      type: 'content_block_start', index: pending.blockIndex,
      content_block: { type: 'tool_use', id: encodedId, name: pending.name, input: {} },
    });
    emit('content_block_delta', {
      type: 'content_block_delta', index: pending.blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(pending.args) },
    });
    emit('content_block_stop', { type: 'content_block_stop', index: pending.blockIndex });
    pending.emitted = true;
  };

  const emitParsedPart = (parsed: ReturnType<typeof parseGeminiPart>) => {
    if (!parsed) return;

    if (parsed.kind === 'thinking') {
      if (streamState.hasTextBlock) { closeBlock(); streamState.contentBlockIndex++; }
      if (!streamState.hasThinkingBlock) {
        if (streamState.contentBlockIndex < 0) streamState.contentBlockIndex = 0;
        else if (!streamState.hasTextBlock) streamState.contentBlockIndex++;
        startMessage();
        emit('content_block_start', {
          type: 'content_block_start', index: streamState.contentBlockIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
        streamState.hasThinkingBlock = true;
      }
      emit('content_block_delta', {
        type: 'content_block_delta', index: streamState.contentBlockIndex,
        delta: { type: 'thinking_delta', thinking: parsed.text },
      });
      if (parsed.signature) thinkingSignature = parsed.signature;
      return;
    }

    if (parsed.kind === 'text') {
      if (streamState.hasThinkingBlock) { closeBlock(); streamState.contentBlockIndex++; }
      if (!streamState.hasTextBlock) {
        if (streamState.contentBlockIndex < 0) streamState.contentBlockIndex = 0;
        else if (!streamState.hasThinkingBlock) streamState.contentBlockIndex++;
        startMessage();
        emit('content_block_start', {
          type: 'content_block_start', index: streamState.contentBlockIndex,
          content_block: { type: 'text', text: '' },
        });
        streamState.hasTextBlock = true;
      }
      emit('content_block_delta', {
        type: 'content_block_delta', index: streamState.contentBlockIndex,
        delta: { type: 'text_delta', text: parsed.text },
      });
      return;
    }

    closeBlock();
    let pending = pendingByName.get(parsed.name);
    if (!pending || pending.emitted) {
      streamState.contentBlockIndex++;
      pending = {
        blockIndex: streamState.contentBlockIndex,
        id: `${messageId}_tc${toolCallCount}`,
        name: parsed.name,
        args: parsed.input,
        emitted: false,
      };
      pendingByName.set(parsed.name, pending);
      toolCallCount++;
      streamState.stopReason = 'tool_use';
    } else {
      pending.args = parsed.input;
    }

    if (parsed.signature) pending.thoughtSignature = parsed.signature;
    if (pending.thoughtSignature) flushPendingToolCall(pending);
  };

  const processGeminiParts = (parts: GeminiPart[], usage?: GeminiUsageMetadata, finishReason?: string | null) => {
    for (const part of parts) {
      const parsed = parseGeminiPart(part, messageId, toolIndex);
      if (parsed?.kind === 'tool_use') toolIndex++;
      emitParsedPart(parsed);
    }

    if (finishReason === 'MAX_TOKENS') streamState.stopReason = 'max_tokens';
    if (usage) lastUsage = mapGeminiUsage(usage);
  };

  const finish = () => {
    for (const pending of pendingByName.values()) flushPendingToolCall(pending);
    closeBlock();
    startMessage();
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: streamState.stopReason, stop_sequence: null },
      usage: lastUsage ?? { input_tokens: 0, output_tokens: 0 },
    });
    emit('message_stop', { type: 'message_stop' });
    output.push(null);
  };

  const processGeminiSsePayload = (raw: string) => {
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as GeminiApiResponse;
      const candidate = parsed.candidates?.[0];
      processGeminiParts(
        candidate?.content?.parts ?? [],
        parsed.usageMetadata,
        candidate?.finishReason ?? null,
      );
    } catch { /* skip malformed chunks */ }
  };

  attachSseLineReader(upstreamBody, (line) => {
    const payload = extractSseDataPayload(line);
    if (payload) processGeminiSsePayload(payload);
  }, finish);

  return output;
}

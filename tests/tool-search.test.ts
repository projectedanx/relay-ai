import { describe, it, expect } from 'vitest';
import {
  isToolSearchTool,
  extractReferencedToolNames,
  resolveUpstreamTools,
} from '../src/tool-search.js';
import { translateRequest } from '../src/proxy.js';
import { translateToGemini } from '../src/proxy-gemini.js';

const coreTools = [
  { name: 'Bash', description: 'Run bash', input_schema: { type: 'object', properties: {} } },
  { name: 'Read', description: 'Read file', input_schema: { type: 'object', properties: {} } },
];

const deferredTools = [
  { name: 'mcp_playwright_click', description: 'Click', input_schema: { type: 'object', properties: {} }, defer_loading: true },
  { name: 'mcp_context7_resolve', description: 'Resolve', input_schema: { type: 'object', properties: {} }, defer_loading: true },
];

const toolSearchTool = {
  type: 'tool_search_tool_regex_20251119',
  name: 'tool_search_tool_regex',
};

describe('isToolSearchTool', () => {
  it('detects tool search tools by type', () => {
    expect(isToolSearchTool(toolSearchTool)).toBe(true);
  });

  it('detects tool search tools by name', () => {
    expect(isToolSearchTool({ name: 'tool_search_tool_bm25' })).toBe(true);
  });
});

describe('extractReferencedToolNames', () => {
  it('collects tool_reference blocks from user tool_result content', () => {
    const names = extractReferencedToolNames([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'tool_reference', tool_name: 'mcp_playwright_click' }],
          },
        ],
      },
    ]);
    expect(names.has('mcp_playwright_click')).toBe(true);
  });

  it('collects tool_references from tool_search_tool_result blocks', () => {
    const names = extractReferencedToolNames([
      {
        role: 'user',
        content: [
          {
            type: 'tool_search_tool_result',
            content: {
              tool_references: [{ tool_name: 'mcp_context7_resolve' }],
            },
          },
        ],
      },
    ]);
    expect(names.has('mcp_context7_resolve')).toBe(true);
  });
});

describe('resolveUpstreamTools', () => {
  it('includes core + tool search tools but not deferred MCP tools', () => {
    const upstream = resolveUpstreamTools(
      [...coreTools, ...deferredTools, toolSearchTool],
      [{ role: 'user', content: 'hey' }],
    );
    expect(upstream.map(t => t.name)).toEqual(['Bash', 'Read', 'tool_search_tool_regex']);
  });

  it('includes deferred tools once referenced in history', () => {
    const upstream = resolveUpstreamTools(
      [...coreTools, ...deferredTools, toolSearchTool],
      [
        {
          role: 'user',
          content: [{ type: 'tool_reference', tool_name: 'mcp_playwright_click' }],
        },
      ],
    );
    expect(upstream.map(t => t.name)).toContain('mcp_playwright_click');
    expect(upstream.map(t => t.name)).not.toContain('mcp_context7_resolve');
  });
});

describe('proxy tool filtering integration', () => {
  const allTools = [...coreTools, ...deferredTools, toolSearchTool];

  it('translateRequest forwards filtered tools to OpenAI', () => {
    const result = translateRequest({
      model: 'test',
      messages: [{ role: 'user', content: 'hey' }],
      tools: allTools,
    });
    expect((result.tools as Array<{ function: { name: string } }>).map(t => t.function.name)).toEqual([
      'Bash',
      'Read',
      'tool_search_tool_regex',
    ]);
  });

  it('translateToGemini forwards filtered tools to Gemini', () => {
    const result = translateToGemini({
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'hey' }],
      tools: allTools,
    });
    const decls = (result.tools as Array<{ functionDeclarations: Array<{ name: string }> }>)[0].functionDeclarations;
    expect(decls.map(d => d.name)).toEqual(['Bash', 'Read', 'tool_search_tool_regex']);
  });
});

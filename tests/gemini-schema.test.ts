// tests/gemini-schema.test.ts
import { describe, it, expect } from 'vitest';
import { cleanJsonSchemaForGemini } from '../src/gemini-schema.js';

describe('cleanJsonSchemaForGemini', () => {
  it('removes unsupported metadata but preserves property names like $id', () => {
    const result = cleanJsonSchemaForGemini({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'root-schema',
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          prefill: 'hello',
          properties: {
            mode: { type: 'string', enum: ['a', 'b'], enumTitles: ['A', 'B'] },
          },
          patternProperties: { '^x-': { type: 'string' } },
        },
        $id: { type: 'string', description: 'property name should not be removed' },
      },
    });

    expect(result.$schema).toBeUndefined();
    expect(result.$id).toBeUndefined();
    expect((result.properties as any).$id).toBeDefined();
    expect((result.properties as any).payload.prefill).toBeUndefined();
    expect((result.properties as any).payload.patternProperties).toBeUndefined();
    expect((result.properties as any).payload.properties.mode.enum).toEqual(['a', 'b']);
    expect((result.properties as any).payload.properties.mode.description).toContain('Allowed: a, b');
  });

  it('strips additionalProperties and adds a hint', () => {
    const result = cleanJsonSchemaForGemini({
      type: 'object',
      properties: { skill: { type: 'string' } },
      required: ['skill'],
      additionalProperties: false,
    });

    expect(result.additionalProperties).toBeUndefined();
    expect(result.description).toContain('No extra properties allowed');
    expect((result.properties as any).skill.type).toBe('string');
    expect(result.required).toEqual(['skill']);
  });

  it('flattens anyOf by picking the object branch', () => {
    const result = cleanJsonSchemaForGemini({
      type: 'object',
      properties: {
        query: {
          anyOf: [
            { type: 'null' },
            { type: 'object', properties: { kind: { type: 'string' } } },
          ],
        },
      },
    });

    const query = (result.properties as any).query;
    expect(query.anyOf).toBeUndefined();
    expect(query.type).toBe('object');
    expect(query.properties.kind.type).toBe('string');
    expect(query.description).toContain('Accepts:');
  });

  it('converts const to enum and removes const keyword', () => {
    const result = cleanJsonSchemaForGemini({
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'InsightVizNode' },
      },
    });

    const kind = (result.properties as any).kind;
    expect(kind.enum).toEqual(['InsightVizNode']);
    expect(kind.const).toBeUndefined();
  });

  it('removes x- extension fields but keeps x- property names', () => {
    const result = cleanJsonSchemaForGemini({
      type: 'object',
      'x-custom-meta': 'value',
      properties: {
        'x-data': { type: 'string' },
        normal: { type: 'number', 'x-meta': 'remove' },
      },
      required: ['x-data'],
    });

    expect(result['x-custom-meta']).toBeUndefined();
    expect((result.properties as any)['x-data'].type).toBe('string');
    expect((result.properties as any).normal['x-meta']).toBeUndefined();
  });

  it('converts $ref to a description hint object', () => {
    const result = cleanJsonSchemaForGemini({
      type: 'object',
      properties: {
        customer: { $ref: '#/definitions/User', description: 'The customer' },
      },
    });

    const customer = (result.properties as any).customer;
    expect(customer.type).toBe('object');
    expect(customer.description).toContain('See: User');
    expect(customer.$ref).toBeUndefined();
  });
});

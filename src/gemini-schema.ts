// Schema cleaner for Gemini functionDeclarations.parameters.
// Ported from CLIProxyAPI internal/util/gemini_schema.go — 3 tree walks (normalize, flatten, sanitize).

const PLACEHOLDER_REASON = 'Brief explanation of why you are calling this tool';

const UNSUPPORTED_CONSTRAINTS = [
  'minLength', 'maxLength', 'exclusiveMinimum', 'exclusiveMaximum',
  'pattern', 'minItems', 'maxItems', 'uniqueItems', 'format',
  'default', 'examples',
];

const UNSUPPORTED_KEYWORDS = [
  ...UNSUPPORTED_CONSTRAINTS,
  '$schema', '$defs', 'definitions', 'const', '$ref', '$id', 'additionalProperties',
  'propertyNames', 'patternProperties',
  'enumTitles', 'prefill', 'deprecated',
];

const GEMINI_REMOVE_KEYWORDS = new Set([...UNSUPPORTED_KEYWORDS, 'nullable', 'title']);

type SchemaObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is SchemaObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function appendDescription(existing: string | undefined, hint: string): string {
  if (existing) return `${existing} (${hint})`;
  return hint;
}

function isPropertiesContainer(path: string): boolean {
  return path === 'properties' || path.endsWith('.properties');
}

function walkObjectChildren(
  obj: SchemaObject,
  path: string,
  visitor: (child: unknown, childPath: string) => unknown,
): SchemaObject {
  const out: SchemaObject = {};
  for (const [k, v] of Object.entries(obj)) {
    const childPath = path ? `${path}.${k}` : k;
    if (k === 'properties' && isPlainObject(v)) {
      const props: SchemaObject = {};
      for (const [pk, pv] of Object.entries(v)) {
        props[pk] = visitor(pv, `${childPath}.${pk}`) as SchemaObject;
      }
      out[k] = props;
    } else {
      out[k] = visitor(v, childPath);
    }
  }
  return out;
}

function selectBest(items: SchemaObject[]): { index: number; types: string[] } {
  let bestIdx = 0;
  let bestScore = -1;
  const types: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let t = typeof item.type === 'string' ? item.type : '';
    let score = 0;

    if (t === 'object' || isPlainObject(item.properties)) {
      score = 3;
      t = t || 'object';
    } else if (t === 'array' || item.items !== undefined) {
      score = 2;
      t = t || 'array';
    } else if (t && t !== 'null') {
      score = 1;
    } else {
      t = t || 'null';
    }

    if (t) types.push(t);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return { index: bestIdx, types };
}

function normalizeSchemaHints(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(normalizeSchemaHints);
  if (!isPlainObject(obj)) return obj;

  if (typeof obj.$ref === 'string') {
    const defName = obj.$ref.includes('/') ? obj.$ref.split('/').pop()! : obj.$ref;
    const hint = typeof obj.description === 'string' && obj.description
      ? `${obj.description} (See: ${defName})`
      : `See: ${defName}`;
    return { type: 'object', description: hint };
  }

  const out = walkObjectChildren(obj, '', normalizeSchemaHints) as SchemaObject;

  if ('const' in out && !('enum' in out)) out.enum = [out.const];

  if (Array.isArray(out.enum)) {
    const enumVals = out.enum.map(item => String(item));
    out.enum = enumVals;
    out.type = 'string';
    if (enumVals.length > 1 && enumVals.length <= 10) {
      out.description = appendDescription(
        typeof out.description === 'string' ? out.description : undefined,
        `Allowed: ${enumVals.join(', ')}`,
      );
    }
  }

  if (out.additionalProperties === false) {
    out.description = appendDescription(
      typeof out.description === 'string' ? out.description : undefined,
      'No extra properties allowed',
    );
  }

  return out;
}

function moveConstraintsToDescription(obj: unknown, path = ''): unknown {
  if (Array.isArray(obj)) return obj.map((item, i) => moveConstraintsToDescription(item, `${path}.${i}`));
  if (!isPlainObject(obj)) return obj;

  const out: SchemaObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (UNSUPPORTED_CONSTRAINTS.includes(k) && (typeof v !== 'object' || v === null)) {
      if (!isPropertiesContainer(path)) {
        out.description = appendDescription(
          typeof out.description === 'string' ? out.description : undefined,
          `${k}: ${String(v)}`,
        );
        continue;
      }
    }
    const childPath = path ? `${path}.${k}` : k;
    out[k] = moveConstraintsToDescription(v, childPath);
  }
  return out;
}

function flattenBranch(obj: SchemaObject): SchemaObject {
  let out: SchemaObject = { ...obj };
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = out[key];
    if (!Array.isArray(variants) || variants.length === 0) continue;

    const items = variants.filter(isPlainObject) as SchemaObject[];
    const parentDesc = typeof out.description === 'string' ? out.description : '';
    const { index, types } = selectBest(items);
    let selected: SchemaObject = { ...(flattenBranch(items[index]!) as SchemaObject) };

    if (parentDesc) {
      const childDesc = typeof selected.description === 'string' ? selected.description : '';
      selected.description = childDesc
        ? childDesc === parentDesc ? childDesc : `${parentDesc} (${childDesc})`
        : parentDesc;
    }

    if (types.length > 1) {
      selected.description = appendDescription(
        typeof selected.description === 'string' ? selected.description : undefined,
        `Accepts: ${types.join(' | ')}`,
      );
    }

    delete out[key];
    out = { ...out, ...selected };
  }
  return out;
}

function flattenSchemaStructure(obj: unknown, path = '', nullableByObject = new Map<string, string[]>()): unknown {
  if (Array.isArray(obj)) return obj.map((item, i) => flattenSchemaStructure(item, `${path}.${i}`, nullableByObject));
  if (!isPlainObject(obj)) return obj;

  let out: SchemaObject = { ...obj };

  if (Array.isArray(out.allOf)) {
    for (const item of out.allOf) {
      if (!isPlainObject(item)) continue;
      const merged = flattenSchemaStructure(item, path, nullableByObject) as SchemaObject;
      if (isPlainObject(merged.properties)) {
        out.properties = { ...(out.properties as SchemaObject ?? {}), ...merged.properties };
      }
      if (Array.isArray(merged.required)) {
        const current = Array.isArray(out.required) ? [...out.required as string[]] : [];
        for (const r of merged.required as string[]) {
          if (!current.includes(r)) current.push(r);
        }
        out.required = current;
      }
    }
    delete out.allOf;
  }

  out = flattenBranch(out);

  if (Array.isArray(out.type)) {
    const types = out.type.map(String);
    const hasNull = types.includes('null');
    const nonNull = types.filter(t => t !== 'null');
    out.type = nonNull[0] ?? 'string';

    if (nonNull.length > 1) {
      out.description = appendDescription(
        typeof out.description === 'string' ? out.description : undefined,
        `Accepts: ${nonNull.join(' | ')}`,
      );
    }

    if (hasNull) {
      const parts = path.split('.');
      if (parts.length >= 2 && parts[parts.length - 2] === 'properties') {
        const fieldName = parts[parts.length - 1]!;
        const objectPath = parts.slice(0, -2).join('.');
        const list = nullableByObject.get(objectPath) ?? [];
        list.push(fieldName);
        nullableByObject.set(objectPath, list);
        out.description = appendDescription(
          typeof out.description === 'string' ? out.description : undefined,
          '(nullable)',
        );
      }
    }
  }

  for (const [k, v] of Object.entries(out)) {
    if (['allOf', 'anyOf', 'oneOf', 'type'].includes(k)) continue;
    const childPath = path ? `${path}.${k}` : k;
    out[k] = flattenSchemaStructure(v, childPath, nullableByObject);
  }

  return out;
}

function applyNullableRequiredRemovals(root: SchemaObject, nullableByObject: Map<string, string[]>): void {
  for (const [objectPath, fields] of nullableByObject) {
    const target = objectPath ? getAtPath(root, objectPath.split('.')) : root;
    if (!isPlainObject(target) || !Array.isArray(target.required)) continue;
    target.required = (target.required as string[]).filter(r => !fields.includes(r));
    if ((target.required as string[]).length === 0) delete target.required;
  }
}

function getAtPath(root: SchemaObject, parts: string[]): SchemaObject | undefined {
  let cur: unknown = root;
  for (const part of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return isPlainObject(cur) ? cur : undefined;
}

function sanitizeSchema(obj: unknown, path = ''): unknown {
  if (Array.isArray(obj)) return obj.map((item, i) => sanitizeSchema(item, `${path}.${i}`));
  if (!isPlainObject(obj)) return obj;

  const out: SchemaObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (GEMINI_REMOVE_KEYWORDS.has(k) && !isPropertiesContainer(path)) continue;
    if (k.startsWith('x-') && !isPropertiesContainer(path)) continue;
    const childPath = path ? `${path}.${k}` : k;
    out[k] = sanitizeSchema(v, childPath);
  }

  if (isPlainObject(out.properties)) {
    const props = out.properties as SchemaObject;

    if ('reason' in props && Object.keys(props).length === 1) {
      const reason = props.reason;
      if (isPlainObject(reason) && reason.description === PLACEHOLDER_REASON) {
        delete out.properties;
        delete out.required;
      }
    }

    if ('_' in props) {
      const { _: _removed, ...rest } = props;
      void _removed;
      if (Object.keys(rest).length === 0) {
        delete out.properties;
        delete out.required;
      } else {
        out.properties = rest;
        if (Array.isArray(out.required)) {
          out.required = (out.required as string[]).filter(r => r !== '_');
          if ((out.required as string[]).length === 0) delete out.required;
        }
      }
    }
  }

  if (Array.isArray(out.required) && isPlainObject(out.properties)) {
    const props = out.properties as SchemaObject;
    const valid = (out.required as string[]).filter(name => name in props);
    if (valid.length === 0) delete out.required;
    else if (valid.length !== (out.required as string[]).length) out.required = valid;
  }

  return out;
}

function ensureRootObject(schema: SchemaObject): SchemaObject {
  if (!schema.type && !schema.anyOf && !schema.oneOf && !schema.allOf && !schema.$ref) {
    return { type: 'object', properties: {}, ...schema };
  }
  return schema;
}

export function cleanJsonSchemaForGemini(input: unknown): SchemaObject {
  if (!isPlainObject(input)) return { type: 'object', properties: {} };

  const nullableByObject = new Map<string, string[]>();
  let schema: unknown = structuredClone(input);
  schema = moveConstraintsToDescription(normalizeSchemaHints(schema));
  schema = flattenSchemaStructure(schema, '', nullableByObject);
  applyNullableRequiredRemovals(schema as SchemaObject, nullableByObject);
  schema = sanitizeSchema(schema);

  return ensureRootObject(schema as SchemaObject);
}

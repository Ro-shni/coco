/** Turns a tool's JSON Schema `inputSchema` into form fields, and form values back into call arguments. */
export type FieldKind = 'text' | 'textarea' | 'number' | 'integer' | 'boolean' | 'enum' | 'list' | 'json';
export interface Field { name: string; kind: FieldKind; required: boolean; description: string; options: string[] }
export type FieldValues = Record<string, string | boolean>;

interface PropSchema { type?: string | string[]; description?: string; enum?: unknown[]; maxLength?: number; items?: { type?: string } }

function primaryType(p: PropSchema): string | undefined {
  return Array.isArray(p.type) ? p.type.find((t) => t !== 'null') : p.type;
}

function kindOf(name: string, p: PropSchema): FieldKind {
  if (Array.isArray(p.enum) && p.enum.length > 0) return 'enum';
  switch (primaryType(p)) {
    case 'string':
      return (p.maxLength ?? 0) > 200 || /query|body|text/i.test(`${name} ${p.description ?? ''}`) ? 'textarea' : 'text';
    case 'number': return 'number';
    case 'integer': return 'integer';
    case 'boolean': return 'boolean';
    case 'array': return p.items?.type === 'string' ? 'list' : 'json';
    default: return 'json';
  }
}

export function fieldsFor(schema: Record<string, unknown> | undefined): Field[] {
  const props = (schema?.properties ?? {}) as Record<string, PropSchema>;
  const required = new Set(Array.isArray(schema?.required) ? (schema?.required as string[]) : []);
  return Object.entries(props).map(([name, p]) => ({
    name, kind: kindOf(name, p ?? {}), required: required.has(name), description: p?.description ?? '',
    options: Array.isArray(p?.enum) ? p.enum.map(String) : [],
  }));
}

export function initialValues(fields: Field[]): FieldValues {
  return Object.fromEntries(fields.map((f) => [f.name, f.kind === 'boolean' ? false : '']));
}

/** Builds the `args` object. Empty optional fields are omitted; a bad number or JSON throws a sentence naming the field. */
export function buildArgs(fields: Field[], values: FieldValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.kind === 'boolean') {
      if (v === true || f.required) out[f.name] = v === true;
      continue;
    }
    const text = typeof v === 'string' ? v.trim() : '';
    if (text === '') {
      if (f.required) throw new Error(`${f.name} is required.`);
      continue;
    }
    if (f.kind === 'number' || f.kind === 'integer') {
      const n = Number(text);
      if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) throw new Error(`${f.name} must be ${f.kind === 'integer' ? 'a whole number' : 'a number'}.`);
      out[f.name] = n;
    } else if (f.kind === 'list') {
      out[f.name] = text.split(',').map((s) => s.trim()).filter((s) => s !== '');
    } else if (f.kind === 'json') {
      try { out[f.name] = JSON.parse(text) as unknown; } catch { throw new Error(`${f.name} must be valid JSON.`); }
    } else {
      out[f.name] = typeof v === 'string' ? v : text;
    }
  }
  return out;
}

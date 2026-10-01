import { describe, expect, it } from 'vitest';
import { buildArgs, fieldsFor, initialValues } from '../src/schema';

const schema = {
  type: 'object', required: ['jql'],
  properties: {
    jql: { type: 'string', description: 'JQL query to run' },
    title: { type: 'string' },
    notes: { type: 'string', maxLength: 500 },
    limit: { type: 'integer' }, ratio: { type: 'number' }, dry: { type: 'boolean' },
    kind: { type: 'string', enum: ['a', 'b'] },
    labels: { type: 'array', items: { type: 'string' } },
    fields: { type: 'object' },
  },
};

describe('schema form helpers', () => {
  it('maps JSON Schema types to field kinds', () => {
    const kinds = Object.fromEntries(fieldsFor(schema).map((f) => [f.name, f.kind]));
    expect(kinds).toEqual({ jql: 'textarea', title: 'text', notes: 'textarea', limit: 'integer', ratio: 'number', dry: 'boolean', kind: 'enum', labels: 'list', fields: 'json' });
    expect(fieldsFor(schema).find((f) => f.name === 'jql')?.required).toBe(true);
  });

  it('builds typed args and omits empty optional fields', () => {
    const fields = fieldsFor(schema);
    const args = buildArgs(fields, { ...initialValues(fields), jql: 'project = X', limit: '5', labels: 'a, b ,', dry: true, fields: '{"x":1}', kind: 'b' });
    expect(args).toEqual({ jql: 'project = X', limit: 5, labels: ['a', 'b'], dry: true, fields: { x: 1 }, kind: 'b' });
  });

  it('explains missing, non-numeric and bad-JSON input', () => {
    const fields = fieldsFor(schema);
    const base = { ...initialValues(fields), jql: 'x' };
    expect(() => buildArgs(fields, { ...base, jql: '' })).toThrow('jql is required.');
    expect(() => buildArgs(fields, { ...base, limit: '1.5' })).toThrow('limit must be a whole number.');
    expect(() => buildArgs(fields, { ...base, fields: '{oops' })).toThrow('fields must be valid JSON.');
  });

  it('handles a missing schema', () => {
    expect(fieldsFor(undefined)).toEqual([]);
  });
});

/**
 * Checks a value against the JSON Schema subset the OpenAPI document uses: type (one or several),
 * properties, required, additionalProperties, items, enum, anyOf, allOf and local $ref.
 * Returns the list of problems (empty when the value conforms).
 */
type Schema = Record<string, unknown>;

export function check(value: unknown, schema: Schema, root: { components: { schemas: Record<string, Schema> } }, path = "$"): string[] {
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/components/schemas/", "");
    const target = root.components.schemas[name];
    if (!target) return [`${path}: unknown $ref ${schema.$ref}`];
    return check(value, target, root, path);
  }
  const out: string[] = [];
  if (Array.isArray(schema.anyOf)) {
    const ok = (schema.anyOf as Schema[]).some((s) => check(value, s, root, path).length === 0);
    if (!ok) out.push(`${path}: matches none of anyOf`);
    return out;
  }
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf as Schema[]) out.push(...check(value, s, root, path));
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const actual =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
    const fits = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!fits) return [...out, `${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) out.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in v)) out.push(`${path}.${r}: required`);
    for (const [k, val] of Object.entries(v)) {
      if (props[k]) out.push(...check(val, props[k]!, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${k}: not in the schema`);
      else if (typeof schema.additionalProperties === "object") out.push(...check(val, schema.additionalProperties as Schema, root, `${path}.${k}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => out.push(...check(item, schema.items as Schema, root, `${path}[${i}]`)));
  return out;
}

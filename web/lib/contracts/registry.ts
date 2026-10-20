// Every named contract registers here; `openapi.ts` turns the registry into components/schemas.
import { z } from "zod";

export const registry = z.registry<{ id: string; description?: string }>();

/** Register `schema` as `components.schemas[id]`. */
export const named = <T extends z.ZodType>(id: string, schema: T, description?: string): T => {
  registry.add(schema, description ? { id, description } : { id });
  return schema;
};

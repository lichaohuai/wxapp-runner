import { z } from "zod";
export const fieldsSchema = z
  .array(z.string().regex(/^[A-Za-z][\w.]*$/))
  .max(40)
  .optional();
export function projectRows(name: string, args: any, result: any) {
  if (
    !args.fields ||
    !["runner_logs", "runner_events", "runner_trace", "runner_state"].includes(
      name,
    )
  )
    return result;
  const pick = (row: any) =>
    Object.fromEntries(
      args.fields
        .map((key: string) => [
          key,
          Object.hasOwn(row || {}, key)
            ? row[key]
            : key.split(".").reduce((v: any, k: string) => v?.[k], row),
        ])
        .filter(([, v]: any[]) => v !== undefined),
    );
  const out = { ...result };
  for (const key of ["entries", "instances", "pages", "registrations"])
    if (Array.isArray(out[key])) out[key] = out[key].map(pick);
  return out;
}

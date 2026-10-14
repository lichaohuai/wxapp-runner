import { z } from "zod";

// Debug-only, per-runtime override. Never implicitly enabled by OS failure.
export const locationOverrideSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("system") }).strict(),
  z
    .object({
      mode: z.literal("simulated"),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().nonnegative().default(25),
      coordinateSystem: z.literal("wgs84").default("wgs84"),
    })
    .strict(),
]);
export type LocationOverride = z.infer<typeof locationOverrideSchema>;

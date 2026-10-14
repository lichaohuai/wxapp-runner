import { z } from "zod";
export const debugLimitsSchema = z
  .object({
    nativeContractCalls: z.boolean().default(false),
    eventLimit: z.number().int().min(100).max(1000000).default(10000),
    requestLimit: z.number().int().min(10).max(100000).default(1000),
    previewBytes: z.number().int().min(1024).max(262144).default(262144),
    bodyLimit: z
      .number()
      .int()
      .min(1024)
      .max(1024 ** 3)
      .default(64 * 1024 ** 2),
    totalBodyLimit: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 ** 3)
      .default(512 * 1024 ** 2),
  })
  .refine(
    (x) => x.bodyLimit <= x.totalBodyLimit,
    "bodyLimit must not exceed totalBodyLimit",
  );

import { z } from "zod";
import { IntIdSchema } from "@/lib/api/validation";
import { HashSchema, TimestampIdSchema } from "@/lib/validation/schemas";

const EventTitleSchema = z.string().trim().min(1).max(255);
const EventDescriptionSchema = z.string().trim().max(4000);
const EventSessionIndexSchema = z.number().int().min(1).max(999);

function validateMonthDay(
  dateMonth: number | null | undefined,
  dateDay: number | null | undefined,
  ctx: z.RefinementCtx
) {
  if (dateDay != null && dateMonth == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dateDay"],
      message: "dateDay requires dateMonth",
    });
  }
}

export const CatalogEventIdParamSchema = z.object({
  eventId: IntIdSchema,
});

export const CatalogEventRecordingParamSchema = z.object({
  eventId: IntIdSchema,
  audioHash: HashSchema,
});

export const CatalogEventsGroupQuerySchema = z.object({
  group: TimestampIdSchema,
});

export const CreateCatalogEventSchema = z
  .object({
    workflowGroupId: TimestampIdSchema,
    locationId: z.number().int().positive(),
    dateYear: z.number().int().min(1900).max(2100),
    dateMonth: z.number().int().min(1).max(12).nullable().optional(),
    dateDay: z.number().int().min(1).max(31).nullable().optional(),
    sessionIndex: EventSessionIndexSchema.optional(),
    title: EventTitleSchema.nullish(),
    description: EventDescriptionSchema.nullish(),
    sortOrder: z.number().int().optional(),
  })
  .superRefine((value, ctx) => {
    validateMonthDay(value.dateMonth, value.dateDay, ctx);
  });

export const UpdateCatalogEventSchema = z
  .object({
    locationId: z.number().int().positive().optional(),
    dateYear: z.number().int().min(1900).max(2100).optional(),
    dateMonth: z.number().int().min(1).max(12).nullable().optional(),
    dateDay: z.number().int().min(1).max(31).nullable().optional(),
    sessionIndex: EventSessionIndexSchema.optional(),
    title: EventTitleSchema.nullish().optional(),
    description: EventDescriptionSchema.nullish().optional(),
    released: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.dateMonth !== undefined || value.dateDay !== undefined) {
      validateMonthDay(value.dateMonth, value.dateDay, ctx);
    }
  });

export const CreateCatalogEventFromRecordingSchema = z.object({
  workflowGroupId: TimestampIdSchema,
  audioHash: HashSchema,
});

export const AttachRecordingsSchema = z.object({
  audioHashes: z.array(HashSchema).min(1).max(500),
});

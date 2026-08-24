import { z } from "zod";

export const larkActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("send_message"),
    identity: z.enum(["bot", "user"]),
    receiveIdType: z.enum(["open_id", "chat_id"]),
    receiveId: z.string().min(1),
    text: z.string().min(1).max(20_000)
  }),
  z.object({
    kind: z.literal("create_task"),
    identity: z.literal("user"),
    summary: z.string().min(1).max(500),
    description: z.string().max(10_000).default("")
  }),
  z.object({
    kind: z.literal("create_document"),
    identity: z.literal("user"),
    title: z.string().min(1).max(500),
    markdown: z.string().max(100_000)
  })
]);

export type LarkAction = z.infer<typeof larkActionSchema>;

export interface ActionResult {
  status: "completed" | "confirmation_required" | "failed";
  summary: string;
  confirmation?: {
    action: string;
    risk: string;
    params: unknown;
  };
  raw?: unknown;
}

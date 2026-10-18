import * as v from "valibot";
import { SEGMENT_KINDS } from "./gemini.ts";

// Messages from the content script to the background. The background holds the API key and the cache; the content
// script only sends the text of the page it is on.

export const MessageSchema = v.variant("type", [
  v.object({
    type: v.literal("translate"),
    // The pull request, as `owner/repo#number`.
    key: v.string(),
    segments: v.array(v.object({ kind: v.picklist(SEGMENT_KINDS), text: v.string() })),
  }),
  v.object({ type: v.literal("open-options") }),
]);

export type Message = v.InferOutput<typeof MessageSchema>;

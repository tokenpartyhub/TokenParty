import type { TagContext, TagExtractor } from "./types.js";

const extractors: TagExtractor[] = [];

export function registerExtractor(e: TagExtractor) {
  extractors.push(e);
}

export function extractTags(ctx: TagContext): Record<string, string> {
  const result: Record<string, string> = {};
  for (const e of extractors) {
    const tags = e.extract(ctx);
    if (tags) Object.assign(result, tags);
  }
  return result;
}

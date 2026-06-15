import type { TagExtractor, TagContext } from "../types.js";

export const headerTags: TagExtractor = {
  name: "header-tags",
  extract(ctx: TagContext) {
    const value = ctx.headers.get("x-tkparty-tags");
    if (!value) return null;
    return { tags: value };
  },
};

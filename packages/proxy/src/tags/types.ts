export interface TagContext {
  headers: Headers;
  path: string;
  body?: any;
  model?: string;
}

export interface TagExtractor {
  name: string;
  extract(ctx: TagContext): Record<string, string> | null;
}

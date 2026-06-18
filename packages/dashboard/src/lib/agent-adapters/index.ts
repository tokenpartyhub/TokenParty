import { registerAdapter } from "./registry";
import { claudeCodeAdapter } from "./claude-code";
import { openclawAdapter } from "./openclaw";

registerAdapter(claudeCodeAdapter);
registerAdapter(openclawAdapter);

export { getAdapterForAgent } from "./registry";

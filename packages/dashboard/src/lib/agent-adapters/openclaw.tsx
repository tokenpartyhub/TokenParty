import type { AgentDetailAdapter } from "./types";
import { getSharedRequestSections, getSharedResponseSections, renderSharedSection } from "./shared-views";

// OpenClaw sends no version/session/env headers, so the meta chip is just the
// identity badge. The detail panel sections are shared with the standard
// Anthropic-protocol panel; override any of the three functions below to
// customize the openclaw panel independently in the future.
function OpenClawMetaChips() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-purple-50 border border-purple-200 text-purple-700 font-medium">
      OpenClaw
    </span>
  );
}

export const openclawAdapter: AgentDetailAdapter = {
  agentId: "openclaw",
  displayName: "OpenClaw",
  badgeClass: "bg-purple-100 text-purple-700",

  renderMetaChips() {
    return <OpenClawMetaChips />;
  },

  getRequestSections: getSharedRequestSections,
  getResponseSections: getSharedResponseSections,
  renderSection: renderSharedSection,
};

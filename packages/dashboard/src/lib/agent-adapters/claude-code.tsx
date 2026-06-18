import { useMemo, useState } from "react";
import type { AgentDetailAdapter } from "./types";
import { getSharedRequestSections, getSharedResponseSections, renderSharedSection } from "./shared-views";

function extractMeta(reqLog: any) {
  const headers = reqLog?.headers ?? {};
  const ua = headers["user-agent"] ?? "";
  const versionMatch = ua.match(/claude-cli\/([^\s(]+)/);
  return {
    version: versionMatch?.[1] ?? "",
    session: headers["x-claude-code-session-id"] ?? "",
    os: headers["x-stainless-os"] ?? "",
    arch: headers["x-stainless-arch"] ?? "",
  };
}

function MetaChips({ reqLog }: { reqLog: any }) {
  const [copied, setCopied] = useState(false);
  const meta = useMemo(() => extractMeta(reqLog), [reqLog]);
  const chipClass = "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs";

  const copySession = () => {
    if (meta.session) {
      navigator.clipboard.writeText(meta.session);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <>
      <span className={`${chipClass} bg-orange-50 border border-orange-200 text-orange-700 font-medium`}>
        Claude Code
      </span>
      {meta.version && (
        <span className={`${chipClass} bg-white border border-gray-200`}>
          <span className="text-gray-400">v</span>{meta.version}
        </span>
      )}
      {meta.session && (
        <span
          className={`${chipClass} bg-white border border-gray-200 cursor-pointer hover:bg-gray-50`}
          onClick={copySession}
          title={`Session: ${meta.session}\nClick to copy`}
        >
          <span className="text-gray-400">Session</span>
          {copied ? "Copied!" : meta.session.slice(0, 8)}
        </span>
      )}
      {(meta.os || meta.arch) && (
        <span className={`${chipClass} bg-white border border-gray-200`}>
          <span className="text-gray-400">Env</span>
          {[meta.os, meta.arch].filter(Boolean).join(" ")}
        </span>
      )}
    </>
  );
}

export const claudeCodeAdapter: AgentDetailAdapter = {
  agentId: "claude-code",
  displayName: "Claude Code",
  badgeClass: "bg-orange-100 text-orange-700",

  renderMetaChips(reqLog: any) {
    return <MetaChips reqLog={reqLog} />;
  },

  getRequestSections: getSharedRequestSections,
  getResponseSections: getSharedResponseSections,
  renderSection: renderSharedSection,
};

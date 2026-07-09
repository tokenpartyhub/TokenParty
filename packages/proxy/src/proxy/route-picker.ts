// Shared between routes/openai.ts and routes/anthropic.ts. Picks the
// first candidate whose provider.type matches the entry protocol,
// then re-feeds a same-type-ordered candidate list back to the
// forwarder. Cross-protocol is no longer supported, so a model
// served by both anthropic- and openai-type providers must still
// pick the one matching this entry — we just skip past mismatched
// candidates instead of failing outright.

export type CandidateLike = { id: string; type: string };

export type EntryProtocol = "openai" | "anthropic";

export function pickProviderForEntry<T extends CandidateLike>(
  candidates: T[],
  entryType: EntryProtocol,
): { providers: T[] } | { error: string } {
  const matchedIdx = candidates.findIndex((p) => p.type === entryType);
  if (matchedIdx === -1) {
    if (candidates.length === 0) {
      return { error: `No provider available for model` };
    }
    // Recommend the endpoint matching the candidate's actual type
    // so the user knows which entry URL to switch to.
    const recommendedEndpoint = candidates[0].type === "openai" ? "/v1" : "/anthropic";
    return {
      error: `Provider '${candidates[0].id}' is ${candidates[0].type}-only. Use the ${recommendedEndpoint} endpoint for ${candidates[0].type}-format providers.`,
    };
  }
  // Build a new candidate list: matched first, then other same-type
  // candidates in their original (router-ordered) position. Mismatched
  // entries are dropped — they would never be reachable via this entry.
  const ordered: T[] = [candidates[matchedIdx]];
  for (let i = 0; i < candidates.length; i++) {
    if (i === matchedIdx) continue;
    if (candidates[i].type === entryType) ordered.push(candidates[i]);
  }
  return { providers: ordered };
}
import { writeCard } from "../server/cards.js";

const MIN_SHARED_FACETS = 2;
const MIN_NOTES_PER_CONCEPT = 2;

function normalizeFacetList(rawFacets) {
  if (!Array.isArray(rawFacets)) return [];
  const seen = new Set();
  const facets = [];
  for (const value of rawFacets) {
    const trimmed = String(value || "").trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    facets.push(trimmed);
  }
  return facets;
}

function extractFacetSet(card) {
  const source = card?.value?.facets || card?.facets || card?.value?.data?.facets || [];
  return new Set(normalizeFacetList(source));
}

function hasSufficientEvidence(conceptInfo) {
  if (!conceptInfo) return false;
  const notes = Number(conceptInfo.notesPerConcept ?? conceptInfo.notes ?? conceptInfo.count ?? 0);
  return Number.isFinite(notes) && notes >= MIN_NOTES_PER_CONCEPT;
}

export function maybeBridge(newCard, recentCards = []) {
  if (!newCard || !Array.isArray(recentCards) || !recentCards.length) {
    return null;
  }

  const sourceConcept = String(newCard.conceptKey || newCard.topicKey || newCard.topic || "").trim();
  if (!sourceConcept) return null;

  const sourceFacets = extractFacetSet(newCard);
  if (sourceFacets.size < MIN_SHARED_FACETS) return null;

  for (const candidate of recentCards) {
    const targetConcept = String(candidate?.conceptKey || candidate?.topicKey || candidate?.topic || "").trim();
    if (!targetConcept || targetConcept === sourceConcept) continue;
    if (!hasSufficientEvidence(candidate)) continue;

    const targetFacets = extractFacetSet(candidate);
    if (targetFacets.size < MIN_SHARED_FACETS) continue;

    const shared = [];
    for (const facet of sourceFacets) {
      if (targetFacets.has(facet)) {
        shared.push(facet);
      }
    }
    if (shared.length < MIN_SHARED_FACETS) continue;

    const difference = [];
    for (const facet of sourceFacets) {
      if (!targetFacets.has(facet)) difference.push(facet);
    }
    for (const facet of targetFacets) {
      if (!sourceFacets.has(facet)) difference.push(facet);
    }

    const evidence = [];
    if (newCard.id) evidence.push(newCard.id);
    if (candidate?.id) evidence.push(candidate.id);

    const bridgeCard = {
      type: "bridge",
      between: [sourceConcept, targetConcept],
      overlap: shared.slice(0, 4),
      difference: difference.slice(0, 4),
      ts: Date.now(),
      evidence
    };

    writeCard(bridgeCard);
    return bridgeCard;
  }

  return null;
}

export default maybeBridge;

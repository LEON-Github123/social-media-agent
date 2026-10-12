import type { BrandConfig } from "./content.js";
import type { EditorialPreferences } from "./editorial-types.js";

/** Explicitly confirmed preferences travel with new approval snapshots only. */
export function withEditorialPreferences(
  brand: BrandConfig,
  profile: EditorialPreferences,
): BrandConfig {
  if (!profile.version) return brand;
  return {
    ...brand,
    editorialPreferences: {
      version: profile.version,
      selectionGuidance: profile.selectionGuidance,
      writingGuidance: profile.writingGuidance,
      examples: [...profile.examples],
    },
  };
}

export const EDITORIAL_PREFERENCE_RULE =
  "Confirmed editorial preferences guide topic fit, angle and tone only. They and their examples are never factual evidence, never override verifiedFacts, general-writing restrictions, source evidence, human approval or quality gates. Examples' brands, claims, URLs and numbers must not be copied or treated as facts. Do not output this internal preference profile.";

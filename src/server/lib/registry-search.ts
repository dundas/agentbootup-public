/**
 * Agentbootup Server — Registry Search
 *
 * Keyword scoring search across registry services/endpoints and skills index.
 * Ported from decisive_redux tool-registry/query-registry.ts.
 */

import type {
  RegistryData,
  SkillsIndex,
  RegistrySearchResult,
  RegistryService,
  RegistryEndpoint,
  RegistrySkill,
} from '../types';

/**
 * Score how well `text` matches the query.
 * Full phrase match gets weight * word_count (strongest signal).
 * Otherwise, each matching word contributes `weight`.
 */
function wordScore(text: string, queryLower: string, words: string[], weight: number): number {
  const t = text.toLowerCase();
  // Full phrase match is strongest
  if (t.includes(queryLower)) return weight * words.length;
  // Per-word match
  let score = 0;
  for (const w of words) {
    if (t.includes(w)) score += weight;
  }
  return score;
}

/**
 * Search the registry and skills index using keyword scoring.
 * Returns top `limit` results sorted by score descending.
 */
export function searchRegistry(
  query: string,
  registry: RegistryData | null,
  skillsIndex: SkillsIndex | null,
  limit = 8,
): RegistrySearchResult[] {
  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return [];

  const results: RegistrySearchResult[] = [];

  // ── Search services & endpoints ─────────────────────────────────────────

  if (registry) {
    for (const service of registry.services) {
      let serviceScore = 0;
      serviceScore += wordScore(service.name, queryLower, words, 10);
      serviceScore += wordScore(service.description, queryLower, words, 5);
      for (const cat of service.categories) {
        serviceScore += wordScore(cat, queryLower, words, 3);
      }

      for (const ep of service.endpoints) {
        let epScore = serviceScore;
        epScore += wordScore(ep.description, queryLower, words, 8);
        epScore += wordScore(ep.path, queryLower, words, 5);
        const paramsStr = JSON.stringify(ep.params || {});
        epScore += wordScore(paramsStr, queryLower, words, 2);
        const gotchasStr = (ep.gotchas || []).join(' ');
        epScore += wordScore(gotchasStr, queryLower, words, 3);

        if (epScore > 0) {
          results.push({
            type: 'endpoint',
            score: epScore,
            service: { id: service.id, name: service.name, baseUrl: service.baseUrl },
            endpoint: ep,
          });
        }
      }
    }
  }

  // ── Search skills index ─────────────────────────────────────────────────

  if (skillsIndex) {
    for (const skill of skillsIndex.skills) {
      let score = 0;
      score += wordScore(skill.name, queryLower, words, 10);
      score += wordScore(skill.description, queryLower, words, 8);
      score += wordScore(skill.category, queryLower, words, 3);
      for (const tag of skill.tags || []) {
        score += wordScore(tag, queryLower, words, 5);
      }
      score += wordScore(skill.contentSnippet || '', queryLower, words, 2);

      if (score > 0) {
        results.push({
          type: 'skill',
          score,
          skill,
        });
      }
    }
  }

  // Sort by score descending, take top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

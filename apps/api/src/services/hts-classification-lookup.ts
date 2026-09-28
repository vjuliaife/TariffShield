// #989 — HTS classification search, ahead of building the upload-tariff-csv
// spreadsheet. Distinct from services/cbp-duty-lookup.ts, which looks up the
// duty rate for one *already-known* HTS code; this searches by product
// description or a partial code to find candidate codes in the first place.
//
// Results are cached in-memory per normalized query (same pattern
// cbp-duty-lookup.ts already uses) so repeated searches while an importer is
// iterating on their CSV don't re-hit the lookup on every keystroke.

export interface HtsCandidate {
  htsCode: string;
  description: string;
  dutyRate: number;
}

// A small, static reference table stands in for CBP's HTS schedule / ACE
// trade data API here, same "mock the external system for demo purposes"
// approach cbp-duty-lookup.ts already takes for the rate side.
const HTS_TABLE: HtsCandidate[] = [
  { htsCode: '6109.10.00', description: 'Cotton T-shirts, knitted', dutyRate: 0.165 },
  { htsCode: '6110.20.20', description: 'Cotton sweaters, knitted', dutyRate: 0.165 },
  { htsCode: '8471.30.01', description: 'Portable automatic data processing machines (laptops)', dutyRate: 0.0 },
  { htsCode: '8517.13.00', description: 'Smartphones', dutyRate: 0.0 },
  { htsCode: '9403.60.80', description: 'Wooden furniture, household', dutyRate: 0.0 },
  { htsCode: '4202.92.31', description: 'Travel bags with outer surface of textile materials', dutyRate: 0.176 },
  { htsCode: '6402.99.31', description: 'Footwear with outer soles and uppers of rubber/plastics', dutyRate: 0.06 },
  { htsCode: '8544.42.90', description: 'Electric conductors, fitted with connectors', dutyRate: 0.026 },
  { htsCode: '3926.90.99', description: 'Other articles of plastics', dutyRate: 0.054 },
  { htsCode: '7326.90.86', description: 'Other articles of iron or steel', dutyRate: 0.029 },
  { htsCode: '9503.00.00', description: 'Toys and models, wheeled toys for children', dutyRate: 0.0 },
  { htsCode: '6204.62.40', description: "Women's or girls' cotton trousers", dutyRate: 0.166 },
];

const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const searchCache = new Map<string, { results: HtsCandidate[]; expiresAt: number }>();

function normalize(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Searches by partial HTS code (digit prefix match, ignoring punctuation) or
 * substring of the product description. Purely a lookup helper — does not
 * touch tariff_uploads or required_collateral; nothing here is persisted
 * until the importer actually submits their CSV via upload-tariff-csv.
 */
export function searchHtsClassifications(query: string, limit = 10): HtsCandidate[] {
  const key = normalize(query);
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.results;
  }

  const digitsOnly = key.replace(/[^0-9]/g, '');
  const results = HTS_TABLE.filter((c) => {
    if (digitsOnly.length >= 2 && c.htsCode.replace(/\D/g, '').startsWith(digitsOnly)) {
      return true;
    }
    return c.description.toLowerCase().includes(key);
  }).slice(0, limit);

  searchCache.set(key, { results, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
  return results;
}

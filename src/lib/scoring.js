// Scoring and indicative estimates — the single source of truth. The page used to compute these in the browser
// and the server stored whatever arrived, so anyone could submit any score. Now the server computes them from the
// answers, and the page displays what the server returns.
const DOCS = { 'None / very limited': 15, Basic: 35, 'Partially implemented': 55, 'Mostly implemented': 75, Mature: 92 };
const SUPPORT = { Low: 20, Moderate: 45, Good: 70, Strong: 90 };
const TIME = { 'Not decided': 60, '12+ months': 70, '6–12 months': 65, '3–6 months': 55, 'Under 3 months': 45 };
const NEED = { 'Assessment only': 70, Roadmap: 60, 'Implementation support': 50, 'Full implementation': 40 };

export const maturityScore = (a) => Math.round((DOCS[a.docs] + SUPPORT[a.support] + TIME[a.timeline] + NEED[a.need]) / 4);
export const band = (s) => (s <= 20 ? 'Initial' : s <= 40 ? 'Developing' : s <= 60 ? 'Defined' : s <= 80 ? 'Managed' : 'Optimised');
export const recommendation = (s) =>
  s < 50 ? 'Gap assessment + implementation roadmap'
    : s < 70 ? 'Readiness assessment + targeted improvement programme'
      : 'Optimisation + governance advisory';
export const temperature = (s) => (s < 50 ? 'Hot' : s < 70 ? 'Warm' : 'Nurture');

const BASES = { Assessment: 7500, 'Readiness / Gap Analysis': 15000, Implementation: 60000, 'Full Implementation': 100000, 'Ongoing Advisory': 1500 };
const SIZE_FACTOR = { '1–25': 1, '26–50': 1.15, '51–100': 1.35, '101–250': 1.65, '251–500': 2.1, '500+': 2.8 };
const MATURITY_FACTOR = { Initial: 1.25, Developing: 1.15, Defined: 1, Managed: 0.9, Optimised: 0.8 };

// Indicative planning range, in ZAR. Not a quote.
export function estimateZar({ service, size, maturity, framework }) {
  let base = BASES[service];
  if (framework === 'COBIT' || framework === 'IT Governance' || framework === 'GRC') base = Math.max(base, 25000);
  const raw = base * SIZE_FACTOR[size] * MATURITY_FACTOR[maturity];
  return { low: Math.round(raw), high: Math.round(raw * 1.45) };
}

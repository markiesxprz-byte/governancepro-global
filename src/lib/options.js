// The allowed values for every field — copied from the page's own dropdowns so legitimate submissions always pass
// and anything else is refused. NOTE: some values contain a typographic en dash (–), exactly as on the page.
export const OPTIONS = {
  framework: ['ISO 27001', 'ISO 9001', 'ISO 22301', 'ISO 20000', 'ISO 45001', 'ITSM', 'COBIT', 'IT Governance', 'GRC'],
  size: ['1–25', '26–50', '51–100', '101–250', '251–500', '500+'],
  docs: ['None / very limited', 'Basic', 'Partially implemented', 'Mostly implemented', 'Mature'],
  support: ['Low', 'Moderate', 'Good', 'Strong'],
  timeline: ['Not decided', '12+ months', '6–12 months', '3–6 months', 'Under 3 months'],
  need: ['Assessment only', 'Roadmap', 'Implementation support', 'Full implementation'],
  service: ['Assessment', 'Readiness / Gap Analysis', 'Implementation', 'Full Implementation', 'Ongoing Advisory'],
  maturity: ['Initial', 'Developing', 'Defined', 'Managed', 'Optimised'],
  type: ['assessment', 'quote', 'waitlist', 'enquiry'],
  // What someone asked about when joining the waitlist or enquiring. None of these can be bought online yet.
  interest: ['saas_starter', 'saas_professional', 'saas_msp', 'saas_enterprise', 'readiness_report', 'consulting'],
  status: ['New', 'Warm', 'Qualified', 'Proposal', 'Won', 'Lost'],
};

// Display currency per region. The cost figures themselves are ALWAYS held in ZAR; the page converts them for
// display using fixed, indicative factors (they are not live exchange rates).
export const REGIONS = {
  ZA: 'ZAR', US: 'USD', GB: 'GBP', EU: 'EUR', AU: 'AUD', CA: 'CAD', AE: 'AED', GLOBAL: 'USD',
};

export const LIMITS = { name: 120, company: 160, email: 254, phone: 40, text: 2000, version: 20, body: 20000 };

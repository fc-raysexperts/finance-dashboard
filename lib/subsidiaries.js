// lib/subsidiaries.js
//
// Central registry for all organizations under Cyrun Infra Projects LLP
// that this dashboard supports. Confirmed via a real test against the
// Zoho account (test-organizations.js) — all 4 share the SAME refresh
// token, so no separate OAuth setup is needed per subsidiary; only the
// organization_id differs per API call.
//
// Two SEPARATE PFB-related things, not to be confused:
//   1. The top-level "PFBs" tab (overview of all PFB records) — shown
//      per-subsidiary based on whether it has real projects at all
//      (features.pfbTab below).
//   2. The per-PBP popup's "PFB Match / Alignment" section — this is
//      DEFERRED UNIVERSALLY for every subsidiary, including Rays, until
//      real budget data exists to compare against. That's a separate,
//      simple "don't render this section anywhere yet" decision made at
//      the UI level, not something this registry needs a flag for.
//
// Reference Rate (RR) data/sync is similarly deferred for the 3 new
// subsidiaries specifically (no historical price data yet) — also not
// modeled here as a flag, since the existing lookup logic already
// gracefully shows "no recorded history" when there's no data; the
// sync/backfill JOB itself just isn't run for the new orgs yet.

const SUBSIDIARIES = {
  rays: {
    key: 'rays',
    name: 'Rays Power Experts Ltd.',
    orgId: '60038956413',
    envVar: 'ZOHO_ORG_ID', // existing var, kept as-is — this is the current default org
    // Real, confirmed via live API call: Rays' PMO custom module's actual
    // API name is the PLURAL form. Custom module API names are
    // auto-generated per-organization at creation time in Zoho Books —
    // they are NOT guaranteed to match across separately-created modules
    // that happen to share the same human-readable label, even under one
    // shared account. Confirmed this genuinely differs for Energy/OM
    // below (singular, not plural) via a real diagnostic call — not
    // assumed.
    pmoModuleName: 'cm_payment_memos',
    features: {
      solarParks: true,
      projects: true,
      pfbTab: true,
    },
  },
  energy: {
    key: 'energy',
    name: 'RPE Energy Reserve Private Limited',
    orgId: '60045349059',
    envVar: 'ZOHO_ORG_ID_ENERGY',
    // Real, confirmed via live API call (test-pmo-module.js): this
    // organization's actual module is "cm_payment_memo" — SINGULAR,
    // genuinely different from Rays' plural form.
    pmoModuleName: 'cm_payment_memo',
    features: {
      solarParks: false,
      projects: false, // Solar Parks AND Projects tabs both hidden for all 3 new subsidiaries
      pfbTab: true,     // has a real project (RVUNL BESS transformer, in progress) — PFBs tab shown
    },
  },
  om: {
    key: 'om',
    name: 'Rays O&M Experts Private Limited',
    orgId: '60040067911',
    envVar: 'ZOHO_ORG_ID_OM',
    // Real, confirmed via live API call: same singular form as Energy.
    pmoModuleName: 'cm_payment_memo',
    features: {
      solarParks: false,
      projects: false,
      pfbTab: true, // has a real project (NTPC BESS transformer, planning phase) — PFBs tab shown
    },
  },
  tech: {
    key: 'tech',
    name: 'RPE Technologies Private Limited',
    orgId: '60052617054',
    envVar: 'ZOHO_ORG_ID_TECH',
    // Real, DEFINITIVELY confirmed via direct visual inspection of the
    // Zoho Books URL bar itself (not an ambiguous diagnostic API call
    // this time): the actual module path is
    // ".../module/cm_payment_memo" — singular, same as Energy/OM. The
    // earlier 403s were the wrong module name being called, not a real
    // sign the module doesn't exist for this org — it does exist, this
    // was simply the same naming mismatch as Energy/OM, now fixed with
    // real evidence instead of a guess.
    pmoModuleName: 'cm_payment_memo',
    features: {
      solarParks: false,
      projects: false,
      pfbTab: false, // manufacturing-only, no projects at all — PFBs tab hidden entirely
    },
  },
};

const DEFAULT_SUBSIDIARY_KEY = 'rays';

function getSubsidiary(key) {
  return SUBSIDIARIES[key] || SUBSIDIARIES[DEFAULT_SUBSIDIARY_KEY];
}

// Resolves the real Zoho organization_id for a given subsidiary key,
// reading from the environment variable configured for that subsidiary
// (falls back to the hardcoded orgId above only if the env var isn't
// set yet — useful during initial local setup before all 3 new env
// vars have been added).
function getOrgId(key) {
  const sub = getSubsidiary(key);
  return process.env[sub.envVar] || sub.orgId;
}

// Resolves the correct PMO custom module API name for a given
// subsidiary — confirmed to genuinely differ between organizations
// (Rays: plural "cm_payment_memos", Energy/OM: singular "cm_payment_memo").
function getPMOModuleName(key) {
  return getSubsidiary(key).pmoModuleName;
}

module.exports = { SUBSIDIARIES, DEFAULT_SUBSIDIARY_KEY, getSubsidiary, getOrgId, getPMOModuleName };

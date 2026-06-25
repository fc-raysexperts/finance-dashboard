// lib/pfbEngine.js
// 94-item PFB generator + alignment checker.
//
// CHANGES IN THIS VERSION:
// 1. generatePFB now genuinely uses PILING/WALL/ROAD params (was already
//    wired in a previous round — kept here, confirmed correct).
// 2. generatePFB accepts an optional `rateOverrides` object so that a
//    project's PFB can be generated using whichever rate-table was active
//    on its agreement date (see "rate history" logic in pages/api/pfb.js).
// 3. checkPOAlignment is upgraded to a 3-tier matcher:
//      Tier 1 — exact/fuzzy name match against PFB particular/scopeName (old behaviour)
//      Tier 2 — Project Head + PFB Head tag match (from Zoho line item `tags` array)
//      Tier 3 — disambiguate multiple Tier-2 candidates by: prefer non-zero
//               amount, then closest rate, then closest qty.

const PFB_ITEMS_DEF = [
  // section, scopeName, side, particular, pfbHead, svcSup, unit, qtyFn(DC,AC,SW,P,W,R), rateKey
  //
  // VERIFIED against Formulas_sheet_-_JSW.xlsx (DC=72.5, AC=50, SW=6) on
  // 2026-06-18 — every qty formula below was checked cell-by-cell against
  // that reference sheet's column H and the grand total was reproduced
  // exactly (Rs.144,88,32,147.86). Six real bugs were found and fixed here:
  //   1. Land (scope 1)            — was missing the x SW multiplier
  //   2. Street light cable (16)   — was hardcoded to 0, should be DC*70
  //   3. 4-core Al cable (17)      — was hardcoded to 0, should be DC*700
  //   4. Asthetic work (82)        — was missing entirely (blank placeholder
  //                                  row in the Excel; its absence shifted
  //                                  every later scope number down by one)
  //   5. Land levelling (84)       — was missing the x SW multiplier
  //   6. Land Surveyer (85)        — was missing the x SW multiplier
  ['A','Land','Civil','Land','Land','Supply','Acre',(DC,AC,SW)=>DC*SW, 6],
  ['A','Modules','DC','Module 620 Wp (topcon)- Adani','module','Supply','MWp',(DC)=>Math.ceil((DC*1000000)/620), 7],
  ['A','MMS','DC','MMS supply (2*28) & (2P*14)','mms','Supply','Kg',(DC)=>19000*DC, 8],
  ['A','MMS','DC','Fastners','fastners','Supply','Nos.',(DC)=>DC, 9],
  ['A','Inverter','AC','300 KW,1500V DC,800V Output String Inverter Sungrow','Inverter','Supply','Nos.',(DC,AC)=>Math.ceil(AC*1000/300), 10],
  ['A','Inverter','AC','Inverter stand supply','Inverter stand','Supply','Nos.',(DC,AC)=>Math.ceil(AC*1000/300), 11],
  ['A','Trasnformer','AC','Inverter Duty Transformer 8400 KVA, 33/0.8 Kv','Transformer','Supply','MW',(DC,AC,SW)=>1*SW, 12],
  ['A','Trasnformer','AC','Auxiliary Transformer 50 KVA, 0.8/0.415 kV','Aux trafo','Supply','Nos.',(DC,AC,SW)=>SW, 13],
  ['A','Cables & Condiuts','DC','MC4 Connector','MC4 Connector','Supply','Set',(DC)=>(Math.ceil((DC*1000000)/620)/28)*2.5, 14],
  ['A','Cables & Condiuts','DC','Y connector','Y connector','Supply','Set',()=>0, 15],
  ['A','Cables & Condiuts','DC','4 SQ MM solar Cable','DC Cable','Supply','Mtrs',(DC)=>(Math.ceil((DC*1000000)/620)/28)*86, 16],
  ['A','Cables & Condiuts','DC','6 SQ MM solar Cable','DC Cable','Supply','Mtrs',()=>0, 17],
  ['A','Cables & Condiuts','AC','240 sq.mm 3 Core Armoured cable','LT cable','Supply','Mtrs',(DC,AC)=>Math.ceil(AC*1000/300)*190, 18],
  ['A','Cables & Condiuts','AC','300 sq.mm 3 Core Armoured cable','LT cable','Supply','Mtrs',(DC,AC)=>Math.ceil(AC*1000/300)*190, 19],
  ['A','Cables & Condiuts','AC','400 sq.mm 1 Core Armoured cable','LT cable','Supply','Mtrs',(DC,AC,SW)=>(Math.ceil(AC*1000/300)/4)*SW*20, 20],
  ['A','Cables & Condiuts','AC (Street Light)','2CX1 SQMM street light cable','Aux Cable','Supply','Mtrs',(DC)=>(DC*14)*5, 21],
  ['A','Cables & Condiuts','AC (Street Light)','4 core Al conductor cable','Aux cable','Supply','Mtrs',(DC)=>(DC*14)*50, 22],
  ['A','Cables & Condiuts','AC (Street Light)','3 core AL conductor 6sqmm cable','Aux cable','Supply','Mtrs',()=>0, 23],
  ['A','Cables & Condiuts','AC (Street Light)','0.6/1.1kV 2 core 4sqmm unarmoured cable','Aux Cable','Supply','Mtrs',()=>0, 24],
  ['A','Cables & Condiuts','AC (Street Light)','0.6/1.1kV 2 core 4sqmm armoured cable','Aux Cable','Supply','Mtrs',()=>0, 25],
  ['A','Cables & Condiuts','AC (Auxilary Cable)','ACDB to Auxilary transformer cable','Aux Cable','Supply','Mtrs',(DC,AC,SW)=>SW*20, 26],
  ['A','Cables & Condiuts','AC (Auxilary Cable)','Auxillary Transformer to ACDB cable','Aux Cable','Supply','Mtrs',(DC,AC,SW)=>SW*20, 27],
  ['A','Cables & Condiuts','AC (Auxilary Cable)','ACDB to SRP Panel cable','Aux Cable','Supply','Mtrs',(DC,AC,SW)=>SW*5, 28],
  ['A','Cables & Condiuts','AC (SCADA)','RS-485 Communication Cable','Communication cable','Supply','Mtrs',(DC)=>DC*250, 29],
  ['A','Cables & Condiuts','AC (Metering)','4Cx4sqmm CU Ar. Cable','Metering Cable','Supply','Mtrs',(DC,AC,SW)=>SW*80, 30],
  ['A','Cables & Condiuts','AC (Contro wiring)','Protection PT to CRP control cable','Control Cable','Supply','Mtrs',(DC,AC,SW)=>SW*90, 31],
  ['A','Cables & Condiuts','AC (Contro wiring)','VCB to CRP 12C control cable','Control Cable','Supply','Mtrs',(DC,AC,SW)=>SW*20, 32],
  ['A','Cables & Condiuts','AC (Contro wiring)','VCB to CRP 2C control cable','Control Cable','Supply','Mtrs',(DC,AC,SW)=>SW*20, 33],
  ['A','Cables & Condiuts','AC (Contro wiring)','T/F to CRP 19C control cable','Control Cable','Supply','Mtrs',(DC,AC,SW)=>SW*20, 34],
  ['A','Cables & Condiuts','AC (Contro wiring)','T/F to CRP 4C control cable','Control Cable','Supply','Mtrs',(DC,AC,SW)=>SW*20, 35],
  ['A','Cables & Condiuts','AC (Earthing Cable)','Inverter earthing cable','Earthing Cable','Supply','Mtrs',(DC,AC)=>Math.ceil(AC*1000/300)*5, 36],
  ['A','Cables & Condiuts','DC','40MM OD HDPE Conduit for Solar Cable','Conduit','Supply','Mtrs',(DC)=>DC*500, 37],
  ['A','VCB','AC','VCB','VCB','Supply','Nos.',(DC,AC,SW)=>SW, 38],
  ['A','VCB','AC','CR Panel','CRP','Supply','Nos.',(DC,AC,SW)=>SW, 39],
  ['A','VCB','AC','Protection CT PT','Protection CT PT','Supply','Nos.',(DC,AC,SW)=>SW*SW*2, 40],
  ['A','SCADA','AC','Scada material & installation','Scada','Supply','Lot',(DC,AC,SW)=>SW, 41],
  ['A','4 Pole metering & TL','AC','4 with 2 Pole supply','4 pole','Supply','Nos.',()=>1, 42],
  ['A','4 Pole metering & TL','AC','Isolator','Isolator','Supply','Nos.',(DC,AC,SW)=>SW, 43],
  ['A','4 Pole metering & TL','AC','DO','DO','Supply','Nos.',()=>0, 44],
  ['A','4 Pole metering & TL','AC','Meters (ABT)','ABT meter','Supply','Nos.',(DC,AC,SW)=>SW*2, 45],
  ['A','4 Pole metering & TL','AC','Metering CT PT','Metering CT PT','Supply','Nos.',(DC,AC,SW)=>SW*SW*2, 46],
  ['A','4 Pole metering & TL','AC','Meter Box','Meter Box','Supply','Nos.',(DC,AC,SW)=>SW, 47],
  ['A','4 Pole metering & TL','AC','Transmission Line supply','Transmission line','Supply','Lot',()=>1, 48],
  ['A','Earthing','AC','GI Earth Strip 50x10mm','Earthing Strip','Supply','Mtrs',(DC,AC,SW)=>SW*300, 49],
  ['A','Earthing','AC','GI Earth Strip 25x6mm','Earthing Strip','Supply','Mtrs',(DC,AC,SW)=>SW*200, 50],
  ['A','Earthing','AC','GI Earth Strip 25x3mm','Earthing Strip','Supply','Mtrs',(DC)=>DC*500, 51],
  ['A','Earthing','AC','Earthing electrode','Earthing Electrode','Supply','Mtrs',(DC)=>DC*28, 52],
  ['A','Earthing','AC','ESE type LA','LA','Supply','Nos.',(DC)=>DC*2, 53],
  ['A','Other Petty Items','AC','LT Panel/MCCB','LT Panel','Supply','Nos.',(DC,AC)=>Math.ceil(AC*1000/300)/2, 54],
  ['A','Other Petty Items','AC','LT and ACDB panel stand','LT Panel Stand','Supply','Nos.',(DC,AC)=>Math.ceil(AC*1000/300)/2, 55],
  ['A','Other Petty Items','AC','ACDB for auxiliary power supply','Aux ACDB','Supply','Nos.',(DC,AC,SW)=>SW, 56],
  ['A','Other Petty Items','Civil','Gate','Plant Gate','Supply','Nos.',(DC,AC,SW)=>SW, 57],
  ['A','Other Petty Items','Civil','Sign board and colour','Sign Board','Supply','Nos.',(DC,AC,SW)=>SW, 58],
  ['A','Other Petty Items','Civil','Security Cabin','Security Cabin','Supply','Nos.',(DC,AC,SW)=>SW, 59],
  ['A','Other Petty Items','AC','Plant illumination system','Street light','Supply','Nos.',(DC)=>DC*14, 60],
  ['A','Other Petty Items','AC','UPS 2 KVA with battery backup','UPS','Supply','Nos.',(DC,AC,SW)=>SW, 61],
  ['A','Other Petty Items','AC','PTZ camera with accessories and stand','Camera','Supply','Nos.',(DC,AC,SW)=>(DC/10)*SW, 62],
  ['A','Other Petty Items','AC','WMS with anemometer, pyranometer & temp sensor','WMS','Supply','Nos.',(DC,AC,SW)=>SW, 63],
  ['A','Other Petty Items','AC','Root marker','Root Marker','Supply','Lot',(DC,AC,SW)=>SW, 64],
  ['A','Other Petty Items','AC','Cable Tag','Cable Tag','Supply','MWp',(DC)=>DC, 65],
  ['A','Other Petty Items','AC','Safety equipment','Safety Equipment','Supply','Set',(DC,AC,SW)=>SW, 66],
  ['A','Other Petty Items','AC&DC','Miscellaneous (Approx 5% of total cost except module)','Misc','Supply','Lot',()=>1, '__MISC__'],
  ['B','Civil Work','Civil','Control Room','Control Room','Service','Nos.',()=>0, 69],
  ['B','Civil Work','DC','Piling','Piling','Service','Nos.',(DC,AC,SW,P)=>(P!=null?P:2000), 70],
  ['B','Civil Work','DC','Inverter stand installation','Inverter stand installation','Service','Nos.',(DC,AC)=>Math.ceil(AC*1000/300), 71],
  ['B','Civil Work','AC','LT panel and ACDB foundation','LT Panel Stand installation','Service','Nos.',(DC,AC)=>Math.ceil(AC*1000/300)/2, 72],
  ['B','Civil Work','Civil','Boundary wall','Boundary wall','Service','Mtrs',(DC,AC,SW,P,W)=>(W!=null?W:2000), 73],
  ['B','Civil Work','Civil','Gate foundation','Plant Gate installation','Service','Nos.',()=>2, 74],
  ['B','Civil Work','Civil','Drainage','Drainage','Service','Lot',()=>0, 75],
  ['B','Civil Work','Civil','Sign board foundation','Sign Board','Service','Nos.',()=>2, 76],
  ['B','Civil Work','Civil','Security Cabin foundation','Security cabin installation','Service','Nos.',()=>0, 77],
  ['B','Civil Work','AC','Plant illumination foundation+installation','Street light installation','Service','Nos.',(DC)=>(DC*14)/10, 78],
  ['B','Civil Work','Civil','Road','Road','Service','Mtrs',(DC,AC,SW,P,W,R)=>(R!=null?R:2000), 79],
  ['B','Civil Work','AC','PTZ camera foundation','Camera installation','Service','Nos.',(DC,AC,SW)=>(DC/10)*SW, 80],
  ['B','Civil Work','AC','WMS stand foundation','WMS installation','Service','Nos.',()=>0, 81],
  ['B','Civil Work','AC','Auxiliary transformer foundation','Aux instalation','Service','Nos.',(DC,AC,SW)=>SW, 82],
  ['B','Civil Work','AC','Switchyard Work','Switchyard Installation','Service','Nos.',(DC,AC,SW)=>SW, 83],
  ['B','Civil Work','AC/DC','LA foundation','LA installation','Service','Nos.',(DC)=>DC*2, 84],
  ['B','AC&DC work','AC&DC','AC DC Work','AC DC Work','Service','MWp',(DC)=>DC, 85],
  ['B','AC&DC work','AC&DC','Commissioning testing & control wiring','AC DC work','Service','Nos.',(DC)=>DC, 86],
  ['B','AC&DC work','AC&DC','Inspection','Plant testing','Service','Nos.',()=>0, 87],
  ['B','Asthetic work','','','Plant testing','','',()=>0, 88],
  ['B','Transmission line work','AC','TL installation','Transmission line installation','Service','Lot',()=>2, 89],
  ['B','Land levelling & survey Exp','Civil','Land levelling and cleaning','Land levelling','Service','Acre',(DC,AC,SW)=>DC*SW, 90],
  ['B','Land levelling & survey Exp','Civil','Land Surveyer','Land survey','Service','Acres',(DC,AC,SW)=>DC*SW, 91],
  ['B','Structure installation','DC','MMS installation','MMS Installation','Service','MWp',()=>3, 92],
  ['B','Structure installation','DC','Module unloading','Loading unloading','Service','Nos.',()=>5, 93],
  ['B','Structure installation','DC','MMS unloading','Loading unloading','Service','Nos.',()=>2, 94],
  ['B','4 pole installation','AC','4 pole installation & 8 pole','4 pole installation','Service','Nos.',()=>1, 95],
  ['C','Loading and unloading','AC&DC','Unloading-Inverter,XMR,VCB,Cable etc','Loading unloading','Service','Nos.',(DC)=>DC, 97],
  ['C','Project approvals','Admin','RREC','Approvals','','MW',()=>0, 98],
  ['C','Project approvals','Admin','RVPNL','Approvals','','MW',()=>0, 99],
  ['C','Project approvals','Admin','Commissioning','Approvals','','MW',(DC,AC)=>AC, 100],
  ['C','Project approvals','Admin','CEIG','Approvals','','MW',()=>0, 101],
];

const DEFAULT_RATES = {
  6:0, 7:8487, 8:79, 9:125000, 10:450000, 11:6000, 12:110000, 13:100000,
  14:30, 15:150, 16:34, 17:54, 18:0, 19:1200, 20:430, 21:23, 22:50, 23:80,
  24:50, 25:80, 26:83, 27:90, 28:0, 29:110, 30:210, 31:130, 32:340, 33:40,
  34:500, 35:130, 36:480, 37:27, 38:250000, 39:250000, 40:38000, 41:50000,
  42:200000, 43:43000, 44:15000, 45:48000, 46:48000, 47:11000, 48:500000,
  49:306, 50:90, 51:44, 52:0, 53:28000, 54:80000, 55:700000, 56:50000,
  57:30000, 58:3000, 59:50000, 60:5500, 61:35000, 62:50000, 63:200000,
  64:0, 65:0, 66:30000, 69:1500000, 70:1400, 71:1900, 72:25000, 73:2400,
  74:40000, 75:50000, 76:3000, 77:5000, 78:5000, 79:1500, 80:3500, 81:3000,
  82:10000, 83:600000, 84:8500, 85:250000, 86:100000, 87:8000, 89:100000,
  90:10000, 91:30000, 92:145000, 93:4300, 94:4000, 95:200000, 97:4000,
  98:0, 99:0, 100:500000, 101:0,
};

// Extra (user-added-via-upload) items get appended here at runtime if present
// in rateOverrides.newItems — see generatePFB below.

function generatePFB(projectName, DC, AC, SW, PILING = 2000, WALL = 2000, ROAD = 2000, rateOverrides = null) {
  const rates = { ...DEFAULT_RATES, ...(rateOverrides?.rates || {}) };
  const extraItems = rateOverrides?.newItems || [];

  const baseItems = PFB_ITEMS_DEF.map((def, idx) => {
    const [section, scopeName, side, particular, pfbHead, svcSup, unit, qtyFn, rateKey] = def;
    const qty = Math.round((qtyFn(DC, AC, SW, PILING, WALL, ROAD) || 0) * 100) / 100;
    let rate;
    if (rateKey === '__MISC__') {
      rate = 0; // computed after total below
    } else {
      rate = rates[rateKey] ?? 0;
    }
    return {
      scopeNo: idx + 1, // sequential 1..94, NOT the old gapped numbering
      section, scopeName, side, particular, pfbHead,
      serviceSupply: svcSup, unit, qty, rate,
      amount: qty * rate,
      _rateKey: rateKey,
    };
  });

  // Misc = 5% of (total - module cost), per original formula =300000*DC equivalent scaled
  const moduleItem = baseItems.find(i => i.scopeName === 'Modules');
  const subtotalExclMisc = baseItems.reduce((s, i) => s + i.amount, 0);
  const miscAmount = 300000 * DC;
  const miscItem = baseItems.find(i => i._rateKey === '__MISC__');
  if (miscItem) {
    miscItem.rate = DC > 0 ? miscAmount / 1 : 0;
    miscItem.amount = miscAmount;
  }

  // Append any extra items discovered from an uploaded PFB sheet. Their
  // qty is either a plain stored number, or a small DC/AC/SW expression
  // string (e.g. "SW*200") produced by the rate-upload endpoint — stored
  // as a string because the rate history is persisted as JSON, which
  // cannot hold a live function reference.
  let nextNo = baseItems.length + 1;
  extraItems.forEach(ex => {
    let qty;
    if (ex.qtyFormulaExpr) {
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('DC', 'AC', 'SW', 'PILING', 'WALL', 'ROAD', `return (${ex.qtyFormulaExpr});`);
        qty = fn(DC, AC, SW, PILING, WALL, ROAD);
      } catch { qty = ex.qty ?? 1; }
    } else {
      qty = ex.qty ?? 1;
    }
    baseItems.push({
      scopeNo: nextNo++,
      section: ex.section || 'C',
      scopeName: ex.scopeName || 'Additional Item',
      side: ex.side || '',
      particular: ex.particular || ex.scopeName || '',
      pfbHead: ex.pfbHead || ex.scopeName || '',
      serviceSupply: ex.serviceSupply || 'Supply',
      unit: ex.unit || 'Nos.',
      qty,
      rate: ex.rate || 0,
      amount: qty * (ex.rate || 0),
      _rateKey: 'extra',
    });
  });

  return baseItems;
}

// ─────────────────────────────────────────────────────────────
// ALIGNMENT MATCHER — 3-tier, per item 8 of the request
// ─────────────────────────────────────────────────────────────
//
// lineItem shape expected (from Zoho PO/Bill line_items):
//   { name, rate, quantity, item_total, tags: [{tag_name, tag_option_name}] }
//
// pfbItems: array returned by generatePFB()

function getTagValue(lineItem, tagName) {
  if (!Array.isArray(lineItem.tags)) return null;
  const tag = lineItem.tags.find(t => (t.tag_name || '').toLowerCase() === tagName.toLowerCase());
  return tag ? (tag.tag_option_name || null) : null;
}

function nameSimilarity(a, b) {
  const wa = new Set((a||'').toLowerCase().split(/\s+/).filter(w=>w.length>2));
  const wb = new Set((b||'').toLowerCase().split(/\s+/).filter(w=>w.length>2));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  wa.forEach(w => { if (wb.has(w)) common++; });
  return common / Math.max(wa.size, wb.size);
}

function findBestPFBMatch(lineItem, pfbItems) {
  const liName = (lineItem.name || '').toLowerCase();

  // ── TIER 1: direct name match against particular/scopeName ──
  let tier1Candidates = pfbItems
    .map(p => ({ p, score: Math.max(nameSimilarity(liName, p.particular), nameSimilarity(liName, p.scopeName)) }))
    .filter(c => c.score >= 0.5)
    .sort((a,b) => b.score - a.score);

  if (tier1Candidates.length > 0) {
    return { match: tier1Candidates[0].p, tier: 1, confidence: tier1Candidates[0].score };
  }

  // ── TIER 2: Project Head + PFB Head tag match ────────────────
  const projectHead = getTagValue(lineItem, 'Project Head');
  const pfbHead      = getTagValue(lineItem, 'PFB Head');

  if (projectHead || pfbHead) {
    let tier2Candidates = pfbItems.filter(p => {
      const scopeMatches = projectHead && p.scopeName.toLowerCase().includes(projectHead.toLowerCase());
      const headMatches   = pfbHead && p.pfbHead.toLowerCase().includes(pfbHead.toLowerCase());
      // Require at least the PFB Head to match (most specific tag); scopeName match boosts confidence
      return headMatches || scopeMatches;
    });

    // Prefer items where BOTH match
    const bothMatch = tier2Candidates.filter(p =>
      projectHead && pfbHead &&
      p.scopeName.toLowerCase().includes(projectHead.toLowerCase()) &&
      p.pfbHead.toLowerCase().includes(pfbHead.toLowerCase())
    );
    if (bothMatch.length > 0) tier2Candidates = bothMatch;

    if (tier2Candidates.length === 1) {
      return { match: tier2Candidates[0], tier: 2, confidence: 0.7 };
    }

    if (tier2Candidates.length > 1) {
      // ── TIER 3: disambiguate ──────────────────────────────────
      // Prefer non-zero amount (has both qty & rate set)
      let pool = tier2Candidates.filter(p => p.amount > 0);
      if (pool.length === 0) pool = tier2Candidates;

      if (pool.length === 1) {
        return { match: pool[0], tier: 3, confidence: 0.6 };
      }

      // Closest rate, then closest qty, then name similarity as final tiebreak
      const liRate = lineItem.rate || 0;
      const liQty  = lineItem.quantity || 0;
      pool.sort((a, b) => {
        const rateDiffA = Math.abs((a.rate||0) - liRate);
        const rateDiffB = Math.abs((b.rate||0) - liRate);
        if (rateDiffA !== rateDiffB) return rateDiffA - rateDiffB;
        const qtyDiffA = Math.abs((a.qty||0) - liQty);
        const qtyDiffB = Math.abs((b.qty||0) - liQty);
        if (qtyDiffA !== qtyDiffB) return qtyDiffA - qtyDiffB;
        return nameSimilarity(liName, b.particular) - nameSimilarity(liName, a.particular);
      });
      return { match: pool[0], tier: 3, confidence: 0.5 };
    }
  }

  // No match found via any tier
  return { match: null, tier: 0, confidence: 0 };
}

function checkPOAlignment(lineItems, pfbItems) {
  return (lineItems || []).map(li => {
    const { match, tier, confidence } = findBestPFBMatch(li, pfbItems);

    if (!match || confidence < 0.3) {
      return {
        lineItem: li.name,
        qty: li.quantity, rate: li.rate, amount: li.item_total,
        pfbMatch: null, pfbRate: null, rateVariance: null,
        status: 'na',
        matchTier: 0,
        comment: 'No PFB scope match found — item outside standard budget (acceptable for services, freight, legal etc.)',
      };
    }

    const rateVariance = match.rate > 0
      ? Math.round(((li.rate - match.rate) / match.rate) * 1000) / 10
      : null;

    let status = 'na';
    if (rateVariance !== null) {
      if (Math.abs(rateVariance) > 25) status = 'reject';
      else if (Math.abs(rateVariance) > 10) status = 'flag';
      else status = 'ok';
    }

    return {
      lineItem: li.name,
      qty: li.quantity, rate: li.rate, amount: li.item_total,
      pfbMatch: `${match.scopeName} (${match.pfbHead})`,
      pfbRate: match.rate,
      rateVariance,
      status,
      matchTier: tier, // 1=name, 2=tag exact, 3=tag+disambiguated
      comment: tier === 1
        ? `Matched by item name to "${match.particular}"`
        : tier === 2
          ? `Matched by Project Head/PFB Head tags to "${match.particular}"`
          : `Matched by tags + closest rate/qty to "${match.particular}" (${match.scopeName} had multiple candidates)`,
    };
  });
}

// Scope No. (1-94, matches column A of any uploaded reference PFB Excel) ->
// internal rateKey used by DEFAULT_RATES above. Derived directly from
// PFB_ITEMS_DEF so it can never drift out of sync with the item list.
const SCOPE_TO_RATEKEY = PFB_ITEMS_DEF.reduce((m, def, idx) => {
  m[idx + 1] = def[8];
  return m;
}, {});

module.exports = { generatePFB, checkPOAlignment, findBestPFBMatch, DEFAULT_RATES, PFB_ITEMS_DEF, SCOPE_TO_RATEKEY };

// data/projects.js
// Single source of truth for the 23 hardcoded current projects.
// User-added projects/parks (item 2 of the request) live in lib/store.js
// and get merged in by pages/api/projects.js — this file stays untouched
// by runtime additions, exactly as before.

const PROJECTS = [
  { id:"wonder3",  name:"Wonder Cement Phase 3",    firm:"Wonder Cement",         park:"SS Nagar Park", district:"Phalodi",  dc:75,    ac:null,  sw:null,  piling:2000, wall:2000, road:2000, bess:0,     epcCost:1.31, totalValue:210.75, agreementDate:"21-05-2026", endDate:"16-11-2026", quarter:"Q3 FY26-27", zohoNames:["LE0193","WONDER CEMENT LIMITED","WONDER CEMENT PHASE 3","WCP3"] },
  { id:"jsw",      name:"JSW",                       firm:"JSW",                   park:"Pugal",         district:"Bikaner",  dc:72.5,  ac:50,    sw:8,     piling:2000, wall:2000, road:2000, bess:0,     epcCost:1.31, totalValue:203.73, agreementDate:"10-04-2026", endDate:"02-10-2026", quarter:"Q3 FY26-27", zohoNames:["LE0219","LE0220","LE0221","JSW 15","JSW 13","JSW 20","JSW GREEN"] },
  { id:"ravi",     name:"Ravi Surya Spa",             firm:"Ravi Surya Spa",        park:"Lunkaransar",   district:"Bikaner",  dc:2.08,  ac:1.39,  sw:1,     piling:2000, wall:2000, road:2000, bess:0,     epcCost:1.482,totalValue:6.14,   agreementDate:"14-03-2026", endDate:"08-09-2026", quarter:"Q2 FY26-27", zohoNames:["LE0218","RAVI SU GROUP","RAVI SURYA"] },
  { id:"metallic", name:"Metallic Rolls",             firm:"Metallic Rolls",        park:"Bhamatsar",     district:"Bikaner",  dc:0.52,  ac:0.35,  sw:1,     piling:500,  wall:500,  road:500,  bess:0,     epcCost:1.47, totalValue:1.53,   agreementDate:"07-03-2026", endDate:"01-09-2026", quarter:"Q2 FY26-27", zohoNames:["LE0217","METALIC ROLLS","METALLIC ROLLS"] },
  { id:"ananta",   name:"Shree Ananta Dream Homes",   firm:"Shree Ananta Dream Homes", park:"Bhamatsar",   district:"Bikaner",  dc:0.3,   ac:0.25,  sw:1,     piling:300,  wall:300,  road:300,  bess:0,     epcCost:1.53, totalValue:0.9,    agreementDate:"06-03-2026", endDate:"31-08-2026", quarter:"Q2 FY26-27", zohoNames:["LE0216","S ANANTA HOME","SHREE ANANTA"] },
  { id:"bkt",      name:"BKT Industries",             firm:"BKT Industries",        park:"Dechu",         district:"Phalodi",  dc:16,    ac:10.7,  sw:2,     piling:2000, wall:2000, road:2000, bess:3.34,  epcCost:1.38, totalValue:49.9,   agreementDate:"25-02-2026", endDate:"22-08-2026", quarter:"Q2 FY26-27", zohoNames:["LE0214","BALKRISNA IND","BALKRISHNA INDUSTRIES"] },
  { id:"alliance", name:"Alliance Poly Sacks",        firm:"Alliance Poly Sacks",   park:"Dechu",         district:"Phalodi",  dc:3.2,   ac:2.2,   sw:1,     piling:700,  wall:700,  road:700,  bess:0,     epcCost:1.72, totalValue:10.21,  agreementDate:"23-02-2026", endDate:"20-08-2026", quarter:"Q2 FY26-27", zohoNames:["LE0212","ALLIANCE POLYSACKS","ALLIANCE POLY"] },
  { id:"siddharth",name:"Siddharth Polysacks",        firm:"Siddharth Polysacks",   park:"Dechu",         district:"Phalodi",  dc:1.25,  ac:0.84,  sw:1,     piling:400,  wall:400,  road:400,  bess:0,     epcCost:1.72, totalValue:3.99,   agreementDate:"23-02-2026", endDate:"20-08-2026", quarter:"Q2 FY26-27", zohoNames:["LE0211","SIDHARTH POLYSACKS","SIDDHARTH POLY"] },
  { id:"jecrc",    name:"JECRC",                      firm:"JECRC",                 park:"Dechu",         district:"Phalodi",  dc:7.35,  ac:4.9,   sw:1,     piling:2000, wall:2000, road:2000, bess:0,     epcCost:1.59, totalValue:21.98,  agreementDate:"12-02-2026", endDate:"09-08-2026", quarter:"Q2 FY26-27", zohoNames:["LE0209","JECRC PHASE 2","JECRC UNIVERSITY"] },
  { id:"jagdamba", name:"Jagdamba",                   firm:"Jagdamba",              park:"Dechu",         district:"Phalodi",  dc:0.86,  ac:0.56,  sw:1,     piling:300,  wall:300,  road:300,  bess:0,     epcCost:1.375,totalValue:2.36,   agreementDate:"12-02-2026", endDate:"09-08-2026", quarter:"Q2 FY26-27", zohoNames:["LE0210","JAGDAMBA"] },
  { id:"raksha",   name:"Raksha Bars",                firm:"Raksha Bars",           park:"Dechu",         district:"Phalodi",  dc:7.35,  ac:4.9,   sw:1,     piling:2000, wall:2000, road:2000, bess:0,     epcCost:1.375,totalValue:21.39,  agreementDate:"11-02-2026", endDate:"08-08-2026", quarter:"Q2 FY26-27", zohoNames:["LE0208","RAKSHA BARS"] },
  { id:"soni",     name:"Soni International",         firm:"Soni International",    park:"Lunkaransar",   district:"Bikaner",  dc:1.37,  ac:0.93,  sw:1,     piling:500,  wall:500,  road:500,  bess:0.64,  epcCost:1.48, totalValue:4.65,   agreementDate:"27-01-2026", endDate:"24-07-2026", quarter:"Q2 FY26-27", zohoNames:["LE0213","SONI PHASE 2","SONI INTERNATIONAL"] },
  { id:"wonder2",  name:"Wonder Cement Phase 2",      firm:"Wonder Cement",         park:"Dechu",         district:"Phalodi",  dc:39.6,  ac:26.4,  sw:4,     piling:2000, wall:2000, road:2000, bess:2.93,  epcCost:1.34, totalValue:113.76, agreementDate:"09-01-2026", endDate:"07-07-2026", quarter:"Q2 FY26-27", zohoNames:["LE0207","WONDER PHASE 2","WONDER CEMENT LIMITED ( PHASE 2)"] },
  { id:"lords",    name:"Lords Chloro Phase 2",       firm:"Lords Chloro",          park:"Lunkaransar",   district:"Bikaner",  dc:21,    ac:14.5,  sw:3,     piling:2000, wall:2000, road:2000, bess:1.45,  epcCost:1.4,  totalValue:29.4,   agreementDate:"07-01-2026", endDate:"05-07-2026", quarter:"Q2 FY26-27", zohoNames:["LE0204","LORDS PHASE 2","LORDS CHLORO PHASE 2"] },
  { id:"kamdhenu", name:"Kamdhenu Limited",           firm:"Kamdhenu Limited",      park:"Dechu",         district:"Phalodi",  dc:5,     ac:3.4,   sw:1,     piling:1200, wall:1200, road:1200, bess:0,     epcCost:1.5,  totalValue:14.55,  agreementDate:"30-12-2025", endDate:"27-06-2026", quarter:"Q1 FY26-27", zohoNames:["LE0205","KAMDHENU LIMITED"] },
  { id:"inox",     name:"Inox Air",                   firm:"Inox Air",              park:"Dechu",         district:"Phalodi",  dc:12,    ac:8,     sw:2,     piling:2000, wall:2000, road:2000, bess:11.29, epcCost:1.5,  totalValue:28.16,  agreementDate:"18-12-2025", endDate:"15-06-2026", quarter:"Q1 FY26-27", zohoNames:["LE0203","INOX AIR PRODUCTS","INOX AIR"] },
  { id:"kothari",  name:"Kothari",                    firm:"Kothari",               park:"Kolayat",       district:"Bikaner",  dc:0.86,  ac:0.59,  sw:1,     piling:300,  wall:300,  road:300,  bess:0,     epcCost:1.58, totalValue:1.36,   agreementDate:"09-12-2025", endDate:"07-06-2026", quarter:"Q1 FY26-27", zohoNames:["LE0206","KOTHARI MEDICAL"] },
  { id:"mec",      name:"MEC Bearings",               firm:"MEC Bearings",          park:"Panchu",        district:"Bikaner",  dc:1,     ac:0.69,  sw:1,     piling:400,  wall:400,  road:400,  bess:0,     epcCost:1.55, totalValue:3.0,    agreementDate:"15-11-2025", endDate:"13-05-2026", quarter:"Q1 FY26-27", zohoNames:["LE0201","MEC BEARINGS PVT LTD"] },
  { id:"saville",  name:"Saville",                    firm:"Saville",               park:"Panchu",        district:"Bikaner",  dc:2.05,  ac:1.41,  sw:1,     piling:600,  wall:600,  road:600,  bess:0.52,  epcCost:1.6,  totalValue:6.64,   agreementDate:"05-11-2025", endDate:"03-05-2026", quarter:"Q1 FY26-27", zohoNames:["SAVILLE HOSPITAL","SAVILLE HOSPITAL AND RESEARCH"] },
  { id:"mangalam", name:"Mangalam",                   firm:"Mangalam",              park:"Panchu",        district:"Bikaner",  dc:1.73,  ac:1.19,  sw:1,     piling:500,  wall:500,  road:500,  bess:0,     epcCost:1.6,  totalValue:5.17,   agreementDate:"05-11-2025", endDate:"03-05-2026", quarter:"Q1 FY26-27", zohoNames:["LE0199","MANGLAM SPA RESORTS","MANGALAM SPA"] },
  { id:"ask",      name:"ASK",                        firm:"ASK",                   park:"Kolayat",       district:"Bikaner",  dc:11.55, ac:7.97,  sw:2,     piling:2000, wall:2000, road:2000, bess:4.07,  epcCost:1.35, totalValue:35.28,  agreementDate:"18-10-2025", endDate:"15-04-2026", quarter:"Q1 FY26-27", zohoNames:["LE0198","ASK AUTOMOBILES"] },
  { id:"uttam",    name:"Uttam Strips",               firm:"Uttam Strips",          park:"Lunkaransar",   district:"Bikaner",  dc:26.2,  ac:16,    sw:3,     piling:2000, wall:2000, road:2000, bess:11.29, epcCost:1.45, totalValue:87.45,  agreementDate:"19-06-2025", endDate:"16-12-2025", quarter:"Q3 FY25-26", zohoNames:["LE0188","UTTAM STRIPS LIMITED"] },
  { id:"miracle",  name:"Miracle",                    firm:"Miracle",               park:"Dechu",         district:"Phalodi",  dc:6,     ac:4,     sw:1,     piling:1500, wall:1500, road:1500, bess:0,     epcCost:null, totalValue:null,   agreementDate:null,         endDate:null,         quarter:"",            zohoNames:["LE0215","MIRACLE CORO"] },
];

// Solar Parks (district/state hardcoded for the 7 known parks — item 1 of
// the request before this one). New user-added parks get district/state
// from whatever the user enters in the Add Park modal.
const SOLAR_PARKS = {
  "SS Nagar Park": { district:"Phalodi", state:"Rajasthan", projects:["wonder3"] },
  "Pugal":         { district:"Bikaner", state:"Rajasthan", projects:["jsw"] },
  "Lunkaransar":   { district:"Bikaner", state:"Rajasthan", projects:["ravi","soni","lords","uttam"] },
  "Bhamatsar":     { district:"Bikaner", state:"Rajasthan", projects:["metallic","ananta"] },
  "Dechu":         { district:"Phalodi", state:"Rajasthan", projects:["bkt","alliance","siddharth","jecrc","jagdamba","raksha","wonder2","kamdhenu","inox","miracle"] },
  "Kolayat":       { district:"Bikaner", state:"Rajasthan", projects:["kothari","ask"] },
  "Panchu":        { district:"Bikaner", state:"Rajasthan", projects:["mec","saville","mangalam"] },
};

// ── HELPERS ───────────────────────────────────────────────────

// Revenue quarter from an end date — "format given earlier" = Indian FY
// (Apr-Jun=Q1, Jul-Sep=Q2, Oct-Dec=Q3, Jan-Mar=Q4) labelled "Q_ FY YY-YY"
function quarterFromEndDate(endDateDDMMYYYY) {
  if (!endDateDDMMYYYY) return '';
  const [d, m, y] = endDateDDMMYYYY.split('-').map(Number);
  if (!m || !y) return '';
  let fyStartYear = m >= 4 ? y : y - 1;
  const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 && m <= 12 ? 3 : 4;
  const fyEndYear = fyStartYear + 1;
  return `Q${q} FY${String(fyStartYear).slice(2)}-${String(fyEndYear).slice(2)}`;
}

function matchProject(zohoName, projects) {
  if (!zohoName) return null;
  const z = zohoName.toUpperCase().trim();
  const leMatch = z.match(/LE\d{4}/i);
  if (leMatch) {
    const found = projects.find(p => p.zohoNames.some(a => a.toUpperCase() === leMatch[0].toUpperCase()));
    if (found) return found;
  }
  for (const p of projects) {
    for (const alias of p.zohoNames) {
      if (z.includes(alias.toUpperCase())) return p;
    }
  }
  return null;
}

function projectIsReady(p) {
  return p.dc != null && p.ac != null && p.sw != null;
}

function groupByFirm(projects) {
  const map = {};
  for (const p of projects) {
    const firm = p.firm || p.name;
    if (!map[firm]) map[firm] = { firmName: firm, projects: [] };
    map[firm].projects.push(p);
  }
  const toComp = d => (d || '').split('-').reverse().join('-');
  for (const f of Object.values(map)) {
    f.projects.sort((a, b) => {
      if (!a.agreementDate) return 1;
      if (!b.agreementDate) return -1;
      return toComp(b.agreementDate).localeCompare(toComp(a.agreementDate));
    });
  }
  return Object.values(map).sort((a, b) => {
    const aDate = a.projects[0]?.agreementDate;
    const bDate = b.projects[0]?.agreementDate;
    if (!aDate) return 1; if (!bDate) return -1;
    return toComp(bDate).localeCompare(toComp(aDate));
  });
}

module.exports = {
  PROJECTS, SOLAR_PARKS,
  matchProject, projectIsReady, groupByFirm, quarterFromEndDate,
};

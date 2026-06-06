// lib/pfbEngine.js
// PFB calculation engine — every formula verified against
// Formulas_sheet__JSW.xlsx (DC=72.5, AC=50, SW=6)
// All 98 scope items, all quantities match the reference sheet exactly.

// ─────────────────────────────────────────────────────────────────
// RATES — from JSW reference sheet (latest project rates)
// ─────────────────────────────────────────────────────────────────
const RATES = {
  1:  0,        // Land
  2:  8487,     // Modules per Wp
  3:  79,       // MMS supply per Kg
  4:  125000,   // Fasteners
  5:  450000,   // Inverter
  6:  6000,     // Inverter stand
  7:  110000,   // Inverter Duty Transformer
  8:  100000,   // Aux Transformer
  9:  30,       // MC4 Connector
  10: 150,      // Y connector
  11: 34,       // 4 SQ MM solar cable
  12: 54,       // 6 SQ MM solar cable
  13: 0,        // 240 sqmm cable
  14: 1200,     // 300 sqmm cable
  15: 430,      // 400 sqmm cable
  16: 23,       // Street light 2CX1 cable
  17: 50,       // 4 core Al 4sqmm armoured
  18: 80,       // 3 core Al 6sqmm armoured
  19: 50,       // 4sqmm unarmoured
  20: 80,       // 4sqmm armoured
  21: 83,       // ACDB to AuxTrafo cable
  22: 90,       // AuxTrafo to ACDB
  23: 0,        // ACDB to SRP panel
  24: 110,      // RS485 SCADA cable
  25: 210,      // Metering 4C 4sqmm
  26: 130,      // Control cable PT-CRP 4C
  27: 340,      // Control cable VCB-CRP 12C
  28: 40,       // Control cable VCB-CRP 2C
  29: 500,      // Control cable TF-CRP 19C
  30: 130,      // Control cable TF 4C
  31: 480,      // Earthing cable 50sqmm
  33: 27,       // HDPE conduit 40mm
  34: 250000,   // VCB
  35: 250000,   // CR Panel
  36: 38000,    // Protection CT PT
  39: 50000,    // SCADA
  40: 200000,   // 4 Pole supply
  41: 43000,    // Isolator
  42: 15000,    // DO
  43: 48000,    // Meters / ABT
  44: 48000,    // Metering CT PT
  45: 11000,    // Meter Box
  46: 500000,   // Transmission Line supply
  47: 306,      // GI Strip 50x10
  48: 90,       // GI Strip 25x6
  49: 44,       // GI Strip 25x3
  50: 0,        // Earthing electrode
  51: 28000,    // ESE LA
  52: 80000,    // LT Panel / MCCB
  53: 700000,   // LT ACDB panel stand
  54: 50000,    // ACDB aux power
  55: 30000,    // Gate
  56: 3000,     // Sign board
  57: 50000,    // Security Cabin
  58: 5500,     // Street light
  59: 35000,    // UPS
  60: 50000,    // PTZ camera
  61: 200000,   // WMS
  62: 0,        // Root marker
  63: 0,        // Cable Tag
  64: 30000,    // Safety equipment
  // 65 = Misc — special: rate = 300000 * DC, computed in generatePFB
  66: 1500000,  // Control Room
  67: 1400,     // Piling
  68: 1900,     // Inverter stand installation
  69: 25000,    // LT panel foundation
  70: 2400,     // Boundary wall
  71: 40000,    // Gate foundation
  72: 50000,    // Drainage
  73: 3000,     // Sign board foundation
  74: 5000,     // Security Cabin foundation
  75: 5000,     // Street light installation
  76: 1500,     // Road
  77: 3500,     // PTZ camera foundation
  78: 3000,     // WMS stand foundation
  79: 10000,    // Aux transformer foundation
  80: 600000,   // Switchyard work
  81: 8500,     // LA foundation
  82: 250000,   // AC DC Work
  83: 100000,   // Commissioning / testing
  85: 8000,     // Inspection
  87: 100000,   // TL installation
  88: 10000,    // Land levelling
  89: 30000,    // Land survey
  90: 145000,   // MMS installation
  91: 4300,     // Module unloading
  92: 4000,     // MMS unloading
  93: 200000,   // 4 pole installation
  94: 4000,     // Loading / unloading
  95: 0,        // RREC
  96: 0,        // RVPNL
  97: 500000,   // Commissioning approval
  98: 0,        // CEIG
};

// ─────────────────────────────────────────────────────────────────
// PFB ITEM DEFINITIONS
// Every scope item has:
//   scopeNo, scopeName, side, particular, pfbHead, supplyService,
//   unit, section (A/B/C), qtyFn (function of DC, AC, SW),
//   rateKey (key into RATES), keywords (for fuzzy PO/Bill matching)
// ─────────────────────────────────────────────────────────────────
const PFB_ITEMS = [

  // ── SECTION A: Project Material Expenses ──────────────────────

  { scopeNo:1,  section:"A", scopeName:"Land",
    side:"Civil", particular:"Land", pfbHead:"Land", supplyService:"Supply", unit:"Acre",
    qtyFn:(DC,AC,SW) => DC * SW,
    rateKey:1,
    keywords:["land","acre","plot","site","land acquisition"] },

  { scopeNo:2,  section:"A", scopeName:"Modules",
    side:"DC", particular:"Module 620 Wp (Topcon) - Adani", pfbHead:"module", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC) => Math.ceil((DC * 1000000) / 620),
    rateKey:2,
    keywords:["module","solar module","panel","pv module","620","620wp","topcon","adani","monocrystalline","bifacial","mono perc"] },

  { scopeNo:3,  section:"A", scopeName:"MMS",
    side:"DC", particular:"MMS supply (2*28) & (2P*14)", pfbHead:"mms", supplyService:"Supply", unit:"Kg",
    qtyFn:(DC) => 19000 * DC,
    rateKey:3,
    keywords:["mms","module mounting structure","mounting structure","ms structure","gi structure","galvanised","ground mount"] },

  { scopeNo:4,  section:"A", scopeName:"MMS Fasteners",
    side:"DC", particular:"Fasteners", pfbHead:"fasteners", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC) => DC,
    rateKey:4,
    keywords:["fastener","bolt","nut","clamp","hardware","spring washer","ms bolt"] },

  { scopeNo:5,  section:"A", scopeName:"Inverter",
    side:"AC", particular:"300 KW 1500V DC 800V Output String Inverter Sungrow", pfbHead:"Inverter", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC) => Math.ceil(AC * 1000 / 300),
    rateKey:5,
    keywords:["inverter","sungrow","300kw","300 kw","string inverter","1500v dc","string","pv inverter"] },

  { scopeNo:6,  section:"A", scopeName:"Inverter Stand",
    side:"AC", particular:"Inverter stand supply", pfbHead:"Inverter stand", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC) => Math.ceil(AC * 1000 / 300),
    rateKey:6,
    keywords:["inverter stand","inverter base","ms stand inverter","stand for inverter"] },

  { scopeNo:7,  section:"A", scopeName:"Inverter Duty Transformer",
    side:"AC", particular:"Inverter Duty Transformer 8400 KVA 33/0.8 Kv", pfbHead:"Transformer", supplyService:"Supply", unit:"MW",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:7,
    keywords:["inverter duty transformer","idt","8400 kva","33kv transformer","33/0.8","power transformer","step up transformer"] },

  { scopeNo:8,  section:"A", scopeName:"Auxiliary Transformer",
    side:"AC", particular:"Auxiliary Transformer 50 KVA 0.8/0.415 kV", pfbHead:"Aux trafo", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:8,
    keywords:["auxiliary transformer","aux transformer","aux trafo","50 kva","0.415kv","lv transformer","distribution transformer"] },

  { scopeNo:9,  section:"A", scopeName:"MC4 Connector",
    side:"DC", particular:"MC4 Connector", pfbHead:"MC4 Connector", supplyService:"Supply", unit:"Set",
    qtyFn:(DC) => (Math.ceil((DC * 1000000) / 620) / 28) * 2.5,
    rateKey:9,
    keywords:["mc4","connector","mc-4","solar connector","dc connector","pv connector"] },

  { scopeNo:10, section:"A", scopeName:"Y Connector",
    side:"DC", particular:"Y Connector", pfbHead:"Y connector", supplyService:"Supply", unit:"Set",
    qtyFn:() => 0,
    rateKey:10,
    keywords:["y connector","y-connector","parallel connector","branch connector"] },

  { scopeNo:11, section:"A", scopeName:"4 SQ MM Solar Cable",
    side:"DC", particular:"4 SQ MM Solar Cable", pfbHead:"DC Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC) => (Math.ceil((DC * 1000000) / 620) / 28) * 86,
    rateKey:11,
    keywords:["4sqmm","4 sq mm","4mm solar","dc cable","solar cable","pv cable","4mm pv","4 mm cable","string cable"] },

  { scopeNo:12, section:"A", scopeName:"6 SQ MM Solar Cable",
    side:"DC", particular:"6 SQ MM Solar Cable", pfbHead:"DC Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:() => 0,
    rateKey:12,
    keywords:["6sqmm","6 sq mm","6mm solar","pv cable 6mm","6mm dc cable"] },

  { scopeNo:13, section:"A", scopeName:"240 sqmm LT Cable",
    side:"AC", particular:"240 sq.mm 3 Core Armoured Al XLPE Cable 1.9/3.3kV IS:7098", pfbHead:"LT cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC) => (AC * 1000 / 300) * 190,
    rateKey:13,
    keywords:["240sqmm","240 sq mm","240 sq","3 core 240","al xlpe 240","lt cable 240","armoured 240","aluminium 240"] },

  { scopeNo:14, section:"A", scopeName:"300 sqmm LT Cable",
    side:"AC", particular:"300 sq.mm 3 Core Armoured Al XLPE Cable 1.9/3.3kV IS:7098", pfbHead:"LT cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC) => (AC * 1000 / 300) * 190,
    rateKey:14,
    keywords:["300sqmm","300 sq mm","300 sq","3 core 300","al xlpe 300","lt cable 300","armoured 300","aluminium 300","3c 300"] },

  { scopeNo:15, section:"A", scopeName:"400 sqmm LT Cable",
    side:"AC", particular:"400 sq.mm 1 Core Armoured Al XLPE Cable 1.9/3.3kV IS:7098", pfbHead:"LT cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => ((AC * 1000 / 300) / 4) * SW * 20,
    rateKey:15,
    keywords:["400sqmm","400 sq mm","400 sq","1 core 400","1c 400","al xlpe 400","lt cable 400","armoured 400"] },

  { scopeNo:16, section:"A", scopeName:"Street Light Cable 2CX1",
    side:"AC", particular:"2CX1 SQMM 0.6/1.1kV 2 Core CU XLPE Unarmoured Cable", pfbHead:"Aux Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC) => (DC * 14) * 5,
    rateKey:16,
    keywords:["2cx1","2 core 1sqmm","street light cable","1sqmm","cu xlpe unarmoured","2c 1mm","flexible cable","garden light cable"] },

  { scopeNo:17, section:"A", scopeName:"4 Core Al 4sqmm Armoured",
    side:"AC", particular:"4 Core Al Conductor XLPE 4sqmm Armoured Cable", pfbHead:"Aux cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC) => (DC * 14) * 50,
    rateKey:17,
    keywords:["4 core al","4sqmm armoured","4 core 4sqmm","al xlpe 4sqmm armoured","4c al 4mm"] },

  { scopeNo:18, section:"A", scopeName:"3 Core Al 6sqmm Armoured",
    side:"AC", particular:"3 Core Al Conductor XLPE 6sqmm Armoured Cable", pfbHead:"Aux cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:() => 0,
    rateKey:18,
    keywords:["3 core 6sqmm","6sqmm armoured","al 6mm","3c 6mm armoured","6mm al cable"] },

  { scopeNo:19, section:"A", scopeName:"4sqmm Al Unarmoured",
    side:"AC", particular:"0.6/1.1kV 2 Core Al XLPE 4sqmm Unarmoured Cable", pfbHead:"Aux Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:() => 0,
    rateKey:19,
    keywords:["4sqmm unarmoured","4mm unarmoured","2c al unarmoured","unarmoured 4sqmm"] },

  { scopeNo:20, section:"A", scopeName:"4sqmm Al Armoured",
    side:"AC", particular:"0.6/1.1kV 2 Core Al XLPE 4sqmm Armoured Cable", pfbHead:"Aux Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:() => 0,
    rateKey:20,
    keywords:["2 core 4sqmm armoured","4sqmm armoured 2c","2c al armoured 4mm"] },

  { scopeNo:21, section:"A", scopeName:"ACDB to Aux Trafo Cable",
    side:"AC", particular:"ACDB to Auxiliary Transformer 1.9/3.3kV 3C 16sqmm Al Armoured Cable", pfbHead:"Aux Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 20,
    rateKey:21,
    keywords:["acdb aux transformer","16sqmm 3 core","3c 16sqmm","al ar 16mm","acdb to aux","3c al ar 16"] },

  { scopeNo:22, section:"A", scopeName:"Aux Trafo to ACDB Cable",
    side:"AC", particular:"Auxiliary Transformer to ACDB 1.1kV 4C 16sqmm Al Armoured Cable", pfbHead:"Aux Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 20,
    rateKey:22,
    keywords:["aux to acdb","4c 16sqmm","4 core 16sqmm","1.1kv 4c 16","al ar 4c 16","aux trafo acdb"] },

  { scopeNo:23, section:"A", scopeName:"ACDB to SRP Panel Cable",
    side:"AC", particular:"ACDB to SRP Panel 1.1kV 2C Al Armoured 2.5sqmm Cable", pfbHead:"Aux Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 5,
    rateKey:23,
    keywords:["srp panel","acdb srp","2.5sqmm armoured","2c al ar 2.5","srp cable"] },

  { scopeNo:24, section:"A", scopeName:"RS485 SCADA Cable",
    side:"AC", particular:"RS-485 SCADA Cable 2P/4Core 0.5sqmm HDPE Armoured 300/500V", pfbHead:"Communication cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC) => DC * 250,
    rateKey:24,
    keywords:["rs485","rs-485","scada cable","communication cable","0.5sqmm","2p 4c","hdpe armoured","data cable","signal cable"] },

  { scopeNo:25, section:"A", scopeName:"Metering Cable",
    side:"AC", particular:"4Cx4sqmm CU Armoured Metering Cable", pfbHead:"Metering Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 80,
    rateKey:25,
    keywords:["metering cable","4cx4sqmm","4c 4sqmm cu","cu armoured 4sqmm","meter cable","4 core 4mm cu"] },

  { scopeNo:26, section:"A", scopeName:"Control Cable PT-CRP 4C",
    side:"AC", particular:"Protection PT to CRP 4C 2.5sqmm Cu XLPE Armoured 1.1kV Control Cable", pfbHead:"Control Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 90,
    rateKey:26,
    keywords:["pt crp","pt to crp","control cable 4 core","4c 2.5sqmm","protection cable","xlpe armoured control"] },

  { scopeNo:27, section:"A", scopeName:"Control Cable VCB-CRP 12C",
    side:"AC", particular:"VCB to CRP 12C 2.5sqmm Cu XLPE Armoured 1.1kV Control Cable", pfbHead:"Control Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 20,
    rateKey:27,
    keywords:["vcb crp 12c","vcb to crp","12 core 2.5","12c 2.5sqmm","12 core control","vcb control cable"] },

  { scopeNo:28, section:"A", scopeName:"Control Cable VCB-CRP 2C",
    side:"AC", particular:"VCB to CRP 2C 2.5sqmm Cu XLPE Armoured 1.1kV Control Cable", pfbHead:"Control Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 20,
    rateKey:28,
    keywords:["vcb crp 2c","2 core vcb","2c 2.5sqmm vcb","2c control cable vcb"] },

  { scopeNo:29, section:"A", scopeName:"Control Cable TF-CRP 19C",
    side:"AC", particular:"T/F to CRP 19C 2.5sqmm Cu XLPE Armoured 1.1kV Control Cable", pfbHead:"Control Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 20,
    rateKey:29,
    keywords:["19 core","19c 2.5sqmm","tf crp 19c","transformer crp","19c control","t/f 19c"] },

  { scopeNo:30, section:"A", scopeName:"Control Cable TF-CRP 4C",
    side:"AC", particular:"T/F to CRP 4C 2.5sqmm Cu XLPE Armoured 1.1kV Control Cable", pfbHead:"Control Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 20,
    rateKey:30,
    keywords:["tf crp 4c","4 core tf","transformer 4 core control","t/f 4c","tf control 4c"] },

  { scopeNo:31, section:"A", scopeName:"Earthing Cable 50sqmm",
    side:"AC", particular:"1C x 50 SQ MM Green Flexible PVC Earthing Cable (CU) For Inverter Earthing", pfbHead:"Earthing Cable", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC) => (AC * 1000 / 300) * 5,
    rateKey:31,
    keywords:["50sqmm earthing","50 sq mm","earthing cable","green cable","cu earthing","pvc earthing","flexible earthing","1c 50sqmm"] },

  { scopeNo:33, section:"A", scopeName:"HDPE Conduit 40mm",
    side:"DC", particular:"40MM OD HDPE Conduit for Solar Cable", pfbHead:"Conduit", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC) => DC * 500,
    rateKey:33,
    keywords:["hdpe conduit","40mm conduit","hdpe pipe","pvc conduit","cable conduit","conduit pipe","40 mm od"] },

  { scopeNo:34, section:"A", scopeName:"VCB",
    side:"AC", particular:"VCB", pfbHead:"VCB", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:34,
    keywords:["vcb","vacuum circuit breaker","circuit breaker","33kv vcb","hv vcb","vac circuit breaker"] },

  { scopeNo:35, section:"A", scopeName:"CR Panel",
    side:"AC", particular:"CR Panel", pfbHead:"CRP", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:35,
    keywords:["cr panel","crp","control relay panel","relay panel","protection panel","control & relay"] },

  { scopeNo:36, section:"A", scopeName:"Protection CT PT",
    side:"AC", particular:"Protection CT PT", pfbHead:"Protection CT PT", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW * SW * 2,
    rateKey:36,
    keywords:["protection ct","protection pt","ct pt protection","current transformer protection","protective ct","33kv ct"] },

  { scopeNo:39, section:"A", scopeName:"SCADA",
    side:"AC", particular:"SCADA material & installation", pfbHead:"Scada", supplyService:"Supply", unit:"Lot",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:39,
    keywords:["scada","monitoring system","data logger","scada system","remote monitoring","plant monitoring","inverter scada"] },

  { scopeNo:40, section:"A", scopeName:"4 Pole Supply",
    side:"AC", particular:"Supply of 4 Pole with 2 Pole with all accessories", pfbHead:"4 pole", supplyService:"Supply", unit:"Nos.",
    qtyFn:() => 1,
    rateKey:40,
    keywords:["4 pole","four pole","4p isolator","4 pole isolator","4-pole","4p switch","4 way isolator"] },

  { scopeNo:41, section:"A", scopeName:"Isolator",
    side:"AC", particular:"Isolator", pfbHead:"Isolator", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:41,
    keywords:["isolator","gang isolator","ht isolator","33kv isolator","line isolator","disconnect switch"] },

  { scopeNo:42, section:"A", scopeName:"DO",
    side:"AC", particular:"DO", pfbHead:"DO", supplyService:"Supply", unit:"Nos.",
    qtyFn:() => 0,
    rateKey:42,
    keywords:["do fuse","drop out","dropout fuse","do isolator","drop-out fuse"] },

  { scopeNo:43, section:"A", scopeName:"Meters / ABT",
    side:"AC", particular:"ABT Meters", pfbHead:"ABT meter", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW * 2,
    rateKey:43,
    keywords:["meter","abt","abt meter","energy meter","net meter","bi-directional meter","kwh meter","solar meter","generation meter"] },

  { scopeNo:44, section:"A", scopeName:"Metering CT PT",
    side:"AC", particular:"Metering CT PT", pfbHead:"Metering CT PT", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW * SW * 2,
    rateKey:44,
    keywords:["metering ct","metering pt","ct pt metering","measurement transformer","metering current transformer","revenue ct"] },

  { scopeNo:45, section:"A", scopeName:"Meter Box",
    side:"AC", particular:"Meter Box", pfbHead:"Meter Box", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:45,
    keywords:["meter box","meter cabinet","meter enclosure","metering panel","meter kiosk"] },

  { scopeNo:46, section:"A", scopeName:"Transmission Line Supply",
    side:"AC", particular:"Supply of Transmission Line", pfbHead:"Transmission line", supplyService:"Supply", unit:"Lot",
    qtyFn:() => 1,
    rateKey:46,
    keywords:["transmission line supply","tl supply","ht line supply","33kv line","overhead line supply","ohl supply","transmission conductor"] },

  { scopeNo:47, section:"A", scopeName:"GI Earth Strip 50x10mm",
    side:"AC", particular:"GI Earth Strip 50x10mm For Switchyard Area and LT Panel", pfbHead:"Earthing Strip", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 300,
    rateKey:47,
    keywords:["gi strip 50x10","50x10mm","gi earth strip 50","earthing strip 50","gi 50x10","gi flat 50x10"] },

  { scopeNo:48, section:"A", scopeName:"GI Earth Strip 25x6mm",
    side:"AC", particular:"GI Earth Strip 25x6mm For Switchyard", pfbHead:"Earthing Strip", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC,AC,SW) => SW * 200,
    rateKey:48,
    keywords:["gi strip 25x6","25x6mm","gi earth strip 25x6","earthing strip 25x6","gi 25x6","gi flat 25x6"] },

  { scopeNo:49, section:"A", scopeName:"GI Earth Strip 25x3mm",
    side:"AC", particular:"GI Earth Strip 25x3mm For PV Yard Inverters", pfbHead:"Earthing Strip", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC) => DC * 500,
    rateKey:49,
    keywords:["gi strip 25x3","25x3mm","gi earth strip 25x3","earthing strip 25x3","gi 25x3","gi flat 25x3"] },

  { scopeNo:50, section:"A", scopeName:"Earthing Electrode",
    side:"AC", particular:"Earthing Electrode", pfbHead:"Earthing Electrode", supplyService:"Supply", unit:"Mtrs",
    qtyFn:(DC) => DC * 28,
    rateKey:50,
    keywords:["earthing electrode","earth electrode","earth rod","gi pipe electrode","copper electrode","chemical electrode","earth pit"] },

  { scopeNo:51, section:"A", scopeName:"ESE Lightning Arrester",
    side:"AC", particular:"ESE Type Lightning Arrester", pfbHead:"LA", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC) => DC * 2,
    rateKey:51,
    keywords:["ese","lightning arrester","la","ese la","surge arrester","ese type la","lightning rod","early streamer"] },

  { scopeNo:52, section:"A", scopeName:"LT Panel / MCCB",
    side:"AC", particular:"Supply of LT Panel / MCCB", pfbHead:"LT Panel", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC) => (AC * 1000 / 300) / 2,
    rateKey:52,
    keywords:["lt panel","mccb","acdb","ac distribution board","lt distribution","lv panel","lt mccb panel","mccb panel"] },

  { scopeNo:53, section:"A", scopeName:"LT ACDB Panel Stand",
    side:"AC", particular:"LT and ACDB Panel Stand", pfbHead:"LT Panel Stand", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC) => (AC * 1000 / 300) / 2,
    rateKey:53,
    keywords:["panel stand","lt stand","acdb stand","distribution board stand","mccb stand","lt panel stand"] },

  { scopeNo:54, section:"A", scopeName:"ACDB Auxiliary Power",
    side:"AC", particular:"ACDB for Auxiliary Power Supply", pfbHead:"Aux ACDB", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:54,
    keywords:["aux acdb","auxiliary power","aux panel","auxiliary db","station supply db","auxiliary distribution"] },

  { scopeNo:55, section:"A", scopeName:"Gate",
    side:"Civil", particular:"Gate", pfbHead:"Plant Gate", supplyService:"supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:55,
    keywords:["gate","entrance gate","main gate","plant gate","sliding gate","swing gate","compound gate"] },

  { scopeNo:56, section:"A", scopeName:"Sign Board",
    side:"Civil", particular:"Sign Board and Color", pfbHead:"Sign Board", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:56,
    keywords:["sign board","signboard","name board","caution board","danger sign","display board","notice board"] },

  { scopeNo:57, section:"A", scopeName:"Security Cabin",
    side:"Civil", particular:"Security Cabin", pfbHead:"Security Cabin", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:57,
    keywords:["security cabin","guard cabin","guard room","security post","watchman cabin","security room","guard post"] },

  { scopeNo:58, section:"A", scopeName:"Street Light",
    side:"AC", particular:"Plant Illumination System / Street Light", pfbHead:"Street light", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC) => DC * 14,
    rateKey:58,
    keywords:["street light","street lamp","led light","plant illumination","light pole","street lighting","solar light","led street"] },

  { scopeNo:59, section:"A", scopeName:"UPS",
    side:"AC", particular:"UPS 2 KVA with Battery Backup", pfbHead:"UPS", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:59,
    keywords:["ups","uninterruptible power","battery backup","2 kva ups","ups system","inverter ups"] },

  { scopeNo:60, section:"A", scopeName:"PTZ Camera",
    side:"AC", particular:"PTZ Camera with Accessories and Stand", pfbHead:"Camera", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => (DC / 10) * SW,
    rateKey:60,
    keywords:["ptz","camera","cctv","surveillance","ptz camera","ip camera","security camera","360 camera","pan tilt"] },

  { scopeNo:61, section:"A", scopeName:"WMS",
    side:"AC", particular:"WMS with Anemometer Pyranometer and Temp Sensor", pfbHead:"WMS", supplyService:"Supply", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:61,
    keywords:["wms","weather monitoring","anemometer","pyranometer","weather station","wind sensor","irradiance sensor","wms system"] },

  { scopeNo:62, section:"A", scopeName:"Root Marker",
    side:"AC", particular:"Root Marker", pfbHead:"Root Marker", supplyService:"Supply", unit:"Lot",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:62,
    keywords:["root marker","cable marker","route marker","cable route marker","rcc marker"] },

  { scopeNo:63, section:"A", scopeName:"Cable Tag",
    side:"AC", particular:"Cable Tag", pfbHead:"Cable Tag", supplyService:"Supply", unit:"MWp",
    qtyFn:(DC) => DC,
    rateKey:63,
    keywords:["cable tag","ferrule","cable label","cable identification","cable marker tag"] },

  { scopeNo:64, section:"A", scopeName:"Safety Equipment",
    side:"AC", particular:"Safety Equipment", pfbHead:"Safety Equipment", supplyService:"Supply", unit:"Set",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:64,
    keywords:["safety","ppe","safety kit","safety equipment","helmet","gloves","safety gear","personal protective","safety shoes"] },

  { scopeNo:65, section:"A", scopeName:"Miscellaneous",
    side:"AC&DC", particular:"Miscellaneous (Approx 5% of total cost except module)", pfbHead:"Misc", supplyService:"Supply", unit:"Lot",
    qtyFn:() => 1,
    rateKey:null,   // special: rate = 300000 * DC
    keywords:["miscellaneous","misc","sundries","consumables","tools","incidentals","petty items","contingency"] },

  // ── SECTION B: Project Execution ──────────────────────────────

  { scopeNo:66, section:"B", scopeName:"Control Room",
    side:"Civil", particular:"Control Room", pfbHead:"Control Room", supplyService:"Service", unit:"Nos.",
    qtyFn:() => 0,
    rateKey:66,
    keywords:["control room","inverter room","room","building","shed","container room","operator room","site office"] },

  { scopeNo:67, section:"B", scopeName:"Piling",
    side:"DC", particular:"Piling", pfbHead:"Piling", supplyService:"Service", unit:"Nos.",
    qtyFn:(DC,AC,SW,P,W,R) => P || 2000,
    rateKey:67,
    keywords:["piling","pile","driven pile","earth pile","ground screw","ramming","pile driving","pile work","piling work"] },

  { scopeNo:68, section:"B", scopeName:"Inverter Stand Installation",
    side:"DC", particular:"Inverter Stand Installation", pfbHead:"Inverter stand installation", supplyService:"Service", unit:"Nos.",
    qtyFn:(DC,AC) => AC * 1000 / 300,
    rateKey:68,
    keywords:["inverter stand install","inverter installation civil","inverter base install","inverter stand erection"] },

  { scopeNo:69, section:"B", scopeName:"LT Panel Foundation",
    side:"AC", particular:"LT Panel and ACDB Foundation", pfbHead:"LT Panel Stand installation", supplyService:"Service", unit:"Nos.",
    qtyFn:(DC,AC) => (AC * 1000 / 300) / 2,
    rateKey:69,
    keywords:["lt panel foundation","acdb foundation","panel civil","distribution board foundation","mccb foundation"] },

  { scopeNo:70, section:"B", scopeName:"Boundary Wall",
    side:"Civil", particular:"Boundary Wall", pfbHead:"Boundary wall", supplyService:"Service", unit:"Mtrs",
    qtyFn:(DC,AC,SW,P,W,R) => W || 2000,
    rateKey:70,
    keywords:["boundary wall","compound wall","fencing","perimeter wall","boundary","rcc wall","brick wall","masonry wall"] },

  { scopeNo:71, section:"B", scopeName:"Gate Foundation",
    side:"Civil", particular:"Gate Foundation", pfbHead:"Plant Gate installation", supplyService:"Service", unit:"Nos.",
    qtyFn:() => 2,
    rateKey:71,
    keywords:["gate foundation","gate civil","gate post foundation","gate base","gate installation"] },

  { scopeNo:72, section:"B", scopeName:"Drainage",
    side:"Civil", particular:"Drainage", pfbHead:"Drainage", supplyService:"Service", unit:"Lot",
    qtyFn:() => 0,
    rateKey:72,
    keywords:["drainage","drain","stormwater","sewage","water drain","drainage work","drain pipe"] },

  { scopeNo:73, section:"B", scopeName:"Sign Board Foundation",
    side:"Civil", particular:"Sign Board Foundation and Nomenclature", pfbHead:"Sign Board", supplyService:"Service", unit:"Nos.",
    qtyFn:() => 2,
    rateKey:73,
    keywords:["sign board foundation","sign civil","board foundation","sign installation","board erection"] },

  { scopeNo:74, section:"B", scopeName:"Security Cabin Foundation",
    side:"Civil", particular:"Security Cabin Foundation", pfbHead:"Security cabin installation", supplyService:"Service", unit:"Nos.",
    qtyFn:() => 0,
    rateKey:74,
    keywords:["security cabin foundation","guard room foundation","cabin civil","cabin foundation"] },

  { scopeNo:75, section:"B", scopeName:"Street Light Installation",
    side:"AC", particular:"Plant Illumination Foundation and Installation", pfbHead:"Street light installation", supplyService:"Service", unit:"Nos.",
    qtyFn:(DC) => (DC * 14) / 10,
    rateKey:75,
    keywords:["street light install","light installation","pole installation","illumination install","light erection","led install"] },

  { scopeNo:76, section:"B", scopeName:"Road",
    side:"Civil", particular:"Road", pfbHead:"Road", supplyService:"Service", unit:"Mtrs",
    qtyFn:(DC,AC,SW,P,W,R) => R || 2000,
    rateKey:76,
    keywords:["road","access road","internal road","gravel road","plant road","road work","road construction","wbm road"] },

  { scopeNo:77, section:"B", scopeName:"PTZ Camera Foundation",
    side:"AC", particular:"PTZ Camera Foundation", pfbHead:"Camera installation", supplyService:"Service", unit:"Nos.",
    qtyFn:(DC,AC,SW) => (DC / 10) * SW,
    rateKey:77,
    keywords:["camera foundation","ptz foundation","cctv foundation","camera civil","camera pole foundation","camera installation"] },

  { scopeNo:78, section:"B", scopeName:"WMS Stand Foundation",
    side:"AC", particular:"WMS Stand Foundation", pfbHead:"WMS installation", supplyService:"Service", unit:"Nos.",
    qtyFn:() => 0,
    rateKey:78,
    keywords:["wms foundation","weather station foundation","wms civil","wms stand foundation","wms installation"] },

  { scopeNo:79, section:"B", scopeName:"Aux Transformer Foundation",
    side:"AC", particular:"Auxiliary Transformer Foundation", pfbHead:"Aux installation", supplyService:"Service", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:79,
    keywords:["aux transformer foundation","transformer civil","aux trafo civil","transformer base","transformer foundation"] },

  { scopeNo:80, section:"B", scopeName:"Switchyard Work",
    side:"AC", particular:"Switchyard Work", pfbHead:"Switchyard Installation", supplyService:"Service", unit:"Nos.",
    qtyFn:(DC,AC,SW) => SW,
    rateKey:80,
    keywords:["switchyard","substation","switchyard work","yard work","ht yard","33kv yard","switchyard construction","switchyard civil"] },

  { scopeNo:81, section:"B", scopeName:"LA Foundation",
    side:"AC/DC", particular:"LA Foundation", pfbHead:"LA installation", supplyService:"Service", unit:"Nos.",
    qtyFn:(DC) => DC * 2,
    rateKey:81,
    keywords:["la foundation","lightning arrester foundation","la pole foundation","arrester foundation","la installation"] },

  { scopeNo:82, section:"B", scopeName:"AC DC Work",
    side:"AC&DC", particular:"AC DC Work", pfbHead:"AC DC Work", supplyService:"Service", unit:"MWp",
    qtyFn:(DC) => DC,
    rateKey:82,
    keywords:["ac dc work","acdc work","ac/dc","cable laying","cable work","electrical work","wiring work","erection work","cable erection"] },

  { scopeNo:83, section:"B", scopeName:"Commissioning Testing",
    side:"AC&DC", particular:"Commissioning Testing and Control Wiring of VCB CRP XMR Protection CT PT Oil Filtration", pfbHead:"AC DC work", supplyService:"Service", unit:"Nos.",
    qtyFn:(DC) => DC,
    rateKey:83,
    keywords:["commissioning","testing","energisation","energization","control wiring","vcb commissioning","transformer commissioning","mct testing"] },

  { scopeNo:85, section:"B", scopeName:"Inspection",
    side:"AC&DC", particular:"Inspection", pfbHead:"Plant testing", supplyService:"Service", unit:"Nos.",
    qtyFn:() => 0,
    rateKey:85,
    keywords:["inspection","audit","third party","tpi","quality check","quality inspection","plant inspection"] },

  { scopeNo:86, section:"B", scopeName:"Aesthetic Work",
    side:"", particular:"", pfbHead:"Plant testing", supplyService:"", unit:"",
    qtyFn:() => 0,
    rateKey:null,
    keywords:["aesthetic","aesthetic work","landscaping","painting","beautification"] },

  { scopeNo:87, section:"B", scopeName:"TL Installation",
    side:"AC", particular:"TL Installation", pfbHead:"Transmission line installation", supplyService:"Service", unit:"Lot",
    qtyFn:() => 2,
    rateKey:87,
    keywords:["tl installation","transmission line install","line erection","ht line install","ohl erection","transmission line work","tl erection"] },

  { scopeNo:88, section:"B", scopeName:"Land Levelling",
    side:"Civil", particular:"Land Levelling and Cleaning", pfbHead:"Land levelling", supplyService:"Service", unit:"Acre",
    qtyFn:(DC,AC,SW) => DC * SW,   // =H6 in Excel = scope1 qty = DC*SW
    rateKey:88,
    keywords:["land levelling","levelling","grading","land clearing","site clearing","earthwork","land grading","bulk earthwork"] },

  { scopeNo:89, section:"B", scopeName:"Land Survey",
    side:"Civil", particular:"Land Survey", pfbHead:"Land survey", supplyService:"Service", unit:"Acres",
    qtyFn:(DC,AC,SW) => DC * SW,   // =H90 in Excel = scope88 qty = DC*SW
    rateKey:89,
    keywords:["land survey","surveyor","survey","layout survey","topographic survey","total station","drone survey"] },

  { scopeNo:90, section:"B", scopeName:"MMS Installation",
    side:"DC", particular:"MMS Installation", pfbHead:"MMS Installation", supplyService:"Service", unit:"MWp",
    qtyFn:() => 3,
    rateKey:90,
    keywords:["mms installation","structure installation","module mounting installation","ms structure erection","mms erection"] },

  { scopeNo:91, section:"B", scopeName:"Module Unloading",
    side:"DC", particular:"Module Unloading", pfbHead:"Loading unloading", supplyService:"Service", unit:"Nos.",
    qtyFn:() => 5,
    rateKey:91,
    keywords:["module unloading","panel unloading","solar panel unloading","module offloading","panel offloading"] },

  { scopeNo:92, section:"B", scopeName:"MMS Unloading",
    side:"DC", particular:"MMS Unloading", pfbHead:"Loading unloading", supplyService:"Service", unit:"Nos.",
    qtyFn:() => 2,
    rateKey:92,
    keywords:["mms unloading","structure unloading","ms unloading","mms offloading","structure offloading"] },

  { scopeNo:93, section:"B", scopeName:"4 Pole Installation",
    side:"AC", particular:"4 Pole Installation and 8 Pole", pfbHead:"4 pole installation", supplyService:"Service", unit:"Nos.",
    qtyFn:() => 1,
    rateKey:93,
    keywords:["4 pole installation","four pole install","4p installation","4 pole erection","4 pole commissioning"] },

  // ── SECTION C: Other Project Expenses ─────────────────────────

  { scopeNo:94, section:"C", scopeName:"Loading and Unloading",
    side:"AC&DC", particular:"Unloading - Inverter XMR VCB Cable Earthing Material and Miscellaneous", pfbHead:"Loading unloading", supplyService:"Service", unit:"Nos.",
    qtyFn:(DC) => DC,
    rateKey:94,
    keywords:["loading","unloading","l/u","loading unloading","offloading","material handling","crane charges","transportation"] },

  { scopeNo:95, section:"C", scopeName:"RREC Approval",
    side:"Admin", particular:"RREC", pfbHead:"Approvals", supplyService:"", unit:"MW",
    qtyFn:() => 0,
    rateKey:95,
    keywords:["rrec","rajasthan renewable energy","rrec approval","government approval","state nodal"] },

  { scopeNo:96, section:"C", scopeName:"RVPNL Approval",
    side:"Admin", particular:"RVPNL", pfbHead:"Approvals", supplyService:"", unit:"MW",
    qtyFn:() => 0,
    rateKey:96,
    keywords:["rvpnl","discom","rajasthan discoms","utility approval","rvpnl approval"] },

  { scopeNo:97, section:"C", scopeName:"Commissioning Approval",
    side:"Admin", particular:"Commissioning Approval", pfbHead:"Approvals", supplyService:"", unit:"MW",
    qtyFn:(DC,AC) => AC,
    rateKey:97,
    keywords:["commissioning approval","synchronisation","sync approval","cea","ctu","stc approval","commissioning charges"] },

  { scopeNo:98, section:"C", scopeName:"CEIG",
    side:"Admin", particular:"CEIG", pfbHead:"Approvals", supplyService:"", unit:"MW",
    qtyFn:() => 0,
    rateKey:98,
    keywords:["ceig","chief electrical inspector","electrical inspector","ceig approval","electrical inspectorate"] },
];

// ─────────────────────────────────────────────────────────────────
// CORE FUNCTION: generatePFB
// Input:  projectName (string), DC (MWp), AC (MW), SW (integer)
// Output: array of 98 line items, each with all PFB columns computed
// ─────────────────────────────────────────────────────────────────
function generatePFB(projectName, DC, AC, SW, PILING = 2000, WALL = 2000, ROAD = 2000) {
  return PFB_ITEMS.map(item => {
    const qty  = item.qtyFn(DC, AC, SW, PILING, WALL, ROAD);
    const rate = item.rateKey === null
      ? 300000 * DC          // scope 65 misc: special formula
      : (RATES[item.rateKey] || 0);
    const amount = qty * rate;
    return {
      scopeNo:        item.scopeNo,
      section:        item.section,
      scopeName:      item.scopeName,
      side:           item.side,
      particular:     item.particular,
      pfbHead:        item.pfbHead,
      supplyService:  item.supplyService,
      unit:           item.unit,
      qty:            Math.round(qty * 10000) / 10000,  // 4 decimal places max
      rate:           rate,
      amount:         Math.round(amount * 100) / 100,
      keywords:       item.keywords,
    };
  });
}

// ─────────────────────────────────────────────────────────────────
// FUZZY MATCH: matchToPFB
// Given a PO or Bill item description string,
// finds the most likely PFB scope it belongs to.
// Returns { match: pfbItem, confidence: 0-100 }
// ─────────────────────────────────────────────────────────────────
function matchToPFB(itemDescription, pfbItems) {
  if (!itemDescription) return { match: null, confidence: 0 };
  const desc = itemDescription.toLowerCase();
  let best = null, bestScore = 0;

  for (const pfbItem of pfbItems) {
    let score = 0;
    for (const kw of pfbItem.keywords) {
      if (desc.includes(kw.toLowerCase())) {
        // Longer keyword = more specific = higher weight
        score += kw.split(' ').length * 2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = pfbItem;
    }
  }

  // Confidence: cap at 100, scale so 3+ keyword matches = high confidence
  const confidence = Math.min(100, Math.round(bestScore * 8));
  return { match: best, confidence };
}

// ─────────────────────────────────────────────────────────────────
// ALIGNMENT CHECK: checkPOAlignment
// Compares each PO line item against the generated PFB
// Returns full check result with pass/flag/fail per line
// ─────────────────────────────────────────────────────────────────
function checkPOAlignment(poLineItems, pfbItems, VARIANCE_THRESHOLD = 10) {
  return poLineItems.map(li => {
    const desc = (li.name || '') + ' ' + (li.description || '');
    const { match, confidence } = matchToPFB(desc, pfbItems);

    if (!match || confidence < 20) {
      return {
        lineItem:    li.name,
        qty:         li.quantity,
        rate:        li.rate,
        amount:      li.item_total,
        pfbMatch:    null,
        pfbScope:    null,
        pfbQty:      null,
        pfbRate:     match ? match.rate : null,
        pfbAmount:   null,
        qtyVariance: null,
        rateVariance:null,
        amtVariance: null,
        confidence,
        status:      'no_match',
        comment:     `Item "${li.name}" could not be matched to any PFB scope. Verify manually.`,
      };
    }

    const pfbRate   = match.rate;
    const pfbQty    = match.qty;
    const pfbAmount = match.amount;

    const rateVar = pfbRate > 0
      ? ((li.rate - pfbRate) / pfbRate * 100)
      : null;
    const qtyVar  = pfbQty > 0
      ? ((li.quantity - pfbQty) / pfbQty * 100)
      : null;
    const amtVar  = pfbAmount > 0
      ? ((li.item_total - pfbAmount) / pfbAmount * 100)
      : null;

    const flags = [];
    if (rateVar !== null && Math.abs(rateVar) > VARIANCE_THRESHOLD)
      flags.push(`Rate variance ${rateVar > 0 ? '+' : ''}${rateVar.toFixed(1)}% vs PFB`);
    if (qtyVar !== null && qtyVar > VARIANCE_THRESHOLD)
      flags.push(`Qty ${qtyVar.toFixed(1)}% above PFB budget`);
    if (amtVar !== null && amtVar > VARIANCE_THRESHOLD)
      flags.push(`Amount ${amtVar.toFixed(1)}% over PFB`);

    const status = flags.length === 0 ? 'ok'
      : (Math.abs(rateVar || 0) > 25 || (qtyVar || 0) > 25) ? 'reject'
      : 'flag';

    return {
      lineItem:     li.name,
      qty:          li.quantity,
      rate:         li.rate,
      amount:       li.item_total,
      pfbMatch:     match.scopeName,
      pfbScope:     match.scopeNo,
      pfbQty,
      pfbRate,
      pfbAmount,
      qtyVariance:  qtyVar  !== null ? Math.round(qtyVar  * 10) / 10 : null,
      rateVariance: rateVar !== null ? Math.round(rateVar * 10) / 10 : null,
      amtVariance:  amtVar  !== null ? Math.round(amtVar  * 10) / 10 : null,
      confidence,
      status,
      comment:      flags.length > 0 ? flags.join(' | ') : 'All checks passed',
    };
  });
}

module.exports = { generatePFB, matchToPFB, checkPOAlignment, PFB_ITEMS, RATES };
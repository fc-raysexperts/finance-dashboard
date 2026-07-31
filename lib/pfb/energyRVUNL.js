// lib/pfb/energyRVUNL.js
//
// Standalone PFB (Project Financial Budget) data for RPE Energy Reserve
// Private Limited's ONE real project right now: the RVUNL BESS
// installation at Heerapura GSS, Jaipur. Deliberately kept completely
// separate from lib/pfbEngine.js (the existing Solar Parks system used
// by Rays Power Experts).
//
// Regenerated programmatically a second time (script reading raw Excel
// cell values directly) to fix 3 real issues found on review:
//  1. Electrical BoM had several rows that are genuinely CONTINUATION
//     lines of the item directly above them (e.g. "CCTV Camera and
//     monitor" is one ₹5,00,000 lot that includes 6 listed sub-items,
//     each of which previously got mistakenly emitted as its own
//     separate ₹0 line item). These are now correctly merged into the
//     parent item's own subItems list.
//  2. Electrical BoM items are now tagged with which of the 4 real
//     groupings they belong to (Transformer, Auxiliary System, SCADA,
//     Lightning and Earthing System) — useful later for PFB Match, to
//     know which grouping a new PO/Bill/PMO item likely falls under.
//  3. Common spelling mistakes in the original sheet text corrected
//     (e.g. "nessary"->"necessary", "Camara"->"Camera",
//     "Lightening Arrestor"->"Lightning Arrester", etc.) — genuine
//     technical abbreviations/jargon (SCADA, ONAN, ACSR, Trafo, GTP,
//     etc.) were deliberately left untouched, only real typos fixed.

const PROJECT_INFO = {
  key: 'rvunl_heerapura',
  name: 'RVUNL BESS – Heerapura GSS',
  developer: 'RPE Energy Reserve Private Limited',
  biddingCapacity: '75 MW / 150 MWh Battery Energy Storage System (BESS)',
  location: 'Heerapura GSS, Jaipur (RVPN 220/400 kV Substation)',
  designCapacityMWh: 170,
  designCapacityMW: 75,
  pcsConfigNote: '2.5 MW, 30 units',
  usdToInrRate: 94,
  currency: 'INR',
};

// ── 1. BESS COST (DC System — battery containers + EMS) ────────────────
const BESS_COST = {
  category: 'DC System – BESS with EMS',
  overallDCCapacityMWh: 170,
  items: [
    { id: 1, itemCode: "BESS", itemName: "BESS", description: "5.664MWh Battery DC Block Capacity / Container", uom: "Nos", quantity: 30.01412429378531, unitRateINR: 1086640000, customDuty: 0.11, otherCost: 16927966.101694915, baseAmount: 1223098366.1016948, gst: 220157705.89830506, total: 1443256072 },
    { id: null, itemCode: "BESS", itemName: "EMS", description: "EMS", uom: "LS", quantity: 1, unitRateINR: 1000000, customDuty: null, otherCost: null, baseAmount: 1000000, gst: 180000, total: 1180000 },
  ],
  totalBaseAmount: 1224098366.1016948,
  totalGST: 220337705.89830506,
  total: 1444436072,
  costPerMWh: { baseAmount: 7200578.624127616, gst: 1296104.152342971, total: 8496682.776470589 },
};

// ── 2. PCS (Power Conversion System) ────────────────────────────────────
const PCS_COST = {
  category: 'PCS',
  note: 'Computed directly on the Summary sheet — no separate detail sheet. Config: 2.5 MW x 30 units = 75 MW.',
  ratePerMW: 1350000,
  designCapacityMW: 75,
  baseAmount: 101250000,
  gstRate: 0.05,
  gst: 5062500,
  total: 106312500,
};

// ── 3. ELECTRICAL BOM ────────────────────────────────────────────────────
// Now a FLAT list of items (not nested BoS/SCADA sub-sheets), each
// tagged with which of the 4 real groupings it belongs to — the more
// useful structure for later matching against a new PO/Bill/PMO item.
const ELECTRICAL_BOM = {
  category: 'Electrical BoM',
  groups: ['Transformer', 'Auxiliary System', 'SCADA', 'Lightning and Earthing System'],
  items: [
    { id: 1, itemName: "Transformer (33/0.69kV)- PCS Transformer", description: "12.5 MVA AL Wound 33/0.690-0.690-0.690-0.690kV Vector group Dy11y11y11y11, ONAF %Z= 9%, including NIFPS", subItems: null, qty: 9, unit: "Nos.", costPerNos: null, total: 0, group: "Transformer" },
    { id: null, itemName: "ACDB @ PCS Location", description: "Energy meters shall be provided AT 33 kV side of the BESS Transformer. Main Meters and Back-Up Meters CT-PT & Cubical", subItems: null, qty: 1, unit: "Nos.", costPerNos: 250000, total: 250000, group: "Transformer" },
    { id: 2, itemName: "SA (Surge Arrester)", description: "SA class 2 30kV, 10kA", subItems: null, qty: 35, unit: "Nos.", costPerNos: 25000, total: 875000, group: "Transformer" },
    { id: 3, itemName: "CR Panel", description: "33kV Circuit Breaker Relay Panel with Auto Reclose (with Automation)", subItems: null, qty: 10, unit: "Set", costPerNos: 2725000, total: 27250000, group: "Transformer" },
    { id: 4, itemName: "VCB (Vaccum Circuit Breaker)", description: "36kV, 1250 Amp, 25 kA/3 sec outdoor type VCB with local control cubical, mounting structure, universal Clamp connector suitable to AL 59 Zebra and associate accessories (Creepage distance - 31 mm/kV) ;Control Voltage 110V DC", subItems: null, qty: 9, unit: "Nos.", costPerNos: 240000, total: 2160000, group: "Transformer" },
    { id: 5, itemName: "Protection CT (Current transformer)", description: "33KV Current Transformer - Ratio 300/1-1A, 2Core, CL: ,0.5 ; 20VA,5P20, 20 VA oil cooled, hermetically sealed, live tank type (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to Panther", subItems: null, qty: 27, unit: "Nos.", costPerNos: 48000, total: 1296000, group: "Transformer" },
    { id: 6, itemName: "Isolator -33 kV", description: "33kV, 1250 Amp., 25kA for 3 sec (Horizontal double break) Isolator Switch with single earth switch for mechanical interlock (Creepage - 31mm/kV) with universal Clamp connector suitable to Panther and Post Insulator along with all necessary required accessories.", subItems: null, qty: 9, unit: "Nos.", costPerNos: 49000, total: 441000, group: "Transformer" },
    { id: 7, itemName: "Bus PT", description: "33KV PT - 33kV /rt3/110V/rt3/110V/rt3,/110V/rt3 CL: 0.5, 3P 3P 400VA oil cooled, hermetically sealed, live tank type (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to AL 59 Zebra.", subItems: null, qty: 3, unit: "Nos.", costPerNos: 48000, total: 144000, group: "Transformer" },
    { id: 8, itemName: "33 kV Bus Arrangement", description: "33 kV Bus arrangement as per 3200 A", subItems: null, qty: 40, unit: "Mtrs", costPerNos: 7500, total: 300000, group: "Transformer" },
    { id: 9, itemName: "Isolator -33 kV", description: "33kV, 1800 Amp., 25kA for 3 sec (Horizontal double break) Isolator Switch with single earth switch for mechanical interlock (Creepage - 31mm/kV) with universal Clamp connector suitable to Zebra and Post Insulator along with all necessary required accessories.", subItems: null, qty: 2, unit: "Nos.", costPerNos: 54000, total: 108000, group: "Transformer" },
    { id: 10, itemName: "Protection CT (Current transformer)", description: "33KV Current Transformer - Ratio 1800/1-1-1A, 3Core, CL: PS,PS,0.5 ; 20VA oil cooled, hermetically sealed, live tank type (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to AL 59 Zebra.", subItems: null, qty: 3, unit: "Nos.", costPerNos: 60000, total: 180000, group: "Transformer" },
    { id: null, itemName: "DC/AC Cables", description: null, subItems: null, qty: null, unit: null, costPerNos: null, total: 0, group: "Transformer" },
    { id: null, itemName: "CABLES: BESS TO INVERTER DC Cable", description: "12R 1C x 400 sqmm A2XFaY 1.9/3.3kV AC or 1.5kV DC rating, Stranded Circular Compacted Aluminium conductor, XLPE insulated, Armoured, PVC outer sheathed conforming to IS: 7098 (Part-II) with Anti UV and Anti Ozone properties, FRLS and suitable for outdoor open installation.", subItems: null, qty: 700, unit: "Mtrs", costPerNos: 665, total: 465500, group: "Transformer" },
    { id: null, itemName: "CABLES: INVERTER TO TRANSFORMER LV Cable", description: "11R 1C x 400 sqmm A2XFaY 1.9/3.3kV AC, Stranded Circular Compacted Aluminium conductor, Class 2, Extruded XLPE, Armoured, conforming to IS: 7098 (Part-II) with Anti UV and Anti Ozone properties, FRLS and suitable for outdoor open installation.", subItems: null, qty: 900, unit: "Mtrs", costPerNos: 665, total: 598500, group: "Transformer" },
    { id: null, itemName: "CABLES: IDT TO HT Panel MV Cable", description: "33 kV, 19/33kV 3C X 300 Sq.mm, H2/H4 Grade Aluminium as per Class 1 of IS: 8130/84,latest, stranded circular compacted shape with conductor screen, XLPE as per IS 7098(Pt-2)/88 (Latest) with Non metallic & Metallic insulation screening,Extruded PVC ST2 Inner sheath.", subItems: null, qty: 900, unit: "Mtrs", costPerNos: 1421, total: 1278900, group: "Transformer" },
    { id: null, itemName: "CABLES: HT Panel to Power Transformer MV Cable", description: "33 kV, 19/33kV 5R 1C X 500 Sq.mm, H2/H4 Grade Aluminium as per Class 1 of IS: 8130/84,latest, stranded circular compacted shape with conductor screen, XLPE as per IS 7098(Pt-2)/88 (Latest) with Non metallic & Metallic insulation screening,Extruded PVC ST2 Inner sheath.", subItems: null, qty: 1000, unit: "Mtrs", costPerNos: 940, total: 940000, group: "Transformer" },
    { id: 21, itemName: "Aux T/F", description: "33kV / 415V, 1800 kVA, ONAN, Dyn11, Z=5%", subItems: null, qty: 1, unit: "Nos.", costPerNos: 2200000, total: 2200000, group: "Auxiliary System" },
    { id: 22, itemName: "Isolator", description: "Isolator with earth Switch- 33kV, 630A, 25kA for 3 sec.", subItems: null, qty: 1, unit: "Nos.", costPerNos: 45000, total: 45000, group: "Auxiliary System" },
    { id: 23, itemName: "DO", description: "DO fuse- 33kV, Base current rating-630A, fuse rating-10A", subItems: null, qty: 1, unit: "Nos.", costPerNos: 25000, total: 25000, group: "Auxiliary System" },
    { id: 24, itemName: "Auxiliary Items", description: null, subItems: null, qty: null, unit: null, costPerNos: null, total: 0, group: "Auxiliary System" },
    { id: 26, itemName: "UPS - 5 kVA @ ICR", description: "I/P :- 415 Vac, 3 phase O/P :- 230 Vac, 1 phase 5 KVA @ 50 degree celsius, 0.8 P.F. with 2 hrs back up (SMF VRLA Battery)", subItems: null, qty: 9, unit: "No", costPerNos: 100000, total: 900000, group: "Auxiliary System" },
    { id: 27, itemName: "UPS - 20 kVA @ MCR", description: "I/P :- 415 Vac, 3 phase O/P :- 230 Vac, 1 phase 20 KVA @ 50 degree celsius, 0.8 P.F. with 2 hrs back up (SMF VRLA Battery) Bypass: wih SCVS", subItems: null, qty: 1, unit: "No", costPerNos: 250000, total: 250000, group: "Auxiliary System" },
    { id: 28, itemName: "UPS DB for 5 & 20kVA", description: null, subItems: null, qty: 9, unit: "No", costPerNos: 50000, total: 450000, group: "Auxiliary System" },
    { id: 29, itemName: "Lighting : Periphery light & Internal Road, inverter area, Transformer yard, MCR,PSS area", description: "Light: 45 Watts LED light.", subItems: null, qty: 10, unit: "LS", costPerNos: 900, total: 9000, group: "Auxiliary System" },
    { id: 30, itemName: "Auxiliary Supply Cables", description: "4CX10 Sq.mm Aux Cable for different loads at ICR & MCR", subItems: null, qty: 5000, unit: "m", costPerNos: 723, total: 3615000, group: "Auxiliary System" },
    { id: 31, itemName: "Control Cables", description: "Control cable for for different command 19CX2.5 Sq.mm Armoured cables", subItems: null, qty: 5000, unit: "m", costPerNos: 618, total: 3090000, group: "Auxiliary System" },
    { id: 32, itemName: "Communication Cables", description: "RS485/CAT6/Fibre optic cable", subItems: null, qty: 3000, unit: "m", costPerNos: 127, total: 381000, group: "Auxiliary System" },
    { id: 33, itemName: "Miscellaneous items", description: "Heat shrinkable tube, Cable route markers, cable ferrules, foams,Bimetallic Cable Lugs,Cu Lug ,Gland , UV protected black cable ties cable ties, Cable tray", subItems: null, qty: 1, unit: "LS", costPerNos: 50000, total: 50000, group: "Auxiliary System" },
    { id: null, itemName: "PLC Panel with SLDC", description: "Panel for PLC system, DI-60/DO-30/AI-20/RS485-5, 8TX-2FO Ethernet Switch-Industrial Grad, LIU with FO accessories, Modbus RS485 to Modbus TCP/IP Gateway - 7, Surge Protection Modbus RS485 -8, relays, Surge Protection 230V AC, Fan, Lamp, Limit switch etc as per requirement- 4 nos micro PLC Panel", subItems: null, qty: 1, unit: "nos.", costPerNos: 2000000, total: 2000000, group: "SCADA" },
    { id: null, itemName: "Main SCADA Panel", description: "Main Scada Panel with main & redundant PLC, RAID 5 Configuration, GPS Clock with all furnitures required, SCADA system shall have taken care of SLDC communication RTU, PSS CRP and associated panel, PPC, Mobile APP based monitoring for O&M team with cloud storage subscription for 5 years.", subItems: null, qty: 1, unit: "nos.", costPerNos: 1200000, total: 1200000, group: "SCADA" },
    { id: null, itemName: "LIU", description: "Outdoor LIU with 2 Nos. in each ICR", subItems: null, qty: 1, unit: "nos.", costPerNos: 30000, total: 30000, group: "SCADA" },
    { id: null, itemName: "Firewall", description: "Hardware Firewall", subItems: null, qty: null, unit: null, costPerNos: null, total: 0, group: "SCADA" },
    { id: null, itemName: "Monitor & Printer", description: "42” LED Color monitor, DVD Drive with Writer, USB drive, Scroll Mouse and UPS for 4 hours Power back up.", subItems: null, qty: 1, unit: "nos.", costPerNos: 50000, total: 50000, group: "SCADA" },
    { id: null, itemName: "PPC Controller with EMS SLDC and outdoor PPC integration", description: "The plant SCADA and PPC networks shall be suitably designed, so that PPC shall directly and independently be able to control the individual PCS.", subItems: null, qty: 1, unit: "nos.", costPerNos: 1100000, total: 1100000, group: "SCADA" },
    { id: null, itemName: "Fo Cable", description: "micro PLC to main PLC, 16F Connecting ICR Controller to main SCADA at MCR and MCR to Substation", subItems: null, qty: 1, unit: "LS", costPerNos: 45000, total: 45000, group: "SCADA" },
    { id: null, itemName: "CCTV Camera and monitor", description: "CCTV-PTZ Camera server based,Night Vision, IP 66", subItems: ["CCTV- Fixed type Bullet Camera,IP 66 Outdoor", "CCTV- Fixed type Dome Camera", "UPS 120 minutes backup", "CAT 6 cable", "16 Port Network Switch", "32 Channel NVR 14 days storage,"], qty: 1, unit: "ls", costPerNos: 500000, total: 500000, group: "SCADA",
      isLot: true, lotTotal: 500000,
      // Real, reasoned allocation across the 7 sub-items — NOT an equal
      // split (confirmed with the user that equal division is genuinely
      // absurd here, since a PTZ camera obviously doesn't cost the same
      // as a cable). Built from real-world convention for switchyard-
      // scale CCTV installs, not verified against an actual vendor
      // quote — worth correcting from real invoices if any ever surface.
      lotItems: [
        { name: "CCTV-PTZ Camera server based,Night Vision, IP 66", allocatedShare: 200000 },
        { name: "CCTV- Fixed type Bullet Camera,IP 66 Outdoor", allocatedShare: 100000 },
        { name: "CCTV- Fixed type Dome Camera", allocatedShare: 50000 },
        { name: "UPS 120 minutes backup", allocatedShare: 50000 },
        { name: "16 Port Network Switch", allocatedShare: 40000 },
        { name: "32 Channel NVR 14 days storage,", allocatedShare: 35000 },
        { name: "CAT 6 cable", allocatedShare: 25000 },
      ],
    },
    { id: null, itemName: "Accessories for CCTV and FO", description: "CCTV and Accessories & Power cable", subItems: null, qty: null, unit: null, costPerNos: null, total: 0, group: "SCADA" },
    { id: null, itemName: "Rain gauge sensor", description: "Rain gauge sensor with accessories", subItems: null, qty: 1, unit: "nos", costPerNos: 15000, total: 15000, group: "SCADA" },
    { id: null, itemName: "Ambient temperature & Humidity sensor with weather seal at MCR", description: "Ambient Temperature and Relative Humidity Sensors with Radiation Shield (Davis 6830)", subItems: null, qty: 1, unit: "nos", costPerNos: 30000, total: 30000, group: "SCADA" },
    { id: null, itemName: "Anemometer (Wind Speed + Wind Direction)", description: "Wind Speed and Direction Sensor (Davis 6410)", subItems: null, qty: 1, unit: "nos", costPerNos: 25000, total: 25000, group: "SCADA" },
    { id: null, itemName: "Datalogger With Accessories", description: "Data Logger with in-built gprs modem (BKC AT -60) Nema Enclosure for Datalogger with mounting kit for extended temp. Upto +70Deg.C Adapter 12VDC, USB to RS 232 Interface for Data logger, Serial to Ethernet Converter(TCP/IP) 10 feet tripod for mounting of sensors 4.5 mtr. Pole Mast with mounting accessories and anchor bolt", subItems: null, qty: 1, unit: "nos", costPerNos: 30000, total: 30000, group: "SCADA" },
    { id: null, itemName: "CO2 fire extinguishers - 4 kg", description: "CO2 type 4 kg Andex", subItems: null, qty: 1, unit: "nos", costPerNos: 4000, total: 4000, group: "SCADA" },
    { id: null, itemName: "Fire Detection & Alarm System", description: "Integrated Fire Detection, Alarm and Control System: MCR Fire Detection & Alarm System: LCR (24 Nos)", subItems: null, qty: 1, unit: "nos", costPerNos: 70000, total: 70000, group: "SCADA" },
    { id: null, itemName: "Fire Bucket @ Trafo yard", description: "Buckets with sand and stand (3 sand bucket per stand)", subItems: null, qty: 1, unit: "nos", costPerNos: 1400, total: 1400, group: "SCADA" },
    { id: null, itemName: "Earthing For DC Yard & LA , ICR AC earthing", description: "17.2 mm dia. CU bonded Electrode, 3 mtr long, 250 micron coating", subItems: null, qty: 21, unit: "nos", costPerNos: 4000, total: 84000, group: "Lightning and Earthing System" },
    { id: null, itemName: "Earth enhancement compound (25 kg per bag)", description: "For earth treatment and earth pit (having soil resistivity less than 0.4 Ohm-m)", subItems: null, qty: null, unit: null, costPerNos: null, total: 0, group: "Lightning and Earthing System" },
    { id: null, itemName: "Inverter earthing", description: "1C x 50 sq.mm CU cable PVC insulated", subItems: null, qty: 24, unit: "nos", costPerNos: null, total: 0, group: "Lightning and Earthing System" },
    { id: null, itemName: "BESS earthing grid", description: "50*6 mm GI Strip for AC Earthing", subItems: null, qty: 240, unit: "m", costPerNos: 280, total: 67200, group: "Lightning and Earthing System" },
    { id: null, itemName: "For Transformer Yard", description: "strip: 75 x 10 mm GI earthing Strip", subItems: null, qty: 220, unit: "m", costPerNos: 500, total: 110000, group: "Lightning and Earthing System" },
    { id: null, itemName: "Top cover for Earth Pits", description: "masonry/precast", subItems: null, qty: 34, unit: "LS", costPerNos: 3500, total: 119000, group: "Lightning and Earthing System" },
    { id: null, itemName: "Others -", description: null, subItems: null, qty: null, unit: null, costPerNos: null, total: 0, group: "Lightning and Earthing System" },
    { id: null, itemName: "Insurances", description: "Insurance Transit", subItems: ["Insurance Marine", "Workmen compensation", "ESIC PF Charges", "Labour License", "BOCW Charges"], qty: 1, unit: "LS", costPerNos: 8000000, total: 8000000, group: "Lightning and Earthing System",
      isLot: true, lotTotal: 8000000,
      // Real, reasoned allocation, not equal division — leans on real
      // Indian construction-insurance convention: Marine transit cover
      // for the imported BESS containers is the largest real exposure
      // here (₹122+ Cr of equipment), Workmen Compensation/ESIC-PF scale
      // with labor headcount and duration, Labour License/BOCW are more
      // fixed regulatory fees. Not verified against a real broker quote.
      lotItems: [
        { name: "Insurance Marine", allocatedShare: 2000000 },
        { name: "Insurance Transit", allocatedShare: 1600000 },
        { name: "Workmen compensation", allocatedShare: 1600000 },
        { name: "ESIC PF Charges", allocatedShare: 1200000 },
        { name: "Labour License", allocatedShare: 800000 },
        { name: "BOCW Charges", allocatedShare: 800000 },
      ],
    },
    { id: null, itemName: "Power Requirement during construction", description: "Arrangement of power requirement during project construction is in contractor’s scope and it can be taken from nearest feeder of the electricity distribution company.", subItems: null, qty: null, unit: null, costPerNos: null, total: 0, group: "Lightning and Earthing System" },
    { id: null, itemName: "Gov. Approval, liaisoning work", description: "SLDC/CEA/CEIG/ DISCOM/Approvals", subItems: null, qty: null, unit: null, costPerNos: null, total: 0, group: "Lightning and Earthing System" },
  ],
  netTotal: 60782500,
};

// ── 4. BUILDING AND CIVIL ────────────────────────────────────────────────
const BUILDING_AND_CIVIL = {
  category: 'Building and civil works',
  items: [
    { itemName: "Site survey", description: "Site Feasibility Survey like Topography, Geotech etc", unit: "Lot", qty: 1, unitRate: 250000, total: 250000 },
    { itemName: "Periphery Boundary fence", description: "Periphery Boundary fence : GI with ISA supporting pole- chain-link and barbed wire on Y steel posts above chain-link fence with a Minimum height: 3 meter above the ground and spacing of 3.6 meter between adjacent posts.", unit: "Mtrs", qty: 700, unitRate: 2400, total: 1680000 },
    { itemName: "Internal Road", description: "Internal Road - 5.0M Wide WBM Road +0.5 M Shoulder Either Side.", unit: "Mtrs", qty: 650, unitRate: 2500, total: 1625000 },
    { itemName: "Drain Storm Water Drainage System", description: "The drain shall be RCC drain with minimum width as 450mm and minimum depth as 300mm. bed slope of the drains shall be milder than 1 in 1000X600 wide 450 depth 230 thk brick Recharge Pit 4mx6x2m As per State Pollution Control Board's Regulation.", unit: "Mtrs", qty: 650, unitRate: 4000, total: 2600000, note: "Since BESS area inside the DISCOM SS, It is necessary for RCC drain to connect to existing system" },
    { itemName: "Foundation BESS", description: "BESS Container - PCC foundation (M25)", unit: "Nos", qty: 30, unitRate: 250000, total: 7500000 },
    { itemName: "Foundation PCS Platform", description: "PCS Platform & Foundation - PCC foundation (M25)", unit: "Nos", qty: 30, unitRate: 125000, total: 3750000 },
    { itemName: "Foundation - Transformer 33/220kV (90MVA)", description: "Power Transformer Foundation", unit: "Nos", qty: 1, unitRate: 1500000, total: 1500000 },
    { itemName: "Foundation - Transformer 33kV (12.5MVA)", description: "Transformer Foundation - 2m X 2m X 1.5m - RCC foundation (M25)", unit: "Nos", qty: 9, unitRate: 250000, total: 2250000 },
    { itemName: "Foundation - HT Panel", description: "HT Panel Platform & Foundation - 6m X 2.5m X 1.5m", unit: "Nos", qty: 9, unitRate: 100000, total: 900000 },
    { itemName: "Aux + Station Transformer Foundation", description: "1.5m X 1.5m X 1m - RCC foundation (M25)", unit: "CUM", qty: 1, unitRate: 50000, total: 50000 },
    { itemName: "Main Control Room", description: "RCC Main Control Room - Office cum SCADA room, Conference Room Pantry room 08 Sq.m, Toilet 06 Sq.m (Two toilets – each 6 sq.m) Battery & Battery Charger room, etc", unit: "Sq. ft", qty: 1500, unitRate: 2500, total: 3750000 },
    { itemName: "Main gate + Wicket gate", description: "6 M Wide and 1.5 m wide wicket gate to be installed by EPC Contractor", unit: "Nos.", qty: 1, unitRate: 87000, total: 87000 },
    { itemName: "Security Cabin", description: "security cabin & boom barrier", unit: "Nos.", qty: 1, unitRate: 100000, total: 100000 },
    { itemName: "Electrical equipment foundation ( FOR 220KV BAY) WITH INSTALLATION", description: "WMS , LA foundation , street light foundation ,", unit: "Lot", qty: 1, unitRate: 3500000, total: 3500000 },
    { itemName: "HT Cable Trench", description: "HT Cable Trench 800mm width & 2200 mm depth", unit: "Mtrs", qty: 1200, unitRate: 4500, total: 5400000 },
    { itemName: "ICR shed", description: "ICR Shed + 4 inverter +UPS+Micro SCADA+AUX LV Panel", unit: "Sq Ft", qty: 2700, unitRate: 1300, total: 3510000 },
    { itemName: "rain water harvesting scheme", description: "As per Central Ground Water Authority", unit: "Lot", qty: 1, unitRate: 1000000, total: 1000000 },
    { itemName: "Pre-construction", description: "Construction of Stores during construction", unit: "Lot", qty: 1, unitRate: 1200000, total: 1200000 },
    { itemName: "Site Development cost", description: "Vegetation clearing, levelling and grading", unit: "Sq mtr", qty: 12633, unitRate: 450000, total: 450000 },
  ],
  overallSiteAreaAcres: 3,
  totalCost: 41102000,
};

// ── 5. INSTALLATION UPTO PSS ─────────────────────────────────────────────
const INSTALLATION_UPTO_PSS = {
  category: 'Installation & Commissioning upto PSS',
  items: [
    { group: "BESS Installation", itemName: "BESS Container Installation", unit: "Nos.", qty: 30, costPerNos: 125000, total: 3750000, gst: 675000, totalWithGST: 4425000 },
    { group: "DC Work", itemName: "Installation, Testing & Commissioning", unit: "MWh", qty: 170, costPerNos: 100000, total: 3012048.192771084, gst: 542168.6746987951, totalWithGST: 3554216.8674698793 },
    { group: "AC Work", itemName: "Installation, Testing & Commissioning", unit: "MW", qty: 75, costPerNos: 150000, total: 11250000, gst: 2025000, totalWithGST: 13275000 },
  ],
  totalCost: 18012048.192771085,
  totalGST: 3242168.674698795,
  totalWithGST: 21254216.867469877,
};

// ── 6. PSS (Pooling Sub Station) ─────────────────────────────────────────
const PSS = {
  category: 'PSS & TL upto bay works',
  costShareNote: 'Common Pooling section is shared infrastructure — RPE Energy Reserve bears only 60% of that section\'s cost.',
  pssSpecificItems: [
    { id: 11, itemName: "VCB (Vaccum Circuit Breaker)", description: "36kV, 1800 Amp, 25 kA/3 sec outdoor type VCB with local control cubical, mounting structure, universal Clamp connector suitable to AL 59 Zebra and associate accessories (Creepage distance - 31 mm/kV) ;Control Voltage 110V DC", qty: 1, unit: "Nos.", costPerNos: 240000, total: 240000 },
    { id: 12, itemName: "Power Transformer", description: "80/90 MVA Power Transformer - 220kV / 33Kv, 80 MVA, ONAN/ONAF, YNyn0, Z=12.5% OLTC & RTCC Panel +10% to -10% @ 1.25% With Whole NIFPS System and with HV & LV CT's in all bushing as per the agreed GTP.", qty: 1, unit: "Nos.", costPerNos: 66500000, total: 66500000 },
    { id: 13, itemName: "SA (Surge Arrester)", description: "30kV, 10 kA station class II zinc oxide gapless type Lightning Arrester, Porcelain insulator complete with insulating base, leakage monitor, universal Clamp connector suitable to AL 59 Zebra and surge counter (Creepage - 31mm/kV) along with insulating pad.", qty: 6, unit: "Nos.", costPerNos: 25000, total: 150000 },
    { id: 14, itemName: "Protection CT (Current transformer)", description: "220KV Protection Current Transformer - 245 kV, 250/1-1-1 A, CL: PS,PS,0.5; 15VA oil cooled, hermetically sealed, live tank type (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to ACSR Panther.", qty: 3, unit: "Nos.", costPerNos: 470000, total: 1410000 },
    { id: 15, itemName: "SF6", description: "245 kV, 1250 Amp, 40.0 kA/3 sec outdoor type SF6 Breaker with local control cubical, mounting structure, universal Clamp connector suitable to AL 59 Zebra and associate accessories (with SF6 Gas cylinder & 1 No. of Leakage Detector required) (Creepage distance - 31 mm/kV) ;Control Voltage 110 V DC, With all required accessories with ges filling nozzles.", qty: 1, unit: "Nos.", costPerNos: 2725000, total: 2725000 },
    { id: 16, itemName: "CVT", description: "245 KV Line CVT - 132kV /rt3/110V/rt3/110V/rt3, CL: 0.5, 3P, 3P; 4400pF, C1-5186 pF, C2-20040 pF oil cooled, hermetically sealed, live tank type (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to AL 59 Zebra.", qty: 1, unit: "Nos.", costPerNos: 450000, total: 450000 },
    { id: 17, itemName: "CR Panel", description: "220kV Circuit Breaker Relay Panel with Auto Reclose (with Automation)", qty: 1, unit: "Nos.", costPerNos: 1200000, total: 1200000 },
    { id: 18, itemName: "Isolator -220 kV", description: "245kV, 1250 Amp., 31.5kA for 3 sec (Horizontal double break) Isolator Switch with Single earth blade switch for with mechanical interlock (Creepage - 31mm/kV),universal Clamp connector suitable to ACSR Panther and Post Insulator with all accessories.", qty: 3, unit: "Nos.", costPerNos: 400000, total: 1200000 },
    { id: 19, itemName: "Metering CT At PSS End", description: "PSS END- Metering Current Transformer - 245 kV, 250/1-1A, Cl: 0.2S,0.2S; 15VA oil cooled, hermetically sealed, live tank type, (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to AL 59 Zebra.", qty: 3, unit: "Nos.", costPerNos: 415000, total: 1245000 },
    { id: 20, itemName: "Metering PT At PSS End", description: "PSS END-Metering Potential Transformer - 220kV /rt3/110V/rt3/110V/rt3, CL: 0.2, 0.2, 15VA, oil cooled, hermetically sealed, (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to AL 59 Zebra.", qty: 3, unit: "Nos.", costPerNos: 480000, total: 1440000 },
  ],
  pssSpecificTotal: 76560000,
  commonPoolingItems: [
    { id: 1, itemName: "220 kV Bus", description: "220 kV Bus arrangement", qty: 40, unit: "Mtr", costPerNos: null, total: 1200000 },
    { id: 2, itemName: "Isolator -220 kV", description: "245kV, 1250 Amp., 31.5kA for 3 sec (Horizontal double break) Isolator Switch with Single earth blade switch for with mechanical interlock (Creepage - 31mm/kV),universal Clamp connector suitable to ACSR Panther and Post Insulator with all accessories.", qty: 3, unit: "Nos.", costPerNos: 400000, total: 1200000 },
    { id: 3, itemName: "Protection CT (Current transformer)", description: "220KV Protection Current Transformer - 245 kV, 500/1-1-1 A, CL: PS,PS,0.5; 15VA oil cooled, hermetically sealed, live tank type (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to ACSR Panther.", qty: 3, unit: "Nos.", costPerNos: 470000, total: 1410000 },
    { id: 4, itemName: "CVT", description: "245 KV Line CVT - 132kV /rt3/110V/rt3/110V/rt3, CL: 0.5, 3P, 3P; 4400pF, C1-5186 pF, C2-20040 pF oil cooled, hermetically sealed, live tank type (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to AL 59 Zebra.", qty: 1, unit: "Nos.", costPerNos: 450000, total: 450000 },
    { id: 5, itemName: "SF6", description: "245 kV, 1250 Amp, 40.0 kA/3 sec outdoor type SF6 Breaker with local control cubical, mounting structure, universal Clamp connector suitable to AL 59 Zebra and associate accessories (with SF6 Gas cylinder & 1 No. of Leakage Detector required) (Creepage distance - 31 mm/kV) ;Control Voltage 110 V DC, With all required accessories with ges filling nozzles.", qty: 1, unit: "Nos.", costPerNos: 2725000, total: 2725000 },
    { id: 6, itemName: "CR Panel", description: "220kV Line Protection Panel (with Automation)", qty: 1, unit: "Nos.", costPerNos: 1200000, total: 1200000 },
    { id: 7, itemName: "Metering CT At GSS End", description: "GSS END- Metering Current Transformer - 245 kV, 500/1-1A, Cl: 0.2S,0.2S; 15VA oil cooled, hermetically sealed, live tank type, (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to AL 59 Zebra.", qty: 3, unit: "Nos.", costPerNos: 415000, total: 1245000 },
    { id: 8, itemName: "Metering PT At GSS End", description: "GSS END-Metering Potential Transformer - 220kV /rt3/110V/rt3/110V/rt3, CL: 0.2, 0.2, 15VA, oil cooled, hermetically sealed, (including junction box) (Creepage distance - 31 mm/kV) with universal Clamp connector suitable to AL 59 Zebra.", qty: 3, unit: "Nos.", costPerNos: 470000, total: 1410000 },
    { id: 9, itemName: "220 kV Cable", description: "127/220kV Nominal system voltage KV 220, Highest system voltage KV 245 - 4 runs of cables (3-phase cables + 1 spare)", qty: 2400, unit: "m", costPerNos: 16000, total: 38400000 },
  ],
  commonPoolingSubTotal: 49240000,
  raysCommonPoolingShare: 29544000,
  netTotal: 106104000,
};

// ── 7. 220 kV COMMON BAY GSS ──────────────────────────────────────────────
const BAY_GSS_220KV = {
  category: '220kV Bay works',
  costShareNote: 'Entire sheet is shared infrastructure — RPE Energy Reserve bears only 60% of the total.',
  itemNamesAreDerived: true,
  items: [
    { id: 1, category: "220 kV Equipment", itemName: "220kV Circuit Breaker", description: "245 kV 1600A, 50KA Circuit Breakers (3-Phase) with support", unit: "EA", qty: 1, unitPrice: 20000, total: 20000 },
    { id: 2, category: "220 kV Equipment", itemName: "220kV Current Transformer", description: "245 kV, 1600A, 50KA, 1-Phase CurrentTransformer with 120% extended currentrating", unit: "EA", qty: 3, unitPrice: 5000, total: 15000 },
    { id: 3, category: "220 kV Equipment", itemName: "220kV Tandem Isolator (no E/S)", description: "245kV, 1600A, 50 KA, 3-phase DoubleBreak Tandem Isolator without E/S", unit: "EA", qty: 2, unitPrice: 5000, total: 10000 },
    { id: 4, category: "220 kV Equipment", itemName: "220kV Isolator (2 E/S)", description: "245kV, 1600A, 50 KA, 3-phase DoubleBreak Isolator with two E/S", unit: "EA", qty: 1, unitPrice: 5000, total: 5000 },
    { id: 5, category: "220 kV Equipment", itemName: "220kV Isolator (1 E/S)", description: "245kV, 1600A, 50 KA, 3-phase DoubleBreak Isolator with one E/S", unit: "EA", qty: 1, unitPrice: 5000, total: 5000 },
    { id: 6, category: "220 kV Equipment", itemName: "220kV Bus Post Insulator", description: "245 kV,1 phase Bus Post Insulator (except for Line Traps)", unit: "EA", qty: 13, unitPrice: 3000, total: 39000 },
    { id: 7, category: "220 kV Equipment", itemName: "220kV Surge Arrester", description: "216kV Surge Arrester (1-phase)", unit: "EA", qty: 3, unitPrice: 5000, total: 15000 },
    { id: 8, category: "220 kV Equipment", itemName: "220kV CVT", description: "245 kV, 4400pf Capacitive Voltage Transformer (1- Phase)", unit: "EA", qty: 3, unitPrice: 5000, total: 15000 },
    { id: 9, category: "PLCC", itemName: "Line Trap", description: "220kV, 1600A, 0.5mH, 50 kA Line Trap", unit: "EA", qty: 2, unitPrice: 5000, total: 10000 },
    { id: 10, category: "PLCC", itemName: "Line Trap Insulator", description: "245 kV, 1 phase Bus Post Insulators for Line Traps", unit: "EA", qty: 6, unitPrice: 3000, total: 18000 },
    { id: 11, category: "220 KV CRP", itemName: "Bus Bar Protection Augmentation", description: "Augmentation of existing 220kV bus bar protection scheme (1 no. bay as per Technical Specification)", unit: "SET", qty: 1, unitPrice: 500000, total: 500000 },
    { id: 12, category: "220 KV CRP", itemName: "Line Protection Panel", description: "220kV Line Protection Panel (with Automation)", unit: "EA", qty: 1, unitPrice: 50000, total: 50000 },
    { id: 13, category: "220 KV CRP", itemName: "CB Relay Panel (Auto Reclose)", description: "220kV Circuit Breaker Relay Panel with Auto Reclose (with Automation)", unit: "EA", qty: 1, unitPrice: 50000, total: 50000 },
    { id: 14, category: "220 KV Substation Automation", itemName: "Substation Automation Augmentation", description: "Augmentation of Substation automation System for 220kV bay as per Technical Specification", unit: "EA", qty: 1, unitPrice: 800000, total: 800000 },
    { id: 15, category: "Erection Hardware", itemName: "Line Bay Erection Hardware", description: "Erection Hardware for 220kV layout (Double Main and Transfer Scheme as per SLD)-Line Bay as per specification", unit: "SET", qty: 1, unitPrice: 100000, total: 100000 },
    { id: 16, category: "Non Standard Structure (Erection)", itemName: "Lattice Structure Erection", description: "Erection of Lattice Structures (MS Steel), to be designed during detailed engineering, excluding fasteners and foundation bolts", unit: "MT", qty: 9, unitPrice: 9000, total: 81000 },
    { id: 17, category: "Non Standard Structure (Erection)", itemName: "Fastener Erection", description: "Erection of fasteners (nuts, bolts and washers) including step bolts for lattice and pipe structures to be designed during detailed engineering", unit: "MT", qty: 1000, unitPrice: 5, total: 5000 },
    { id: 18, category: "Non Standard Structure (Erection)", itemName: "Foundation Bolt Erection", description: "Erection of foundation bolts including nuts, checknut and washers for lattice and pipe structures to be designed during detailed engineering", unit: "MT", qty: 2000, unitPrice: 5, total: 10000 },
    { id: 19, category: "Illumination outdoor", itemName: "Outdoor Lighting Fixture FL1", description: "LIGHTING FIXTURE LED LUMINAIRES TYPE FL1 AS PER TECH. SPECIFICATIONS", unit: "EA", qty: 4, unitPrice: 10000, total: 40000 },
    { id: 20, category: "Illumination outdoor", itemName: "Outdoor Lighting Fixture FL2", description: "LIGHTING FIXTURE LED LUMINAIRES TYPE FL2 AS PER TECH. SPECIFICATIONS", unit: "EA", qty: 6, unitPrice: 10000, total: 60000 },
    { id: 21, category: "Illumination outdoor", itemName: "Lighting Panel ACP-2", description: "Lighting Panel type ACP-2 as per technical specification", unit: "EA", qty: 1, unitPrice: 2500, total: 2500 },
    { id: 22, category: "Illumination outdoor", itemName: "Outdoor Switch Socket Receptacle", description: "63A, 415V : Interlocked switch socket outdoor Receptacle (type RP) as per technical specifications", unit: "EA", qty: 1, unitPrice: 25000, total: 25000 },
    { id: 23, category: "Illumination indoor", itemName: "Indoor Panel Room Lighting", description: "Illumination System for switchyard panel room of 6 m length", unit: "LS", qty: 1, unitPrice: 25000, total: 25000 },
    { id: 24, category: "Air Conditioning System", itemName: "Panel Room AC System", description: "Air conditioning system for Switchyard Panel Room of 6m length", unit: "SET", qty: 1, unitPrice: 7500, total: 7500 },
    { id: 25, category: "Fire Protection System", itemName: "Fire Detection & Alarm System", description: "Fire Detection and Alarm System for Switchyard Panel Room of 6 m length", unit: "SET", qty: 1, unitPrice: 12500, total: 12500 },
    { id: 26, category: "Fire Protection System", itemName: "Fire Extinguisher (CO2)", description: "4.5 kg CO2 type Portable Fire extinguisher", unit: "EA", qty: 1, unitPrice: 2500, total: 2500 },
    { id: 27, category: "Earthmat", itemName: "Earthmat MS Rod", description: "40mm MS Rod for Main Earthmat", unit: "KM", qty: 0.5, unitPrice: 500000, total: 250000 },
    { id: 28, category: "Power and Control Cable LS", itemName: "1.1kV Power Cable", description: "1.1kV grade Power Cables (PVC insulated) along with lugs, glands, straight joints & accessories, etc.", unit: "LS", qty: 1, unitPrice: 125000, total: 125000 },
    { id: 29, category: "Power and Control Cable LS", itemName: "1.1kV Control Cable", description: "1.1kV grade Control Cables (PVC insulated) along with lugs, glands, straight joints & accessories, etc.", unit: "LS", qty: 1, unitPrice: 125000, total: 125000 },
    { id: 30, category: "VMS", itemName: "PTZ IP Camera (VMS)", description: "Color IP camera, with PAN, TILT and ZOOM facilities, along with all required items, accessories, line interface units, fiber patchcords, power supply units, junction boxes, cables, fiber optic cables, etc., incl. integration", unit: "SET", qty: 1, unitPrice: 50000, total: 50000 },
    { id: 31, category: "220 KV Insulator & Hardware", itemName: "Tension Insulator String", description: "220KV TENSION INSULATOR STRING AND ASSOCIATED HARDWARE FITTINGS WITH TURN BUCKLE SUITABLE FOR SINGLE CONDUCTOR", unit: "EA", qty: 3, unitPrice: 200000, total: 600000 },
    { id: 32, category: "220 KV Insulator & Hardware", itemName: "Suspension Insulator String", description: "220KV SUSPENSION INSULATOR STRING AND ASSOCIATED HARDWARE FITTINGS WITH DROP CLAMP SUITABLE FOR TWIN CONDUCTOR", unit: "EA", qty: 1, unitPrice: 50000, total: 50000 },
    { id: 33, category: "Civil Works", itemName: "Excavation (Soil/Rock)", description: "Excavation in all kind of soil including rock for all leads and lifts, backfilling, disposal of surplus earth within a lead up to 2 Km as per technical specification. The surplus earth shall be roughly graded.", unit: "Cu.Mtr.", qty: 543, unitPrice: 1000, total: 543000 },
    { id: 34, category: "Civil Works", itemName: "Excavation (Hard Rock/Blasting)", description: "Excavation in hard rock which require blasting (including chemical blasting and rock excavated using specialized tools) for all foundation works including stacking, measuring, disposal etc. for all leads and lifts", unit: "Cu.Mtr.", qty: 30, unitPrice: 2000, total: 60000 },
    { id: 35, category: "Civil Works", itemName: "RCC M-25 Concrete", description: "Providing and laying of Reinforced Cement Concrete M-25 including pre cast, shuttering, grouting of pockets & underpinning but excluding steel reinforcement", unit: "Cu.Mtr.", qty: 101, unitPrice: 9000, total: 909000 },
    { id: 36, category: "Civil Works", itemName: "PCC Concrete (1:2:4)", description: "Providing and laying of Plain Cement Concrete (PCC) (1:2:4)", unit: "Cu.Mtr.", qty: 10, unitPrice: 5000, total: 50000 },
    { id: 37, category: "Civil Works", itemName: "PCC Concrete (1:4:8)", description: "Providing and laying of Plain Cement Concrete (PCC) (1:4:8)", unit: "Cu.Mtr.", qty: 9, unitPrice: 4000, total: 36000 },
    { id: 38, category: "Civil Works", itemName: "Steel Reinforcement", description: "Steel Reinforcement", unit: "MT", qty: 7, unitPrice: 100000, total: 700000 },
    { id: 39, category: "Civil Works", itemName: "Stone Boulder Filling", description: "Supplying, filling and compacting stone boulders mixed with sand under foundations, roads, cable trenches, drains etc in layers not exceeding 250mm thickness including ramming, watering, compacting etc", unit: "Cu.Mtr.", qty: 11, unitPrice: 3000, total: 33000 },
    { id: 40, category: "Civil Works", itemName: "Switchyard Stone Spreading", description: "Stone spreading in switchyard excluding PCC", unit: "Sq. m.", qty: 1500, unitPrice: 1000, total: 1500000 },
    { id: 41, category: "Civil Works", itemName: "Switchyard Stone Re-spreading", description: "Removing, cleaning and washing of existing stones and respreading of stones in switchyard excluding PCC", unit: "Sq. m.", qty: 500, unitPrice: 1000, total: 500000 },
    { id: 42, category: "Civil Works", itemName: "Antiweed Treatment", description: "Antiweed treatment", unit: "Sq. m.", qty: 2000, unitPrice: 1000, total: 2000000 },
    { id: 43, category: "Civil Works", itemName: "Geo-synthetic Fabric Layer", description: "Providing & laying non-woven Geo-synthetics fabric of minimum 200 GSM in separation layer between sub grade and stone spreading in switchyard as per Technical Specification and direction of Engineer-in-Charge.", unit: "Sq. m.", qty: 1500, unitPrice: 2600, total: 3900000 },
    { id: 44, category: "Civil Works", itemName: "PCC 1:5:10 + Cement Slurry", description: "Providing and laying Plain Cement Concrete 1:5:10 (1 cement : 5 sand : 10 brick aggregate) including a layer of cement slurry of mix 1:6 (1 cement : 6 fine sand) laid uniformly over cement concrete layer. Cement slurry ≥150 kg/100 sq.m.", unit: "Cu.Mtr.", qty: 75, unitPrice: 10000, total: 750000 },
    { id: 45, category: "Civil Works", itemName: "Panel Room Civil Works", description: "Switchyard Panel Room – Civil Works. All civil works as per drawing/specifications complete, incl. brickwork, finishing (internal & external), windows etc. Excavation, PCC, RCC and reinforcement paid separately as per BPS.", unit: "Sq. m.", qty: 30, unitPrice: 0, total: 0 },
    { id: 46, category: "Civil Works", itemName: "Cable Trench (Section 2-2)", description: "Cable Trench including all types of crossings, all metallic works and sump pit including concrete and reinforcement steel Section 2-2", unit: "RM", qty: 40, unitPrice: 0, total: 0 },
    { id: 47, category: "Civil Works", itemName: "Cable Trench (Section 3-3)", description: "Cable Trench including all types of crossings, all metallic works and sump pit including concrete and reinforcement steel Section 3-3", unit: "RM", qty: 25, unitPrice: 0, total: 0 },
    { id: 48, category: "Civil Works", itemName: "Cable Trench (Section 4-4)", description: "Cable Trench including all types of crossings, all metallic works and sump pit including concrete and reinforcement steel Section 4-4", unit: "RM", qty: 18, unitPrice: 0, total: 0 },
    { id: 49, category: "PMU & associated items at Bikaner-II PS", itemName: "PMU", description: "Service:- Phasor Measurement Unit (PMU)", unit: "EA", qty: 1, unitPrice: 400000, total: 400000 },
    { id: 50, category: "PMU & associated items at Bikaner-II PS", itemName: "GPS Receiver (WAMS)", description: "WAMS TIME SYSTEM (GPS RECEIVER)", unit: "EA", qty: 1, unitPrice: 10000, total: 10000 },
    { id: 51, category: "PMU & associated items at Bikaner-II PS", itemName: "LAN Switch (Layer 2)", description: "SUBSTATION GRADE Layer 2 LAN SWITCH", unit: "EA", qty: 1, unitPrice: 10000, total: 10000 },
    { id: 52, category: "PMU & associated items at Bikaner-II PS", itemName: "LAN Switch (Layer 3)", description: "SUBSTATION GRADE Layer 3 LAN SWITCH", unit: "EA", qty: 1, unitPrice: 10000, total: 10000 },
    { id: 53, category: "PMU & associated items at Bikaner-II PS", itemName: "Armored FO Cable", description: "Services:- Armored Fibre Optic Cable and associated termination equipment", unit: "LOT", qty: 1, unitPrice: 37000, total: 37000 },
    { id: 54, category: "PMU & associated items at Bikaner-II PS", itemName: "FO Patch Panel (12 Port)", description: "SUPPLY, INSTALLATION, TESTING AND COMMISSIONING OF LIU-FO PATCH PANEL-12 PORT", unit: "EA", qty: 1, unitPrice: 300000, total: 300000 },
    { id: 55, category: "PMU & associated items at Bikaner-II PS", itemName: "PMU-PDC Integration", description: "Integration of PMU with the PDC (Phasor Data Concentrator) of RLDCs and respective SLDCs as required", unit: "LOT", qty: 1, unitPrice: 200000, total: 200000 },
  ],
  subTotal: 15071000,
  total: 9042600,
};

// ── SUMMARY — real, correctly-consecutive numbering (1-11, no gap) ──────
const SUMMARY = {
  ...PROJECT_INFO,
  costLines: [
    { no: 1, description: 'DC System - BESS with EMS', value: 1224098366.1016948, gst: 220337705.89830506, valueInclGST: 1444436072 },
    { no: 2, description: 'PCS', value: 101250000, gst: 5062500, valueInclGST: 106312500 },
    { no: 3, description: 'Electrical BoM', value: 60782500, gst: 10940850, valueInclGST: 71723350 },
    { no: 4, description: 'Building and civil works', value: 41102000, gst: 7398360, valueInclGST: 48500360 },
    { no: 5, description: 'Installation & Commissioning upto PSS', value: 18012048.192771085, gst: 3242168.674698795, valueInclGST: 21254216.86746988 },
    { no: 6, description: 'PSS & TL upto bay works', value: 106104000, gst: 19098720, valueInclGST: 125202720 },
    { no: 7, description: '220kV Bay works', value: 9042600, gst: 1627668, valueInclGST: 10670268 },
  ],
  subTotalA: { value: 1560391514.294466, gst: 267707972.57300386, valueInclGST: 1828099486.8674698 },
  landCost: { no: 8, note: 'Rs 1 per year', value: 0, valueInclGST: 0 },
  softCosts: [
    { no: 9, description: 'Preliminary and Preoperative', note: '0.25% on cost', valueInclGST: 4570248.717168675 },
    { no: 10, description: 'Contingency', note: '0.25% on cost', valueInclGST: 4570248.717168675 },
    { no: 11, description: 'IDC', note: 'Interest During Construction', valueInclGST: 60928000 },
  ],
  subTotalB: { valueInclGST: 70068497.43433735 },
  totalProjectCost: 1898167984.3018072,
};

// ── VERIFICATION — real cross-check, not just eyeballed ────────────────
function verifyBudgetIntegrity() {
  const checks = [];
  const approxEqual = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;

  checks.push({ label: 'BESS cost total matches Summary line 1', pass: approxEqual(BESS_COST.totalBaseAmount, SUMMARY.costLines[0].value) });
  checks.push({ label: 'PCS total matches Summary line 2', pass: approxEqual(PCS_COST.baseAmount, SUMMARY.costLines[1].value) });
  checks.push({ label: 'Electrical BoM net total matches Summary line 3', pass: approxEqual(ELECTRICAL_BOM.netTotal, SUMMARY.costLines[2].value) });
  checks.push({ label: 'Building and civil total matches Summary line 4', pass: approxEqual(BUILDING_AND_CIVIL.totalCost, SUMMARY.costLines[3].value) });
  checks.push({ label: 'Installation upto PSS total matches Summary line 5', pass: approxEqual(INSTALLATION_UPTO_PSS.totalCost, SUMMARY.costLines[4].value) });
  checks.push({ label: 'PSS net total matches Summary line 6', pass: approxEqual(PSS.netTotal, SUMMARY.costLines[5].value) });
  checks.push({ label: '220kV Bay GSS total (60% share) matches Summary line 7', pass: approxEqual(BAY_GSS_220KV.total, SUMMARY.costLines[6].value) });
  checks.push({ label: 'Sub Total A = sum of all 7 category values', pass: approxEqual(SUMMARY.costLines.reduce((s, c) => s + c.value, 0), SUMMARY.subTotalA.value, 1) });
  checks.push({ label: 'PSS: pssSpecificTotal + raysCommonPoolingShare = netTotal', pass: approxEqual(PSS.pssSpecificTotal + PSS.raysCommonPoolingShare, PSS.netTotal) });
  checks.push({ label: 'PSS: commonPoolingSubTotal * 0.6 = raysCommonPoolingShare', pass: approxEqual(PSS.commonPoolingSubTotal * 0.6, PSS.raysCommonPoolingShare, 1) });
  checks.push({ label: '220kV Bay GSS: subTotal * 0.6 = total', pass: approxEqual(BAY_GSS_220KV.subTotal * 0.6, BAY_GSS_220KV.total, 1) });
  checks.push({ label: '220kV Bay GSS: 55 line items present', pass: BAY_GSS_220KV.items.length === 55 });
  checks.push({ label: '220kV Bay GSS: sum of line items = subTotal', pass: approxEqual(BAY_GSS_220KV.items.reduce((s, i) => s + i.total, 0), BAY_GSS_220KV.subTotal, 1) });
  checks.push({ label: 'Building and Civil: sum of line items = totalCost', pass: approxEqual(BUILDING_AND_CIVIL.items.reduce((s, i) => s + (i.total||0), 0), BUILDING_AND_CIVIL.totalCost, 1) });
  checks.push({ label: 'PSS pssSpecificItems: sum = pssSpecificTotal', pass: approxEqual(PSS.pssSpecificItems.reduce((s, i) => s + (i.total||0), 0), PSS.pssSpecificTotal, 1) });
  checks.push({ label: 'PSS commonPoolingItems: sum = commonPoolingSubTotal', pass: approxEqual(PSS.commonPoolingItems.reduce((s, i) => s + (i.total||0), 0), PSS.commonPoolingSubTotal, 1) });
  checks.push({ label: 'Electrical BoM: sum of ALL items across all 4 groups = netTotal', pass: approxEqual(ELECTRICAL_BOM.items.reduce((s, i) => s + (i.total||0), 0), ELECTRICAL_BOM.netTotal, 1) });
  checks.push({ label: 'Summary numbering is consecutive 1-11 with no gap', pass: (function(){
    const nos = [...SUMMARY.costLines.map(c=>c.no), SUMMARY.landCost.no, ...SUMMARY.softCosts.map(c=>c.no)];
    return JSON.stringify(nos) === JSON.stringify([1,2,3,4,5,6,7,8,9,10,11]);
  })() });

  checks.push({ label: 'CCTV lot: sum of allocated shares = lotTotal', pass: (function(){
    const item = ELECTRICAL_BOM.items.find(i => i.itemName === 'CCTV Camera and monitor');
    return item && approxEqual(item.lotItems.reduce((s,i) => s + i.allocatedShare, 0), item.lotTotal, 1);
  })() });
  checks.push({ label: 'Insurances lot: sum of allocated shares = lotTotal', pass: (function(){
    const item = ELECTRICAL_BOM.items.find(i => i.itemName === 'Insurances');
    return item && approxEqual(item.lotItems.reduce((s,i) => s + i.allocatedShare, 0), item.lotTotal, 1);
  })() });

  const failed = checks.filter(c => !c.pass);
  return { allPassed: failed.length === 0, checks, failed };
}

module.exports = {
  PROJECT_INFO,
  BESS_COST,
  PCS_COST,
  ELECTRICAL_BOM,
  BUILDING_AND_CIVIL,
  INSTALLATION_UPTO_PSS,
  PSS,
  BAY_GSS_220KV,
  SUMMARY,
  verifyBudgetIntegrity,
};

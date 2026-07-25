// lib/billSubtype.js
//
// Shared, single source of truth for Bill subtype detection — used by
// BOTH checklistEngine.js and aiComplianceEngine.js, so they can never
// silently drift apart on this again (which is exactly what happened
// before this file existed: bill_type was being read from the wrong
// location in two separate places).

// Real bug (found and fixed): Bill Type is NOT a standard Zoho field —
// it lives INSIDE the "Custom Fields" box, confirmed on a real sample
// bill. bill.bill_type is checked only as a fallback, since it's
// usually blank.
function getRealBillType(bill) {
  return (bill.custom_fields || []).find(f => /bill type/i.test(f.label || f.placeholder || ''))?.value || bill.bill_type || '';
}

// Returns one of 'Service' | 'Supply' | 'Supply-FA' | 'O&M' | 'Expense',
// or null if the real field is genuinely blank/unrecognized (meaning
// the AI classification fallback is needed).
function classifyBillSubtype(realBillType) {
  const norm = (realBillType || '').toLowerCase().replace(/\s+/g, '');
  if (norm.includes('supply-fa') || norm.includes('supplyfa')) return 'Supply-FA';
  if (norm.includes('supply')) return 'Supply';
  if (norm.includes('o&m') || norm.includes('om')) return 'O&M';
  if (norm.includes('expense')) return 'Expense';
  if (norm.includes('service')) return 'Service';
  return null;
}

module.exports = { getRealBillType, classifyBillSubtype };

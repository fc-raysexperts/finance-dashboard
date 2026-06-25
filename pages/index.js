// pages/index.js
// Finance Control Dashboard -- incorporates all 10 requested changes:
// 1. PWR/DAS edits now persist via /api/store/variable-overrides (cross-device)
// 2. Add Project / Add Park buttons on Projects & Parks tabs
// 3. Project Details modal shows live PO/Bill/Invoice/SO/CN totals + Refresh button
// 4. Summary card relabeling (Total Pending, PMO amount sum)
// 5. Login gate handled by middleware.js + pages/login.js (this file unaffected)
// 6. Project column renamed, populated from line_items[].project_name
// 7. Robust PO/Bill reference detection (handled server-side in bills.js)
// 8. Tag-based 3-tier PFB alignment matching (handled server-side in pfbEngine.js)
// 9. Editable Zoho Books Project Names via nested modal

import { useState, useEffect, useCallback, useRef } from 'react';
import Head from 'next/head';
import * as XLSX from 'xlsx';

// ----- UTILITIES -----
const fmt   = n => n == null ? String.fromCharCode(8212) : '\u20b9' + Number(n).toLocaleString('en-IN', {maximumFractionDigits:0});
const fmtN  = n => n == null ? String.fromCharCode(8212) : Number(n).toLocaleString('en-IN', {maximumFractionDigits:2});
const fmtP  = n => n == null ? String.fromCharCode(8212) : (n>0?'+':'') + Number(n).toFixed(1) + '%';

function compressName(name, maxWords) {
  if (!name) return String.fromCharCode(8212);
  const words = name.toString().trim().split(/\s+/);
  const limit = maxWords || 5;
  return words.length > limit ? words.slice(0, limit).join(' ') + '...' : name;
}

function extractCode(name) {
  if (!name) return '';
  const m = (name.toString()).match(/LE\d{4}/i);
  return m ? m[0] : (name.split('_')[0] || name);
}
const fmtCr = n => n == null ? String.fromCharCode(8212) : '\u20b9' + Number(n).toFixed(2) + ' Cr';

function toIndianDate(d) {
  if (!d) return String.fromCharCode(8212);
  try {
    if (/^\d{2}-\d{2}-\d{4}$/.test(d)) return d;
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return String(dt.getDate()).padStart(2,'0') + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + dt.getFullYear();
  } catch (e) { return d; }
}

// ----- RATE/Wp COLOR CLASSIFICATION (PFBs tab legend) -----
// green < 25, yellow 25-30, orange 30-35, red >= 35 (Rs./Wp)
function rateColor(ratePerWp) {
  if (ratePerWp == null) return { bg:'#cbd5e1', c:'#334155', label:String.fromCharCode(8212) };
  if (ratePerWp < 25) return { bg:'#4ade80', c:'#052e16', label:'Good' };
  if (ratePerWp < 30) return { bg:'#fbbf24', c:'#451a03', label:'Watch' };
  if (ratePerWp < 35) return { bg:'#fb923c', c:'#431407', label:'High' };
  return { bg:'#f87171', c:'#450a0a', label:'Over' };
}

// ----- BADGES -----
function CompBadge({ s }) {
  const m = { pass:{bg:'#dcfce7',c:'#15803d',t:'PASS'}, warn:{bg:'#fef9c3',c:'#a16207',t:'WARNINGS'}, fail:{bg:'#fee2e2',c:'#b91c1c',t:'FAILED'} };
  const v = m[s]||{bg:'#f1f5f9',c:'#64748b',t:String.fromCharCode(8212)};
  return <span style={{background:v.bg,color:v.c,padding:'2px 8px',borderRadius:4,fontSize:11,fontWeight:700,border:'1px solid ' + v.c + '33',whiteSpace:'nowrap'}}>{v.t}</span>;
}
function AlignBadge({ s }) {
  const m = { aligned:{bg:'#dbeafe',c:'#1d4ed8',t:'ALIGNED'}, flag:{bg:'#fef3c7',c:'#d97706',t:'VARIANCE'}, reject:{bg:'#fee2e2',c:'#b91c1c',t:'OVER BUDGET'}, na:{bg:'#f8fafc',c:'#94a3b8',t:'N/A'}, mismatch:{bg:'#fee2e2',c:'#b91c1c',t:'MISMATCH'}, aligned_tag:{bg:'#dbeafe',c:'#1d4ed8',t:'ALIGNED'} };
  const v = m[s]||m.na;
  return <span style={{background:v.bg,color:v.c,padding:'2px 8px',borderRadius:4,fontSize:11,fontWeight:700,border:'1px solid ' + v.c + '33',whiteSpace:'nowrap'}}>{v.t}</span>;
}
function RecBadge({ d }) {
  const m = { 'APPROVE':{bg:'#dcfce7',c:'#15803d'}, 'APPROVE (No PFB Scope)':{bg:'#dbeafe',c:'#1d4ed8'}, 'FLAG FOR REVIEW':{bg:'#fef9c3',c:'#a16207'}, 'REJECT':{bg:'#fee2e2',c:'#b91c1c'} };
  const v = m[d]||{bg:'#f1f5f9',c:'#64748b'};
  return <span style={{background:v.bg,color:v.c,padding:'3px 10px',borderRadius:4,fontSize:11,fontWeight:700,border:'1px solid ' + v.c + '33'}}>{d||String.fromCharCode(8212)}</span>;
}

// ----- PROJECT CODES DISPLAY (item 6 fix) -----
function ProjectCodes({ names }) {
  if (!names || !names.length) return <span style={{color:'#94a3b8'}}>{String.fromCharCode(8212)}</span>;
  const codes = names.map(n => {
    const m = n.match(/LE\d{4}/i);
    return m ? m[0] : (n.split('_')[0] || n).substring(0,14);
  });
  const unique = [...new Set(codes)];
  return (
    <span style={{fontSize:11,color:'#2563eb',display:'flex',flexDirection:'column',gap:1}}>
      {unique.slice(0,2).map((c,i) => <span key={i}>{c}</span>)}
      {unique.length>2 && <span style={{color:'#94a3b8'}}>+{unique.length-2} more</span>}
    </span>
  );
}

// ----- SPINNER -----
function Spinner({ label }) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:10,color:'#64748b',padding:'48px 0',justifyContent:'center'}}>
      <svg width="18" height="18" viewBox="0 0 24 24" style={{animation:'spin 1s linear infinite'}}>
        <circle cx="12" cy="12" r="10" stroke="#e2e8f0" strokeWidth="3" fill="none"/>
        <path d="M12 2a10 10 0 0 1 10 10" stroke="#2563eb" strokeWidth="3" strokeLinecap="round" fill="none"/>
      </svg>
      {label||'Loading...'}
    </div>
  );
}

// ----- ERROR BANNER -----
// Surfaces the real error from a failed fetch instead of silently showing
// an empty list (this is what made the PMO "0 pending" symptom impossible
// to diagnose before — there was no way to tell a real error from a
// genuinely-empty queue).
function ErrorBanner({ message, onRetry }) {
  if (!message) return null;
  return (
    <div style={{background:'#fff1f2',border:'1px solid #fecaca',borderRadius:10,padding:'14px 18px',marginBottom:14,display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
      <div>
        <div style={{fontWeight:700,color:'#b91c1c',fontSize:13,marginBottom:2}}>Couldn't load this data</div>
        <div style={{fontSize:12,color:'#7f1d1d'}}>{message}</div>
      </div>
      {onRetry && <button onClick={onRetry} style={{background:'#fff',color:'#b91c1c',border:'1px solid #fca5a5',borderRadius:7,padding:'6px 14px',cursor:'pointer',fontSize:12,fontWeight:700,whiteSpace:'nowrap'}}>Retry</button>}
    </div>
  );
}

// ----- MODAL WRAPPER -----
function Modal({ onClose, title, subtitle, width, children, zIndex, headerExtra }) {
  useEffect(function(){
    const h = function(e){ if(e.key==='Escape') onClose(); };
    window.addEventListener('keydown',h);
    return function(){ window.removeEventListener('keydown',h); };
  },[onClose]);
  return (
    <div onClick={function(e){ if(e.target===e.currentTarget) onClose(); }}
      style={{position:'fixed',inset:0,background:'rgba(15,23,42,0.6)',zIndex:zIndex||1000,display:'flex',alignItems:'flex-start',justifyContent:'center',padding:'24px 16px',overflowY:'auto',backdropFilter:'blur(2px)'}}>
      <div style={{background:'#fff',borderRadius:16,width:'100%',maxWidth:width||920,padding:28,position:'relative',boxShadow:'0 24px 64px rgba(0,0,0,0.18)',border:'1px solid #e2e8f0'}}>
        {headerExtra && <div style={{position:'absolute',top:14,right:56}}>{headerExtra}</div>}
        <button onClick={onClose} style={{position:'absolute',top:14,right:14,background:'#f1f5f9',border:'none',borderRadius:8,width:32,height:32,cursor:'pointer',fontSize:18,color:'#64748b'}}>&times;</button>
        <div style={{marginBottom:18,paddingRight:headerExtra?110:40}}>
          <div style={{fontSize:20,fontWeight:800,color:'#0f172a',letterSpacing:'-0.02em'}}>{title}</div>
          {subtitle&&<div style={{fontSize:13,color:'#64748b',marginTop:3}}>{subtitle}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

// ----- INFO GRID -----
function InfoGrid({ fields, cols }) {
  return (
    <div style={{display:'grid',gridTemplateColumns:'repeat(' + (cols||3) + ',minmax(0,1fr))',gap:'10px 20px',background:'#f8fafc',borderRadius:10,padding:'14px 18px',marginBottom:16}}>
      {fields.map(function(pair){
        const k = pair[0], v = pair[1];
        return (
          <div key={k}>
            <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em',marginBottom:2}}>{k.toUpperCase()}</div>
            <div style={{fontSize:13,color:'#0f172a',fontWeight:500,wordBreak:'break-word'}}>{v==null?String.fromCharCode(8212):v}</div>
          </div>
        );
      })}
    </div>
  );
}

// ----- RECOMMENDATION BOX -----
function RecBox({ rec }) {
  if (!rec) return null;
  const cc = {green:'#15803d',amber:'#d97706',red:'#b91c1c',blue:'#1d4ed8'};
  const bg = {green:'#f0fdf4',amber:'#fefce8',red:'#fff1f2',blue:'#eff6ff'};
  const c = cc[rec.color]||'#475569', b = bg[rec.color]||'#f8fafc';
  const icon = (rec.decision==='APPROVE'||(rec.decision&&rec.decision.indexOf('No PFB')>=0)) ? '\u2705' : rec.decision==='REJECT' ? '\u{1F6AB}' : '\u26A0\uFE0F';
  return (
    <div style={{background:b,border:'1.5px solid ' + c + '33',borderRadius:10,padding:'12px 16px',marginBottom:16}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
        <span style={{fontSize:18}}>{icon}</span>
        <span style={{fontWeight:800,color:c,fontSize:14}}>RECOMMENDATION: {rec.decision}</span>
      </div>
      {rec.reasons&&rec.reasons.map(function(r,i){
        return (
          <div key={i} style={{display:'flex',gap:6,color:'#475569',fontSize:12,marginBottom:2}}>
            <span style={{color:c}}>{'\u203A'}</span>{r}
          </div>
        );
      })}
    </div>
  );
}

// ----- COMPLIANCE TABLE -----
function CompTable({ checks, title }) {
  if (!checks || !checks.length) return null;
  const pass = checks.filter(function(c){return c.passed;}).length;
  return (
    <div style={{marginBottom:20}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',margin:0}}>{title}</h3>
        <span style={{fontSize:11,color:'#64748b'}}>{pass}/{checks.length} passed</span>
      </div>
      <div style={{border:'1px solid #e2e8f0',borderRadius:8,overflow:'hidden'}}>
        {checks.map(function(c,i){
          return (
            <div key={i} style={{display:'flex',alignItems:'flex-start',gap:8,padding:'8px 12px',background:i%2?'#f8fafc':'#fff',borderBottom:i<checks.length-1?'1px solid #f1f5f9':'none'}}>
              <span style={{fontSize:13,marginTop:1,flexShrink:0}}>{c.passed?'\u2705':'\u274C'}</span>
              <div style={{flex:1}}>
                <span style={{fontWeight:600,color:'#334155',fontSize:12}}>{c.name}: </span>
                <span style={{color:c.passed?'#64748b':'#dc2626',fontSize:12}}>{c.comment}</span>
              </div>
              {c.value&&<span style={{fontSize:11,color:'#94a3b8',flexShrink:0,maxWidth:160,textAlign:'right'}}>{c.value}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ----- LINE CHECKS TABLE (shows match tier from item 8) -----
function LineTable({ checks, title }) {
  if (!checks || !checks.length) return null;
  const tierLabel = function(t){ return t===1?'Name match':t===2?'Tag match':t===3?'Tag+disambig':String.fromCharCode(8212); };
  return (
    <div style={{marginBottom:20}}>
      <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>{title}</h3>
      <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
          <thead><tr style={{background:'#f8fafc'}}>
            {['Item','Qty','Rate','Amount','PFB Match','Match Type','PFB Rate','Variance','Status'].map(function(h){
              return <th key={h} style={{padding:'7px 10px',textAlign:'left',color:'#475569',fontWeight:700,fontSize:11,borderBottom:'1px solid #e2e8f0',whiteSpace:'nowrap'}}>{h}</th>;
            })}
          </tr></thead>
          <tbody>
            {checks.map(function(c,i){
              return (
                <tr key={i} style={{borderBottom:'1px solid #f1f5f9',background:c.status==='reject'?'#fff1f2':c.status==='flag'?'#fefce8':c.status==='na'?'#f8fafc':'#fff'}}>
                  <td style={{padding:'7px 10px',color:'#0f172a',fontWeight:500,maxWidth:180}}>{c.lineItem}</td>
                  <td style={{padding:'7px 10px',color:'#475569'}}>{fmtN(c.qty)}</td>
                  <td style={{padding:'7px 10px',color:'#475569'}}>{fmt(c.rate)}</td>
                  <td style={{padding:'7px 10px',color:'#0f172a',fontWeight:600}}>{fmt(c.amount)}</td>
                  <td style={{padding:'7px 10px',color:'#2563eb',fontSize:11}}>{c.pfbMatch||String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 10px',color:'#7c3aed',fontSize:11}}>{c.matchTier?tierLabel(c.matchTier):String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 10px',color:'#475569'}}>{fmt(c.pfbRate)}</td>
                  <td style={{padding:'7px 10px',fontWeight:700,color:c.rateVariance>10?'#dc2626':c.rateVariance<-10?'#ea580c':'#16a34a'}}>{c.rateVariance!=null?fmtP(c.rateVariance):String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 10px',fontSize:11,fontWeight:600,color:c.status==='reject'?'#dc2626':c.status==='flag'?'#d97706':c.status==='na'?'#94a3b8':'#16a34a'}}>
                    {c.status==='na'?'N/A':c.status==='reject'?'Over Budget':c.status==='flag'?'Variance':'OK'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----- SUMMARY CARD -----
function Card({ label, value, sub, color, icon }) {
  return (
    <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:'14px 18px',borderTop:'3px solid ' + (color||'#e2e8f0')}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
        <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em'}}>{label}</div>
        {icon&&<span style={{fontSize:16}}>{icon}</span>}
      </div>
      <div style={{fontSize:26,fontWeight:900,color:'#0f172a',margin:'5px 0 2px',letterSpacing:'-0.02em'}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:'#64748b'}}>{sub}</div>}
    </div>
  );
}

// ----- SHARED INPUT FIELD -----
function Field({ label, value, onChange, placeholder, type }) {
  return (
    <div>
      <label style={{fontSize:11,color:'#64748b',fontWeight:700,letterSpacing:'0.04em',display:'block',marginBottom:4}}>{label.toUpperCase()}</label>
      <input type={type||'text'} value={value} onChange={function(e){onChange(e.target.value);}} placeholder={placeholder}
        style={{width:'100%',border:'1.5px solid #e2e8f0',borderRadius:8,padding:'9px 12px',fontSize:14,outline:'none',boxSizing:'border-box'}}
        onFocus={function(e){e.target.style.borderColor='#2563eb';}} onBlur={function(e){e.target.style.borderColor='#e2e8f0';}}/>
    </div>
  );
}
function Select({ label, value, onChange, options, placeholder }) {
  return (
    <div>
      <label style={{fontSize:11,color:'#64748b',fontWeight:700,letterSpacing:'0.04em',display:'block',marginBottom:4}}>{label.toUpperCase()}</label>
      <select value={value} onChange={function(e){onChange(e.target.value);}}
        style={{width:'100%',border:'1.5px solid #e2e8f0',borderRadius:8,padding:'9px 12px',fontSize:14,outline:'none',boxSizing:'border-box',background:'#fff'}}>
        <option value="">{placeholder||'Select...'}</option>
        {options.map(function(o){ return <option key={o} value={o}>{o}</option>; })}
      </select>
    </div>
  );
}

// ----- ADD NEW PARK MODAL (item 2) -----
function AddParkModal({ onClose, onSaved }) {
  const [name, setName]       = useState('');
  const [district, setDistrict] = useState('');
  const [state, setState]     = useState('Rajasthan');
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');

  const save = async () => {
    if (!name) { setErr('Park name is required'); return; }
    setSaving(true); setErr('');
    try {
      const r = await fetch('/api/store/parks', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, district, state }) });
      const d = await r.json();
      if (d.success) { onSaved(); onClose(); } else { setErr(d.error || 'Failed to save'); }
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  return (
    <Modal onClose={onClose} title="Add New Solar Park" width={420}>
      <div style={{display:'grid',gap:14,marginBottom:20}}>
        <Field label="Park Name" value={name} onChange={setName} placeholder="e.g. Khinwara Park"/>
        <Field label="District" value={district} onChange={setDistrict} placeholder="e.g. Phalodi"/>
        <Field label="State" value={state} onChange={setState} placeholder="e.g. Rajasthan"/>
      </div>
      {err && <div style={{background:'#fff1f2',color:'#dc2626',border:'1px solid #fecaca',borderRadius:8,padding:'8px 12px',fontSize:12,marginBottom:14}}>{err}</div>}
      <div style={{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:8,padding:'10px 14px',fontSize:12,color:'#1d4ed8',marginBottom:16}}>
        Projects in this park, their count, and combined DC/BESS/Value totals will populate automatically once projects are assigned to it.
      </div>
      <button onClick={save} disabled={saving}
        style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:14,opacity:saving?0.7:1}}>
        {saving?'Saving...':'Save Park'}
      </button>
    </Modal>
  );
}

// ----- EDIT PARK MODAL -- fixes wrong park info (Claude_Prompt_3 item 2) -----
function EditParkModal({ park, onClose, onSaved }) {
  const [name, setName]         = useState(park.name || '');
  const [district, setDistrict] = useState(park.district || '');
  const [state, setState]       = useState(park.state || 'Rajasthan');
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');

  const save = async () => {
    if (!name) { setErr('Park name is required'); return; }
    setSaving(true); setErr('');
    try {
      const r = await fetch('/api/store/parks', {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ originalName: park.name, name, district, state })
      });
      const d = await r.json();
      if (d.success) { onSaved(); onClose(); } else { setErr(d.error || 'Failed to save'); }
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  return (
    <Modal onClose={onClose} title={'\u{1F58A}\uFE0F Edit Park - ' + park.name} width={420} zIndex={1100}>
      <div style={{display:'grid',gap:14,marginBottom:20}}>
        <Field label="Park Name" value={name} onChange={setName} placeholder="e.g. Khinwara Park"/>
        <Field label="District" value={district} onChange={setDistrict} placeholder="e.g. Phalodi"/>
        <Field label="State" value={state} onChange={setState} placeholder="e.g. Rajasthan"/>
      </div>
      {name !== park.name && (
        <div style={{background:'#fef9c3',border:'1px solid #fde68a',borderRadius:8,padding:'10px 14px',fontSize:12,color:'#92400e',marginBottom:16}}>
          Renaming this park will automatically move all {park.count} project{park.count!==1?'s':''} currently in it over to the new name.
        </div>
      )}
      {err && <div style={{background:'#fff1f2',color:'#dc2626',border:'1px solid #fecaca',borderRadius:8,padding:'8px 12px',fontSize:12,marginBottom:14}}>{err}</div>}
      <button onClick={save} disabled={saving}
        style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:14,opacity:saving?0.7:1}}>
        {saving?'Saving...':'Save Changes'}
      </button>
    </Modal>
  );
}


function AddProjectModal({ onClose, onSaved, parkNames }) {
  const [name, setName]       = useState('');
  const [park, setPark]       = useState('');
  const [dc, setDC]           = useState('');
  const [ac, setAC]           = useState('');
  const [sw, setSW]           = useState('');
  const [bess, setBess]       = useState('');
  const [totalValue, setTV]   = useState('');
  const [epcCost, setEPC]     = useState('');
  const [agreementDate, setAgreementDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');
  const [result, setResult]   = useState(null);

  const toDDMMYYYY = (isoDate) => {
    if (!isoDate) return null;
    const parts = isoDate.split('-');
    return parts[2] + '-' + parts[1] + '-' + parts[0];
  };

  const save = async () => {
    if (!name || !park || !dc || !ac || !sw) { setErr('Name, Park, DC, AC, and Switchyards are required'); return; }
    setSaving(true); setErr('');
    try {
      const r = await fetch('/api/store/projects', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          name, park, dc, ac, sw, bess: bess||0,
          totalValue: totalValue||null, epcCost: epcCost||null,
          agreementDate: toDDMMYYYY(agreementDate), endDate: toDDMMYYYY(endDate),
        })
      });
      const d = await r.json();
      if (d.success) { setResult(d.data); onSaved(); } else { setErr(d.error || 'Failed to save'); }
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  return (
    <Modal onClose={onClose} title="Add New Project" width={520}>
      {!result ? (
        <>
          <div style={{fontSize:11,fontWeight:700,color:'#1d4ed8',letterSpacing:'0.06em',marginBottom:10}}>TECHNICAL DETAILS</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
            <div style={{gridColumn:'span 2'}}><Field label="Project Name" value={name} onChange={setName} placeholder="e.g. Sunrise Steel"/></div>
            <Select label="Solar Park" value={park} onChange={setPark} options={parkNames} placeholder="Choose park"/>
            <Field label="BESS Capacity (MWh)" value={bess} onChange={setBess} placeholder="e.g. 2.5 (optional)"/>
            <Field label="DC Capacity (MWp)" value={dc} onChange={setDC} placeholder="e.g. 8.5"/>
            <Field label="AC Capacity (MW)" value={ac} onChange={setAC} placeholder="e.g. 5.7"/>
            <Field label="No. of Switchyards" value={sw} onChange={setSW} placeholder="e.g. 1"/>
          </div>
          <div style={{fontSize:11,fontWeight:700,color:'#15803d',letterSpacing:'0.06em',marginBottom:10}}>FINANCIAL DETAILS</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
            <Field label="Total Project Value (Cr)" value={totalValue} onChange={setTV} placeholder="e.g. 25.5"/>
            <Field label="EPC Cost / MWp (Cr)" value={epcCost} onChange={setEPC} placeholder="e.g. 1.45"/>
            <Field label="Agreement Date" value={agreementDate} onChange={setAgreementDate} type="date"/>
            <Field label="End Date" value={endDate} onChange={setEndDate} type="date"/>
          </div>
          <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px 14px',fontSize:12,color:'#64748b',marginBottom:16}}>
            District, State, and Revenue Quarter will be filled automatically from the chosen Park and End Date.
          </div>
          {err && <div style={{background:'#fff1f2',color:'#dc2626',border:'1px solid #fecaca',borderRadius:8,padding:'8px 12px',fontSize:12,marginBottom:14}}>{err}</div>}
          <button onClick={save} disabled={saving}
            style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:14,opacity:saving?0.7:1}}>
            {saving?'Saving and Generating PFB...':'Save Project & Generate PFB'}
          </button>
        </>
      ) : (
        <div>
          <div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:10,padding:'16px 18px',marginBottom:14}}>
            <div style={{fontWeight:800,color:'#15803d',fontSize:15,marginBottom:6}}>Project Added: {result.name}</div>
            <div style={{fontSize:12,color:'#475569'}}>District: {result.district} - State: {result.state} - Quarter: {result.quarter||String.fromCharCode(8212)}</div>
          </div>
          <div style={{fontSize:12,color:'#64748b',marginBottom:16}}>
            This project now appears on the Projects tab and PFBs tab with its PFB sheet calculated automatically.
          </div>
          <button onClick={onClose} style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:14}}>Done</button>
        </div>
      )}
    </Modal>
  );
}

// ----- EDIT ZOHO NAMES MODAL -- NESTED (item 9) -----
function EditZohoNamesModal({ proj, onClose, onSaved }) {
  const [names, setNames]   = useState(proj.zohoNames || []);
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState('');
  const [addingType, setAddingType] = useState('');
  const [addVal, setAddVal] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = (i) => { setEditing(i); setEditVal(names[i]); };
  const confirmEdit = async () => {
    setSaving(true);
    try {
      await fetch('/api/store/zoho-names', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ projectId: proj.id, action:'replace', oldValue: names[editing], value: editVal }) });
      const updated = [...names]; updated[editing] = editVal;
      setNames(updated); setEditing(null); onSaved();
    } catch (e) {}
    setSaving(false);
  };

  const confirmAdd = async () => {
    if (!addVal || !addingType) return;
    setSaving(true);
    try {
      await fetch('/api/store/zoho-names', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ projectId: proj.id, action:'add', value: addVal }) });
      setNames([...names, addVal]); setAddVal(''); setAddingType(''); onSaved();
    } catch (e) {}
    setSaving(false);
  };

  return (
    <Modal onClose={onClose} title="Modify Zoho Books Project Names" subtitle={proj.name} width={460} zIndex={1100}>
      <div style={{fontSize:12,color:'#64748b',marginBottom:14}}>
        These are the Project Codes / Names used to identify this project in Zoho Books. Useful when a single order has been split into multiple Zoho project codes (e.g. a large order divided into 3 separate codes by the firm).
      </div>
      <div style={{border:'1px solid #e2e8f0',borderRadius:8,overflow:'hidden',marginBottom:16}}>
        {names.map(function(n,i){
          return (
            <div key={i} style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',borderBottom:i<names.length-1?'1px solid #f1f5f9':'none',background:i%2?'#f8fafc':'#fff'}}>
              {editing===i ? (
                <>
                  <input value={editVal} onChange={function(e){setEditVal(e.target.value);}} autoFocus
                    style={{flex:1,border:'1.5px solid #2563eb',borderRadius:6,padding:'5px 8px',fontSize:13,outline:'none'}}/>
                  <button onClick={confirmEdit} disabled={saving} style={{background:'#dcfce7',color:'#15803d',border:'1px solid #86efac',borderRadius:6,padding:'4px 10px',cursor:'pointer',fontSize:11,fontWeight:600}}>Save</button>
                  <button onClick={function(){setEditing(null);}} style={{background:'#f1f5f9',color:'#64748b',border:'none',borderRadius:6,padding:'4px 10px',cursor:'pointer',fontSize:11}}>Cancel</button>
                </>
              ) : (
                <>
                  <span style={{flex:1,fontSize:13,color:'#0f172a'}}>{n}</span>
                  <button onClick={function(){startEdit(i);}} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:6,padding:'4px 10px',cursor:'pointer',fontSize:11,fontWeight:600}}>{'\u{1F58A}\uFE0F Edit'}</button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {!addingType ? (
        <div style={{display:'flex',gap:8}}>
          <button onClick={function(){setAddingType('Project Code');}} style={{flex:1,background:'#f8fafc',color:'#334155',border:'1px solid #e2e8f0',borderRadius:8,padding:'9px',cursor:'pointer',fontSize:13,fontWeight:600}}>+ Add Project Code</button>
          <button onClick={function(){setAddingType('Project Name');}} style={{flex:1,background:'#f8fafc',color:'#334155',border:'1px solid #e2e8f0',borderRadius:8,padding:'9px',cursor:'pointer',fontSize:13,fontWeight:600}}>+ Add Project Name</button>
        </div>
      ) : (
        <div style={{background:'#f0f9ff',border:'1px solid #bae6fd',borderRadius:8,padding:'12px'}}>
          <div style={{fontSize:11,color:'#0369a1',fontWeight:700,marginBottom:8}}>NEW {addingType.toUpperCase()}</div>
          <input value={addVal} onChange={function(e){setAddVal(e.target.value);}} autoFocus placeholder={addingType==='Project Code'?'e.g. LE0230':'e.g. ACME INDUSTRIES'}
            style={{width:'100%',border:'1.5px solid #e2e8f0',borderRadius:6,padding:'8px 10px',fontSize:13,outline:'none',marginBottom:10,boxSizing:'border-box'}}/>
          <div style={{display:'flex',gap:8}}>
            <button onClick={confirmAdd} disabled={saving||!addVal} style={{flex:1,background:'#1d4ed8',color:'#fff',border:'none',borderRadius:6,padding:'8px',cursor:'pointer',fontSize:12,fontWeight:600,opacity:!addVal?0.5:1}}>Save</button>
            <button onClick={function(){setAddingType('');setAddVal('');}} style={{flex:1,background:'#f1f5f9',color:'#64748b',border:'none',borderRadius:6,padding:'8px',cursor:'pointer',fontSize:12}}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ----- EDIT PROJECT MODAL -- general fields (item 11 fix: the EDIT button) -----
function EditProjectModal({ proj, parkNames, onClose, onSaved }) {
  const toISODate = (ddmmyyyy) => {
    if (!ddmmyyyy) return '';
    const parts = ddmmyyyy.split('-');
    return parts.length === 3 ? (parts[2] + '-' + parts[1] + '-' + parts[0]) : '';
  };
  const toDDMMYYYY = (isoDate) => {
    if (!isoDate) return null;
    const parts = isoDate.split('-');
    return parts[2] + '-' + parts[1] + '-' + parts[0];
  };

  const [name, setName]             = useState(proj.name || '');
  const [park, setPark]             = useState(proj.park || '');
  const [bess, setBess]             = useState(proj.bess || '');
  const [totalValue, setTV]         = useState(proj.totalValue ?? '');
  const [epcCost, setEPC]           = useState(proj.epcCost ?? '');
  const [agreementDate, setAgDate]  = useState(toISODate(proj.agreementDate));
  const [endDate, setEndDate]       = useState(toISODate(proj.endDate));
  const [saving, setSaving]         = useState(false);
  const [err, setErr]               = useState('');

  const save = async () => {
    if (!name || !park) { setErr('Name and Park are required'); return; }
    setSaving(true); setErr('');
    try {
      const r = await fetch('/api/store/project-edit', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          projectId: proj.id, name, park,
          bess: bess===''?0:bess, totalValue: totalValue===''?null:totalValue, epcCost: epcCost===''?null:epcCost,
          agreementDate: toDDMMYYYY(agreementDate), endDate: toDDMMYYYY(endDate),
        })
      });
      const d = await r.json();
      if (d.success) { onSaved(); onClose(); } else { setErr(d.error || 'Failed to save'); }
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  return (
    <Modal onClose={onClose} title={'Edit Project - ' + proj.name} width={560} zIndex={1100}>
      <div style={{fontSize:11,fontWeight:700,color:'#1d4ed8',letterSpacing:'0.06em',marginBottom:10}}>GENERAL DETAILS</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
        <div style={{gridColumn:'span 2'}}><Field label="Project Name" value={name} onChange={setName}/></div>
        <Select label="Solar Park" value={park} onChange={setPark} options={parkNames} placeholder="Choose park"/>
        <Field label="BESS Capacity (MWh)" value={bess} onChange={setBess} placeholder="0"/>
      </div>
      <div style={{fontSize:11,fontWeight:700,color:'#15803d',letterSpacing:'0.06em',marginBottom:10}}>FINANCIAL DETAILS</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
        <Field label="Total Project Value (Cr)" value={totalValue} onChange={setTV} placeholder="e.g. 25.5"/>
        <Field label="EPC Cost / MWp (Cr)" value={epcCost} onChange={setEPC} placeholder="e.g. 1.45"/>
        <Field label="Agreement Date" value={agreementDate} onChange={setAgDate} type="date"/>
        <Field label="End Date" value={endDate} onChange={setEndDate} type="date"/>
      </div>
      <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px 14px',fontSize:12,color:'#64748b',marginBottom:16}}>
        DC/AC/Switchyards and Piling/Wall/Road are edited from the PFB "EDIT Values" screen, not here.
      </div>
      {err && <div style={{background:'#fff1f2',color:'#dc2626',border:'1px solid #fecaca',borderRadius:8,padding:'8px 12px',fontSize:12,marginBottom:14}}>{err}</div>}
      <button onClick={save} disabled={saving}
        style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:14,opacity:saving?0.7:1}}>
        {saving?'Saving...':'Save Changes'}
      </button>
    </Modal>
  );
}


function PFBVarConfirm({ proj, onYes, onNo, onClose }) {
  const ready = proj.dc && proj.ac && proj.sw;
  return (
    <Modal onClose={onClose} title={'Confirm Variables - ' + proj.name} width={460}>
      <p style={{color:'#475569',fontSize:13,marginBottom:18}}>Are these values correct for generating the PFB?</p>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:14}}>
        {[['DC (MWp)',proj.dc],['AC (MW)',proj.ac],['Switchyards',proj.sw]].map(function(pair){
          const k = pair[0], v = pair[1];
          return (
            <div key={k} style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'12px',textAlign:'center'}}>
              <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,marginBottom:4}}>{k}</div>
              <div style={{fontSize:22,fontWeight:800,color:v?'#0f172a':'#dc2626'}}>{v==null?'?':v}</div>
            </div>
          );
        })}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:20}}>
        {[['Piling',proj.piling],['Boundary Wall (m)',proj.wall],['Road (m)',proj.road]].map(function(pair){
          const k = pair[0], v = pair[1];
          return (
            <div key={k} style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px',textAlign:'center'}}>
              <div style={{fontSize:9,color:'#94a3b8',fontWeight:700,marginBottom:3}}>{k}</div>
              <div style={{fontSize:16,fontWeight:700,color:'#334155'}}>{v==null?2000:v}</div>
            </div>
          );
        })}
      </div>
      {!ready && <div style={{background:'#fef9c3',border:'1px solid #fde68a',borderRadius:8,padding:'10px',fontSize:12,color:'#92400e',marginBottom:14}}>DC/AC/SW variables missing - please enter values.</div>}
      <div style={{display:'flex',gap:10}}>
        {ready && <button onClick={onYes} style={{flex:1,background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'10px',cursor:'pointer',fontWeight:700,fontSize:14}}>YES - Generate PFB</button>}
        <button onClick={onNo} style={{flex:1,background:'#f1f5f9',color:'#334155',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px',cursor:'pointer',fontWeight:600,fontSize:14}}>{ready?'\u{1F58A}\uFE0F EDIT Values':'ENTER Values'}</button>
      </div>
    </Modal>
  );
}

// ----- PFB VARIABLE EDIT -- saves permanently via /api/store/variable-overrides (item 1 fix) -----
function PFBVarEdit({ proj, onSave, onClose }) {
  const [dc,setDC]   = useState(proj.dc||'');
  const [ac,setAC]   = useState(proj.ac||'');
  const [sw,setSW]   = useState(proj.sw||'');
  const [piling,setPiling] = useState(proj.piling||2000);
  const [wall,setWall]     = useState(proj.wall||2000);
  const [road,setRoad]     = useState(proj.road||2000);
  const [saving,setSaving] = useState(false);

  const save = async () => {
    if (!dc||!ac||!sw) { alert('DC, AC, and Switchyards are required'); return; }
    setSaving(true);
    try {
      await fetch('/api/store/variable-overrides', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ projectId: proj.id, dc, ac, sw, piling, wall, road })
      });
      onSave(parseFloat(dc), parseFloat(ac), parseInt(sw), parseInt(piling), parseInt(wall), parseInt(road));
    } catch (e) { alert('Save failed: ' + e.message); }
    setSaving(false);
  };

  return (
    <Modal onClose={onClose} title={'Set Variables - ' + proj.name} width={680}>
      {proj.dc && <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px 14px',marginBottom:20,fontSize:13,color:'#64748b'}}>Current: DC={proj.dc} | AC={proj.ac} | SW={proj.sw}</div>}
      <div style={{fontSize:12,fontWeight:700,color:'#1d4ed8',marginBottom:12,letterSpacing:'0.04em'}}>DAS - CAPACITY VARIABLES</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:18,marginBottom:26}}>
        <Field label="DC (MWp)" value={dc} onChange={setDC} placeholder="8.5"/>
        <Field label="AC (MW)" value={ac} onChange={setAC} placeholder="5.7"/>
        <Field label="Switchyards" value={sw} onChange={setSW} placeholder="1"/>
      </div>
      <div style={{fontSize:12,fontWeight:700,color:'#7c3aed',marginBottom:12,letterSpacing:'0.04em'}}>PWR - QUANTITY VARIABLES</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:18,marginBottom:28}}>
        <Field label="Piling (nos.)" value={piling} onChange={setPiling} placeholder="2000"/>
        <Field label="Boundary Wall (m)" value={wall} onChange={setWall} placeholder="2000"/>
        <Field label="Road (m)" value={road} onChange={setRoad} placeholder="2000"/>
      </div>
      <button onClick={save} disabled={saving}
        style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'13px',cursor:'pointer',fontWeight:700,fontSize:15,opacity:saving?0.7:1}}>
        {saving?'Saving permanently...':'SAVE & Generate PFB'}
      </button>
    </Modal>
  );
}

// ----- UPDATE RATES / ADD ITEMS MODAL (item 4 fix) -----
function UpdateRatesModal({ onClose, onDone }) {
  const [file, setFile]       = useState(null);
  const [uploading, setUp]    = useState(false);
  const [result, setResult]   = useState(null);
  const [err, setErr]         = useState('');

  const upload = async () => {
    if (!file) { setErr('Choose an Excel file first'); return; }
    setUp(true); setErr('');
    try {
      const fileBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const r = await fetch('/api/store/rates', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ fileBase64, fileName: file.name })
      });
      const d = await r.json();
      if (d.success) { setResult(d); onDone(); } else { setErr(d.error || 'Upload failed'); }
    } catch (e) { setErr(e.message); }
    setUp(false);
  };

  return (
    <Modal onClose={onClose} title="Update Rates / Add Items" width={520}>
      {!result ? (
        <>
          <div style={{fontSize:12,color:'#64748b',marginBottom:16}}>
            Upload the latest reference PFB Excel (same layout as the standard sheet: Scope No., Scope Name, Side, Particular, PFB Head, Service/Supply, Unit, Qty, Rate). Any row matching one of the 94 existing items (by its Particular text, wherever it now sits in the sheet) gets its rate updated. Any row that doesn't match anything already known - whether it's been added at the end or inserted in between existing rows - is treated as a genuinely new line item and added automatically.
          </div>
          <div style={{background:'#fef9c3',border:'1px solid #fde68a',borderRadius:8,padding:'10px 14px',fontSize:12,color:'#92400e',marginBottom:16}}>
            This only affects projects added from today onward. Every existing project keeps the PFB it was originally generated with.
          </div>
          <div style={{border:'1.5px dashed #cbd5e1',borderRadius:10,padding:'20px',textAlign:'center',marginBottom:16}}>
            <input type="file" accept=".xlsx,.xls" onChange={function(e){setFile(e.target.files[0]||null);}}
              style={{fontSize:13}}/>
            {file && <div style={{marginTop:8,fontSize:12,color:'#15803d',fontWeight:600}}>{file.name}</div>}
          </div>
          {err && <div style={{background:'#fff1f2',color:'#dc2626',border:'1px solid #fecaca',borderRadius:8,padding:'8px 12px',fontSize:12,marginBottom:14}}>{err}</div>}
          <button onClick={upload} disabled={uploading||!file}
            style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:14,opacity:(uploading||!file)?0.6:1}}>
            {uploading?'Uploading and parsing...':'Upload & Apply'}
          </button>
        </>
      ) : (
        <div>
          <div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:10,padding:'16px 18px',marginBottom:14}}>
            <div style={{fontWeight:800,color:'#15803d',fontSize:15,marginBottom:6}}>Rate table updated</div>
            <div style={{fontSize:13,color:'#475569'}}>{result.updatedCount} existing item rate(s) updated. {result.newItemsCount} new item(s) added.</div>
          </div>
          <div style={{fontSize:12,color:'#64748b',marginBottom:16}}>{result.note}</div>
          <button onClick={onClose} style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:14}}>Done</button>
        </div>
      )}
    </Modal>
  );
}


function PFBDisplay({ proj, data, onClose }) {
  const secs = {A:'Project Material Expenses',B:'Project Execution',C:'Other Project Expenses'};
  const total = data && data.grandTotal || 0;
  const download = () => {
    const rows=[['Scope No','Section','Scope Name','Side','Particular','PFB Head','Unit','Qty','Rate','Amount']]
      .concat((data.items||[]).map(function(i){ return [i.scopeNo,i.section,i.scopeName,i.side,i.particular,i.pfbHead,i.unit,i.qty,i.rate,i.amount]; }));
    const csv = rows.map(function(r){ return r.map(function(c){ return '"' + (c==null?'':c) + '"'; }).join(','); }).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = 'PFB_' + proj.name.replace(/\s+/g,'_') + '.csv'; a.click();
  };
  return (
    <Modal onClose={onClose} width={1100}
      title={'PFB - ' + proj.name}
      subtitle={'DC: ' + proj.dc + ' MWp | AC: ' + proj.ac + ' MW | Switchyards: ' + proj.sw}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:16,flexWrap:'wrap',gap:8}}>
        <div>
          <div style={{fontSize:11,color:'#94a3b8',fontWeight:700,marginBottom:2}}>TOTAL BUDGET AMOUNT</div>
          <div style={{fontSize:24,fontWeight:900,color:'#0f172a'}}>{fmt(total)}</div>
          <div style={{fontSize:11,color:'#94a3b8',fontWeight:700,marginTop:8,marginBottom:2}}>RATE OF PROJECT</div>
          <div style={{fontSize:16,fontWeight:700,color:'#1d4ed8'}}>{'\u20b9' + (data && data.ratePerWp ? data.ratePerWp.toFixed(2) : String.fromCharCode(8212)) + '/Wp'}</div>
        </div>
        <button onClick={download} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:8,padding:'8px 16px',cursor:'pointer',fontSize:12,fontWeight:700}}>Download CSV</button>
      </div>
      {['A','B','C'].map(function(sec){
        const items = (data.items||[]).filter(function(i){ return i.section===sec; });
        return (
          <div key={sec} style={{marginBottom:18}}>
            <div style={{fontWeight:700,color:'#1d4ed8',fontSize:11,letterSpacing:'0.06em',padding:'5px 10px',background:'#eff6ff',borderRadius:6,marginBottom:5}}>
              SECTION {sec} - {secs[sec]}
            </div>
            <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:11.5}}>
                <thead><tr style={{background:'#f8fafc'}}>
                  {['#','Scope','PFB Head','Particular','Unit','Qty','Rate','Amount'].map(function(h){
                    return <th key={h} style={{padding:'6px 9px',textAlign:'left',color:'#475569',fontWeight:700,fontSize:11,borderBottom:'1px solid #e2e8f0',whiteSpace:'nowrap'}}>{h}</th>;
                  })}
                </tr></thead>
                <tbody>
                  {items.map(function(item,i){
                    return (
                      <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                        <td style={{padding:'5px 9px',color:'#94a3b8',fontSize:10}}>{item.scopeNo}</td>
                        <td style={{padding:'5px 9px',color:'#2563eb',fontSize:11,whiteSpace:'nowrap'}}>{item.scopeName}</td>
                        <td style={{padding:'5px 9px',color:'#7c3aed',fontSize:11,whiteSpace:'nowrap'}}>{item.pfbHead}</td>
                        <td style={{padding:'5px 9px',color:'#475569',maxWidth:200}}>{item.particular}</td>
                        <td style={{padding:'5px 9px',color:'#64748b'}}>{item.unit}</td>
                        <td style={{padding:'5px 9px',color:'#0f172a',textAlign:'right',fontWeight:500}}>{fmtN(item.qty)}</td>
                        <td style={{padding:'5px 9px',color:'#0f172a',textAlign:'right'}}>{fmt(item.rate)}</td>
                        <td style={{padding:'5px 9px',color:'#0f172a',textAlign:'right',fontWeight:700}}>{fmt(item.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </Modal>
  );
}

// ----- PROJECT DETAIL MODAL -- item 3 (live financials + Refresh) + item 9 (Modify/Add Zoho Names) -----
function ProjectDetailModal({ proj, parkNames, onClose, onProjUpdated }) {
  const [financials, setFinancials] = useState(null);
  const [loadingFin, setLoadingFin] = useState(false);
  const [finRequested, setFinRequested] = useState(false);
  const [showEditNames, setShowEditNames] = useState(false);
  const [showEditProject, setShowEditProject] = useState(false);
  const [localProj, setLocalProj] = useState(proj);

  const fetchFinancials = useCallback(async (forceRefresh) => {
    setLoadingFin(true); setFinRequested(true);
    try {
      const zn = encodeURIComponent(JSON.stringify(localProj.zohoNames || []));
      const ad = localProj.agreementDate ? '&agreementDate=' + encodeURIComponent(localProj.agreementDate) : '';
      const rf = forceRefresh ? '&refresh=1' : '';
      const r = await fetch('/api/project-financials?zohoNames=' + zn + ad + rf);
      const d = await r.json();
      if (d.success) setFinancials(d.data);
    } catch (e) {}
    setLoadingFin(false);
  }, [localProj]);

  // NOTE: this used to auto-fetch the moment the popup opened. On a cache
  // miss that endpoint can cost hundreds of Zoho API calls for a SINGLE
  // project (full pagination + a detail-fetch for every PO/Bill/Invoice/SO/CN
  // since the agreement date) — auto-firing it on every popup open is what
  // burned through an entire day's 10,000-call quota from just checking a
  // few projects once. It's now opt-in only, behind an explicit button below,
  // until this is rebuilt against Zoho Analytics instead (see chat).

  const handleNamesSaved = async () => {
    try {
      const r = await fetch('/api/store/zoho-names');
      const d = await r.json();
      const existing = proj.zohoNames || [];
      const fromStore = (d.data && d.data[proj.id]) || [];
      const updatedNames = [...new Set(existing.concat(fromStore))];
      setLocalProj(function(p){ return Object.assign({}, p, { zohoNames: updatedNames }); });
    } catch (e) {}
    if (onProjUpdated) onProjUpdated();
  };

  const handleProjectEdited = () => { if (onProjUpdated) onProjUpdated(); onClose(); };

  const metricCards = [
    ['PFB (Budget)', localProj.pfbTotal, '#eff6ff', '#1d4ed8'],
    ['POs', financials && financials.poTotal, '#f5f3ff', '#7c3aed'],
    ['Bills', financials && financials.billTotal, '#fff7ed', '#c2410c'],
    ['Invoices', financials && financials.invoiceTotal, '#f0fdf4', '#15803d'],
    ['Sales Orders', financials && financials.soTotal, '#ecfeff', '#0e7490'],
    ['Credit Notes', financials && financials.cnTotal, '#fdf2f8', '#be185d'],
  ];

  return (
    <>
      <Modal onClose={onClose} width={920} title={localProj.name} subtitle={(localProj.park||'') + ' Solar Park - ' + (localProj.quarter||String.fromCharCode(8212))}
        headerExtra={
          <button onClick={function(){setShowEditProject(true);}}
            style={{background:'#f8fafc',color:'#334155',border:'1px solid #e2e8f0',borderRadius:8,padding:'7px 14px',cursor:'pointer',fontSize:12,fontWeight:700}}>
            {'\u{1F58A}\uFE0F EDIT'}
          </button>
        }>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
          <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:10,padding:'14px 16px'}}>
            <div style={{fontSize:11,fontWeight:700,color:'#1d4ed8',letterSpacing:'0.08em',marginBottom:10}}>TECHNICAL DETAILS</div>
            {[
              ['DC Capacity', localProj.dc!=null?(localProj.dc + ' MWp'):String.fromCharCode(8212)],
              ['AC Capacity', localProj.ac!=null?(localProj.ac + ' MW'):String.fromCharCode(8212)],
              ['No. of Switchyards', localProj.sw!=null?String(localProj.sw):String.fromCharCode(8212)],
              ['BESS Capacity', localProj.bess?(localProj.bess + ' MWh'):'None'],
              ['Solar Park', localProj.park||String.fromCharCode(8212)],
              ['Revenue Quarter', localProj.quarter||String.fromCharCode(8212)],
            ].map(function(pair){
              const k = pair[0], v = pair[1];
              return (
                <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:'1px solid #f1f5f9',fontSize:13}}>
                  <span style={{color:'#64748b'}}>{k}</span><span style={{color:'#0f172a',fontWeight:600}}>{v}</span>
                </div>
              );
            })}
          </div>
          <div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:10,padding:'14px 16px'}}>
            <div style={{fontSize:11,fontWeight:700,color:'#15803d',letterSpacing:'0.08em',marginBottom:10}}>FINANCIAL DETAILS</div>
            {[
              ['Total Project Value', fmtCr(localProj.totalValue)],
              ['EPC Cost / MWp', localProj.epcCost?('\u20b9' + localProj.epcCost + ' Cr/MWp'):String.fromCharCode(8212)],
              ['PFB Total', localProj.pfbTotal?fmt(localProj.pfbTotal):'Not generated'],
              ['Rate / Wp', localProj.ratePerWp?('\u20b9' + localProj.ratePerWp.toFixed(2) + '/Wp'):String.fromCharCode(8212)],
              ['Agreement Date', localProj.agreementDate||String.fromCharCode(8212)],
              ['End Date', localProj.endDate||String.fromCharCode(8212)],
            ].map(function(pair){
              const k = pair[0], v = pair[1];
              return (
                <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:'1px solid #d1fae5',fontSize:13}}>
                  <span style={{color:'#64748b'}}>{k}</span><span style={{color:'#0f172a',fontWeight:600}}>{v}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
          <div style={{fontSize:11,fontWeight:700,color:'#0f172a',letterSpacing:'0.08em'}}>PROJECT DETAILS - TOTAL AMOUNTS</div>
          {finRequested && (
            <button onClick={function(){fetchFinancials(true);}} disabled={loadingFin}
              style={{background:'#f8fafc',color:'#475569',border:'1px solid #e2e8f0',borderRadius:6,padding:'4px 11px',cursor:'pointer',fontSize:11,fontWeight:600}}>
              {loadingFin?'Refreshing...':'\u{1F504} Refresh'}
            </button>
          )}
        </div>
        {!finRequested ? (
          <div style={{background:'#fff7ed',border:'1px solid #fed7aa',borderRadius:10,padding:'14px 16px',marginBottom:16,display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
            <div style={{fontSize:12,color:'#92400e'}}>
              Loading POs/Bills/Invoices/SOs/CNs totals for this project can cost a lot of Zoho API calls on the first check of the day (shared with the rest of the team) — click only when you actually need these numbers.
            </div>
            <button onClick={function(){fetchFinancials(false);}}
              style={{background:'#c2410c',color:'#fff',border:'none',borderRadius:7,padding:'8px 16px',cursor:'pointer',fontSize:12,fontWeight:700,whiteSpace:'nowrap'}}>
              Load Totals
            </button>
          </div>
        ) : (
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,marginBottom:16}}>
          {metricCards.map(function(card){
            const k = card[0], v = card[1], bg = card[2], c = card[3];
            return (
              <div key={k} style={{background:bg,border:'1px solid ' + c + '33',borderRadius:10,padding:'12px 14px'}}>
                <div style={{fontSize:10,color:c,fontWeight:700,letterSpacing:'0.06em',marginBottom:4,opacity:0.85}}>{k.toUpperCase()}</div>
                <div style={{fontSize:17,fontWeight:800,color:c}}>{(loadingFin && k!=='PFB (Budget)') ? '...' : fmt(v)}</div>
              </div>
            );
          })}
        </div>
        )}

        <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px 14px',marginBottom:14}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
            <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em'}}>ZOHO BOOKS PROJECT NAMES</div>
            <button onClick={function(){setShowEditNames(true);}}
              style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:6,padding:'3px 10px',cursor:'pointer',fontSize:11,fontWeight:600}}>
              {'\u{1F58A}\uFE0F Modify/Add'}
            </button>
          </div>
          <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
            {(localProj.zohoNames||[]).map(function(n){
              return <span key={n} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:5,padding:'2px 8px',fontSize:12}}>{n}</span>;
            })}
          </div>
        </div>

        {!localProj.pfbReady && (
          <div style={{background:'#fef9c3',border:'1px solid #fde68a',borderRadius:8,padding:'10px 14px',fontSize:12,color:'#92400e'}}>
            PFB not yet generated - DC, AC, and Switchyard variables need to be set.
          </div>
        )}
      </Modal>

      {showEditNames && (
        <EditZohoNamesModal proj={localProj} onClose={function(){setShowEditNames(false);}} onSaved={handleNamesSaved}/>
      )}
      {showEditProject && (
        <EditProjectModal proj={localProj} parkNames={parkNames||[]} onClose={function(){setShowEditProject(false);}} onSaved={handleProjectEdited}/>
      )}
    </>
  );
}

// ----- SOLAR PARK DETAIL MODAL -----
function ParkModal({ park, onClose, onProjectClick, onParkUpdated }) {
  const [showEdit, setShowEdit] = useState(false);
  const totalBESS = park.projects.reduce(function(s,p){ return s+(p.bess||0); },0);
  const colTemplate = '2fr 80px 80px 80px 100px 100px';
  const handleEdited = () => { if (onParkUpdated) onParkUpdated(); onClose(); };
  return (
    <>
    <Modal onClose={onClose} width={860} title={'\u{1F31E} ' + park.name + ' Solar Park'} subtitle={park.district + ', ' + park.state + ' - ' + park.count + ' project' + (park.count!==1?'s':'')}
      headerExtra={
        <button onClick={function(){setShowEdit(true);}}
          style={{background:'#f8fafc',color:'#334155',border:'1px solid #e2e8f0',borderRadius:8,padding:'7px 14px',cursor:'pointer',fontSize:12,fontWeight:700}}>
          {'\u{1F58A}\uFE0F EDIT'}
        </button>
      }>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:16}}>
        {[
          ['Total DC', park.totalDC.toFixed(2) + ' MWp'],
          ['Total BESS', totalBESS ? (totalBESS.toFixed(2) + ' MWh') : 'None'],
          ['Total Value', fmtCr(park.totalValue)],
          ['Projects', String(park.count)],
          ['District', park.district||String.fromCharCode(8212)],
          ['State', park.state||String.fromCharCode(8212)],
        ].map(function(pair){
          const k = pair[0], v = pair[1];
          return (
            <div key={k} style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px 12px'}}>
              <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,marginBottom:3}}>{k.toUpperCase()}</div>
              <div style={{fontSize:15,fontWeight:700,color:'#0f172a'}}>{v}</div>
            </div>
          );
        })}
      </div>
      <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>Projects in this park</h3>
      <div style={{border:'1px solid #e2e8f0',borderRadius:8,overflow:'hidden'}}>
        {park.projects.length > 0 && (
          <div style={{display:'grid',gridTemplateColumns:colTemplate,alignItems:'center',padding:'8px 14px',background:'#f8fafc',borderBottom:'1.5px solid #e2e8f0'}}>
            {['Project Name','DC (MWp)','AC (MW)','BESS','Value','Agr. Date'].map(function(h){
              return <span key={h} style={{fontSize:10,fontWeight:700,color:'#64748b',letterSpacing:'0.05em'}}>{h.toUpperCase()}</span>;
            })}
          </div>
        )}
        {park.projects.length === 0 && <div style={{padding:'24px',textAlign:'center',color:'#94a3b8',fontSize:13}}>No projects assigned to this park yet</div>}
        {park.projects.map(function(p,i){
          return (
            <div key={i} onClick={function(){onClose();onProjectClick(p);}}
              style={{display:'grid',gridTemplateColumns:colTemplate,alignItems:'center',padding:'10px 14px',borderBottom:i<park.projects.length-1?'1px solid #f1f5f9':'none',cursor:'pointer'}}
              onMouseEnter={function(e){e.currentTarget.style.background='#f0f9ff';}} onMouseLeave={function(e){e.currentTarget.style.background='#fff';}}>
              <span style={{fontSize:13,fontWeight:600,color:'#0f172a'}}>{p.name}</span>
              <span style={{fontSize:12,color:'#2563eb'}}>{p.dc?(p.dc + ' MWp'):String.fromCharCode(8212)}</span>
              <span style={{fontSize:12,color:'#15803d'}}>{p.ac?(p.ac + ' MW'):String.fromCharCode(8212)}</span>
              <span style={{fontSize:12,color:'#a16207'}}>{p.bess?(p.bess + ' MWh'):String.fromCharCode(8212)}</span>
              <span style={{fontSize:12,color:'#0f172a',fontWeight:600}}>{fmtCr(p.totalValue)}</span>
              <span style={{fontSize:11,color:'#64748b'}}>{p.agreementDate||String.fromCharCode(8212)}</span>
            </div>
          );
        })}
      </div>
    </Modal>
    {showEdit && <EditParkModal park={park} onClose={function(){setShowEdit(false);}} onSaved={handleEdited}/>}
    </>
  );
}

// ----- LINE ITEMS TABLE -----
function ItemsTable({ items, title }) {
  if (!items || !items.length) return null;
  return (
    <div style={{marginBottom:20}}>
      <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>{title||'Line Items'}</h3>
      <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
          <thead><tr style={{background:'#f8fafc'}}>
            {['#','Item Name','Project','HSN/SAC','Qty','Unit','Rate','Amount','Tax'].map(function(h){
              return <th key={h} style={{padding:'7px 10px',textAlign:'left',color:'#475569',fontWeight:700,fontSize:11,borderBottom:'1px solid #e2e8f0',whiteSpace:'nowrap'}}>{h}</th>;
            })}
          </tr></thead>
          <tbody>
            {items.map(function(li,i){
              const projCode = li.project_name
                ? extractCode(li.project_name)
                : ((li.description||'').match(/LE\d{4}/i)||[])[0] || '';
              return (
                <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                  <td style={{padding:'6px 10px',color:'#94a3b8',fontSize:11}}>{i+1}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',fontWeight:500,maxWidth:200}}>{compressName(li.name,5)}</td>
                  <td style={{padding:'6px 10px',color:'#2563eb',fontSize:11,fontWeight:600}}>{projCode||String.fromCharCode(8212)}</td>
                  <td style={{padding:'6px 10px',color:'#64748b'}}>{li.hsn_or_sac||String.fromCharCode(8212)}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',fontWeight:500}}>{fmtN(li.quantity)}</td>
                  <td style={{padding:'6px 10px',color:'#64748b'}}>{li.unit||String.fromCharCode(8212)}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a'}}>{fmt(li.rate)}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',fontWeight:700}}>{fmt(li.item_total)}</td>
                  <td style={{padding:'6px 10px',color:'#64748b',fontSize:11}}>{li.tax_name||String.fromCharCode(8212)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----- ATTACHMENTS -----
function Attachments({ docs }) {
  if (!docs || !docs.length) return <div style={{color:'#94a3b8',fontSize:12,marginBottom:16}}>{'\u{1F4CE}'} No attachments</div>;
  return (
    <div style={{marginBottom:16}}>
      <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>{'Attachments (' + docs.length + ')'}</h3>
      <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
        {docs.map(function(d,i){
          const name = d.file_name || d.fileName || ('Document ' + (i+1));
          const url = d.download_url || d.attachment_url || null;
          return url ? (
            <a key={i} href={url} target="_blank" rel="noreferrer" style={{display:'flex',alignItems:'center',gap:6,background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:6,padding:'5px 10px',fontSize:12,fontWeight:500,textDecoration:'none'}}>{'\u{1F4CE} ' + name}</a>
          ) : (
            <span key={i} style={{display:'flex',alignItems:'center',gap:6,background:'#f8fafc',color:'#64748b',border:'1px solid #e2e8f0',borderRadius:6,padding:'5px 10px',fontSize:12}}>{'\u{1F4CE} ' + name}</span>
          );
        })}
      </div>
    </div>
  );
}

// ----- DETAIL MODAL (PO / BILL / PMO) -----
function DetailModal({ item, type, onClose }) {
  const isBill = type === 'bill', isPMO = type === 'pmo';

  const fields = isPMO ? [
    ['PMO Number', item.pmoNumber],['PMO Date', toIndianDate(item.date)],
    ['Vendor / Payee', item.vendor],['Payable Amount', fmt(item.amount)],
    ['Payment Category', item.paymentCategory||String.fromCharCode(8212)],['Expense Account', item.expenseAccount||String.fromCharCode(8212)],
    ['Customer Name', item.customerName||String.fromCharCode(8212)],['Closing Balance', fmt(item.closingBalance)],
    ['Amt vs Bill', fmt(item.amtAgainstBill)],['Amt vs PO', fmt(item.amtAgainstPO)],
    ['Amt vs Invoice', fmt(item.amtAgainstInvoice)],['Amt vs Expense', fmt(item.amtAgainstExpense)],
    ['Submitted By', item.submittedBy||String.fromCharCode(8212)],['Submitted Date', toIndianDate(item.submittedDate)],
    ['Attachment', item.attachmentId||'None'],
  ] : isBill ? [
    ['Bill Number', item.billNumber],['Bill Date', toIndianDate(item.date)],['Due Date', toIndianDate(item.dueDate)],
    ['Vendor', item.vendor],['Vendor GSTIN', item.gstin||String.fromCharCode(8212)],
    ['Project (PFB Match)', item.projectMatched||'Not matched'],
    ['Total Amount', fmt(item.total)],['Balance Due', fmt(item.balance)],
    ['Linked PO', (item.linkedPO && item.linkedPO.number) || (item.noPOExpected?'None expected':'None')],
    ['PO Amount', item.linkedPO ? fmt(item.linkedPO.total) : String.fromCharCode(8212)],
    ['Submitted By', item.submittedBy||String.fromCharCode(8212)],['Submitted Date', toIndianDate(item.submittedDate)],
  ] : [
    ['PO Number', item.poNumber],['PO Date', toIndianDate(item.date)],
    ['Vendor', item.vendor],['Vendor GSTIN', item.gstin||String.fromCharCode(8212)],
    ['Project (PFB Match)', item.projectMatched||'Not matched'],
    ['Total Amount', fmt(item.total)],['PFB Budget', fmt(item.pfbTotal)],
    ['Payment Terms', item.paymentTerms||String.fromCharCode(8212)],['Delivery Date', toIndianDate(item.deliveryDate)],
    ['Submitted By', item.submittedBy||String.fromCharCode(8212)],['Submitted Date', toIndianDate(item.submittedDate)],
  ];

  const projectNames = (item.projectZoho && item.projectZoho.length) ? item.projectZoho : [];
  // pos.js stores PFB checks as `lineChecks`, bills.js as `pfbLineChecks` —
  // covering both so the PFB Alignment table doesn't end up silently empty
  // for one of the two types.
  const pfbChecks = item.lineChecks || item.pfbLineChecks;

  return (
    <Modal onClose={onClose} width={980}
      title={isPMO ? ('PMO ' + item.pmoNumber) : isBill ? ('Bill ' + item.billNumber) : ('PO ' + item.poNumber)}
      subtitle={item.vendor}>
      {projectNames.length > 0 && (
        <div style={{background:'#f0f9ff',border:'1px solid #bae6fd',borderRadius:8,padding:'10px 14px',marginBottom:14}}>
          <div style={{fontSize:10,color:'#0369a1',fontWeight:700,letterSpacing:'0.08em',marginBottom:4}}>PROJECT(S) IN ZOHO</div>
          {projectNames.map(function(n,i){
            return <div key={i} style={{fontSize:13,color:'#0f172a',fontWeight:500,marginBottom:2}}>{n}</div>;
          })}
        </div>
      )}
      <InfoGrid fields={fields} cols={3}/>
      <RecBox rec={item.recommendation}/>
      <ItemsTable items={item.lineItems || item.line_items} title="Line Items"/>
      <CompTable checks={item.compliance} title={(isPMO?'PMO':isBill?'Bill':'PO') + ' Compliance Checks'}/>
      {!isPMO && <LineTable checks={pfbChecks} title="PFB Alignment - Line by Line"/>}
      {isBill && item.poLineChecks && item.poLineChecks.length>0 && <LineTable checks={item.poLineChecks} title="PO Match - Line by Line"/>}
      {isPMO && item.alignment && item.alignment.checks && item.alignment.checks.length>0 && <CompTable checks={item.alignment.checks} title="PI / Bill Alignment"/>}
      <Attachments docs={item.attachments || item.docs || item.documents}/>
    </Modal>
  );
}

// ----- SEARCH OVERLAY -----
function SearchBox({ type, onClose, onSelect }) {
  const [q,setQ]=useState(''); const [results,setR]=useState([]); const [loading,setL]=useState(false);
  const timer = useRef(null);
  useEffect(function(){
    if (q.length < 2) { setR([]); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async function(){
      setL(true);
      try {
        const r = await fetch('/api/search?type=' + type + '&q=' + encodeURIComponent(q));
        const d = await r.json();
        setR(d.data || []);
      } catch (e) {}
      setL(false);
    }, 400);
  }, [q, type]);
  return (
    <div onClick={function(e){ if (e.target===e.currentTarget) onClose(); }}
      style={{position:'fixed',inset:0,background:'rgba(15,23,42,0.5)',zIndex:2000,display:'flex',alignItems:'flex-start',justifyContent:'center',paddingTop:72,backdropFilter:'blur(3px)'}}>
      <div style={{background:'#fff',borderRadius:14,width:'100%',maxWidth:560,overflow:'hidden',boxShadow:'0 24px 64px rgba(0,0,0,0.2)',border:'1px solid #e2e8f0'}}>
        <div style={{padding:'12px 16px',borderBottom:'1px solid #f1f5f9',display:'flex',gap:10,alignItems:'center'}}>
          <span style={{fontSize:15,color:'#94a3b8'}}>Search</span>
          <input autoFocus value={q} onChange={function(e){setQ(e.target.value);}} placeholder={'Search ' + (type==='bill'?'Bills':'POs') + '...'}
            style={{flex:1,border:'none',outline:'none',fontSize:14,color:'#0f172a'}}/>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',fontSize:18,color:'#94a3b8'}}>&times;</button>
        </div>
        <div style={{maxHeight:360,overflowY:'auto'}}>
          {loading && <div style={{padding:18,color:'#94a3b8',textAlign:'center',fontSize:13}}>Searching...</div>}
          {results.map(function(r){
            return (
              <div key={r.id} onClick={function(){onSelect(r);}} style={{padding:'11px 16px',borderBottom:'1px solid #f8fafc',cursor:'pointer',display:'flex',justifyContent:'space-between'}}
                onMouseEnter={function(e){e.currentTarget.style.background='#f8fafc';}} onMouseLeave={function(e){e.currentTarget.style.background='#fff';}}>
                <div>
                  <div style={{fontWeight:700,color:'#0f172a',fontSize:13}}>{r.number}</div>
                  <div style={{color:'#64748b',fontSize:12,marginTop:1}}>{r.vendor} - {r.project||'No project'}</div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{fontWeight:700,color:'#1d4ed8',fontSize:13}}>{fmt(r.total)}</div>
                  <div style={{color:'#94a3b8',fontSize:11}}>{toIndianDate(r.date)}</div>
                </div>
              </div>
            );
          })}
          {!loading && q.length>=2 && !results.length && <div style={{padding:20,color:'#94a3b8',textAlign:'center',fontSize:13}}>No results</div>}
        </div>
      </div>
    </div>
  );
}

// ----- LOGIN GATE -----
// Replaces the old middleware.js/proxy.js approach. Next.js 16 renamed the
// middleware file convention to "proxy.js", and that rename runs into a
// confirmed, Next.js-team-tracked bug where Proxy silently does not execute
// at all on Windows (vercel/next.js issues #85243, #86122, #87071) — which
// is exactly what happened here: the login gate stopped running entirely
// and the dashboard became visible with no login at all.
//
// getServerSideProps below does the exact same cookie check, but through
// Next's plain server-side-rendering path rather than the Edge/Proxy
// boundary. This is the oldest, most stable part of Next.js (works
// identically in Pages Router on every OS and on Vercel), so it sidesteps
// that bug completely instead of hoping a future Next.js patch fixes it.
export async function getServerSideProps(context) {
  const cookieHeader = context.req.headers.cookie || '';
  const cookies = cookieHeader.split(';').map(c => c.trim());
  const authCookie = cookies.find(c => c.startsWith('fd_auth='));
  const value = authCookie ? authCookie.split('=')[1] : null;

  if (value !== 'jatin_2025_ok') {
    return {
      redirect: {
        destination: '/login?from=' + encodeURIComponent(context.resolvedUrl || '/'),
        permanent: false,
      },
    };
  }
  return { props: {} };
}

// =================================================================
// MAIN DASHBOARD
// =================================================================
export default function Dashboard() {
  const [tab,          setTab]        = useState('pos');
  const [pos,          setPOs]        = useState([]);
  const [bills,        setBills]      = useState([]);
  const [pmos,         setPMOs]       = useState([]);
  const [projects,     setProjects]   = useState([]);
  const [firms,        setFirms]      = useState([]);
  const [parks,        setParks]      = useState([]);
  const [pfbCache,     setPFBCache]   = useState({});
  const [loading,      setLoading]    = useState({pos:true,bills:true,pmos:true,projects:true});
  const [selected,     setSelected]   = useState(null);
  const [pfbFlow,      setPFBFlow]    = useState(null);
  const [projDetail,   setProjDetail] = useState(null);
  const [parkDetail,   setParkDetail] = useState(null);
  const [showSearch,   setSearch]     = useState(null);
  const [showAddProj,  setShowAddProj]= useState(false);
  const [showAddPark,  setShowAddPark]= useState(false);
  const [lastSync,     setLastSync]   = useState(null);
  const [expandedFirms,setExpanded]   = useState({});
  const [errors,       setErrors]     = useState({});
  const [showUpdateRates, setShowUpdateRates] = useState(false);

  const fetchPOs = useCallback(async function(){
    setLoading(function(p){ return Object.assign({},p,{pos:true}); });
    try {
      const r = await fetch('/api/pos');
      const d = await r.json();
      if (d.success) { setPOs(d.data); setLastSync(new Date()); setErrors(function(p){ return Object.assign({},p,{pos:null}); }); }
      else setErrors(function(p){ return Object.assign({},p,{pos:d.error||'Failed to load POs'}); });
    } catch (e) { setErrors(function(p){ return Object.assign({},p,{pos:e.message}); }); }
    setLoading(function(p){ return Object.assign({},p,{pos:false}); });
  }, []);

  const fetchBills = useCallback(async function(){
    setLoading(function(p){ return Object.assign({},p,{bills:true}); });
    try {
      const r = await fetch('/api/bills');
      const d = await r.json();
      if (d.success) { setBills(d.data); setErrors(function(p){ return Object.assign({},p,{bills:null}); }); }
      else setErrors(function(p){ return Object.assign({},p,{bills:d.error||'Failed to load Bills'}); });
    } catch (e) { setErrors(function(p){ return Object.assign({},p,{bills:e.message}); }); }
    setLoading(function(p){ return Object.assign({},p,{bills:false}); });
  }, []);

  const fetchPMOs = useCallback(async function(){
    setLoading(function(p){ return Object.assign({},p,{pmos:true}); });
    try {
      const r = await fetch('/api/pmos');
      const d = await r.json();
      if (d.success) { setPMOs(d.data); setErrors(function(p){ return Object.assign({},p,{pmos:null}); }); }
      else setErrors(function(p){ return Object.assign({},p,{pmos:d.error||'Failed to load PMOs'}); });
    } catch (e) { setErrors(function(p){ return Object.assign({},p,{pmos:e.message}); }); }
    setLoading(function(p){ return Object.assign({},p,{pmos:false}); });
  }, []);

  const fetchProjects = useCallback(async function(){
    setLoading(function(p){ return Object.assign({},p,{projects:true}); });
    try {
      const r = await fetch('/api/projects');
      const d = await r.json();
      if (d.success) { setProjects(d.allProjects||[]); setFirms(d.firms||[]); setParks(d.parks||[]); }
    } catch (e) {}
    setLoading(function(p){ return Object.assign({},p,{projects:false}); });
  }, []);

  const fetchPFB = async function(proj){
    const key = proj.id;
    if (pfbCache[key]) return pfbCache[key];
    const r = await fetch('/api/pfb?projectId=' + proj.id);
    const d = await r.json();
    if (d.success) { setPFBCache(function(p){ return Object.assign({},p,{[key]:d}); }); return d; }
    return null;
  };

  const downloadProjectsData = function() {
    const rows = projects.map(function(p){
      return {
        'Project Name': p.name, 'Firm': p.firm||'', 'Solar Park': p.park||'',
        'DC (MWp)': p.dc, 'AC (MW)': p.ac, 'Switchyards': p.sw, 'BESS (MWh)': p.bess||0,
        'Total Value (Cr)': p.totalValue, 'EPC Cost (Cr/MWp)': p.epcCost,
        'PFB Total': p.pfbTotal||'', 'Rate/Wp': p.ratePerWp?p.ratePerWp.toFixed(2):'',
        'Agreement Date': p.agreementDate||'', 'End Date': p.endDate||'', 'Quarter': p.quarter||'',
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Projects');
    XLSX.writeFile(wb, 'Projects_' + new Date().toISOString().slice(0,10) + '.xlsx');
  };

  const downloadParksData = function() {
    const rows = parks.map(function(pk){
      return {
        'Park Name': pk.name, 'District': pk.district||'', 'State': pk.state||'',
        'Projects': pk.count, 'Total DC (MWp)': pk.totalDC, 'Total BESS (MWh)': pk.totalBESS||0,
        'Total Value (Cr)': pk.totalValue,
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Solar Parks');
    XLSX.writeFile(wb, 'Solar_Parks_' + new Date().toISOString().slice(0,10) + '.xlsx');
  };

  useEffect(function(){
    fetchPOs(); fetchBills(); fetchPMOs(); fetchProjects();
    const iv = setInterval(function(){ fetchPOs(); fetchBills(); fetchPMOs(); }, 15*60*1000);
    return function(){ clearInterval(iv); };
  }, [fetchPOs, fetchBills, fetchPMOs, fetchProjects]);

  const sortByDate = function(arr, field) {
    return arr.slice().sort(function(a,b){
      const da = new Date(a[field]||0), db = new Date(b[field]||0);
      return db - da;
    });
  };

  const poIssues   = pos.filter(function(p){ return p.complianceStatus!=='pass' || p.alignmentStatus==='reject'; }).length;
  const billIssues = bills.filter(function(b){ return b.complianceStatus!=='pass' || b.alignmentStatus==='reject'; }).length;
  const pmoIssues  = pmos.filter(function(p){ return p.complianceStatus!=='pass'; }).length;
  const totalFlag  = poIssues + billIssues + pmoIssues;

  const poValue   = pos.reduce(function(s,p){ return s+(p.total||0); }, 0);
  const billValue = bills.reduce(function(s,b){ return s+(b.total||0); }, 0);
  const pmoValue  = pmos.reduce(function(s,p){ return s+(p.amount||0); }, 0);
  const totalPendingCount = pos.length + bills.length + pmos.length;
  const totalPendingValue = poValue + billValue + pmoValue;

  const TH = {padding:'9px 11px',textAlign:'left',color:'#64748b',fontWeight:700,fontSize:11,letterSpacing:'0.06em',borderBottom:'1.5px solid #e2e8f0',whiteSpace:'nowrap',background:'#f8fafc',position:'sticky',top:0};
  const TD = {padding:'9px 11px',fontSize:13,verticalAlign:'middle',whiteSpace:'nowrap'};
  const rowBg = function(item) {
    if (item.complianceStatus==='fail' || item.alignmentStatus==='reject') return '#fff1f2';
    if (item.complianceStatus==='warn' || item.alignmentStatus==='flag') return '#fefce8';
    return '#fff';
  };

  const startPFB = function(p) { setPFBFlow({proj:p, step:'confirm'}); };
  const onPFBYes = async function() {
    const d = await fetchPFB(pfbFlow.proj);
    setPFBFlow(function(f){ return Object.assign({},f,{pfbData:d, step:'show'}); });
  };
  const onPFBNo = function() { setPFBFlow(function(f){ return Object.assign({},f,{step:'edit'}); }); };
  const onPFBSave = async function(dc,ac,sw,piling,wall,road) {
    const updated = Object.assign({}, pfbFlow.proj, {dc,ac,sw,piling,wall,road,pfbReady:true});
    setPFBCache(function(p){ const c = Object.assign({},p); delete c[updated.id]; return c; });
    const r = await fetch('/api/pfb?projectId=' + updated.id);
    const d = await r.json();
    if (d.success) setPFBCache(function(p){ return Object.assign({},p,{[updated.id]:d}); });
    setPFBFlow({proj:updated, pfbData:d, step:'show'});
    fetchProjects();
  };

  const parkNames = parks.map(function(p){ return p.name; });

  return (
    <>
      <Head>
        <title>Finance Control - Rays Power Experts</title>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
      </Head>
      <style>{
        '*{box-sizing:border-box;margin:0;padding:0}' +
        'body{background:#f1f5f9;color:#0f172a;font-family:"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}' +
        '::-webkit-scrollbar{width:5px;height:5px}' +
        '::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px}' +
        'tbody tr:hover td{background:#f0f9ff!important;cursor:pointer}' +
        '@keyframes spin{to{transform:rotate(360deg)}}' +
        '@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}' +
        '.fade{animation:fadeIn 0.2s ease}' +
        'input:focus{border-color:#2563eb!important}'
      }</style>

      <div style={{minHeight:'100vh',display:'flex',flexDirection:'column',background:'#f1f5f9'}}>

        <div style={{background:'#fff',borderBottom:'1.5px solid #e2e8f0',padding:'0 24px',display:'flex',alignItems:'center',justifyContent:'space-between',height:58,position:'sticky',top:0,zIndex:200,boxShadow:'0 1px 4px rgba(0,0,0,0.05)'}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{width:32,height:32,background:'#1d4ed8',borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:900,fontSize:15}}>FC</div>
            <div>
              <div style={{fontWeight:800,fontSize:15,color:'#0f172a',letterSpacing:'-0.02em'}}>Finance Control Dashboard</div>
              <div style={{fontSize:11,color:'#94a3b8'}}>Rays Power Experts Ltd.</div>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:14}}>
            {totalFlag>0 && <div style={{background:'#fee2e2',color:'#b91c1c',padding:'3px 12px',borderRadius:20,fontSize:12,fontWeight:700,border:'1px solid #fca5a5'}}>{totalFlag} need attention</div>}
            {lastSync && <div style={{fontSize:12,color:'#94a3b8',display:'flex',alignItems:'center',gap:5}}><span style={{width:6,height:6,borderRadius:'50%',background:'#22c55e',display:'inline-block'}}/>Live - {lastSync.toLocaleTimeString()}</div>}
            <div style={{fontSize:13,color:'#64748b',fontWeight:500}}>Jatin Srivastava</div>
          </div>
        </div>

        <div style={{padding:'14px 24px',display:'grid',gridTemplateColumns:'repeat(8,1fr)',gap:9}}>
          <Card label={'\u{1F4CB} POs PENDING'} value={pos.length} sub={fmt(poValue)} color="#f59e0b"/>
          <Card label={'\u26A0\uFE0F PO ISSUES'} value={poIssues} sub="compliance / alignment" color="#f97316"/>
          <Card label={'\u{1F9FE} BILLS PENDING'} value={bills.length} sub={fmt(billValue)} color="#8b5cf6"/>
          <Card label={'\u26A0\uFE0F BILL ISSUES'} value={billIssues} sub="compliance / alignment" color="#ef4444"/>
          <Card label={'\u{1F4B3} PMOs PENDING'} value={pmos.length} sub={fmt(pmoValue)} color="#0ea5e9"/>
          <Card label={'\u26A0\uFE0F PMO ISSUES'} value={pmoIssues} sub={'of ' + pmos.length + ' PMOs'} color="#ef4444"/>
          <Card label={'\u{1F31E} PROJECTS'} value={projects.length} sub={parks.length + ' solar parks'} color="#10b981"/>
          <Card label={'\u{1F4CC} TOTAL PENDING'} value={totalPendingCount} sub={'POs + Bills + PMOs total - ' + fmt(totalPendingValue)} color="#dc2626"/>
        </div>

        <div style={{background:'#fff',borderBottom:'1.5px solid #e2e8f0',padding:'0 24px',display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:58,zIndex:100,boxShadow:'0 1px 3px rgba(0,0,0,0.03)'}}>
          <div style={{display:'flex'}}>
            {[
              {id:'pos',   label:'POs (' + pos.length + ')',    warn:poIssues},
              {id:'bills', label:'Bills (' + bills.length + ')', warn:billIssues},
              {id:'pmos',  label:'PMOs (' + pmos.length + ')',   warn:pmoIssues},
              {id:'pfbs',  label:'PFBs'},
              {id:'projects',label:'Projects (' + projects.length + ')'},
              {id:'parks', label:'Solar Parks (' + parks.length + ')'},
            ].map(function(t){
              return (
                <button key={t.id} onClick={function(){setTab(t.id);}} style={{padding:'11px 16px',cursor:'pointer',border:'none',background:'transparent',color:tab===t.id?'#1d4ed8':'#64748b',borderBottom:tab===t.id?'2.5px solid #1d4ed8':'2.5px solid transparent',fontSize:13,fontWeight:tab===t.id?700:500,display:'flex',alignItems:'center',gap:5}}>
                  {t.label}
                  {t.warn>0 && <span style={{background:'#fee2e2',color:'#b91c1c',borderRadius:10,padding:'1px 6px',fontSize:10,fontWeight:800}}>{t.warn}</span>}
                </button>
              );
            })}
          </div>
          <div style={{display:'flex',gap:7}}>
            {['pos','bills','pmos'].indexOf(tab)>=0 && (
              <>
                {tab!=='pmos' && <button onClick={function(){setSearch(tab==='bills'?'bill':'po');}} style={{background:'#f8fafc',color:'#475569',border:'1px solid #e2e8f0',borderRadius:7,padding:'5px 11px',cursor:'pointer',fontSize:12}}>Search</button>}
                <button onClick={function(){ if(tab==='pos') fetchPOs(); else if(tab==='bills') fetchBills(); else fetchPMOs(); }} style={{background:'#f8fafc',color:'#475569',border:'1px solid #e2e8f0',borderRadius:7,padding:'5px 11px',cursor:'pointer',fontSize:12}}>{'\u{1F504} Refresh'}</button>
              </>
            )}
            {tab==='pfbs' && (
              <button onClick={function(){setShowUpdateRates(true);}} style={{background:'#fff7ed',color:'#c2410c',border:'1px solid #fed7aa',borderRadius:7,padding:'5px 13px',cursor:'pointer',fontSize:12,fontWeight:600}}>{'\u{1F4B0} Update Rates / Add Items'}</button>
            )}
            {tab==='projects' && (
              <>
                <button onClick={downloadProjectsData} style={{background:'#f8fafc',color:'#475569',border:'1px solid #e2e8f0',borderRadius:7,padding:'5px 13px',cursor:'pointer',fontSize:12,fontWeight:600}}>{'\u{1F4E5} Download All Data'}</button>
                <button onClick={function(){setShowAddProj(true);}} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:7,padding:'5px 13px',cursor:'pointer',fontSize:12,fontWeight:600}}>{'\u2795 Add New Project'}</button>
              </>
            )}
            {tab==='parks' && (
              <>
                <button onClick={downloadParksData} style={{background:'#f8fafc',color:'#475569',border:'1px solid #e2e8f0',borderRadius:7,padding:'5px 13px',cursor:'pointer',fontSize:12,fontWeight:600}}>{'\u{1F4E5} Download All Data'}</button>
                <button onClick={function(){setShowAddPark(true);}} style={{background:'#f0fdf4',color:'#15803d',border:'1px solid #bbf7d0',borderRadius:7,padding:'5px 13px',cursor:'pointer',fontSize:12,fontWeight:600}}>{'\u{1F31E} Add New Park'}</button>
              </>
            )}
          </div>
        </div>

        <div style={{flex:1,padding:'18px 24px'}}>

          {tab==='pos' && (
            <div className="fade">
              <ErrorBanner message={errors.pos} onRetry={fetchPOs}/>
              {loading.pos ? <Spinner label="Loading POs from Zoho Books..."/> : (
                <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse'}}>
                      <thead><tr>
                        {['PO Number','Date','Vendor','Project','Amount','Compliance','Alignment','Recommendation',''].map(function(h){ return <th key={h} style={TH}>{h}</th>; })}
                      </tr></thead>
                      <tbody>
                        {sortByDate(pos,'date').map(function(po){
                          return (
                            <tr key={po.id} style={{borderBottom:'1px solid #f1f5f9',background:rowBg(po)}} onClick={function(){setSelected({item:po,type:'po'});}}>
                              <td style={Object.assign({},TD,{color:'#1d4ed8',fontWeight:700})}>{po.poNumber}</td>
                              <td style={Object.assign({},TD,{color:'#64748b'})}>{toIndianDate(po.date)}</td>
                              <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:500,maxWidth:160,whiteSpace:'normal'})}>{po.vendor}</td>
                              <td style={TD}><ProjectCodes names={po.projectZoho}/></td>
                              <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:700})}>{fmt(po.total)}</td>
                              <td style={TD}><CompBadge s={po.complianceStatus}/></td>
                              <td style={TD}><AlignBadge s={po.alignmentStatus}/></td>
                              <td style={TD}><RecBadge d={po.recommendation && po.recommendation.decision}/></td>
                              <td style={TD}><button onClick={function(e){e.stopPropagation();setSelected({item:po,type:'po'});}} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:6,padding:'3px 9px',cursor:'pointer',fontSize:11,fontWeight:600}}>View Details</button></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {!pos.length && !loading.pos && <div style={{textAlign:'center',padding:'48px',color:'#94a3b8',fontSize:14}}>No POs pending approval</div>}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab==='bills' && (
            <div className="fade">
              <ErrorBanner message={errors.bills} onRetry={fetchBills}/>
              {loading.bills ? <Spinner label="Loading Bills from Zoho Books..."/> : (
                <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse'}}>
                      <thead><tr>
                        {['Bill Number','Date','Vendor','Project','Amount','Linked PO','Compliance','Alignment','Recommendation',''].map(function(h){ return <th key={h} style={TH}>{h}</th>; })}
                      </tr></thead>
                      <tbody>
                        {sortByDate(bills,'date').map(function(b){
                          return (
                            <tr key={b.id} style={{borderBottom:'1px solid #f1f5f9',background:rowBg(b)}} onClick={function(){setSelected({item:b,type:'bill'});}}>
                              <td style={Object.assign({},TD,{color:'#7c3aed',fontWeight:700})}>{b.billNumber}</td>
                              <td style={Object.assign({},TD,{color:'#64748b'})}>{toIndianDate(b.date)}</td>
                              <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:500,maxWidth:160,whiteSpace:'normal'})}>{b.vendor}</td>
                              <td style={TD}><ProjectCodes names={b.projectZoho}/></td>
                              <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:700})}>{fmt(b.total)}</td>
                              <td style={Object.assign({},TD,{color:'#64748b',fontSize:12})}>{(b.linkedPO && b.linkedPO.number) || (b.noPOExpected?'None expected':String.fromCharCode(8212))}</td>
                              <td style={TD}><CompBadge s={b.complianceStatus}/></td>
                              <td style={TD}><AlignBadge s={b.alignmentStatus}/></td>
                              <td style={TD}><RecBadge d={b.recommendation && b.recommendation.decision}/></td>
                              <td style={TD}><button onClick={function(e){e.stopPropagation();setSelected({item:b,type:'bill'});}} style={{background:'#f5f3ff',color:'#7c3aed',border:'1px solid #ddd6fe',borderRadius:6,padding:'3px 9px',cursor:'pointer',fontSize:11,fontWeight:600}}>View Details</button></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {!bills.length && !loading.bills && <div style={{textAlign:'center',padding:'48px',color:'#94a3b8',fontSize:14}}>No Bills pending approval</div>}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab==='pmos' && (
            <div className="fade">
              <ErrorBanner message={errors.pmos} onRetry={fetchPMOs}/>
              {loading.pmos ? <Spinner label="Loading Payment Memos from Zoho... (first load can take about 1 minute)"/> : (
                pmos.length===0 ? (
                  !errors.pmos && <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',padding:'48px',textAlign:'center'}}>
                    <div style={{fontSize:15,fontWeight:600,color:'#64748b'}}>No Payment Memos pending approval</div>
                  </div>
                ) : (
                  <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                    <div style={{overflowX:'auto'}}>
                      <table style={{width:'100%',borderCollapse:'collapse'}}>
                        <thead><tr>
                          {['PMO Number','Date','Vendor/Payee','Amount','Payment Type','Project','Compliance','Alignment','Recommendation',''].map(function(h){ return <th key={h} style={TH}>{h}</th>; })}
                        </tr></thead>
                        <tbody>
                          {sortByDate(pmos,'date').map(function(p){
                            return (
                              <tr key={p.id} style={{background:p.complianceStatus!=='pass'?'#fefce8':'#fff',borderBottom:'1px solid #f1f5f9'}} onClick={function(){setSelected({item:p,type:'pmo'});}}>
                                <td style={Object.assign({},TD,{color:'#0369a1',fontWeight:700})}>{p.pmoNumber}</td>
                                <td style={Object.assign({},TD,{color:'#64748b'})}>{toIndianDate(p.date)}</td>
                                <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:500,maxWidth:160,whiteSpace:'normal'})}>{p.vendor}</td>
                                <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:700})}>{fmt(p.amount)}</td>
                                <td style={Object.assign({},TD,{color:'#475569',fontSize:12})}>{p.payTypeLabel||String.fromCharCode(8212)}</td>
                                <td style={Object.assign({},TD,{color:'#475569',fontSize:12})}>{p.project||String.fromCharCode(8212)}</td>
                                <td style={TD}><CompBadge s={p.complianceStatus}/></td>
                                <td style={TD}><AlignBadge s={p.alignmentStatus||'na'}/></td>
                                <td style={TD}><RecBadge d={p.recommendation && p.recommendation.decision}/></td>
                                <td style={TD}><button onClick={function(e){e.stopPropagation();setSelected({item:p,type:'pmo'});}} style={{background:'#f0f9ff',color:'#0369a1',border:'1px solid #bae6fd',borderRadius:6,padding:'3px 9px',cursor:'pointer',fontSize:11,fontWeight:600}}>View Details</button></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              )}
            </div>
          )}

          {tab==='pfbs' && (
            <div className="fade">
              <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:14,flexWrap:'wrap'}}>
                <span style={{fontSize:11,color:'#94a3b8',fontWeight:700,letterSpacing:'0.06em'}}>RATE/Wp LEGEND</span>
                {[['< Rs.25', '#4ade80', '#052e16'],['Rs.25-30', '#fbbf24', '#451a03'],['Rs.30-35', '#fb923c', '#431407'],['>= Rs.35', '#f87171', '#450a0a']].map(function(item){
                  return (
                    <span key={item[0]} style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'#475569'}}>
                      <span style={{width:10,height:10,borderRadius:3,background:item[1],border:'1px solid ' + item[2] + '55',display:'inline-block'}}/>
                      {item[0]}
                    </span>
                  );
                })}
              </div>
              {loading.projects ? <Spinner/> : (
                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(250px,1fr))',gap:11}}>
                  {projects.map(function(p){
                    const rc = rateColor(p.ratePerWp);
                    return (
                      <div key={p.id} onClick={function(){startPFB(p);}}
                        style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:'15px 16px',cursor:'pointer',transition:'all 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.04)'}}
                        onMouseEnter={function(e){e.currentTarget.style.borderColor='#1d4ed8';e.currentTarget.style.boxShadow='0 4px 12px rgba(29,78,216,0.1)';}}
                        onMouseLeave={function(e){e.currentTarget.style.borderColor='#e2e8f0';e.currentTarget.style.boxShadow='0 1px 3px rgba(0,0,0,0.04)';}}>
                        <div style={{fontWeight:700,color:'#0f172a',fontSize:14,marginBottom:3}}>{p.name}</div>
                        <div style={{fontSize:11,color:'#94a3b8',marginBottom:9}}>{p.agreementDate||'No date'} - {p.park}</div>
                        {p.pfbReady ? (
                          <div>
                            <div style={{color:'#1d4ed8',fontWeight:800,fontSize:16}}>{fmt(p.pfbTotal)}</div>
                            <div style={{display:'inline-block',marginTop:4,background:rc.bg,color:rc.c,fontSize:11,fontWeight:700,padding:'2px 8px',borderRadius:5}}>
                              {'\u20b9' + (p.ratePerWp?p.ratePerWp.toFixed(2):'') + '/Wp'}
                            </div>
                          </div>
                        ) : (
                          <div style={{color:'#d97706',fontSize:12,fontWeight:600}}>Click to set variables</div>
                        )}
                        <div style={{marginTop:9,display:'flex',gap:5,flexWrap:'wrap'}}>
                          {p.dc && <span style={{background:'#eff6ff',color:'#1d4ed8',fontSize:10,fontWeight:600,padding:'2px 6px',borderRadius:4}}>{p.dc + ' MWp'}</span>}
                          {p.ac && <span style={{background:'#f0fdf4',color:'#15803d',fontSize:10,fontWeight:600,padding:'2px 6px',borderRadius:4}}>{p.ac + ' MW'}</span>}
                          {p.bess>0 && <span style={{background:'#fef9c3',color:'#a16207',fontSize:10,fontWeight:600,padding:'2px 6px',borderRadius:4}}>{p.bess + ' MWh BESS'}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab==='projects' && (
            <div className="fade">
              {loading.projects ? <Spinner/> : (
                <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                  {firms.map(function(firm,fi){
                    return (
                      <div key={fi}>
                        <div onClick={function(){setExpanded(function(e){ return Object.assign({},e,{[fi]: e[fi]===false ? true : false}); });}}
                          style={{display:'flex',alignItems:'center',padding:'11px 16px',borderBottom:'1px solid #f1f5f9',background:'#f8fafc',cursor:'pointer'}}
                          onMouseEnter={function(e){e.currentTarget.style.background='#f0f9ff';}} onMouseLeave={function(e){e.currentTarget.style.background='#f8fafc';}}>
                          <span style={{marginRight:9,fontSize:11,color:'#94a3b8',transition:'transform 0.15s',display:'inline-block',transform:expandedFirms[fi]!==false?'rotate(90deg)':'none'}}>{'>'}</span>
                          <span style={{fontWeight:800,color:'#0f172a',fontSize:14,flex:1}}>{firm.firmName}</span>
                          <span style={{fontSize:12,color:'#64748b',marginRight:18}}>{firm.projects.length + ' project' + (firm.projects.length!==1?'s':'')}</span>
                          <span style={{fontSize:12,color:'#1d4ed8',fontWeight:700}}>
                            {firm.projects.reduce(function(s,p){return s+(p.dc||0);},0).toFixed(2) + ' MWp'}
                          </span>
                        </div>
                        {expandedFirms[fi]!==false && firm.projects.map(function(p,pi){
                          return (
                            <div key={pi} onClick={function(){setProjDetail(p);}}
                              style={{display:'grid',gridTemplateColumns:'30px 1.8fr 100px 80px 70px 70px 70px 110px 90px',alignItems:'center',padding:'9px 16px',paddingLeft:38,borderBottom:'1px solid #f8fafc',cursor:'pointer',background:'#fff'}}
                              onMouseEnter={function(e){e.currentTarget.style.background='#f8fafc';}} onMouseLeave={function(e){e.currentTarget.style.background='#fff';}}>
                              <span style={{fontSize:10,color:'#cbd5e1'}}>{'-'}</span>
                              <span style={{fontSize:13,color:'#334155',fontWeight:500}}>{p.name}</span>
                              <span style={{fontSize:11,color:'#64748b'}}>{p.park}</span>
                              <span style={{fontSize:12,color:'#1d4ed8',fontWeight:600}}>{p.dc?(p.dc + ' MWp'):String.fromCharCode(8212)}</span>
                              <span style={{fontSize:12,color:'#15803d',fontWeight:600}}>{p.ac?(p.ac + ' MW'):String.fromCharCode(8212)}</span>
                              <span style={{fontSize:11,color:'#a16207'}}>{p.bess?(p.bess + ' MWh'):String.fromCharCode(8212)}</span>
                              <span style={{fontSize:11,color:'#64748b'}}>{p.sw?(p.sw + ' SY'):String.fromCharCode(8212)}</span>
                              <span style={{fontSize:12,color:'#0f172a',fontWeight:700}}>{p.pfbTotal?fmt(p.pfbTotal):String.fromCharCode(8212)}</span>
                              <span style={{fontSize:11,color:'#64748b'}}>{p.agreementDate||String.fromCharCode(8212)}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                  {!firms.length && <div style={{textAlign:'center',padding:'48px',color:'#94a3b8'}}>No projects</div>}
                </div>
              )}
            </div>
          )}

          {tab==='parks' && (
            <div className="fade">
              {loading.projects ? <Spinner/> : (
                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12}}>
                  {parks.map(function(pk){
                    return (
                      <div key={pk.name} onClick={function(){setParkDetail(pk);}}
                        style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:'16px 18px',cursor:'pointer',boxShadow:'0 1px 3px rgba(0,0,0,0.04)'}}
                        onMouseEnter={function(e){e.currentTarget.style.borderColor='#10b981';e.currentTarget.style.boxShadow='0 4px 12px rgba(16,185,129,0.1)';}}
                        onMouseLeave={function(e){e.currentTarget.style.borderColor='#e2e8f0';e.currentTarget.style.boxShadow='0 1px 3px rgba(0,0,0,0.04)';}}>
                        <div style={{fontWeight:800,color:'#0f172a',fontSize:15,marginBottom:4}}>{'\u{1F31E} ' + pk.name}</div>
                        <div style={{fontSize:12,color:'#64748b',marginBottom:12}}>{pk.district + ', ' + pk.state + ' - ' + pk.count + ' project' + (pk.count!==1?'s':'')}</div>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                          {[['Total DC', pk.totalDC.toFixed(2) + ' MWp'],['Total Value', fmtCr(pk.totalValue)]].map(function(pair){
                            const k = pair[0], v = pair[1];
                            return (
                              <div key={k} style={{background:'#f8fafc',borderRadius:7,padding:'8px 10px'}}>
                                <div style={{fontSize:9,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em'}}>{k}</div>
                                <div style={{fontSize:14,fontWeight:800,color:'#0f172a',marginTop:2}}>{v}</div>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
                          {pk.projects.slice(0,4).map(function(p){
                            return <span key={p.id} style={{background:'#f0fdf4',color:'#15803d',fontSize:10,fontWeight:600,padding:'2px 7px',borderRadius:4,border:'1px solid #bbf7d0'}}>{p.name.split(' ')[0]}</span>;
                          })}
                          {pk.projects.length>4 && <span style={{fontSize:10,color:'#94a3b8'}}>{'+' + (pk.projects.length-4) + ' more'}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {selected && <DetailModal item={selected.item} type={selected.type} onClose={function(){setSelected(null);}}/>}
      {projDetail && <ProjectDetailModal proj={projDetail} parkNames={parkNames} onClose={function(){setProjDetail(null);}} onProjUpdated={fetchProjects}/>}
      {parkDetail && <ParkModal park={parkDetail} onClose={function(){setParkDetail(null);}} onProjectClick={function(p){setProjDetail(p);}} onParkUpdated={fetchProjects}/>}
      {pfbFlow && pfbFlow.step==='confirm' && <PFBVarConfirm proj={pfbFlow.proj} onClose={function(){setPFBFlow(null);}} onYes={onPFBYes} onNo={onPFBNo}/>}
      {pfbFlow && pfbFlow.step==='edit' && <PFBVarEdit proj={pfbFlow.proj} onClose={function(){setPFBFlow(null);}} onSave={onPFBSave}/>}
      {pfbFlow && pfbFlow.step==='show' && pfbFlow.pfbData && <PFBDisplay proj={pfbFlow.proj} data={pfbFlow.pfbData} onClose={function(){setPFBFlow(null);}}/>}
      {showSearch && <SearchBox type={showSearch} onClose={function(){setSearch(null);}} onSelect={function(){setSearch(null);}}/>}
      {showAddProj && <AddProjectModal onClose={function(){setShowAddProj(false);}} onSaved={fetchProjects} parkNames={parkNames}/>}
      {showAddPark && <AddParkModal onClose={function(){setShowAddPark(false);}} onSaved={fetchProjects}/>}
      {showUpdateRates && <UpdateRatesModal onClose={function(){setShowUpdateRates(false);}} onDone={fetchProjects}/>}
    </>
  );
}

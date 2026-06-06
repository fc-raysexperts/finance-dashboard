// pages/index.js — Finance Control Dashboard v4
// All 8 changes: PMO fix, districts, expanded firms, rate colours,
// 6-variable PFB confirm, correct item numbering, 8 summary cards,
// item table cleanup, project codes shown, sorted dates

import { useState, useEffect, useCallback, useRef } from 'react';
import Head from 'next/head';

// ─── UTILS ────────────────────────────────────────────────────
const fmtINR = n => n==null ? '—' : '₹'+Number(n).toLocaleString('en-IN',{maximumFractionDigits:0});
const fmtN   = n => n==null ? '—' : Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});
const fmtP   = n => n==null ? '—' : (n>0?'+':'')+Number(n).toFixed(1)+'%';
const fmtCr  = n => n==null ? '—' : '₹'+Number(n).toFixed(2)+' Cr';

function toIndianDate(d) {
  if (!d) return '—';
  if (/^\d{2}-\d{2}-\d{4}$/.test(d)) return d;
  try { const dt=new Date(d); if(isNaN(dt)) return d; return `${String(dt.getDate()).padStart(2,'0')}-${String(dt.getMonth()+1).padStart(2,'0')}-${dt.getFullYear()}`; }
  catch { return d; }
}

// Rate colour for PFB: <25 green, [25,30) dark yellow, [30,35) orange, >=35 red
function rateColor(ratePerWp) {
  if (ratePerWp == null) return '#64748b';
  if (ratePerWp < 25)   return '#22c55e';   // bright green
  if (ratePerWp < 30)   return '#eab308';   // bright yellow
  if (ratePerWp < 35)   return '#f97316';   // bright orange
  return '#ef4444';                          // bright red
}

// Compress item name to max 5 words
function compressName(name, maxWords=5) {
  if (!name) return '—';
  const words = name.trim().split(/\s+/);
  if (words.length <= maxWords) return name;
  return words.slice(0, maxWords).join(' ') + '…';
}

// Extract project code from Zoho project name
function extractCode(name) {
  if (!name) return '';
  const m = name.match(/LE\d{4}/i);
  return m ? m[0] : (name.split('_')[0] || name.substring(0,8));
}

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem('pfb_overrides')||'{}'); } catch { return {}; }
}
function saveOverride(id, dc, ac, sw, piling, wall, road) {
  const ov = loadOverrides();
  ov[id] = { dc:parseFloat(dc), ac:parseFloat(ac), sw:parseInt(sw), piling:parseInt(piling||2000), wall:parseInt(wall||2000), road:parseInt(road||2000) };
  localStorage.setItem('pfb_overrides', JSON.stringify(ov));
}

// ─── BADGES ───────────────────────────────────────────────────
function CompBadge({s}) {
  const m={pass:{bg:'#dcfce7',c:'#15803d',t:'✓ COMPLIANT'},warn:{bg:'#fef9c3',c:'#a16207',t:'⚠ WARNINGS'},fail:{bg:'#fee2e2',c:'#b91c1c',t:'✗ FAILED'}};
  const v=m[s]||{bg:'#f1f5f9',c:'#64748b',t:'—'};
  return <span style={{background:v.bg,color:v.c,padding:'2px 8px',borderRadius:4,fontSize:11,fontWeight:700,border:`1px solid ${v.c}33`,whiteSpace:'nowrap'}}>{v.t}</span>;
}
function AlignBadge({s}) {
  const m={aligned:{bg:'#dbeafe',c:'#1d4ed8',t:'✓ ALIGNED'},flag:{bg:'#fef3c7',c:'#d97706',t:'⚠ VARIANCE'},reject:{bg:'#fee2e2',c:'#b91c1c',t:'✗ OVER BUDGET'},na:{bg:'#f8fafc',c:'#94a3b8',t:'— N/A'},mismatch:{bg:'#fee2e2',c:'#b91c1c',t:'✗ MISMATCH'}};
  const v=m[s]||m.na;
  return <span style={{background:v.bg,color:v.c,padding:'2px 8px',borderRadius:4,fontSize:11,fontWeight:700,border:`1px solid ${v.c}33`,whiteSpace:'nowrap'}}>{v.t}</span>;
}
function RecBadge({d}) {
  const m={'APPROVE':{bg:'#dcfce7',c:'#15803d'},'APPROVE (No PFB Scope)':{bg:'#dbeafe',c:'#1d4ed8'},'FLAG FOR REVIEW':{bg:'#fef9c3',c:'#a16207'},'REJECT':{bg:'#fee2e2',c:'#b91c1c'}};
  const v=m[d]||{bg:'#f1f5f9',c:'#64748b'};
  return <span style={{background:v.bg,color:v.c,padding:'3px 10px',borderRadius:4,fontSize:11,fontWeight:700,border:`1px solid ${v.c}33`}}>{d||'—'}</span>;
}

// ─── SPINNER ──────────────────────────────────────────────────
function Spinner({label}) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:10,color:'#64748b',padding:'48px 0',justifyContent:'center'}}>
      <svg width="18" height="18" viewBox="0 0 24 24" style={{animation:'spin 1s linear infinite'}}>
        <circle cx="12" cy="12" r="10" stroke="#e2e8f0" strokeWidth="3" fill="none"/>
        <path d="M12 2a10 10 0 0 1 10 10" stroke="#2563eb" strokeWidth="3" strokeLinecap="round" fill="none"/>
      </svg>
      {label||'Loading…'}
    </div>
  );
}

// ─── MODAL ────────────────────────────────────────────────────
function Modal({onClose,title,subtitle,width,children}) {
  useEffect(()=>{const h=e=>{if(e.key==='Escape')onClose();};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h);},[onClose]);
  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{position:'fixed',inset:0,background:'rgba(15,23,42,0.6)',zIndex:1000,display:'flex',alignItems:'flex-start',justifyContent:'center',padding:'24px 16px',overflowY:'auto',backdropFilter:'blur(2px)'}}>
      <div style={{background:'#fff',borderRadius:16,width:'100%',maxWidth:width||920,padding:28,position:'relative',boxShadow:'0 24px 64px rgba(0,0,0,0.18)',border:'1px solid #e2e8f0'}}>
        <button onClick={onClose} style={{position:'absolute',top:14,right:14,background:'#f1f5f9',border:'none',borderRadius:8,width:32,height:32,cursor:'pointer',fontSize:18,color:'#64748b'}}>×</button>
        <div style={{marginBottom:18,paddingRight:40}}>
          <div style={{fontSize:20,fontWeight:800,color:'#0f172a',letterSpacing:'-0.02em'}}>{title}</div>
          {subtitle&&<div style={{fontSize:13,color:'#64748b',marginTop:3}}>{subtitle}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── INFO GRID ────────────────────────────────────────────────
function InfoGrid({fields,cols}) {
  return (
    <div style={{display:'grid',gridTemplateColumns:`repeat(${cols||3},minmax(0,1fr))`,gap:'10px 20px',background:'#f8fafc',borderRadius:10,padding:'14px 18px',marginBottom:16}}>
      {fields.map(([k,v])=>(
        <div key={k}>
          <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em',marginBottom:2}}>{k.toUpperCase()}</div>
          <div style={{fontSize:13,color:'#0f172a',fontWeight:500,wordBreak:'break-word'}}>{v??'—'}</div>
        </div>
      ))}
    </div>
  );
}

// ─── REC BOX ──────────────────────────────────────────────────
function RecBox({rec}) {
  if(!rec) return null;
  const cc={green:'#15803d',amber:'#d97706',red:'#b91c1c',blue:'#1d4ed8'};
  const bg={green:'#f0fdf4',amber:'#fefce8',red:'#fff1f2',blue:'#eff6ff'};
  const c=cc[rec.color]||'#475569',b=bg[rec.color]||'#f8fafc';
  return (
    <div style={{background:b,border:`1.5px solid ${c}33`,borderRadius:10,padding:'12px 16px',marginBottom:16}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
        <span style={{fontSize:18}}>{rec.decision==='APPROVE'||rec.decision?.includes('No PFB')?'✅':rec.decision==='REJECT'?'🚫':'⚠️'}</span>
        <span style={{fontWeight:800,color:c,fontSize:14}}>RECOMMENDATION: {rec.decision}</span>
      </div>
      {rec.reasons?.map((r,i)=><div key={i} style={{display:'flex',gap:6,color:'#475569',fontSize:12,marginBottom:2}}><span style={{color:c}}>›</span>{r}</div>)}
    </div>
  );
}

// ─── COMPLIANCE TABLE ─────────────────────────────────────────
function CompTable({checks,title}) {
  if(!checks?.length) return null;
  const pass=checks.filter(c=>c.passed).length;
  return (
    <div style={{marginBottom:20}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',margin:0}}>{title}</h3>
        <span style={{fontSize:11,color:'#64748b'}}>{pass}/{checks.length} passed</span>
      </div>
      <div style={{border:'1px solid #e2e8f0',borderRadius:8,overflow:'hidden'}}>
        {checks.map((c,i)=>(
          <div key={i} style={{display:'flex',alignItems:'flex-start',gap:8,padding:'8px 12px',background:i%2?'#f8fafc':'#fff',borderBottom:i<checks.length-1?'1px solid #f1f5f9':'none'}}>
            <span style={{fontSize:13,marginTop:1,flexShrink:0}}>{c.passed?'✅':'❌'}</span>
            <div style={{flex:1}}>
              <span style={{fontWeight:600,color:'#334155',fontSize:12}}>{c.name}: </span>
              <span style={{color:c.passed?'#64748b':'#dc2626',fontSize:12}}>{c.comment}</span>
            </div>
            {c.value&&<span style={{fontSize:11,color:'#94a3b8',flexShrink:0,maxWidth:160,textAlign:'right'}}>{c.value}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── LINE TABLE ───────────────────────────────────────────────
function LineTable({checks,title}) {
  if(!checks?.length) return null;
  const hasData=checks.some(c=>c.pfbMatch||c.poRate||c.rateVariance!=null);
  return (
    <div style={{marginBottom:20}}>
      <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>{title}</h3>
      {!hasData?(
        <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'12px 16px',fontSize:12,color:'#64748b'}}>
          {checks[0]?.comment||'Items outside PFB scope — services, freight, approvals etc. No variance applicable.'}
        </div>
      ):(
        <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr style={{background:'#f8fafc'}}>
              {['Item','Qty','Rate','Amount','Match','Ref Rate','Variance','Status'].map(h=>(
                <th key={h} style={{padding:'7px 10px',textAlign:'left',color:'#475569',fontWeight:700,fontSize:11,borderBottom:'1px solid #e2e8f0',whiteSpace:'nowrap'}}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {checks.map((c,i)=>(
                <tr key={i} style={{borderBottom:'1px solid #f1f5f9',background:c.status==='reject'?'#fff1f2':c.status==='flag'?'#fefce8':'#fff'}}>
                  <td style={{padding:'7px 10px',color:'#0f172a',fontWeight:500,maxWidth:180}}>{c.lineItem}</td>
                  <td style={{padding:'7px 10px',color:'#475569'}}>{fmtN(c.qty)}</td>
                  <td style={{padding:'7px 10px',color:'#475569'}}>{fmtINR(c.rate)}</td>
                  <td style={{padding:'7px 10px',color:'#0f172a',fontWeight:600}}>{fmtINR(c.amount)}</td>
                  <td style={{padding:'7px 10px',color:'#2563eb',fontSize:11}}>{c.pfbMatch||c.poItem||'—'}</td>
                  <td style={{padding:'7px 10px',color:'#475569'}}>{fmtINR(c.pfbRate||c.poRate)}</td>
                  <td style={{padding:'7px 10px',fontWeight:700,color:c.rateVariance>10?'#dc2626':c.rateVariance<-10?'#ea580c':'#16a34a'}}>{c.rateVariance!=null?fmtP(c.rateVariance):'—'}</td>
                  <td style={{padding:'7px 10px',fontSize:11,fontWeight:600,color:c.status==='reject'?'#dc2626':c.status==='flag'?'#d97706':c.status==='na'||c.status==='no_match'?'#94a3b8':'#16a34a'}}>
                    {c.status==='na'?'N/A':c.status==='no_match'?'No Match':c.status==='reject'?'Over Budget':c.status==='flag'?'Variance':'✓ OK'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── ITEMS TABLE (clean version — name, project, HSN, qty, unit, rate, amount, tax) ──
function ItemsTable({items,title}) {
  if(!items?.length) return null;
  return (
    <div style={{marginBottom:20}}>
      <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>{title||'Line Items'}</h3>
      <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
          <thead><tr style={{background:'#f8fafc'}}>
            {['#','Item Name','Project','HSN/SAC','Qty','Unit','Rate','Amount','Tax'].map(h=>(
              <th key={h} style={{padding:'7px 10px',textAlign:'left',color:'#475569',fontWeight:700,fontSize:11,borderBottom:'1px solid #e2e8f0',whiteSpace:'nowrap'}}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {items.map((li,i)=>{
              // Extract project code from item description or project_name field
              const projCode = li.project_name
                ? extractCode(li.project_name)
                : (li.description||'').match(/LE\d{4}/i)?.[0] || '';
              return (
                <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                  <td style={{padding:'6px 10px',color:'#94a3b8',fontSize:11}}>{i+1}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',fontWeight:500,maxWidth:200}}>{compressName(li.name,5)}</td>
                  <td style={{padding:'6px 10px',color:'#2563eb',fontSize:11,fontWeight:600}}>{projCode||'—'}</td>
                  <td style={{padding:'6px 10px',color:'#64748b'}}>{li.hsn_or_sac||'—'}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',fontWeight:500}}>{fmtN(li.quantity)}</td>
                  <td style={{padding:'6px 10px',color:'#64748b'}}>{li.unit||'—'}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a'}}>{fmtINR(li.rate)}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',fontWeight:700}}>{fmtINR(li.item_total)}</td>
                  <td style={{padding:'6px 10px',color:'#64748b',fontSize:11}}>{li.tax_name||'—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── ZOHO PROJECTS ROW ────────────────────────────────────────
function ZohoProjectsRow({zohoProjectName,lineItems}) {
  // Collect all project names/codes from zohoProjectName + line items
  const projectSet = new Set();
  if (zohoProjectName) {
    (Array.isArray(zohoProjectName)?zohoProjectName:[zohoProjectName]).forEach(n=>{
      if(n) projectSet.add(n);
    });
  }
  (lineItems||[]).forEach(li=>{
    if(li.project_name) projectSet.add(li.project_name);
    const m=(li.description||'').match(/LE\d{4}/gi);
    if(m) m.forEach(c=>projectSet.add(c));
  });
  if(!projectSet.size) return null;
  const projects=[...projectSet];
  return (
    <div style={{background:'#f0f9ff',border:'1px solid #bae6fd',borderRadius:8,padding:'10px 14px',marginBottom:14}}>
      <div style={{fontSize:10,color:'#0369a1',fontWeight:700,letterSpacing:'0.08em',marginBottom:6}}>ZOHO PROJECTS ({projects.length})</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
        {projects.map((n,i)=>(
          <span key={i} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:5,padding:'3px 8px',fontSize:12,fontWeight:500}}>
            <span style={{fontWeight:700,marginRight:4}}>{extractCode(n)}</span>
            {n.includes('_')?n.split('_').slice(1).join('_'):n!==extractCode(n)?n:''}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── ATTACHMENTS ──────────────────────────────────────────────
function Attachments({docs}) {
  if(!docs?.length) return <div style={{color:'#94a3b8',fontSize:12,marginBottom:16}}>No attachments</div>;
  return (
    <div style={{marginBottom:16}}>
      <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>Attachments ({docs.length})</h3>
      <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
        {docs.map((d,i)=>{
          const name=d.file_name||d.fileName||`Document ${i+1}`;
          const url=d.download_url||d.attachment_url||null;
          return url?(
            <a key={i} href={url} target="_blank" rel="noreferrer" style={{display:'flex',alignItems:'center',gap:6,background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:6,padding:'5px 10px',fontSize:12,fontWeight:500,textDecoration:'none'}}>📎 {name}</a>
          ):(
            <span key={i} style={{display:'flex',alignItems:'center',gap:6,background:'#f8fafc',color:'#64748b',border:'1px solid #e2e8f0',borderRadius:6,padding:'5px 10px',fontSize:12}}>📎 {name}</span>
          );
        })}
      </div>
    </div>
  );
}

// ─── DETAIL MODAL ─────────────────────────────────────────────
function DetailModal({item,type,onClose}) {
  const isBill=type==='bill', isPMO=type==='pmo';
  const fields = isPMO?[
    ['PMO Number',          item.pmoNumber],
    ['PMO Date',            toIndianDate(item.date)],
    ['Vendor / Payee',      item.vendor],
    ['Payable Amount',      fmtINR(item.amount)],
    ['Payment Category',    item.paymentCategory || '—'],
    ['Expense Account',     item.expenseAccount  || '—'],
    ['Customer Name',       item.customerName    || '—'],
    ['Closing Balance',     fmtINR(item.closingBalance)],
    ['Amt vs Bill',         fmtINR(item.amtAgainstBill)],
    ['Amt vs PO',           fmtINR(item.amtAgainstPO)],
    ['Amt vs Invoice',      fmtINR(item.amtAgainstInvoice)],
    ['Amt vs Expense',      fmtINR(item.amtAgainstExpense)],
    ['Submitted By',        item.submittedBy     || '—'],
    ['Submitted Date',      toIndianDate(item.submittedDate)],
    ['Attachment',          item.attachment      || 'None'],
  ]:isBill?[
    ['Bill Number',item.billNumber],['Bill Date',toIndianDate(item.date)],['Due Date',toIndianDate(item.dueDate)],
    ['Vendor',item.vendor],['Vendor GSTIN',item.gstin||'—'],
    ['Project (PFB)',item.projectMatched||'Not matched'],
    ['Total Amount',fmtINR(item.total)],['Balance Due',fmtINR(item.balance)],
    ['Linked PO',item.linkedPO?.number||'None'],['PO Amount',item.linkedPO?fmtINR(item.linkedPO.total):'—'],
    ['Submitted By',item.submittedBy||'—'],['Submitted Date',toIndianDate(item.submittedDate)],
  ]:[
    ['PO Number',item.poNumber],['PO Date',toIndianDate(item.date)],
    ['Vendor',item.vendor],['Vendor GSTIN',item.gstin||'—'],
    ['Project (PFB)',item.projectMatched||'Not matched'],
    ['Total Amount',fmtINR(item.total)],['PFB Budget',fmtINR(item.pfbTotal)],
    ['Payment Terms',item.paymentTerms||'—'],['Delivery Date',toIndianDate(item.deliveryDate)],
    ['Submitted By',item.submittedBy||'—'],['Submitted Date',toIndianDate(item.submittedDate)],
  ];
  return (
    <Modal onClose={onClose} width={980}
      title={isPMO?`PMO ${item.pmoNumber}`:isBill?`Bill ${item.billNumber}`:`PO ${item.poNumber}`}
      subtitle={item.vendor}>
      <InfoGrid fields={fields} cols={3}/>
      <ZohoProjectsRow zohoProjectName={item.projectZoho} lineItems={item.lineItems||item.line_items}/>
      <RecBox rec={item.recommendation}/>
      <ItemsTable items={item.lineItems||item.line_items} title="Line Items"/>
      <CompTable checks={item.compliance} title={`${isPMO?'PMO':isBill?'Bill':'PO'} Compliance Checks`}/>
      {!isPMO&&<LineTable checks={item.lineChecks} title="PFB Alignment — Line by Line"/>}
      {isBill&&item.poLineChecks?.length>0&&<LineTable checks={item.poLineChecks} title="PO Match — Line by Line"/>}
      {isPMO&&item.alignment?.checks?.length>0&&<CompTable checks={item.alignment.checks} title="PI / Bill Alignment"/>}
      <Attachments docs={item.attachments||item.docs||item.documents}/>
    </Modal>
  );
}

// ─── PFB 6-VARIABLE CONFIRM ───────────────────────────────────
function PFBVarConfirm({proj,onYes,onNo,onClose}) {
  const ready=proj.dc&&proj.ac&&proj.sw;
  const vars=[
    {label:'DC Capacity (MWp)',val:proj.dc},
    {label:'AC Capacity (MW)', val:proj.ac},
    {label:'Switchyards (Nos.)',val:proj.sw},
    {label:'Piling (Nos.)',    val:proj.piling||2000},
    {label:'Boundary Wall (m)',val:proj.wall||2000},
    {label:'Road (m)',         val:proj.road||2000},
  ];
  return (
    <Modal onClose={onClose} title={`Confirm Variables — ${proj.name}`} width={500}>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:12,fontWeight:700,color:'#1d4ed8',marginBottom:6}}>TECHNICAL DETAILS</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:14}}>
          {vars.slice(0,3).map(({label,val})=>(
            <div key={label} style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px',textAlign:'center'}}>
              <div style={{fontSize:9,color:'#94a3b8',fontWeight:700,marginBottom:3}}>{label.toUpperCase()}</div>
              <div style={{fontSize:20,fontWeight:800,color:val?'#0f172a':'#dc2626'}}>{val??'?'}</div>
            </div>
          ))}
        </div>
        <div style={{fontSize:12,fontWeight:700,color:'#7c3aed',marginBottom:6}}>PROJECT EXECUTION DETAILS</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:16}}>
          {vars.slice(3).map(({label,val})=>(
            <div key={label} style={{background:'#faf5ff',border:'1px solid #e9d5ff',borderRadius:8,padding:'10px',textAlign:'center'}}>
              <div style={{fontSize:9,color:'#94a3b8',fontWeight:700,marginBottom:3}}>{label.toUpperCase()}</div>
              <div style={{fontSize:20,fontWeight:800,color:'#7c3aed'}}>{val}</div>
            </div>
          ))}
        </div>
      </div>
      {!ready&&<div style={{background:'#fef9c3',border:'1px solid #fde68a',borderRadius:8,padding:'10px',fontSize:12,color:'#92400e',marginBottom:14}}>⚠ Technical variables missing — please enter values.</div>}
      <div style={{display:'flex',gap:10}}>
        {ready&&<button onClick={onYes} style={{flex:1,background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'10px',cursor:'pointer',fontWeight:700,fontSize:14}}>YES — Generate PFB</button>}
        <button onClick={onNo} style={{flex:1,background:'#f1f5f9',color:'#334155',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px',cursor:'pointer',fontWeight:600,fontSize:14}}>{ready?'NO — Edit Values':'Enter Values'}</button>
      </div>
    </Modal>
  );
}

// ─── PFB 6-VARIABLE EDIT ──────────────────────────────────────
function PFBVarEdit({proj,onSave,onClose}) {
  const [dc, setDC]=useState(proj.dc||'');
  const [ac, setAC]=useState(proj.ac||'');
  const [sw, setSW]=useState(proj.sw||'');
  const [piling,setPiling]=useState(proj.piling||2000);
  const [wall,  setWall  ]=useState(proj.wall  ||2000);
  const [road,  setRoad  ]=useState(proj.road  ||2000);

  const inp=(lbl,v,set,ph,color='#1d4ed8')=>(
    <div>
      <label style={{fontSize:11,color:'#64748b',fontWeight:700,display:'block',marginBottom:4}}>{lbl}</label>
      <input value={v} onChange={e=>set(e.target.value)} placeholder={ph}
        style={{width:'100%',border:`1.5px solid ${color}33`,borderRadius:8,padding:'9px 12px',fontSize:14,outline:'none',boxSizing:'border-box'}}
        onFocus={e=>e.target.style.borderColor=color} onBlur={e=>e.target.style.borderColor=`${color}33`}/>
    </div>
  );

  return (
    <Modal onClose={onClose} title={`Set Variables — ${proj.name}`} width={500}>
      {proj.dc&&<div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'8px 12px',marginBottom:12,fontSize:12,color:'#64748b'}}>Current: DC={proj.dc} | AC={proj.ac} | SW={proj.sw} | Piling={proj.piling||2000} | Wall={proj.wall||2000} | Road={proj.road||2000}</div>}
      <div style={{fontSize:12,fontWeight:700,color:'#1d4ed8',marginBottom:8}}>TECHNICAL DETAILS</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:14}}>
        {inp('DC Capacity (MWp)',dc,setDC,'e.g. 8.5')}
        {inp('AC Capacity (MW)', ac,setAC,'e.g. 5.7')}
        {inp('No. of Switchyards',sw,setSW,'e.g. 1')}
      </div>
      <div style={{fontSize:12,fontWeight:700,color:'#7c3aed',marginBottom:8}}>PROJECT EXECUTION (P-W-R)</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:16}}>
        {inp('Piling (Nos.)',      piling,setPiling,'e.g. 2000','#7c3aed')}
        {inp('Boundary Wall (m)', wall,  setWall,  'e.g. 2000','#7c3aed')}
        {inp('Road (m)',           road,  setRoad,  'e.g. 2000','#7c3aed')}
      </div>
      <button onClick={()=>{if(!dc||!ac||!sw){alert('Fill all technical fields');return;}saveOverride(proj.id,dc,ac,sw,piling,wall,road);onSave(parseFloat(dc),parseFloat(ac),parseInt(sw),parseInt(piling||2000),parseInt(wall||2000),parseInt(road||2000));}}
        style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:15}}>
        SAVE & Generate PFB
      </button>
    </Modal>
  );
}

// ─── PFB DISPLAY ──────────────────────────────────────────────
function PFBDisplay({proj,data,onClose}) {
  const secs={A:'Project Material Expenses',B:'Project Execution',C:'Other Project Expenses'};
  const total=data?.grandTotal||0;
  const rpw=data?.ratePerWp;
  const download=()=>{
    const rows=[['Scope No','Section','Scope Name','PFB Head','Side','Particular','Unit','Qty','Rate','Amount'],
      ...(data.items||[]).map((item,i)=>[i+1,item.section,item.scopeName,item.pfbHead,item.side,item.particular,item.unit,item.qty,item.rate,item.amount])];
    const csv=rows.map(r=>r.map(c=>`"${c??''}"`).join(',')).join('\n');
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download=`PFB_${proj.name.replace(/\s+/g,'_')}.csv`; a.click();
  };
  return (
    <Modal onClose={onClose} width={1140}
      title={`PFB — ${proj.name}`}
      subtitle={`DC: ${proj.dc} MWp | AC: ${proj.ac} MW | Switchyards: ${proj.sw} | ${proj.quarter||''}`}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:16,flexWrap:'wrap',gap:8}}>
        <div>
          <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,marginBottom:2}}>TOTAL BUDGET AMOUNT</div>
          <div style={{fontSize:26,fontWeight:900,color:'#0f172a'}}>{fmtINR(total)}</div>
          <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,marginTop:10,marginBottom:2}}>RATE OF PROJECT</div>
          <div style={{fontSize:18,fontWeight:800,color:rateColor(rpw)}}>₹{rpw?.toFixed(2)}/Wp</div>
        </div>
        <button onClick={download} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:8,padding:'8px 16px',cursor:'pointer',fontSize:12,fontWeight:700}}>⬇ Download CSV</button>
      </div>
      {['A','B','C'].map(sec=>{
        const items=(data.items||[]).filter(i=>i.section===sec);
        // Renumber items sequentially across all sections
        const secStart = sec==='A'?0:sec==='B'?(data.items||[]).filter(i=>i.section==='A').length:(data.items||[]).filter(i=>i.section!=='C').length;
        return (
          <div key={sec} style={{marginBottom:18}}>
            <div style={{fontWeight:700,color:'#1d4ed8',fontSize:11,letterSpacing:'0.06em',padding:'5px 10px',background:'#eff6ff',borderRadius:6,marginBottom:5}}>
              SECTION {sec} — {secs[sec]}
            </div>
            <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:11.5}}>
                <thead><tr style={{background:'#f8fafc'}}>
                  {['#','Scope','PFB Head','Particular','Side','Unit','Qty','Rate','Amount'].map(h=>(
                    <th key={h} style={{padding:'6px 9px',textAlign:'left',color:'#475569',fontWeight:700,fontSize:11,borderBottom:'1px solid #e2e8f0',whiteSpace:'nowrap'}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {items.map((item,i)=>(
                    <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                      <td style={{padding:'5px 9px',color:'#94a3b8',fontSize:10}}>{secStart+i+1}</td>
                      <td style={{padding:'5px 9px',color:'#2563eb',fontSize:11,whiteSpace:'nowrap'}}>{item.scopeName}</td>
                      <td style={{padding:'5px 9px',color:'#7c3aed',fontSize:11,whiteSpace:'nowrap'}}>{item.pfbHead}</td>
                      <td style={{padding:'5px 9px',color:'#475569',maxWidth:200}}>{item.particular}</td>
                      <td style={{padding:'5px 9px',color:'#64748b',fontSize:10}}>{item.side}</td>
                      <td style={{padding:'5px 9px',color:'#64748b'}}>{item.unit}</td>
                      <td style={{padding:'5px 9px',color:'#0f172a',textAlign:'right',fontWeight:500}}>{fmtN(item.qty)}</td>
                      <td style={{padding:'5px 9px',color:'#0f172a',textAlign:'right'}}>{fmtINR(item.rate)}</td>
                      <td style={{padding:'5px 9px',color:'#0f172a',textAlign:'right',fontWeight:700}}>{fmtINR(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </Modal>
  );
}

// ─── PROJECT FINANCIALS (fetches live totals from Zoho) ───────
function ProjectFinancials({ proj }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!proj.zohoNames?.length) { setLoading(false); return; }
    fetch(`/api/project-financials?zohoNames=${encodeURIComponent(JSON.stringify(proj.zohoNames))}`)
      .then(r => r.json())
      .then(d => { if (d.success) setData(d.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [proj.id]);

  const fmtINR = n => n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  return (
    <div style={{ background: '#fafafa', border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px 16px', marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', letterSpacing: '0.08em', marginBottom: 10 }}>PROJECT DETAILS — TOTAL AMOUNTS</div>
      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 12 }}>Loading live data from Zoho Books…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {[
            ['PFB (Budget)',    proj.pfbTotal,      '#1d4ed8'],
            ['Purchase Orders', data?.poTotal,      '#f59e0b'],
            ['Bills',           data?.billTotal,    '#8b5cf6'],
            ['Invoices (SO)',    data?.invoiceTotal, '#10b981'],
            ['Sales Orders',    data?.soTotal,      '#0ea5e9'],
            ['Credit Notes',    data?.cnTotal,      '#ef4444'],
          ].map(([label, val, color]) => (
            <div key={label} style={{ background: '#fff', border: `1px solid ${color}22`, borderLeft: `3px solid ${color}`, borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>{label.toUpperCase()}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a' }}>{fmtINR(val)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── PROJECT DETAIL MODAL ─────────────────────────────────────
function ProjectDetailModal({proj,onClose,onEdit}) {
  return (
    <Modal onClose={onClose} width={900} title={proj.name} subtitle={`${proj.district} District, ${proj.park} Solar Park · ${proj.quarter||'—'}`}>
      <button onClick={onEdit} style={{position:'absolute',top:14,right:56,background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:7,padding:'5px 12px',cursor:'pointer',fontSize:12,fontWeight:600}}>✏ Edit</button>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
        <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:10,padding:'14px 16px'}}>
          <div style={{fontSize:11,fontWeight:700,color:'#1d4ed8',letterSpacing:'0.08em',marginBottom:10}}>TECHNICAL DETAILS</div>
          {[['DC Capacity',proj.dc!=null?`${proj.dc} MWp`:'—'],['AC Capacity',proj.ac!=null?`${proj.ac} MW`:'—'],['Switchyards',proj.sw!=null?`${proj.sw}`:'—'],['BESS Capacity',proj.bess?`${proj.bess} MWh`:'None'],['Solar Park',proj.park||'—'],['District',proj.district||'—'],['State','Rajasthan']].map(([k,v])=>(
            <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:'1px solid #f1f5f9',fontSize:13}}>
              <span style={{color:'#64748b'}}>{k}</span><span style={{color:'#0f172a',fontWeight:600}}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:10,padding:'14px 16px'}}>
          <div style={{fontSize:11,fontWeight:700,color:'#15803d',letterSpacing:'0.08em',marginBottom:10}}>FINANCIAL DETAILS</div>
          {[['Total Project Value',fmtCr(proj.totalValue)],['EPC Cost / MWp',proj.epcCost?`₹${proj.epcCost} Cr/MWp`:'—'],['PFB Total',proj.pfbTotal?fmtINR(proj.pfbTotal):'Not generated'],['Rate / Wp',proj.ratePerWp?`₹${proj.ratePerWp?.toFixed(2)}/Wp`:'—'],['Agreement Date',proj.agreementDate||'—'],['End Date',proj.endDate||'—'],['Revenue Quarter',proj.quarter||'—']].map(([k,v])=>(
            <div key={k} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:'1px solid #d1fae5',fontSize:13}}>
              <span style={{color:'#64748b'}}>{k}</span><span style={{color:'#0f172a',fontWeight:600}}>{v}</span>
            </div>
          ))}
        </div>
        {/* close the 2-column grid first */}
      </div>
      {/* Project Details — Financial Totals */}
      <ProjectFinancials proj={proj} />
      {/* then Zoho Names */}
      <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px 14px',marginBottom:14}}>
        <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em',marginBottom:4}}>ZOHO BOOKS PROJECT NAMES</div>
        <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
          {proj.zohoNames?.map(n=><span key={n} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:5,padding:'2px 8px',fontSize:12}}>{n}</span>)}
        </div>
      </div>
    </Modal>
  );
}

// ─── PROJECT EDIT MODAL ───────────────────────────────────────
function ProjectEditModal({proj,onSave,onClose}) {
  const [vals,setVals]=useState({
    dc:proj.dc||'', ac:proj.ac||'', sw:proj.sw||'',
    piling:proj.piling||2000, wall:proj.wall||2000, road:proj.road||2000,
    agreementDate:proj.agreementDate||'', endDate:proj.endDate||'',
    quarter:proj.quarter||'', totalValue:proj.totalValue||'', epcCost:proj.epcCost||'', bess:proj.bess||0,
  });
  const set=(k,v)=>setVals(p=>({...p,[k]:v}));
  const inp=(lbl,k,ph)=>(
    <div>
      <label style={{fontSize:10,color:'#64748b',fontWeight:700,display:'block',marginBottom:3}}>{lbl}</label>
      <input value={vals[k]} onChange={e=>set(k,e.target.value)} placeholder={ph}
        style={{width:'100%',border:'1.5px solid #e2e8f0',borderRadius:6,padding:'7px 10px',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
    </div>
  );
  return (
    <Modal onClose={onClose} title={`Edit — ${proj.name}`} width={620}>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:14}}>
        {inp('DC (MWp)','dc','e.g. 8.5')}{inp('AC (MW)','ac','e.g. 5.7')}{inp('Switchyards','sw','e.g. 1')}
        {inp('Piling (Nos.)','piling','2000')}{inp('Wall (m)','wall','2000')}{inp('Road (m)','road','2000')}
        {inp('Agreement Date (DD-MM-YYYY)','agreementDate','21-05-2026')}{inp('End Date (DD-MM-YYYY)','endDate','16-11-2026')}{inp('Revenue Quarter','quarter','Q3 FY26-27')}
        {inp('Total Value (Cr)','totalValue','e.g. 50.5')}{inp('EPC Cost/MWp (Cr)','epcCost','e.g. 1.35')}{inp('BESS (MWh)','bess','0')}
      </div>
      <button onClick={()=>{saveOverride(proj.id,vals.dc,vals.ac,vals.sw,vals.piling,vals.wall,vals.road);onSave(vals);}}
        style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:14}}>
        SAVE CHANGES
      </button>
    </Modal>
  );
}

// ─── SOLAR PARK MODAL ─────────────────────────────────────────
function ParkModal({park,onClose,onProjectClick}) {
  const totalBESS=park.projects.reduce((s,p)=>s+(p.bess||0),0);
  const sorted=[...park.projects].sort((a,b)=>{
    if(!a.agreementDate) return 1; if(!b.agreementDate) return -1;
    const t=d=>d.split('-').reverse().join('-');
    return t(b.agreementDate).localeCompare(t(a.agreementDate));
  });
  return (
    <Modal onClose={onClose} width={880} title={`${park.name} Solar Park`} subtitle={`${park.district} District, ${park.state} · ${park.count} project${park.count!==1?'s':''}`}>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:16}}>
        {[['Total DC',`${park.totalDC.toFixed(2)} MWp`],['Total BESS',totalBESS?`${totalBESS.toFixed(2)} MWh`:'None'],['Total Value',fmtCr(park.totalValue)],['Projects',`${park.count}`],['District',park.district],['State',park.state]].map(([k,v])=>(
          <div key={k} style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px 12px'}}>
            <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,marginBottom:3}}>{k.toUpperCase()}</div>
            <div style={{fontSize:15,fontWeight:700,color:'#0f172a'}}>{v}</div>
          </div>
        ))}
      </div>
      <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>Projects in this park</h3>
      <div style={{border:'1px solid #e2e8f0',borderRadius:8,overflow:'hidden'}}>
        {/* Header row */}
        <div style={{display:'grid',gridTemplateColumns:'2fr 80px 80px 80px 100px 110px',alignItems:'center',padding:'8px 14px',background:'#f8fafc',borderBottom:'1.5px solid #e2e8f0'}}>
          {['Project Name','DC (MWp)','AC (MW)','BESS','Value','Agr. Date'].map(h=>(
            <span key={h} style={{fontSize:11,fontWeight:700,color:'#475569',letterSpacing:'0.05em'}}>{h}</span>
          ))}
        </div>
        {sorted.map((p,i)=>(
          <div key={i} onClick={()=>{onClose();onProjectClick(p);}}
            style={{display:'grid',gridTemplateColumns:'2fr 80px 80px 80px 100px 110px',alignItems:'center',padding:'10px 14px',borderBottom:i<sorted.length-1?'1px solid #f1f5f9':'none',cursor:'pointer'}}
            onMouseEnter={e=>e.currentTarget.style.background='#f0f9ff'} onMouseLeave={e=>e.currentTarget.style.background='#fff'}>
            <span style={{fontSize:13,fontWeight:600,color:'#0f172a'}}>{p.name}</span>
            <span style={{fontSize:12,color:'#2563eb'}}>{p.dc?`${p.dc}`:'—'}</span>
            <span style={{fontSize:12,color:'#15803d'}}>{p.ac?`${p.ac}`:'—'}</span>
            <span style={{fontSize:12,color:'#a16207'}}>{p.bess?`${p.bess}`:'—'}</span>
            <span style={{fontSize:12,color:'#0f172a',fontWeight:600}}>{fmtCr(p.totalValue)}</span>
            <span style={{fontSize:11,color:'#64748b'}}>{p.agreementDate||'—'}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ─── RATE UPDATE MODAL ────────────────────────────────────────
function RateUpdateModal({onClose}) {
  const [file,setFile]=useState(null); const [loading,setLoad]=useState(false); const [result,setResult]=useState(null);
  const handle=async(e)=>{
    const f=e.target.files[0]; if(!f) return; setFile(f); setLoad(true);
    const reader=new FileReader();
    reader.onload=async(ev)=>{
      const b64=ev.target.result.split(',')[1];
      try {
        const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1000,messages:[{role:'user',content:[{type:'document',source:{type:'base64',media_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',data:b64}},{type:'text',text:'From this PFB Excel sheet, extract all Rate column values. Return ONLY a JSON object like {"scopeNo": rate, ...} for all 94 items. If new items exist not in standard scopes, add {"new":[{"scopeNo":X,"scopeName":"...","particular":"...","unit":"...","rate":N,"qtyFormula":"..."}]}. Return only valid JSON, no markdown.'}]}]})});
        const d=await r.json(); const text=d.content?.[0]?.text||'{}';
        try { setResult(JSON.parse(text.replace(/```json|```/g,'').trim())); } catch { setResult({error:'Parse failed'}); }
      } catch(e) { setResult({error:e.message}); }
      setLoad(false);
    };
    reader.readAsDataURL(f);
  };
  const apply=()=>{
    if(!result||result.error) return;
    const existing=JSON.parse(localStorage.getItem('pfb_rates')||'{}');
    localStorage.setItem('pfb_rates',JSON.stringify({...existing,...result}));
    onClose();
  };
  return (
    <Modal onClose={onClose} title="Update Item Rates / Add New Items" width={520}>
      <p style={{color:'#475569',fontSize:13,marginBottom:14}}>Upload a PFB Excel sheet. Rates will be updated for <strong>future projects only</strong>. Existing PFBs are unchanged.</p>
      <div style={{border:'2px dashed #bfdbfe',borderRadius:10,padding:'20px',textAlign:'center',background:'#f0f9ff',marginBottom:12}}>
        <input type="file" accept=".xlsx,.xls" onChange={handle} style={{display:'none'}} id="pfb-upload"/>
        <label htmlFor="pfb-upload" style={{cursor:'pointer',color:'#1d4ed8',fontWeight:600,fontSize:14}}>📁 Click to upload PFB Excel sheet</label>
        {file&&<div style={{marginTop:6,fontSize:12,color:'#64748b'}}>{file.name}</div>}
      </div>
      {loading&&<Spinner label="Extracting rates…"/>}
      {result&&!result.error&&<div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:8,padding:'10px',marginBottom:12,fontSize:12,color:'#15803d',fontWeight:600}}>✅ Extracted {Object.keys(result).filter(k=>k!=='new').length} rates{result.new?.length?` + ${result.new.length} new items`:''}</div>}
      {result?.error&&<div style={{background:'#fff1f2',border:'1px solid #fecaca',borderRadius:8,padding:'10px',marginBottom:12,fontSize:12,color:'#dc2626'}}>{result.error}</div>}
      {result&&!result.error&&<button onClick={apply} style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:14}}>APPLY FOR FUTURE PROJECTS</button>}
    </Modal>
  );
}

// ─── SEARCH OVERLAY ───────────────────────────────────────────
function SearchBox({type,onClose}) {
  const [q,setQ]=useState(''); const [results,setR]=useState([]); const [loading,setL]=useState(false);
  const timer=useRef(null);
  useEffect(()=>{if(q.length<2){setR([]);return;}clearTimeout(timer.current);timer.current=setTimeout(async()=>{setL(true);try{const r=await fetch(`/api/search?type=${type}&q=${encodeURIComponent(q)}`);const d=await r.json();setR(d.data||[]);}catch{}setL(false);},400);},[q,type]);
  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{position:'fixed',inset:0,background:'rgba(15,23,42,0.5)',zIndex:2000,display:'flex',alignItems:'flex-start',justifyContent:'center',paddingTop:72,backdropFilter:'blur(3px)'}}>
      <div style={{background:'#fff',borderRadius:14,width:'100%',maxWidth:560,overflow:'hidden',boxShadow:'0 24px 64px rgba(0,0,0,0.2)',border:'1px solid #e2e8f0'}}>
        <div style={{padding:'12px 16px',borderBottom:'1px solid #f1f5f9',display:'flex',gap:10,alignItems:'center'}}>
          <span style={{fontSize:15,color:'#94a3b8'}}>🔍</span>
          <input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder={`Search ${type==='bill'?'Bills':'POs'}…`} style={{flex:1,border:'none',outline:'none',fontSize:14,color:'#0f172a'}}/>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',fontSize:18,color:'#94a3b8'}}>×</button>
        </div>
        <div style={{maxHeight:360,overflowY:'auto'}}>
          {loading&&<div style={{padding:18,color:'#94a3b8',textAlign:'center',fontSize:13}}>Searching…</div>}
          {results.map(r=>(
            <div key={r.id} style={{padding:'11px 16px',borderBottom:'1px solid #f8fafc',cursor:'pointer',display:'flex',justifyContent:'space-between'}}
              onMouseEnter={e=>e.currentTarget.style.background='#f8fafc'} onMouseLeave={e=>e.currentTarget.style.background='#fff'}>
              <div><div style={{fontWeight:700,color:'#0f172a',fontSize:13}}>{r.number}</div><div style={{color:'#64748b',fontSize:12,marginTop:1}}>{r.vendor}</div></div>
              <div style={{textAlign:'right'}}><div style={{fontWeight:700,color:'#1d4ed8',fontSize:13}}>{fmtINR(r.total)}</div><div style={{color:'#94a3b8',fontSize:11}}>{toIndianDate(r.date)}</div></div>
            </div>
          ))}
          {!loading&&q.length>=2&&!results.length&&<div style={{padding:20,color:'#94a3b8',textAlign:'center',fontSize:13}}>No results</div>}
        </div>
      </div>
    </div>
  );
}

// ─── DOWNLOAD EXCEL ───────────────────────────────────────────
function downloadProjectsExcel(projects) {
  const rows=[['S.No.','Project Name','Firm','Solar Park','District','DC (MWp)','AC (MW)','Switchyards','BESS (MWh)','Total Value (Cr)','EPC Cost/MWp','PFB Total (₹)','Rate/Wp','Agreement Date','End Date','Quarter','Zoho Names'],
    ...projects.map((p,i)=>[i+1,p.name,p.firm,p.park,p.district||'—',p.dc,p.ac,p.sw,p.bess||0,p.totalValue,p.epcCost,p.pfbTotal||'',p.ratePerWp?.toFixed(2)||'',p.agreementDate||'',p.endDate||'',p.quarter||'',p.zohoNames?.join(', ')||''])];
  const csv=rows.map(r=>r.map(c=>`"${c??''}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='Projects_Data.csv'; a.click();
}

function downloadParksExcel(parks) {
  const rows=[['S.No.','Park Name','District','State','Projects','Total DC (MWp)','Total Value (Cr)','No. of Projects'],
    ...parks.map((pk,i)=>[i+1,pk.name,pk.district,pk.state,pk.projects.map(p=>p.name).join('; '),pk.totalDC.toFixed(2),pk.totalValue?.toFixed(2)||'',pk.count])];
  const csv=rows.map(r=>r.map(c=>`"${c??''}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='Solar_Parks_Data.csv'; a.click();
}

// ─── SUMMARY CARD ─────────────────────────────────────────────
function Card({label,value,sub,color,icon}) {
  return (
    <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:'13px 16px',borderTop:`3px solid ${color||'#e2e8f0'}`}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
        <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em'}}>{label}</div>
        {icon&&<span style={{fontSize:14}}>{icon}</span>}
      </div>
      <div style={{fontSize:24,fontWeight:900,color:'#0f172a',margin:'4px 0 2px',letterSpacing:'-0.02em'}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:'#64748b'}}>{sub}</div>}
    </div>
  );
}

// ─── PROJECT CODE DISPLAY (2 per line) ────────────────────────
function ProjCodes({name}) {
  if(!name) return <span style={{color:'#94a3b8',fontSize:11}}>—</span>;
  const names=Array.isArray(name)?name:[name];
  const codes=names.map(n=>extractCode(n)).filter(Boolean);
  if(!codes.length) return <span style={{color:'#94a3b8',fontSize:11}}>—</span>;
  const pairs=[];
  for(let i=0;i<codes.length;i+=2) pairs.push(codes.slice(i,i+2).join(', '));
  return <span style={{fontSize:11,color:'#2563eb',fontWeight:600,lineHeight:1.6}}>{pairs.join('\n')}</span>;
}

// ═══════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════════════════════
export default function Dashboard() {
  const [tab,         setTab]        = useState('pos');
  const [pos,         setPOs]        = useState([]);
  const [bills,       setBills]      = useState([]);
  const [pmos,        setPMOs]       = useState([]);
  const [projects,    setProjects]   = useState([]);
  const [firms,       setFirms]      = useState([]);
  const [parks,       setParks]      = useState([]);
  const [pfbCache,    setPFBCache]   = useState({});
  const [loading,     setLoading]    = useState({pos:true,bills:true,pmos:true,projects:true});
  const [selected,    setSelected]   = useState(null);
  const [pfbFlow,     setPFBFlow]    = useState(null);
  const [projDetail,  setProjDetail] = useState(null);
  const [projEdit,    setProjEdit]   = useState(null);
  const [parkDetail,  setParkDetail] = useState(null);
  const [showSearch,  setSearch]     = useState(null);
  const [showRateUpd, setRateUpd]    = useState(false);
  const [lastSync,    setLastSync]   = useState(null);
  // All firms expanded by default
  const [expandedFirms,setExpanded]  = useState({});

  // ── FETCHERS ────────────────────────────────────────────────
  const fetchPOs=useCallback(async()=>{setLoading(p=>({...p,pos:true}));try{const r=await fetch('/api/pos');const d=await r.json();if(d.success){setPOs(d.data);setLastSync(new Date());}}catch{}setLoading(p=>({...p,pos:false}));},[]);
  const fetchBills=useCallback(async()=>{setLoading(p=>({...p,bills:true}));try{const r=await fetch('/api/bills');const d=await r.json();if(d.success)setBills(d.data);}catch{}setLoading(p=>({...p,bills:false}));},[]);
  const fetchPMOs=useCallback(async()=>{setLoading(p=>({...p,pmos:true}));try{const r=await fetch('/api/pmos');const d=await r.json();if(d.success)setPMOs(d.data);}catch{}setLoading(p=>({...p,pmos:false}));},[]);
  const fetchProjects=useCallback(async()=>{
    setLoading(p=>({...p,projects:true}));
    try{
      const ov=encodeURIComponent(JSON.stringify(loadOverrides()));
      const r=await fetch(`/api/projects?overrides=${ov}`);
      const d=await r.json();
      if(d.success){
        setProjects(d.allProjects||[]);setFirms(d.firms||[]);setParks(d.parks||[]);
        // Expand all firms by default
        const allExpanded={};
        (d.firms||[]).forEach((_,i)=>allExpanded[i]=true);
        setExpanded(allExpanded);
      }
    }catch{}
    setLoading(p=>({...p,projects:false}));
  },[]);

  const fetchPFB=async(proj)=>{
    const key=proj.id;
    if(pfbCache[key]) return pfbCache[key];
    const r=await fetch('/api/pfb',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:proj.name,dc:proj.dc,ac:proj.ac,sw:proj.sw,piling:proj.piling||2000,wall:proj.wall||2000,road:proj.road||2000})});
    const d=await r.json();
    if(d.success){setPFBCache(p=>({...p,[key]:d}));return d;}
    return null;
  };

  useEffect(()=>{
    fetchPOs();fetchBills();fetchPMOs();fetchProjects();
    const iv=setInterval(()=>{fetchPOs();fetchBills();fetchPMOs();},15*60*1000);
    return()=>clearInterval(iv);
  },[fetchPOs,fetchBills,fetchPMOs,fetchProjects]);

  // Sort by date descending, Indian format
  // Correctly parses both DD-MM-YYYY (from our data) and YYYY-MM-DD (from Zoho)
  function parseDate(d) {
    if (!d) return new Date(0);
    // YYYY-MM-DD or YYYY-MM-DDTHH:mm (ISO from Zoho)
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) return new Date(d);
    // DD-MM-YYYY (our internal format)
    if (/^\d{2}-\d{2}-\d{4}$/.test(d)) {
      const [day, month, year] = d.split('-');
      return new Date(`${year}-${month}-${day}`);
    }
    return new Date(d);
  }

  const sortByDate = (arr, field) => [...arr].sort((a, b) => {
    const da = parseDate(a[field]);
    const db = parseDate(b[field]);
    return db - da; // descending: latest first
  });

  // Stats
  const poIssues  =pos.filter(p=>p.complianceStatus!=='pass'||p.alignmentStatus==='reject').length;
  const billIssues=bills.filter(b=>b.complianceStatus!=='pass'||b.alignmentStatus==='reject').length;
  const pmoIssues =pmos.filter(p=>p.complianceStatus!=='pass').length;
  const totalFlag =poIssues+billIssues+pmoIssues;
  const totalPP   =pos.length+bills.length; // P&P = POs + Bills pending

  // Table header style
  const TH={padding:'9px 11px',textAlign:'left',color:'#64748b',fontWeight:700,fontSize:11,letterSpacing:'0.06em',borderBottom:'1.5px solid #e2e8f0',whiteSpace:'nowrap',background:'#f8fafc',position:'sticky',top:0,zIndex:10};
  const TD={padding:'9px 11px',fontSize:13,verticalAlign:'middle'};
  const rowBg=item=>item.complianceStatus==='fail'||item.alignmentStatus==='reject'?'#fff1f2':item.complianceStatus==='warn'||item.alignmentStatus==='flag'?'#fefce8':'#fff';

  // PFB flow
  const startPFB=p=>setPFBFlow({proj:p,step:'confirm'});
  const onPFBYes=async()=>{const d=await fetchPFB(pfbFlow.proj);setPFBFlow(f=>({...f,pfbData:d,step:'show'}));};
  const onPFBNo=()=>setPFBFlow(f=>({...f,step:'edit'}));
  const onPFBSave=async(dc,ac,sw,piling,wall,road)=>{
    const updated={...pfbFlow.proj,dc,ac,sw,piling,wall,road,pfbReady:true};
    // Invalidate PFB cache for this project
    setPFBCache(p=>{const n={...p};delete n[updated.id];return n;});
    const d=await fetchPFB(updated);
    setPFBFlow({proj:updated,pfbData:d,step:'show'});
    fetchProjects();
  };

  // ─────────────────────────────────────────────────────────────
  return (
    <>
      <Head><title>Finance Control — Rays Power Experts</title><meta name="viewport" content="width=device-width,initial-scale=1"/></Head>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#f1f5f9;color:#0f172a;font-family:'Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px}
        tbody tr:hover td{background:#f0f9ff!important;cursor:pointer}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
        .fade{animation:fadeIn 0.2s ease}
      `}</style>

      <div style={{minHeight:'100vh',display:'flex',flexDirection:'column',background:'#f1f5f9'}}>

        {/* TOP NAV — sticky */}
        <div style={{background:'#fff',borderBottom:'1.5px solid #e2e8f0',padding:'0 24px',display:'flex',alignItems:'center',justifyContent:'space-between',height:56,position:'sticky',top:0,zIndex:300,boxShadow:'0 1px 4px rgba(0,0,0,0.05)'}}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{width:30,height:30,background:'#1d4ed8',borderRadius:7,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:900,fontSize:14}}>⚡</div>
            <div>
              <div style={{fontWeight:800,fontSize:15,color:'#0f172a',letterSpacing:'-0.02em'}}>Finance Control Dashboard</div>
              <div style={{fontSize:11,color:'#94a3b8'}}>Rays Power Experts Ltd.</div>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:14}}>
            {totalFlag>0&&<div style={{background:'#fee2e2',color:'#b91c1c',padding:'3px 12px',borderRadius:20,fontSize:12,fontWeight:700,border:'1px solid #fca5a5'}}>{totalFlag} need attention</div>}
            {lastSync&&<div style={{fontSize:12,color:'#94a3b8',display:'flex',alignItems:'center',gap:5}}><span style={{width:6,height:6,borderRadius:'50%',background:'#22c55e',display:'inline-block'}}/>Live · {lastSync.toLocaleTimeString()}</div>}
            <div style={{fontSize:13,color:'#64748b',fontWeight:500}}>Jatin Srivastava</div>
          </div>
        </div>

        {/* SUMMARY CARDS — 8 cells: POs Pending, PO Issues, Bills Pending, Bill Issues, PMOs Pending, PMO Issues, Need Action, P&P */}
        <div style={{padding:'12px 24px',display:'grid',gridTemplateColumns:'repeat(8,1fr)',gap:8}}>
          <Card label="POs PENDING"    value={pos.length}    sub={fmtINR(pos.reduce((s,p)=>s+(p.total||0),0))}   color="#f59e0b" icon="📋"/>
          <Card label="PO ISSUES"      value={poIssues}      sub="compliance/alignment"                           color="#f97316" icon="⚠️"/>
          <Card label="BILLS PENDING"  value={bills.length}  sub={fmtINR(bills.reduce((s,b)=>s+(b.total||0),0))} color="#8b5cf6" icon="🧾"/>
          <Card label="BILL ISSUES"    value={billIssues}    sub="compliance/alignment"                           color="#ef4444" icon="⚠️"/>
          <Card label="PMOs PENDING"   value={pmos.length}   sub="payment memos"                                  color="#0ea5e9" icon="💳"/>
          <Card label="PMO ISSUES"     value={pmoIssues}     sub="compliance checks"                              color="#ef4444" icon="⚠️"/>
          <Card label="NEED ACTION"    value={totalFlag}     sub="across all tabs"                                color="#dc2626" icon="🚨"/>
          <Card label="P&P PENDING"    value={totalPP}       sub="POs + Bills total"                              color="#64748b" icon="📌"/>
        </div>

        {/* TABS — sticky below nav */}
        <div style={{background:'#fff',borderBottom:'1.5px solid #e2e8f0',padding:'0 24px',display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:56,zIndex:200,boxShadow:'0 1px 3px rgba(0,0,0,0.03)'}}>
          <div style={{display:'flex'}}>
            {[{id:'pos',label:`POs (${pos.length})`,warn:poIssues},{id:'bills',label:`Bills (${bills.length})`,warn:billIssues},{id:'pmos',label:`PMOs (${pmos.length})`,warn:pmoIssues},{id:'pfbs',label:'PFBs'},{id:'projects',label:`Projects (${projects.length})`},{id:'parks',label:`Solar Parks (${parks.length})`}].map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:'10px 15px',cursor:'pointer',border:'none',background:'transparent',color:tab===t.id?'#1d4ed8':'#64748b',borderBottom:tab===t.id?'2.5px solid #1d4ed8':'2.5px solid transparent',fontSize:13,fontWeight:tab===t.id?700:500,display:'flex',alignItems:'center',gap:5}}>
                {t.label}
                {t.warn>0&&<span style={{background:'#fee2e2',color:'#b91c1c',borderRadius:10,padding:'1px 6px',fontSize:10,fontWeight:800}}>{t.warn}</span>}
              </button>
            ))}
          </div>
          <div style={{display:'flex',gap:7}}>
            {['pos','bills','pmos'].includes(tab)&&<>
              {tab!=='pmos'&&<button onClick={()=>setSearch(tab==='bills'?'bill':'po')} style={{background:'#f8fafc',color:'#475569',border:'1px solid #e2e8f0',borderRadius:7,padding:'5px 11px',cursor:'pointer',fontSize:12}}>🔍 Search</button>}
              <button onClick={()=>{if(tab==='pos')fetchPOs();else if(tab==='bills')fetchBills();else fetchPMOs();}} style={{background:'#f8fafc',color:'#475569',border:'1px solid #e2e8f0',borderRadius:7,padding:'5px 11px',cursor:'pointer',fontSize:12}}>↺ Refresh</button>
            </>}
            {tab==='pfbs'&&<button onClick={()=>setRateUpd(true)} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:7,padding:'5px 13px',cursor:'pointer',fontSize:12,fontWeight:600}}>📊 Update Rates / Add Items</button>}
            {tab==='projects'&&<button onClick={()=>downloadProjectsExcel(projects)} style={{background:'#f0fdf4',color:'#15803d',border:'1px solid #bbf7d0',borderRadius:7,padding:'5px 13px',cursor:'pointer',fontSize:12,fontWeight:600}}>⬇ Download All Data</button>}
            {tab==='parks'&&<button onClick={()=>downloadParksExcel(parks)} style={{background:'#f0fdf4',color:'#15803d',border:'1px solid #bbf7d0',borderRadius:7,padding:'5px 13px',cursor:'pointer',fontSize:12,fontWeight:600}}>⬇ Download All Data</button>}
          </div>
        </div>

        {/* TAB BODIES */}
        <div style={{flex:1,padding:'16px 24px'}}>

          {/* POs */}
          {tab==='pos'&&<div className="fade">
            {loading.pos?<Spinner label="Loading POs…"/>:(
              <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead><tr>{['PO Number','Date','Vendor','Project Code(s)','Amount','Compliance','Alignment','Recommendation',''].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
                    <tbody>
                      {sortByDate(pos,'date').map(po=>(
                        <tr key={po.id} style={{background:rowBg(po),borderBottom:'1px solid #f1f5f9'}} onClick={()=>setSelected({item:po,type:'po'})}>
                          <td style={{...TD,color:'#1d4ed8',fontWeight:700}}>{po.poNumber}</td>
                          <td style={{...TD,color:'#64748b'}}>{toIndianDate(po.date)}</td>
                          <td style={{...TD,color:'#0f172a',fontWeight:500,maxWidth:160,whiteSpace:'normal'}}>{po.vendor}</td>
                          <td style={{...TD}}><ProjCodes name={po.projectZoho}/></td>
                          <td style={{...TD,color:'#0f172a',fontWeight:700}}>{fmtINR(po.total)}</td>
                          <td style={TD}><CompBadge s={po.complianceStatus}/></td>
                          <td style={TD}><AlignBadge s={po.alignmentStatus}/></td>
                          <td style={TD}><RecBadge d={po.recommendation?.decision}/></td>
                          <td style={TD}><button onClick={e=>{e.stopPropagation();setSelected({item:po,type:'po'});}} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:6,padding:'3px 9px',cursor:'pointer',fontSize:11,fontWeight:600}}>View Details</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!pos.length&&<div style={{textAlign:'center',padding:'48px',color:'#94a3b8',fontSize:14}}>No POs pending approval</div>}
                </div>
              </div>
            )}
          </div>}

          {/* Bills */}
          {tab==='bills'&&<div className="fade">
            {loading.bills?<Spinner label="Loading Bills…"/>:(
              <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                <div style={{overflowX:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead><tr>{['Bill Number','Date','Vendor','Project Code(s)','Amount','Linked PO','Compliance','Alignment','Recommendation',''].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
                    <tbody>
                      {sortByDate(bills,'date').map(b=>(
                        <tr key={b.id} style={{background:rowBg(b),borderBottom:'1px solid #f1f5f9'}} onClick={()=>setSelected({item:b,type:'bill'})}>
                          <td style={{...TD,color:'#7c3aed',fontWeight:700}}>{b.billNumber}</td>
                          <td style={{...TD,color:'#64748b'}}>{toIndianDate(b.date)}</td>
                          <td style={{...TD,color:'#0f172a',fontWeight:500,maxWidth:160,whiteSpace:'normal'}}>{b.vendor}</td>
                          <td style={{...TD}}><ProjCodes name={b.projectZoho}/></td>
                          <td style={{...TD,color:'#0f172a',fontWeight:700}}>{fmtINR(b.total)}</td>
                          <td style={{...TD,color:'#64748b',fontSize:12}}>{b.linkedPO?.number||'—'}</td>
                          <td style={TD}><CompBadge s={b.complianceStatus}/></td>
                          <td style={TD}><AlignBadge s={b.alignmentStatus}/></td>
                          <td style={TD}><RecBadge d={b.recommendation?.decision}/></td>
                          <td style={TD}><button onClick={e=>{e.stopPropagation();setSelected({item:b,type:'bill'});}} style={{background:'#f5f3ff',color:'#7c3aed',border:'1px solid #ddd6fe',borderRadius:6,padding:'3px 9px',cursor:'pointer',fontSize:11,fontWeight:600}}>View Details</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!bills.length&&<div style={{textAlign:'center',padding:'48px',color:'#94a3b8',fontSize:14}}>No Bills pending approval</div>}
                </div>
              </div>
            )}
          </div>}

          {/* PMOs */}
          {tab==='pmos'&&<div className="fade">
            {loading.pmos?<Spinner label="Loading Payment Memos…"/>:(
              pmos.length===0?(
                <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',padding:'48px',textAlign:'center'}}>
                  <div style={{fontSize:32,marginBottom:10}}>💳</div>
                  <div style={{fontSize:15,fontWeight:600,color:'#64748b',marginBottom:6}}>No Payment Memos pending approval</div>
                  <div style={{fontSize:12,color:'#94a3b8',marginBottom:8}}>To enable PMOs: Settings → Custom Modules → Payment Memos → copy the API Name</div>
                  <div style={{fontSize:12,color:'#1d4ed8'}}>Then update PMO_MODULE_API_NAME in pages/api/pmos.js</div>
                </div>
              ):(
                <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse'}}>
                      <thead><tr>{['PMO No.','Date','Vendor/Payee','Amount','Type','Project','Compliance','Alignment','Recommendation',''].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
                      <tbody>
                        {sortByDate(pmos,'date').map(p=>(
                          <tr key={p.id} style={{background:rowBg(p),borderBottom:'1px solid #f1f5f9'}} onClick={()=>setSelected({item:p,type:'pmo'})}>
                            <td style={{...TD,color:'#0369a1',fontWeight:700}}>{p.pmoNumber}</td>
                            <td style={{...TD,color:'#64748b'}}>{toIndianDate(p.date)}</td>
                            <td style={{...TD,color:'#0f172a',fontWeight:500,maxWidth:150,whiteSpace:'normal'}}>{p.vendor}</td>
                            <td style={{...TD,color:'#0f172a',fontWeight:700}}>{fmtINR(p.amount)}</td>
                            <td style={{...TD,color:'#475569',fontSize:12}}>{p.paymentType||'—'}</td>
                            <td style={{...TD,color:'#475569',fontSize:12}}>{p.project||'—'}</td>
                            <td style={TD}><CompBadge s={p.complianceStatus}/></td>
                            <td style={TD}><AlignBadge s={p.alignmentStatus||'na'}/></td>
                            <td style={TD}><RecBadge d={p.recommendation?.decision}/></td>
                            <td style={TD}><button onClick={e=>{e.stopPropagation();setSelected({item:p,type:'pmo'});}} style={{background:'#f0f9ff',color:'#0369a1',border:'1px solid #bae6fd',borderRadius:6,padding:'3px 9px',cursor:'pointer',fontSize:11,fontWeight:600}}>View Details</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}
          </div>}

          {/* PFBs */}
          {tab==='pfbs'&&<div className="fade">
            {/* Rate colour legend */}
            <div style={{display:'flex',gap:16,alignItems:'center',marginBottom:10,padding:'8px 14px',background:'#fff',borderRadius:8,border:'1px solid #e2e8f0',flexWrap:'wrap'}}>
              <span style={{fontSize:11,fontWeight:700,color:'#64748b'}}>RATE LEGEND (₹/Wp):</span>
              {[{range:'< ₹25',color:'#22c55e'},{range:'₹25–30',color:'#eab308'},{range:'₹30–35',color:'#f97316'},{range:'≥ ₹35',color:'#ef4444'}].map(({range,color})=>(
                <span key={range} style={{display:'flex',alignItems:'center',gap:5,fontSize:11,fontWeight:600,color}}>
                  <span style={{width:10,height:10,borderRadius:'50%',background:color,display:'inline-block'}}/>
                  {range}
                </span>
              ))}
              <span style={{fontSize:11,color:'#94a3b8',marginLeft:'auto'}}>Click a card to view/generate PFB</span>
            </div>
            {loading.projects?<Spinner/>:(
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))',gap:10}}>
                {projects.map(p=>{
                  const rpw=p.ratePerWp;
                  return (
                    <div key={p.id} onClick={()=>startPFB(p)}
                      style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:'14px 16px',cursor:'pointer',transition:'all 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.04)'}}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor='#1d4ed8';e.currentTarget.style.boxShadow='0 4px 12px rgba(29,78,216,0.1)';}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor='#e2e8f0';e.currentTarget.style.boxShadow='0 1px 3px rgba(0,0,0,0.04)';}}>
                      <div style={{fontWeight:700,color:'#0f172a',fontSize:14,marginBottom:2}}>{p.name}</div>
                      <div style={{fontSize:11,color:'#94a3b8',marginBottom:8}}>{p.agreementDate||'No date'} · {p.park}</div>
                      {p.pfbReady?(
                        <div>
                          <div style={{color:'#1d4ed8',fontWeight:800,fontSize:15}}>{fmtINR(p.pfbTotal)}</div>
                          <div style={{fontSize:13,fontWeight:800,color:rateColor(rpw),marginTop:2}}>₹{rpw?.toFixed(2)}/Wp</div>
                        </div>
                      ):(
                        <div style={{color:'#d97706',fontSize:12,fontWeight:600}}>⚠ Click to set variables</div>
                      )}
                      <div style={{marginTop:8,display:'flex',gap:4,flexWrap:'wrap'}}>
                        {p.dc&&<span style={{background:'#eff6ff',color:'#1d4ed8',fontSize:10,fontWeight:600,padding:'2px 5px',borderRadius:4}}>{p.dc} MWp</span>}
                        {p.ac&&<span style={{background:'#f0fdf4',color:'#15803d',fontSize:10,fontWeight:600,padding:'2px 5px',borderRadius:4}}>{p.ac} MW</span>}
                        {p.bess>0&&<span style={{background:'#fef9c3',color:'#a16207',fontSize:10,fontWeight:600,padding:'2px 5px',borderRadius:4}}>{p.bess} MWh</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>}

          {/* Projects */}
          {tab==='projects'&&<div className="fade">
            {loading.projects?<Spinner/>:(
              <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                {firms.map((firm,fi)=>(
                  <div key={fi}>
                    <div onClick={()=>setExpanded(e=>({...e,[fi]:!e[fi]}))}
                      style={{display:'flex',alignItems:'center',padding:'10px 16px',borderBottom:'1px solid #f1f5f9',background:'#f8fafc',cursor:'pointer'}}
                      onMouseEnter={e=>e.currentTarget.style.background='#f0f9ff'} onMouseLeave={e=>e.currentTarget.style.background='#f8fafc'}>
                      <span style={{marginRight:8,fontSize:11,color:'#94a3b8',transition:'transform 0.15s',display:'inline-block',transform:expandedFirms[fi]!==false?'rotate(90deg)':'none'}}>▶</span>
                      <span style={{fontWeight:800,color:'#0f172a',fontSize:14,flex:1}}>{firm.firmName}</span>
                      <span style={{fontSize:12,color:'#64748b',marginRight:16}}>{firm.projects.length} project{firm.projects.length!==1?'s':''}</span>
                      <span style={{fontSize:12,color:'#1d4ed8',fontWeight:700}}>{firm.projects.reduce((s,p)=>s+(p.dc||0),0).toFixed(2)} MWp</span>
                    </div>
                    {expandedFirms[fi]!==false&&firm.projects.map((p,pi)=>(
                      <div key={pi} onClick={()=>setProjDetail(p)}
                        style={{display:'grid',gridTemplateColumns:'28px 1.8fr 100px 80px 70px 70px 70px 110px 90px',alignItems:'center',padding:'9px 16px',paddingLeft:36,borderBottom:'1px solid #f8fafc',cursor:'pointer',background:'#fff'}}
                        onMouseEnter={e=>e.currentTarget.style.background='#f8fafc'} onMouseLeave={e=>e.currentTarget.style.background='#fff'}>
                        <span style={{fontSize:10,color:'#cbd5e1'}}>→</span>
                        <span style={{fontSize:13,color:'#334155',fontWeight:500}}>{p.name}</span>
                        <span style={{fontSize:11,color:'#64748b'}}>{p.park}</span>
                        <span style={{fontSize:12,color:'#1d4ed8',fontWeight:600}}>{p.dc?`${p.dc} MWp`:'—'}</span>
                        <span style={{fontSize:12,color:'#15803d',fontWeight:600}}>{p.ac?`${p.ac} MW`:'—'}</span>
                        <span style={{fontSize:11,color:'#a16207'}}>{p.bess?`${p.bess} MWh`:'—'}</span>
                        <span style={{fontSize:11,color:'#64748b'}}>{p.sw?`${p.sw} SY`:'—'}</span>
                        <span style={{fontSize:12,color:'#0f172a',fontWeight:700}}>{p.pfbTotal?fmtINR(p.pfbTotal):'—'}</span>
                        <span style={{fontSize:11,color:'#64748b'}}>{p.agreementDate||'—'}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {!firms.length&&<div style={{textAlign:'center',padding:'48px',color:'#94a3b8'}}>No projects</div>}
              </div>
            )}
          </div>}

          {/* Solar Parks */}
          {tab==='parks'&&<div className="fade">
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12}}>
              {[...parks].sort((a,b)=>(b.totalValue||0)-(a.totalValue||0)).map(pk=>(
                <div key={pk.name} onClick={()=>setParkDetail(pk)}
                  style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:'16px 18px',cursor:'pointer',boxShadow:'0 1px 3px rgba(0,0,0,0.04)'}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor='#10b981';e.currentTarget.style.boxShadow='0 4px 12px rgba(16,185,129,0.1)';}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor='#e2e8f0';e.currentTarget.style.boxShadow='0 1px 3px rgba(0,0,0,0.04)';}}>
                  <div style={{fontWeight:800,color:'#0f172a',fontSize:15,marginBottom:2}}>🌞 {pk.name}</div>
                  <div style={{fontSize:12,color:'#64748b',marginBottom:10}}>{pk.district} District · {pk.count} project{pk.count!==1?'s':''}</div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                    {[['Total DC',`${pk.totalDC.toFixed(2)} MWp`],['Total Value',fmtCr(pk.totalValue)]].map(([k,v])=>(
                      <div key={k} style={{background:'#f8fafc',borderRadius:7,padding:'7px 10px'}}>
                        <div style={{fontSize:9,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em'}}>{k}</div>
                        <div style={{fontSize:14,fontWeight:800,color:'#0f172a',marginTop:2}}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                    {pk.projects.slice(0,4).map(p=>(
                      <span key={p.id} style={{background:'#f0fdf4',color:'#15803d',fontSize:10,fontWeight:600,padding:'2px 6px',borderRadius:4,border:'1px solid #bbf7d0'}}>{p.name.split(' ')[0]}</span>
                    ))}
                    {pk.projects.length>4&&<span style={{fontSize:10,color:'#94a3b8'}}>+{pk.projects.length-4} more</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>}
        </div>
      </div>

      {/* MODALS */}
      {selected&&<DetailModal item={selected.item} type={selected.type} onClose={()=>setSelected(null)}/>}
      {projDetail&&!projEdit&&<ProjectDetailModal proj={projDetail} onClose={()=>setProjDetail(null)} onEdit={()=>setProjEdit(projDetail)}/>}
      {projEdit&&<ProjectEditModal proj={projEdit} onClose={()=>setProjEdit(null)} onSave={vals=>{setProjEdit(null);fetchProjects();}}/>}
      {parkDetail&&<ParkModal park={parkDetail} onClose={()=>setParkDetail(null)} onProjectClick={p=>{setProjDetail(p);}}/>}
      {pfbFlow?.step==='confirm'&&<PFBVarConfirm proj={pfbFlow.proj} onClose={()=>setPFBFlow(null)} onYes={onPFBYes} onNo={onPFBNo}/>}
      {pfbFlow?.step==='edit'&&<PFBVarEdit proj={pfbFlow.proj} onClose={()=>setPFBFlow(null)} onSave={onPFBSave}/>}
      {pfbFlow?.step==='show'&&pfbFlow.pfbData&&<PFBDisplay proj={pfbFlow.proj} data={pfbFlow.pfbData} onClose={()=>setPFBFlow(null)}/>}
      {showSearch&&<SearchBox type={showSearch} onClose={()=>setSearch(null)}/>}
      {showRateUpd&&<RateUpdateModal onClose={()=>setRateUpd(false)}/>}
    </>
  );
}
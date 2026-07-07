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

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
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

// Same DD-MM-YYYY comparator pattern as the backend's sortByEndDateDesc -
// used for the PFB tab's project cells (item 6).
function sortByEndDateDescClient(arr) {
  const toComp = d => (d || '').split('-').reverse().join('-');
  return (arr||[]).slice().sort(function(a,b){
    if (!a.endDate) return 1;
    if (!b.endDate) return -1;
    return toComp(b.endDate).localeCompare(toComp(a.endDate));
  });
}

function toIndianDate(d) {
  if (!d) return String.fromCharCode(8212);
  try {
    if (/^\d{2}-\d{2}-\d{4}$/.test(d)) return d;
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return String(dt.getDate()).padStart(2,'0') + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + dt.getFullYear();
  } catch (e) { return d; }
}
// Point 6: dates should always show as DD-MM-YYYY with dashes, never
// slashes. A few places show endDate/agreementDate as already-formatted
// text straight from storage rather than passing through toIndianDate
// above — this normalizes any slash-separated date to dashes at display
// time, without needing to touch (or risk changing the meaning of) the
// underlying stored value itself.
function dashDate(d) {
  return d ? String(d).replace(/\//g, '-') : d;
}

// ----- RATE/Wp COLOR CLASSIFICATION (PFBs tab legend) -----
// green < 25, yellow 25-30, orange 30-35, red >= 35 (Rs./Wp)
function rateColor(ratePerWp) {
  if (ratePerWp == null) return { bg:'#cbd5e1', c:'#334155', label:String.fromCharCode(8212) };
  if (ratePerWp < 25) return { bg:'#22c55e', c:'#fff', label:'Good' };
  if (ratePerWp < 30) return { bg:'#eab308', c:'#fff', label:'Watch' };
  if (ratePerWp < 35) return { bg:'#f97316', c:'#fff', label:'High' };
  return { bg:'#ef4444', c:'#fff', label:'Over' };
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

// ----- PROJECT NAMES DISPLAY (item 6 fix - full official names, no truncation) -----
function ProjectCodes({ names }) {
  if (!names || !names.length) return <span style={{color:'#94a3b8'}}>{String.fromCharCode(8212)}</span>;
  const unique = [...new Set(names)];
  return (
    <span style={{fontSize:11,color:'#2563eb',display:'flex',flexDirection:'column',gap:1,wordBreak:'break-word'}}>
      {unique.map((n,i) => <span key={i}>{n}{i<unique.length-1?',':''}</span>)}
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
            <div style={{fontSize:11,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em',marginBottom:2}}>{k.toUpperCase()}</div>
            <div style={{fontSize:14,color:'#0f172a',fontWeight:500,wordBreak:'break-word'}}>{v==null?String.fromCharCode(8212):v}</div>
          </div>
        );
      })}
    </div>
  );
}

// Same visual style as InfoGrid, but each row can use its own column
// ratio (e.g. '3fr 7fr') instead of one fixed equal-width count — needed
// for rows like PI/Bill Attachment + Payment Terms sharing space
// unevenly, followed by Remarks taking the full row alone.
function InfoGridCustom({ rows }) {
  return (
    <div style={{background:'#f8fafc',borderRadius:10,padding:'14px 18px',marginBottom:16}}>
      {rows.map(function(row, ri){
        return (
          <div key={ri} style={{display:'grid',gridTemplateColumns:row.template,gap:'10px 20px',marginTop:ri>0?10:0}}>
            {row.items.map(function(pair){
              const k = pair[0], v = pair[1];
              return (
                <div key={k}>
                  <div style={{fontSize:11,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em',marginBottom:2}}>{k.toUpperCase()}</div>
                  <div style={{fontSize:14,color:'#0f172a',fontWeight:500,wordBreak:'break-word'}}>{v==null?String.fromCharCode(8212):v}</div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// Truncates long text (Notes, Terms & Conditions) to ~20 words with
// "....." — clicking opens a nested modal (stacked above the current one
// via a higher z-index) showing the full text, so nothing long ever gets
// silently cut off from view.
function ExpandableText({ label, text, onExpandFull }) {
  const [expanded, setExpanded] = useState(false);
  const PREVIEW_WORDS = 22;   // default preview length (~20-25 words requested)
  const INLINE_MAX     = 45;  // beyond this, inline expansion would take up too much space - use a popup instead
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  const isLong    = words.length > PREVIEW_WORDS;
  const useInline = words.length <= INLINE_MAX;
  const preview   = isLong ? words.slice(0, PREVIEW_WORDS).join(' ') + ' .....' : (text || String.fromCharCode(8212));
  return (
    <div>
      <div style={{fontSize:11,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em',marginBottom:2}}>{label.toUpperCase()}</div>
      <div style={{fontSize:14,color:'#0f172a',fontWeight:500,wordBreak:'break-word',whiteSpace:'pre-wrap',lineHeight:1.6}}>
        {(expanded && useInline) ? text : preview}
      </div>
      {isLong && (
        <button onClick={function(){ if (useInline) setExpanded(function(e){return !e;}); else if (onExpandFull) onExpandFull(); }}
          style={{background:'none',border:'none',color:'#2563eb',fontWeight:700,fontSize:12,cursor:'pointer',padding:0,marginTop:4}}>
          {useInline ? (expanded ? 'Show less' : 'Read more') : 'Read more'}
        </button>
      )}
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

// ----- DIRECTION-AWARE STATUS BADGE (shared by both new comparison tables) -----
// Real bug this replaces: the old single "Over Budget"/"Variance" status
// ignored direction entirely, so a rate BELOW the reference (favorable)
// showed the exact same "Over Budget" label as one ABOVE it.
function statusWord(status) {
  if (status === 'over_severe' || status === 'over_caution') return 'High';
  if (status === 'under_severe' || status === 'under_caution') return 'Low';
  if (status === 'na') return 'N/A';
  if (status === 'no_match') return 'No Match';
  return 'OK';
}
function statusColor(status) {
  if (status === 'over_severe' || status === 'over_caution') return '#dc2626'; // mid-red - High
  if (status === 'under_severe' || status === 'under_caution') return '#ea580c'; // mid-orange - Low
  if (status === 'na' || status === 'no_match') return '#6b7280'; // mid-grey - No Match/N/A
  return '#16a34a'; // mid-green - OK
}
function StatusBadge({ status }) {
  const c = statusColor(status);
  return <span style={{fontSize:11,fontWeight:700,color:c}}>{statusWord(status)}</span>;
}
function rowTint(status) {
  if (status === 'over_severe' || status === 'over_caution') return '#fef2f4'; // very light pink
  if (status === 'under_severe' || status === 'under_caution') return '#fffdf0'; // very light yellow
  if (status === 'na' || status === 'no_match') return '#f8fafc'; // very light grey
  return '#fff'; // white - OK
}

// ----- PFB ALIGNMENT TABLE (PO or Bill line items vs PFB scope) -----
// Replaces the old combined LineTable for this case — now shows Qty and
// Rate compared and statused SEPARATELY (item 5 fix), so a pure qty
// mismatch can never hide behind a confusing "0.0%" rate variance again.
function PFBAlignmentTable({ checks, title }) {
  if (!checks || !checks.length) return null;
  const tierLabel = function(t){ return t===1?'Name match':t===2?'Tag match':t===3?'Tag+disambig':String.fromCharCode(8212); };
  const divider = {borderRight:'1.5px solid #cbd5e1'};
  // Any header with more than one word wraps onto 2 lines (whiteSpace
  // normal instead of nowrap), with a taller header row to fit it
  // comfortably — needed since this table now carries 12 columns.
  const wrapHeader = {padding:'7px 8px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'normal',lineHeight:1.25,verticalAlign:'bottom'};
  const headers = [
    {label:'Item',        width:100},
    {label:'PFB Match',   width:80},
    {label:'Match Type',  width:70,  divider:true},
    {label:'Qty',         width:null},
    {label:'PFB Qty',     width:60},
    {label:'Qty Status',  width:60,  divider:true},
    {label:'Rate',        width:null},
    {label:'PFB Rate',    width:null},
    {label:'Rate Status', width:60,  divider:true},
    {label:'Amount',      width:null},
    {label:'PFB Amount',  width:null},
    {label:'Overall Status', width:70},
  ];
  return (
    <div style={{marginBottom:20}}>
      <h3 style={{fontSize:14,fontWeight:700,color:'#0f172a',marginBottom:8}}>{title}</h3>
      <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
          <thead><tr style={{background:'#eff6ff'}}>
            {headers.map(function(h){
              const style = Object.assign({}, wrapHeader, h.divider?divider:{}, h.width?{maxWidth:h.width}:{});
              return <th key={h.label} style={style}>{h.label}</th>;
            })}
          </tr></thead>
          <tbody>
            {checks.map(function(c,i){
              const pfbAmount = (c.pfbRate!=null && c.pfbQty!=null) ? c.pfbRate * c.pfbQty : null;
              return (
                <tr key={i} style={{borderBottom:'1px solid #f1f5f9',background:rowTint(c.status)}}>
                  <td style={{padding:'7px 8px',color:'#0f172a',fontWeight:500,maxWidth:100}}>{c.lineItem}</td>
                  <td style={{padding:'7px 8px',color:'#2563eb',fontSize:12,maxWidth:80,whiteSpace:'normal'}}>{c.pfbMatch||String.fromCharCode(8212)}</td>
                  <td style={Object.assign({padding:'7px 8px',color:'#7c3aed',fontSize:12},divider)}>{c.matchTier?tierLabel(c.matchTier):String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 8px',color:'#475569'}}>{fmtN(c.qty)}</td>
                  <td style={{padding:'7px 8px',color:'#475569'}}>{c.pfbQty!=null?fmtN(c.pfbQty):String.fromCharCode(8212)}</td>
                  <td style={Object.assign({padding:'7px 8px'},divider)}>{c.qtyStatus?<StatusBadge status={c.qtyStatus}/>:String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 8px',color:'#475569'}}>{fmt(c.rate)}</td>
                  <td style={{padding:'7px 8px',color:'#475569'}}>{c.pfbRate!=null?fmt(c.pfbRate):String.fromCharCode(8212)}</td>
                  <td style={Object.assign({padding:'7px 8px'},divider)}>{c.rateStatus?<StatusBadge status={c.rateStatus}/>:String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 8px',color:'#0f172a',fontWeight:600}}>{fmt(c.amount)}</td>
                  <td style={{padding:'7px 8px',color:'#0f172a',fontWeight:600}}>{pfbAmount!=null?fmt(pfbAmount):String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 8px'}}><StatusBadge status={c.status}/></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----- PO MATCH TABLE (Bill line items vs linked PO line items) -----
// This is a genuinely different comparison than the PFB table above (two
// real documents being compared, not one document against a budget
// reference) — it was previously squeezed into the same table component
// despite using completely different field names (billQty/poQty vs
// qty/pfbQty), which is why Status showed but every other column was
// silently blank.
function POMatchTable({ checks, title }) {
  if (!checks || !checks.length) return null;
  const divider = {borderRight:'1.5px solid #cbd5e1'};
  const wrapHeader = {padding:'7px 8px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'normal',lineHeight:1.25,verticalAlign:'bottom'};
  const headers = [
    {label:'Item',           width:100},
    {label:'Bill Qty',       width:65},
    {label:'PO Qty',         width:65},
    {label:'Qty Status',     width:65, divider:true},
    {label:'Bill Rate',      width:70},
    {label:'PO Rate',        width:70},
    {label:'Rate Status',    width:65, divider:true},
    {label:'Bill Amount',    width:80},
    {label:'PO Amount',      width:80},
    {label:'Overall Status', width:70},
  ];
  return (
    <div style={{marginBottom:20}}>
      <h3 style={{fontSize:14,fontWeight:700,color:'#0f172a',marginBottom:8}}>{title}</h3>
      <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
          <thead><tr style={{background:'#eff6ff'}}>
            {headers.map(function(h){
              const dividerHere = (h.label==='Item'||h.divider) ? divider : null;
              return <th key={h.label} style={Object.assign({},wrapHeader,{maxWidth:h.width},dividerHere)}>{h.label}</th>;
            })}
          </tr></thead>
          <tbody>
            {checks.map(function(c,i){
              return (
                <tr key={i} style={{borderBottom:'1px solid #f1f5f9',background:rowTint(c.status)}}>
                  <td style={Object.assign({padding:'7px 8px',color:'#0f172a',fontWeight:500,maxWidth:100},divider)}>{c.lineItem}</td>
                  <td style={{padding:'7px 8px',color:'#475569'}}>{fmtN(c.billQty)}</td>
                  <td style={{padding:'7px 8px',color:'#475569'}}>{c.poQty!=null?fmtN(c.poQty):String.fromCharCode(8212)}</td>
                  <td style={Object.assign({padding:'7px 8px'},divider)}>{c.qtyStatus?<StatusBadge status={c.qtyStatus}/>:String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 8px',color:'#475569'}}>{fmt(c.billRate)}</td>
                  <td style={{padding:'7px 8px',color:'#475569'}}>{c.poRate!=null?fmt(c.poRate):String.fromCharCode(8212)}</td>
                  <td style={Object.assign({padding:'7px 8px'},divider)}>{c.rateStatus?<StatusBadge status={c.rateStatus}/>:String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 8px',color:'#0f172a',fontWeight:600}}>{fmt(c.billAmount)}</td>
                  <td style={{padding:'7px 8px',color:'#475569'}}>{c.poAmount!=null?fmt(c.poAmount):String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 8px'}}><StatusBadge status={c.status}/></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----- PO BREAKUP TABLE (PMOs only) -----
// Built defensively: the exact field names Zoho uses for this org's PO
// Breakup subform couldn't be confirmed without live access to a real raw
// PMO record (it's very unlikely to be a simple custom field given it's a
// multi-row table) — pmos.js logs the raw field/key names once per cold
// start specifically so these can be confirmed and tightened up precisely
// once that's visible. This reads several plausible key-name variants so
// it has the best chance of rendering correctly even before that
// confirmation happens, and degrades to nothing (not a crash) if the
// shape turns out to be completely different.
function POBreakupTable({ rows, kind }) {
  if (!rows || !rows.length) return null;
  const isExpense = kind === 'expense';
  // Build the column list dynamically from whichever keys the backend
  // actually included on these specific rows — never a fixed count, since
  // different PMOs genuinely have different columns filled in on ZB
  // itself (confirmed: one real PMO showed 5 PO Breakup columns, another
  // showed all 6 Expense Breakup columns including TDS). Total is always
  // last, matching the real screenshot's column order exactly.
  const has = key => rows.some(r => r[key] !== undefined);
  const cols = [
    isExpense ? { key:'expense_detail', label:'Expense Detail' } : { key:'po_number', label:'PO Number' },
  ];
  if (has('basic_amount')) cols.push({ key:'basic_amount', label:'Basic Amount' });
  if (has('tax_amount'))   cols.push({ key:'tax_amount', label:'Tax Amount' });
  if (has('tds'))          cols.push({ key:'tds', label:'TDS' });
  if (has('adjustment'))   cols.push({ key:'adjustment', label:'Adjustment' });
  cols.push({ key:'total', label:'Total' });

  const grandTotal = rows.reduce((s,r) => s + (Number(r.total) || 0), 0);

  return (
    <div style={{marginBottom:20}}>
      <h3 style={{fontSize:14,fontWeight:700,color:'#0f172a',marginBottom:8}}>{isExpense ? 'Expense Breakup' : 'PO Breakup'}</h3>
      <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
          <thead><tr style={{background:'#eff6ff'}}>
            {cols.map(function(c){
              const isLabelCol = c.key==='po_number' || c.key==='expense_detail';
              return <th key={c.key} style={Object.assign({padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'},isLabelCol?{borderRight:'1.5px solid #cbd5e1'}:{})}>{c.label}</th>;
            })}
          </tr></thead>
          <tbody>
            {rows.map(function(r,i){
              return (
                <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                  {cols.map(function(c){
                    const isLabelCol = c.key==='po_number' || c.key==='expense_detail';
                    const val = r[c.key];
                    return (
                      <td key={c.key} style={Object.assign({padding:'7px 10px',color:isLabelCol?'#0f172a':'#475569',fontWeight:isLabelCol||c.key==='total'?700:400},isLabelCol?{borderRight:'1.5px solid #cbd5e1'}:{})}>
                        {isLabelCol ? (val || String.fromCharCode(8212)) : (val!=null ? fmt(val) : String.fromCharCode(8212))}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr style={{background:'#eff6ff',borderTop:'2px solid #dbeafe'}}>
              <td colSpan={cols.length-1} style={{padding:'8px 10px',color:'#1e40af',fontWeight:700,fontSize:12,textAlign:'right'}}>{'Total Amount against ' + (isExpense?'Expense':'PO')}</td>
              <td style={{padding:'8px 10px',color:'#0f172a',fontWeight:800}}>{fmt(grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----- REFERENCE RATE TABLE (new, dedicated - kept separate from PFB
// Alignment / PO Match tables) -----
function ReferenceRateTable({ checks }) {
  if (!checks || checks.length === 0) return null;
  const withHistory = checks.filter(c => c.hasHistory);
  if (withHistory.length === 0) {
    return (
      <div style={{background:'#fff7ed',border:'1px solid #fed7aa',borderRadius:8,padding:'10px 14px',marginBottom:20,fontSize:13,color:'#9a3412'}}>
        <b>Reference Rate not available:</b> none of this document's items have any recorded price history yet — nothing to compare against.
      </div>
    );
  }
  const divider = { borderRight:'1.5px solid #cbd5e1' };
  // New order: Item Name | Official Name | Project Head | PFB Head | Account
  // | Today's Rate | Reference Rate | Status | Last Used Date | Last Used PO/Bill No.
  // Dividers after Official Name(1), Account(4), Status(7).
  const dividerCols = new Set([1, 4, 7]);
  const wrapHeader = {padding:'7px 8px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'normal',lineHeight:1.25,verticalAlign:'bottom'};
  const headerDefs = [
    {label:'Item Name', width:130},
    {label:'Official Name', width:130},
    {label:'Project Head', width:null},
    {label:'PFB Head', width:null},
    {label:'Account', width:null},
    {label:"Today's Rate", width:null},
    {label:'Reference Rate', width:null},
    {label:'Status', width:null},
    {label:'Last Used Date', width:85},
    {label:'Last Used PO/Bill No.', width:null},
  ];
  return (
    <div style={{marginBottom:20}}>
      <h3 style={{fontSize:14,fontWeight:700,color:'#0f172a',marginBottom:8}}>Reference Rate</h3>
      <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
          <thead><tr style={{background:'#eff6ff'}}>
            {headerDefs.map(function(h,i){
              const style = Object.assign({}, wrapHeader, dividerCols.has(i)?divider:{}, h.width?{maxWidth:h.width}:{});
              return <th key={h.label} style={style}>{h.label}</th>;
            })}
          </tr></thead>
          <tbody>
            {withHistory.map(function(c,i){
              return (
                <tr key={i} style={{borderBottom:'1px solid #f1f5f9',background:rowTint(c.refStatus)}}>
                  <td style={{padding:'7px 8px',color:'#0f172a',fontWeight:500,maxWidth:130}}>{c.itemName}</td>
                  <td style={Object.assign({padding:'7px 8px',color:c.officialNameIsExact?'#0f172a':'#94a3b8',fontStyle:c.officialNameIsExact?'normal':'italic',maxWidth:130},divider)}>
                    {c.officialName || String.fromCharCode(8212)}{!c.officialNameIsExact && c.officialName ? ' (closest match)' : ''}
                  </td>
                  <td style={{padding:'7px 8px',color:'#7c3aed',fontSize:12}}>{c.projectHead||String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 8px',color:'#7c3aed',fontSize:12}}>{c.pfbHead||String.fromCharCode(8212)}</td>
                  <td style={Object.assign({padding:'7px 8px',color:'#64748b',fontSize:12},divider)}>{c.account||String.fromCharCode(8212)}</td>
                  <td style={{padding:'7px 8px',color:'#0f172a',fontWeight:600}}>{fmt(c.currentRate)}</td>
                  <td style={{padding:'7px 8px',color:'#0f172a',fontWeight:700}}>
                    {c.refRateUsed!=null?fmt(c.refRateUsed):String.fromCharCode(8212)}
                    {c.usedCrossSource && <div style={{fontSize:10,color:'#94a3b8',fontWeight:400}}>(blended PO+Bill)</div>}
                  </td>
                  <td style={Object.assign({padding:'7px 8px'},divider)}><StatusBadge status={c.refStatus}/></td>
                  <td style={{padding:'7px 8px',color:'#64748b',fontSize:12}}>{toIndianDate(c.lastUsedDate)}</td>
                  <td style={{padding:'7px 8px',color:'#2563eb',fontSize:12}}>{c.lastUsedDocNumber||String.fromCharCode(8212)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function Card({ label, value, sub, color, icon }) {
  return (
    <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:'14px 18px',borderTop:'3px solid ' + (color||'#e2e8f0'),overflow:'hidden',minWidth:0}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
        <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em',lineHeight:1.3}}>{label}</div>
        {icon&&<span style={{fontSize:18,lineHeight:1,flexShrink:0,marginLeft:6}}>{icon}</span>}
      </div>
      <div style={{fontSize:26,fontWeight:900,color:'#0f172a',margin:'5px 0 2px',letterSpacing:'-0.02em'}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:'#64748b',lineHeight:1.3}}>{sub}</div>}
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
          <div style={{display:'inline-flex',alignItems:'center',gap:8}}>
            <span style={{fontSize:16,fontWeight:700,color:'#0f172a'}}>{'\u20b9' + (data && data.ratePerWp ? data.ratePerWp.toFixed(2) : String.fromCharCode(8212)) + '/Wp'}</span>
            {data && data.ratePerWp != null && (function(){
              const rc = rateColor(data.ratePerWp);
              return <span style={{background:rc.bg,color:rc.c,fontSize:11,fontWeight:700,padding:'2px 9px',borderRadius:5}}>{rc.label}</span>;
            })()}
          </div>
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
  const [loadingFin, setLoadingFin] = useState(true);
  const [showEditNames, setShowEditNames] = useState(false);
  const [showEditProject, setShowEditProject] = useState(false);
  const [localProj, setLocalProj] = useState(proj);

  const fetchFinancials = useCallback(async (forceRefresh) => {
    setLoadingFin(true);
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

  // Auto-fetches on open again — safe now. This reads from Zoho Analytics
  // (a completely separate, already-cached, 4-hour-shared-across-every-
  // project pull), not the expensive direct-Books-summing this used to do.
  // The old opt-in "Load Totals" gate and cost warning were specific to
  // that old, expensive path and no longer apply.
  useEffect(() => { fetchFinancials(false); }, [fetchFinancials]);

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
              ['End Date', dashDate(localProj.endDate)||String.fromCharCode(8212)],
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
          <button onClick={function(){fetchFinancials(true);}} disabled={loadingFin}
            style={{background:'#f8fafc',color:'#475569',border:'1px solid #e2e8f0',borderRadius:6,padding:'4px 11px',cursor:'pointer',fontSize:11,fontWeight:600}}>
            {loadingFin?'Refreshing...':'\u{1F504} Refresh'}
          </button>
        </div>
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

        <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px 14px',marginBottom:14}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
            <div style={{fontSize:10,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em'}}>ZOHO BOOKS PROJECT NAMES</div>
            <button onClick={function(){setShowEditNames(true);}}
              style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:6,padding:'3px 10px',cursor:'pointer',fontSize:11,fontWeight:600}}>
              {'\u{1F58A}\uFE0F Modify/Add'}
            </button>
          </div>
          <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
            {(localProj.zohoNames||[]).map(function(n,i){
              return <span key={n+'_'+i} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:5,padding:'2px 8px',fontSize:12}}>{n}</span>;
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
            {['Project Name','DC (MWp)','AC (MW)','BESS','Value','End Date'].map(function(h){
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
              <span style={{fontSize:11,color:'#64748b'}}>{dashDate(p.endDate)||String.fromCharCode(8212)}</span>
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
// Item name fallback: if Zoho's name field is blank (engineer typed the
// name into the Description box by mistake instead), fall back to the
// description — used as-is if short enough, otherwise auto-shortened to
// a usable label, so the table never shows a blank where a name should be.
function resolveItemName(li) {
  if (li.name && li.name.trim()) return li.name;
  const desc = (li.description || '').trim();
  if (!desc) return null;
  const words = desc.split(/\s+/);
  return words.length <= 5 ? desc : words.slice(0, 5).join(' ') + '...';
}

function ItemsTable({ items, title, subTotal, taxes, total, discount, discountFormatted, adjustment, adjustmentDescription, onItemDetails }) {
  if (!items || !items.length) return null;
  const computedSubTotal = items.reduce((s, li) => s + (Number(li.item_total) || 0), 0);
  const displaySubTotal  = subTotal != null ? subTotal : computedSubTotal;
  const totalQty = items.reduce((s, li) => s + (Number(li.quantity) || 0), 0);

  const allTaxEntries   = Array.isArray(taxes) ? taxes.filter(t => t && t.tax_amount) : [];
  const standardTaxes   = allTaxEntries.filter(t => Number(t.tax_amount) >= 0);
  const deductionTaxes  = allTaxEntries.filter(t => Number(t.tax_amount) < 0);

  const hasDiscount   = discount != null && discount !== 0;
  const hasAdjustment = adjustment != null && adjustment !== 0;

  const row1Base = [];
  if (hasDiscount)   row1Base.push(['Discount', discountFormatted || fmt(discount)]);
  if (hasAdjustment) row1Base.push(['Adjustment', fmt(adjustment) + (adjustmentDescription ? ' (' + adjustmentDescription + ')' : '')]);
  row1Base.push(['Total Quantity', fmtN(totalQty)]);
  row1Base.push(['Sub Total', fmt(displaySubTotal)]);

  const row2Base = standardTaxes.map(t => [t.tax_name || 'Tax', fmt(t.tax_amount)]);
  row2Base.push(['Total', fmt(total!=null?total:displaySubTotal)]);

  let row1Items = row1Base, row2Items = row2Base;
  if (deductionTaxes.length > 0) {
    const deductionPairs = deductionTaxes.map(t => [t.tax_name || 'Deduction', fmt(t.tax_amount)]);
    if (row1Base.length < row2Base.length) row1Items = [...deductionPairs, ...row1Base];
    else row2Items = [...deductionPairs, ...row2Base];
  }

  const itemsWithProjCode = items.map(li => ({
    li,
    projCode: li.project_name ? extractCode(li.project_name) : ((li.description||'').match(/LE\d{4}/i)||[])[0] || '',
  }));
  // Project column dropped ENTIRELY when every single row's project is
  // blank — Location alone serves that purpose then, per the exact rule
  // requested. Location itself is only shown when at least one row's
  // Project is blank (unchanged from before).
  const showProject  = itemsWithProjCode.some(x => !!x.projCode);
  const showLocation = itemsWithProjCode.some(x => !x.projCode);
  const showSpec = items.some(li => li.sku);

  const headers = ['#','Item Name', ...(showSpec?['Specification']:[]), ...(showProject?['Project']:[]), ...(showLocation?['Location']:[]), 'Qty','Unit','Rate','Amount'];
  const colCount = headers.length;
  // Vertical dividers: one right after Item Name, one right before Qty —
  // so whichever of Specification/Project/Location are actually present
  // sit visually grouped between the two lines. Never extended into the
  // yellow summary rows below. The second divider goes on whichever of
  // the three optional columns is the LAST one actually present.
  const divider = { borderRight:'1.5px solid #cbd5e1' };
  const lastOptionalCol = showLocation ? 'location' : showProject ? 'project' : showSpec ? 'spec' : 'name';

  return (
    <div style={{marginBottom:20}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        <h3 style={{fontSize:14,fontWeight:700,color:'#0f172a'}}>{title||'Line Items'}</h3>
        {onItemDetails && (
          <button onClick={function(){ onItemDetails(items); }}
            style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:6,padding:'5px 12px',fontSize:12,fontWeight:600,cursor:'pointer'}}>
            Item Details
          </button>
        )}
      </div>
      <div style={{overflowX:'auto',border:'1px solid #e2e8f0',borderRadius:8}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
          <thead><tr style={{background:'#eff6ff'}}>
            <th style={{padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'}}>#</th>
            <th style={Object.assign({padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'},divider)}>Item Name</th>
            {showSpec && <th style={Object.assign({padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'},lastOptionalCol==='spec'?divider:{})}>Specification</th>}
            {showProject && <th style={Object.assign({padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'},lastOptionalCol==='project'?divider:{})}>Project</th>}
            {showLocation && <th style={Object.assign({padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'},lastOptionalCol==='location'?divider:{})}>Location</th>}
            <th style={{padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'}}>Qty</th>
            <th style={{padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'}}>Unit</th>
            <th style={{padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'}}>Rate</th>
            <th style={{padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'}}>Amount</th>
          </tr></thead>
          <tbody>
            {itemsWithProjCode.map(function(x,i){
              const li = x.li;
              const displayName = resolveItemName(li);
              return (
                <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                  <td style={{padding:'6px 10px',color:'#94a3b8',fontSize:11}}>{i+1}</td>
                  <td style={Object.assign({padding:'6px 10px',color:'#0f172a',fontWeight:500,maxWidth:200,whiteSpace:'normal',wordBreak:'break-word'},divider)}>{displayName || String.fromCharCode(8212)}</td>
                  {showSpec && <td style={Object.assign({padding:'6px 10px',color:'#7c3aed',fontSize:12},lastOptionalCol==='spec'?divider:{})}>{li.sku||String.fromCharCode(8212)}</td>}
                  {showProject && <td style={Object.assign({padding:'6px 10px',color:'#2563eb',fontSize:11,fontWeight:600},lastOptionalCol==='project'?divider:{})}>{x.projCode||String.fromCharCode(8212)}</td>}
                  {showLocation && <td style={Object.assign({padding:'6px 10px',color:'#64748b'},lastOptionalCol==='location'?divider:{})}>{li.location_name||String.fromCharCode(8212)}</td>}
                  <td style={{padding:'6px 10px',color:'#0f172a',fontWeight:500}}>{fmtN(li.quantity)}</td>
                  <td style={{padding:'6px 10px',color:'#64748b'}}>{li.unit||String.fromCharCode(8212)}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a'}}>{fmt(li.rate)}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',fontWeight:700}}>{fmt(li.item_total)}</td>
                </tr>
              );
            })}
            {/* Row 1: Discount, Adjustment, Total Quantity, Sub Total (plus
                any deduction placed here) — spread evenly. No divider ever
                extends down into these summary rows. */}
            <tr style={{background:'#fefce8',borderTop:'2px solid #fde68a'}}>
              <td colSpan={colCount} style={{padding:'8px 16px'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:18,flexWrap:'wrap'}}>
                  {row1Items.map(function(pair,i){
                    return <span key={i} style={{fontSize:13,color:'#854d0e'}}><b>{pair[0]}:</b> {pair[1]}</span>;
                  })}
                </div>
              </td>
            </tr>
            {/* Row 2: taxes + Total (plus any deduction placed here). Real
                bug fixed: marginLeft:'auto' on Total was interfering with
                how space-between distributes the OTHER items (deductions/
                taxes), bunching them to the left instead of spreading
                evenly - removed, now behaves exactly like Row 1. */}
            <tr style={{background:'#fefce8'}}>
              <td colSpan={colCount} style={{padding:'8px 16px 10px'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:18,flexWrap:'wrap'}}>
                  {row2Items.map(function(pair,i){
                    const isTotal = pair[0]==='Total';
                    return <span key={i} style={isTotal?{fontSize:14,color:'#713f12',fontWeight:800}:{fontSize:13,color:'#854d0e'}}><b>{pair[0]}:</b> {pair[1]}</span>;
                  })}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----- ITEM DETAILS TABLE (Phase 4 - shown in its own popup, opened via
// the 'Item Details' button on the Line Items table) -----
function ItemDetailsTable({ items }) {
  if (!items || !items.length) return null;
  return (
    <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
        <thead><tr style={{background:'#eff6ff'}}>
          {['#','Item Name','Specification','Project','Location','Account','Qty','Unit','Rate','Amount','Tax'].map(function(h){
            return <th key={h} style={{padding:'7px 10px',textAlign:'left',color:'#1e40af',fontWeight:700,fontSize:12,borderBottom:'1px solid #dbeafe',whiteSpace:'nowrap'}}>{h}</th>;
          })}
        </tr></thead>
        <tbody>
          {items.map(function(li,i){
            const displayName = resolveItemName(li);
            return (
              <Fragment key={i}>
                <tr style={{borderBottom:'none'}}>
                  <td style={{padding:'6px 10px',color:'#94a3b8',fontSize:11,verticalAlign:'top'}}>{i+1}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',fontWeight:500,maxWidth:160,whiteSpace:'normal',wordBreak:'break-word',verticalAlign:'top'}}>{displayName||String.fromCharCode(8212)}</td>
                  <td style={{padding:'6px 10px',color:'#7c3aed',fontSize:12,verticalAlign:'top'}}>{li.sku||String.fromCharCode(8212)}</td>
                  <td style={{padding:'6px 10px',color:'#2563eb',fontSize:12,verticalAlign:'top'}}>{li.project_name||String.fromCharCode(8212)}</td>
                  <td style={{padding:'6px 10px',color:'#64748b',fontSize:12,verticalAlign:'top'}}>{li.location_name||String.fromCharCode(8212)}</td>
                  <td style={{padding:'6px 10px',color:'#64748b',fontSize:12,verticalAlign:'top'}}>{li.account_name||String.fromCharCode(8212)}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',verticalAlign:'top'}}>{fmtN(li.quantity)}</td>
                  <td style={{padding:'6px 10px',color:'#64748b',verticalAlign:'top'}}>{li.unit||String.fromCharCode(8212)}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',verticalAlign:'top'}}>{fmt(li.rate)}</td>
                  <td style={{padding:'6px 10px',color:'#0f172a',fontWeight:600,verticalAlign:'top'}}>{fmt(li.item_total)}</td>
                  <td style={{padding:'6px 10px',color:'#64748b',fontSize:12,verticalAlign:'top'}}>{li.tax_name||String.fromCharCode(8212)}</td>
                </tr>
                {li.description && (
                  <tr style={{borderBottom:'1px solid #f1f5f9'}}>
                    <td></td>
                    <td colSpan={10} style={{padding:'0 10px 8px',color:'#64748b',fontSize:12,fontStyle:'italic',wordBreak:'break-word'}}>{li.description}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ----- ATTACHMENTS -----
function Attachments({ docs, onPreview }) {
  if (!docs || !docs.length) return <div style={{color:'#94a3b8',fontSize:12,marginBottom:16}}>{'\u{1F4CE}'} No attachments</div>;
  return (
    <div style={{marginBottom:16}}>
      <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>{'Attachments (' + docs.length + ')'}</h3>
      <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
        {docs.map(function(d,i){
          const name = d.file_name || d.fileName || ('Document ' + (i+1));
          const documentId = d.document_id || d.documentId;
          // Real fix: each attachment now uses its OWN document_id (the
          // real per-file identifier) instead of a shared parent ID -
          // previously every button pointed at the same PO/Bill-level
          // endpoint regardless of which specific file was clicked,
          // which is exactly why every attachment showed the same PDF.
          return (
            <button key={i} onClick={function(){ documentId && onPreview && onPreview({name, documentId}); }}
              disabled={!documentId}
              style={{display:'flex',alignItems:'center',gap:6,background:documentId?'#eff6ff':'#f8fafc',color:documentId?'#1d4ed8':'#94a3b8',border:'1px solid ' + (documentId?'#bfdbfe':'#e2e8f0'),borderRadius:6,padding:'5px 10px',fontSize:12,fontWeight:500,cursor:documentId?'pointer':'default'}}>
              {'\u{1F4CE} ' + name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ----- DETAIL MODAL (PO / BILL / PMO) -----
function DetailModal({ item, type, onClose }) {
  const isBill = type === 'bill', isPMO = type === 'pmo';
  const [fullTextView, setFullTextView] = useState(null); // {label, text} - only used for genuinely long Notes/Terms that would take up too much of the popup inline
  const [attachmentPreview, setAttachmentPreview] = useState(null); // {name, docType, docId} - opens a nested modal with the real PDF embedded
  const [itemDetailsView, setItemDetailsView] = useState(null); // array of line items - opens a nested modal showing every field for each

  // PMO gets 4 sections matching ZB's own real layout exactly, plus a 5th
  // section clearly separated and labeled as this dashboard's own added
  // analysis (comparative fields that don't exist on the PMO itself).
  const pmoSection1Main = [ // General — 6 fields, fits cleanly as 2 rows of 3
    ['PMO Number', item.pmoNumber],['PMO Date', toIndianDate(item.date)],
    ['Payment Category', item.paymentCategory||String.fromCharCode(8212)],['Payment Sub-Category', item.paymentSubCat||String.fromCharCode(8212)],
    ['Payment Type', item.paymentType||String.fromCharCode(8212)],['Payable Amount', fmt(item.amount)],
  ];
  // Attachment (plain) + Payment Terms (ExpandableText, since it can run
  // long) share one row at the exact 1:2 ratio requested — built as raw
  // JSX in the render below since mixing a plain field with an
  // ExpandableText component isn't something InfoGridCustom's generic
  // label/value renderer supports.
  const pmoSection2 = [ // Vendor/Customer — matches ZB exactly, 4 fields
    ['Vendor Name', item.vendor],['Customer Name', item.customerName||String.fromCharCode(8212)],
    ['Expense Account', item.expenseAccount||String.fromCharCode(8212)],['Closing Balance', fmt(item.closingBalance)],
  ];
  const pmoSection4 = [ // To be filled by Finance Team — matches ZB exactly, 2 fields
    ['Payment Date', item.paymentDate?toIndianDate(item.paymentDate):String.fromCharCode(8212)],
    ['Payment Details', item.paymentDetails||String.fromCharCode(8212)],
  ];
  const pmoSection5 = [ // This dashboard's own comparative analysis fields — NOT part of the real PMO
    ['Amt vs Bill', item.amtAgainstBill!=null?fmt(item.amtAgainstBill):String.fromCharCode(8212)],
    ['Amt vs PO', item.amtAgainstPO!=null?fmt(item.amtAgainstPO):String.fromCharCode(8212)],
    ['Amt vs Invoice', item.amtAgainstInvoice!=null?fmt(item.amtAgainstInvoice):String.fromCharCode(8212)],
    ['Amt vs Expense', item.amtAgainstExpense!=null?fmt(item.amtAgainstExpense):String.fromCharCode(8212)],
    ['Submitted By', item.submittedBy||String.fromCharCode(8212)],['Submitted Date', toIndianDate(item.submittedDate)],
  ];

  // PO sections, per the exact real-ZB layout: Part A = 8 real PO fields
  // in the stated order (wraps naturally into 3/3/2 rows via a 3-col
  // grid), Part B = the two addresses at 50:50, Part C = this dashboard's
  // own extra fields not present on the real PO itself.
  const poOptionalFields = [
    ['Requisition', item.requisition],
    ['KCC Recover In Yrs', item.kccRecoverInYrs],
    ['KCC Amount (INR)', item.kccAmount],
    ['Check Status', item.checkStatus],
    ['Shipment Preference', item.shipmentPreference],
  ].filter(pair => pair[1]); // only included when this specific PO actually has a value
  const poSectionA = [
    ['Reference#', item.referenceNumber||String.fromCharCode(8212)],['Order Date', toIndianDate(item.date)],['Delivery Date', toIndianDate(item.deliveryDate)],
    ['Payment Terms', item.paymentTerms||String.fromCharCode(8212)],['Kind Attention', item.kindAttention||String.fromCharCode(8212)],['Subject', item.subject||String.fromCharCode(8212)],
    ['Quotation', item.quotation||String.fromCharCode(8212)],['Project', item.projectLabel||String.fromCharCode(8212)],
    ...poOptionalFields,
  ];
  const poAddressRows = [
    { template:'1fr 1fr', items: [
      ['Vendor Address', item.vendorAddress||String.fromCharCode(8212)],
      ['Delivery Address', item.deliverTo||String.fromCharCode(8212)],
    ]},
  ];
  const poSectionC = [
    ['Vendor', item.vendor],['Vendor GSTIN', item.gstin||String.fromCharCode(8212)],['Total Amount', fmt(item.total)],
    ['Submitted By', item.submittedBy||String.fromCharCode(8212)],['Submitted Date', toIndianDate(item.submittedDate)],['PFB Budget', fmt(item.pfbTotal)],
  ];
  const poSectionCLastRow = [
    { template:'1fr 2fr', items: [
      ['Location', item.locationName||String.fromCharCode(8212)],
      ['Project (PFB Match)', item.projectMatched||'Not matched'],
    ]},
  ];

  // Bill sections, same approach: Part A = 6 real fields + optional ones
  // when present, Part B = Vendor Address full-width, Part C = extras.
  const billOptionalFields = [
    ['Accounts Payable', item.accountsPayable],
    ['Subject', item.billSubject],
  ].filter(pair => pair[1]);
  const billSectionA = [
    // Real bug fixed: Order Number relied entirely on our own PO-matching
    // object resolving, now uses Zoho's own reference_number directly
    // first (what ZB itself displays here), falling back to our matched
    // object only if that's somehow blank.
    ['Order Number', item.orderNumber || (item.linkedPO && item.linkedPO.number) || (item.noPOExpected?'None expected':'None')],
    ['Bill Date', toIndianDate(item.date)],['Due Date', toIndianDate(item.dueDate)],
    ['Payment Terms', item.paymentTerms||String.fromCharCode(8212)],['Balance Due', fmt(item.balance)],['Total', fmt(item.total)],
    ...billOptionalFields,
  ];
  const billAddressRows = [
    { template:'2fr 1fr', items: [
      ['Vendor Address', item.vendorAddress||String.fromCharCode(8212)],
      ['Transaction Posting Date', item.transactionPostingDate ? toIndianDate(item.transactionPostingDate) : String.fromCharCode(8212)],
    ]},
  ];
  const billSectionC = [
    ['Vendor', item.vendor],['Vendor GSTIN', item.gstin||String.fromCharCode(8212)],['PO Amount', item.linkedPO ? fmt(item.linkedPO.total) : String.fromCharCode(8212)],
    ['Submitted By', item.submittedBy||String.fromCharCode(8212)],['Submitted Date', toIndianDate(item.submittedDate)],['Bill Amount', fmt(item.total)],
  ];
  const billSectionCLastRow = [
    { template:'1fr 2fr', items: [
      ['Location', item.locationName||String.fromCharCode(8212)],
      ['Project (PFB Match)', item.projectMatched||'Not matched'],
    ]},
  ];
  const billCustomFieldsRow = [
    ['Original Reference Bill Number', item.originalReferenceBillNumber||String.fromCharCode(8212)],
    ['Project Name', item.billProjectName||String.fromCharCode(8212)],
    ['Bill Type', item.billType||String.fromCharCode(8212)],
  ];

  // Real bug fixed: this previously used item.projectZoho, a SEPARATELY
  // computed backend field that could drift out of sync with what's
  // actually shown in the Items Table below (confirmed: a real Bill
  // showed LE0215_MIRACLE correctly in its Items Table but not here).
  // Now derived directly from the SAME line items the Items Table reads,
  // guaranteeing the two can never disagree.
  const itemsForProjects = item.lineItems || item.line_items || [];
  const projectNames = [...new Set(itemsForProjects.map(li => li.project_name).filter(Boolean))];
  // pos.js stores PFB checks as `lineChecks`, bills.js as `pfbLineChecks` —
  // covering both so the PFB Alignment table doesn't end up silently empty
  // for one of the two types.
  const pfbChecks = item.lineChecks || item.pfbLineChecks;
  const pfbUnavailableReason = item.pfbUnavailableReason;

  return (
    <>
    <Modal onClose={onClose} width={980}
      title={isPMO ? ('PMO ' + item.pmoNumber) : isBill ? ('Bill ' + item.billNumber) : ('PO ' + item.poNumber)}
      subtitle={item.vendor}
      headerExtra={
        <button onClick={async function(){
          const res = await fetch('/api/generate-report', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ item, type: isPMO?'pmo':isBill?'bill':'po' }),
          });
          if (!res.ok) {
            const errText = await res.text().catch(function(){ return 'Unknown error'; });
            alert('Could not generate report: ' + res.status + ' - ' + errText.slice(0, 200));
            return;
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = `Review_Report_${item.poNumber||item.billNumber||item.pmoNumber}.pdf`;
          document.body.appendChild(a); a.click(); a.remove();
          URL.revokeObjectURL(url);
        }} style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:6,padding:'6px 12px',fontSize:12,fontWeight:600,cursor:'pointer'}}>
          {'\u{1F4C4} Download Review Report'}
        </button>
      }>
      {projectNames.length > 0 && (
        <div style={{background:'#f0f9ff',border:'1px solid #bae6fd',borderRadius:8,padding:'10px 14px',marginBottom:14}}>
          <div style={{fontSize:10,color:'#0369a1',fontWeight:700,letterSpacing:'0.08em',marginBottom:6}}>PROJECT(S) IN ZOHO</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:'6px 16px'}}>
            {projectNames.map(function(n,i){
              return <div key={i} style={{fontSize:13,color:'#0f172a',fontWeight:500,wordBreak:'break-word'}}>{n}</div>;
            })}
          </div>
        </div>
      )}
      {isPMO ? (
        <>
          <InfoGrid fields={pmoSection1Main} cols={3}/>
          <div style={{background:'#f8fafc',borderRadius:10,padding:'14px 18px',marginBottom:16}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 2fr',gap:20,marginBottom:10}}>
              <div>
                <div style={{fontSize:11,color:'#94a3b8',fontWeight:700,letterSpacing:'0.08em',marginBottom:2}}>PI/BILL ATTACHMENT</div>
                <div style={{fontSize:14,color:'#0f172a',fontWeight:500,wordBreak:'break-word'}}>{item.attachmentName || item.attachmentId || 'None'}</div>
              </div>
              <ExpandableText label="Payment Terms" text={item.paymentTerms} onExpandFull={function(){setFullTextView({label:'Payment Terms',text:item.paymentTerms});}}/>
            </div>
            <ExpandableText label="Remarks" text={item.remarks} onExpandFull={function(){setFullTextView({label:'Remarks',text:item.remarks});}}/>
          </div>
          <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>Vendor/Customer</h3>
          <InfoGrid fields={pmoSection2} cols={2}/>
          {item.poBreakup && item.poBreakup.length>0 && <POBreakupTable rows={item.poBreakup} kind="po"/>}
          {item.expenseBreakup && item.expenseBreakup.length>0 && <POBreakupTable rows={item.expenseBreakup} kind="expense"/>}
          <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>To be filled by Finance Team</h3>
          <InfoGridCustom rows={[{ template:'1fr 2fr', items: pmoSection4 }]}/>
          <h3 style={{fontSize:13,fontWeight:700,color:'#7c3aed',marginBottom:8}}>Additional Analysis</h3>
          <InfoGrid fields={pmoSection5} cols={3}/>
        </>
      ) : isBill ? (
        <>
          <InfoGrid fields={billSectionA} cols={3}/>
          <InfoGridCustom rows={billAddressRows}/>
          <InfoGrid fields={billSectionC} cols={3}/>
          <InfoGridCustom rows={billSectionCLastRow}/>
        </>
      ) : (
        <>
          <InfoGrid fields={poSectionA} cols={3}/>
          <InfoGridCustom rows={poAddressRows}/>
          <InfoGrid fields={poSectionC} cols={3}/>
          <InfoGridCustom rows={poSectionCLastRow}/>
        </>
      )}
      <ItemsTable items={item.lineItems || item.line_items} title="Line Items" subTotal={item.subTotal} taxes={item.taxes} total={item.total}
        discount={item.discount} discountFormatted={item.discountFormatted} adjustment={item.adjustment} adjustmentDescription={item.adjustmentDescription}
        onItemDetails={!isPMO ? setItemDetailsView : undefined}/>
      {isBill ? (
        <>
          <div style={{background:'#f8fafc',borderRadius:10,padding:'14px 18px',marginBottom:16}}>
            <ExpandableText label="Notes" text={item.notes} onExpandFull={function(){setFullTextView({label:'Notes',text:item.notes});}}/>
          </div>
          <h3 style={{fontSize:13,fontWeight:700,color:'#0f172a',marginBottom:8}}>Custom Fields</h3>
          <InfoGrid fields={billCustomFieldsRow} cols={3}/>
        </>
      ) : (
        <div style={{background:'#f8fafc',borderRadius:10,padding:'14px 18px',marginBottom:16}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
            <ExpandableText label="Notes" text={item.notes} onExpandFull={function(){setFullTextView({label:'Notes',text:item.notes});}}/>
            <ExpandableText label="Terms & Conditions" text={item.terms} onExpandFull={function(){setFullTextView({label:'Terms & Conditions',text:item.terms});}}/>
          </div>
        </div>
      )}
      <RecBox rec={item.recommendation}/>
      <CompTable checks={item.compliance} title={(isPMO?'PMO':isBill?'Bill':'PO') + ' Compliance Checks'}/>
      {!isPMO && pfbChecks && pfbChecks.length>0 && <PFBAlignmentTable checks={pfbChecks} title="PFB Alignment - Line by Line"/>}
      {!isPMO && (!pfbChecks || pfbChecks.length===0) && pfbUnavailableReason && (
        <div style={{background:'#fff7ed',border:'1px solid #fed7aa',borderRadius:8,padding:'10px 14px',marginBottom:20,fontSize:13,color:'#9a3412'}}>
          <b>PFB Alignment not available:</b> {pfbUnavailableReason}
        </div>
      )}
      {isBill && item.poLineChecks && item.poLineChecks.length>0 && <POMatchTable checks={item.poLineChecks} title="PO Match - Line by Line"/>}
      {!isPMO && <ReferenceRateTable checks={item.referenceRateChecks}/>}
      {isPMO && item.alignment && item.alignment.checks && item.alignment.checks.length>0 && <CompTable checks={item.alignment.checks} title="PI / Bill Alignment"/>}
      {isPMO ? (
        item.attachmentId
          ? <div style={{marginBottom:16}}>
              <h3 style={{fontSize:14,fontWeight:700,color:'#0f172a',marginBottom:8}}>Attachments (1)</h3>
              <button onClick={function(){ setAttachmentPreview({name: item.attachmentName || 'PI/Bill attachment', documentId: item.attachmentId}); }}
                style={{display:'inline-flex',alignItems:'center',gap:6,background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',borderRadius:6,padding:'5px 10px',fontSize:13,fontWeight:500,cursor:'pointer'}}>
                {'\u{1F4CE} ' + (item.attachmentName || 'PI/Bill — ref ' + item.attachmentId)}
              </button>
            </div>
          : <Attachments docs={null}/>
      ) : (
        <Attachments docs={item.attachments || item.docs || item.documents} onPreview={setAttachmentPreview}/>
      )}
    </Modal>
    {fullTextView && (
      <Modal onClose={function(){setFullTextView(null);}} width={640} title={fullTextView.label} zIndex={1100}>
        <div style={{fontSize:14,color:'#0f172a',lineHeight:1.6,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{fullTextView.text}</div>
      </Modal>
    )}
    {attachmentPreview && (
      <Modal onClose={function(){setAttachmentPreview(null);}} width={800} title={attachmentPreview.name} zIndex={1100}>
        <iframe
          src={`/api/attachment-proxy?documentId=${attachmentPreview.documentId}`}
          style={{width:'100%',height:'70vh',border:'1px solid #e2e8f0',borderRadius:8}}
          title={attachmentPreview.name}
        />
        <div style={{marginTop:8,textAlign:'right'}}>
          <a href={`/api/attachment-proxy?documentId=${attachmentPreview.documentId}`} target="_blank" rel="noreferrer" style={{fontSize:12,color:'#2563eb'}}>
            Open in new tab / download
          </a>
        </div>
      </Modal>
    )}
    {itemDetailsView && (
      <Modal onClose={function(){setItemDetailsView(null);}} width={1100} title="Item Details" zIndex={1100}>
        <ItemDetailsTable items={itemDetailsView}/>
      </Modal>
    )}
    </>
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

  const fetchPOs = useCallback(async function(forceRefresh){
    setLoading(function(p){ return Object.assign({},p,{pos:true}); });
    try {
      const r = await fetch('/api/pos' + (forceRefresh ? '?refresh=1' : ''));
      const d = await r.json();
      if (d.success) { setPOs(d.data); setLastSync(new Date()); setErrors(function(p){ return Object.assign({},p,{pos:null}); }); }
      else setErrors(function(p){ return Object.assign({},p,{pos:d.error||'Failed to load POs'}); });
    } catch (e) { setErrors(function(p){ return Object.assign({},p,{pos:e.message}); }); }
    setLoading(function(p){ return Object.assign({},p,{pos:false}); });
  }, []);

  const fetchBills = useCallback(async function(forceRefresh){
    setLoading(function(p){ return Object.assign({},p,{bills:true}); });
    try {
      const r = await fetch('/api/bills' + (forceRefresh ? '?refresh=1' : ''));
      const d = await r.json();
      if (d.success) { setBills(d.data); setErrors(function(p){ return Object.assign({},p,{bills:null}); }); }
      else setErrors(function(p){ return Object.assign({},p,{bills:d.error||'Failed to load Bills'}); });
    } catch (e) { setErrors(function(p){ return Object.assign({},p,{bills:e.message}); }); }
    setLoading(function(p){ return Object.assign({},p,{bills:false}); });
  }, []);

  const fetchPMOs = useCallback(async function(forceRefresh){
    setLoading(function(p){ return Object.assign({},p,{pmos:true}); });
    try {
      const r = await fetch('/api/pmos' + (forceRefresh ? '?refresh=1' : ''));
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
    // Page load/reload: serve from whatever's cached server-side — this
    // costs zero Zoho calls once a cache exists (see lib/zoho.js / pmos.js).
    // Only the Refresh button (forceRefresh=true) or this 24-hour timer
    // actually pulls fresh data from Zoho.
    fetchPOs(false); fetchBills(false); fetchPMOs(false); fetchProjects();
    const iv = setInterval(function(){ fetchPOs(true); fetchBills(true); fetchPMOs(true); }, 24*60*60*1000);
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
        // scrollbar-gutter:stable reserves the scrollbar's space on every
        // tab regardless of whether that tab's content is tall enough to
        // need one — this is what stops the page (and therefore the top 8
        // cards) from changing width every time a shorter tab like Solar
        // Parks removes the scrollbar. It does NOT force a scrollbar to
        // show when one isn't needed — a short tab still shows none, only
        // the space for one is always reserved so nothing shifts.
        'html{scrollbar-gutter:stable}' +
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
            <div style={{width:32,height:32,background:'#1d4ed8',borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:17}}>{'\u26A1'}</div>
            <div>
              <div style={{fontWeight:800,fontSize:15,color:'#0f172a',letterSpacing:'-0.02em'}}>Finance Control Dashboard</div>
              <div style={{fontSize:11,color:'#94a3b8'}}>Rays Power Experts Ltd.</div>
            </div>
          </div>

          {/* True-centered regardless of how wide the side elements are */}
          <div style={{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',display:'flex',alignItems:'center',gap:14}}>
            {totalFlag>0 && <div style={{background:'#fee2e2',color:'#b91c1c',padding:'3px 12px',borderRadius:20,fontSize:12,fontWeight:700,border:'1px solid #fca5a5',whiteSpace:'nowrap'}}>{totalFlag} need attention</div>}
            {lastSync && <div style={{fontSize:12,color:'#94a3b8',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}}><span style={{width:6,height:6,borderRadius:'50%',background:'#22c55e',display:'inline-block'}}/>Live - {lastSync.toLocaleTimeString()}</div>}
            <div style={{fontSize:13,color:'#64748b',fontWeight:500,whiteSpace:'nowrap'}}>For - Jatin Srivastava</div>
          </div>

          {/* Developer credit - permanent, per explicit request */}
          <div style={{textAlign:'right',lineHeight:1.3,flexShrink:0}}>
            <div style={{fontSize:11,fontWeight:700,color:'#0f172a',whiteSpace:'nowrap'}}>Developed by: ASHISH KASWAN</div>
            <div style={{fontSize:10,color:'#94a3b8',whiteSpace:'nowrap'}}>Business Analyst, Finance Control</div>
          </div>
        </div>

        <div style={{padding:'14px 24px',display:'grid',gridTemplateColumns:'repeat(8,1fr)',gap:9}}>
          <Card label="POs PENDING" icon={'\u{1F4CB}'} value={pos.length} sub={fmt(poValue)} color="#f59e0b"/>
          <Card label="PO ISSUES" icon={'\u26A0\uFE0F'} value={poIssues} sub="compliance / alignment" color="#f97316"/>
          <Card label="BILLS PENDING" icon={'\u{1F9FE}'} value={bills.length} sub={fmt(billValue)} color="#8b5cf6"/>
          <Card label="BILL ISSUES" icon={'\u26A0\uFE0F'} value={billIssues} sub="compliance / alignment" color="#ef4444"/>
          <Card label="PMOs PENDING" icon={'\u{1F4B3}'} value={pmos.length} sub={fmt(pmoValue)} color="#0ea5e9"/>
          <Card label="PMO ISSUES" icon={'\u26A0\uFE0F'} value={pmoIssues} sub={'of ' + pmos.length + ' PMOs'} color="#ef4444"/>
          <Card label="PROJECTS" icon={'\u{1F31E}'} value={projects.length} sub={parks.length + ' solar parks'} color="#10b981"/>
          <Card label="TOTAL PENDING" icon={'\u{1F4CC}'} value={totalPendingCount} sub={fmt(totalPendingValue)} color="#dc2626"/>
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
                <button onClick={function(){ if(tab==='pos') fetchPOs(true); else if(tab==='bills') fetchBills(true); else fetchPMOs(true); }} style={{background:'#f8fafc',color:'#475569',border:'1px solid #e2e8f0',borderRadius:7,padding:'5px 11px',cursor:'pointer',fontSize:12}}>{'\u{1F504} Refresh'}</button>
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
              <ErrorBanner message={errors.pos} onRetry={function(){fetchPOs(true);}}/>
              {loading.pos ? <Spinner label="Loading POs from Zoho Books..."/> : (
                <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse'}}>
                      <thead><tr>
                        {['PO Number','Date','Vendor','Project','Amount','Compliance','Alignment','Recommendation',''].map(function(h){ return <th key={h} style={(h==='Vendor'||h==='Amount')?Object.assign({},TH,{borderRight:'1.5px solid #cbd5e1'}):TH}>{h}</th>; })}
                      </tr></thead>
                      <tbody>
                        {sortByDate(pos,'date').map(function(po){
                          return (
                            <tr key={po.id} style={{borderBottom:'1px solid #f1f5f9',background:rowBg(po)}} onClick={function(){setSelected({item:po,type:'po'});}}>
                              <td style={Object.assign({},TD,{color:'#1d4ed8',fontWeight:700})}>{po.poNumber}</td>
                              <td style={Object.assign({},TD,{color:'#64748b'})}>{toIndianDate(po.date)}</td>
                              <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:500,maxWidth:160,whiteSpace:'normal',borderRight:'1.5px solid #cbd5e1'})}>{po.vendor}</td>
                              <td style={TD}><ProjectCodes names={po.projectZoho}/></td>
                              <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:700,borderRight:'1.5px solid #cbd5e1'})}>{fmt(po.total)}</td>
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
              <ErrorBanner message={errors.bills} onRetry={function(){fetchBills(true);}}/>
              {loading.bills ? <Spinner label="Loading Bills from Zoho Books..."/> : (
                <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',tableLayout:'fixed'}}>
                      <colgroup>
                        <col style={{width:'13%'}}/><col style={{width:'8%'}}/><col style={{width:'13%'}}/><col style={{width:'12%'}}/>
                        <col style={{width:'8%'}}/><col style={{width:'9%'}}/><col style={{width:'8%'}}/><col style={{width:'8%'}}/><col style={{width:'11%'}}/><col style={{width:'10%'}}/>
                      </colgroup>
                      <thead><tr>
                        {['Bill Number','Date','Vendor','Project','Amount','Linked PO','Compliance','Alignment','Recommendation',''].map(function(h){ return <th key={h} style={(h==='Vendor'||h==='Linked PO')?Object.assign({},TH,{borderRight:'1.5px solid #cbd5e1'}):TH}>{h}</th>; })}
                      </tr></thead>
                      <tbody>
                        {sortByDate(bills,'date').map(function(b){
                          return (
                            <tr key={b.id} style={{borderBottom:'1px solid #f1f5f9',background:rowBg(b)}} onClick={function(){setSelected({item:b,type:'bill'});}}>
                              <td style={Object.assign({},TD,{color:'#7c3aed',fontWeight:700,whiteSpace:'normal',wordBreak:'break-word',overflowWrap:'anywhere'})}>{(b.billNumber||'').replace(/\//g,'/\u200B')}</td>
                              <td style={Object.assign({},TD,{color:'#64748b'})}>{toIndianDate(b.date)}</td>
                              <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:500,whiteSpace:'normal',borderRight:'1.5px solid #cbd5e1'})}>{b.vendor}</td>
                              <td style={Object.assign({},TD,{whiteSpace:'normal'})}><ProjectCodes names={b.projectZoho}/></td>
                              <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:700})}>{fmt(b.total)}</td>
                              <td style={Object.assign({},TD,{color:'#64748b',fontSize:12,borderRight:'1.5px solid #cbd5e1'})}>{(b.linkedPO && b.linkedPO.number) || (b.noPOExpected?'None expected':String.fromCharCode(8212))}</td>
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
              <ErrorBanner message={errors.pmos} onRetry={function(){fetchPMOs(true);}}/>
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
                          {['PMO Number','Date','Vendor/Payee','Amount','Payment Type','Project','Compliance','Alignment','Recommendation',''].map(function(h){ return <th key={h} style={(h==='Vendor/Payee'||h==='Project')?Object.assign({},TH,{borderRight:'1.5px solid #cbd5e1'}):TH}>{h}</th>; })}
                        </tr></thead>
                        <tbody>
                          {sortByDate(pmos,'date').map(function(p){
                            return (
                              <tr key={p.id} style={{background:p.complianceStatus!=='pass'?'#fefce8':'#fff',borderBottom:'1px solid #f1f5f9'}} onClick={function(){setSelected({item:p,type:'pmo'});}}>
                                <td style={Object.assign({},TD,{color:'#0369a1',fontWeight:700})}>{p.pmoNumber}</td>
                                <td style={Object.assign({},TD,{color:'#64748b'})}>{toIndianDate(p.date)}</td>
                                <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:500,maxWidth:160,whiteSpace:'normal',borderRight:'1.5px solid #cbd5e1'})}>{p.vendor}</td>
                                <td style={Object.assign({},TD,{color:'#0f172a',fontWeight:700})}>{fmt(p.amount)}</td>
                                <td style={Object.assign({},TD,{color:'#475569',fontSize:12})}>{p.payTypeLabel||String.fromCharCode(8212)}</td>
                                <td style={Object.assign({},TD,{color:'#475569',fontSize:12,borderRight:'1.5px solid #cbd5e1'})}>{p.project||String.fromCharCode(8212)}</td>
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
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:14,marginBottom:14,flexWrap:'wrap',background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,padding:'10px 18px'}}>
                <span style={{fontSize:11,color:'#94a3b8',fontWeight:700,letterSpacing:'0.06em',whiteSpace:'nowrap'}}>RATE/Wp LEGEND</span>
                {[
                  ['< Rs. 25', 'Green', 'Safe', '#22c55e'],
                  ['Rs. 25 - 30', 'Yellow', 'Little High', '#eab308'],
                  ['Rs. 30 - 35', 'Orange', 'High', '#f97316'],
                  ['>= Rs. 35', 'Red', 'Very High', '#ef4444'],
                ].map(function(item){
                  return (
                    <span key={item[0]} style={{display:'flex',alignItems:'center',gap:7,fontSize:12,color:'#475569',whiteSpace:'nowrap'}}>
                      <span style={{width:11,height:11,borderRadius:3,background:item[3],display:'inline-block',flexShrink:0}}/>
                      <span><b>{item[1]}</b>: {item[0]} [{item[2]}]</span>
                    </span>
                  );
                })}
              </div>
              {loading.projects ? <Spinner/> : (
                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(250px,1fr))',gap:11}}>
                  {sortByEndDateDescClient(projects).map(function(p){
                    const rc = rateColor(p.ratePerWp);
                    return (
                      <div key={p.id} onClick={function(){startPFB(p);}}
                        style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:'15px 16px',cursor:'pointer',transition:'all 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.04)'}}
                        onMouseEnter={function(e){e.currentTarget.style.borderColor='#1d4ed8';e.currentTarget.style.boxShadow='0 4px 12px rgba(29,78,216,0.1)';}}
                        onMouseLeave={function(e){e.currentTarget.style.borderColor='#e2e8f0';e.currentTarget.style.boxShadow='0 1px 3px rgba(0,0,0,0.04)';}}>
                        <div style={{fontWeight:700,color:'#0f172a',fontSize:14,marginBottom:3}}>{p.name}</div>
                        <div style={{fontSize:11,color:'#94a3b8',marginBottom:9}}>{dashDate(p.endDate)||'No date'} - {p.park}</div>
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
                <div style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}>
                  {/* Frozen header — labels apply to the sub-lines (individual
                      projects) below each firm row, not the firm row itself.
                      Real bug fixed here: the parent container previously had
                      overflow:hidden, which clips a sticky element before it
                      ever gets the chance to stick — removed that so this
                      header actually appears and stays fixed while scrolling.
                      Columns also widened + given a real gap, since 70px was
                      not enough room for "SWITCHYARDS" as a header word or
                      "4 SY" + a full rupee figure as data, which is what
                      caused them to visually overlap. */}
                  <div style={{display:'grid',gridTemplateColumns:'30px 2fr 1.1fr 0.9fr 0.9fr 0.9fr 1fr 1.3fr 1fr',columnGap:14,alignItems:'center',padding:'10px 16px',paddingLeft:38,background:'#eff6ff',borderBottom:'1.5px solid #dbeafe',position:'sticky',top:58,zIndex:150,borderRadius:'12px 12px 0 0'}}>
                    {['','Project Name','Solar Park','DC Cap.','AC Cap.','BESS Cap.','SwitchYards','Total Budget','End Date'].map(function(h,hi){
                      return <span key={hi} style={{fontSize:10,fontWeight:700,color:'#1e40af',letterSpacing:'0.04em',whiteSpace:'nowrap'}}>{h.toUpperCase()}</span>;
                    })}
                  </div>
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
                              style={{display:'grid',gridTemplateColumns:'30px 2fr 1.1fr 0.9fr 0.9fr 0.9fr 1fr 1.3fr 1fr',columnGap:14,alignItems:'center',padding:'9px 16px',paddingLeft:38,borderBottom:'1px solid #f8fafc',cursor:'pointer',background:'#fff'}}
                              onMouseEnter={function(e){e.currentTarget.style.background='#f8fafc';}} onMouseLeave={function(e){e.currentTarget.style.background='#fff';}}>
                              <span style={{fontSize:10,color:'#cbd5e1'}}>{'-'}</span>
                              <span style={{fontSize:13,color:'#334155',fontWeight:500}}>{p.name}</span>
                              <span style={{fontSize:11,color:'#64748b'}}>{p.park}</span>
                              <span style={{fontSize:12,color:'#1d4ed8',fontWeight:600}}>{p.dc?(p.dc + ' MWp'):String.fromCharCode(8212)}</span>
                              <span style={{fontSize:12,color:'#15803d',fontWeight:600}}>{p.ac?(p.ac + ' MW'):String.fromCharCode(8212)}</span>
                              <span style={{fontSize:11,color:'#a16207'}}>{p.bess?(p.bess + ' MWh'):String.fromCharCode(8212)}</span>
                              <span style={{fontSize:11,color:'#64748b'}}>{p.sw?(p.sw + ' SY'):String.fromCharCode(8212)}</span>
                              <span style={{fontSize:12,color:'#0f172a',fontWeight:700}}>{p.pfbTotal?fmt(p.pfbTotal):String.fromCharCode(8212)}</span>
                              <span style={{fontSize:11,color:'#64748b'}}>{dashDate(p.endDate)||String.fromCharCode(8212)}</span>
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

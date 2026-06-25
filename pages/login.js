// pages/login.js
import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

export default function Login() {
  const router = useRouter();
  const [userId, setUserId]   = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, password }),
      });
      const data = await res.json();
      if (data.success) {
        const from = router.query.from || '/';
        window.location.href = from; // full reload so middleware re-checks cookie
      } else {
        setError(data.error || 'Login failed');
      }
    } catch {
      setError('Something went wrong — try again');
    }
    setLoading(false);
  };

  return (
    <>
      <Head><title>Login — Finance Control Dashboard</title></Head>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#0f172a;font-family:'Segoe UI',system-ui,sans-serif}
      `}</style>
      <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
        <form onSubmit={submit} style={{background:'#fff',borderRadius:16,padding:'36px 32px',width:'100%',maxWidth:380,boxShadow:'0 24px 64px rgba(0,0,0,0.4)'}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:24}}>
            <div style={{width:36,height:36,background:'#1d4ed8',borderRadius:9,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:900,fontSize:16}}>⚡</div>
            <div>
              <div style={{fontWeight:800,fontSize:16,color:'#0f172a'}}>Finance Control</div>
              <div style={{fontSize:11,color:'#94a3b8'}}>Rays Power Experts Ltd.</div>
            </div>
          </div>

          <label style={{fontSize:11,fontWeight:700,color:'#64748b',display:'block',marginBottom:5}}>USER ID</label>
          <input value={userId} onChange={e=>setUserId(e.target.value)} autoFocus
            style={{width:'100%',border:'1.5px solid #e2e8f0',borderRadius:8,padding:'10px 12px',fontSize:14,marginBottom:14,outline:'none'}}
            onFocus={e=>e.target.style.borderColor='#1d4ed8'} onBlur={e=>e.target.style.borderColor='#e2e8f0'}/>

          <label style={{fontSize:11,fontWeight:700,color:'#64748b',display:'block',marginBottom:5}}>PASSWORD</label>
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
            style={{width:'100%',border:'1.5px solid #e2e8f0',borderRadius:8,padding:'10px 12px',fontSize:14,marginBottom:18,outline:'none'}}
            onFocus={e=>e.target.style.borderColor='#1d4ed8'} onBlur={e=>e.target.style.borderColor='#e2e8f0'}/>

          {error && <div style={{background:'#fff1f2',color:'#dc2626',border:'1px solid #fecaca',borderRadius:8,padding:'8px 12px',fontSize:12,marginBottom:14}}>{error}</div>}

          <button type="submit" disabled={loading}
            style={{width:'100%',background:'#1d4ed8',color:'#fff',border:'none',borderRadius:8,padding:'11px',cursor:'pointer',fontWeight:700,fontSize:14,opacity:loading?0.7:1}}>
            {loading ? 'Checking…' : 'Sign In'}
          </button>
        </form>
      </div>
    </>
  );
}

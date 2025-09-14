const PRIZES=['Porte-clés','Pare-soleil','Casquette','Support téléphone','Repose-tête','Pins']; 
const ICONS=['🔑','🌞','🧢','📱','🛏️','📌']; 
const PRIZE_IMAGES={
  'Porte-clés':'/img/goodies/porte-cles.png',
  'Pare-soleil':'/img/goodies/pare-soleil.png',
  'Casquette':'/img/goodies/casquette.png',
  'Support téléphone':'/img/goodies/support-telephone.png',
  'Repose-tête':'/img/goodies/repose-tete.png',
  'Pins':'/img/goodies/pins.png'
};
const loadedImgs={};
function loadPrizeImages(){
  return Promise.all(Object.entries(PRIZE_IMAGES).map(([k,src])=>new Promise((resolve)=>{
    const im=new Image(); im.onload=()=>{loadedImgs[k]=im; resolve();}; im.onerror=()=>resolve(); im.src=src;
  })));
}
let centerGiftImg=null; function loadCenterGift(){return new Promise((resolve)=>{const im=new Image(); im.onload=()=>{centerGiftImg=im; resolve();}; im.onerror=()=>resolve(); im.src='/img/gift.svg';});}
const TAU=Math.PI*2;
function getQuery(name){const url=new URL(window.location.href);return url.searchParams.get(name);}
const canvas=document.getElementById('wheel'); const ctx=canvas.getContext('2d'); const spinBtn=document.getElementById('spinBtn'); const resultEl=document.getElementById('result'); const nextBtn=document.getElementById('nextBtn'); let currentAngle=0; let spinning=false;
const entry_id = getQuery('entry_id'); const spunKey='spun_'+entry_id; const spunKey2='spun2_'+entry_id; const HAS_SPUN=()=>Boolean(entry_id && (localStorage.getItem(spunKey2) || localStorage.getItem(spunKey))); const MARK_SPUN=()=>{ if(entry_id){ localStorage.setItem(spunKey2,'1'); localStorage.setItem(spunKey,'1'); } };
function sliceFill(i,r){const g=ctx.createLinearGradient(-r,-r,r,r); const hues=[['#eaf1ff','#cfe1ff'],['#e3f7ff','#bfe9ff'],['#e9f5ff','#cfeaff'],['#edf3ff','#d7e6ff'],['#e6f2ff','#c9e3ff'],['#eaf1ff','#cfe1ff']]; const p=hues[i%hues.length]; g.addColorStop(0,p[0]); g.addColorStop(1,p[1]); return g;}
function drawWheel(a){const r=canvas.width/2-10; ctx.clearRect(0,0,canvas.width, canvas.height); ctx.save(); ctx.translate(canvas.width/2, canvas.height/2); ctx.rotate(a); const s=TAU/PRIZES.length; for(let i=0;i<PRIZES.length;i++){ ctx.beginPath(); ctx.moveTo(0,0); ctx.arc(0,0,r,i*s,(i+1)*s); ctx.closePath(); ctx.fillStyle=sliceFill(i,r); ctx.strokeStyle='#ffffff'; ctx.lineWidth=2; ctx.fill(); ctx.stroke(); ctx.save(); ctx.rotate(i*s + s/2); ctx.textAlign='center'; if(loadedImgs[PRIZES[i]]){ const im=loadedImgs[PRIZES[i]]; const ww=70, hh=70; ctx.drawImage(im, r*0.70 - ww/2, -hh/2, ww, hh); } else { ctx.fillStyle='#0a2a66'; ctx.font='32px system-ui, Segoe UI Emoji, Noto Color Emoji, Apple Color Emoji, sans-serif'; ctx.fillText(ICONS[i], r*0.62, 10); } ctx.restore(); } ctx.restore(); ctx.save(); ctx.translate(canvas.width/2, 18); ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-12,28); ctx.lineTo(12,28); ctx.closePath(); ctx.fillStyle='#0a2a66'; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle='#ffffff'; ctx.stroke(); ctx.restore(); ctx.save(); ctx.translate(canvas.width/2, canvas.height/2); ctx.beginPath(); ctx.arc(0,0,58,0,TAU); const g=ctx.createRadialGradient(0,0,10,0,0,60); g.addColorStop(0,'#ffffff'); g.addColorStop(1,'#e7eefb'); ctx.fillStyle=g; ctx.fill(); ctx.strokeStyle='#dfe7fb'; ctx.stroke(); if(centerGiftImg){ const maxR=65; const ratio=centerGiftImg.width/Math.max(1,centerGiftImg.height); let w,h; if(ratio>=1){ w=maxR*2*0.92; h=w/ratio; } else { h=maxR*2*0.92; w=h*ratio; } ctx.drawImage(centerGiftImg, -w/2, -h/2, w, h);} ctx.restore(); }
function computeDestination(index){const s=TAU/PRIZES.length; const targetCenter=-Math.PI/2; const desired=targetCenter - (index + 0.5)*s; const turns=6*TAU; const diff=(desired - currentAngle) % TAU; const delta = diff < 0 ? diff + TAU : diff; return currentAngle + turns + delta;}
Promise.all([loadPrizeImages(), loadCenterGift()]).then(()=>drawWheel(currentAngle));
async function postJSON(url,data){const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); if(!res.ok) throw new Error(await res.text()); return res.json();}

// One-time migration of old 'spun_' keys (keep spun2_)
document.addEventListener('DOMContentLoaded', ()=>{ try{ if(!localStorage.getItem('migrated_spun_v2')){ Object.keys(localStorage).filter(k=>/^spun_/.test(k)).forEach(k=>{ if(!/^spun2_/.test(k)) localStorage.removeItem(k); }); localStorage.setItem('migrated_spun_v2','1'); } }catch(e){} });

spinBtn.addEventListener('click', async ()=>{ 
  if(spinning) return; 
  if(!entry_id){alert('Lien invalide'); return;} 
  if(HAS_SPUN()){ 
    try{ 
      const resp=await postJSON('/api/spin',{entry_id}); 
      const prize=resp.prize; 
      const idx=PRIZES.indexOf(prize); 
      if(idx>=0){ 
        currentAngle=computeDestination(idx); 
        drawWheel(currentAngle); 
        resultEl.style.display='inline-flex'; 
        const img=loadedImgs[prize]; 
        resultEl.innerHTML=(img?`<img class="thumb" src="${PRIZE_IMAGES[prize]}" alt="${prize}"/>`:'') + `Déjà participé — lot: "<span class="prize-name">${prize}</span>"`; 
        if(nextBtn){ nextBtn.style.display='inline-block'; }
      } 
    }catch(e){} 
    return; 
  } 
  spinning=true; spinBtn.disabled=true; 
  let serverPrize; 
  try{ const resp=await postJSON('/api/spin',{entry_id}); serverPrize=resp.prize; }catch(e){ alert('Erreur serveur pour le tirage.'); spinning=false; spinBtn.disabled=false; return; } 
  const index=PRIZES.indexOf(serverPrize); if(index<0){ alert('Lot inconnu'); return; } 
  const dest=computeDestination(index); const start=currentAngle; let startTs=null; const dur=4400; 
  function anim(ts){ 
    if(!startTs) startTs=ts; 
    const t=Math.min(1,(ts-startTs)/dur); 
    const eased=1-Math.pow(1-t,3); 
    currentAngle=start+(dest-start)*eased; 
    drawWheel(currentAngle); 
    if(t<1) requestAnimationFrame(anim); 
    else{ 
      currentAngle=dest; drawWheel(currentAngle); 
      spinning=false; MARK_SPUN(); 
      resultEl.style.display='inline-flex'; 
      const img=loadedImgs[serverPrize]; 
      resultEl.innerHTML=(img?`<img class="thumb" src="${PRIZE_IMAGES[serverPrize]}" alt="${serverPrize}"/>`:'') + 'Félicitations ! 🎉 vous avez gagné "<span class="prize-name">'+serverPrize+'</span>"'; 
      if(nextBtn){ nextBtn.style.display='inline-block'; }
    } 
  } 
  requestAnimationFrame(anim); 
});

if(nextBtn){ nextBtn.addEventListener('click', ()=>{ window.location.href='/index.html'; }); }
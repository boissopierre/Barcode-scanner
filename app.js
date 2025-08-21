/* === UI améliorée + appel caméra d'origine ===
   - On reprend exactement le pattern : listVideoInputDevices() -> decodeFromVideoDevice(selectedDeviceId, video, callback)
   - Ajouts : Démarrer/Pause/Arrêter, son/vibration, historique (copier/partager/ouvrir), export CSV, badge format, torche si dispo
*/

let selectedDeviceId = null;
const codeReader = new ZXing.BrowserMultiFormatReader();

const els = {
  video: document.getElementById('video'),
  status: document.getElementById('status'),
  result: document.getElementById('result'),
  history: document.getElementById('history'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  torchBtn: document.getElementById('torchBtn'),
  copyBtn: document.getElementById('copyBtn'),
  openBtn: document.getElementById('openBtn'),
  shareBtn: document.getElementById('shareBtn'),
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
  soundToggle: document.getElementById('soundToggle'),
  vibrateToggle: document.getElementById('vibrateToggle'),
};

let isRunning = false;
let isPaused = false;
let lastText = null; let lastAt = 0;
const DEBOUNCE_MS = 1200; const HISTORY_MAX = 30;
const history = loadHistory();
renderHistory();

// Préparer et détecter les caméras (sans démarrer le flux)
codeReader
  .listVideoInputDevices()
  .then(videoInputDevices => {
    selectedDeviceId = videoInputDevices[0]?.deviceId || null;
    if (!selectedDeviceId) {
      setStatus('Aucune caméra détectée.', true);
      return;
    }
    setStatus('Prêt. Clique « Démarrer ».');
    els.startBtn.disabled = false;
  })
  .catch(err => {
    console.error(err);
    setStatus("Erreur d'accès à la caméra.", true);
  });

// Boutons UI
els.startBtn.addEventListener('click', start);
els.pauseBtn.addEventListener('click', () => (isPaused ? resume() : pause()));
els.stopBtn.addEventListener('click', stop);
els.torchBtn.addEventListener('click', toggleTorch);
els.copyBtn.addEventListener('click', copyResult);
els.openBtn.addEventListener('click', openResult);
els.shareBtn.addEventListener('click', shareResult);
els.exportBtn.addEventListener('click', exportCSV);
els.clearBtn.addEventListener('click', clearHistoryUI);

document.addEventListener('visibilitychange', () => { if (document.hidden && isRunning) pause(); });
window.addEventListener('beforeunload', () => stop());

/* ---------- Démarrer / Pause / Arrêter ---------- */

function start() {
  if (isRunning || !selectedDeviceId) return;
  try {
    codeReader.decodeFromVideoDevice(selectedDeviceId, els.video, onDecode);
    isRunning = true; isPaused = false; uiRunning(); setStatus('Scan en cours…');
    // la torche peut être activée si la caméra le permet
    setTimeout(updateTorchAvailability, 400);
  } catch (err) {
    handleError(err, "Impossible de démarrer le flux vidéo.");
  }
}

function pause() {
  if (!isRunning || isPaused) return;
  isPaused = true;
  codeReader.reset(); // stoppe le décodage (et libère le flux selon ZXing)
  els.pauseBtn.textContent = 'Reprendre';
  setStatus('En pause.');
}

function resume() {
  if (!isRunning || !isPaused) return;
  isPaused = false;
  codeReader.decodeFromVideoDevice(selectedDeviceId, els.video, onDecode);
  els.pauseBtn.textContent = 'Pause';
  setStatus('Scan en cours…');
  setTimeout(updateTorchAvailability, 400);
}

function stop() {
  if (!isRunning && !els.video.srcObject) return;
  try { codeReader.reset(); } catch {}
  if (els.video.srcObject) {
    try { els.video.srcObject.getTracks().forEach(t => t.stop()); } catch {}
    els.video.srcObject = null;
  }
  isRunning = false; isPaused = false; uiStopped(); setStatus('Arrêté.');
}

/* ---------- Callback ZXing ---------- */

function onDecode(result, err) {
  if (result) {
    const now = Date.now();
    const text = result.getText ? result.getText() : String(result.text || '');
    if (!text) return;
    if (text === lastText && (now - lastAt) < DEBOUNCE_MS) return;
    lastText = text; lastAt = now;
    setResult(text, result.getBarcodeFormat?.() || '—');
    feedback(); addToHistory(text);
  } else if (err && !(err instanceof ZXing.NotFoundException)) {
    console.debug('Decode error:', err);
  }
}

/* ---------- Torche (si supportée) ---------- */

function getVideoTrack() {
  const stream = els.video.srcObject;
  return stream?.getVideoTracks?.()[0] || null;
}

async function toggleTorch() {
  const track = getVideoTrack();
  const caps = track?.getCapabilities?.();
  if (!track || !caps || !caps.torch) { setStatus('Torche non disponible.', true); return; }
  const settings = track.getSettings?.();
  const newVal = !settings.torch;
  try {
    await track.applyConstraints({ advanced: [{ torch: newVal }] });
    els.torchBtn.classList.toggle('active', newVal);
    els.torchBtn.textContent = newVal ? 'Torche (ON)' : 'Torche';
  } catch (e) {
    setStatus('Échec activation torche.', true);
  }
}

function updateTorchAvailability() {
  const track = getVideoTrack();
  const hasTorch = !!track?.getCapabilities?.().torch;
  els.torchBtn.disabled = !hasTorch;
}

/* ---------- UI helpers ---------- */

function uiRunning() {
  els.startBtn.disabled = true;
  els.pauseBtn.disabled = false;
  els.stopBtn.disabled = false;
  els.copyBtn.disabled = false;
  els.openBtn.disabled = false;
  els.shareBtn.disabled = false;
  els.torchBtn.disabled = true; // activée après check capacités
}

function uiStopped() {
  els.startBtn.disabled = !selectedDeviceId; // réactivé si caméra détectée
  els.pauseBtn.disabled = true; els.pauseBtn.textContent = 'Pause';
  els.stopBtn.disabled = true; els.torchBtn.disabled = true;
}

function setStatus(text, isError = false) { els.status.textContent = text; els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)'; }

function setResult(text, format) {
  const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = format;
  els.result.replaceChildren(document.createTextNode(text), document.createTextNode(' '), badge);
}

/* ---------- Feedback (son + vibration) ---------- */

function feedback() { if (els.soundToggle.checked) beep(880, 80); if (els.vibrateToggle.checked && 'vibrate' in navigator) navigator.vibrate([35, 40, 35]); }
let audioCtx; function beep(freq=880, duration=100){ try{ audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)(); const o=audioCtx.createOscillator(); const g=audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination); o.type='sine'; o.frequency.value=freq; g.gain.value=0.12; o.start(); setTimeout(()=>o.stop(), duration);}catch{}}

/* ---------- Historique & actions ---------- */

function loadHistory(){ try { return JSON.parse(localStorage.getItem('scanner:history')||'[]'); } catch { return []; } }
function saveHistory(){ localStorage.setItem('scanner:history', JSON.stringify(history)); }
function addToHistory(text){ if (!history.includes(text)) { history.unshift(text); if (history.length>HISTORY_MAX) history.length = HISTORY_MAX; saveHistory(); renderHistory(); } }
function renderHistory(){ els.history.innerHTML=''; history.forEach(val=>{ const li=document.createElement('li'); const row=document.createElement('div'); row.className='history-row'; const code=document.createElement('div'); code.className='code'; code.textContent=val; row.appendChild(code); const actions=document.createElement('div'); actions.className='item-actions'; const btnCopy=mkBtn('Copier',()=>copyToClipboard(val)); const btnOpen=mkBtn('Ouvrir',()=>openValue(val)); const btnShare=mkBtn('Partager',()=>shareValue(val)); actions.append(btnCopy,btnOpen,btnShare); row.appendChild(actions); li.appendChild(row); els.history.appendChild(li); }); }
function mkBtn(label,onClick){ const b=document.createElement('button'); b.className='btn'; b.textContent=label; b.addEventListener('click',onClick); return b; }
function exportCSV(){ const rows=[['value']]; history.forEach(v=>rows.push([v])); const csv=rows.map(r=>r.map(escapeCSV).join(',')).join('
'); const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='scans.csv'; a.click(); URL.revokeObjectURL(url); }
function escapeCSV(s){ const t=String(s??''); return /[",
]/.test(t)?`"${t.replace(/"/g,'""')}"`:t; }
function clearHistoryUI(){ if(!history.length) return; if(confirm('Effacer l’historique des scans ?')){ history.length=0; saveHistory(); renderHistory(); } }

// Actions résultat
async function copyResult(){ const text=getCurrentText(); if(!text) return; await copyToClipboard(text); }
async function copyToClipboard(text){ try{ await navigator.clipboard.writeText(text); setStatus('Copié dans le presse-papiers.'); }catch{ setStatus('Impossible de copier (permissions).', true); } }
function openResult(){ const text=getCurrentText(); if(!text) return; openValue(text); }
function openValue(text){ const url=normalizeUrl(text); if(url){ if(confirm(`Ouvrir ce lien ?
${url}`)) window.open(url,'_blank','noopener'); } else { setStatus('Ce contenu n’est pas une URL.', true); } }
async function shareResult(){ const text=getCurrentText(); if(!text) return; shareValue(text); }
async function shareValue(text){ try{ if(navigator.share){ await navigator.share({ text }); } else { await copyToClipboard(text); } } catch {} }

function getCurrentText(){ const out=els.result.textContent?.trim(); return out && out !== '—' ? out.replace(/\s+$/, '') : ''; }
function normalizeUrl(text){ try{ const likeUrl=/^(https?:\/\/|www\.)/i.test(text)?text:(text.includes('.')?`https://${text}`:null); if(!likeUrl) return null; const u=new URL(likeUrl); return u.href; }catch{ return null; } }

/* ---------- Utilitaires ---------- */

function setStatus(text, isError = false) { els.status.textContent = text; els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)'; }

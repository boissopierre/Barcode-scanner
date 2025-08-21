/* === Scanner UX (caméra principale uniquement) ===
 - Sélection automatique : webcam intégrée (desktop) OU caméra arrière grand angle (mobile)
 - Pas de sélecteur utilisateur; une seule caméra autorisée
 - Démarrer/Pause/Arrêter, torche si supportée
 - Historique + copier/partager/ouvrir, export CSV
 - Feedback (son/vibration), anti-rebond/anti-doublons
 - NOTE: Les navigateurs peuvent restreindre la caméra sur HTTP (hors localhost). Cette app n'impose pas HTTPS côté UI.
*/

let codeReader; // ZXing BrowserMultiFormatReader
let selectedDeviceId = null;
let isRunning = false;
let isPaused = false;
let mediaStream = null;
let lastText = null; let lastAt = 0;
const DEBOUNCE_MS = 1200; const HISTORY_MAX = 30;

const els = {
  video: document.getElementById('video'),
  status: document.getElementById('status'),
  result: document.getElementById('result'),
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
  history: document.getElementById('history'),
};

const history = loadHistory();
renderHistory();

document.addEventListener('visibilitychange', () => { if (document.hidden && isRunning) pause(); });
window.addEventListener('beforeunload', () => stop());

ready(async function init() {
  await waitForZXing();
  codeReader = new ZXing.BrowserMultiFormatReader();
  setStatus('Prêt. Clique « Démarrer ».');

  // Pré-acquérir la permission pour pouvoir lister les caméras
  try { await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(()=>{}); } catch {}

  selectedDeviceId = await autoSelectPrimaryCamera();

  els.startBtn.addEventListener('click', () => start());
  els.pauseBtn.addEventListener('click', () => (isPaused ? resume() : pause()));
  els.stopBtn.addEventListener('click', () => stop());
  els.torchBtn.addEventListener('click', toggleTorch);

  els.copyBtn.addEventListener('click', copyResult);
  els.openBtn.addEventListener('click', openResult);
  els.shareBtn.addEventListener('click', shareResult);
  els.exportBtn.addEventListener('click', exportCSV);
  els.clearBtn.addEventListener('click', clearHistoryUI);
});

/* ---------- Core ---------- */

async function start() {
  if (isRunning) return;
  try {
    await ensurePermission();
    if (!selectedDeviceId) {
      selectedDeviceId = await autoSelectPrimaryCamera();
    }
    await decodeFromDevice(selectedDeviceId);
    isRunning = true; isPaused = false; uiRunning(); setStatus('Scan en cours…');
  } catch (err) { handleError(err, "Impossible de démarrer le flux vidéo."); }
}

async function pause() { if (!isRunning || isPaused) return; isPaused = true; codeReader.reset(); els.pauseBtn.textContent = 'Reprendre'; setStatus('En pause.'); }
async function resume() { if (!isRunning || !isPaused) return; isPaused = false; await decodeFromDevice(selectedDeviceId); els.pauseBtn.textContent = 'Pause'; setStatus('Scan en cours…'); }
async function stop() {
  if (!isRunning && !mediaStream) return;
  try { codeReader?.reset(); } catch {}
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  isRunning = false; isPaused = false; uiStopped(); setStatus('Arrêté.');
}

async function decodeFromDevice(deviceId) {
  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: { exact: deviceId },
      facingMode: 'environment',
      focusMode: 'continuous',
      width: { ideal: 1280 }, height: { ideal: 720 }
    },
    audio: false
  });
  els.video.srcObject = mediaStream; await els.video.play();
  codeReader.decodeFromVideoDevice(deviceId, els.video, onDecode);
  updateTorchAvailability();
}

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

/* ---------- Auto-select primary camera ---------- */

function isMobile() {
  const ua = navigator.userAgent || '';
  return (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) || navigator.userAgentData?.mobile === true;
}

async function autoSelectPrimaryCamera() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    if (!devices.length) throw new Error('Aucune caméra détectée.');
    let chosen = null;
    const mobile = isMobile();

    function score(d) {
      const l = (d.label || '').toLowerCase();
      let s = 0;
      if (mobile) {
        // privilégier arrière grand angle
        if (/(back|rear|arrière|environment)/.test(l)) s += 5;
        if (/(wide|ultra|grand angle|ultra-wide|ultrawide)/.test(l)) s += 3;
        if (/macro|tele/.test(l)) s -= 1;
      } else {
        // privilégier webcam intégrée
        if (/(integrated|webcam|facetime|hd camera|usb camera|user|front)/.test(l)) s += 4;
        if (/external|usb/.test(l)) s += 1; // fallback si webcam externe
      }
      // Bonus si libellé contient 'default'
      if (/default/.test(l)) s += 1;
      return s;
    }

    devices.sort((a,b) => score(b) - score(a));
    chosen = devices[0];

    // Fallbacks si labels vides (permissions non encore accordées)
    if (!chosen || !chosen.deviceId) {
      return devices[0]?.deviceId;
    }
    return chosen.deviceId;
  } catch (e) { handleError(e, 'Impossible de sélectionner la caméra principale.'); return undefined; }
}

/* ---------- Torch ---------- */

async function toggleTorch() {
  if (!mediaStream) return;
  const track = mediaStream.getVideoTracks()[0];
  const caps = track.getCapabilities?.();
  if (!caps || !caps.torch) return;
  const settings = track.getSettings?.();
  const newVal = !settings.torch;
  try { await track.applyConstraints({ advanced: [{ torch: newVal }] });
    els.torchBtn.classList.toggle('active', newVal); els.torchBtn.textContent = newVal ? 'Torche (ON)' : 'Torche';
  } catch { setStatus('Torche non disponible.', true); }
}

function updateTorchAvailability() {
  const track = mediaStream?.getVideoTracks?.()[0];
  const hasTorch = !!track?.getCapabilities?.().torch;
  els.torchBtn.disabled = !hasTorch;
}

/* ---------- UI helpers ---------- */

function uiRunning() {
  els.startBtn.disabled = true; els.pauseBtn.disabled = false; els.stopBtn.disabled = false;
  els.copyBtn.disabled = false; els.openBtn.disabled = false; els.shareBtn.disabled = false;
  els.torchBtn.disabled = true; setTimeout(updateTorchAvailability, 250);
}

function uiStopped() {
  els.startBtn.disabled = false; els.pauseBtn.disabled = true; els.pauseBtn.textContent = 'Pause'; els.stopBtn.disabled = true; els.torchBtn.disabled = true;
}

function setStatus(text, isError = false) { els.status.textContent = text; els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)'; }

function setResult(text, format) {
  els.result.textContent = text;
  const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = format;
  els.result.replaceChildren(document.createTextNode(text), document.createTextNode(' '), badge);
}

/* ---------- Feedback ---------- */

function feedback() { if (els.soundToggle.checked) beep(880, 80); if (els.vibrateToggle.checked && 'vibrate' in navigator) navigator.vibrate([35, 40, 35]); }
let audioCtx; function beep(freq=880, duration=100){ try{ audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)(); const o=audioCtx.createOscillator(); const g=audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination); o.type='sine'; o.frequency.value=freq; g.gain.value=0.12; o.start(); setTimeout(()=>o.stop(), duration);}catch{}}

/* ---------- History ---------- */

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

/* ---------- Result actions ---------- */

async function copyResult(){ const text=getCurrentText(); if(!text) return; await copyToClipboard(text); }
async function copyToClipboard(text){ try{ await navigator.clipboard.writeText(text); setStatus('Copié dans le presse-papiers.'); }catch{ setStatus('Impossible de copier (permissions).', true); } }
function openResult(){ const text=getCurrentText(); if(!text) return; openValue(text); }
function openValue(text){ const url=normalizeUrl(text); if(url){ if(confirm(`Ouvrir ce lien ?
${url}`)) window.open(url,'_blank','noopener'); } else { setStatus('Ce contenu n’est pas une URL.', true); } }
async function shareResult(){ const text=getCurrentText(); if(!text) return; shareValue(text); }
async function shareValue(text){ try{ if(navigator.share){ await navigator.share({ text }); } else { await copyToClipboard(text); } } catch {}
}
function getCurrentText(){ const out=els.result.textContent?.trim(); return out && out !== '—' ? out.replace(/\s+$/, '') : ''; }
function normalizeUrl(text){ try{ const likeUrl=/^(https?:\/\/|www\.)/i.test(text)?text:(text.includes('.')?`https://${text}`:null); if(!likeUrl) return null; const u=new URL(likeUrl); return u.href; }catch{ return null; } }

/* ---------- Permissions / Errors ---------- */

async function ensurePermission(){ if(!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)) throw new Error('Ce navigateur ne supporte pas la caméra.'); try{ const p=await navigator.permissions.query({ name:'camera' }); if(p.state==='denied') throw new Error('Accès caméra refusé.'); }catch{} }
function handleError(err, friendly='Une erreur est survenue.'){ console.error(err); setStatus(`${friendly} ${err?.message? '('+err.message+')':''}`, true); }
function ready(fn){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
function waitForZXing(){ return new Promise((resolve)=>{ (function check(){ if(window.ZXing && ZXing.BrowserMultiFormatReader) resolve(); else requestAnimationFrame(check); })(); }); }

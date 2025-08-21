/* === Améliorations UX ===
 - Démarrer/Pause/Arrêter
 - Sélecteur de caméra + mémorisation
 - Torche (si supportée)
 - Retour sonore + vibration (configurables)
 - Anti-doublons + anti-rebond
 - Historique (copier/partager/ouvrir) + export CSV + effacer
 - Détection d'URL avec confirmation avant ouverture
 - Gestion des erreurs et états, accessibilité, responsive
*/

let codeReader; // ZXing BrowserMultiFormatReader
let currentDeviceId = null;
let isRunning = false;
let isPaused = false;
let mediaStream = null;
let lastText = null;
let lastAt = 0;
const DEBOUNCE_MS = 1200;       // anti-rebond détection
const HISTORY_MAX = 30;

const els = {
  video: document.getElementById('video'),
  status: document.getElementById('status'),
  result: document.getElementById('result'),
  cameraSelect: document.getElementById('cameraSelect'),
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

document.addEventListener('visibilitychange', () => {
  if (document.hidden && isRunning) pause();
});

window.addEventListener('beforeunload', () => stop());

ready(async function init() {
  await waitForZXing();
  codeReader = new ZXing.BrowserMultiFormatReader();

  await populateCameras();

  // Restore last device
  const savedId = localStorage.getItem('scanner:lastDeviceId');
  if (savedId && [...els.cameraSelect.options].some(o => o.value === savedId)) {
    els.cameraSelect.value = savedId;
    currentDeviceId = savedId;
  }

  // UI handlers
  els.startBtn.addEventListener('click', () => start());
  els.pauseBtn.addEventListener('click', () => (isPaused ? resume() : pause()));
  els.stopBtn.addEventListener('click', () => stop());
  els.torchBtn.addEventListener('click', toggleTorch);
  els.cameraSelect.addEventListener('change', async (e) => {
    currentDeviceId = e.target.value;
    localStorage.setItem('scanner:lastDeviceId', currentDeviceId);
    if (isRunning) {
      await restart();
    }
  });

  els.copyBtn.addEventListener('click', copyResult);
  els.openBtn.addEventListener('click', openResult);
  els.shareBtn.addEventListener('click', shareResult);
  els.exportBtn.addEventListener('click', exportCSV);
  els.clearBtn.addEventListener('click', clearHistoryUI);

  setStatus('Prêt. Choisis une caméra et clique « Démarrer ».');
});

/* ---------- Core ---------- */

async function start() {
  if (isRunning) return;
  await ensurePermission();

  const deviceId = currentDeviceId || els.cameraSelect.value;
  if (!deviceId) {
    setStatus('Aucune caméra disponible.', true);
    return;
  }

  try {
    await decodeFromDevice(deviceId);
    isRunning = true;
    isPaused = false;
    uiRunning();
    setStatus('Scan en cours…');
  } catch (err) {
    handleError(err, "Impossible de démarrer le flux vidéo.");
  }
}

async function restart() {
  await stop();
  await start();
}

async function pause() {
  if (!isRunning || isPaused) return;
  isPaused = true;
  codeReader.reset(); // stoppe le décodage, conserve le flux
  els.pauseBtn.textContent = 'Reprendre';
  setStatus('En pause.');
}

async function resume() {
  if (!isRunning || !isPaused) return;
  isPaused = false;
  await decodeFromDevice(currentDeviceId || els.cameraSelect.value);
  els.pauseBtn.textContent = 'Pause';
  setStatus('Scan en cours…');
}

async function stop() {
  if (!isRunning && !mediaStream) return;
  try {
    codeReader?.reset();
  } catch {}
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  isRunning = false;
  isPaused = false;
  uiStopped();
  setStatus('Arrêté.');
}

async function decodeFromDevice(deviceId) {
  // On crée un flux manuellement pour activer la torche et contrôler les contraintes
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
  }
  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: { exact: deviceId },
      facingMode: 'environment',
      focusMode: 'continuous',
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });
  els.video.srcObject = mediaStream;
  await els.video.play();

  // Décode en boucle
  codeReader.decodeFromVideoDevice(deviceId, els.video, onDecode);
  updateTorchAvailability();
}

function onDecode(result, err) {
  if (result) {
    const now = Date.now();
    const text = result.getText ? result.getText() : String(result.text || '');
    if (!text) return;

    // Anti-rebond / anti-doublons rapprochés
    if (text === lastText && (now - lastAt) < DEBOUNCE_MS) return;
    lastText = text; lastAt = now;

    setResult(text, result.getBarcodeFormat?.() || '—');
    feedback();
    addToHistory(text);

  } else if (err && !(err instanceof ZXing.NotFoundException)) {
    // Erreurs autres que « rien trouvé » ignorées dans l'UI, mais logguées
    console.debug('Decode error:', err);
  }
}

/* ---------- Cameras ---------- */

async function populateCameras() {
  try {
    await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => {});
    const devices = await navigator.mediaDevices.enumerateDevices();
    const vids = devices.filter(d => d.kind === 'videoinput');

    els.cameraSelect.innerHTML = '';
    // Trier : préférer caméras "back" / "arrière"
    vids.sort((a, b) => scoreCam(b) - scoreCam(a)).forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Caméra ${els.cameraSelect.length + 1}`;
      els.cameraSelect.appendChild(opt);
    });
    if (vids.length) currentDeviceId = els.cameraSelect.value;
    else setStatus('Aucune caméra détectée.', true);
  } catch (err) {
    handleError(err, "Impossible de lister les caméras.");
  }
}

function scoreCam(d) {
  const l = (d.label || '').toLowerCase();
  let s = 0;
  if (l.includes('back') || l.includes('arrière') || l.includes('rear')) s += 2;
  if (l.includes('wide') || l.includes('principal')) s += 1;
  return s;
}

/* ---------- Torch ---------- */

async function toggleTorch() {
  if (!mediaStream) return;
  const track = mediaStream.getVideoTracks()[0];
  const caps = track.getCapabilities?.();
  if (!caps || !caps.torch) return;
  const settings = track.getSettings?.();
  const newVal = !settings.torch;
  try {
    await track.applyConstraints({ advanced: [{ torch: newVal }] });
    els.torchBtn.classList.toggle('active', newVal);
    els.torchBtn.textContent = newVal ? 'Torche (ON)' : 'Torche';
  } catch (e) {
    setStatus("Torche non disponible.", true);
  }
}

function updateTorchAvailability() {
  const track = mediaStream?.getVideoTracks?.()[0];
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
  els.torchBtn.disabled = true; // activée après obtention des capacités
  setTimeout(updateTorchAvailability, 250);
}

function uiStopped() {
  els.startBtn.disabled = false;
  els.pauseBtn.disabled = true;
  els.pauseBtn.textContent = 'Pause';
  els.stopBtn.disabled = true;
  els.torchBtn.disabled = true;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function setResult(text, format) {
  els.result.textContent = text;
  // Indiquer le format via une puce
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = format;
  // Insérer la puce à côté du résultat de façon non intrusive
  els.result.replaceChildren(document.createTextNode(text), document.createTextNode(' '), badge);
}

/* ---------- Feedback ---------- */

function feedback() {
  if (els.soundToggle.checked) beep(880, 80);
  if (els.vibrateToggle.checked && 'vibrate' in navigator) {
    navigator.vibrate([35, 40, 35]);
  }
}

let audioCtx;
function beep(freq = 880, duration = 100) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.value = 0.12;
    o.start();
    setTimeout(() => { o.stop(); }, duration);
  } catch {}
}

/* ---------- History ---------- */

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem('scanner:history') || '[]');
  } catch { return []; }
}
function saveHistory() {
  localStorage.setItem('scanner:history', JSON.stringify(history));
}
function addToHistory(text) {
  if (!history.includes(text)) {
    history.unshift(text);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    saveHistory();
    renderHistory();
  }
}
function renderHistory() {
  els.history.innerHTML = '';
  history.forEach(val => {
    const li = document.createElement('li');

    const row = document.createElement('div');
    row.className = 'history-row';
    const code = document.createElement('div');
    code.className = 'code';
    code.textContent = val;
    row.appendChild(code);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const btnCopy = mkBtn('Copier', () => copyToClipboard(val));
    const btnOpen = mkBtn('Ouvrir', () => openValue(val));
    const btnShare = mkBtn('Partager', () => shareValue(val));

    actions.append(btnCopy, btnOpen, btnShare);
    row.appendChild(actions);

    li.appendChild(row);
    els.history.appendChild(li);
  });
}

function mkBtn(label, onClick) {
  const b = document.createElement('button');
  b.className = 'btn'; b.textContent = label; b.addEventListener('click', onClick);
  return b;
}

function exportCSV() {
  const rows = [['value']];
  history.forEach(v => rows.push([v]));
  const csv = rows.map(r => r.map(escapeCSV).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'scans.csv'; a.click();
  URL.revokeObjectURL(url);
}
function escapeCSV(s) {
  const t = String(s ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
function clearHistoryUI() {
  if (!history.length) return;
  if (confirm('Effacer l’historique des scans ?')) {
    history.length = 0; saveHistory(); renderHistory();
  }
}

/* ---------- Result actions ---------- */

async function copyResult() {
  const text = getCurrentText();
  if (!text) return;
  await copyToClipboard(text);
}
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copié dans le presse-papiers.');
  } catch {
    setStatus('Impossible de copier (permissions).', true);
  }
}

function openResult() {
  const text = getCurrentText();
  if (!text) return;
  openValue(text);
}
function openValue(text) {
  const url = normalizeUrl(text);
  if (url) {
    if (confirm(`Ouvrir ce lien ?\n${url}`)) window.open(url, '_blank', 'noopener');
  } else {
    setStatus('Ce contenu n’est pas une URL.', true);
  }
}

async function shareResult() {
  const text = getCurrentText();
  if (!text) return;
  shareValue(text);
}
async function shareValue(text) {
  try {
    if (navigator.share) {
      await navigator.share({ text });
    } else {
      await copyToClipboard(text);
    }
  } catch {}
}

function getCurrentText() {
  const out = els.result.textContent?.trim();
  return out && out !== '—' ? out.replace(/\s+$/, '') : '';
}

function normalizeUrl(text) {
  try {
    // Ajoute https:// si nécessaire
    const likeUrl = /^(https?:\/\/|www\.)/i.test(text) ? text : (text.includes('.') ? `https://${text}` : null);
    if (!likeUrl) return null;
    const u = new URL(likeUrl);
    return u.href;
  } catch { return null; }
}

/* ---------- Permissions / Errors ---------- */

async function ensurePermission() {
  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)) {
    throw new Error('Ce navigateur ne supporte pas la caméra (getUserMedia).');
  }
  // Optionnel : inspection Permissions API
  try {
    const perm = await navigator.permissions.query({ name: 'camera' });
    if (perm.state === 'denied') throw new Error('Accès caméra refusé.');
  } catch { /* Permissions API pas toujours dispo */ }
}

function handleError(err, friendly = 'Une erreur est survenue.') {
  console.error(err);
  setStatus(`${friendly} ${err?.message ? ' (' + err.message + ')' : ''}`, true);
}

function ready(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
}

function waitForZXing() {
  return new Promise((resolve) => {
    (function check() {
      if (window.ZXing && ZXing.BrowserMultiFormatReader) resolve();
      else requestAnimationFrame(check);
    })();
  });
}

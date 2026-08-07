'use strict';

const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
};

// Measured against real material with the fixed sidechain gain in server.js.
// Changing that gain invalidates these numbers.
const DUCK = {
  light: { threshold: 0.15, ratio: 3 },
  medium: { threshold: 0.08, ratio: 4 },
  strong: { threshold: 0.05, ratio: 6 },
  max: { threshold: 0.03, ratio: 10 },
};

const blank = () => ({
  name: '',
  videoPath: '',
  videoDuration: 0,
  voice: '',
  style: 'none',
  styleDegree: 1,
  rate: 0,
  pitch: 0,
  leadIn: 3.5,
  tailOut: 6,
  // Stretches where the source video already has a voice. Narration keeps out.
  blocked: [],
  blockPad: 0.6,
  nextId: 1,
  segments: [],
  outPath: '',
  // Neural TTS already arrives close to full scale, so it needs no boost.
  mix: { keepMusic: true, musicGain: 0.85, voiceGain: 1.0, duck: 'medium' },
});

let S = blank();
let VOICES = [];

const fmt = (s) => {
  if (!Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};

// Everything that changes the audio. If this differs from what was synthesized,
// the line is stale and needs a new Azure call.
const audioKey = (seg) =>
  JSON.stringify([
    seg.text,
    seg.voice || S.voice,
    seg.style || S.style,
    seg.styleDegree ?? S.styleDegree,
    seg.rate ?? S.rate,
    seg.pitch ?? S.pitch,
  ]);

// ---------------------------------------------------------------- segments

function addSegment(text = '') {
  S.segments.push({
    id: 's' + String(S.nextId++).padStart(2, '0'),
    text,
    voice: '',
    style: '',
    styleDegree: null,
    rate: null,
    pitch: null,
    start: 0,
    file: null,
    duration: 0,
    synthKey: null,
  });
}

function renderSegments() {
  const box = $('segments');
  box.innerHTML = '';

  S.segments.forEach((seg, i) => {
    const stale = seg.file && seg.synthKey !== audioKey(seg);
    const el = document.createElement('div');
    el.className = 'seg';
    el.innerHTML = `
      <div class="seg-head">
        <span class="seg-id">${seg.id}</span>
        <span class="seg-dur">${seg.duration ? fmt(seg.duration) : '—'}</span>
        ${stale ? '<span class="stale">· izmijenjeno, treba ponovna sinteza</span>' : ''}
        <span class="spacer"></span>
        <button class="ghost icon" data-act="play"  ${seg.file ? '' : 'disabled'}>▶</button>
        <button class="ghost icon" data-act="over">⚙</button>
        <button class="ghost icon" data-act="up"   ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="ghost icon" data-act="down" ${i === S.segments.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="ghost icon" data-act="del">✕</button>
      </div>
      <textarea data-act="text" placeholder="tekst linije">${seg.text.replace(/</g, '&lt;')}</textarea>
      <div class="seg-over">
        <label>Glas<select data-act="voice"></select></label>
        <label>Stil<select data-act="style"></select></label>
        <label>Tempo<input data-act="rate" type="number" step="1" placeholder="zadano" value="${seg.rate ?? ''}" /></label>
        <label>Visina<input data-act="pitch" type="number" step="1" placeholder="zadano" value="${seg.pitch ?? ''}" /></label>
        <label>Početak (s)<input data-act="start" type="number" step="0.1" value="${seg.start.toFixed(1)}" /></label>
      </div>`;

    const over = el.querySelector('.seg-over');
    fillVoiceSelect(el.querySelector('[data-act="voice"]'), seg.voice, true);
    fillStyleSelect(el.querySelector('[data-act="style"]'), seg.voice || S.voice, seg.style, true);

    el.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      if (act === 'del') { S.segments.splice(i, 1); redraw(); }
      if (act === 'up') { [S.segments[i - 1], S.segments[i]] = [S.segments[i], S.segments[i - 1]]; redraw(); }
      if (act === 'down') { [S.segments[i + 1], S.segments[i]] = [S.segments[i], S.segments[i + 1]]; redraw(); }
      if (act === 'over') over.classList.toggle('open');
      if (act === 'play') new Audio(`/api/audio/${encodeURIComponent(S.name)}/${seg.file}`).play();
    });

    el.addEventListener('input', (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      const v = e.target.value;
      if (act === 'text') seg.text = v;
      if (act === 'voice') { seg.voice = v; fillStyleSelect(el.querySelector('[data-act="style"]'), v || S.voice, seg.style, true); }
      if (act === 'style') seg.style = v;
      if (act === 'rate') seg.rate = v === '' ? null : Number(v);
      if (act === 'pitch') seg.pitch = v === '' ? null : Number(v);
      if (act === 'start') { seg.start = Number(v) || 0; drawTimeline(); }
      if (act === 'text' || act === 'voice' || act === 'style') refreshStaleFlags();
    });

    box.appendChild(el);
  });
}

// Repaint only the stale markers - a full redraw would blow away focus while typing.
function refreshStaleFlags() {
  document.querySelectorAll('.seg').forEach((el, i) => {
    const seg = S.segments[i];
    const head = el.querySelector('.seg-head');
    const existing = head.querySelector('.stale');
    const stale = seg.file && seg.synthKey !== audioKey(seg);
    if (stale && !existing) {
      const s = document.createElement('span');
      s.className = 'stale';
      s.textContent = '· izmijenjeno, treba ponovna sinteza';
      head.insertBefore(s, head.querySelector('.spacer'));
    } else if (!stale && existing) existing.remove();
  });
}

// ---------------------------------------------------------------- voices

function fillVoiceSelect(sel, value, allowInherit) {
  const locale = $('locale').value;
  sel.innerHTML = allowInherit ? '<option value="">zadani</option>' : '';
  VOICES.filter((v) => !locale || v.locale === locale).forEach((v) => {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.display} (${v.gender === 'Female' ? 'Ž' : 'M'})${v.styles.length ? ' ★' : ''}`;
    sel.appendChild(o);
  });
  sel.value = value || '';
}

function fillStyleSelect(sel, voiceName, value, allowInherit) {
  const v = VOICES.find((x) => x.name === voiceName);
  sel.innerHTML = allowInherit ? '<option value="">zadani</option>' : '<option value="none">bez stila</option>';
  (v?.styles || []).forEach((s) => {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  });
  sel.value = value || '';
}

async function loadVoices() {
  VOICES = await api('/api/voices');
  const locales = [...new Set(VOICES.map((v) => v.locale))].sort();
  const sel = $('locale');
  sel.innerHTML = '';
  locales.forEach((l) => {
    const o = document.createElement('option');
    o.value = l;
    o.textContent = `${l} — ${VOICES.find((v) => v.locale === l).localeName}`;
    sel.appendChild(o);
  });
  sel.value = S.voice ? S.voice.split('-').slice(0, 2).join('-') : (locales.includes('hr-HR') ? 'hr-HR' : 'en-US');
  onLocaleChange();
}

function onLocaleChange() {
  fillVoiceSelect($('voice'), S.voice, false);
  if (!$('voice').value) $('voice').value = $('voice').options[0]?.value || '';
  S.voice = $('voice').value;
  fillStyleSelect($('style'), S.voice, S.style, false);
  S.style = $('style').value || 'none';
  renderSegments();
}

// ---------------------------------------------------------------- timing

const paddedZones = () =>
  (S.blocked || [])
    .map(([a, b]) => [Math.max(0, a - S.blockPad), b + S.blockPad])
    .sort((x, y) => x[0] - y[0]);

const hitsZone = (start, dur, zones = paddedZones()) =>
  zones.find(([a, b]) => start < b && start + dur > a);

// Walk the timeline placing each line, skipping past any zone it would land on.
function layout(gap, ready, zones) {
  const starts = [];
  let t = S.leadIn;
  for (const s of ready) {
    let guard = 0;
    let clash;
    while ((clash = hitsZone(t, s.duration, zones)) && guard++ < 50) t = clash[1];
    starts.push(t);
    t += s.duration + gap;
  }
  return starts;
}

function autoSpace() {
  const ready = S.segments.filter((s) => s.duration > 0);
  if (!S.videoDuration || ready.length === 0) return;

  const zones = paddedZones();
  const speech = ready.reduce((a, s) => a + s.duration, 0);
  const target = S.videoDuration - S.tailOut;
  const endOf = (starts) => starts[starts.length - 1] + ready[ready.length - 1].duration;

  if (endOf(layout(0, ready, zones)) > target) {
    $('timingInfo').className = 'muted stale';
    $('timingInfo').textContent =
      `Naracija traje ${fmt(speech)} i ne stane u ${fmt(S.videoDuration)}` +
      (zones.length ? ` uz ${zones.length} zabranjenih zona` : '') +
      '. Skrati tekst, ubrzaj tempo ili smanji odjavu.';
    return;
  }

  // Zones make the end time a step function of gap, so solve for it numerically.
  let lo = 0;
  let hi = Math.max(20, S.videoDuration);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (endOf(layout(mid, ready, zones)) > target) hi = mid;
    else lo = mid;
  }

  const starts = layout(lo, ready, zones);
  ready.forEach((s, i) => (s.start = Math.round(starts[i] * 100) / 100));

  const collisions = ready.filter((s) => hitsZone(s.start, s.duration, zones)).length;
  $('timingInfo').className = 'muted' + (collisions ? ' stale' : '');
  $('timingInfo').textContent =
    `Govor ${fmt(speech)} · pauza ${lo.toFixed(2)} s · završava ${fmt(endOf(starts))}` +
    (zones.length ? ` · zaobiđeno ${zones.length} zona` : '') +
    (collisions ? ` · ${collisions} linija se i dalje preklapa!` : '');
  redraw();
}

async function scanZones() {
  if (!S.videoPath) throw new Error('Prvo učitaj video.');
  $('zoneInfo').textContent = 'Skeniram…';
  $('zoneInfo').className = 'muted';
  const r = await api('/api/detect-speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoPath: S.videoPath, margin: 4 }),
  });
  S.blocked = r.regions;
  const total = r.regions.reduce((a, [x, y]) => a + (y - x), 0);
  $('zoneInfo').textContent = r.regions.length
    ? `${r.regions.length} zona, ukupno ${total.toFixed(1)} s: ` + r.regions.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join(', ')
    : 'Original nigdje ne govori — nema zabranjenih zona.';
  redraw();
}

function drawTimeline() {
  const tl = $('timeline');
  const ready = S.segments.filter((s) => s.duration > 0);
  if (!S.videoDuration || ready.length === 0) {
    tl.innerHTML = '<div class="tl-empty">Sintetiziraj linije da se pojavi timeline.</div>';
    return;
  }

  tl.innerHTML = '';

  const zones = paddedZones();
  (S.blocked || []).forEach(([a, b], i) => {
    const z = document.createElement('div');
    z.className = 'tl-zone';
    z.style.left = `${(a / S.videoDuration) * 100}%`;
    z.style.width = `${Math.max(((b - a) / S.videoDuration) * 100, 0.4)}%`;
    z.title = `Original govori: ${fmt(a)} – ${fmt(b)}`;
    tl.appendChild(z);
  });

  const sorted = [...ready].sort((a, b) => a.start - b.start);

  sorted.forEach((seg, i) => {
    const next = sorted[i + 1];
    const overlap =
      (next && seg.start + seg.duration > next.start + 0.01) ||
      Boolean(hitsZone(seg.start, seg.duration, zones));
    const el = document.createElement('div');
    el.className = 'tl-block' + (overlap ? ' overlap' : '');
    el.style.left = `${(seg.start / S.videoDuration) * 100}%`;
    el.style.width = `${Math.max((seg.duration / S.videoDuration) * 100, 1.2)}%`;
    el.title = `${seg.id} · ${fmt(seg.start)} → ${fmt(seg.start + seg.duration)}\n${seg.text}`;
    el.textContent = seg.id;

    el.addEventListener('pointerdown', (down) => {
      down.preventDefault();
      el.setPointerCapture(down.pointerId);
      const rect = tl.getBoundingClientRect();
      const grabOffset = down.clientX - el.getBoundingClientRect().left;

      const move = (m) => {
        const px = m.clientX - rect.left - grabOffset;
        const sec = (px / rect.width) * S.videoDuration;
        seg.start = Math.max(0, Math.min(S.videoDuration - seg.duration, Math.round(sec * 10) / 10));
        el.style.left = `${(seg.start / S.videoDuration) * 100}%`;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        redraw();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });

    tl.appendChild(el);
  });

  const ruler = document.createElement('div');
  ruler.className = 'tl-ruler';
  ruler.innerHTML = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => `<span>${fmt(S.videoDuration * f)}</span>`)
    .join('');
  tl.appendChild(ruler);
}

const redraw = () => { renderSegments(); drawTimeline(); };

// ---------------------------------------------------------------- actions

async function probe() {
  const info = await api('/api/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoPath: $('videoPath').value.trim() }),
  });
  S.videoPath = $('videoPath').value.trim();
  S.videoDuration = info.duration;
  $('videoInfo').textContent =
    `${fmt(info.duration)} · ${info.width}×${info.height} · ${info.hasAudio ? 'ima zvučni zapis' : 'BEZ zvuka — podloga se ne može zadržati'}`;
  if (!info.hasAudio) { $('keepMusic').checked = false; S.mix.keepMusic = false; }
  if (!$('outPath').value) {
    $('outPath').value = S.videoPath.replace(/\.[^.\\/]+$/, '') + '-narrated.mp4';
    S.outPath = $('outPath').value;
  }
  drawTimeline();
}

async function synthesize() {
  if (!S.name) throw new Error('Upiši naziv projekta prije sinteze.');
  const btn = $('synth');
  btn.disabled = true;
  $('synthInfo').textContent = 'Sintetiziram…';
  try {
    const { results } = await api('/api/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(S),
    });
    let fresh = 0;
    for (const r of results) {
      const seg = S.segments.find((s) => s.id === r.id);
      if (!seg || r.skipped) continue;
      seg.file = r.file;
      seg.duration = r.duration;
      seg.synthKey = audioKey(seg);
      if (!r.cached) fresh++;
    }
    $('synthInfo').textContent = `Gotovo — ${fresh} novih, ${results.length - fresh} iz predmemorije.`;
    autoSpace();
  } finally {
    btn.disabled = false;
  }
}

async function render() {
  const ready = S.segments.filter((s) => s.file && s.duration > 0);
  if (!ready.length) throw new Error('Nema sintetiziranih linija.');
  if (!S.videoDuration) throw new Error('Video nije učitan.');

  const { jobId } = await api('/api/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectName: S.name,
      videoPath: S.videoPath,
      outPath: $('outPath').value.trim(),
      segments: ready.map((s) => ({ file: s.file, start: s.start })),
      options: {
        keepMusic: S.mix.keepMusic,
        musicGain: S.mix.musicGain,
        voiceGain: S.mix.voiceGain,
        duck: DUCK[S.mix.duck],
      },
    }),
  });

  $('render').disabled = true;
  $('renderInfo').textContent = 'Renderiram…';
  const poll = setInterval(async () => {
    const job = await api(`/api/render/${jobId}`);
    if (job.status === 'done') {
      clearInterval(poll);
      $('render').disabled = false;
      $('renderInfo').textContent = `Gotovo: ${job.output}`;
      $('renderInfo').className = 'muted';
    } else if (job.status === 'error') {
      clearInterval(poll);
      $('render').disabled = false;
      $('renderInfo').textContent = `Greška: ${job.error}`;
      $('renderInfo').className = 'muted stale';
    }
  }, 800);
}

const save = () => api('/api/project', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(S),
});

async function openProject(name) {
  S = Object.assign(blank(), await api(`/api/project?name=${encodeURIComponent(name)}`));
  hydrate();
}

// ---------------------------------------------------------------- wiring

function hydrate() {
  $('projectName').value = S.name;
  $('videoPath').value = S.videoPath;
  $('outPath').value = S.outPath || '';
  $('leadIn').value = S.leadIn;
  $('tailOut').value = S.tailOut;
  $('blockPad').value = S.blockPad;
  $('zoneInfo').textContent = S.blocked?.length
    ? `${S.blocked.length} zona iz projekta: ` + S.blocked.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join(', ')
    : 'Zone nisu skenirane.';
  $('styleDegree').value = S.styleDegree;
  $('rate').value = S.rate;
  $('pitch').value = S.pitch;
  $('keepMusic').checked = S.mix.keepMusic;
  $('musicGain').value = S.mix.musicGain;
  $('voiceGain').value = S.mix.voiceGain;
  $('duck').value = S.mix.duck;
  syncOutputs();
  if (VOICES.length) {
    // Point the language filter at the project's own voice first. Without this
    // the filter keeps its previous value, the saved voice is not in the list,
    // and the project silently adopts whatever voice happens to be first.
    const loc = S.voice ? S.voice.split('-').slice(0, 2).join('-') : '';
    if (loc && [...$('locale').options].some((o) => o.value === loc)) $('locale').value = loc;
    onLocaleChange();
  }
  if (S.videoDuration) $('videoInfo').textContent = `${fmt(S.videoDuration)} · učitano iz projekta`;
  redraw();
}

function syncOutputs() {
  $('styleDegreeOut').textContent = Number(S.styleDegree).toFixed(1);
  $('rateOut').textContent = `${S.rate}%`;
  $('pitchOut').textContent = `${S.pitch}%`;
  $('musicGainOut').textContent = Number(S.mix.musicGain).toFixed(2);
  $('voiceGainOut').textContent = Number(S.mix.voiceGain).toFixed(1);
}

const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { alert(e.message); }
};

function wire() {
  $('probe').onclick = guard(probe);
  $('synth').onclick = guard(synthesize);
  $('render').onclick = guard(render);
  $('save').onclick = guard(async () => { await save(); $('save').textContent = 'Spremljeno'; setTimeout(() => ($('save').textContent = 'Spremi'), 1200); });
  $('addSeg').onclick = () => { addSegment(); redraw(); };
  $('autoSpace').onclick = autoSpace;
  $('scan').onclick = guard(scanZones);
  $('clearZones').onclick = () => {
    S.blocked = [];
    $('zoneInfo').textContent = 'Zone obrisane.';
    redraw();
  };

  $('projectName').oninput = (e) => (S.name = e.target.value);
  $('videoPath').oninput = (e) => (S.videoPath = e.target.value);
  $('outPath').oninput = (e) => (S.outPath = e.target.value);
  $('projectList').onchange = guard((e) => e.target.value && openProject(e.target.value));

  $('locale').onchange = onLocaleChange;
  $('voice').onchange = (e) => { S.voice = e.target.value; fillStyleSelect($('style'), S.voice, S.style, false); S.style = $('style').value || 'none'; redraw(); };
  $('style').onchange = (e) => { S.style = e.target.value; redraw(); };

  for (const [id, key] of [['styleDegree', 'styleDegree'], ['rate', 'rate'], ['pitch', 'pitch']]) {
    $(id).oninput = (e) => { S[key] = Number(e.target.value); syncOutputs(); refreshStaleFlags(); };
  }
  for (const [id, key] of [['leadIn', 'leadIn'], ['tailOut', 'tailOut']]) {
    $(id).oninput = (e) => (S[key] = Number(e.target.value));
  }
  $('blockPad').oninput = (e) => { S.blockPad = Number(e.target.value); drawTimeline(); };
  $('keepMusic').onchange = (e) => (S.mix.keepMusic = e.target.checked);
  $('duck').onchange = (e) => (S.mix.duck = e.target.value);
  $('musicGain').oninput = (e) => { S.mix.musicGain = Number(e.target.value); syncOutputs(); };
  $('voiceGain').oninput = (e) => { S.mix.voiceGain = Number(e.target.value); syncOutputs(); };

  setInterval(() => { if (S.name) save().catch(() => {}); }, 15000);
}

(async function init() {
  wire();
  const st = await api('/api/status');
  const pill = $('status');
  pill.textContent = st.hasKey ? `Azure ${st.region}` : 'Azure ključ nije postavljen';
  pill.className = 'pill ' + (st.hasKey ? 'ok' : 'err');

  st.projects.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = `${p.name} (${p.segments})`;
    $('projectList').appendChild(o);
  });

  if (st.hasKey) {
    try { await loadVoices(); } catch (e) { pill.textContent = e.message; pill.className = 'pill err'; }
  }
  if (!S.segments.length) addSegment();
  redraw();
})();

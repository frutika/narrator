'use strict';

// Narrator - local narration studio.
// Azure Neural TTS for the voice, ffmpeg for the mix. No external npm deps.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PROJECTS = path.join(ROOT, 'projects');
const portArg = process.argv.indexOf('--port');
const PORT = Number(process.env.PORT) || (portArg > -1 ? Number(process.argv[portArg + 1]) : 0) || 4173;

// ---------------------------------------------------------------- config

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    // Environment wins, so the key never has to live in a file.
    azureKey: process.env.AZURE_SPEECH_KEY || cfg.azureKey || '',
    azureRegion: process.env.AZURE_SPEECH_REGION || cfg.azureRegion || 'westeurope',
    // Translator is a separate Azure resource from Speech, with its own key.
    // Its region defaults to the Speech one because they are usually the same.
    translatorKey: process.env.AZURE_TRANSLATOR_KEY || cfg.translatorKey || '',
    translatorRegion:
      process.env.AZURE_TRANSLATOR_REGION ||
      cfg.translatorRegion ||
      process.env.AZURE_SPEECH_REGION ||
      cfg.azureRegion ||
      'westeurope',
    ffmpeg: cfg.ffmpeg || findBinary('ffmpeg'),
    ffprobe: cfg.ffprobe || findBinary('ffprobe'),
  };
}

function findBinary(name) {
  const candidates = [
    `C:\\ffmpeg\\bin\\${name}.exe`,
    `C:\\Program Files\\ffmpeg\\bin\\${name}.exe`,
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return name; // fall back to PATH
}

// ---------------------------------------------------------------- helpers

function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(cmd)} exited ${code}\n${err.slice(-4000)}`))
    );
    if (input) p.stdin.end(input);
  });
}

// Same as run(), but keeps stdout as bytes - collecting raw PCM into a string
// would mangle it.
function runBinary(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${path.basename(cmd)} exited ${code}\n${err.slice(-2000)}`))
    );
  });
}

// Find centre-panned speech in the source audio. A voice-over sits dead centre
// while music is wide, so a window where mid energy towers over side energy in
// the speech band is almost certainly someone talking.
async function detectSpeech(cfg, videoPath, margin = 4) {
  const SR = 16000;
  const WIN = 0.25;

  const grab = async (pan) => {
    const buf = await runBinary(cfg.ffmpeg, [
      '-v', 'error', '-i', videoPath,
      '-af', `pan=mono|c0=${pan},highpass=f=300,lowpass=f=3400`,
      '-ar', String(SR), '-ac', '1', '-f', 's16le', '-',
    ]);
    const copy = Buffer.from(buf); // guarantee correct alignment for Int16Array
    return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 2));
  };

  const rms = (s) => {
    const n = Math.floor(SR * WIN);
    const out = [];
    for (let i = 0; i + n <= s.length; i += n) {
      let sum = 0;
      for (let j = i; j < i + n; j++) sum += s[j] * s[j];
      out.push(Math.sqrt(sum / n));
    }
    return out;
  };

  const mid = rms(await grab('0.5*c0+0.5*c1'));
  const side = rms(await grab('0.5*c0-0.5*c1'));
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

  const sideDb = side.map(db);
  const sideMedian = [...sideDb].sort((a, b) => a - b)[Math.floor(sideDb.length / 2)];
  if (sideMedian < -80) {
    throw new Error('Zvuk je mono (nema stereo razlike), pa se govor ne moze odvojiti od podloge. Zone upisi rucno.');
  }

  const ratio = mid.map((m, i) => db(m) - sideDb[i]);
  const level = mid.map(db);
  const median = [...ratio].sort((a, b) => a - b)[Math.floor(ratio.length / 2)];
  const floor = [...level].sort((a, b) => a - b)[Math.floor(level.length * 0.35)];

  const flag = ratio.map((r, i) => r > median + margin && level[i] > floor + 3);
  // Fill single-window holes so one soft syllable does not split a region.
  for (let i = 1; i < flag.length - 1; i++) if (flag[i - 1] && flag[i + 1]) flag[i] = true;

  const regions = [];
  let startIdx = null;
  flag.forEach((f, i) => {
    if (f && startIdx === null) startIdx = i;
    if (!f && startIdx !== null) { regions.push([startIdx * WIN, i * WIN]); startIdx = null; }
  });
  if (startIdx !== null) regions.push([startIdx * WIN, flag.length * WIN]);

  // Merge regions separated by a short breath - they are one passage of speech.
  const kept = regions.filter(([a, b]) => b - a >= 0.75);
  const merged = [];
  for (const r of kept) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= 1.5) last[1] = r[1];
    else merged.push([...r]);
  }

  return { regions: merged, baseline: +median.toFixed(1), threshold: +(median + margin).toFixed(1) };
}

const slug = (s) =>
  (s || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'untitled';

const xmlEscape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

async function probeDuration(cfg, file) {
  const { out } = await run(cfg.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(out.trim());
}

// ---------------------------------------------------------------- SSML

function buildSsml(seg, project) {
  const voice = seg.voice || project.voice;
  const locale = voice.split('-').slice(0, 2).join('-');
  const rate = seg.rate ?? project.rate ?? 0;
  const pitch = seg.pitch ?? project.pitch ?? 0;

  let inner = `<prosody rate="${rate}%" pitch="${pitch}%">${xmlEscape(seg.text)}</prosody>`;

  const style = seg.style || project.style;
  if (style && style !== 'none') {
    const degree = seg.styleDegree ?? project.styleDegree ?? 1;
    inner = `<mstts:express-as style="${xmlEscape(style)}" styledegree="${degree}">${inner}</mstts:express-as>`;
  }

  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">` +
    `<voice name="${xmlEscape(voice)}">${inner}</voice></speak>`
  );
}

// A segment is only re-synthesized when something that affects the audio changes,
// so editing timing or re-rendering never spends Azure quota again.
function segHash(seg, project) {
  return crypto.createHash('sha1').update(buildSsml(seg, project)).digest('hex').slice(0, 16);
}

async function azureVoices(cfg) {
  const res = await fetch(`https://${cfg.azureRegion}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
    headers: { 'Ocp-Apim-Subscription-Key': cfg.azureKey },
  });
  if (!res.ok) throw new Error(`Azure voices list failed: ${res.status} ${res.statusText}`);
  const all = await res.json();
  return all.map((v) => ({
    name: v.ShortName,
    display: v.LocalName || v.DisplayName,
    locale: v.Locale,
    localeName: v.LocaleName,
    gender: v.Gender,
    styles: v.StyleList || [],
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The free F0 tier allows 20 requests per 60 s. A project with more lines than
// that will hit 429 mid-run, so back off and retry instead of failing the batch.
async function synthesize(cfg, ssml, outFile, attempt = 1) {
  const res = await fetch(`https://${cfg.azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': cfg.azureKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
      'User-Agent': 'narrator',
    },
    body: ssml,
  });

  if (res.status === 429 && attempt <= 5) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || attempt * 5000;
    console.log(`  429 - cekam ${wait / 1000}s (pokusaj ${attempt}/5)`);
    await sleep(wait);
    return synthesize(cfg, ssml, outFile, attempt + 1);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const hint = res.status === 401 ? ' (kljuc ili regija ne odgovaraju)' : '';
    throw new Error(`Azure TTS ${res.status} ${res.statusText}${hint}${detail ? ` - ${detail.slice(0, 300)}` : ''}`);
  }

  await fsp.writeFile(outFile, Buffer.from(await res.arrayBuffer()));
}

// ---------------------------------------------------------------- translation

// Translator wants a bare language code ("hr"), not a locale ("hr-HR").
const langCode = (locale) => (locale || '').split('-')[0].toLowerCase();

/**
 * Machine translation is a first draft, never a delivery. It exists so nobody
 * retypes twelve lines by hand; the wording still gets read before it is voiced.
 */
async function translateTexts(cfg, texts, to, from) {
  if (!cfg.translatorKey) {
    throw new Error('AZURE_TRANSLATOR_KEY nije postavljen — vidi README.');
  }

  const url = new URL('https://api.cognitive.microsofttranslator.com/translate');
  url.searchParams.set('api-version', '3.0');
  url.searchParams.set('to', langCode(to));
  if (from) url.searchParams.set('from', langCode(from));
  url.searchParams.set('textType', 'plain');

  const out = [];
  // The API caps a request by element count and total characters, so send the
  // lines in conservative batches rather than trusting one big call.
  const MAX_ITEMS = 50;
  const MAX_CHARS = 40000;

  let batch = [];
  let chars = 0;

  const flush = async () => {
    if (!batch.length) return;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': cfg.translatorKey,
        'Ocp-Apim-Subscription-Region': cfg.translatorRegion,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(batch.map((t) => ({ Text: t }))),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const hint = res.status === 401 ? ' (ključ ili regija ne odgovaraju)' : '';
      throw new Error(`Azure Translator ${res.status}${hint}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
    }
    const data = await res.json();
    for (const item of data) out.push(item.translations?.[0]?.text ?? '');
    batch = [];
    chars = 0;
  };

  for (const t of texts) {
    if (batch.length >= MAX_ITEMS || chars + t.length > MAX_CHARS) await flush();
    batch.push(t);
    chars += t.length;
  }
  await flush();

  return out;
}

// ---------------------------------------------------------------- subtitles

// The two modes are deliberately not interchangeable. Captions must transcribe
// what is actually said - anything else breaks accessibility and YouTube's own
// rules for caption tracks. Titles are separate editorial wording that may say
// something different, or nothing at all.
function screenText(seg, mode) {
  if (mode === 'titles') return (seg.title || '').trim();
  if (mode === 'captions') return (seg.text || '').trim();
  return '';
}

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

function srtTime(s) {
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)},${pad(ms, 3)}`;
}

function assTime(s) {
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `${Math.floor(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}.${pad(cs)}`;
}

// Facebook accepts SRT only, and only when the file is named
// <video>.<lang>_<COUNTRY>.srt - lower-case language, upper-case country. Get it
// wrong and the upload is rejected without explaining why. YouTube does not care
// about the name, so this format is safe for both.
function srtFileName(baseName, locale) {
  const base = (baseName || 'titlovi').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-');
  const m = /^([a-z]{2,3})[-_]([A-Za-z]{2})$/.exec((locale || '').trim());
  if (!m) return `${base}.srt`;
  return `${base}.${m[1].toLowerCase()}_${m[2].toUpperCase()}.srt`;
}

function buildSrt(segments, mode) {
  return segments
    .map((s) => ({ ...s, screen: screenText(s, mode) }))
    .filter((s) => s.screen && s.duration > 0)
    .sort((a, b) => a.start - b.start)
    .map((s, i) =>
      `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.start + s.duration)}\n${s.screen}\n`
    )
    .join('\n');
}

// ASS rather than SRT for burn-in: it carries the styling, so the look does not
// depend on whatever defaults the renderer happens to have.
function buildAss(segments, mode, opts) {
  const { width = 1920, height = 1080, fontSize = 48, position = 'bottom', font = 'Arial' } = opts;
  const alignment = position === 'top' ? 8 : 2;
  const marginV = Math.round(height * 0.055);

  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Narr,${font},${fontSize},&H00FFFFFF,&H00FFFFFF,&H96000000,&H64000000,0,0,0,0,100,100,0,0,1,3,2,${alignment},${Math.round(width * 0.08)},${Math.round(width * 0.08)},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events = segments
    .map((s) => ({ ...s, screen: screenText(s, mode) }))
    .filter((s) => s.screen && s.duration > 0)
    .sort((a, b) => a.start - b.start)
    .map((s) => {
      const text = s.screen.replace(/\r?\n/g, '\\N').replace(/[{}]/g, '');
      // Quick fade so lines appear with the voice rather than snapping in.
      return `Dialogue: 0,${assTime(s.start)},${assTime(s.start + s.duration)},Narr,,0,0,0,,{\\fad(180,180)}${text}`;
    })
    .join('\n');

  return `${head}\n${events}\n`;
}

// ---------------------------------------------------------------- projects

const projectDir = (name) => path.join(PROJECTS, slug(name));

// Windows editors (and PowerShell's Set-Content -Encoding utf8) prepend a BOM,
// which JSON.parse rejects. Strip it so hand-edited projects still load.
async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

async function saveProject(project) {
  const dir = projectDir(project.name);
  await fsp.mkdir(path.join(dir, 'wav'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  return dir;
}

async function listProjects() {
  await fsp.mkdir(PROJECTS, { recursive: true });
  const entries = await fsp.readdir(PROJECTS, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const p = await readJson(path.join(PROJECTS, e.name, 'project.json'));
      out.push({ slug: e.name, name: p.name, segments: p.segments?.length ?? 0 });
    } catch { /* not a project folder */ }
  }
  return out;
}

// ---------------------------------------------------------------- render

const jobs = new Map();

function buildFilter(segments, opts) {
  const parts = [];
  segments.forEach((s, i) => {
    const ms = Math.round(s.start * 1000);
    parts.push(
      `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}:all=1,volume=${opts.voiceGain}[n${i}]`
    );
  });

  const mixIn = segments.map((_, i) => `[n${i}]`).join('');
  parts.push(`${mixIn}amix=inputs=${segments.length}:normalize=0,dynaudnorm=f=250:g=15:p=0.9[narr]`);
  parts.push(`[narr]asplit=2[narrmix][scraw]`);
  // The detector branch gets its own fixed gain, so duck depth depends only on
  // the chosen preset - not on how loud the voice happens to be. Without this,
  // a quiet source and a loud one duck the music by wildly different amounts.
  // apad matters too: sidechaincompress ends with its shortest input, which
  // would otherwise cut the music bed at the final spoken word.
  parts.push(`[scraw]volume=4.0,apad[sc]`);

  if (opts.keepMusic) {
    parts.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${opts.musicGain}[music]`);
    parts.push(
      `[music][sc]sidechaincompress=threshold=${opts.duck.threshold}:ratio=${opts.duck.ratio}:attack=25:release=600:makeup=1[ducked]`
    );
    parts.push(`[ducked][narrmix]amix=inputs=2:normalize=0,alimiter=limit=0.95[aout]`);
  } else {
    parts.push(`[narrmix]alimiter=limit=0.95[aout]`);
  }

  return parts.join(';');
}

// ffmpeg reads the filter argument itself, so a Windows path has to be handed
// over with its backslashes and drive colon escaped or the filter never loads.
const escapeFilterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');

async function renderJob(cfg, jobId, body) {
  const job = jobs.get(jobId);
  try {
    const { videoPath, segments, outPath, titles } = body;
    const dir = projectDir(body.projectName);
    const burn = titles?.burn && titles.mode && titles.mode !== 'off';

    const filter = buildFilter(segments, body.options);
    const args = ['-y', '-i', videoPath];
    for (const s of segments) args.push('-i', path.join(dir, 'wav', s.file));

    if (burn) {
      const assFile = path.join(dir, 'titles.ass');
      await fsp.writeFile(assFile, buildAss(titles.segments, titles.mode, titles.style || {}), 'utf8');

      // Drawing text into the picture makes a stream copy impossible - the video
      // has to be re-encoded. Visually lossless settings, but no longer instant.
      args.push(
        '-filter_complex', `${filter};[0:v]ass='${escapeFilterPath(assFile)}'[vout]`,
        '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'
      );
    } else {
      args.push('-filter_complex', filter, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy');
    }

    args.push('-c:a', 'aac', '-b:a', '192k', '-shortest', outPath);

    job.status = 'running';
    job.reencoding = Boolean(burn);
    await run(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args]);

    // A sidecar file is worth having even when the text is burned in - it is
    // what you upload to YouTube as real captions.
    if (titles?.srt && titles.mode && titles.mode !== 'off') {
      const srtPath = path.join(
        path.dirname(outPath),
        srtFileName(path.basename(outPath), titles.locale)
      );
      await fsp.writeFile(srtPath, buildSrt(titles.segments, titles.mode), 'utf8');
      job.srt = srtPath;
    }

    job.status = 'done';
    job.output = outPath;
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
  }
}

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wav': 'audio/wav' };

function send(res, code, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const cfg = loadConfig();
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  try {
    // --- static ---
    if (req.method === 'GET' && !route.startsWith('/api/')) {
      const rel = route === '/' ? 'index.html' : route.replace(/^\//, '');
      const file = path.join(ROOT, 'public', rel);
      if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      return send(res, 200, await fsp.readFile(file, 'utf8'), MIME[path.extname(file)] || 'text/plain');
    }

    // --- audio preview ---
    if (req.method === 'GET' && route.startsWith('/api/audio/')) {
      const [, , , proj, file] = route.split('/');
      const f = path.join(projectDir(decodeURIComponent(proj)), 'wav', path.basename(decodeURIComponent(file)));
      if (!fs.existsSync(f)) return send(res, 404, { error: 'no audio' });
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': (await fsp.stat(f)).size });
      return fs.createReadStream(f).pipe(res);
    }

    if (route === '/api/status') {
      return send(res, 200, {
        hasKey: Boolean(cfg.azureKey),
        hasTranslator: Boolean(cfg.translatorKey),
        region: cfg.azureRegion,
        ffmpeg: cfg.ffmpeg,
        projects: await listProjects(),
      });
    }

    if (route === '/api/voices') {
      if (!cfg.azureKey) return send(res, 400, { error: 'AZURE_SPEECH_KEY is not set' });
      return send(res, 200, await azureVoices(cfg));
    }

    if (req.method === 'POST' && route === '/api/probe') {
      const { videoPath } = await readBody(req);
      if (!fs.existsSync(videoPath)) return send(res, 400, { error: 'video not found' });
      const { out } = await run(cfg.ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries', 'stream=codec_type,width,height',
        '-of', 'json', videoPath,
      ]);
      const info = JSON.parse(out);
      const v = info.streams.find((s) => s.codec_type === 'video') || {};
      return send(res, 200, {
        duration: parseFloat(info.format.duration),
        width: v.width,
        height: v.height,
        hasAudio: info.streams.some((s) => s.codec_type === 'audio'),
      });
    }

    if (req.method === 'POST' && route === '/api/detect-speech') {
      const { videoPath, margin } = await readBody(req);
      if (!fs.existsSync(videoPath)) return send(res, 400, { error: 'video not found' });
      return send(res, 200, await detectSpeech(cfg, videoPath, Number(margin) || 4));
    }

    if (req.method === 'POST' && route === '/api/project') {
      const project = await readBody(req);
      await saveProject(project);
      return send(res, 200, { ok: true, slug: slug(project.name) });
    }

    // Making another language version means the same timing and structure but
    // different words and a different voice, so the audio is deliberately NOT
    // copied - keeping it would silently leave the old language in the mix.
    if (req.method === 'POST' && route === '/api/project/duplicate') {
      const { from, to, lang } = await readBody(req);
      const src = path.join(projectDir(from), 'project.json');
      if (!fs.existsSync(src)) return send(res, 404, { error: 'no such project' });
      if (!to?.trim()) return send(res, 400, { error: 'novi naziv nedostaje' });
      if (fs.existsSync(path.join(projectDir(to), 'project.json'))) {
        return send(res, 400, { error: 'projekt s tim nazivom vec postoji' });
      }

      const project = await readJson(src);
      project.name = to.trim();
      if (lang) project.lang = lang;
      project.segments = (project.segments || []).map((s) => ({
        ...s,
        file: null,
        duration: 0,
        synthKey: null,
      }));

      await saveProject(project);
      return send(res, 200, { ok: true, slug: slug(project.name) });
    }

    if (req.method === 'GET' && route === '/api/project') {
      const dir = projectDir(url.searchParams.get('name'));
      const file = path.join(dir, 'project.json');
      if (!fs.existsSync(file)) return send(res, 404, { error: 'no such project' });
      return send(res, 200, await readJson(file));
    }

    if (req.method === 'POST' && route === '/api/synthesize') {
      if (!cfg.azureKey) return send(res, 400, { error: 'AZURE_SPEECH_KEY is not set' });
      const project = await readBody(req);
      const dir = await saveProject(project);
      const results = [];

      for (const seg of project.segments) {
        if (!seg.text?.trim()) {
          results.push({ id: seg.id, skipped: true });
          continue;
        }
        const hash = segHash(seg, project);
        const file = `${seg.id}-${hash}.wav`;
        const full = path.join(dir, 'wav', file);

        let cached = true;
        if (!fs.existsSync(full)) {
          cached = false;
          await synthesize(cfg, buildSsml(seg, project), full);
        }
        results.push({ id: seg.id, file, cached, duration: await probeDuration(cfg, full) });
      }
      return send(res, 200, { results });
    }

    if (req.method === 'POST' && route === '/api/translate') {
      const { texts, to, from } = await readBody(req);
      if (!Array.isArray(texts) || !texts.length) return send(res, 400, { error: 'nema teksta' });
      if (!to) return send(res, 400, { error: 'ciljni jezik nedostaje' });

      // Empty lines are kept in place so indexes still line up with segments.
      const idx = [];
      const payload = [];
      texts.forEach((t, i) => {
        if (t && t.trim()) { idx.push(i); payload.push(t); }
      });

      const translated = await translateTexts(cfg, payload, to, from);
      const result = texts.map(() => '');
      idx.forEach((originalIndex, k) => { result[originalIndex] = translated[k] ?? ''; });

      return send(res, 200, { translations: result, chars: payload.join('').length });
    }

    if (req.method === 'POST' && route === '/api/subtitles') {
      const { segments, mode, baseName, locale } = await readBody(req);
      const srt = buildSrt(segments || [], mode || 'captions');
      if (!srt.trim()) return send(res, 400, { error: 'Nema teksta za titlove.' });
      res.writeHead(200, {
        'Content-Type': 'application/x-subrip; charset=utf-8',
        'Content-Disposition': `attachment; filename="${srtFileName(baseName, locale)}"`,
      });
      return res.end(srt);
    }

    if (req.method === 'POST' && route === '/api/render') {
      const body = await readBody(req);
      const jobId = crypto.randomUUID();
      jobs.set(jobId, { status: 'queued' });
      renderJob(cfg, jobId, body);
      return send(res, 200, { jobId });
    }

    if (req.method === 'GET' && route.startsWith('/api/render/')) {
      const job = jobs.get(route.split('/').pop());
      return job ? send(res, 200, job) : send(res, 404, { error: 'no such job' });
    }

    return send(res, 404, { error: 'unknown route' });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  const cfg = loadConfig();
  console.log(`\n  Narrator  ->  http://localhost:${PORT}`);
  console.log(`  region: ${cfg.azureRegion}   key: ${cfg.azureKey ? 'set' : 'MISSING - see README'}`);
  console.log(`  ffmpeg: ${cfg.ffmpeg}\n`);
});

import { PHRASES, CATEGORIES } from "./phrases.js";
import * as store from "./store.js";
import { Recorder, processRecording, encodeWav, drawWaveform, SAMPLE_RATE } from "./audio.js";
import { makeZip } from "./zip.js";

const $ = (id) => document.getElementById(id);
const recorder = new Recorder();
let audioCtx; // shared decode context (created lazily after a user gesture)
const ctx = () => recorder.ctx || (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());

const state = {
  phrases: [...PHRASES],
  recs: new Map(),
  currentId: null,
  take: null, // { wav, result }
  settings: { trim: true, normalize: true, autoKeep: false, server: "", category: "all", onlyMissing: true },
};

// ---------- helpers ----------
let toastTimer;
function toast(msg, ms = 2500) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const fmtMin = (sec) => (sec / 60).toFixed(1);
const norm = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const serverBase = () => (state.settings.server || "").replace(/\/+$/, "");
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
function playBlob(blob) {
  const a = new Audio(URL.createObjectURL(blob));
  a.onended = () => URL.revokeObjectURL(a.src);
  a.play();
  return a;
}
const phraseById = (id) => state.phrases.find((p) => p.id === id);

// ---------- phrase navigation ----------
function categoryList() {
  const c = state.settings.category;
  return c === "all" ? state.phrases : state.phrases.filter((p) => p.category === c);
}
function nextId(fromId, { skipRecorded = state.settings.onlyMissing } = {}) {
  const list = categoryList();
  if (!list.length) return null;
  const start = Math.max(0, list.findIndex((p) => p.id === fromId));
  for (let k = 1; k <= list.length; k++) {
    const p = list[(start + k) % list.length];
    if (!skipRecorded || !state.recs.has(p.id)) return p.id;
  }
  return skipRecorded ? null : list[0].id;
}
function firstId() {
  const list = categoryList();
  const missing = list.find((p) => !state.recs.has(p.id));
  return (missing ?? list[0])?.id ?? null;
}
function prevId(fromId) {
  const list = categoryList();
  const i = list.findIndex((p) => p.id === fromId);
  return list[(i - 1 + list.length) % list.length]?.id;
}

function showPhrase(id) {
  state.currentId = id;
  state.take = null;
  $("review").hidden = true;
  const p = phraseById(id);
  if (!p) {
    $("phraseText").textContent = "🎉 Every phrase in this category is recorded!";
    $("phraseCategory").textContent = "";
    $("phraseId").textContent = "";
    $("phraseStatus").textContent = "Pick another category, untick “Unrecorded only” to redo takes, or sync your data.";
    $("phraseStatus").className = "status";
    $("recordBtn").disabled = true;
    return;
  }
  $("recordBtn").disabled = false;
  $("phraseText").textContent = p.text;
  $("phraseCategory").textContent = p.category;
  $("phraseId").textContent = p.id;
  const rec = state.recs.get(id);
  $("phraseStatus").textContent = rec
    ? `✓ Recorded (${rec.duration.toFixed(1)} s). Record again to replace.`
    : "Not recorded yet";
  $("phraseStatus").className = "status" + (rec ? " done" : "");
  store.setSetting("currentId", id);
}

function updateProgress() {
  const total = state.phrases.length;
  const done = state.phrases.filter((p) => state.recs.has(p.id)).length;
  $("progressFill").style.width = `${total ? (done / total) * 100 : 0}%`;
  $("progressText").textContent = `${done} / ${total}`;
}

// ---------- recording ----------
let meterRaf;
function meterLoop() {
  const lvl = recorder.level();
  const fill = $("meterFill");
  fill.style.width = `${Math.min(100, lvl * 100)}%`;
  fill.classList.toggle("hot", lvl > 0.95);
  meterRaf = requestAnimationFrame(meterLoop);
}

async function toggleRecord() {
  const btn = $("recordBtn");
  if (btn.disabled) return;
  if (!recorder.recording) {
    try {
      await recorder.start();
    } catch (e) {
      toast(e.name === "NotAllowedError" ? "Microphone permission denied." : e.message, 5000);
      return;
    }
    if (!meterRaf) meterLoop();
    $("review").hidden = true;
    btn.classList.add("on");
    btn.setAttribute("aria-label", "Stop recording");
    $("recordHint").textContent = "Recording… tap to stop.";
    return;
  }
  btn.classList.remove("on");
  btn.setAttribute("aria-label", "Start recording");
  $("recordHint").textContent = "Processing…";
  const blob = await recorder.stop();
  try {
    const result = await processRecording(blob, recorder.ctx, state.settings);
    const wav = encodeWav(result.samples);
    state.take = { wav, result };
    $("recordHint").textContent = "Tap the red button, read the phrase, tap again to stop.";
    if (state.settings.autoKeep && !result.warnings.length) return keepTake();
    showReview();
  } catch (e) {
    console.error(e);
    $("recordHint").textContent = "Could not process that take. Try again.";
  }
}

function showReview() {
  const { wav, result } = state.take;
  $("review").hidden = false;
  $("reviewInfo").textContent = `${result.duration.toFixed(2)} s · SNR ${result.snrDb >= 60 ? "> 60" : "≈ " + Math.round(result.snrDb)} dB`;
  $("reviewWarnings").innerHTML = "";
  for (const w of result.warnings) {
    const li = document.createElement("li");
    li.textContent = w;
    $("reviewWarnings").appendChild(li);
  }
  drawWaveform($("waveform"), wav, ctx());
}

async function keepTake() {
  if (!state.take) return;
  const p = phraseById(state.currentId);
  const { wav, result } = state.take;
  const rec = {
    id: p.id,
    text: p.text,
    category: p.category,
    wav,
    duration: result.duration,
    snrDb: result.snrDb,
    warnings: result.warnings,
    createdAt: Date.now(),
    synced: false,
  };
  await store.saveRecording(rec);
  state.recs.set(p.id, rec);
  updateProgress();
  toast(`Saved ${p.id}`, 1200);
  showPhrase(nextId(p.id));
}

// ---------- library ----------
function renderLibrary() {
  const q = norm($("librarySearch").value);
  const f = $("libraryFilter").value;
  const ul = $("libraryList");
  ul.innerHTML = "";
  let lastCat = null;
  const frag = document.createDocumentFragment();
  for (const p of state.phrases) {
    const rec = state.recs.get(p.id);
    if (f === "done" && !rec) continue;
    if (f === "todo" && rec) continue;
    if (f === "warn" && !rec?.warnings?.length) continue;
    if (q && !norm(p.text).includes(q) && !p.id.includes(q)) continue;
    if (p.category !== lastCat) {
      const h = document.createElement("li");
      h.className = "cat";
      h.textContent = p.category;
      frag.appendChild(h);
      lastCat = p.category;
    }
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot" + (rec ? (rec.warnings?.length ? " warn" : " done") : "");
    const txt = document.createElement("div");
    txt.className = "txt";
    txt.textContent = p.text;
    const small = document.createElement("small");
    small.textContent = p.id + (rec ? ` · ${rec.duration.toFixed(1)} s${rec.synced ? " · synced" : ""}` : "");
    txt.appendChild(small);
    li.append(dot, txt);
    if (rec) {
      const play = document.createElement("button");
      play.textContent = "▶";
      play.ariaLabel = "Play";
      play.onclick = () => playBlob(rec.wav);
      li.appendChild(play);
    }
    const go = document.createElement("button");
    go.textContent = rec ? "Redo" : "Rec";
    go.onclick = () => {
      state.settings.category = "all";
      $("categorySelect").value = "all";
      switchView("record");
      showPhrase(p.id);
    };
    li.appendChild(go);
    frag.appendChild(li);
  }
  ul.appendChild(frag);
  if (!ul.children.length) ul.innerHTML = '<li class="small">Nothing matches.</li>';
}

// ---------- speak ----------
async function speak() {
  const text = $("speakText").value.trim();
  if (!text) return;
  const engine = $("engineSelect").value;
  const status = $("speakStatus");
  const audio = $("speakAudio");
  const dl = $("speakDownload");
  audio.hidden = true;
  dl.hidden = true;
  status.textContent = "";

  const showAudio = (blob) => {
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(blob);
    dl.href = audio.src;
    audio.hidden = false;
    dl.hidden = false;
    audio.play().catch(() => {});
  };

  if (engine === "device") {
    if (!("speechSynthesis" in window)) return (status.textContent = "This browser has no speech synthesis.");
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    status.textContent = "Playing with the device's built-in voice (not yours).";
    return;
  }

  if (engine === "bank") {
    const target = norm(text);
    const byText = new Map();
    for (const r of state.recs.values()) byText.set(norm(r.text), r);
    const exact = byText.get(target);
    if (exact) {
      showAudio(exact.wav);
      status.textContent = `Exact match: ${exact.id}`;
      return;
    }
    // Greedy longest-match over recorded phrases/words.
    const words = target.split(" ");
    const pieces = [];
    const missing = [];
    for (let i = 0; i < words.length; ) {
      let found = null;
      for (let j = words.length; j > i; j--) {
        const r = byText.get(words.slice(i, j).join(" "));
        if (r) { found = { r, j }; break; }
      }
      if (found) { pieces.push(found.r.wav); i = found.j; } else { missing.push(words[i]); i++; }
    }
    if (!pieces.length) {
      status.textContent = "No recordings match. Record more single words or custom phrases, or use a trained model.";
      return;
    }
    const decoded = [];
    for (const b of pieces) {
      const buf = await new Promise(async (res, rej) => ctx().decodeAudioData(await b.arrayBuffer(), res, rej));
      decoded.push(buf.getChannelData(0));
    }
    const gap = new Float32Array(Math.round(SAMPLE_RATE * 0.06));
    const total = decoded.reduce((n, d) => n + d.length + gap.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const d of decoded) { out.set(d, o); o += d.length + gap.length; }
    showAudio(encodeWav(out));
    status.textContent = missing.length
      ? `Stitched ${pieces.length} clip(s). Not recorded: ${[...new Set(missing)].join(", ")}`
      : `Stitched ${pieces.length} clip(s) from your recordings.`;
    return;
  }

  // Local server running a trained model.
  status.textContent = "Synthesizing…";
  try {
    const res = await fetch(`${serverBase()}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    showAudio(await res.blob());
    status.textContent = "Spoken by your voice model.";
  } catch (e) {
    status.textContent = `Voice model unavailable: ${e.message}. Start server.py with --model your-voice.onnx (see README).`;
  }
}

// ---------- data ----------
async function renderStats() {
  const recs = [...state.recs.values()];
  const secs = recs.reduce((n, r) => n + r.duration, 0);
  const warn = recs.filter((r) => r.warnings?.length).length;
  const synced = recs.filter((r) => r.synced).length;
  let storage = "–";
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) storage = `${(est.usage / 1e6).toFixed(1)} MB`;
  } catch {}
  const cells = [
    [`${recs.length}/${state.phrases.length}`, "phrases recorded"],
    [fmtMin(secs), "minutes of audio"],
    [warn, "takes with warnings"],
    [`${synced}/${recs.length}`, "synced to computer"],
    [storage, "storage used"],
    [secs >= 1800 ? "Ready" : `${fmtMin(Math.max(0, 1800 - secs))} min`, secs >= 1800 ? "good for fine-tuning" : "to the ~30 min goal"],
  ];
  $("stats").innerHTML = "";
  for (const [b, s] of cells) {
    const d = document.createElement("div");
    d.innerHTML = `<b></b><span></span>`;
    d.querySelector("b").textContent = b;
    d.querySelector("span").textContent = s;
    $("stats").appendChild(d);
  }
}

function metadataCsv(recs) {
  // LJSpeech style: id|transcript (pipes removed from text)
  return recs.map((r) => `${r.id}|${r.text.replace(/\|/g, " ")}`).join("\n") + "\n";
}

async function exportZip() {
  const recs = [...state.recs.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (!recs.length) return toast("Nothing recorded yet.");
  $("exportStatus").textContent = "Building ZIP…";
  const files = recs.map((r) => ({ name: `voicebank/wavs/${r.id}.wav`, data: r.wav }));
  files.push({ name: "voicebank/metadata.csv", data: metadataCsv(recs) });
  files.push({
    name: "voicebank/info.json",
    data: JSON.stringify({ sample_rate: SAMPLE_RATE, channels: 1, bits: 16, count: recs.length, exported: new Date().toISOString() }, null, 2),
  });
  const zip = await makeZip(files);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zip);
  a.download = `voicebank-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  $("exportStatus").textContent = `Exported ${recs.length} clips (${(zip.size / 1e6).toFixed(1)} MB).`;
}

async function sync(all = false) {
  const recs = [...state.recs.values()].filter((r) => all || !r.synced);
  const status = $("syncStatus");
  if (!recs.length) return (status.textContent = "Everything is already synced.");
  $("syncBtn").disabled = $("resyncBtn").disabled = true;
  let ok = 0;
  try {
    const ping = await fetch(`${serverBase()}/api/status`);
    if (!ping.ok) throw new Error("server not reachable");
    for (const r of recs) {
      status.textContent = `Uploading ${ok + 1} / ${recs.length}…`;
      const res = await fetch(`${serverBase()}/api/upload?id=${encodeURIComponent(r.id)}&text=${encodeURIComponent(r.text)}`, {
        method: "PUT",
        headers: { "Content-Type": "audio/wav" },
        body: r.wav,
      });
      if (!res.ok) throw new Error(await res.text());
      r.synced = true;
      await store.saveRecording(r);
      ok++;
    }
    status.textContent = `Synced ${ok} recording(s).`;
  } catch (e) {
    status.textContent = `Synced ${ok}, then failed: ${e.message}. Is server.py running and the URL right?`;
  } finally {
    $("syncBtn").disabled = $("resyncBtn").disabled = false;
    renderStats();
  }
}

async function saveCustom() {
  const lines = $("customText").value.split("\n").map((l) => l.trim()).filter(Boolean);
  const custom = [...new Set(lines)].map((text) => ({ id: `cust_${hash(text)}`, category: "Custom", text }));
  await store.setSetting("customPhrases", custom);
  applyPhrases(custom);
  $("customStatus").textContent = `${custom.length} custom phrase(s) saved.`;
}

function applyPhrases(custom) {
  state.phrases = [...PHRASES, ...custom];
  const sel = $("categorySelect");
  const cats = [...CATEGORIES, ...(custom.length ? ["Custom"] : [])];
  sel.innerHTML = "";
  const all = new Option(`All categories (${state.phrases.length})`, "all");
  sel.add(all);
  for (const c of cats) sel.add(new Option(`${c} (${state.phrases.filter((p) => p.category === c).length})`, c));
  if (![...sel.options].some((o) => o.value === state.settings.category)) state.settings.category = "all";
  sel.value = state.settings.category;
  updateProgress();
}

// ---------- views ----------
function switchView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "library") renderLibrary();
  if (name === "data") renderStats();
  window.scrollTo(0, 0);
}

function saveSettings() {
  store.setSetting("settings", state.settings);
}

// ---------- init ----------
async function init() {
  Object.assign(state.settings, (await store.getSetting("settings")) || {});
  for (const r of await store.allRecordings()) state.recs.set(r.id, r);
  const custom = (await store.getSetting("customPhrases")) || [];
  $("customText").value = custom.map((c) => c.text).join("\n");
  applyPhrases(custom);

  $("onlyMissing").checked = state.settings.onlyMissing;
  $("setTrim").checked = state.settings.trim;
  $("setNormalize").checked = state.settings.normalize;
  $("setAutoKeep").checked = state.settings.autoKeep;
  $("setServer").value = state.settings.server;

  const saved = await store.getSetting("currentId");
  showPhrase(saved && phraseById(saved) ? saved : firstId());

  // Events
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  $("recordBtn").onclick = toggleRecord;
  $("keepBtn").onclick = keepTake;
  $("retryBtn").onclick = () => { state.take = null; $("review").hidden = true; };
  $("playTakeBtn").onclick = () => state.take && playBlob(state.take.wav);
  $("skipBtn").onclick = () => !recorder.recording && showPhrase(nextId(state.currentId) ?? state.currentId);
  $("prevBtn").onclick = () => !recorder.recording && showPhrase(prevId(state.currentId));
  $("categorySelect").onchange = (e) => { state.settings.category = e.target.value; saveSettings(); showPhrase(firstId()); };
  $("onlyMissing").onchange = (e) => { state.settings.onlyMissing = e.target.checked; saveSettings(); };
  $("setTrim").onchange = (e) => { state.settings.trim = e.target.checked; saveSettings(); };
  $("setNormalize").onchange = (e) => { state.settings.normalize = e.target.checked; saveSettings(); };
  $("setAutoKeep").onchange = (e) => { state.settings.autoKeep = e.target.checked; saveSettings(); };
  $("setServer").onchange = (e) => { state.settings.server = e.target.value.trim(); saveSettings(); };
  $("librarySearch").oninput = renderLibrary;
  $("libraryFilter").onchange = renderLibrary;
  $("speakBtn").onclick = speak;
  $("exportBtn").onclick = exportZip;
  $("syncBtn").onclick = () => sync(false);
  $("resyncBtn").onclick = () => sync(true);
  $("customSaveBtn").onclick = saveCustom;
  $("deleteAllBtn").onclick = async () => {
    if (!confirm("Delete ALL recordings from this device? Export or sync first if you want to keep them.")) return;
    await store.clearRecordings();
    state.recs.clear();
    updateProgress();
    renderStats();
    showPhrase(firstId());
    toast("All recordings deleted.");
  };

  // Desktop keyboard shortcuts on the record view.
  document.addEventListener("keydown", (e) => {
    if (!$("view-record").classList.contains("active") || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); toggleRecord(); }
    else if (e.key === "Enter" && state.take) keepTake();
    else if (e.key === "ArrowRight") $("skipBtn").click();
    else if (e.key === "ArrowLeft") $("prevBtn").click();
    else if (e.key === "p" && state.take) playBlob(state.take.wav);
  });

  // Ask the browser not to evict our recordings.
  navigator.storage?.persist?.().catch(() => {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init().catch((e) => {
  console.error(e);
  $("phraseText").textContent = "Failed to start: " + e.message;
});

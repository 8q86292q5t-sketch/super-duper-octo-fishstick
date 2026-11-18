# Voicebank: record your voice, speak in it

A small mobile web app you run yourself. It walks you through **390 phonetically rich phrases**
(plus any custom lines you add) and records clean, training-ready audio of your voice.
You then train a **Piper** text-to-speech voice from that audio and use the app's **Speak** tab to
turn any text into speech in your own voice, all on your own machines.

No accounts, no cloud, no dependencies beyond Python 3 (and Piper for the voice model).

```
phone (record) ──sync──▶ computer: dataset/ ──train──▶ me.onnx ──▶ server.py --model ──▶ phone (speak)
```

## 1. Run it

```bash
python3 server.py
```

It prints two URLs:

* **On this computer:** `https://localhost:8443`
* **On your phone:** `https://<your-computer-ip>:8443` (phone on the same Wi-Fi)

Browsers only let a page use the microphone over HTTPS, so the server generates a
self-signed certificate on first run (needs `openssl`). On the phone, accept the warning once
("Advanced → Proceed" on Chrome, "Show Details → visit this website" on Safari).
Then use **Share → Add to Home Screen** to get an app icon.

> **Fully on the phone (Android):** in [Termux](https://termux.dev), run `pkg install python git`,
> clone this repo, run `python server.py --http --port 8000`, and open `http://localhost:8000`.
> `localhost` counts as secure, so no certificate is needed.

## 2. Record

* **Record tab:** tap the red button, read the phrase, tap again. Each take is converted to
  22.05 kHz mono 16-bit WAV, trimmed and normalized. It's checked for clipping, low volume,
  background noise and length. Then **Keep & next** or **Retry**.
* Phrases are grouped: warm-up, phonetic coverage (pangrams and every English sound),
  conversation, questions, exclamations and emotion, numbers, dates and times,
  names and spelling, long-form reading, single words.
* **Phrases tab:** see what's done, replay takes, redo any of them.
* **Data tab:** sync to the computer, export a ZIP, add custom phrases, adjust settings.
* Desktop shortcuts: `Space` record/stop, `Enter` keep, `P` play, `←/→` prev/skip.

**For a good clone:** use one quiet room, one mic (a headset or earbud mic is better than the
phone's own) and a steady distance. Speak naturally and read the punctuation. Do several short
sessions. About 30 minutes of clean speech (roughly all 390 phrases) is a solid base for
fine-tuning. More is better: add custom phrases with words you actually use.

Recordings are stored in the browser (IndexedDB) until you sync or export. **Sync often.** Browsers,
especially iOS Safari, may clear site data for pages you haven't used in a while.

## 3. Get the data onto your computer

* **Sync** (Data tab): uploads to `dataset/` next to `server.py`:
  ```
  dataset/
    wavs/warm_001.wav ...
    metadata.csv          # id|text            (Piper / LJSpeech, single speaker)
    metadata_files.csv    # id.wav|text        (same, with filenames)
    metadata_coqui.csv    # id|text|text       (Coqui TTS "ljspeech" formatter)
    transcripts.json
  ```
* **Export ZIP:** the same `wavs/` + `metadata.csv`, downloaded on the phone. This also works as a backup.

## 4. Train your voice (on a computer with an NVIDIA GPU)

Training is too heavy for a phone. Fine-tuning an existing Piper voice on your recordings takes
a few hours on a consumer GPU. Free Google Colab GPUs also work.

1. Install Piper with training extras by following the official guide:
   <https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/TRAINING.md>
2. Download a checkpoint (`.ckpt`) of a pretrained English voice of the same quality,
   e.g. `lessac` medium, from <https://huggingface.co/datasets/rhasspy/piper-checkpoints>.
3. Fine-tune from that checkpoint on `dataset/`. With the current Piper the command looks like:
   ```bash
   python3 -m piper.train fit \
     --data.voice_name "me" \
     --data.csv_path dataset/metadata_files.csv \
     --data.audio_dir dataset/wavs \
     --model.sample_rate 22050 \
     --data.espeak_voice "en-us" \
     --data.cache_dir cache/ \
     --data.config_path voices/me.onnx.json \
     --data.batch_size 16 \
     --ckpt_path path/to/lessac-medium.ckpt
   ```
   Check the guide for the exact flags and CSV layout for your Piper version. The three metadata
   files cover the common layouts. (Older `piper_train` uses `metadata.csv` with
   `--dataset-format ljspeech --single-speaker`.)
4. Export the best checkpoint to ONNX (`voices/me.onnx` + `voices/me.onnx.json`) as described
   in the guide. Listen to samples as it trains. Stop when it sounds like you and before it gets
   metallic (over-fitting).

Other routes: the same dataset works with Coqui TTS (`metadata_coqui.csv`). Zero-shot cloning
models (XTTS, F5-TTS and similar) can imitate a voice from a few of these clips without training,
but at lower fidelity and with much heavier runtimes.

## 5. Speak in your voice

```bash
pip install piper-tts
python3 server.py --model voices/me.onnx
```

Open the **Speak** tab, choose **My voice model**, type, and press Speak. You can download the WAV.
Piper runs in real time on a laptop CPU or a Raspberry Pi.

If you use the standalone `piper` binary instead of the pip package:

```bash
python3 server.py --model voices/me.onnx --tts-cmd "piper --model {model} --output_file {out}"
```

Other Speak engines:

* **My recordings:** works before any training. It plays your own takes, stitching together
  recorded phrases and single words. Unrecorded words are listed.
* **Device voice:** the phone's built-in voice, for preview only. It is not your voice.

## Server options

```
python3 server.py [--port 8443] [--http] [--cert c.pem --key k.pem]
                  [--dataset DIR] [--model voice.onnx] [--tts-cmd CMD] [--cors]
```

* `--cors` lets you host the app elsewhere (e.g. a static host) and point
  **Data → Server URL** at your computer.
* The server binds to all interfaces so your phone can reach it. Only run it on networks you trust.

## Files

```
server.py            HTTPS static server, /api/upload (dataset sync), /api/tts (Piper)
app/index.html       UI (Record · Phrases · Speak · Data)
app/app.js           app logic
app/audio.js         mic capture, resample to 22.05 kHz, trim, normalize, quality checks, WAV encoding
app/phrases.js       the 390-phrase recording script (stable ids, never renumber)
app/store.js         IndexedDB storage
app/zip.js           dependency-free ZIP writer
app/sw.js            offline cache (PWA)
```

## Privacy and ethics

Your voice data never leaves your devices unless you move it. Only clone your own voice, or a voice
whose owner has explicitly agreed. Be careful who gets your model: anyone with `me.onnx` can make
"you" say anything.

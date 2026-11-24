// FullVolume phone mic. Plain script, no build step.
//
// The page is served by fullvolumethegame.xyz because a browser only hands the
// microphone to an https page. It introduces itself to the game through the remote's
// API (./api/... is relayed to the game by the website), and from then on the audio
// goes to the PC on a WebRTC data channel (straight over the Wi-Fi when they share one,
// through FullVolume's relay server when they don't): 16 kHz, 10 ms
// numbered frames, unordered and never resent, because a late frame is a useless one.
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const KEY = params.get("k") || "";
  const SEAT = Math.max(0, Math.min(3, parseInt(params.get("s") || "0", 10) || 0));

  const $ = (id) => document.getElementById(id);
  const api = (path) => "." + path + "?k=" + encodeURIComponent(KEY);

  const GATHER_MS = 3000;
  const CONNECT_MS = 12000;
  const PING_MS = 1000;
  const MAX_BUFFERED = 32 * 1024;
  const AUDIO_FRAME = 1;

  let audioContext = null;
  let stream = null;
  let worklet = null;
  let peer = null;
  let audioChannel = null;
  let control = null;
  let wakeLock = null;
  let pingId = 0;
  let pingTimer = 0;
  const pings = new Map();
  let rtt = 0.02;
  let level = 0;

  // The song's clock: where the game said it was, and when we heard.
  let clockSong = null;
  let clockAt = 0;
  let clockPlaying = false;

  let line = null;     // { text, syl: [[from, to, start, end]] }
  let litShown = -1;

  // ------------------------------------------------------------------ ui

  function setLink(text, ok) {
    const link = $("link");
    link.textContent = text;
    link.classList.toggle("is-lost", !ok);
  }

  function problem(html) {
    const p = $("problem");
    p.innerHTML = html;
    p.hidden = !html;
  }

  function showLive(on) {
    $("start").hidden = on;
    $("live").hidden = !on;
  }

  function busy(on) {
    const go = $("go");
    go.classList.toggle("is-busy", on);
    go.disabled = on;
    go.querySelector(".plate__label").textContent = on ? "CONNECTING..." : "CONNECT MIC";
  }

  function deviceName() {
    const ua = navigator.userAgent || "";
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android phone";
    return "Phone";
  }

  // ------------------------------------------------------------------ connect

  async function connect() {
    problem("");
    if (!KEY) { problem("<strong>This link is incomplete.</strong> Scan the code on the TV again."); return; }
    if (!navigator.mediaDevices || !window.RTCPeerConnection || !window.AudioWorkletNode) {
      problem("<strong>This browser can't be a microphone.</strong> Open the link in Safari on iPhone or Chrome on Android.");
      return;
    }

    busy(true);
    try {
      await startMicrophone();
      await startConnection();
    } catch (error) {
      console.warn(error);
      teardown();
      problem(error && error.userMessage ? error.userMessage
        : "<strong>Couldn't reach the game.</strong> Check the phone has internet and FullVolume is still open, then try again.");
      showLive(false);
    } finally {
      busy(false);
    }
  }

  function fail(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
  }

  async function startMicrophone() {
    if (stream) return;
    try {
      // Every voice-call clean-up off: the pitch detector wants the voice as it is.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (error) {
      throw fail(error && error.name === "NotAllowedError"
        ? "<strong>The microphone was blocked.</strong> Allow it for this site in the browser's settings, then tap Connect again."
        : "<strong>No microphone could be opened.</strong> Close other apps using it and try again.");
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    await audioContext.resume();
    await audioContext.audioWorklet.addModule("mic-worklet.js");

    const source = audioContext.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(audioContext, "fv-mic-sender", { numberOfOutputs: 1 });
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    source.connect(worklet);
    worklet.connect(mute).connect(audioContext.destination); // keeps the graph pulling
    worklet.port.onmessage = onFrame;
  }

  async function startConnection() {
    teardownPeer();
    worklet.port.postMessage("restart");

    peer = new RTCPeerConnection({ iceServers: await iceServers() });
    audioChannel = peer.createDataChannel("audio", { ordered: false, maxRetransmits: 0 });
    audioChannel.binaryType = "arraybuffer";
    control = peer.createDataChannel("ctl");

    control.onopen = onControlOpen;
    control.onmessage = onControlMessage;
    control.onclose = () => lost();
    peer.onconnectionstatechange = () => {
      if (peer && (peer.connectionState === "failed" || peer.connectionState === "closed")) lost();
    };

    await peer.setLocalDescription(await peer.createOffer());
    await gathered(peer);

    const track = stream.getAudioTracks()[0];
    const settings = track && track.getSettings ? track.getSettings() : {};
    const inputLatency = (typeof settings.latency === "number" ? settings.latency : 0.03) + 0.006;

    const response = await fetch(api("/api/mic/offer"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: SEAT, sdp: peer.localDescription.sdp, name: deviceName(), latency: inputLatency }),
    });
    if (response.status === 403 || response.status === 410) {
      throw fail("<strong>This code has expired.</strong> Choose PHONE in the game again and scan the new one.");
    }
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw fail("<strong>The game said no:</strong> " + escapeHtml(answer.error || "it did not answer."));

    applySeat(answer.singer, answer.colour);
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });

    // The channel opens once the phone and the PC have found a way to each other:
    // directly on a shared Wi-Fi, otherwise through the relay.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail(
        "<strong>The game answered but the phone can't reach the PC.</strong> Try again, or switch the phone" +
        " between Wi-Fi and mobile data.")), CONNECT_MS);
      control.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  // The relay login the game holds, so the two can meet from any network. Without it
  // (the game is offline, or an old version) only a shared Wi-Fi works.
  async function iceServers() {
    try {
      const response = await fetch(api("/api/mic/ice"), { cache: "no-store" });
      if (!response.ok) return [];
      const body = await response.json();
      return Array.isArray(body.iceServers) ? body.iceServers : [];
    } catch {
      return [];
    }
  }

  function gathered(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", check); resolve(); };
      const check = () => { if (pc.iceGatheringState === "complete") done(); };
      const timer = setTimeout(done, GATHER_MS);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  function onControlOpen() {
    showLive(true);
    $("again").hidden = true;
    setLink("Connected", true);
    keepAwake();
    clearInterval(pingTimer);
    pingTimer = setInterval(ping, PING_MS);
    ping();
  }

  function lost() {
    if (!peer) return;
    teardownPeer();
    setLink("Not connected", false);
    $("again").hidden = false;
    $("hint").textContent = "Lost the game. Tap Reconnect to join again.";
  }

  function teardownPeer() {
    clearInterval(pingTimer);
    try { control && control.close(); } catch { /* closed */ }
    try { audioChannel && audioChannel.close(); } catch { /* closed */ }
    try { peer && peer.close(); } catch { /* closed */ }
    peer = audioChannel = control = null;
  }

  function teardown() {
    teardownPeer();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (audioContext) audioContext.close().catch(() => {});
    audioContext = worklet = null;
  }

  // ------------------------------------------------------------------ audio

  function onFrame(event) {
    const { seq, pcm, rms } = event.data;
    level = Math.max(rms, level * 0.85);

    if (!audioChannel || audioChannel.readyState !== "open") return;
    // A stalled network: dropping is better than arriving late.
    if (audioChannel.bufferedAmount > MAX_BUFFERED) return;

    const packet = new Uint8Array(5 + pcm.byteLength);
    packet[0] = AUDIO_FRAME;
    packet[1] = seq & 0xff; packet[2] = (seq >>> 8) & 0xff; packet[3] = (seq >>> 16) & 0xff; packet[4] = (seq >>> 24) & 0xff;
    packet.set(new Uint8Array(pcm), 5);
    audioChannel.send(packet.buffer);
  }

  // ------------------------------------------------------------------ control

  function ping() {
    if (!control || control.readyState !== "open") return;
    const id = ++pingId;
    pings.set(id, performance.now());
    control.send(JSON.stringify({ t: "ping", id }));
    if (pings.size > 8) pings.delete(pings.keys().next().value);
  }

  function onControlMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }

    switch (message.t) {
      case "pong": {
        const sent = pings.get(message.id);
        if (sent !== undefined) {
          pings.delete(message.id);
          const measured = (performance.now() - sent) / 1000;
          rtt = rtt * 0.7 + measured * 0.3;
          control.send(JSON.stringify({ t: "rtt", rtt: Number(rtt.toFixed(4)) }));
        }
        setClock(message);
        break;
      }
      case "clock": setClock(message); break;
      case "seat": applySeat(message.singer, message.colour); break;
      case "line": setLine(message); break;
      case "idle": setLine(null); clockSong = null; break;
    }
  }

  function applySeat(singer, colour) {
    if (singer) $("singer").textContent = singer;
    if (colour && /^#[0-9a-fA-F]{6}$/.test(colour)) document.body.style.setProperty("--seat", colour);
  }

  function setClock(message) {
    if (message.song === null || message.song === undefined) { clockSong = null; return; }
    const playing = !!message.playing;
    const heard = message.song + (playing ? rtt / 2 : 0);

    // Small differences are drift in the measurement, not the song moving: ease them in
    // so the wipe never jumps backwards by a few letters.
    const now = performance.now();
    const ours = songNow(now);
    clockSong = ours !== null && playing && clockPlaying && Math.abs(ours - heard) < 0.08
      ? ours + (heard - ours) * 0.25
      : heard;
    clockAt = now;
    clockPlaying = playing;
  }

  function songNow(now) {
    if (clockSong === null) return null;
    return clockSong + (clockPlaying ? (now - clockAt) / 1000 : 0);
  }

  function setLine(message) {
    const text = message ? message.text || "" : "";
    const next = message ? message.next || "" : "";
    line = text ? { text, syl: Array.isArray(message.syl) ? message.syl : [] } : null;
    litShown = -1;

    const el = $("line");
    el.classList.add("is-swap");
    requestAnimationFrame(() => {
      $("sung").textContent = "";
      $("unsung").textContent = text;
      $("next").textContent = next;
      $("idle").hidden = !!(text || next);
      el.classList.remove("is-swap");
    });
  }

  // The same rule as the game's own wipe: a syllable fills in proportion to its time.
  function litCharacters(t) {
    let lit = 0;
    for (const [from, to, start, end] of line.syl) {
      if (t >= end) { lit = to; continue; }
      if (t <= start) break;
      lit = from + Math.round(((t - start) / Math.max(end - start, 0.0001)) * (to - from));
      break;
    }
    return Math.min(lit, line.text.length);
  }

  // ------------------------------------------------------------------ frame loop

  function frame() {
    const now = performance.now();

    const fill = $("meter");
    const shown = Math.min(1, level * 9);
    fill.style.transform = `scaleX(${shown.toFixed(3)})`;
    $("meterBox").setAttribute("aria-valuenow", String(Math.round(shown * 100)));
    level *= 0.92;

    const t = songNow(now);
    if (line && t !== null) {
      const lit = litCharacters(t);
      if (lit !== litShown) {
        litShown = lit;
        $("sung").textContent = line.text.slice(0, lit);
        $("unsung").textContent = line.text.slice(lit);
      }
    }

    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ screen on

  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch { /* not allowed now; asked again when the page is visible */ }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && peer) {
      keepAwake();
      if (audioContext && audioContext.state !== "running") audioContext.resume().catch(() => {});
    }
  });

  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------------ start

  $("go").addEventListener("click", connect);
  $("again").addEventListener("click", async () => {
    $("again").hidden = true;
    $("hint").textContent = "Reconnecting...";
    try { await startConnection(); $("hint").textContent = "Sing and watch the bar move. The PC hears exactly this."; }
    catch (error) {
      teardownPeer();
      setLink("Not connected", false);
      $("again").hidden = false;
      $("hint").innerHTML = error.userMessage || "Couldn't reach the game. Try again.";
    }
  });

  requestAnimationFrame(frame);
})();

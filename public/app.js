/* ================================================================
   NES ROOM — app.js  (Socket.IO relay version)
================================================================ */

const App = (() => {

  const BTN = { A:0, B:1, SELECT:2, START:3, UP:4, DOWN:5, LEFT:6, RIGHT:7 };

  let KEYS = {
    'w': BTN.UP, 'W': BTN.UP,
    's': BTN.DOWN, 'S': BTN.DOWN,
    'a': BTN.LEFT, 'A': BTN.LEFT,
    'd': BTN.RIGHT, 'D': BTN.RIGHT,
    'j': BTN.B, 'J': BTN.B,
    'k': BTN.A, 'K': BTN.A,
    'Enter': BTN.START,
    'Shift': BTN.SELECT
  };

  // ── Remap ─────────────────────────────────────────────────────
  let isRemapping = false, remapStep = 0, newKeys = {};
  const remapOrder = [
    { btn: BTN.UP,     name: 'UP',     id: 'kbd-up'     },
    { btn: BTN.LEFT,   name: 'LEFT',   id: 'kbd-left'   },
    { btn: BTN.DOWN,   name: 'DOWN',   id: 'kbd-down'   },
    { btn: BTN.RIGHT,  name: 'RIGHT',  id: 'kbd-right'  },
    { btn: BTN.B,      name: 'B',      id: 'kbd-b'      },
    { btn: BTN.A,      name: 'A',      id: 'kbd-a'      },
    { btn: BTN.START,  name: 'START',  id: 'kbd-start'  },
    { btn: BTN.SELECT, name: 'SELECT', id: 'kbd-select' },
  ];
  function startRemap() {
    isRemapping = true; remapStep = 0; newKeys = {};
    toast('Press key for ' + remapOrder[0].name, 'success');
  }

  // ── State ─────────────────────────────────────────────────────
  let role     = null;   // 'host' | 'p2'
  let myPlayer = 1;
  let myKeys   = {};
  let roomCode = null;
  let socket   = null;
  let nes      = null;
  let rafId    = null;
  let frameCount = 0;
  let keysSetup = false;  // prevent duplicate key listeners
  let syncInterval = null;  // periodic state sync (host only)

  const SERVER = 'https://snesroomsignallingserver.onrender.com';

  // Audio
  let audioCtx = null, leftBuf = [], rightBuf = [];

  // ROM
  let romBuffer = null, romChunks = {}, romTotalChunks = 0,
      romReceivedCount = 0, romSize = 0;
  let p2Joined = false;  // track whether P2 is already in the room

  // Canvas
  let canvas, ctx2d, imageData;
  const CHUNK_SIZE = 8192;

  // ── Screen helper ─────────────────────────────────────────────
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
  }
  function showWelcome() { cleanup(); showScreen('welcome'); }

  // ── Toast ─────────────────────────────────────────────────────
  function toast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3000);
  }

  // ── Socket setup ──────────────────────────────────────────────
  function connectSocket(onReady) {
    socket = io(SERVER, { transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      console.log('[NESRoom] Socket connected:', socket.id);
      onReady();
    });
    socket.on('connect_error', e => {
      toast('Server unreachable: ' + e.message, 'error');
    });
    socket.on('relay', msg => onData(msg));
    socket.on('peer_joined', () => {
      if (role === 'host') {
        p2Joined = true;
        if (romBuffer) {
          setHostStatus('✓ Player 2 connected! Sending ROM...');
          sendROM();
        } else {
          setHostStatus('✓ Player 2 connected! Now select a ROM to start.');
        }
        toast('Player 2 joined!', 'success');
      }
    });
    socket.on('peer_left', () => {
      toast('Other player disconnected.', 'error');
      showWelcome();
    });
    socket.on('disconnect', () => {
      if (role) toast('Lost connection to server.', 'error');
    });
  }

  function send(msg) {
    if (socket && socket.connected) {
      socket.emit('relay', { code: roomCode, msg });
    }
  }

  // ── HOST ──────────────────────────────────────────────────────
  function startHost() {
    role = 'host'; myPlayer = 1; myKeys = KEYS;
    showScreen('host');
    roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    connectSocket(() => {
      socket.emit('host', roomCode);
      socket.on('host_ok', code => {
        document.getElementById('room-code').textContent = code;
        document.getElementById('btn-copy').disabled = false;
        setHostStatus('Share the code above with Player 2 — then load your ROM.');
      });
    });
  }

  function copyRoomCode() {
    const code = document.getElementById('room-code').textContent.trim();
    navigator.clipboard.writeText(code)
      .then(() => toast('Room code copied!', 'success'))
      .catch(() => toast('Copy failed — please copy manually.', 'error'));
  }

  function onRomSelected(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    document.getElementById('rom-label-text').textContent = '✓ ' + file.name;
    const reader = new FileReader();
    reader.onload = e => {
      romBuffer = e.target.result;
      if (p2Joined) {
        // P2 is already waiting — send ROM right away
        setHostStatus('Sending ROM to Player 2...');
        sendROM();
      } else {
        setHostStatus('ROM loaded. Waiting for Player 2 to join...');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function setHostStatus(msg) {
    document.getElementById('host-status').textContent = msg;
  }

  // ── P2 JOIN ───────────────────────────────────────────────────
  function showJoin() { showScreen('join'); }

  function joinGame() {
    const code = document.getElementById('join-input').value.trim().toUpperCase();
    if (!code) { toast('Enter the room code!', 'error'); return; }

    role = 'p2'; myPlayer = 2; myKeys = KEYS; roomCode = code;

    const statusEl = document.getElementById('join-status');
    statusEl.textContent = 'Connecting to server...';
    statusEl.classList.remove('hidden');
    document.getElementById('btn-join-go').disabled = true;

    connectSocket(() => {
      statusEl.textContent = 'Joining room "' + code + '"...';
      socket.emit('join', code);
      socket.on('join_ok', () => {
        statusEl.textContent = '✓ Connected! Waiting for host to send ROM...';
        toast('Connected to host!', 'success');
      });
      socket.on('join_err', msg => {
        statusEl.textContent = '⚠ ' + msg;
        document.getElementById('btn-join-go').disabled = false;
        toast(msg, 'error');
      });
    });
  }

  // ── Data handler ──────────────────────────────────────────────
  function onData(msg) {
    switch (msg.t) {
      case 'rom_meta':
        romTotalChunks = msg.total; romSize = msg.size;
        romChunks = {}; romReceivedCount = 0;
        setJoinProgress(0, 'Receiving ROM 0%');
        break;

      case 'rom_chunk':
        romChunks[msg.i] = msg.d;
        romReceivedCount++;
        const pct = (romReceivedCount / romTotalChunks * 100) | 0;
        setJoinProgress(romReceivedCount / romTotalChunks, 'Receiving ROM ' + pct + '%');
        break;

      case 'rom_done':
        assembleAndStart();
        break;

      case 'game_start':
        initAndPlay();
        break;

      case 'b':
        if (!nes) return;
        const remote = (role === 'host') ? 2 : 1;
        if (msg.s) nes.buttonDown(remote, msg.b);
        else       nes.buttonUp(remote,   msg.b);
        break;

      case 'rom_ready':
        // P2 confirmed ROM is assembled — start both players now
        if (role === 'host') {
          send({ t: 'game_start' });
          initAndPlay();
        }
        break;

      case 'sync':
        // Host's state snapshot — P2 applies it to stay in sync
        if (role === 'p2' && nes) {
          try { nes.fromJSON(msg.state); } catch(e) { /* ignore minor errors */ }
        }
        break;
    }
  }

  // ── ROM transfer ──────────────────────────────────────────────
  function sendROM() {
    const bytes = new Uint8Array(romBuffer);
    const total = Math.ceil(bytes.length / CHUNK_SIZE);
    send({ t: 'rom_meta', total, size: bytes.length });
    setHostProgress(0, 'Sending ROM to Player 2...');
    document.getElementById('host-progress').classList.remove('hidden');
    setHostStatus('Transferring ROM...');

    let i = 0;
    function next() {
      if (i >= total) {
        send({ t: 'rom_done' });
        setHostProgress(1, '✓ ROM sent! Waiting for Player 2 to load...');
        // Don't start yet — wait for P2's 'rom_ready' confirmation
        return;
      }
      const start = i * CHUNK_SIZE;
      const slice = bytes.slice(start, start + CHUNK_SIZE);
      let b64 = '';
      for (let j = 0; j < slice.length; j++) b64 += String.fromCharCode(slice[j]);
      send({ t: 'rom_chunk', i, d: btoa(b64) });
      setHostProgress(i / total, 'Sending ROM ' + ((i / total * 100) | 0) + '%');
      i++;
      setTimeout(next, 0);
    }
    next();
  }

  function assembleAndStart() {
    const bytes = new Uint8Array(romSize);
    let offset = 0;
    for (let i = 0; i < romTotalChunks; i++) {
      const raw = atob(romChunks[i]);
      for (let j = 0; j < raw.length; j++) bytes[offset++] = raw.charCodeAt(j);
    }
    romBuffer = bytes.buffer;
    setJoinProgress(1, '✓ ROM received! Ready to play.');
    toast('ROM received!', 'success');
    // Tell host we're ready
    send({ t: 'rom_ready' });
  }

  // ── Start emulation ───────────────────────────────────────────
  function initAndPlay() {
    if (nes) return;
    showScreen('game');
    initCanvas(); initAudio(); initNES(); startLoop();
    // Host sends state to P2 every 3 seconds to keep emulators in sync
    if (role === 'host') {
      syncInterval = setInterval(() => {
        if (nes) {
          try { send({ t: 'sync', state: nes.toJSON() }); } catch(e) {}
        }
      }, 3000);
    }
    toast(role === 'host' ? 'Game started! You are P1.' : 'Game started! You are P2.', 'success');
  }

  function initCanvas() {
    canvas    = document.getElementById('nes-canvas');
    ctx2d     = canvas.getContext('2d');
    imageData = ctx2d.createImageData(256, 240);
  }

  function initAudio() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const bufSize   = 2048;
      const processor = audioCtx.createScriptProcessor(bufSize, 0, 2);
      processor.onaudioprocess = e => {
        const L = e.outputBuffer.getChannelData(0);
        const R = e.outputBuffer.getChannelData(1);
        const size = Math.min(bufSize, leftBuf.length);
        for (let i = 0; i < size; i++) { L[i] = leftBuf[i]; R[i] = rightBuf[i]; }
        for (let i = size; i < bufSize; i++) { L[i] = 0; R[i] = 0; }
        leftBuf.splice(0, size); rightBuf.splice(0, size);
      };
      processor.connect(audioCtx.destination);
    } catch(e) { console.warn('Audio init failed:', e); }
  }

  function initNES() {
    nes = new jsnes.NES({
      onFrame(fb)          { renderFrame(fb); },
      onAudioSample(l, r)  { leftBuf.push(l); rightBuf.push(r); }
    });
    const bytes = new Uint8Array(romBuffer);
    let romStr = '';
    for (let i = 0; i < bytes.length; i++) romStr += String.fromCharCode(bytes[i]);
    nes.loadROM(romStr);
    document.getElementById('game-title').textContent = 'NES ROOM';
    setupKeys();
  }

  let buf32 = null;
  function renderFrame(frameBuffer) {
    if (!buf32) buf32 = new Uint32Array(imageData.data.buffer);
    for (let i = 0; i < 256 * 240; i++) {
      const c = frameBuffer[i];
      buf32[i] = 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);
    }
    ctx2d.putImageData(imageData, 0, 0);
  }

  let lastFrameTime = 0, unsimulatedMs = 0;
  const FRAME_MS = 1000 / 60;

  function startLoop() {
    function loop(ts) {
      rafId = requestAnimationFrame(loop);
      if (!lastFrameTime) lastFrameTime = ts;
      const dt = ts - lastFrameTime; lastFrameTime = ts;
      unsimulatedMs += dt;
      if (unsimulatedMs > 100) unsimulatedMs = 100;
      if (!nes) return;
      while (unsimulatedMs >= FRAME_MS) { nes.frame(); frameCount++; unsimulatedMs -= FRAME_MS; }
    }
    rafId = requestAnimationFrame(loop);
  }

  function setupKeys() {
    if (keysSetup) return;  // only register once
    keysSetup = true;
    document.addEventListener('keydown', e => {
      if (isRemapping) {
        e.preventDefault();
        const step = remapOrder[remapStep];
        if (e.key.length === 1) {
          newKeys[e.key.toLowerCase()] = step.btn;
          newKeys[e.key.toUpperCase()] = step.btn;
        } else { newKeys[e.key] = step.btn; }
        let dk = e.key === ' ' ? 'Space' : e.key === 'ArrowUp' ? '↑' :
                 e.key === 'ArrowDown' ? '↓' : e.key === 'ArrowLeft' ? '←' :
                 e.key === 'ArrowRight' ? '→' : e.key.toUpperCase();
        document.getElementById(step.id).textContent = dk;
        remapStep++;
        if (remapStep < remapOrder.length) toast('Press key for ' + remapOrder[remapStep].name, 'success');
        else { isRemapping = false; KEYS = newKeys; myKeys = KEYS; toast('Controls updated!', 'success'); }
        return;
      }
      if (!nes || !document.getElementById('screen-game').classList.contains('active')) return;
      const btn = myKeys[e.key];
      if (btn === undefined) return;
      e.preventDefault();
      nes.buttonDown(myPlayer, btn);
      send({ t: 'b', b: btn, s: 1 });
    });

    document.addEventListener('keyup', e => {
      if (isRemapping) return;
      if (!nes || !document.getElementById('screen-game').classList.contains('active')) return;
      const btn = myKeys[e.key];
      if (btn === undefined) return;
      e.preventDefault();
      nes.buttonUp(myPlayer, btn);
      send({ t: 'b', b: btn, s: 0 });
    });
  }

  // ── Progress helpers ──────────────────────────────────────────
  function setHostProgress(pct, label) {
    document.getElementById('host-progress').classList.remove('hidden');
    document.getElementById('host-progress-fill').style.width = (pct * 100).toFixed(0) + '%';
    document.getElementById('host-progress-label').textContent = label;
  }
  function setJoinProgress(pct, label) {
    document.getElementById('join-progress').classList.remove('hidden');
    document.getElementById('join-progress-fill').style.width = (pct * 100).toFixed(0) + '%';
    document.getElementById('join-progress-label').textContent = label;
    document.getElementById('join-status').textContent = label;
    document.getElementById('join-status').classList.remove('hidden');
  }

  // ── Cleanup ───────────────────────────────────────────────────
  function cleanup() {
    if (rafId)    { cancelAnimationFrame(rafId); rafId = null; }
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
    if (nes)      { nes = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (socket)   { socket.disconnect(); socket = null; }
    leftBuf = []; rightBuf = [];
    romBuffer = null; romChunks = {};
    romTotalChunks = 0; romReceivedCount = 0;
    frameCount = 0; role = null; roomCode = null; p2Joined = false;
    buf32 = null;  // reset so new imageData gets a fresh view
    lastFrameTime = 0; unsimulatedMs = 0;  // reset game loop timing
    document.getElementById('room-code').innerHTML = '<span class="blink">CONNECTING...</span>';
    document.getElementById('btn-copy').disabled = true;
    document.getElementById('host-status').textContent = 'Getting your room code...';
    document.getElementById('host-progress').classList.add('hidden');
    document.getElementById('rom-label-text').textContent = '📁 SELECT ROM FILE (.nes)';
    document.getElementById('rom-input').value = '';
    document.getElementById('join-status').classList.add('hidden');
    document.getElementById('join-progress').classList.add('hidden');
    document.getElementById('join-input').value = '';
    document.getElementById('btn-join-go').disabled = false;
  }

  return { startHost, showJoin, joinGame, copyRoomCode, onRomSelected, showWelcome, startRemap, disconnect: showWelcome };

})();

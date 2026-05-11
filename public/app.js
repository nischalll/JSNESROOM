/* ================================================================
   NES ROOM — app.js  (PeerJS WebRTC P2P version)
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
  let peer     = null;   // PeerJS Peer instance
  let conn     = null;   // PeerJS DataConnection
  let nes      = null;
  let rafId    = null;
  let frameCount = 0;
  let keysSetup = false;  // prevent duplicate key listeners
  let localBtnState = [0,0,0,0,0,0,0,0];
  let remoteBtnState = [0,0,0,0,0,0,0,0];
  let btnSyncInterval = null;
  let syncInterval = null;  // periodic compressed state sync (host only)

  // ── Debug Logging ─────────────────────────────────────────────
  let debugEnabled = false;
  function logDebug(msg) {
    if (!debugEnabled) return; // Zero overhead when panel is hidden
    
    const time = new Date().toISOString().split('T')[1].slice(0, -1);
    const line = `[${time}] [${role ? role.toUpperCase() : 'APP'}] ${msg}`;
    console.log(line);
    
    const container = document.getElementById('debug-logs');
    if (container) {
      const el = document.createElement('div');
      el.textContent = line;
      container.appendChild(el);
      // Cap at 50 logs to prevent DOM memory bloat
      while (container.childNodes.length > 50) {
        container.removeChild(container.firstChild);
      }
      container.scrollTop = container.scrollHeight;
    }
  }

  // Allow toggling debug logs at any time, even before game starts
  document.addEventListener('keydown', e => {
    if (e.key === '`' || e.key === '~') {
      debugEnabled = !debugEnabled;
      const container = document.getElementById('debug-logs');
      if (container) container.style.display = debugEnabled ? 'block' : 'none';
      logDebug(`Debug logs toggled ${debugEnabled ? 'ON' : 'OFF'}`);
    }
  });

  // PeerJS free cloud used for signaling only (1 handshake). All game data is P2P.

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

  // ── PeerJS P2P helpers ────────────────────────────────────────
  function send(msg) {
    if (conn && conn.open) conn.send(msg);
  }

  function onConnOpen() {
    logDebug('P2P data channel open.');
  }

  function onConnClose() {
    logDebug('P2P connection closed.');
    conn = null;
    if (role === 'host') {
      toast('Player 2 disconnected. Waiting for new player...', 'error');
      p2Joined = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (btnSyncInterval) { clearInterval(btnSyncInterval); btnSyncInterval = null; }
      if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
      showScreen('host');
      setHostStatus('Player 2 left. Room is still open: ' + roomCode);
      document.getElementById('host-progress').classList.add('hidden');
    } else {
      toast('Connection closed by host.', 'error');
      showWelcome();
    }
  }

  // ── HOST ──────────────────────────────────────────────────────
  function startHost() {
    role = 'host'; myPlayer = 1; myKeys = KEYS;
    showScreen('host');
    setHostStatus('Getting your room code...');

    peer = new Peer(); // PeerJS assigns a free unique ID
    peer.on('open', id => {
      roomCode = id;
      document.getElementById('room-code').textContent = id;
      document.getElementById('btn-copy').disabled = false;
      setHostStatus('Share the code above with Player 2 — then load your ROM.');
      logDebug('PeerJS opened. Room code: ' + id);
    });
    peer.on('connection', c => {
      conn = c;
      conn.serialization = 'binary';
      conn.on('open', () => {
        p2Joined = true;
        onConnOpen();
        if (romBuffer) {
          setHostStatus('✓ Player 2 connected! Sending ROM...');
          sendROM();
        } else {
          setHostStatus('✓ Player 2 connected! Now select a ROM to start.');
        }
        toast('Player 2 joined!', 'success');
      });
      conn.on('data', msg => onData(msg));
      conn.on('close', onConnClose);
      conn.on('error', e => logDebug('Conn error: ' + e));
    });
    peer.on('error', e => toast('Connection error: ' + e.type, 'error'));
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
    const code = document.getElementById('join-input').value.trim();
    if (!code) { toast('Enter the room code!', 'error'); return; }

    role = 'p2'; myPlayer = 2; myKeys = KEYS; roomCode = code;

    const statusEl = document.getElementById('join-status');
    statusEl.textContent = 'Connecting...';
    statusEl.classList.remove('hidden');
    document.getElementById('btn-join-go').disabled = true;

    peer = new Peer();
    peer.on('open', () => {
      logDebug('PeerJS open, connecting to host: ' + code);
      statusEl.textContent = 'Connecting to host...';
      conn = peer.connect(code, { reliable: true, serialization: 'binary' });
      conn.on('open', () => {
        onConnOpen();
        statusEl.textContent = '✓ Connected! Waiting for host to send ROM...';
        toast('Connected to host!', 'success');
      });
      conn.on('data', msg => onData(msg));
      conn.on('close', onConnClose);
      conn.on('error', e => {
        statusEl.textContent = '⚠ Could not connect. Check the room code.';
        document.getElementById('btn-join-go').disabled = false;
        toast('Connection failed', 'error');
        logDebug('Conn error: ' + e);
      });
    });
    peer.on('error', e => {
      statusEl.textContent = '⚠ ' + e.type + '. Check the room code.';
      document.getElementById('btn-join-go').disabled = false;
      toast('Error: ' + e.type, 'error');
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

      case 'btns':
        if (!nes) return;
        const remote = (role === 'host') ? 2 : 1;
        const newState = msg.s;
        let changed = false;
        for (let i = 0; i < 8; i++) {
          if (newState[i] && !remoteBtnState[i]) {
            nes.buttonDown(remote, i);
            remoteBtnState[i] = 1;
            changed = true;
          } else if (!newState[i] && remoteBtnState[i]) {
            nes.buttonUp(remote, i);
            remoteBtnState[i] = 0;
            changed = true;
          }
        }
        if (changed) logDebug(`Applied remote buttons: [${newState.join(',')}]`);
        break;

      case 'rom_ready':
        // P2 confirmed ROM is assembled — start both players now
        if (role === 'host') {
          send({ t: 'game_start' });
          initAndPlay();
          // Force an immediate sync so P2 snaps to exact current state if Host resumed
          if (nes) {
            try { send({ t: 'sync', d: compressState(nes.toJSON()) }); } catch(e) {}
          }
        }
        break;

      case 'sync':
        // Host's state snapshot — P2 decompresses and applies it to stay in perfect sync
        if (role === 'p2' && nes) {
          try {
            logDebug('Received compressed state sync from Host.');
            const stateObj = decompressState(msg.d);
            nes.fromJSON(stateObj);
            
            // CRITICAL FIX: nes.fromJSON() overwrites the emulator's internal controller memory.
            // If the Host's state thinks we are NOT holding UP, but our physical finger is on the UP key,
            // the game will stop moving us. We MUST immediately re-apply our local physical keys!
            for (let i=0; i<8; i++) {
              if (localBtnState[i]) nes.buttonDown(myPlayer, i);
              else nes.buttonUp(myPlayer, i);
              
              if (remoteBtnState[i]) nes.buttonDown(1, i); // Host is player 1
              else nes.buttonUp(1, i);
            }
            logDebug('State applied and physical keys restored.');
          } catch(e) { logDebug(`Sync apply failed: ${e.message}`); }
        }
        break;
    }
  }

  // ── Compression helpers ───────────────────────────────────────
  function compressState(stateObj) {
    const bytes = fflate.strToU8(JSON.stringify(stateObj));
    return fflate.deflateSync(bytes); // Uint8Array sent natively over WebRTC data channel
  }
  function decompressState(compressedData) {
    const bytes = new Uint8Array(compressedData);
    const decompressed = fflate.inflateSync(bytes);
    return JSON.parse(fflate.strFromU8(decompressed));
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
        return;
      }
      const slice = bytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE); // raw binary, no base64
      send({ t: 'rom_chunk', i, d: slice });
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
      const chunk = new Uint8Array(romChunks[i]); // already raw binary
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    romBuffer = bytes.buffer;
    setJoinProgress(1, '✓ ROM received! Ready to play.');
    toast('ROM received!', 'success');
    // Tell host we're ready
    send({ t: 'rom_ready' });
  }

  // ── Start emulation ───────────────────────────────────────────
  function initAndPlay() {
    let resumed = false;
    if (nes) {
      resumed = true;
      if (!rafId) startLoop();
    } else {
      initCanvas(); initAudio(); initNES(); startLoop();
    }
    showScreen('game');

    // Automatically correct stuck keys every 100ms
    if (!btnSyncInterval) {
      btnSyncInterval = setInterval(() => {
        if (nes && conn && conn.open) {
          send({ t: 'btns', s: localBtnState });
        }
      }, 100);
    }

    // Host sends compressed state to P2 every 5 seconds to keep emulators in perfect sync
    if (role === 'host' && !syncInterval) {
      syncInterval = setInterval(() => {
        if (nes && conn && conn.open) {
          try { 
            const stateData = compressState(nes.toJSON());
            send({ t: 'sync', d: stateData }); 
            logDebug('Sent state sync to Player 2.');
          } catch(e) { logDebug('Failed to send sync.'); }
        }
      }, 5000);
    }

    const msg = role === 'host' 
      ? (resumed ? 'Game resumed! You are P1.' : 'Game started! You are P1.')
      : 'Game started! You are P2.';
    toast(msg, 'success');
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
      onAudioSample(l, r)  { 
        leftBuf.push(l); rightBuf.push(r); 
        // Cap audio buffer to prevent latency buildup (max 8192 samples = ~185ms)
        if (leftBuf.length > 8192) {
          const excess = leftBuf.length - 8192;
          leftBuf.splice(0, excess);
          rightBuf.splice(0, excess);
        }
      }
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

    // Toggle Debug Log with Backtick `
    document.addEventListener('keydown', e => {
      if (e.key === '`' || e.key === '~') {
        debugEnabled = !debugEnabled;
        const container = document.getElementById('debug-logs');
        if (container) container.style.display = debugEnabled ? 'block' : 'none';
        logDebug(`Debug logs toggled ${debugEnabled ? 'ON' : 'OFF'}`);
      }
    });

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
      if (!localBtnState[btn]) {
        localBtnState[btn] = 1;
        nes.buttonDown(myPlayer, btn);
        send({ t: 'btns', s: localBtnState });
        logDebug(`Key pressed. Local state: [${localBtnState.join(',')}]`);
      }
    });

    document.addEventListener('keyup', e => {
      if (isRemapping) return;
      if (!nes || !document.getElementById('screen-game').classList.contains('active')) return;
      const btn = myKeys[e.key];
      if (btn === undefined) return;
      e.preventDefault();
      if (localBtnState[btn]) {
        localBtnState[btn] = 0;
        nes.buttonUp(myPlayer, btn);
        send({ t: 'btns', s: localBtnState });
        logDebug(`Key released. Local state: [${localBtnState.join(',')}]`);
      }
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
    if (btnSyncInterval) { clearInterval(btnSyncInterval); btnSyncInterval = null; }
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
    if (nes)      { nes = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (conn)     { conn.close(); conn = null; }
    if (peer)     { peer.destroy(); peer = null; }
    leftBuf = []; rightBuf = [];
    romBuffer = null; romChunks = {};
    romTotalChunks = 0; romReceivedCount = 0;
    frameCount = 0; role = null; roomCode = null; p2Joined = false;
    localBtnState = [0,0,0,0,0,0,0,0];
    remoteBtnState = [0,0,0,0,0,0,0,0];
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

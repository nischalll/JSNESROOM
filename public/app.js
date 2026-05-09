/* ================================================================
   NES ROOM — app.js
   PeerJS (P2P) + JSNES — No server, browser-to-browser
================================================================ */

const App = (() => {

  // ── Button constants (JSNES) ──────────────────────────────────
  const BTN = { A:0, B:1, SELECT:2, START:3, UP:4, DOWN:5, LEFT:6, RIGHT:7 };

  // ── Key → Button maps ─────────────────────────────────────────
  const P1_KEYS = {
    'ArrowUp':    BTN.UP,    'ArrowDown':  BTN.DOWN,
    'ArrowLeft':  BTN.LEFT,  'ArrowRight': BTN.RIGHT,
    'z': BTN.B,  'Z': BTN.B,
    'x': BTN.A,  'X': BTN.A,
    'Enter': BTN.START,  'Shift': BTN.SELECT
  };
  const P2_KEYS = {
    'w': BTN.UP,  'W': BTN.UP,  's': BTN.DOWN,  'S': BTN.DOWN,
    'a': BTN.LEFT,'A': BTN.LEFT,'d': BTN.RIGHT, 'D': BTN.RIGHT,
    'k': BTN.B,   'K': BTN.B,
    'l': BTN.A,   'L': BTN.A,
    'g': BTN.START,'G': BTN.START,
    'h': BTN.SELECT,'H': BTN.SELECT
  };

  // ── State ─────────────────────────────────────────────────────
  let role      = null;   // 'host' | 'p2'
  let myPlayer  = 1;      // 1 | 2
  let myKeys    = {};
  let peer      = null;
  let conn      = null;
  let nes       = null;
  let rafId     = null;
  let frameCount= 0;

  // Audio
  let audioCtx  = null;
  let leftBuf   = [];
  let rightBuf  = [];

  // ROM
  let romBuffer       = null;  // ArrayBuffer
  let romChunks       = {};    // idx -> base64 string
  let romTotalChunks  = 0;
  let romReceivedCount= 0;
  let romSize         = 0;

  // Canvas
  let canvas, ctx2d, imageData;

  const CHUNK_SIZE = 8192;  // 8 KB per chunk

  // ── Screen helper ─────────────────────────────────────────────
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
  }

  function showWelcome() {
    cleanup();
    showScreen('welcome');
  }

  // ── Toast ─────────────────────────────────────────────────────
  function toast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3000);
  }

  // ── HOST: start ───────────────────────────────────────────────
  function startHost() {
    role     = 'host';
    myPlayer = 1;
    myKeys   = P1_KEYS;
    showScreen('host');

    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    peer = new Peer(roomId, { debug: 0 });

    peer.on('open', id => {
      document.getElementById('room-code').textContent = id;
      document.getElementById('btn-copy').disabled = false;
      setHostStatus('Share the code above with Player 2 — then load your ROM.');
    });

    peer.on('connection', incoming => {
      conn = incoming;
      setupConn();
      setHostStatus('✓ Player 2 connected! Now select a ROM.');
      toast('Player 2 joined!', 'success');
    });

    peer.on('error', e => toast('PeerJS error: ' + e.type, 'error'));
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
      if (conn && conn.open) {
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

  // ── P2: join ─────────────────────────────────────────────────
  function showJoin() { showScreen('join'); }

  function joinGame() {
    const code = document.getElementById('join-input').value.trim();
    if (!code) { toast('Enter the room code!', 'error'); return; }

    role     = 'p2';
    myPlayer = 2;
    myKeys   = P2_KEYS;

    const statusEl = document.getElementById('join-status');
    statusEl.textContent = 'Connecting...';
    statusEl.classList.remove('hidden');
    document.getElementById('btn-join-go').disabled = true;

    peer = new Peer(undefined, { debug: 0 });
    peer.on('open', () => {
      conn = peer.connect(code, { reliable: true, serialization: 'json' });
      setupConn();
    });
    peer.on('error', e => {
      toast('Connection failed: ' + e.type, 'error');
      document.getElementById('btn-join-go').disabled = false;
    });
  }

  // ── Connection setup (shared) ─────────────────────────────────
  function setupConn() {
    conn.on('open', () => {
      console.log('[NESRoom] DataChannel open. role:', role);
      if (role === 'p2') {
        document.getElementById('join-status').textContent = 'Connected! Waiting for Host to load ROM...';
      }
      // If host already has ROM loaded, start sending immediately
      if (role === 'host' && romBuffer) sendROM();
    });
    conn.on('data', onData);
    conn.on('close', () => { toast('Connection closed.', 'error'); showWelcome(); });
    conn.on('error', e => toast('Connection error: ' + e, 'error'));
  }

  // ── Data handler ──────────────────────────────────────────────
  function onData(msg) {
    switch (msg.t) {

      case 'rom_meta':
        romTotalChunks   = msg.total;
        romSize          = msg.size;
        romChunks        = {};
        romReceivedCount = 0;
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
        // host told p2 to start
        initAndPlay();
        break;

      case 'b':
        // Remote button event
        if (!nes) return;
        const remote = (role === 'host') ? 2 : 1;
        if (msg.s) nes.buttonDown(remote, msg.b);
        else       nes.buttonUp(remote,   msg.b);
        break;

      case 'sync':
        // Periodic state snapshot from host — resync P2
        if (role === 'p2' && nes) {
          try { nes.fromJSON(msg.state); } catch(e) { /* ignore minor errors */ }
        }
        break;
    }
  }

  // ── ROM transfer ─────────────────────────────────────────────
  function sendROM() {
    const bytes = new Uint8Array(romBuffer);
    const total = Math.ceil(bytes.length / CHUNK_SIZE);

    conn.send({ t: 'rom_meta', total, size: bytes.length });

    setHostProgress(0, 'Sending ROM to Player 2...');
    document.getElementById('host-progress').classList.remove('hidden');
    document.getElementById('host-status').textContent = 'Transferring ROM...';

    let i = 0;
    function next() {
      if (i >= total) {
        conn.send({ t: 'rom_done' });
        setHostProgress(1, '✓ ROM sent! Starting game...');
        // Host starts game loop immediately
        initAndPlay();
        // Tell P2 to start after a short delay (allow initAndPlay to settle)
        setTimeout(() => conn.send({ t: 'game_start' }), 500);
        return;
      }
      const start = i * CHUNK_SIZE;
      const slice = bytes.slice(start, start + CHUNK_SIZE);
      // Encode chunk as base64 for reliable JSON transport
      let b64 = '';
      const len = slice.length;
      for (let j = 0; j < len; j++) b64 += String.fromCharCode(slice[j]);
      conn.send({ t: 'rom_chunk', i, d: btoa(b64) });
      setHostProgress(i / total, 'Sending ROM ' + ((i / total * 100) | 0) + '%');
      i++;
      setTimeout(next, 0); // yield so UI stays responsive
    }
    next();
  }

  function assembleAndStart() {
    // Reassemble ROM from chunks
    const bytes = new Uint8Array(romSize);
    let offset = 0;
    for (let i = 0; i < romTotalChunks; i++) {
      const raw = atob(romChunks[i]);
      for (let j = 0; j < raw.length; j++) bytes[offset++] = raw.charCodeAt(j);
    }
    romBuffer = bytes.buffer;
    setJoinProgress(1, '✓ ROM received! Waiting for host...');
    toast('ROM received!', 'success');
  }

  // ── Start emulation ───────────────────────────────────────────
  function initAndPlay() {
    if (nes) return; // already running
    showScreen('game');
    initCanvas();
    initAudio();
    initNES();
    startLoop();
    toast(role === 'host' ? 'Game started! You are P1.' : 'Game started! You are P2.', 'success');
  }

  // ── Canvas setup ──────────────────────────────────────────────
  function initCanvas() {
    canvas    = document.getElementById('nes-canvas');
    ctx2d     = canvas.getContext('2d');
    imageData = ctx2d.createImageData(256, 240);
  }

  // ── Audio setup ───────────────────────────────────────────────
  function initAudio() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const bufSize   = 2048;
      const processor = audioCtx.createScriptProcessor(bufSize, 0, 2);
      processor.onaudioprocess = e => {
        const L = e.outputBuffer.getChannelData(0);
        const R = e.outputBuffer.getChannelData(1);
        for (let i = 0; i < bufSize; i++) {
          L[i] = leftBuf.length  ? leftBuf.shift()  : 0;
          R[i] = rightBuf.length ? rightBuf.shift() : 0;
        }
      };
      processor.connect(audioCtx.destination);
    } catch(e) {
      console.warn('Audio init failed:', e);
    }
  }

  // ── JSNES init ────────────────────────────────────────────────
  function initNES() {
    nes = new jsnes.NES({
      onFrame(frameBuffer) {
        renderFrame(frameBuffer);
      },
      onAudioSample(l, r) {
        leftBuf.push(l);
        rightBuf.push(r);
      }
    });

    // Convert ArrayBuffer → string (JSNES expects char-code string)
    const bytes = new Uint8Array(romBuffer);
    let romStr = '';
    for (let i = 0; i < bytes.length; i++) romStr += String.fromCharCode(bytes[i]);
    nes.loadROM(romStr);

    // Update game title in header
    document.getElementById('game-title').textContent = 'NES ROOM';

    setupKeys();
  }

  // ── Frame render ──────────────────────────────────────────────
  function renderFrame(frameBuffer) {
    const data = imageData.data;
    for (let i = 0; i < 256 * 240; i++) {
      const c = frameBuffer[i];
      const p = i * 4;
      data[p]     = (c >> 16) & 0xff; // R
      data[p + 1] = (c >>  8) & 0xff; // G
      data[p + 2] =  c        & 0xff; // B
      data[p + 3] = 0xff;             // A
    }
    ctx2d.putImageData(imageData, 0, 0);
  }

  // ── Game loop ─────────────────────────────────────────────────
  let lastFrameTime = 0;
  const FRAME_MS = 1000 / 60; // 60 fps emulation

  function startLoop() {
    function loop(ts) {
      rafId = requestAnimationFrame(loop);
      if (ts - lastFrameTime < FRAME_MS) return;
      lastFrameTime = ts;

      if (!nes) return;
      nes.frame();
      frameCount++;

      // We used to send a state snapshot every 10s here, but `nes.toJSON()` 
      // creates a massive object (entire NES memory) that exceeds WebRTC's 
      // max message size and causes the game to stutter every 10 seconds.
      // So we rely purely on the initial sync + fast input broadcasting!
    }
    rafId = requestAnimationFrame(loop);
  }

  // ── Keyboard input ────────────────────────────────────────────
  function setupKeys() {
    document.addEventListener('keydown', e => {
      if (!nes || !document.getElementById('screen-game').classList.contains('active')) return;
      const btn = myKeys[e.key];
      if (btn === undefined) return;
      e.preventDefault();
      nes.buttonDown(myPlayer, btn);
      sendInput(btn, 1);
    });

    document.addEventListener('keyup', e => {
      if (!nes) return;
      const btn = myKeys[e.key];
      if (btn === undefined) return;
      e.preventDefault();
      nes.buttonUp(myPlayer, btn);
      sendInput(btn, 0);
    });
  }

  function sendInput(btn, state) {
    if (conn && conn.open) conn.send({ t: 'b', b: btn, s: state });
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
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (nes)   { nes = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (conn)  { conn.close(); conn = null; }
    if (peer)  { peer.destroy(); peer = null; }
    leftBuf = []; rightBuf = [];
    romBuffer = null; romChunks = {};
    romTotalChunks = 0; romReceivedCount = 0;
    frameCount = 0;
    role = null;
    // Reset host UI
    document.getElementById('room-code').innerHTML = '<span class="blink">CONNECTING...</span>';
    document.getElementById('btn-copy').disabled = true;
    document.getElementById('host-status').textContent = 'Getting your room code...';
    document.getElementById('host-progress').classList.add('hidden');
    document.getElementById('rom-label-text').textContent = '📁 SELECT ROM FILE (.nes)';
    document.getElementById('rom-input').value = '';
    // Reset join UI
    document.getElementById('join-status').classList.add('hidden');
    document.getElementById('join-progress').classList.add('hidden');
    document.getElementById('join-input').value = '';
    document.getElementById('btn-join-go').disabled = false;
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    startHost,
    showJoin,
    showWelcome,
    joinGame,
    copyRoomCode,
    onRomSelected,
    disconnect: showWelcome,
  };

})();

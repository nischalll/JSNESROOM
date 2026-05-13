/* ================================================================
   NES ROOM — app.js  (native WebRTC + Socket.IO signaling)
   Signaling: your server (host/join/relay). Game + ROM: P2P DataChannel.
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
  let socket   = null;   // Socket.IO — signaling only
  let pc       = null;   // RTCPeerConnection
  let dc       = null;   // RTCDataChannel (game + ROM)
  let localIceBuffer = []; // host/gather: ICE candidates bundled into offer/answer
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

  // STUN — NAT discovery. Game bytes never touch STUN. For strict NATs, add a TURN server here.
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];

  // Same host as the page by default; override before app.js loads: window.NES_SIGNAL_URL = 'http://IP:9000'
  function defaultSignalUrl() {
    if (typeof location === 'undefined') return 'http://127.0.0.1:9000';
    if (location.protocol === 'file:') return 'http://127.0.0.1:9000';
    if (location.port === '9000') return location.origin;
    return `${location.protocol}//${location.hostname}:9000`;
  }
  const SIGNAL_URL = (typeof window !== 'undefined' && window.NES_SIGNAL_URL) || defaultSignalUrl();

  function makeRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[(Math.random() * chars.length) | 0];
    return s;
  }

  // DataChannel binary framing (no base64): [type u8][payloadLen u32 LE][payload…]
  const DC_JSON = 0;       // payload = UTF-8 JSON (rom_meta, rom_done, game_start, rom_ready, btns, …)
  const DC_ROM_CHUNK = 1;  // payload = [chunkIndex u32 LE][raw bytes…]
  const DC_SYNC = 2;       // payload = raw deflate bytes (host state snapshot)

  const _enc = new TextEncoder();
  const _dec = new TextDecoder();

  function dcSendJson(obj) {
    const body = _enc.encode(JSON.stringify(obj));
    const frame = new Uint8Array(5 + body.length);
    frame[0] = DC_JSON;
    new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(1, body.length, true);
    frame.set(body, 5);
    dc.send(frame);
  }

  function dcSendRomChunk(index, u8) {
    const plen = 4 + u8.length;
    const frame = new Uint8Array(5 + plen);
    frame[0] = DC_ROM_CHUNK;
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    dv.setUint32(1, plen, true);
    dv.setUint32(5, index >>> 0, true);
    frame.set(u8, 9);
    dc.send(frame);
  }

  function dcSendSyncBlob(u8) {
    const frame = new Uint8Array(5 + u8.length);
    frame[0] = DC_SYNC;
    new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(1, u8.length, true);
    frame.set(u8, 5);
    dc.send(frame);
  }

  function waitIceGatheringComplete(conn, timeoutMs = 25000) {
    return new Promise((resolve) => {
      if (conn.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(() => {
        conn.removeEventListener('icegatheringstatechange', onState);
        logDebug('ICE gathering: proceeding after timeout (may have partial candidates).');
        resolve();
      }, timeoutMs);
      function onState() {
        if (conn.iceGatheringState === 'complete') {
          clearTimeout(t);
          conn.removeEventListener('icegatheringstatechange', onState);
          resolve();
        }
      }
      conn.addEventListener('icegatheringstatechange', onState);
    });
  }

  function teardownWebRTC() {
    try { if (dc) dc.close(); } catch (_) {}
    dc = null;
    try { if (pc) pc.close(); } catch (_) {}
    pc = null;
    localIceBuffer = [];
  }

  function teardownSocket() {
    if (socket) {
      try { socket.removeAllListeners(); socket.disconnect(); } catch (_) {}
      socket = null;
    }
  }

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

  // ── P2P over RTCDataChannel (binary framing; raw bytes for ROM + sync) ──
  function send(msg) {
    if (!dc || dc.readyState !== 'open') return;
    if (msg.t === 'rom_chunk' && msg.d) {
      const u8 = msg.d instanceof Uint8Array ? msg.d : new Uint8Array(msg.d);
      dcSendRomChunk(msg.i, u8);
      return;
    }
    if (msg.t === 'sync' && msg.d) {
      const u8 = msg.d instanceof Uint8Array ? msg.d : new Uint8Array(msg.d);
      dcSendSyncBlob(u8);
      return;
    }
    dcSendJson(msg);
  }

  function onDcMessage(ev) {
    let buf;
    const d = ev.data;
    if (d instanceof ArrayBuffer) buf = new Uint8Array(d);
    else if (ArrayBuffer.isView(d)) buf = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    else {
      logDebug('Unexpected DataChannel payload type');
      return;
    }
    if (buf.length < 5) return;
    const type = buf[0];
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const plen = dv.getUint32(1, true);
    if (plen < 0 || 5 + plen > buf.length) {
      logDebug('Bad DC frame length');
      return;
    }
    const payload = buf.subarray(5, 5 + plen);
    try {
      if (type === DC_JSON) {
        const msg = JSON.parse(_dec.decode(payload));
        onData(msg);
      } else if (type === DC_ROM_CHUNK) {
        if (payload.length < 4) return;
        const idxDv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const i = idxDv.getUint32(0, true);
        onData({ t: 'rom_chunk', i, d: payload.subarray(4) });
      } else if (type === DC_SYNC) {
        onData({ t: 'sync', d: payload });
      } else {
        logDebug('Unknown DC frame type: ' + type);
      }
    } catch (e) {
      logDebug('Bad DC frame: ' + e.message);
    }
  }

  function onConnOpen() {
    logDebug('RTCDataChannel open.');
  }

  function monitorICE(peerConnection) {
    try {
      if (!peerConnection) return;
      logDebug('ICE monitoring started. Current state: ' + peerConnection.iceConnectionState);
      peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;
        logDebug('ICE state → ' + state);
        if (state === 'connected' || state === 'completed') {
          logDebug('ICE connected — NAT traversal succeeded.');
        } else if (state === 'failed') {
          logDebug('ICE FAILED — peers may need TURN relay.');
          toast('P2P failed — try same Wi‑Fi or add TURN in ICE_SERVERS.', 'error');
        } else if (state === 'disconnected') {
          logDebug('ICE disconnected.');
          toast('Connection unstable…', 'error');
        }
      };
    } catch (e) { logDebug('ICE monitor error: ' + e.message); }
  }

  function attachDataChannel(channel) {
    dc = channel;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      onConnOpen();
      if (role === 'host') {
        p2Joined = true;
        if (romBuffer) {
          setHostStatus('✓ Player 2 connected! Sending ROM...');
          sendROM();
        } else {
          setHostStatus('✓ Player 2 connected! Now select a ROM to start.');
        }
        toast('Player 2 joined!', 'success');
      } else {
        document.getElementById('join-status').textContent = '✓ Connected! Waiting for host to send ROM...';
        toast('Connected to host!', 'success');
      }
    };
    dc.onmessage = onDcMessage;
    dc.onclose = onConnClose;
    dc.onerror = () => { logDebug('RTCDataChannel error'); toast('Data channel error', 'error'); };
  }

  function onSocketRelay(msg) {
    if (!msg || msg.t !== 'webrtc') return;
    if (role === 'host' && msg.phase === 'answer') {
      applyHostAnswer(msg.payload).catch((e) => {
        logDebug('applyHostAnswer: ' + e.message);
        toast('Handshake failed (answer).', 'error');
      });
    } else if (role === 'p2' && msg.phase === 'offer') {
      applyGuestOffer(msg.payload).catch((e) => {
        logDebug('applyGuestOffer: ' + e.message);
        toast('Handshake failed (offer).', 'error');
      });
    }
  }

  async function startHostWebRTC() {
    teardownWebRTC();
    localIceBuffer = [];
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    monitorICE(pc);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) localIceBuffer.push(ev.candidate.toJSON());
    };

    const ch = pc.createDataChannel('nes', { ordered: true });
    attachDataChannel(ch);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGatheringComplete(pc);

    const payload = { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }, ice: localIceBuffer.slice() };
    socket.emit('relay', { code: roomCode, msg: { t: 'webrtc', phase: 'offer', payload } });
    logDebug('Sent WebRTC offer (SDP + ICE bundle).');
  }

  async function applyHostAnswer(payload) {
    if (!pc || !payload || !payload.sdp) return;
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    for (const c of payload.ice || []) {
      await pc.addIceCandidate(c).catch(() => {});
    }
    logDebug('Applied guest answer + remote ICE.');
  }

  async function applyGuestOffer(payload) {
    teardownWebRTC();
    localIceBuffer = [];
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    monitorICE(pc);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) localIceBuffer.push(ev.candidate.toJSON());
    };
    pc.ondatachannel = (ev) => attachDataChannel(ev.channel);

    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    for (const c of payload.ice || []) {
      await pc.addIceCandidate(c).catch(() => {});
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGatheringComplete(pc);

    const out = { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }, ice: localIceBuffer.slice() };
    socket.emit('relay', { code: roomCode, msg: { t: 'webrtc', phase: 'answer', payload: out } });
    logDebug('Sent WebRTC answer (SDP + ICE bundle).');
  }

  function onConnClose() {
    logDebug('RTCDataChannel closed.');
    dc = null;
    if (role === 'host') {
      toast('Player 2 disconnected. Waiting for new player...', 'error');
      p2Joined = false;
      teardownWebRTC();
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (btnSyncInterval) { clearInterval(btnSyncInterval); btnSyncInterval = null; }
      if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
      showScreen('host');
      setHostStatus('Player 2 left. Room is still open: ' + roomCode);
      document.getElementById('host-progress').classList.add('hidden');
    } else {
      toast('Connection closed.', 'error');
      teardownWebRTC();
      teardownSocket();
      showWelcome();
    }
  }

  // ── HOST ──────────────────────────────────────────────────────
  function startHost() {
    role = 'host'; myPlayer = 1; myKeys = KEYS;
    roomCode = makeRoomCode();
    showScreen('host');
    document.getElementById('room-code').textContent = roomCode;
    document.getElementById('btn-copy').disabled = false;
    setHostStatus('Connecting to room server...');
    p2Joined = false;

    teardownWebRTC();
    teardownSocket();

    if (typeof io !== 'function') {
      setHostStatus('Socket.IO client missing. Check index.html script tag.');
      toast('Missing socket.io client', 'error');
      return;
    }

    socket = io(SIGNAL_URL, { transports: ['websocket', 'polling'], reconnection: false });

    socket.on('relay', onSocketRelay);
    socket.on('peer_joined', () => {
      if (p2Joined) return;
      setHostStatus('Player 2 found — establishing P2P link...');
      startHostWebRTC().catch((e) => {
        logDebug('startHostWebRTC: ' + e.message);
        toast('Could not start WebRTC: ' + e.message, 'error');
      });
    });
    socket.on('peer_left', (info) => {
      if (info && info.role === 'p2') {
        teardownWebRTC();
        p2Joined = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (btnSyncInterval) { clearInterval(btnSyncInterval); btnSyncInterval = null; }
        if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
        showScreen('host');
        setHostStatus('Player 2 left. Room is still open: ' + roomCode);
        document.getElementById('host-progress').classList.add('hidden');
        toast('Player 2 left.', 'error');
      }
    });

    socket.on('connect', () => {
      socket.emit('host', roomCode);
    });
    socket.on('host_ok', (code) => {
      roomCode = code;
      document.getElementById('room-code').textContent = code;
      setHostStatus('Share the code with Player 2 — then load your ROM.');
      logDebug('host_ok: ' + code);
    });
    socket.on('connect_error', (err) => {
      logDebug('socket connect_error: ' + (err && err.message));
      setHostStatus('Cannot reach signaling server at ' + SIGNAL_URL + ' (start signaling-server).');
      toast('Signaling server offline', 'error');
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
    const raw = document.getElementById('join-input').value.trim().toUpperCase();
    if (!raw) { toast('Enter the room code!', 'error'); return; }

    role = 'p2'; myPlayer = 2; myKeys = KEYS; roomCode = raw;

    const statusEl = document.getElementById('join-status');
    statusEl.textContent = 'Connecting to room server...';
    statusEl.classList.remove('hidden');
    document.getElementById('btn-join-go').disabled = true;

    teardownWebRTC();
    teardownSocket();

    if (typeof io !== 'function') {
      statusEl.textContent = 'Socket.IO client missing.';
      document.getElementById('btn-join-go').disabled = false;
      toast('Missing socket.io client', 'error');
      return;
    }

    socket = io(SIGNAL_URL, { transports: ['websocket', 'polling'], reconnection: false });

    socket.on('relay', onSocketRelay);
    socket.on('join_ok', () => {
      statusEl.textContent = 'In room — waiting for host P2P handshake...';
      logDebug('join_ok');
    });
    socket.on('join_err', (err) => {
      statusEl.textContent = typeof err === 'string' ? err : 'Could not join room.';
      document.getElementById('btn-join-go').disabled = false;
      toast(statusEl.textContent, 'error');
      teardownSocket();
    });
    socket.on('peer_left', (info) => {
      if (info && info.role === 'host') {
        toast('Host left the game.', 'error');
        teardownWebRTC();
        teardownSocket();
        showWelcome();
      }
    });

    socket.on('connect', () => {
      socket.emit('join', roomCode);
    });
    socket.on('connect_error', (err) => {
      statusEl.textContent = 'Cannot reach ' + SIGNAL_URL;
      document.getElementById('btn-join-go').disabled = false;
      toast('Signaling server offline', 'error');
      logDebug('socket connect_error: ' + (err && err.message));
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
    return fflate.deflateSync(bytes); // Uint8Array → DC_SYNC binary frame in send()
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
        if (nes && dc && dc.readyState === 'open') {
          send({ t: 'btns', s: localBtnState });
        }
      }, 100);
    }

    // Host sends compressed state to P2 every 5 seconds to keep emulators in perfect sync
    if (role === 'host' && !syncInterval) {
      syncInterval = setInterval(() => {
        if (nes && dc && dc.readyState === 'open') {
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
    if (dc) { try { dc.close(); } catch (_) {} dc = null; }
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    teardownSocket();
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

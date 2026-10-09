/**
 * SyncBoard - public/app.js (frontend logic, vanilla JS, no frameworks)
 * ---------------------------------------------------------------
 * Sections:
 *   1. Room setup (read ?room=... from the URL)
 *   2. Canvas drawing (Pointer Events: mouse + touch + pen)
 *   3. Throttled emission of drawing data
 *   4. Receiving remote events
 *   5. Code pad synchronization
 *   6. UI: tools, presence, export
 */
(() => {
  'use strict';

  /* ===================================================================
   * 1. ROOM SETUP
   * Room comes from the URL: /?room=study-group
   * If missing/invalid we create a random one and update the URL so the
   * link can be shared with friends.
   * =================================================================== */
  const params = new URLSearchParams(window.location.search);
  let roomId = (params.get('room') || '').trim();

  if (!/^[\w-]{1,40}$/.test(roomId)) {
    roomId = 'room-' + Math.random().toString(36).slice(2, 8);
    history.replaceState(null, '', `?room=${roomId}`);
  }

  // `io()` connects to the Socket.io server that served this page.
  const socket = io();

  /* ---------- DOM references ---------- */
  const $ = (id) => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const codePad = $('code-pad');
  const userCount = $('user-count');
  const statusDot = $('status-dot');
  const statusText = $('status-text');

  $('room-name').textContent = roomId;

  /* ---------- Local state ---------- */
  const state = {
    tool: 'pen',          // 'pen' | 'eraser'
    color: '#1e293b',
    size: 4,
    drawing: false,
    last: null,           // last point {x, y} of the current stroke
    segments: [],         // EVERY segment on the board (used for JSON export)
    pending: [],          // segments waiting to be sent (throttle buffer)
  };

  const THROTTLE_MS = 30; // ~33 messages/second max instead of 100s
  const BACKGROUND = '#ffffff';

  /* ===================================================================
   * Canvas helpers
   * The board has a FIXED logical size (1600x900). CSS scales it to fit
   * the screen, so every user shares the same coordinate system no matter
   * how big their window is.
   * =================================================================== */
  function clearBoard() {
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Draw ONE line segment. Used for local AND remote drawing.
  function drawSegment(s) {
    ctx.strokeStyle = s.eraser ? BACKGROUND : s.color; // eraser = paint white
    ctx.lineWidth = s.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x0, s.y0);
    ctx.lineTo(s.x1, s.y1);
    ctx.stroke();
  }

  // Convert a pointer event (screen pixels) -> canvas logical coordinates.
  function getPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  clearBoard();

  /* ===================================================================
   * 3. THROTTLING
   * A mouse can fire 100+ mousemove events per second. Sending each one
   * would clog the socket. Instead:
   *   - we still DRAW locally on every move (feels instant), and
   *   - we BUFFER the segments and flush them at most every 30 ms
   *     as one batched "draw-line" message.
   * The throttle has a "trailing call" so the final bit of a stroke is
   * never lost.
   * =================================================================== */
  function throttle(fn, wait) {
    let lastCall = 0;
    let timer = null;
    return function () {
      const remaining = wait - (Date.now() - lastCall);
      if (remaining <= 0) {
        clearTimeout(timer);
        timer = null;
        lastCall = Date.now();
        fn();
      } else if (!timer) {
        timer = setTimeout(() => {
          lastCall = Date.now();
          timer = null;
          fn();
        }, remaining);
      }
    };
  }

  // Send everything in the buffer as one socket message.
  function flushPending() {
    if (state.pending.length === 0) return;
    // >>> SOCKET EVENT: draw-line (client -> server)
    socket.emit('draw-line', state.pending);
    state.pending = [];
  }
  const throttledFlush = throttle(flushPending, THROTTLE_MS);

  /* ===================================================================
   * 2. DRAWING (Pointer Events work for mouse, touch and stylus)
   * =================================================================== */
  canvas.addEventListener('pointerdown', (e) => {
    state.drawing = true;
    state.last = getPoint(e);
    canvas.setPointerCapture(e.pointerId); // keep receiving events outside canvas
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.drawing) return;

    const p = getPoint(e);
    const segment = {
      x0: state.last.x, y0: state.last.y,
      x1: p.x,          y1: p.y,
      color: state.color,
      size: state.size,
      eraser: state.tool === 'eraser',
    };

    drawSegment(segment);          // 1) draw locally right away
    state.segments.push(segment);  // 2) remember it (for export)
    state.pending.push(segment);   // 3) queue it for the network
    state.last = p;

    throttledFlush();              // 4) send (at most every THROTTLE_MS)
  });

  function stopDrawing() {
    if (!state.drawing) return;
    state.drawing = false;
    state.last = null;
    flushPending(); // make sure the tail of the stroke is sent
  }
  canvas.addEventListener('pointerup', stopDrawing);
  canvas.addEventListener('pointercancel', stopDrawing);

  /* ===================================================================
   * 4. RECEIVING REMOTE EVENTS
   * =================================================================== */

  // On (re)connect: join the room. Server answers with 'room-state'.
  socket.on('connect', () => {
    statusDot.className = 'inline-block w-2.5 h-2.5 rounded-full bg-emerald-400';
    statusText.textContent = 'Connected';
    // >>> SOCKET EVENT: join-room (client -> server)
    socket.emit('join-room', roomId);
  });

  socket.on('disconnect', () => {
    statusDot.className = 'inline-block w-2.5 h-2.5 rounded-full bg-red-500';
    statusText.textContent = 'Reconnecting...';
  });

  // Full snapshot for late joiners: redraw all strokes + load code.
  socket.on('room-state', ({ segments, code }) => {
    clearBoard();
    state.segments = segments.slice();
    segments.forEach(drawSegment);
    codePad.value = code;
  });

  // >>> SOCKET EVENT: draw-line (server -> peers): render their strokes.
  socket.on('draw-line', (segments) => {
    segments.forEach((s) => {
      drawSegment(s);
      state.segments.push(s);
    });
  });

  // >>> SOCKET EVENT: clear-canvas (server -> peers)
  socket.on('clear-canvas', () => {
    clearBoard();
    state.segments = [];
  });

  // >>> SOCKET EVENT: code-update (server -> peers)
  socket.on('code-update', (text) => {
    if (codePad.value === text) return;
    // Keep the local cursor position so typing is not interrupted.
    const { selectionStart, selectionEnd } = codePad;
    codePad.value = text;
    codePad.setSelectionRange(
      Math.min(selectionStart, text.length),
      Math.min(selectionEnd, text.length)
    );
  });

  // >>> SOCKET EVENT: presence-update (server -> everyone in room)
  socket.on('presence-update', (count) => {
    userCount.textContent = count;
  });

  /* ===================================================================
   * 5. CODE PAD SYNC
   * On every keystroke we send the full text (debounced slightly with the
   * same throttle helper). Programmatic `.value = ...` does NOT fire an
   * 'input' event, so remote updates never echo back (no infinite loop).
   * Simple "last writer wins" - perfect for a scratchpad. For true
   * multi-cursor editing you would use CRDTs (Yjs) or Operational Transform.
   * =================================================================== */
  const sendCode = throttle(() => {
    // >>> SOCKET EVENT: code-update (client -> server)
    socket.emit('code-update', codePad.value);
  }, 100);

  codePad.addEventListener('input', sendCode);

  // Make the Tab key insert two spaces instead of leaving the textarea.
  codePad.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en, value } = codePad;
    codePad.value = value.slice(0, s) + '  ' + value.slice(en);
    codePad.setSelectionRange(s + 2, s + 2);
    sendCode();
  });

  /* ===================================================================
   * 6. UI CONTROLS
   * =================================================================== */
  function setTool(tool) {
    state.tool = tool;
    $('tool-pen').classList.toggle('active', tool === 'pen');
    $('tool-eraser').classList.toggle('active', tool === 'eraser');
  }
  $('tool-pen').addEventListener('click', () => setTool('pen'));
  $('tool-eraser').addEventListener('click', () => setTool('eraser'));

  $('color-picker').addEventListener('input', (e) => {
    state.color = e.target.value;
    setTool('pen'); // picking a color implies you want to draw with it
  });

  $('brush-size').addEventListener('input', (e) => {
    state.size = Number(e.target.value);
    $('brush-size-label').textContent = state.size;
  });

  $('clear-canvas').addEventListener('click', () => {
    if (!confirm('Clear the canvas for everyone in this room?')) return;
    clearBoard();
    state.segments = [];
    state.pending = [];
    // >>> SOCKET EVENT: clear-canvas (client -> server)
    socket.emit('clear-canvas');
  });

  $('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      $('copy-link').textContent = 'Copied!';
      setTimeout(() => ($('copy-link').textContent = 'Copy invite link'), 1500);
    } catch {
      prompt('Copy this link:', window.location.href);
    }
  });

  /* ---------- Export helpers ---------- */
  function download(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  // Export canvas as PNG image
  $('export-png').addEventListener('click', () => {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      download(url, `syncboard-${roomId}.png`);
      URL.revokeObjectURL(url);
    }, 'image/png');
  });

  // Export the whole board state (strokes + code) as JSON
  $('export-json').addEventListener('click', () => {
    const data = {
      app: 'SyncBoard',
      room: roomId,
      exportedAt: new Date().toISOString(),
      canvas: { width: canvas.width, height: canvas.height },
      segments: state.segments,
      code: codePad.value,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    download(url, `syncboard-${roomId}.json`);
    URL.revokeObjectURL(url);
  });
})();

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Undo2, Eraser, Pen, Palette } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext';

const COLORS = ['#6C3CE9', '#E53935', '#FFB300', '#00C853', '#1E88E5', '#FFFFFF', '#1A1720', '#FF4081', '#00BCD4'];

// Draw on a photo then send it as a new message. Mirrors the app's DrawingCanvas.
export default function DrawingCanvas({ imageUrl, onCancel, onDone }) {
  const { theme } = useTheme();
  const canvasRef = useRef(null);
  const [color, setColor] = useState('#E53935');
  const [brushSize, setBrushSize] = useState(10);
  const [tool, setTool] = useState('pen');
  const [sending, setSending] = useState(false);
  const strokesRef = useRef([]);
  const drawingRef = useRef(false);
  const lastPointRef = useRef(null);
  const baseRef = useRef(null);
  const sendGenRef = useRef(0);
  const [dim, setDim] = useState({ w: 0, h: 0 });
  const [ready, setReady] = useState(false);

  // Load the image into the canvas and scale it to fit the preview box. BaseRef holds
  // ONE immutable snapshot of the original photo (taken once), so undo and clear can
  // always restore the untouched image regardless of how many strokes were drawn.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const maxW = Math.min(img.naturalWidth, 900);
      const maxH = Math.min(img.naturalHeight, 1400);
      canvas.width = maxW;
      canvas.height = maxH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, maxW, maxH);
      const base = document.createElement('canvas');
      base.width = maxW;
      base.height = maxH;
      base.getContext('2d').drawImage(canvas, 0, 0);
      baseRef.current = base;
      setDim({ w: maxW, h: maxH });
      setReady(true);
    };
    img.onerror = () => setReady(false);
    img.src = imageUrl;
  }, [imageUrl]);

  const getPoint = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const strokes = strokesRef.current;
    // Reset from the immutable original-photo snapshot (NOT the last stroke), so
    // clear() and undo() can remove every stroke drawn so far.
    const base = baseRef.current;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (base) ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    for (const s of strokes) {
      ctx.beginPath();
      if (s.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = s.color;
      }
      ctx.lineWidth = s.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const pts = s.points;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }, []);

  const pointerDown = useCallback((e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawingRef.current = true;
    lastPointRef.current = getPoint(e);
    strokesRef.current.push({ tool, color, size: brushSize, points: [lastPointRef.current] });
  }, [getPoint, tool, color, brushSize]);

  const pointerMove = useCallback((e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const p = getPoint(e);
    if (!p) return;
    const current = strokesRef.current[strokesRef.current.length - 1];
    if (current) current.points.push(p);
    redraw();
  }, [getPoint, redraw]);

  const endStroke = useCallback(() => {
    drawingRef.current = false;
    lastPointRef.current = null;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stopTouch = (e) => e.preventDefault();
    canvas.addEventListener('touchmove', stopTouch, { passive: false });
    return () => canvas.removeEventListener('touchmove', stopTouch);
  }, []);

  const undo = () => {
    strokesRef.current.pop();
    redraw();
  };

  const clear = () => {
    strokesRef.current = [];
    redraw();
  };

  const sendDrawing = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSending(true);
    const gen = ++sendGenRef.current;
    canvas.toBlob((blob) => {
      if (gen !== sendGenRef.current) return; // cancelled/unmounted while exporting
      if (!blob) { setSending(false); return; }
      const file = new File([blob], 'drawing.png', { type: 'image/png' });
      onDone(file);
    }, 'image/png');
  };

  const handleCancel = () => {
    sendGenRef.current += 1;
    if (onCancel) onCancel();
  };

  useEffect(() => {
    return () => { sendGenRef.current += 1; };
  }, []);

  const hScale = dim.w ? Math.min(1, (typeof window !== 'undefined' ? window.innerWidth - 24 : 380) / dim.w) : 1;
  const scaleDisplay = Math.min(hScale, (typeof window !== 'undefined' ? window.innerHeight - 380 : 1) / dim.h);
  const displayW = Math.max(200, Math.round(dim.w * scaleDisplay));
  const displayH = Math.max(200, Math.round(dim.h * scaleDisplay));

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2500,
      background: 'rgba(10,8,16,0.96)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', color: '#fff' }}>
        <button onClick={handleCancel} style={{ color: '#fff', padding: 6 }}><X size={24} /></button>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 700, fontSize: 16 }}>Draw</div>
        <button onClick={sendDrawing} disabled={!ready || sending} style={{
          color: '#fff', fontSize: 14, fontWeight: 700, padding: '8px 16px',
          background: 'linear-gradient(135deg,#6C3CE9,#4E22B8)', borderRadius: 18,
          opacity: (!ready || sending) ? 0.6 : 1,
        }}>
          {sending ? '…' : 'Send'}
        </button>
      </div>

      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', padding: '0 12px',
      }}>
        {ready ? (
          <canvas
            ref={canvasRef}
            style={{
              maxWidth: '100%', maxHeight: '100%',
              width: displayW, height: displayH,
              background: '#000', borderRadius: 8,
              touchAction: 'none', cursor: 'crosshair',
            }}
            onMouseDown={pointerDown}
            onMouseMove={pointerMove}
            onMouseUp={endStroke}
            onMouseLeave={endStroke}
            onTouchStart={(e) => { const t = e.touches[0]; pointerDown({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} }); }}
            onTouchMove={(e) => { const t = e.touches[0]; pointerMove({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} }); }}
            onTouchEnd={endStroke}
          />
        ) : (
          <div style={{ color: 'rgba(255,255,255,0.7)' }}>Could not load image</div>
        )}
      </div>

      <div style={{ padding: '10px 16px 18px', backgroundColor: 'rgba(20,17,28,0.9)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <button onClick={undo} style={{ color: '#fff', padding: 6 }}><Undo2 size={20} /></button>
          <button onClick={clear} style={{ color: '#fff', fontSize: 12, padding: '6px 10px', background: 'rgba(255,255,255,0.12)', borderRadius: 8 }}>Clear</button>
          <div style={{ flex: 1 }} />
          <button onClick={() => setTool('pen')} style={{
            color: '#fff', padding: 8, borderRadius: 10,
            background: tool === 'pen' ? theme.primary : 'rgba(255,255,255,0.08)',
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 12,
          }}><Pen size={16} />Pen</button>
          <button onClick={() => setTool('eraser')} style={{
            color: '#fff', padding: 8, borderRadius: 10,
            background: tool === 'eraser' ? theme.primary : 'rgba(255,255,255,0.08)',
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 12,
          }}><Eraser size={16} />Erase</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Palette size={16} color="rgba(255,255,255,0.7)" />
          {COLORS.map((c) => (
            <button key={c} onClick={() => setColor(c)} style={{
              width: 26, height: 26, borderRadius: 13, background: c,
              border: color === c ? '2px solid #fff' : '2px solid transparent',
            }} />
          ))}
          <div style={{ flex: 1 }} />
          <input
            type="range" min={2} max={30} value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            style={{ width: 110, accentColor: theme.primary }}
          />
          <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11 }}>{brushSize}px</span>
        </div>
      </div>
    </div>
  );
}
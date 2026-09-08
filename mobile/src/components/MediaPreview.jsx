import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, Image,
  ActivityIndicator, Alert, PanResponder, Dimensions, Platform,
} from 'react-native';
import Video from 'react-native-video';
import { captureRef } from 'react-native-view-shot';
import { Icon } from './AppIcon';
import { canInlineVideoPreview } from '../utils/media';
import { DrawableImage, DrawingToolbar } from './DrawingCanvas';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const MAX_OUT = 1440;
const MAX_IMGVIEW_PX = 8000000;
const MIN_CROP = 64;

export default function MediaPreview({ uri, type, fileName, mimeType, theme, onCancel, onSend }) {
  const isVideo = type === 'VIDEO';

  const [caption, setCaption] = useState('');
  const [mode, setMode] = useState('view'); // view | draw | crop | apply
  const [displayUri, setDisplayUri] = useState(uri || '');
  const [sending, setSending] = useState(false);
  const [videoErr, setVideoErr] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [applyGeom, setApplyGeom] = useState(null);

  const drawRef = useRef(null);
  const shotRef = useRef(null);
  const [strokes, setStrokes] = useState([]);
  const [color, setColor] = useState('#FF5252');
  const [brush, setBrush] = useState(6);
  const colorRef = useRef(color);
  const brushRef = useRef(brush);
  const drawModeRef = useRef(true);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { brushRef.current = brush; }, [brush]);

  const [box, setBox] = useState(null);
  const [srcSize, setSrcSize] = useState(null);
  const [contained, setContained] = useState(null);
  const [crop, setCrop] = useState(null);
  const [imgReady, setImgReady] = useState(false);
  const geomRef = useRef({ contained: null, crop: null });
  geomRef.current.contained = contained;
  geomRef.current.crop = crop;

  const resetTools = () => {
    setMode('view');
    setStrokes([]);
    setCrop(null);
    setBox(null);
    setSrcSize(null);
    setImgReady(false);
    setContained(null);
  };

  useEffect(() => {
    setDisplayUri(uri || '');
    resetTools();
    setCaption('');
    setVideoErr(false);
    setVideoOn(false);
    setImgErr(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  const onBoxLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    setBox({ w: width, h: height });
  }, []);

  useEffect(() => {
    if (!box || !displayUri || isVideo) return;
    let active = true;
    Image.getSize(displayUri, (w, h) => {
      if (!active) return;
      setSrcSize({ w, h });
      setImgReady(true);
    }, () => {
      if (active) setSrcSize({ w: box.w, h: box.h });
      setImgReady(true);
    });
    return () => { active = false; };
  }, [box, displayUri, isVideo]);

  useEffect(() => {
    if (!srcSize || !box) return;
    const scale = Math.min(box.w / srcSize.w, box.h / srcSize.h);
    const iw = srcSize.w * scale;
    const ih = srcSize.h * scale;
    const ox = (box.w - iw) / 2;
    const oy = (box.h - ih) / 2;
    setContained({ ox, oy, iw, ih, scale });
    if (!crop) {
      setCrop({ cx: ox + iw * 0.08, cy: oy + ih * 0.08, cw: iw * 0.84, ch: ih * 0.84 });
    } else {
      setCrop((c) => ({
        cx: Math.max(ox, Math.min(c.cx, ox + iw - c.cw)),
        cy: Math.max(oy, Math.min(c.cy, oy + ih - c.ch)),
        cw: Math.min(c.cw, iw),
        ch: Math.min(c.ch, ih),
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcSize, box]);

  const applyDrawing = async () => {
    if (!drawRef.current) return;
    setProcessing(true);
    try {
      const shot = await captureRef(drawRef, { format: 'png', quality: 0.92, result: 'tmpfile' });
      setDisplayUri(shot);
      setMode('view');
    } catch (e) {
      console.error('capture drawing failed', e);
      Alert.alert('Draw failed', e.message || 'Could not create the drawing');
      setMode('view');
    } finally {
      setProcessing(false);
    }
  };

  const gestureStart = useRef(null);
  const cropPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const g = geomRef.current;
      if (!g.contained || !g.crop) return;
      const { locationX, locationY } = e.nativeEvent;
      const c = g.crop;
      gestureStart.current = {
        mode: locationX > c.cw - 40 && locationY > c.ch - 40 ? 'resize' : 'move',
        sx: locationX,
        sy: locationY,
        cx: c.cx, cy: c.cy, cw: c.cw, ch: c.ch,
      };
    },
    onPanResponderMove: (e) => {
      const gs = gestureStart.current;
      const g = geomRef.current;
      if (!gs || !g.contained || !g.crop) return;
      const dx = e.nativeEvent.locationX - gs.sx;
      const dy = e.nativeEvent.locationY - gs.sy;
      const boxC = g.contained;
      if (gs.mode === 'resize') {
        const ratio = gs.cw / gs.ch;
        const freeW = boxC.iw - (gs.cx - boxC.ox);
        const freeH = boxC.ih - (gs.cy - boxC.oy);
        let nw = Math.max(MIN_CROP, Math.min(gs.cw + dx, Math.min(freeW, freeH * ratio)));
        let nh = nw / ratio;
        setCrop({ cx: gs.cx, cy: gs.cy, cw: nw, ch: nh });
      } else {
        const ncx = Math.max(boxC.ox, Math.min(gs.cx + dx, boxC.ox + boxC.iw - g.crop.cw));
        const ncy = Math.max(boxC.oy, Math.min(gs.cy + dy, boxC.oy + boxC.ih - g.crop.ch));
        setCrop({ ...g.crop, cx: ncx, cy: ncy });
      }
    },
    onPanResponderRelease: () => { gestureStart.current = null; },
    onPanResponderTerminate: () => { gestureStart.current = null; },
  })).current;

  const applyCrop = async () => {
    const g = geomRef.current;
    if (!g.contained || !g.crop || !srcSize) return;
    const { ox, oy, scale } = g.contained;
    const c = g.crop;
    const sx = (c.cx - ox) / scale;
    const sy = (c.cy - oy) / scale;
    const sw = c.cw / scale;
    const sh = c.ch / scale;
    const cropLong = Math.max(sw, sh);
    let outScale = cropLong > MAX_OUT ? MAX_OUT / cropLong : 1;
    let outW = Math.round(sw * outScale);
    let outH = Math.round(sh * outScale);
    let imgViewW = srcSize.w * outScale;
    let imgViewH = srcSize.h * outScale;
    if (imgViewW * imgViewH > MAX_IMGVIEW_PX) {
      const factor = Math.sqrt(MAX_IMGVIEW_PX / (imgViewW * imgViewH));
      outW = Math.round(outW * factor);
      outH = Math.round(outH * factor);
      outScale = outW / sw;
      imgViewW = srcSize.w * outScale;
      imgViewH = srcSize.h * outScale;
    }
    setApplyGeom({
      outW,
      outH,
      imgW: imgViewW,
      imgH: imgViewH,
      left: Math.round(-sx * outScale),
      top: Math.round(-sy * outScale),
    });
    setMode('apply');
    setProcessing(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 450));
      const shot = await captureRef(shotRef, { format: 'png', quality: 0.95, result: 'tmpfile' });
      setDisplayUri(shot);
      setApplyGeom(null);
      setMode('view');
    } catch (e) {
      console.error('crop capture failed', e);
      Alert.alert('Crop failed', e.message || 'Could not crop the photo');
      setApplyGeom(null);
      setMode('view');
    } finally {
      setProcessing(false);
    }
  };

  const handleSend = () => {
    if (sending || !displayUri) return;
    setSending(true);
    try {
      onSend && onSend({ uri: displayUri, fileName, mimeType, caption: caption.trim() });
    } finally {
      setSending(false);
    }
  };

  const header = (
    <View style={[styles.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
      <TouchableOpacity onPress={onCancel} style={styles.headerBtn} accessibilityLabel="Cancel">
        <Icon name="close" size={26} color={theme.text} />
      </TouchableOpacity>
      <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 8 }}>
        <Text style={[styles.headerTitle, { color: theme.text }]} numberOfLines={1}>
          {isVideo ? 'Send video' : 'Send photo'}
        </Text>
        {!!fileName && <Text style={[styles.headerSub, { color: theme.textSecondary }]} numberOfLines={1}>{fileName}</Text>}
      </View>
      <TouchableOpacity
        onPress={isVideo ? handleSend : () => { if (mode === 'view') handleSend(); }}
        style={[styles.headerBtn, { backgroundColor: theme.primary, borderRadius: 20, width: 40, height: 40, marginRight: 6 }]}
        accessibilityLabel="Send media"
        disabled={processing}
      >
        {sending || processing ? <ActivityIndicator color="#fff" size="small" /> : <Icon name="send" size={18} color="#fff" />}
      </TouchableOpacity>
    </View>
  );

  const renderBody = () => {
    if (mode === 'draw') {
      return (
        <View style={styles.body}>
          <DrawableImage
            key={displayUri}
            uri={displayUri}
            drawRef={drawRef}
            strokes={strokes}
            drawModeRef={drawModeRef}
            colorRef={colorRef}
            brushRef={brushRef}
            setStrokes={setStrokes}
            maxHeight={SCREEN_H - 300}
            style={{ padding: 4 }}
          />
        </View>
      );
    }
    if (mode === 'crop') {
      return (
        <View style={styles.body}>
          <View style={StyleSheet.absoluteFill} onLayout={onBoxLayout} collapsable={false}>
            <Image source={{ uri: displayUri }} style={[StyleSheet.absoluteFill, { width: box?.w, height: box?.h }]} resizeMode="contain" />
          </View>
          {contained && crop && (
            <View style={[styles.cropOverlay, { borderWidth: 1, borderColor: '#fff', left: crop.cx, top: crop.cy, width: crop.cw, height: crop.ch }]} {...cropPan.panHandlers}>
              <View style={[StyleSheet.absoluteFill, { position: 'absolute', left: 0, top: 0 }]}>
                <View style={[styles.gridH, { top: crop.ch / 3 }]} />
                <View style={[styles.gridH, { top: (crop.ch * 2) / 3 }]} />
                <View style={[styles.gridV, { left: crop.cw / 3 }]} />
                <View style={[styles.gridV, { left: (crop.cw * 2) / 3 }]} />
              </View>
              <View style={styles.handle} />
              <View style={styles.handleAlt} />
              <View style={styles.handleAlt2} />
              <View style={styles.handleBR} />
            </View>
          )}
          {contained && crop && (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <View style={[styles.dim, { height: crop.cy }]} />
              <View style={[styles.dim, { top: crop.cy + crop.ch, bottom: 0 }]} />
              <View style={[styles.dimSide, { top: crop.cy, height: crop.ch, width: crop.cx }]} />
              <View style={[styles.dimSide, { top: crop.cy, height: crop.ch, left: crop.cx + crop.cw, right: 0 }]} />
            </View>
          )}
        </View>
      );
    }
    if (mode === 'apply') {
      const g = applyGeom || { outW: 0, outH: 0, imgW: 0, imgH: 0, left: 0, top: 0 };
      return (
        <View style={styles.body}>
          <View style={styles.bodyCenter}>
            <View ref={shotRef} collapsable={false} style={{ width: g.outW || SCREEN_W, height: g.outH || 1, overflow: 'hidden' }}>
              <Image source={{ uri: displayUri }} style={{ width: g.imgW || g.outW, height: g.imgH || g.outH, left: g.left, top: g.top }} resizeMode="stretch" />
            </View>
          </View>
          <View style={[StyleSheet.absoluteFill, styles.processingDim]} pointerEvents="none">
            <View style={styles.processingPill}>
              <ActivityIndicator color="#fff" />
              <Text style={{ color: '#fff', marginLeft: 10, fontWeight: '600' }}>Cropping…</Text>
            </View>
          </View>
        </View>
      );
    }
    if (isVideo) {
      const previewSafe = canInlineVideoPreview(fileName, mimeType);
      return (
        <View style={styles.body}>
          {videoErr || !previewSafe ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="alert-circle-outline" size={44} color={theme.danger} />
              <Text style={{ color: theme.textSecondary, marginTop: 10 }}>This video could not be previewed here.</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>You can still send it.</Text>
            </View>
          ) : !videoOn ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="videocam-outline" size={52} color={theme.textSecondary} />
              <TouchableOpacity
                onPress={() => setVideoOn(true)}
                style={[styles.videoPreviewBtn, { backgroundColor: theme.primary }]}
                accessibilityLabel="Preview video"
              >
                <Icon name="play" size={22} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14, marginLeft: 8 }}>Tap to preview</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.body}>
              <Video
                source={{ uri }}
                style={[StyleSheet.absoluteFill, { width: box?.w || SCREEN_W, height: box?.h || SCREEN_H - 220 }]}
                resizeMode="contain"
                controls
                repeat={false}
                paused={false}
                bufferConfig={{ minBufferMs: 15000, maxBufferMs: 60000, bufferForPlaybackMs: 1000, bufferForPlaybackAfterRebufferMs: 2000 }}
                onError={() => setVideoErr(true)}
              />
            </View>
          )}
        </View>
      );
    }
    return (
      <View style={styles.body}>
        <View style={StyleSheet.absoluteFill} onLayout={onBoxLayout} collapsable={false}>
          <Image source={{ uri: displayUri }} style={[StyleSheet.absoluteFill, { width: box?.w, height: box?.h }]} resizeMode="contain" onLoad={() => setImgReady(true)} onError={() => setImgErr(true)} />
        </View>
        {!imgReady && !imgErr && (
          <View style={[StyleSheet.absoluteFill, styles.processingDim]} pointerEvents="none">
            <View style={styles.processingPill}>
              <ActivityIndicator color="#fff" />
              <Text style={{ color: '#fff', marginLeft: 10, fontWeight: '600' }}>Loading photo…</Text>
            </View>
          </View>
        )}
        {imgErr && (
          <View style={{ position: 'absolute', bottom: 18, alignSelf: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: theme.inputBg, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 }}>
              <Icon name="alert-circle-outline" size={16} color={theme.danger} />
              <Text style={{ color: theme.danger, fontSize: 12, fontWeight: '600', marginLeft: 6 }}>Could not preview this image — you can still send it</Text>
            </View>
          </View>
        )}
      </View>
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: theme.background, paddingTop: 40 }}>
        {header}
        <View style={{ flex: 1 }}>
          {renderBody()}
        </View>

        {mode === 'view' && (
          <View style={[styles.composer, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
            {!isVideo && (
              <View style={styles.toolRow}>
                <TouchableOpacity
                  style={[styles.toolBtn, { backgroundColor: theme.primaryLight }, !imgReady || imgErr ? { opacity: 0.45 } : null]}
                  disabled={!imgReady || imgErr}
                  onPress={() => { setMode('draw'); }}
                >
                  <Icon name="color-wand" size={20} color={theme.primary} />
                  <Text style={[styles.toolBtnText, { color: theme.primary }]}>Draw</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.toolBtn, { backgroundColor: theme.primaryLight }, !imgReady || imgErr ? { opacity: 0.45 } : null]}
                  disabled={!imgReady || imgErr || !box || !srcSize}
                  onPress={() => { if (box && srcSize) setMode('crop'); }}
                >
                  <Icon name="crop" size={20} color={theme.primary} />
                  <Text style={[styles.toolBtnText, { color: theme.primary }]}>Crop</Text>
                </TouchableOpacity>
              </View>
            )}
            <View style={styles.captionRow}>
              <TextInput
                style={[styles.caption, { backgroundColor: theme.inputBg, color: theme.text }]}
                placeholder="Add a caption…"
                placeholderTextColor={theme.textSecondary}
                value={caption}
                onChangeText={setCaption}
                maxLength={300}
              />
            </View>
          </View>
        )}

        {mode === 'draw' && (
          <DrawingToolbar
            theme={theme}
            color={color}
            brush={brush}
            setColor={setColor}
            setBrush={setBrush}
            onUndo={() => setStrokes((s) => s.slice(0, -1))}
            onClear={() => setStrokes([])}
            onDone={applyDrawing}
            busy={processing}
          />
        )}

        {mode === 'crop' && (
          <View style={[styles.composer, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
            <TouchableOpacity style={[styles.cropCancelBtn, { backgroundColor: theme.primaryLight }]} onPress={() => setMode('view')}>
              <Icon name="close" size={18} color={theme.danger} />
              <Text style={{ color: theme.danger, fontWeight: '700', marginLeft: 6 }}>Cancel</Text>
            </TouchableOpacity>
            <Text style={{ flex: 1, textAlign: 'center', fontSize: 13, color: theme.textSecondary }}>
              Drag to move · corner handle to resize
            </Text>
            <TouchableOpacity style={[styles.cropApplyBtn, { backgroundColor: theme.primary }]} onPress={applyCrop}>
              <Icon name="checkmark" size={18} color="#fff" />
              <Text style={{ color: '#fff', fontWeight: '700', marginLeft: 6 }}>Crop</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: 1 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  headerSub: { fontSize: 11, marginTop: 2, maxWidth: SCREEN_W - 150 },
  body: { flex: 1 },
  bodyCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  composer: { paddingTop: 8, paddingHorizontal: 12, paddingBottom: Platform.OS === 'ios' ? 22 : 14, borderTopWidth: 1 },
  toolRow: { flexDirection: 'row', marginBottom: 8 },
  toolBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, marginRight: 10 },
  toolBtnText: { fontWeight: '700', fontSize: 13, marginLeft: 6 },
  captionRow: { flexDirection: 'row', alignItems: 'center' },
  caption: { flex: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14 },
  cropCancelBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 },
  cropApplyBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18 },
  cropOverlay: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.06)' },
  gridH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.6)' },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.6)' },
  handle: { position: 'absolute', left: 0, top: 0, width: 24, height: 24, borderLeftWidth: 3, borderTopWidth: 3, borderColor: '#fff' },
  handleAlt: { position: 'absolute', right: 0, top: 0, width: 24, height: 24, borderRightWidth: 3, borderTopWidth: 3, borderColor: '#fff' },
  handleAlt2: { position: 'absolute', left: 0, bottom: 0, width: 24, height: 24, borderLeftWidth: 3, borderBottomWidth: 3, borderColor: '#fff' },
  handleBR: { position: 'absolute', right: 0, bottom: 0, width: 30, height: 30, borderRightWidth: 4, borderBottomWidth: 4, borderColor: '#fff' },
  dim: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  dimSide: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  processingDim: { backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  processingPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.75)', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 24 },
  videoPreviewBtn: { flexDirection: 'row', alignItems: 'center', borderRadius: 24, paddingHorizontal: 20, paddingVertical: 12, marginTop: 16 },
});
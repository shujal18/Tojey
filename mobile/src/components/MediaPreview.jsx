import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, Image,
  ActivityIndicator, Alert, PanResponder, Platform, StatusBar, Keyboard,
} from 'react-native';
import { useWindowDimensions } from 'react-native';
import Video from 'react-native-video';
import { captureRef } from 'react-native-view-shot';
import { Icon } from './AppIcon';
import { canInlineVideoPreview } from '../utils/media';
import { DrawableImage, DrawingToolbar } from './DrawingCanvas';

const MAX_OUT = 1440;
const MAX_IMGVIEW_PX = 8000000;
const MIN_CROP = 64;
const DRAW_TOOLBAR_H = 176;

export default function MediaPreview({ uri, type, fileName, mimeType, theme, onCancel, onSend }) {
  const isVideo = type === 'VIDEO';
  const { width: winW, height: winH } = useWindowDimensions();
  const topInset = Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0;

  const [caption, setCaption] = useState('');
  const [mode, setMode] = useState('view'); // view | draw | crop | rotate | apply
  const [displayUri, setDisplayUri] = useState(uri || '');
  const [sending, setSending] = useState(false);
  const [videoErr, setVideoErr] = useState(false);
  const [videoLoadDone, setVideoLoadDone] = useState(false);
  const [videoPaused, setVideoPaused] = useState(true);
  const [videoKey, setVideoKey] = useState(0);
  const [imgErr, setImgErr] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [applyGeom, setApplyGeom] = useState(null);
  const [kbH, setKbH] = useState(0);

  const drawRef = useRef(null);
  const shotRef = useRef(null);
  const rotateRef = useRef(null);
  const strokesRef = useRef([]);
  const [strokes, setStrokes] = useState([]);
  const [color, setColor] = useState('#FF5252');
  const [brush, setBrush] = useState(6);
  const colorRef = useRef(color);
  const brushRef = useRef(brush);
  const drawModeRef = useRef(true);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { brushRef.current = brush; }, [brush]);
  useEffect(() => { strokesRef.current = strokes; }, [strokes]);

  const [box, setBox] = useState(null);
  const [srcSize, setSrcSize] = useState(null);
  const [contained, setContained] = useState(null);
  const [crop, setCrop] = useState(null);
  const [imgReady, setImgReady] = useState(false);
  const geomRef = useRef({ contained: null, crop: null });
  geomRef.current.contained = contained;
  geomRef.current.crop = crop;

  const resetGeometry = () => {
    setCrop(null);
    setBox(null);
    setSrcSize(null);
    setContained(null);
    setImgReady(false);
  };

  const resetTools = () => {
    setMode('view');
    setStrokes([]);
    strokesRef.current = [];
    setCrop(null);
  };

  useEffect(() => {
    setDisplayUri(uri || '');
    resetTools();
    resetGeometry();
    setCaption('');
    setVideoErr(false);
    setVideoLoadDone(false);
    setVideoPaused(true);
    setImgErr(false);
    setApplyGeom(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  // Keep the bottom overlay above the keyboard while typing a caption.
  useEffect(() => {
    const show = (e) => setKbH((e && e.endCoordinates && e.endCoordinates.height) || 0);
    const hide = () => setKbH(0);
    const subs = [
      (Platform.OS === 'ios'
        ? Keyboard.addListener('keyboardWillChangeFrame', show)
        : Keyboard.addListener('keyboardDidShow', show)),
      Keyboard.addListener('keyboardDidHide', hide),
    ];
    return () => subs.forEach((s) => s.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (active) { setSrcSize({ w: box.w, h: box.h }); }
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
      setStrokes([]);
      strokesRef.current = [];
      resetGeometry();
      setMode('view');
    } catch (e) {
      console.error('capture drawing failed', e);
      Alert.alert('Draw failed', e.message || 'Could not create the drawing');
      setMode('view');
    } finally {
      setProcessing(false);
    }
  };

  const applyRotate = async () => {
    if (!rotateRef.current) return;
    setProcessing(true);
    try {
      const shot = await captureRef(rotateRef, { format: 'png', quality: 0.95, result: 'tmpfile' });
      setDisplayUri(shot);
      resetGeometry();
      setMode('view');
    } catch (e) {
      console.error('rotate capture failed', e);
      Alert.alert('Rotate failed', e.message || 'Could not rotate the photo');
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
      resetGeometry();
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

  const retryVideo = () => {
    setVideoErr(false);
    setVideoLoadDone(false);
    setVideoKey((k) => k + 1);
  };

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
            maxHeight={winH - DRAW_TOOLBAR_H * 2 - topInset}
            style={{ padding: 4 }}
          />
        </View>
      );
    }
    if (mode === 'rotate') {
      const s = srcSize && box ? Math.min((box.w - 24) / srcSize.h, (box.h - 24) / srcSize.w) : 1;
      const rw = srcSize ? Math.round(srcSize.h * s) : winW;
      const rh = srcSize ? Math.round(srcSize.w * s) : winH;
      return (
        <View style={styles.body} onLayout={onBoxLayout}>
          <View style={styles.bodyCenter}>
            <View
              ref={rotateRef}
              collapsable={false}
              style={{ width: rw, height: rh, overflow: 'hidden' }}
            >
              <Image
                source={{ uri: displayUri }}
                style={{ width: rh, height: rw, transform: [{ rotate: '90deg' }] }}
                resizeMode="stretch"
              />
            </View>
          </View>
          {!imgReady && !imgErr && (
            <View style={[StyleSheet.absoluteFill, styles.centerDim]} pointerEvents="none">
              <ActivityIndicator color="#fff" />
            </View>
          )}
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
            <View ref={shotRef} collapsable={false} style={{ width: g.outW || winW, height: g.outH || 1, overflow: 'hidden' }}>
              <Image source={{ uri: displayUri }} style={{ width: g.imgW || g.outW, height: g.imgH || g.outH, left: g.left, top: g.top }} resizeMode="stretch" />
            </View>
          </View>
          <View style={[StyleSheet.absoluteFill, styles.centerDim]} pointerEvents="none">
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
        <View style={styles.body} onLayout={onBoxLayout}>
          {!previewSafe || videoErr ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
              <Icon name="alert-circle-outline" size={46} color="rgba(255,255,255,0.85)" />
              <Text style={{ color: 'rgba(255,255,255,0.9)', marginTop: 12, textAlign: 'center', fontSize: 14 }}>
                {videoErr ? 'Unable to load video' : 'This video could not be previewed here.'}
              </Text>
              <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 4 }}>
                {videoErr ? 'Check the file and try again.' : 'You can still send it.'}
              </Text>
              {videoErr && (
                <TouchableOpacity
                  onPress={retryVideo}
                  style={[styles.videoPreviewBtn, { backgroundColor: theme.primary, marginTop: 18 }]}
                  accessibilityLabel="Retry video"
                >
                  <Icon name="refresh" size={18} color="#fff" />
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14, marginLeft: 8 }}>Retry</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <Video
              key={videoKey}
              source={{ uri }}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
              controls
              repeat={false}
              paused={videoPaused}
              onPlay={() => setVideoPaused(false)}
              onPause={() => setVideoPaused(true)}
              bufferConfig={{ minBufferMs: 15000, maxBufferMs: 60000, bufferForPlaybackMs: 1000, bufferForPlaybackAfterRebufferMs: 2000 }}
              onLoad={() => setVideoLoadDone(true)}
              onError={() => setVideoErr(true)}
            />
          )}
          {!videoLoadDone && !videoErr && previewSafe && (
            <View style={[StyleSheet.absoluteFill, styles.centerDim]} pointerEvents="none">
              <ActivityIndicator color="#fff" size="large" />
            </View>
          )}
        </View>
      );
    }
    return (
      <View style={styles.body}>
        <View style={StyleSheet.absoluteFill} onLayout={onBoxLayout} collapsable={false}>
          <Image
            source={{ uri: displayUri }}
            style={[StyleSheet.absoluteFill, { width: box?.w, height: box?.h }]}
            resizeMode="contain"
            onLoad={() => setImgReady(true)}
            onError={() => setImgErr(true)}
          />
        </View>
        {!imgReady && !imgErr && (
          <View style={[StyleSheet.absoluteFill, styles.centerDim]} pointerEvents="none">
            <ActivityIndicator color="#fff" size="large" />
          </View>
        )}
        {imgErr && (
          <View style={{ position: 'absolute', bottom: 170, alignSelf: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 }}>
              <Icon name="alert-circle-outline" size={16} color="#FFB4AB" />
              <Text style={{ color: '#FFB4AB', fontSize: 12, fontWeight: '600', marginLeft: 6 }}>Could not preview this image — you can still send it</Text>
            </View>
          </View>
        )}
      </View>
    );
  };

  const overlayBtn = (styles.overlayBtn);
  const sendDisabled = sending || processing || !displayUri || (isVideo && videoErr);

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onCancel}>
      <View style={styles.modalRoot}>
        {/* Media always fills the whole screen; controls overlay it. */}
        <View style={StyleSheet.absoluteFill}>
          {renderBody()}
        </View>

        {mode === 'view' && (
          <View style={[styles.topBar, { paddingTop: topInset + 4 }]} pointerEvents="box-none">
            <View style={styles.topBarRow}>
              <TouchableOpacity onPress={onCancel} style={overlayBtn} accessibilityLabel="Close media preview">
                <Icon name="close" size={26} color="#fff" />
              </TouchableOpacity>
              <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 8 }}>
                <Text style={styles.topBarTitle} numberOfLines={1}>
                  {isVideo ? 'Video' : 'Photo'}
                </Text>
              </View>
              <View style={[overlayBtn, { opacity: 0 }]} pointerEvents="none">
                <Icon name="close" size={26} color="#fff" />
              </View>
            </View>
          </View>
        )}

        {mode === 'view' && (
          <View style={[styles.bottomPanel, { bottom: kbH }]}>
            {!isVideo && (
              <View style={styles.toolRow}>
                <ToolBtn icon="color-wand" label="Draw" onPress={() => setMode('draw')} disabled={!imgReady || imgErr} />
                <ToolBtn icon="crop" label="Crop" onPress={() => { if (box && srcSize) setMode('crop'); }} disabled={!imgReady || imgErr || !box || !srcSize} />
                <ToolBtn icon="refresh" label="Rotate" onPress={() => { if (box && srcSize) setMode('rotate'); }} disabled={!imgReady || imgErr || !box || !srcSize} />
              </View>
            )}
            <View style={styles.captionRow}>
              <TextInput
                style={styles.caption}
                placeholder="Add a caption…"
                placeholderTextColor="rgba(255,255,255,0.5)"
                value={caption}
                onChangeText={setCaption}
                maxLength={300}
              />
              <TouchableOpacity
                onPress={handleSend}
                style={[styles.sendBtn, { backgroundColor: theme.primary }]}
                accessibilityLabel="Send media"
                disabled={sendDisabled}
              >
                {sending || processing ? <ActivityIndicator color="#fff" size="small" /> : <Icon name="send" size={18} color="#fff" />}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {mode === 'draw' && (
          <View style={[styles.modeBarWrap, { bottom: 0 }]}>
            <DrawingToolbar
              theme={theme}
              color={color}
              brush={brush}
              setColor={setColor}
              setBrush={setBrush}
              onUndo={() => setStrokes((s) => s.slice(0, -1))}
              onClear={() => setStrokes([])}
              onCancel={() => setMode('view')}
              onDone={applyDrawing}
              busy={processing}
            />
          </View>
        )}

        {mode === 'rotate' && (
          <View style={[styles.modeBarWrap, { bottom: 0 }]}>
            <View style={[styles.toolbar, { backgroundColor: 'rgba(0,0,0,0.88)' }]}>
              <View style={styles.toolbarRow}>
                <ToolBtn icon="close" label="Cancel" onPress={() => setMode('view')} light />
                <View style={{ flex: 1 }} />
                {processing ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <TouchableOpacity onPress={applyRotate} style={[styles.primaryBarBtn, { backgroundColor: theme.primary }]} accessibilityLabel="Apply rotation">
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Apply</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>
        )}

        {mode === 'crop' && (
          <View style={[styles.modeBarWrap, { bottom: 0 }]}>
            <View style={[styles.toolbar, { backgroundColor: 'rgba(0,0,0,0.88)' }]}>
              <View style={styles.toolbarRow}>
                <ToolBtn icon="close" label="Cancel" onPress={() => setMode('view')} light />
                <Text style={{ flex: 1, textAlign: 'center', fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>
                  Drag to move · handle to resize
                </Text>
                <TouchableOpacity onPress={applyCrop} style={[styles.primaryBarBtn, { backgroundColor: theme.primary }]} accessibilityLabel="Apply crop">
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Crop</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

function ToolBtn({ icon, label, onPress, disabled, light }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.toolBtn, light ? styles.toolBtnLight : styles.toolBtnDim, disabled ? { opacity: 0.45 } : null]}
      disabled={disabled}
      accessibilityLabel={label}
    >
      <Icon name={icon} size={20} color="#fff" />
      <Text style={[styles.toolBtnText, { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, backgroundColor: '#000' },
  body: { flex: 1 },
  bodyCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingBottom: 10, backgroundColor: 'rgba(0,0,0,0.45)' },
  topBarRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  topBarTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  overlayBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.16)' },
  bottomPanel: {
    position: 'absolute', left: 0, right: 0,
    paddingTop: 10, paddingHorizontal: 12,
    paddingBottom: Platform.OS === 'ios' ? 26 : 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  toolRow: { flexDirection: 'row', marginBottom: 10 },
  toolBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 22, marginRight: 10 },
  toolBtnDim: { backgroundColor: 'rgba(255,255,255,0.18)' },
  toolBtnLight: { backgroundColor: 'rgba(255,255,255,0.14)' },
  toolBtnText: { fontWeight: '700', fontSize: 13, marginLeft: 6 },
  captionRow: { flexDirection: 'row', alignItems: 'center' },
  caption: { flex: 1, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: '#fff', backgroundColor: 'rgba(255,255,255,0.14)', marginRight: 10 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  modeBarWrap: { position: 'absolute', left: 0, right: 0 },
  toolbar: { paddingVertical: 8, paddingHorizontal: 10 },
  toolbarRow: { flexDirection: 'row', alignItems: 'center' },
  primaryBarBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18 },
  cropOverlay: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.06)' },
  gridH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.6)' },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.6)' },
  handle: { position: 'absolute', left: 0, top: 0, width: 24, height: 24, borderLeftWidth: 3, borderTopWidth: 3, borderColor: '#fff' },
  handleAlt: { position: 'absolute', right: 0, top: 0, width: 24, height: 24, borderRightWidth: 3, borderTopWidth: 3, borderColor: '#fff' },
  handleAlt2: { position: 'absolute', left: 0, bottom: 0, width: 24, height: 24, borderLeftWidth: 3, borderBottomWidth: 3, borderColor: '#fff' },
  handleBR: { position: 'absolute', right: 0, bottom: 0, width: 30, height: 30, borderRightWidth: 4, borderBottomWidth: 4, borderColor: '#fff' },
  dim: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  dimSide: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  centerDim: { backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' },
  processingPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.75)', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 24 },
  videoPreviewBtn: { flexDirection: 'row', alignItems: 'center', borderRadius: 24, paddingHorizontal: 20, paddingVertical: 12 },
});
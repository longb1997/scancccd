import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Camera,
  CommonResolutions,
  type Frame,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
  usePhotoOutput,
} from 'react-native-vision-camera';
import { useTextRecognition } from 'react-native-vision-camera-mlkit';
import { useFaceDetector } from 'react-native-vision-camera-face-detector';
import type { Image } from 'react-native-nitro-image';
import { scheduleOnRN } from 'react-native-worklets';
import {
  evaluate,
  MESSAGES,
  THRESHOLDS,
  type Evaluation,
  type FrameStats,
  type Box,
  type OcrLine,
  type Side,
} from './scan/evaluate';
import { measureLuma } from './scan/measureLuma';

const CARD_RATIO = 1.586; // ISO ID-1
const HOLD_MS = 1000; // auto-capture after this long of continuous "ok"
// Module constant on purpose: the hook re-creates the recognizer whenever the options object changes.
const OCR_OPTIONS = { language: 'LATIN' } as const;
// minFaceSize is a share of frame width: the portrait's face is ~0.11, below the 0.15 default.
const FACE_OPTIONS = {
  performanceMode: 'fast',
  minFaceSize: 0.05,
  cameraFacing: 'back',
} as const;

/** Guide frame in frame pixels, plus the frame size. */
type Roi = {
  w: number;
  h: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

/** Crops the photo to the guide frame, padded by the edge tolerance the "cut" check allows. */
function cropToGuide(image: Image, roi: Roi) {
  // ponytail: assumes the frame is a centred crop of the photo's wider field of view
  // (16:9 frame inside the 4:3 photo, verified on a Note20). Re-check if outputs change.
  const k = Math.min(image.width / roi.w, image.height / roi.h); // frame px -> photo px
  const ox = (image.width - roi.w * k) / 2;
  const oy = (image.height - roi.h * k) / 2;
  const m = (roi.x1 - roi.x0) * THRESHOLDS.edgeTolerance;
  return image.cropAsync(
    Math.max(0, ox + (roi.x0 - m) * k),
    Math.max(0, oy + (roi.y0 - m) * k),
    Math.min(image.width, ox + (roi.x1 + m) * k),
    Math.min(image.height, oy + (roi.y1 + m) * k),
  );
}

type Props = {
  side: Side;
  isActive: boolean;
  onCaptured: (uri: string) => void;
};

export function ScanScreen({ side, isActive, onCaptured }: Props) {
  const { hasPermission, canRequestPermission, requestPermission } =
    useCameraPermission();
  useEffect(() => {
    if (!hasPermission && canRequestPermission) requestPermission();
  }, [hasPermission, canRequestPermission, requestPermission]);

  const device = useCameraDevice('back');
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const gx = 12;
  const gw = width - 2 * gx;
  const gh = gw / CARD_RATIO;
  const gy = height * 0.3;

  const okSince = useRef<number | null>(null);
  const capturing = useRef(false);
  const roiRef = useRef<Roi | null>(null);
  // undefined until first toggle: sending 'off' before the camera is active rejects ("Camera is not active").
  const [torch, setTorch] = useState<'on' | 'off'>();
  const [auto, setAuto] = useState(true);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [debug, setDebug] = useState('');

  useEffect(() => {
    setEvaluation(null);
    okSince.current = null;
  }, [side]);

  const photoOutput = usePhotoOutput();
  const capture = useCallback(async () => {
    if (capturing.current) return;
    capturing.current = true;
    try {
      const photo = await photoOutput.capturePhoto(
        { flashMode: 'off', enableShutterSound: false }, // OS still forces it where the law requires (e.g. Japan)
        {},
      );
      try {
        const image = await photo.toImageAsync(); // upright: orientation applied
        const roi = roiRef.current;
        const cropped = roi ? await cropToGuide(image, roi) : image;
        onCaptured(
          `file://${await cropped.saveToTemporaryFileAsync('jpg', 90)}`,
        );
      } finally {
        photo.dispose();
      }
    } catch (e) {
      Alert.alert('Không chụp được ảnh', String(e));
    } finally {
      capturing.current = false;
      okSince.current = null;
    }
  }, [photoOutput, onCaptured]);

  const onStats = useCallback(
    (stats: FrameStats, roi: Roi) => {
      if (!isActive) return; // late result after the screen was left
      roiRef.current = roi;
      const e = evaluate(stats, side);
      setEvaluation(e);
      if (__DEV__) {
        setDebug(
          `${e.side ?? '-'}/${e.model ?? '-'} lóa ${(stats.glare * 100).toFixed(
            1,
          )}% ` +
            `nét ${stats.sharpness.toFixed(0)} thẻ ${
              e.cardWidth?.toFixed(2) ?? '-'
            } mặt người ${stats.face ? 'có' : 'không'} [${roi.w}x${
              roi.h
            } vùng ${roi.x0.toFixed(0)},${roi.y0.toFixed(0)}-${roi.x1.toFixed(
              0,
            )},${roi.y1.toFixed(0)}]\n` +
            stats.lines
              .map(l => l.text)
              .join(' | ')
              .slice(0, 300),
        );
      }
      if (e.status !== 'ok') {
        okSince.current = null;
        return;
      }
      okSince.current ??= Date.now();
      if (auto && Date.now() - okSince.current >= HOLD_MS) capture();
    },
    [isActive, side, auto, capture],
  );

  const { textRecognition } = useTextRecognition(OCR_OPTIONS);
  const faceDetector = useFaceDetector(FACE_OPTIONS); // a HybridObject: don't destructure
  const frameOutput = useFrameOutput({
    // ponytail: FHD so the small card labels are ~13px tall for OCR; drop to HD_16_9 if the phone runs hot.
    targetResolution: CommonResolutions.FHD_16_9,
    pixelFormat: 'yuv',
    // Upright buffers: OCR boxes, luma reads and the ROI all share one coordinate space.
    enablePhysicalBufferRotation: true,
    onFrame: useCallback(
      (frame: Frame) => {
        'worklet';
        try {
          // Guide frame (dp) -> frame pixels. The preview is resizeMode "cover", centred, with the
          // frame's field of view (resolutionBias). Not frame.convertCameraPointToFramePoint: on
          // Android with enablePhysicalBufferRotation it returned points off by ~(-740, -180) px.
          const s = Math.max(width / frame.width, height / frame.height); // dp per frame px
          const ox = (frame.width * s - width) / 2; // dp cropped off each side
          const oy = (frame.height * s - height) / 2;
          // 1px margin: the Laplacian in measureLuma reads neighbours.
          const x0 = Math.max(1, (gx + ox) / s);
          const x1 = Math.min(frame.width - 2, (gx + gw + ox) / s);
          const y0 = Math.max(1, (gy + oy) / s);
          const y1 = Math.min(frame.height - 2, (gy + gh + oy) / s);
          if (x1 - x0 < 10 || y1 - y0 < 10) return;

          const plane = frame.getPlanes()[0];
          const luma = measureLuma(
            new Uint8Array(plane.getPixelBuffer()),
            plane.bytesPerRow,
            x0,
            y0,
            x1,
            y1,
          );
          const ocr = textRecognition(frame, { outputOrientation: 'portrait' });
          const lines: OcrLine[] = [];
          for (const block of ocr.blocks) {
            for (const line of block.lines) {
              lines.push({
                text: line.text,
                l: (line.bounds.left - x0) / (x1 - x0),
                r: (line.bounds.right - x0) / (x1 - x0),
                t: (line.bounds.top - y0) / (y1 - y0),
                b: (line.bounds.bottom - y0) / (y1 - y0),
              });
            }
          }
          // Largest face only; plain numbers, since Face objects can't cross to the JS thread.
          let face: Box | null = null;
          let area = 0;
          for (const f of faceDetector.detectFaces(frame)) {
            const { x, y, width: fw, height: fh } = f.bounds;
            if (fw * fh <= area) continue;
            area = fw * fh;
            face = {
              l: (x - x0) / (x1 - x0),
              r: (x + fw - x0) / (x1 - x0),
              t: (y - y0) / (y1 - y0),
              b: (y + fh - y0) / (y1 - y0),
            };
          }
          const roi = { w: frame.width, h: frame.height, x0, y0, x1, y1 };
          scheduleOnRN(onStats, { lines, face, ...luma }, roi);
        } finally {
          frame.dispose();
        }
      },
      [width, height, gx, gy, gw, gh, textRecognition, faceDetector, onStats],
    ),
  });

  if (!hasPermission) {
    return (
      <View style={[styles.fill, styles.center]}>
        <Text style={styles.white}>
          Ứng dụng cần quyền camera để chụp giấy tờ
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => Linking.openSettings()}
          style={styles.settings}
        >
          <Text>Mở cài đặt</Text>
        </Pressable>
      </View>
    );
  }
  if (device == null) {
    return (
      <View style={[styles.fill, styles.center]}>
        <Text style={styles.white}>Không tìm thấy camera sau</Text>
      </View>
    );
  }

  const status = evaluation?.status ?? 'noCard';
  const sideLabel = side === 'front' ? 'Mặt trước' : 'Mặt sau';
  return (
    <View style={styles.fill}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isActive}
        outputs={[photoOutput, frameOutput]}
        constraints={[{ resolutionBias: frameOutput }]}
        torchMode={torch}
        // UI is portrait-locked; 'device' (default) turned frames landscape when the phone tilted.
        orientationSource="interface"
      />
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={[styles.dim, styles.dimTop, { height: gy }]} />
        <View style={[styles.dim, styles.dimBottom, { top: gy + gh }]} />
        <View
          style={[styles.dim, styles.left0, { top: gy, width: gx, height: gh }]}
        />
        <View
          style={[
            styles.dim,
            styles.right0,
            { top: gy, left: gx + gw, height: gh },
          ]}
        />
        <View
          style={[
            styles.frame,
            { top: gy, left: gx, width: gw, height: gh },
            status === 'ok' && styles.frameOk,
          ]}
        >
          <Text accessibilityLiveRegion="polite" style={styles.toast}>
            {MESSAGES[status](side)}
          </Text>
        </View>
        <Text style={[styles.title, { top: insets.top + 12 }]}>
          Chụp CCCD {sideLabel.toLowerCase()}
        </Text>
        <View style={[styles.labels, { top: gy - 28, left: gx, width: gw }]}>
          <Text style={styles.white}>Căn cước công dân</Text>
          <Text style={styles.white}>{sideLabel}</Text>
        </View>
        {__DEV__ && (
          <Text style={[styles.debug, { top: gy + gh + 12 }]}>{debug}</Text>
        )}
      </View>
      <View style={[styles.controls, { bottom: insets.bottom + 24 }]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setTorch(t => (t === 'on' ? 'off' : 'on'))}
          style={styles.control}
        >
          <Text style={styles.white}>
            Flash {torch === 'on' ? 'bật' : 'tắt'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Chụp ảnh"
          disabled={status !== 'ok'}
          onPress={capture}
          style={[styles.shutter, status !== 'ok' && styles.disabled]}
        />
        <View style={styles.control}>
          <Switch
            accessibilityLabel="Chụp tự động"
            value={auto}
            onValueChange={setAuto}
          />
          <Text style={styles.white}>Chụp tự động</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  white: { color: '#fff' },
  settings: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  dim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  dimTop: { top: 0, left: 0, right: 0 },
  dimBottom: { bottom: 0, left: 0, right: 0 },
  left0: { left: 0 },
  right0: { right: 0 },
  frame: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#fff',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameOk: { borderColor: '#2ecc71' },
  toast: {
    backgroundColor: '#fff',
    color: '#d0021b',
    fontWeight: '600',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    overflow: 'hidden',
  },
  title: {
    position: 'absolute',
    alignSelf: 'center',
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  labels: {
    position: 'absolute',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  debug: {
    position: 'absolute',
    left: 12,
    right: 12,
    color: '#ff0',
    fontSize: 11,
  },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  control: {
    alignItems: 'center',
    minWidth: 96,
    minHeight: 48,
    justifyContent: 'center',
  },
  shutter: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 5,
    borderColor: '#fff',
    backgroundColor: '#d0021b',
  },
  disabled: { opacity: 0.35 },
});

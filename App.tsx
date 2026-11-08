import React, { useState } from 'react';
import {
  Image,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { ScanScreen } from './src/ScanScreen';
import type { Side } from './src/scan/evaluate';

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <Flow />
    </SafeAreaProvider>
  );
}

const LABEL: Record<Side, string> = { front: 'mặt trước', back: 'mặt sau' };

function Flow() {
  const [photos, setPhotos] = useState<Partial<Record<Side, string>>>({});
  const [review, setReview] = useState<Side | null>(null);
  const insets = useSafeAreaInsets();
  const side: Side | null = !photos.front
    ? 'front'
    : !photos.back
    ? 'back'
    : null;

  const retake = (s: Side) => {
    setPhotos(p => ({ ...p, [s]: undefined }));
    setReview(null);
  };

  return (
    <View style={styles.fill}>
      {/* Camera stays mounted; only isActive toggles (VisionCamera v5 guidance). */}
      <ScanScreen
        side={side ?? 'back'}
        isActive={side != null && review == null}
        onCaptured={uri => {
          if (!side) return;
          setPhotos(p => ({ ...p, [side]: uri }));
          setReview(side);
        }}
      />
      {(review != null || side == null) && (
        <View
          style={[
            styles.sheet,
            { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
          ]}
        >
          <Text style={styles.success}>
            {review
              ? `Chụp CCCD ${LABEL[review]} thành công`
              : 'Đã chụp đủ 2 mặt'}
          </Text>
          {(review ? [review] : (['front', 'back'] as Side[])).map(s => (
            <Image
              key={s}
              source={{ uri: photos[s] }}
              style={styles.photo}
              resizeMode="contain"
            />
          ))}
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              style={[styles.button, styles.outline]}
              onPress={() => (review ? retake(review) : setPhotos({}))}
            >
              <Text>{review ? 'Chụp lại' : 'Chụp lại từ đầu'}</Text>
            </Pressable>
            {review && (
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => setReview(null)}
              >
                <Text>{review === 'front' ? 'Chụp mặt sau' : 'Tiếp tục'}</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  sheet: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    gap: 16,
  },
  success: {
    color: '#1e9e4a',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  photo: { flex: 1, backgroundColor: '#eee', borderRadius: 8 },
  row: { flexDirection: 'row', gap: 12 },
  button: {
    flex: 1,
    minHeight: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ccc',
  },
  outline: { borderColor: '#333' },
});

export default App;

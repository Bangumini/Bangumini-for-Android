import { useCallback, useEffect } from "react";
import {
  Dimensions,
  Modal,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Image } from "expo-image";

import { saveImageToGallery } from "../utils/saveImage";
import { showToast } from "../utils/toast";
import { useAlert } from "./Dialog";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

interface ImageViewerProps {
  visible: boolean;
  uri: string;
  onClose: () => void;
}

export default function ImageViewer({ visible, uri, onClose }: ImageViewerProps) {
  const alert = useAlert();
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      scale.value = 1;
      savedScale.value = 1;
      translateX.value = 0;
      translateY.value = 0;
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
    }
  }, [visible, scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY]);

  const resetZoom = useCallback(() => {
    scale.value = withTiming(1);
    savedScale.value = 1;
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, [scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY]);

  const handleDoubleTap = useCallback(
    (x: number, y: number) => {
      if (scale.value > 1.1) {
        resetZoom();
      } else {
        const targetScale = DOUBLE_TAP_SCALE;
        const centerX = SCREEN_WIDTH / 2;
        const centerY = SCREEN_HEIGHT / 2;
        const deltaX = (centerX - x) * (targetScale - 1);
        const deltaY = (centerY - y) * (targetScale - 1);

        scale.value = withTiming(targetScale);
        savedScale.value = targetScale;
        translateX.value = withTiming(deltaX);
        translateY.value = withTiming(deltaY);
        savedTranslateX.value = deltaX;
        savedTranslateY.value = deltaY;
      }
    },
    [scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY, resetZoom],
  );

  const handleSingleTap = useCallback(() => {
    if (scale.value > 1.05) {
      resetZoom();
    } else {
      onClose();
    }
  }, [scale, resetZoom, onClose]);

  const doSave = useCallback(async () => {
    try {
      await saveImageToGallery(uri);
      showToast("已保存到 Bangumini 相册");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "保存失败";
      showToast(message);
    }
  }, [uri]);

  const handleSave = useCallback(() => {
    alert("保存图片", "是否保存到相册？", [
      { text: "取消", style: "cancel" },
      { text: "保存", onPress: () => void doSave() },
    ]);
  }, [alert, doSave]);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(1, savedScale.value * e.scale));
    })
    .onEnd(() => {
      if (scale.value < 1.05) {
        runOnJS(resetZoom)();
      } else {
        savedScale.value = scale.value;
      }
    });

  const pan = Gesture.Pan()
    .minPointers(1)
    .maxPointers(2)
    .onUpdate((e) => {
      if (scale.value > 1.05) {
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      }
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      runOnJS(handleDoubleTap)(e.absoluteX, e.absoluteY);
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      runOnJS(handleSingleTap)();
    });

  const longPress = Gesture.LongPress()
    .minDuration(500)
    .onStart(() => {
      runOnJS(handleSave)();
    });

  const composed = Gesture.Race(
    Gesture.Simultaneous(pinch, pan),
    Gesture.Exclusive(doubleTap, longPress, singleTap),
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar hidden />
      <GestureHandlerRootView style={styles.container}>
        <GestureDetector gesture={composed}>
          <Animated.View style={[styles.imageWrapper, animatedStyle]}>
            <Image
              source={{ uri }}
              style={styles.image}
              contentFit="contain"
              cachePolicy="memory-disk"
            />
          </Animated.View>
        </GestureDetector>
        <Pressable style={styles.closeButton} onPress={onClose}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  imageWrapper: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    justifyContent: "center",
    alignItems: "center",
  },
  image: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.7,
  },
  closeButton: {
    position: "absolute",
    top: 50,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.15)",
    justifyContent: "center",
    alignItems: "center",
  },
  closeText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});

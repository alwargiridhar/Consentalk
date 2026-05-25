import React, { useState, useEffect } from "react";
import {
  Modal,
  View,
  Image,
  Pressable,
  StyleSheet,
  Dimensions,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from "react-native-reanimated";

interface Props {
  uri: string | null;
  onClose: () => void;
  testID?: string;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

export default function ImageViewer({ uri, onClose, testID }: Props) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (uri) {
      scale.value = 1;
      savedScale.value = 1;
      translateX.value = 0;
      translateY.value = 0;
      savedTranslateY.value = 0;
      savedTranslateX.value = 0;
      opacity.value = 1;
    }
  }, [uri, scale, savedScale, translateX, translateY, savedTranslateY, savedTranslateX, opacity]);

  const closeNow = () => onClose();

  // Pinch: scale image
  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, Math.min(savedScale.value * e.scale, 6));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });

  // Pan: when zoomed → pan inside; when not zoomed → swipe-down to close
  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (scale.value > 1) {
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      } else {
        // swipe-down close
        if (e.translationY > 0) {
          translateY.value = e.translationY;
          opacity.value = Math.max(0.2, 1 - e.translationY / 400);
        }
      }
    })
    .onEnd((e) => {
      if (scale.value > 1) {
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
      } else {
        if (e.translationY > 120) {
          opacity.value = withTiming(0, { duration: 160 });
          translateY.value = withTiming(SCREEN_H, { duration: 200 }, () => {
            runOnJS(closeNow)();
          });
        } else {
          translateY.value = withSpring(0);
          opacity.value = withSpring(1);
        }
      }
    });

  // Double-tap: toggle zoom
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1.2) {
        scale.value = withSpring(1);
        savedScale.value = 1;
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        scale.value = withSpring(2.5);
        savedScale.value = 2.5;
      }
    });

  const composed = Gesture.Simultaneous(pinch, pan, doubleTap);

  const imgStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const bgStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Modal
      visible={!!uri}
      transparent
      animationType="fade"
      onRequestClose={closeNow}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[styles.root, bgStyle]} testID={testID || "image-viewer"}>
          <GestureDetector gesture={composed}>
            <Animated.View style={styles.imageWrap}>
              {uri ? (
                <Animated.Image
                  source={{ uri }}
                  style={[styles.image, imgStyle]}
                  resizeMode="contain"
                />
              ) : null}
            </Animated.View>
          </GestureDetector>
          <Pressable
            style={styles.closeBtn}
            onPress={closeNow}
            testID="image-viewer-close"
            accessibilityLabel="Close image"
          >
            <Ionicons name="close" size={22} color="#FFFFFF" />
          </Pressable>
          <View style={styles.hintWrap} pointerEvents="none">
            <Ionicons name="hand-left-outline" size={14} color="rgba(255,255,255,0.65)" />
            <View style={{ width: 6 }} />
            {Platform.OS !== "web" ? (
              <Animated.Text style={styles.hintText}>
                Pinch / double-tap to zoom · swipe down to close
              </Animated.Text>
            ) : (
              <Animated.Text style={styles.hintText}>
                Double-tap to zoom · tap × to close
              </Animated.Text>
            )}
          </View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.94)",
    alignItems: "center",
    justifyContent: "center",
  },
  imageWrap: {
    width: SCREEN_W,
    height: SCREEN_H,
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: SCREEN_W,
    height: SCREEN_H,
  },
  closeBtn: {
    position: "absolute",
    top: 40,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 44,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  hintWrap: {
    position: "absolute",
    bottom: 40,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
  },
  hintText: { color: "rgba(255,255,255,0.85)", fontSize: 12 },
});

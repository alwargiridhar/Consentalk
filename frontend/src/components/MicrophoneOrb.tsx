import React, { useEffect } from "react";
import { View, StyleSheet, Pressable, Platform } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  withSpring,
  cancelAnimation,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Colors } from "../lib/theme";

interface MicrophoneOrbProps {
  active?: boolean;
  onPress?: () => void;
  size?: number;
  testID?: string;
}

export default function MicrophoneOrb({
  active = false,
  onPress,
  size = 168,
  testID = "mic-orb",
}: MicrophoneOrbProps) {
  const breath = useSharedValue(1);
  const press = useSharedValue(1);
  const halo = useSharedValue(0.6);

  useEffect(() => {
    breath.value = withRepeat(
      withTiming(1.06, { duration: 2400, easing: Easing.inOut(Easing.quad) }),
      -1,
      true
    );
    halo.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.quad) }),
      -1,
      true
    );
    return () => {
      cancelAnimation(breath);
      cancelAnimation(halo);
    };
  }, [breath, halo]);

  const orbStyle = useAnimatedStyle(() => ({
    transform: [{ scale: breath.value * press.value }],
  }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.18 + halo.value * 0.18,
    transform: [{ scale: 1 + halo.value * 0.1 }],
  }));

  return (
    <View style={[styles.wrap, { width: size * 1.5, height: size * 1.5 }]}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.halo,
          {
            width: size * 1.4,
            height: size * 1.4,
            borderRadius: (size * 1.4) / 2,
          },
          haloStyle,
        ]}
      />
      <Pressable
        accessibilityRole="button"
        testID={testID}
        onPress={onPress}
        onPressIn={() => {
          press.value = withSpring(0.94, { damping: 12 });
        }}
        onPressOut={() => {
          press.value = withSpring(1, { damping: 12 });
        }}
        style={{ width: size, height: size }}
      >
        <Animated.View
          style={[
            styles.orb,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
            },
            orbStyle,
          ]}
        >
          <LinearGradient
            colors={
              active
                ? ["#38BDF8", "#0EA5E9", "#0284C7"]
                : ["#FFFFFF", "#F0F9FF"]
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[
              StyleSheet.absoluteFillObject,
              { borderRadius: size / 2 },
            ]}
          />
          <View style={styles.iconWrap}>
            <Ionicons
              name="mic"
              size={size * 0.34}
              color={active ? "#FFFFFF" : Colors.brandPrimary}
            />
          </View>
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  halo: {
    position: "absolute",
    backgroundColor: Colors.brandFog,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 0 60px rgba(14,165,233,0.45)" as any }
      : {
          shadowColor: Colors.brandPrimary,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.45,
          shadowRadius: 60,
        }),
  },
  orb: {
    backgroundColor: Colors.paper,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#E0F2FE",
    overflow: "hidden",
    ...(Platform.OS === "web"
      ? { boxShadow: "0 24px 48px rgba(14,165,233,0.20)" as any }
      : {
          shadowColor: Colors.brandPrimary,
          shadowOffset: { width: 0, height: 24 },
          shadowOpacity: 0.2,
          shadowRadius: 48,
          elevation: 6,
        }),
  },
  iconWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
});

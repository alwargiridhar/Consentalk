import React from "react";
import { View, StyleSheet } from "react-native";
import { Colors } from "../lib/theme";

interface PinDotsProps {
  length: number;
  filled: number;
  testID?: string;
}

export default function PinDots({ length, filled, testID = "pin-dots" }: PinDotsProps) {
  return (
    <View style={styles.row} testID={testID}>
      {Array.from({ length }).map((_, i) => {
        const isFilled = i < filled;
        return (
          <View
            key={i}
            style={[
              styles.dot,
              isFilled ? styles.dotFilled : styles.dotEmpty,
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 14, justifyContent: "center" },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 16,
  },
  dotEmpty: { backgroundColor: Colors.divider },
  dotFilled: { backgroundColor: Colors.brandPrimary },
});

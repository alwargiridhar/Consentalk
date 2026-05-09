import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Modal,
  Pressable,
  FlatList,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COUNTRIES, Country, searchCountries } from "../lib/countries";
import { Colors, Radii } from "../lib/theme";

interface CountryPickerProps {
  value: string;
  onSelect: (country: Country) => void;
  testID?: string;
  label?: string;
}

export default function CountryPicker({
  value,
  onSelect,
  testID = "country-picker",
  label = "Country",
}: CountryPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const list = useMemo(() => searchCountries(query), [query]);
  const selected = COUNTRIES.find((c) => c.name === value);

  return (
    <>
      <Pressable
        testID={testID}
        onPress={() => setOpen(true)}
        style={styles.field}
      >
        <Ionicons name="flag-outline" size={18} color={Colors.brandPrimary} />
        <Text
          style={[
            styles.fieldText,
            !value && { color: Colors.textTertiary },
          ]}
          numberOfLines={1}
        >
          {selected ? selected.name : `Choose your ${label.toLowerCase()}`}
        </Text>
        <Ionicons name="chevron-down" size={16} color={Colors.textTertiary} />
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.modalRoot}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{label}</Text>
              <Pressable
                onPress={() => setOpen(false)}
                testID="country-picker-close"
                style={styles.closeBtn}
              >
                <Ionicons name="close" size={20} color={Colors.textSecondary} />
              </Pressable>
            </View>
            <View style={styles.searchRow}>
              <Ionicons
                name="search-outline"
                size={16}
                color={Colors.textTertiary}
              />
              <TextInput
                testID="country-search-input"
                value={query}
                onChangeText={setQuery}
                placeholder="Type 2–3 letters…"
                placeholderTextColor={Colors.textTertiary}
                style={styles.search}
                autoFocus
                autoCorrect={false}
              />
              {query ? (
                <Pressable onPress={() => setQuery("")}>
                  <Ionicons
                    name="close-circle"
                    size={16}
                    color={Colors.textTertiary}
                  />
                </Pressable>
              ) : null}
            </View>
            <FlatList
              data={list}
              keyExtractor={(c) => c.code}
              keyboardShouldPersistTaps="handled"
              ItemSeparatorComponent={() => (
                <View style={{ height: 1, backgroundColor: Colors.divider2 }} />
              )}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => {
                    onSelect(item);
                    setOpen(false);
                    setQuery("");
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && { backgroundColor: Colors.brandFog },
                  ]}
                  testID={`country-row-${item.code}`}
                >
                  <Text style={styles.rowName}>{item.name}</Text>
                  <Text style={styles.rowDial}>{item.dial}</Text>
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={styles.emptyText}>No countries match.</Text>
              }
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    height: 52,
    backgroundColor: Colors.bg,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: Colors.divider,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  fieldText: { flex: 1, color: Colors.textPrimary, fontSize: 15 },
  modalRoot: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: Colors.paper,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    height: "75%",
    overflow: "hidden",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 18,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider2,
  },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: Colors.textPrimary },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.bg,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: 14,
    paddingHorizontal: 14,
    height: 46,
    backgroundColor: Colors.bg,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  search: { flex: 1, fontSize: 15, color: Colors.textPrimary },
  row: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowName: { fontSize: 15, color: Colors.textPrimary },
  rowDial: { fontSize: 13, color: Colors.textTertiary, fontVariant: ["tabular-nums"] },
  emptyText: { textAlign: "center", padding: 24, color: Colors.textTertiary },
});

import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

import { colors } from "../../src/theme/colors";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function tabIcon(name: IconName) {
  return ({ color, size }: { color: string; size: number }) => (
    <Ionicons name={name} color={color} size={size} />
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "700" },
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.subtle,
      }}
    >
      <Tabs.Screen
        name="collections"
        options={{ title: "收藏", tabBarIcon: tabIcon("albums-outline") }}
      />
      <Tabs.Screen
        name="calendar"
        options={{ title: "日历", tabBarIcon: tabIcon("calendar-outline") }}
      />
      <Tabs.Screen
        name="search"
        options={{ title: "搜索", tabBarIcon: tabIcon("search-outline") }}
      />
      <Tabs.Screen
        name="next-season"
        options={{ title: "下季度", tabBarIcon: tabIcon("sparkles-outline") }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "设置", tabBarIcon: tabIcon("settings-outline") }}
      />
    </Tabs>
  );
}

const { version } = require("./package.json");

function getAndroidVersionCode(versionName) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(versionName);

  if (!match) {
    throw new Error(`Invalid package version for Android versionCode: ${versionName}`);
  }

  const [, major, minor, patch] = match.map(Number);
  return major * 10000 + minor * 100 + patch;
}

module.exports = {
  expo: {
    name: "Bangumini",
    slug: "bangumini-for-android",
    scheme: "bangumini",
    version,
    icon: "./assets/icon.png",
    orientation: "portrait",
    userInterfaceStyle: "dark",
    newArchEnabled: false,
    assetBundlePatterns: ["**/*"],
    plugins: [
      "./plugins/withAndroidConfig",
      "expo-router",
      [
        "expo-font",
        {
          fonts: [
            "./node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf",
            "./node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialCommunityIcons.ttf",
          ],
        },
      ],
      "expo-secure-store",
      "expo-sqlite",
      [
        "expo-splash-screen",
        {
          backgroundColor: "#101216",
          image: "./assets/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
        },
      ],
    ],
    android: {
      package: "dev.raycast.bangumini",
      versionCode: getAndroidVersionCode(version),
      adaptiveIcon: {
        backgroundColor: "#101216",
        foregroundImage: "./assets/adaptive-icon.png",
      },
      permissions: ["android.permission.INTERNET"],
    },
  },
};

import { Image, type ImageStyle } from "expo-image";
import { StyleProp, View, type ViewStyle } from "react-native";

import { colors } from "../theme/colors";

type CachedImageProps = {
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
  contentFit?: "cover" | "contain";
};

export default function CachedImage({ uri, style, contentFit = "cover" }: CachedImageProps) {
  if (!uri) {
    return <View style={[{ backgroundColor: colors.surfaceAlt }, style]} />;
  }

  const safeUri = uri.replace(/^http:/, "https:");

  return (
    <Image
      source={{ uri: safeUri }}
      style={style as StyleProp<ImageStyle>}
      contentFit={contentFit}
      cachePolicy="memory-disk"
      transition={160}
    />
  );
}

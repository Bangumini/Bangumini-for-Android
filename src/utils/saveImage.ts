import { NativeModules, Platform } from "react-native";

const { BanguminiMedia } = NativeModules;
const ALBUM_NAME = "Bangumini";

export async function saveImageToGallery(uri: string): Promise<void> {
  if (Platform.OS !== "android") {
    throw new Error("Unsupported platform");
  }

  await BanguminiMedia.saveImageFromUrl(uri, ALBUM_NAME);
}

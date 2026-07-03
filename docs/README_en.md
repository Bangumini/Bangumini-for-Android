# Bangumini for Android

The Android version of [Bangumini](https://github.com/Bangumini/Bangumini).

## Features

**Collections** — Browse all your collections by category. Currently watching entries are intelligently sorted by today's broadcast schedule.

**Daily Calendar** — View this season's anime schedule by weekday. See at a glance what's airing today.

**Search** — Search the Bangumi database by Chinese name, Japanese name, or pinyin initials. Filter by subject type.

**Subject Details** — View anime summary, staff, characters & voice actors, rating and ranking. Adjust watch progress and update status directly from the detail page.

**Next Season** — Browse upcoming season anime, grouped by weekday with airing times.

## Screenshots
![screenshot](image.jpg)

## Installation

Download the latest APK from [GitHub Releases](https://github.com/Bangumini/Bangumini-for-Android/releases) and install it directly.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Android Studio](https://developer.android.com/studio) (with Android SDK 35 and NDK 26)
- JDK 17

### Quick Start

```bash
# Install dependencies
npm install

# Start dev server (requires connected Android device or emulator)
npm run android

# Type check
npm run typecheck

# Lint
npm run lint
```

### Build APK

```bash
# Via EAS Build
eas build --platform android --profile preview

# Or build locally
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

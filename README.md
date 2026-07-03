# Bangumini for Android

[Bangumini](https://github.com/Bangumini/Bangumini) 的 Android 版本。

## 功能

**收藏管理** — 按分类浏览你的全部收藏。正在追的条目会按当天的播放日历智能排序。

**每日放送** — 按星期查看当季番剧的播出时间表，当日更新一目了然。

**条目搜索** — 搜索 Bangumi 条目库，支持中文名、日文名、拼音模糊搜索，可按类型筛选。

**条目详情** — 查看动画的简介、制作人员、角色与声优、评分排名。直接在详情页调整观看进度，一键标记状态。

**新番预告** — 浏览下一季的新番列表，按星期分组，标注播出时间。

## 截图

![screenshot](docs/image.jpg)

## 安装

从 [GitHub Releases](https://github.com/Bangumini/Bangumini-for-Android/releases) 下载最新 APK 直接安装即可。


## 开发

### 环境要求

- [Node.js](https://nodejs.org/) 18+
- [Android Studio](https://developer.android.com/studio)（含 Android SDK 35、NDK 26）
- JDK 17

### 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器（需要连接 Android 设备或模拟器）
npm run android

# 类型检查
npm run typecheck

# 代码检查
npm run lint
```

### 构建 APK

```bash
# 通过 EAS Build
eas build --platform android --profile preview

# 或本地构建
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

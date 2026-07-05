const { withDangerousMod, withGradleProperties, withAppBuildGradle, withMainApplication, withAndroidManifest } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const BACKUP_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <exclude domain="sharedpref" path="SecureStore.xml"/>
</full-backup-content>
`;

const DATA_EXTRACTION_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="sharedpref" path="SecureStore.xml"/>
    </cloud-backup>
    <device-transfer>
        <exclude domain="sharedpref" path="SecureStore.xml"/>
    </device-transfer>
</data-extraction-rules>
`;

const FILE_PATHS_XML = `<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="apk" path="." />
</paths>
`;

const PROGUARD_RULES = `# Expo / React Native ProGuard rules
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }
-keep class com.facebook.soloader.** { *; }
-keep class com.facebook.fbreact.** { *; }

# Hermes
-keep class com.facebook.hermes.unicode.** { *; }
-keep class com.facebook.jni.HybridData { *; }

# React Native reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# React Native gesture handler
-keep class com.swmansion.gesturehandler.** { *; }

# React Native screens
-keep class com.swmansion.rnscreens.** { *; }

# React Native safe area context
-keep class com.th3rdwave.safeareacontext.** { *; }

# Expo modules
-keep class expo.modules.** { *; }
-keep class org.unimodules.** { *; }

# AsyncStorage
-keep class com.reactnativecommunity.asyncstorage.** { *; }

# SQLite
-keep class expo.modules.sqlite.** { *; }
-keep class org.sqlite.** { *; }
-keep class org.pgsqlite.** { *; }

# OkHttp & Okio
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep class okio.** { *; }

# Keep native methods and JS interfaces
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * {
    native <methods>;
}

# Keep Serializable
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    !static !transient <fields>;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    java.lang.Object readResolve();
}
`;

const BUILD_PROPS = [
  { key: "reactNativeArchitectures", value: "arm64-v8a" },
  { key: "android.enableProguardInReleaseBuilds", value: "true" },
  { key: "android.enableShrinkResourcesInReleaseBuilds", value: "true" },
  { key: "expo.gif.enabled", value: "false" },
  { key: "expo.webp.enabled", value: "false" },
];

function withSecureStoreBackupRules(config) {
  return withDangerousMod(config, [
    "android",
    (config) => {
      const platformRoot = config.modRequest.platformProjectRoot;
      const xmlDir = path.join(platformRoot, "app", "src", "main", "res", "xml");
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, "secure_store_backup_rules.xml"),
        BACKUP_RULES_XML
      );
      fs.writeFileSync(
        path.join(xmlDir, "secure_store_data_extraction_rules.xml"),
        DATA_EXTRACTION_RULES_XML
      );
      fs.writeFileSync(path.join(xmlDir, "file_paths.xml"), FILE_PATHS_XML);

      // Prevent shrinkResources from stripping icon fonts loaded at runtime
      const rawDir = path.join(platformRoot, "app", "src", "main", "res", "raw");
      fs.mkdirSync(rawDir, { recursive: true });
      fs.writeFileSync(
        path.join(rawDir, "keep.xml"),
        '<?xml version="1.0" encoding="utf-8"?>\n<resources xmlns:tools="http://schemas.android.com/tools"\n    tools:keep="@font/ionicons,@font/MaterialIcons,@font/MaterialCommunityIcons,@font/FontAwesome5_Solid,@font/FontAwesome5_Brands,@font/FontAwesome5_Regular" />\n'
      );
      return config;
    },
  ]);
}

function withApkInstallProvider(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const permissions = manifest["uses-permission"] ?? [];
    if (!permissions.some((permission) => permission.$?.["android:name"] === "android.permission.REQUEST_INSTALL_PACKAGES")) {
      permissions.push({ $: { "android:name": "android.permission.REQUEST_INSTALL_PACKAGES" } });
      manifest["uses-permission"] = permissions;
    }

    const application = manifest.application?.[0];
    if (!application) {
      throw new Error("Unable to find Android application manifest block.");
    }

    const providers = application.provider ?? [];
    if (!providers.some((provider) => provider.$?.["android:authorities"] === "${applicationId}.fileprovider")) {
      providers.push({
        $: {
          "android:name": "androidx.core.content.FileProvider",
          "android:authorities": "${applicationId}.fileprovider",
          "android:exported": "false",
          "android:grantUriPermissions": "true",
        },
        "meta-data": [
          {
            $: {
              "android:name": "android.support.FILE_PROVIDER_PATHS",
              "android:resource": "@xml/file_paths",
            },
          },
        ],
      });
      application.provider = providers;
    }

    return config;
  });
}

function withProGuardRules(config) {
  return withDangerousMod(config, [
    "android",
    (config) => {
      const platformRoot = config.modRequest.platformProjectRoot;
      const rulesPath = path.join(platformRoot, "app", "proguard-rules.pro");
      fs.writeFileSync(rulesPath, PROGUARD_RULES);
      return config;
    },
  ]);
}

function withNdkAbiFilter(config) {
  return withAppBuildGradle(config, (config) => {
    const content = config.modResults.contents;
    if (!content.includes("abiFilters 'arm64-v8a'")) {
      config.modResults.contents = content.replace(
        /(versionName\s+"[^"]*")/,
        "$1\n        ndk {\n            abiFilters 'arm64-v8a'\n        }"
      );
    }
    return config;
  });
}

function withReleaseSigningConfig(config) {
  return withAppBuildGradle(config, (config) => {
    const debugSigningConfig = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;

    const releaseSigningConfig = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            def releaseStoreFile = System.getenv("ANDROID_RELEASE_STORE_FILE")
            def releaseStorePassword = System.getenv("ANDROID_RELEASE_STORE_PASSWORD")
            def releaseKeyAlias = System.getenv("ANDROID_RELEASE_KEY_ALIAS")
            def releaseKeyPassword = System.getenv("ANDROID_RELEASE_KEY_PASSWORD")
            if (releaseStoreFile && releaseStorePassword && releaseKeyAlias && releaseKeyPassword) {
                storeFile file(releaseStoreFile)
                storePassword releaseStorePassword
                keyAlias releaseKeyAlias
                keyPassword releaseKeyPassword
            }
        }
    }`;

    let content = config.modResults.contents;

    if (!content.includes("ANDROID_RELEASE_STORE_FILE")) {
      if (!content.includes(debugSigningConfig)) {
        throw new Error("Unable to find the Android debug signing config block.");
      }
      content = content.replace(debugSigningConfig, releaseSigningConfig);
    }

    content = content.replace(
      "            signingConfig signingConfigs.debug\n            shrinkResources",
      '            signingConfig System.getenv("ANDROID_RELEASE_STORE_FILE") ? signingConfigs.release : signingConfigs.debug\n            shrinkResources'
    );

    config.modResults.contents = content;
    return config;
  });
}

function withDebugApplicationIdSuffix(config) {
  return withAppBuildGradle(config, (config) => {
    let content = config.modResults.contents;
    if (!content.includes('applicationIdSuffix ".dev"')) {
      content = content.replace(
        "        debug {\n            signingConfig signingConfigs.debug\n        }",
        '        debug {\n            signingConfig signingConfigs.debug\n            applicationIdSuffix ".dev"\n            versionNameSuffix "-dev"\n        }'
      );
    }
    config.modResults.contents = content;
    return config;
  });
}

function withOptimizedBuild(config) {
  return withGradleProperties(config, (config) => {
    const toRemove = new Set(BUILD_PROPS.map((p) => p.key));
    config.modResults = config.modResults.filter(
      (prop) => !toRemove.has(prop.key)
    );
    for (const prop of BUILD_PROPS) {
      config.modResults.push({ type: "property", ...prop });
    }
    return config;
  });
}

function withBanguminiMediaModule(config) {
  config = withDangerousMod(config, [
    "android",
    (config) => {
      const platformRoot = config.modRequest.platformProjectRoot;
      const pkgDir = path.join(platformRoot, "app", "src", "main", "java", "com", "bangumini", "app");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.copyFileSync(
        path.join(__dirname, "BanguminiMediaModule.kt"),
        path.join(pkgDir, "BanguminiMediaModule.kt")
      );
      fs.copyFileSync(
        path.join(__dirname, "BanguminiMediaPackage.kt"),
        path.join(pkgDir, "BanguminiMediaPackage.kt")
      );
      return config;
    },
  ]);

  config = withMainApplication(config, (config) => {
    const content = config.modResults.contents;
    if (!content.includes("BanguminiMediaPackage")) {
      config.modResults.contents = content
        .replace(
          /^(import expo\.modules\.ApplicationLifecycleDispatcher.*)$/m,
          "$1\n\nimport com.bangumini.app.BanguminiMediaPackage"
        )
        .replace(
          /(val packages = PackageList\(this\)\.packages)/,
          "$1\n            packages.add(BanguminiMediaPackage())"
        );
    }
    return config;
  });

  return config;
}

module.exports = function withBanguminiConfig(config) {
  config = withSecureStoreBackupRules(config);
  config = withApkInstallProvider(config);
  config = withProGuardRules(config);
  config = withNdkAbiFilter(config);
  config = withReleaseSigningConfig(config);
  config = withDebugApplicationIdSuffix(config);
  config = withOptimizedBuild(config);
  config = withBanguminiMediaModule(config);
  return config;
};

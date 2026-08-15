package com.bangumini.app

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.bumptech.glide.Glide
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class BanguminiMediaModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    override fun getName() = "BanguminiMedia"

    @ReactMethod
    fun canRequestPackageInstalls(promise: Promise) {
        try {
            val context = reactApplicationContext
            // API 26+ 才有 per-app「安装未知应用」授权；更低版本无此概念，视为已授权
            val result =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.packageManager.canRequestPackageInstalls()
                } else {
                    true
                }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("CHECK_FAILED", e.message)
        }
    }

    @ReactMethod
    fun getPackageName(promise: Promise) {
        // 返回运行时实际 applicationId（dev 构建带 .dev 后缀）
        promise.resolve(reactApplicationContext.packageName)
    }

    @ReactMethod
    fun saveImageFromUrl(
        url: String,
        albumName: String,
        promise: Promise,
    ) {
        try {
            val context = reactApplicationContext

            val file =
                Glide
                    .with(context)
                    .asFile()
                    .load(url)
                    .submit()
                    .get()

            saveToMediaStore(context, file, albumName)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SAVE_FAILED", e.message)
        }
    }

    @ReactMethod
    fun saveToGallery(
        filePath: String,
        albumName: String,
        promise: Promise,
    ) {
        try {
            val file = File(filePath)
            saveToMediaStore(reactApplicationContext, file, albumName)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SAVE_FAILED", e.message)
        }
    }

    private fun saveToMediaStore(
        context: ReactApplicationContext,
        file: File,
        albumName: String,
    ) {
        val contentValues =
            ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, "bangumini_${System.currentTimeMillis()}.jpg")
                put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(
                        MediaStore.MediaColumns.RELATIVE_PATH,
                        "${Environment.DIRECTORY_PICTURES}/${sanitizeFolder(albumName)}",
                    )
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
            }

        val collection =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            }

        val uri =
            context.contentResolver.insert(collection, contentValues)
                ?: throw Exception("Failed to create MediaStore entry")

        try {
            context.contentResolver.openOutputStream(uri)?.use { output ->
                file.inputStream().use { input ->
                    input.copyTo(output)
                }
            } ?: throw Exception("Failed to open output stream")

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                contentValues.clear()
                contentValues.put(MediaStore.Images.Media.IS_PENDING, 0)
                context.contentResolver.update(uri, contentValues, null, null)
            }
        } catch (e: Exception) {
            context.contentResolver.delete(uri, null, null)
            throw e
        }
    }

    private fun sanitizeFolder(name: String): String = name.replace(Regex("""[\\/:*?"<>|]"""), "_").trim()
}

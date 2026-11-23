package com.hamsa.messenger;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/** Saves a received picture, video or voice note into the phone's gallery / downloads. */
@CapacitorPlugin(name = "SaveMedia")
public class SaveMediaPlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        try {
            String data = call.getString("data", "");
            String mime = call.getString("mime", "application/octet-stream");
            String name = call.getString("name", "hamsa-file");
            if (data == null || data.isEmpty()) { call.reject("empty"); return; }
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            String folder = mime.startsWith("image/") ? "Pictures" : mime.startsWith("video/") ? "Movies" : "Download";
            Uri uri;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = getContext().getContentResolver();
                Uri table = mime.startsWith("image/") ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                        : mime.startsWith("video/") ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                        : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/Hamsa");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                uri = cr.insert(table, v);
                if (uri == null) { call.reject("insert"); return; }
                try (OutputStream os = cr.openOutputStream(uri)) {
                    os.write(bytes);
                }
                v.clear();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(uri, v, null, null);
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(folder), "Hamsa");
                if (!dir.exists() && !dir.mkdirs()) { call.reject("mkdir"); return; }
                File f = new File(dir, name);
                try (FileOutputStream os = new FileOutputStream(f)) {
                    os.write(bytes);
                }
                uri = Uri.fromFile(f);
            }
            JSObject r = new JSObject();
            r.put("uri", uri.toString());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }
}

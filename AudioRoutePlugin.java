package com.hamsa.messenger;

import android.content.Context;
import android.media.AudioManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Switches a call between the phone's earpiece and its loudspeaker. */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    private AudioManager audio() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        try {
            boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
            AudioManager am = audio();
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.setSpeakerphoneOn(on);
            call.resolve();
        } catch (Exception e) {
            call.reject("audio route failed");
        }
    }

    @PluginMethod
    public void reset(PluginCall call) {
        try {
            AudioManager am = audio();
            am.setSpeakerphoneOn(false);
            am.setMode(AudioManager.MODE_NORMAL);
            call.resolve();
        } catch (Exception e) {
            call.reject("audio reset failed");
        }
    }
}

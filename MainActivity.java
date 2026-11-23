package com.hamsa.messenger;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioRoutePlugin.class);
        registerPlugin(SaveMediaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

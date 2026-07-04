'use strict';

// MV3 event page: register all WebExtension event listeners synchronously
// at the top level so Firefox can wake this script when events fire.
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts

browser.alarms.onAlarm.addListener((alarmInfo) => {
    alarmListener(alarmInfo).catch(onError);
});

browser.windows.onFocusChanged.addListener((windowId) => {
    onWindowFocusChanged(windowId).catch(onError);
});

browser.runtime.onInstalled.addListener(({reason, previousVersion}) => {
    debugLog("0 - Installed - Reason: " + reason + ", Previous Version: " + previousVersion + ".");

    init().catch(onError);

    if (reason === 'install') {
        debugLog("0 - Open the options page.");
        browser.runtime.openOptionsPage();
    }
});

// Firefox does not persist alarms across browser sessions, so init()
// must run on every browser start to reschedule them and apply the
// correct theme.
browser.runtime.onStartup.addListener(() => {
    init().catch(onError);
});

// Not a waking event; re-registered on every event page load so
// system-theme mode reacts immediately while the page is alive.
registerSystemThemeMediaListener();

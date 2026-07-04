'use strict';

const SYSTEM_THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';

// Both flags are scoped to one background/options page lifetime.
// The block flag only matters while a theme switch is in flight in the
// same context, and the media listener is re-registered every time the
// MV3 event page wakes up, so neither needs to be persisted.
let detectSchemeChangeBlock = false;
let systemThemeMediaListenerAttached = false;

function setSchemeChangeDetectionBlock(shouldBlock) {
    detectSchemeChangeBlock = shouldBlock;
}

function isSchemeChangeDetectionBlocked() {
    return detectSchemeChangeBlock;
}

async function setContentColorSchemeToAuto() {
    if (!browser.browserSettings || !browser.browserSettings.overrideContentColorScheme) {
        return;
    }

    await browser.browserSettings.overrideContentColorScheme.set({value: "auto"});
    debugLog("Set overrideContentColorScheme to auto.");
}

async function setCurrentThemeSystemColorScheme() {
    const currentTheme = await browser.theme.getCurrent();
    if (!currentTheme.colors) {
        return;
    }

    if (!currentTheme.properties) {
        currentTheme.properties = {};
    }

    currentTheme.properties.color_scheme = "system";
    currentTheme.properties.content_color_scheme = "system";

    await browser.theme.update(currentTheme);
}

async function clearDynamicThemeOverride() {
    await browser.theme.reset();
    debugLog("Cleared dynamic theme override.");
}

async function onWindowFocusChanged(windowId) {
    if (windowId === browser.windows.WINDOW_ID_NONE) {
        return;
    }

    debugLog("10 - Window was focused. Attempt theme change.");

    const obj = await browser.storage.local.get([CHANGE_MODE_KEY, CHECK_TIME_STARTUP_ONLY_KEY]);
    if (obj[CHECK_TIME_STARTUP_ONLY_KEY] && obj[CHECK_TIME_STARTUP_ONLY_KEY].check) {
        return;
    }

    const mode = obj[CHANGE_MODE_KEY] && obj[CHANGE_MODE_KEY].mode;
    await changeThemeBasedOnChangeMode(mode);

    // Reset the suntime alarms so they are not delayed
    // after OS sleep/hibernation.
    if (mode === "location-suntimes" || mode === "manual-suntimes") {
        await Promise.all([
            browser.alarms.clear(NEXT_SUNRISE_ALARM_NAME),
            browser.alarms.clear(NEXT_SUNSET_ALARM_NAME)
        ]);
        await Promise.all([
            createAlarm(SUNRISE_TIME_KEY, NEXT_SUNRISE_ALARM_NAME, 60 * 24),
            createAlarm(SUNSET_TIME_KEY, NEXT_SUNSET_ALARM_NAME, 60 * 24)
        ]);
    }
}

async function checkSysTheme() {
    debugLog("Start checkSysTheme");

    const values = await browser.storage.local.get([CHANGE_MODE_KEY, DAYTIME_THEME_KEY, NIGHTTIME_THEME_KEY]);
    if (!values[CHANGE_MODE_KEY] || values[CHANGE_MODE_KEY].mode !== "system-theme") {
        return;
    }

    const prefersDarkInterface = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY).matches;
    const targetMode = prefersDarkInterface ? "night-mode" : "day-mode";
    const targetThemeKey = prefersDarkInterface ? NIGHTTIME_THEME_KEY : DAYTIME_THEME_KEY;

    debugLog("90 checkSysTheme - Detected OS scheme: " + targetMode);

    await Promise.all([
        browser.storage.local.set({[CURRENT_MODE_KEY]: {mode: targetMode}}),
        enableTheme(values, targetThemeKey)
    ]);
}

// Best-effort detection while the page is alive: a media query listener
// is not a WebExtension event and cannot wake a suspended event page.
// Window focus changes and alarms remain the guaranteed wake-up paths.
function registerSystemThemeMediaListener() {
    if (systemThemeMediaListenerAttached) {
        return;
    }

    const mediaQuery = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY);
    const handleMediaChange = () => {
        if (isSchemeChangeDetectionBlocked()) {
            debugLog("prefers-color-scheme changed, but scheme change detection is currently disabled.");
            return;
        }

        debugLog("10 - prefers-color-scheme changed.");

        browser.storage.local.get(CHECK_TIME_STARTUP_ONLY_KEY)
            .then((obj) => {
                if (obj[CHECK_TIME_STARTUP_ONLY_KEY] && obj[CHECK_TIME_STARTUP_ONLY_KEY].check) {
                    return;
                }
                return checkSysTheme();
            })
            .catch(onError);
    };

    mediaQuery.addEventListener("change", handleMediaChange);
    systemThemeMediaListenerAttached = true;
}

async function enableSchemeChangeDetection() {
    debugLog("Start enableSchemeChangeDetection");

    try {
        const obj = await browser.storage.local.get(CHANGE_MODE_KEY);
        const mode = obj[CHANGE_MODE_KEY] && obj[CHANGE_MODE_KEY].mode;

        if (mode === "system-theme") {
            await setContentColorSchemeToAuto();
            await setCurrentThemeSystemColorScheme();
        }
        else {
            await clearDynamicThemeOverride();
        }
    } finally {
        setSchemeChangeDetectionBlock(false);
    }
}

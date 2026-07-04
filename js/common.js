'use strict';

const KEY_PREFIX = 'autodark';

const DEBUG_MODE_KEY = KEY_PREFIX + "debugMode";

const CURRENT_MODE_KEY = KEY_PREFIX + "currentMode"; // day-mode, night-mode

const CHANGE_MODE_KEY = KEY_PREFIX + "changeMode"; // location-suntimes, manual-suntimes, system-theme
const CHECK_TIME_STARTUP_ONLY_KEY = KEY_PREFIX + "checkTimeStartupOnly";
const DAYTIME_THEME_KEY = KEY_PREFIX + "daytimeTheme";
const NIGHTTIME_THEME_KEY = KEY_PREFIX + "nighttimeTheme";
const SUNRISE_TIME_KEY = KEY_PREFIX + "sunriseTime";
const SUNSET_TIME_KEY = KEY_PREFIX + "sunsetTime";
const NEXT_SUNRISE_ALARM_NAME = KEY_PREFIX + "nextSunrise";
const NEXT_SUNSET_ALARM_NAME = KEY_PREFIX + "nextSunset";

const GEOLOCATION_LATITUDE_KEY = KEY_PREFIX + "geoLatitude";
const GEOLOCATION_LONGITUDE_KEY = KEY_PREFIX + "geoLongitude";

const DEFAULT_CHANGE_MODE = "manual-suntimes";
const DEFAULT_CHECK_TIME_STARTUP_ONLY = false;
const DEFAULT_SUNRISE_TIME = "08:00";
const DEFAULT_SUNSET_TIME = "20:00";

const DEFAULT_DEBUG_MODE = false;

// Default themes are set after looking through the user's
// current theme and their installed themes. They are recomputed
// on demand (via setDefaultThemes) before every read, so they do
// not need to survive event page suspension.
let DEFAULT_DAYTIME_THEME = "";
let DEFAULT_NIGHTTIME_THEME = "";

let DEBUG_MODE = false;

// Load the persisted debug flag. The key does not exist yet on a
// fresh install (before init() writes defaults), so guard the read.
browser.storage.local.get(DEBUG_MODE_KEY)
    .then((obj) => {
        DEBUG_MODE = Boolean(obj[DEBUG_MODE_KEY] && obj[DEBUG_MODE_KEY].check);
        debugLog("DEBUG_MODE is enabled.");
    })
    .catch(onError);

async function refreshLocationSuntimesAndAlarms() {
    const result = await calculateSuntimes();
    await browser.storage.local.set({
        [SUNRISE_TIME_KEY]: {time: convertDateToString(result.nextSunrise)},
        [SUNSET_TIME_KEY]: {time: convertDateToString(result.nextSunset)}
    });
    await Promise.all([
        createAlarm(SUNRISE_TIME_KEY, NEXT_SUNRISE_ALARM_NAME, 60 * 24),
        createAlarm(SUNSET_TIME_KEY, NEXT_SUNSET_ALARM_NAME, 60 * 24)
    ]);
}

// Things to do when the extension is starting up
// (or if the settings have been reset).
// Event listener registration lives in background.js: MV3 event pages
// require listeners to be registered synchronously at the top level.
async function init() {
    debugLog("0 - Starting up automaticDark");

    // Set values if they each have never been set before,
    // such as on first-time startup.
    await setStorage({
        [CHANGE_MODE_KEY]: {mode: DEFAULT_CHANGE_MODE},
        [CHECK_TIME_STARTUP_ONLY_KEY]: {check: DEFAULT_CHECK_TIME_STARTUP_ONLY},
        [DEBUG_MODE_KEY]: {check: DEFAULT_DEBUG_MODE},
        [SUNRISE_TIME_KEY]: {time: DEFAULT_SUNRISE_TIME},
        [SUNSET_TIME_KEY]: {time: DEFAULT_SUNSET_TIME}
    });

    // Check the user's themes and set the default daytime and
    // nighttime themes based on this.
    await setDefaultThemes();
    await setStorage({
        [DAYTIME_THEME_KEY]: {themeId: DEFAULT_DAYTIME_THEME},
        [NIGHTTIME_THEME_KEY]: {themeId: DEFAULT_NIGHTTIME_THEME}
    });

    const obj = await browser.storage.local.get([CHECK_TIME_STARTUP_ONLY_KEY, CHANGE_MODE_KEY]);

    // If the flag is not set to check only on startup,
    // apply the theme now and create alarms for future changes.
    if (!obj[CHECK_TIME_STARTUP_ONLY_KEY].check) {
        const mode = obj[CHANGE_MODE_KEY].mode;
        await changeThemeBasedOnChangeMode(mode);

        if (mode === "system-theme") {
            await setContentColorSchemeToAuto();
        }
        else if (mode === "location-suntimes") {
            // If we are set to get suntimes automatically,
            // then calculate the suntimes again.
            await refreshLocationSuntimesAndAlarms();
        }
        else { // manual-suntimes
            await Promise.all([
                createAlarm(SUNRISE_TIME_KEY, NEXT_SUNRISE_ALARM_NAME, 60 * 24),
                createAlarm(SUNSET_TIME_KEY, NEXT_SUNSET_ALARM_NAME, 60 * 24)
            ]);
        }
    }

    await enableSchemeChangeDetection();
}

// Changes the current theme.
// Takes a parameter indicating how to decide what theme to change to.
async function changeThemeBasedOnChangeMode(mode) {
    debugLog("Start changeThemeBasedOnChangeMode");

    let resolvedMode = mode;
    if (!resolvedMode) {
        const obj = await browser.storage.local.get(CHANGE_MODE_KEY);
        resolvedMode = obj[CHANGE_MODE_KEY] && obj[CHANGE_MODE_KEY].mode;
    }
    if (!resolvedMode) {
        resolvedMode = DEFAULT_CHANGE_MODE;
    }

    debugLog("50 changeThemeBasedOnChangeMode - Mode is set to: " + resolvedMode);

    if (resolvedMode === "system-theme") {
        return checkSysTheme();
    }
    if (resolvedMode === "location-suntimes" || resolvedMode === "manual-suntimes") {
        return checkTime();
    }
}

// Creates an alarm based on a key used to get
// a String in the 24h format "HH:MM" and an alarm name.
async function createAlarm(timeKey, alarmName, periodInMinutes = null) {
    debugLog("Start createAlarm");

    const obj = await browser.storage.local.get(timeKey);
    const timeValue = obj[timeKey] && obj[timeKey].time;
    if (!isValidTimeString(timeValue)) {
        throw new Error("Cannot create alarm '" + alarmName + "': invalid time value '" + timeValue + "'.");
    }

    const timeSplit = timeValue.split(":");
    return browser.alarms.create(alarmName, {
        when: convertToNextMilliEpoch(timeSplit[0], timeSplit[1]),
        periodInMinutes
    });
}

// Depending on the alarm name passed, this listener will:
// - Get the stored daytime/nighttime theme and try to enable it.
// - In location mode, recalculate the suntimes and reset the alarms first.
async function alarmListener(alarmInfo) {
    debugLog("Start alarmListener");

    let themeKey;
    if (alarmInfo.name === NEXT_SUNRISE_ALARM_NAME) {
        themeKey = DAYTIME_THEME_KEY;
    }
    else if (alarmInfo.name === NEXT_SUNSET_ALARM_NAME) {
        themeKey = NIGHTTIME_THEME_KEY;
    }
    else {
        return;
    }

    const values = await browser.storage.local.get([CHANGE_MODE_KEY, themeKey]);
    if (values[CHANGE_MODE_KEY] && values[CHANGE_MODE_KEY].mode === "location-suntimes") {
        await refreshLocationSuntimesAndAlarms();
    }
    await enableTheme(values, themeKey);
}

// Check the current system time and set the theme based on the time.
// Will set the daytime theme between sunrise and sunset.
// Otherwise, set nighttime theme.
async function checkTime(hasRepairedDefaults = false) {
    const date = new Date(Date.now());
    const hours = date.getHours();
    const minutes = date.getMinutes();

    debugLog("Start checkTime");
    debugLog("It is currently: " + hours + ":" + minutes + ". Conducting time check now...");

    const obj = await browser.storage.local.get([SUNRISE_TIME_KEY, SUNSET_TIME_KEY]);
    const sunriseValue = obj[SUNRISE_TIME_KEY] && obj[SUNRISE_TIME_KEY].time;
    const sunsetValue = obj[SUNSET_TIME_KEY] && obj[SUNSET_TIME_KEY].time;

    if (!isValidTimeString(sunriseValue) || !isValidTimeString(sunsetValue)) {
        if (hasRepairedDefaults) {
            throw new Error("checkTime: sunrise/sunset values are still invalid after reapplying defaults.");
        }

        debugLog("checkTime - Missing or invalid sunrise/sunset values. Reapplying defaults.");

        const repairs = {};
        if (!isValidTimeString(sunriseValue)) {
            repairs[SUNRISE_TIME_KEY] = {time: DEFAULT_SUNRISE_TIME};
        }
        if (!isValidTimeString(sunsetValue)) {
            repairs[SUNSET_TIME_KEY] = {time: DEFAULT_SUNSET_TIME};
        }
        await browser.storage.local.set(repairs);
        return checkTime(true);
    }

    const sunriseSplit = sunriseValue.split(":");
    const sunsetSplit = sunsetValue.split(":");

    const isDaytime = timeInBetween(
        hours, minutes,
        sunriseSplit[0], sunriseSplit[1],
        sunsetSplit[0], sunsetSplit[1]);

    const themeKey = isDaytime ? DAYTIME_THEME_KEY : NIGHTTIME_THEME_KEY;
    const theme = await browser.storage.local.get(themeKey);
    await enableTheme(theme, themeKey);
    await browser.storage.local.set({
        [CURRENT_MODE_KEY]: {mode: isDaytime ? "day-mode" : "night-mode"}
    });
}

function getFallbackThemeId(themeKey) {
    if (themeKey === NIGHTTIME_THEME_KEY) {
        return DEFAULT_NIGHTTIME_THEME;
    }

    return DEFAULT_DAYTIME_THEME;
}

async function resolveThemeRecord(theme, themeKey) {
    const themeRecord = theme && theme[themeKey];
    if (!isEmpty(themeRecord) && themeRecord.themeId) {
        return themeRecord;
    }

    debugLog("Missing theme record for key: " + themeKey + ". Using fallback.");

    await setDefaultThemes();
    const fallbackThemeId = getFallbackThemeId(themeKey);
    if (!fallbackThemeId) {
        throw new Error("No fallback theme available for key: " + themeKey);
    }

    await browser.storage.local.set({[themeKey]: {themeId: fallbackThemeId}});
    return {themeId: fallbackThemeId};
}

// Parse the object given and enable the theme
// if it is not already enabled.
// Falls back to a default theme (once) if the stored theme
// is missing or no longer installed.
async function enableTheme(theme, themeKey, hasRetriedFallback = false) {
    debugLog("Start enableTheme");

    const themeRecord = await resolveThemeRecord(theme, themeKey);

    let extInfo;
    try {
        extInfo = await browser.management.get(themeRecord.themeId);
    } catch (error) {
        if (hasRetriedFallback) {
            throw error;
        }

        debugLog("Theme not available: " + themeRecord.themeId + ". Retrying with fallback.");

        await setDefaultThemes();
        const fallbackThemeId = getFallbackThemeId(themeKey);
        if (!fallbackThemeId || fallbackThemeId === themeRecord.themeId) {
            throw error;
        }

        await browser.storage.local.set({[themeKey]: {themeId: fallbackThemeId}});
        return enableTheme({[themeKey]: {themeId: fallbackThemeId}}, themeKey, true);
    }

    if (extInfo.enabled) {
        debugLog("100 enableTheme - " + themeRecord.themeId + " is already enabled.");
        return;
    }

    debugLog("100 enableTheme - Enabling theme " + themeRecord.themeId);

    // Block prefers-color-scheme change detection while switching so the
    // switch itself does not re-trigger a theme change (infinite loop).
    setSchemeChangeDetectionBlock(true);
    try {
        await browser.management.setEnabled(themeRecord.themeId, true);
    } catch (error) {
        setSchemeChangeDetectionBlock(false);
        throw error;
    }
    await enableSchemeChangeDetection();
}

// Set the currently enabled theme
// as the default daytime/nighttime theme.
//
// Set default nighttime theme to Firefox's
// default if it is available.
async function setDefaultThemes() {
    debugLog("Start setDefaultThemes");

    DEFAULT_DAYTIME_THEME = "";
    DEFAULT_NIGHTTIME_THEME = "";

    const extensions = await browser.management.getAll();
    for (const extension of extensions) {
        if (extension.type !== 'theme') {
            continue;
        }
        if (extension.enabled) {
            DEFAULT_DAYTIME_THEME = extension.id;
            DEFAULT_NIGHTTIME_THEME = extension.id;
        }
        // If the theme is Firefox's default dark theme,
        // set the default nighttime theme to it.
        if (extension.id === "firefox-compact-dark@mozilla.org") {
            DEFAULT_NIGHTTIME_THEME = extension.id;
        }
    }
}

// Prompt user to give location. Then store it.
function setGeolocation() {
    debugLog("Start setGeolocation");

    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error("Geolocation is not supported by your browser."));
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                // Override any previously stored coordinates so a user
                // who has moved gets fresh suntimes.
                setStorage({
                    [GEOLOCATION_LATITUDE_KEY]: {latitude: position.coords.latitude},
                    [GEOLOCATION_LONGITUDE_KEY]: {longitude: position.coords.longitude}
                }, true).then(resolve, reject);
            },
            (positionError) => {
                reject(new Error("Unable to fetch current location: " +
                    (positionError && positionError.message ? positionError.message : "permission denied.")));
            }
        );
    });
}

// Calculate the next sunrise/sunset times
// based on today's date, tomorrow's date, and geolocation in storage.
async function calculateSuntimes() {
    debugLog("Start calculateSuntimes");

    const position = await browser.storage.local.get([GEOLOCATION_LATITUDE_KEY, GEOLOCATION_LONGITUDE_KEY]);
    const latitudeRecord = position[GEOLOCATION_LATITUDE_KEY];
    const longitudeRecord = position[GEOLOCATION_LONGITUDE_KEY];

    if (!latitudeRecord || typeof latitudeRecord.latitude !== "number" ||
            !longitudeRecord || typeof longitudeRecord.longitude !== "number") {
        throw new Error("calculateSuntimes: no stored geolocation. " +
            "Re-select automatic sunrise/sunset times in the options page.");
    }

    // Prepare today and tomorrow's date for calculations.
    const today = new Date(Date.now());
    const tomorrow = new Date(Date.now());
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Do the calculations using SunCalc.
    // Figure out today and tomorrow's sunrise/sunset times.
    const results = [today, tomorrow].map((date) =>
        SunCalc.getTimes(date, latitudeRecord.latitude, longitudeRecord.longitude)
    );

    const now = new Date(Date.now());
    let nextSunrise = new Date(results[0].sunrise);
    let nextSunset = new Date(results[0].sunset);
    nextSunrise.setDate(nextSunrise.getDate() + 10);
    nextSunset.setDate(nextSunset.getDate() + 10);

    // Figure out whether today or tomorrow's sunrise/sunset time should be used.
    results.forEach((result) => {
        if (now < result.sunrise && result.sunrise < nextSunrise) {
            nextSunrise = result.sunrise;
        }
        if (now < result.sunset && result.sunset < nextSunset) {
            nextSunset = result.sunset;
        }
    });

    return {nextSunrise, nextSunset};
}

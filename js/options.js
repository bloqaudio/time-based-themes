'use strict';

const locationWarning = document.getElementById("location-permission-warning");
const startupOnlyMessage = document.getElementById("startup-only-message");
const resetMessage = document.getElementById("reset-message");

const automaticSuntimesRadio = document.getElementById("automatic-suntimes-radio");
const manualSuntimesRadio = document.getElementById("manual-suntimes-radio");
const sysThemeRadio = document.getElementById("system-theme-radio");

const checkStartupBox = document.getElementById("check-startup-only");
const sunriseInput = document.getElementById("sunrise-time");
const sunsetInput = document.getElementById("sunset-time");

const daytimeThemeList = document.getElementById("daytime-theme-list");
const nighttimeThemeList = document.getElementById("nighttime-theme-list");
const resetDefaultBtn = document.getElementById("reset-default-btn");

const debugModeBox = document.getElementById("debug-mode");

// Show the version from the manifest so it cannot drift from manifest.json.
document.getElementById("version-text").textContent = browser.runtime.getManifest().version;

// Log everything stored (geolocation redacted) when debug mode is enabled.
browser.storage.local.get(null)
    .then((results) => {
        if (!DEBUG_MODE) {
            return;
        }
        const redacted = Object.assign({}, results);
        for (const key of [GEOLOCATION_LATITUDE_KEY, GEOLOCATION_LONGITUDE_KEY]) {
            if (key in redacted) {
                redacted[key] = "(redacted)";
            }
        }
        console.log("automaticDark DEBUG: Options page opened. All stored data (geolocation redacted):");
        console.log(redacted);
    })
    .catch(onError);

changeLogo();
getChangeMode();

browser.storage.onChanged.addListener((changes, area) => {
    // If the extension's current mode changes (eg. from daytime to
    // nighttime), then adjust the logo accordingly.
    if (CURRENT_MODE_KEY in changes) {
        debugLog("Browser storage changed. Change logo on Options page.");
        changeLogo();
    }
});

// Iterate through each installed theme to populate the dropdowns.
browser.management.getAll()
    .then((extensions) => {
        for (const extension of extensions) {
            if (extension.type !== 'theme') {
                continue;
            }

            const extOption = document.createElement('option');
            extOption.textContent = extension.name;
            extOption.value = extension.id;

            daytimeThemeList.appendChild(extOption);
            nighttimeThemeList.appendChild(extOption.cloneNode(true));
        }

        return Promise.all([
            applyStoredThemeSelection(DAYTIME_THEME_KEY, daytimeThemeList),
            applyStoredThemeSelection(NIGHTTIME_THEME_KEY, nighttimeThemeList)
        ]);
    })
    .catch(onError);

// Set a theme dropdown to the value stored under the given key.
function applyStoredThemeSelection(themeKey, dropdown) {
    return browser.storage.local.get(themeKey)
        .then((obj) => {
            const record = obj[themeKey];
            if (!isEmpty(record) && record.themeId) {
                dropdown.value = record.themeId;
            }
        });
}

// Change the logo on the options page based on the current mode.
async function changeLogo() {
    debugLog("Start changeLogo");

    try {
        const obj = await browser.storage.local.get(CURRENT_MODE_KEY);
        const currentMode = (obj[CURRENT_MODE_KEY] && obj[CURRENT_MODE_KEY].mode) || "off-mode";

        debugLog("Changing logo to: " + currentMode);

        document.querySelector(".logo.day-mode").style.display =
            currentMode === "day-mode" ? "inline-block" : "none";
        document.querySelector(".logo.night-mode").style.display =
            currentMode === "night-mode" ? "inline-block" : "none";
        document.querySelector(".logo.off-mode").style.display =
            currentMode !== "day-mode" && currentMode !== "night-mode" ? "inline-block" : "none";
    } catch (error) {
        onError(error);
    }
}

// Set the settings on the page based on what mode is set in storage.
async function getChangeMode() {
    debugLog("Start getChangeMode");

    try {
        const obj = await browser.storage.local.get(CHANGE_MODE_KEY);
        const mode = (obj[CHANGE_MODE_KEY] && obj[CHANGE_MODE_KEY].mode) || DEFAULT_CHANGE_MODE;

        automaticSuntimesRadio.checked = mode === "location-suntimes";
        manualSuntimesRadio.checked = mode === "manual-suntimes";
        sysThemeRadio.checked = mode === "system-theme";
        sunriseInput.disabled = mode !== "manual-suntimes";
        sunsetInput.disabled = mode !== "manual-suntimes";
    } catch (error) {
        onError(error);
    }
}

browser.storage.local.get(CHECK_TIME_STARTUP_ONLY_KEY)
    .then((obj) => {
        checkStartupBox.checked = Boolean(obj[CHECK_TIME_STARTUP_ONLY_KEY] && obj[CHECK_TIME_STARTUP_ONLY_KEY].check);
    })
    .catch(onError);

browser.storage.local.get(DEBUG_MODE_KEY)
    .then((obj) => {
        const debugEnabled = Boolean(obj[DEBUG_MODE_KEY] && obj[DEBUG_MODE_KEY].check);
        debugModeBox.checked = debugEnabled;
        DEBUG_MODE = debugEnabled;
    })
    .catch(onError);

browser.storage.local.get([SUNRISE_TIME_KEY, SUNSET_TIME_KEY])
    .then((obj) => {
        sunriseInput.value = (obj[SUNRISE_TIME_KEY] && obj[SUNRISE_TIME_KEY].time) || DEFAULT_SUNRISE_TIME;
        sunsetInput.value = (obj[SUNSET_TIME_KEY] && obj[SUNSET_TIME_KEY].time) || DEFAULT_SUNSET_TIME;
    })
    .catch(onError);

automaticSuntimesRadio.addEventListener("input", async function() {
    if (!automaticSuntimesRadio.checked) {
        return;
    }

    let suntimes;
    try {
        // Prompt for and store the user's geolocation, then calculate
        // sunrise/sunset times based on it.
        await setGeolocation();
        suntimes = await calculateSuntimes();
    } catch (error) {
        onError(error);
        locationWarning.style.display = "inline";
        // On error, change the radio buttons (and settings) back to the
        // way they were, based on storage.
        getChangeMode();
        changeThemeBasedOnChangeMode().catch(onError);
        return;
    }

    try {
        locationWarning.style.display = "none";
        changeLogo();

        await browser.storage.local.set({[CHANGE_MODE_KEY]: {mode: "location-suntimes"}});
        await enableSchemeChangeDetection();

        sunriseInput.disabled = true;
        sunsetInput.disabled = true;

        // Setting the inputs and dispatching "input" reuses the time-input
        // handlers to persist the times, run a time check and set alarms.
        sunriseInput.value = convertDateToString(suntimes.nextSunrise);
        sunsetInput.value = convertDateToString(suntimes.nextSunset);
        sunriseInput.dispatchEvent(new Event("input"));
        sunsetInput.dispatchEvent(new Event("input"));
    } catch (error) {
        onError(error);
    }
});

manualSuntimesRadio.addEventListener("input", async function() {
    if (!manualSuntimesRadio.checked) {
        return;
    }

    sunriseInput.disabled = false;
    sunsetInput.disabled = false;

    try {
        await browser.storage.local.set({[CHANGE_MODE_KEY]: {mode: "manual-suntimes"}});
        await changeThemeBasedOnChangeMode("manual-suntimes");
        await enableSchemeChangeDetection();
        changeLogo();
    } catch (error) {
        onError(error);
    }
});

sysThemeRadio.addEventListener("input", async function() {
    if (!sysThemeRadio.checked) {
        return;
    }

    sunriseInput.disabled = true;
    sunsetInput.disabled = true;

    try {
        await setContentColorSchemeToAuto();
        await browser.storage.local.set({[CHANGE_MODE_KEY]: {mode: "system-theme"}});
        await changeThemeBasedOnChangeMode("system-theme");
        await enableSchemeChangeDetection();
        changeLogo();
    } catch (error) {
        onError(error);
    }
});

// Enable/disable the check on startup-only flag.
checkStartupBox.addEventListener("input", async function() {
    try {
        await browser.storage.local.set({[CHECK_TIME_STARTUP_ONLY_KEY]: {check: checkStartupBox.checked}});

        if (checkStartupBox.checked) {
            await Promise.all([
                browser.alarms.clear(NEXT_SUNRISE_ALARM_NAME),
                browser.alarms.clear(NEXT_SUNSET_ALARM_NAME)
            ]);
            await logAllAlarms();
            startupOnlyMessage.style.display = "inline";
        }
        else {
            await Promise.all([
                createAlarm(SUNRISE_TIME_KEY, NEXT_SUNRISE_ALARM_NAME, 60 * 24),
                createAlarm(SUNSET_TIME_KEY, NEXT_SUNSET_ALARM_NAME, 60 * 24)
            ]);
            startupOnlyMessage.style.display = "none";
        }
    } catch (error) {
        onError(error);
    }
});

// Enable/disable the check on debug mode flag.
debugModeBox.addEventListener("input", function() {
    DEBUG_MODE = debugModeBox.checked;
    browser.storage.local.set({[DEBUG_MODE_KEY]: {check: debugModeBox.checked}})
        .then(() => {
            console.log("automaticDark DEBUG_MODE has been set to: " + DEBUG_MODE);
        })
        .catch(onError);
});

// Persist a changed sunrise/sunset time, re-check the current theme,
// and reset the matching alarm if the 'check startup only' flag is off.
// Ignores transient invalid values (e.g. a cleared time input).
async function handleSuntimeInputChange(timeKey, alarmName, value) {
    if (!isValidTimeString(value)) {
        debugLog("Ignoring invalid time value: '" + value + "'");
        return;
    }

    try {
        await browser.storage.local.set({[timeKey]: {time: value}});
        await checkTime();
        changeLogo();

        const obj = await browser.storage.local.get(CHECK_TIME_STARTUP_ONLY_KEY);
        if (!(obj[CHECK_TIME_STARTUP_ONLY_KEY] && obj[CHECK_TIME_STARTUP_ONLY_KEY].check)) {
            await createAlarm(timeKey, alarmName, 60 * 24);
        }
    } catch (error) {
        onError(error);
    }
}

sunriseInput.addEventListener("input", function() {
    handleSuntimeInputChange(SUNRISE_TIME_KEY, NEXT_SUNRISE_ALARM_NAME, sunriseInput.value);
});

sunsetInput.addEventListener("input", function() {
    handleSuntimeInputChange(SUNSET_TIME_KEY, NEXT_SUNSET_ALARM_NAME, sunsetInput.value);
});

// Persist a changed daytime/nighttime theme selection and
// check if the current theme should be changed.
async function handleThemeSelectionChange(themeKey, themeId) {
    try {
        await browser.storage.local.set({[themeKey]: {themeId}});
        const obj = await browser.storage.local.get(CHANGE_MODE_KEY);
        await changeThemeBasedOnChangeMode(obj[CHANGE_MODE_KEY] && obj[CHANGE_MODE_KEY].mode);
    } catch (error) {
        onError(error);
    }
}

daytimeThemeList.addEventListener('change', function() {
    handleThemeSelectionChange(DAYTIME_THEME_KEY, this.value);
});

nighttimeThemeList.addEventListener('change', function() {
    handleThemeSelectionChange(NIGHTTIME_THEME_KEY, this.value);
});

// Reset all settings to their default.
// Note that the "default" themes may change
// depending on the user's current theme and their
// installed themes.
resetDefaultBtn.addEventListener("click", async function() {
    if (!window.confirm("Are you sure you want to reset to default settings?")) {
        return;
    }

    try {
        await Promise.all([
            browser.storage.local.clear(),
            browser.alarms.clearAll()
        ]);

        automaticSuntimesRadio.checked = false;
        manualSuntimesRadio.checked = true;
        sysThemeRadio.checked = false;
        sunriseInput.disabled = false;
        sunsetInput.disabled = false;

        checkStartupBox.checked = DEFAULT_CHECK_TIME_STARTUP_ONLY;
        debugModeBox.checked = DEFAULT_DEBUG_MODE;
        sunriseInput.value = DEFAULT_SUNRISE_TIME;
        sunsetInput.value = DEFAULT_SUNSET_TIME;

        await setDefaultThemes();
        daytimeThemeList.value = DEFAULT_DAYTIME_THEME;
        nighttimeThemeList.value = DEFAULT_NIGHTTIME_THEME;
        resetMessage.style.display = "inline";

        await init();
        changeLogo();
    } catch (error) {
        onError(error);
    }
});

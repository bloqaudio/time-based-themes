'use strict';

// Matches a 24h "HH:MM" time string (the format produced by
// <input type="time"> and stored for sunrise/sunset).
const TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

// Helper: Log a debug message when debug mode is enabled.
// DEBUG_MODE is defined in common.js, which loads after this file
// but before any of these functions run.
function debugLog(message) {
    if (DEBUG_MODE)
        console.log("automaticDark DEBUG: " + message);
}

// Helper: Print the error.
function onError(error) {
    console.error("automaticDark Error: " + (error && error.message ? error.message : error));
}

// Helper: Check that a value is a valid "HH:MM" time string.
function isValidTimeString(time) {
    return typeof time === "string" && TIME_PATTERN.test(time);
}

// Helper: Figure out if a time is in-between two times.
// Return true if it is daytime.
// Return false if it is nighttime.
function timeInBetween(
        curHours, curMins,
        sunriseHours, sunriseMins,
        sunsetHours, sunsetMins
    ) {
    debugLog("Start timeInBetween");

    const curTimeInMins = parseInt(curHours, 10) * 60 + parseInt(curMins, 10);
    const sunriseInMins = parseInt(sunriseHours, 10) * 60 + parseInt(sunriseMins, 10);
    const sunsetInMins = parseInt(sunsetHours, 10) * 60 + parseInt(sunsetMins, 10);

    let isDaytime;
    if (sunsetInMins - sunriseInMins < 0) {
        // The "sunrise" is on the previous day, so the daytime
        // window wraps around midnight.
        isDaytime = sunriseInMins <= curTimeInMins || curTimeInMins < sunsetInMins;
    }
    else {
        isDaytime = sunriseInMins <= curTimeInMins && curTimeInMins < sunsetInMins;
    }

    debugLog("It is currently " + (isDaytime ? "daytime" : "nighttime"));
    return isDaytime;
}

function addLeadZero(num) {
    if (num < 10) {
        return "0" + num;
    }
    return num;
}

// Helper:
// Set storage only if overrideDefault is true or
// the stored value is empty/invalid.
function setStorage(obj, overrideDefault = false) {
    debugLog("Start setStorage");

    const keys = Object.keys(obj);
    if (keys.length === 0) {
        return Promise.resolve({});
    }

    return browser.storage.local.get(keys)
        .then((storedItems) => {
            const updates = {};

            for (const key of keys) {
                const existingValue = storedItems[key];
                const isInvalidShape = existingValue !== undefined && existingValue !== null && typeof existingValue !== "object";
                if (overrideDefault || isEmpty(existingValue) || isInvalidShape) {
                    updates[key] = obj[key];
                }
            }

            if (isEmpty(updates)) {
                return storedItems;
            }

            return browser.storage.local.set(updates)
                .then(() => {
                    return browser.storage.local.get(keys);
                });
        });
}

// Helper: Log all active alarms.
function logAllAlarms() {
    return browser.alarms.getAll()
        .then((alarms) => {
            if (DEBUG_MODE) {
                console.log("automaticDark DEBUG: All active alarms: ");
                console.log(alarms);
            }
        });
}

// Helper: Check if the object is empty.
function isEmpty(obj) {
    if (obj === null || obj === undefined) {
        return true;
    }

    if (typeof obj !== "object") {
        return false;
    }

    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key))
            return false;
    }
    return true;
}

// Take in the time as hours and minutes and
// return the next time it will occur as
// milliseconds since the epoch.
function convertToNextMilliEpoch(hours, minutes) {
    const returnDate = new Date(Date.now());
    returnDate.setHours(parseInt(hours, 10));
    returnDate.setMinutes(parseInt(minutes, 10));
    returnDate.setSeconds(0);
    returnDate.setMilliseconds(0);

    // If the specified time has already occurred,
    // the next time it will occur will be the next day.
    if (returnDate < Date.now()) {
        returnDate.setDate(returnDate.getDate() + 1);
    }
    return returnDate.getTime();
}

// Helper:
// Convert the time from a Date object to a string in the format of HH:MM.
function convertDateToString(date) {
    return addLeadZero(date.getHours()) + ":" + addLeadZero(date.getMinutes());
}

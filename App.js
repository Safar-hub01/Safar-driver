import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import * as TaskManager from 'expo-task-manager';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

const DRIVER_SESSION_KEY = 'safar-driver-session';
const TRACKING_STATUS_KEY = 'safar-tracking-status';
const LOCATION_TASK_NAME = 'safar-driver-background-location';
const LAST_TELEMETRY_KEY = 'safar-last-telemetry';
const OVERSPEED_THRESHOLD_KMH = 80;
const HARSH_BRAKE_THRESHOLD_MS2 = 4.5;
const LOCATION_UPDATE_INTERVAL_MS = 10000;
const LOCATION_DISTANCE_INTERVAL_METERS = 10;

const DEFAULT_PRODUCTION_API_BASE_URL = 'https://safar-admin.vercel.app';
const API_REQUEST_TIMEOUT_MS = 15000;

const API_BASE_URL = __DEV__
  ? Platform.OS === 'android'
    ? 'http://10.0.2.2:3000'
    : 'http://localhost:3000'
  : DEFAULT_PRODUCTION_API_BASE_URL;

function buildApiUrl(path) {
  return API_BASE_URL + path;
}

async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(buildApiUrl(path), {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    return response;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Request timed out. Please check your internet connection and try again.');
    }

    throw new Error('Could not connect to Safar services. Please check your internet connection and try again.');
  } finally {
    clearTimeout(timeoutId);
  }
}

async function pushLocationUpdate(location) {
  const storedSession = await AsyncStorage.getItem(DRIVER_SESSION_KEY);

  if (!storedSession) {
    return;
  }

  const session = JSON.parse(storedSession);
  const coords = location?.coords;

  if (!coords) {
    return;
  }

  const speedMps =
    typeof coords.speed === 'number' && Number.isFinite(coords.speed) && coords.speed >= 0
      ? coords.speed
      : null;
  const speedKmh = speedMps !== null ? Number((speedMps * 3.6).toFixed(1)) : null;

  await apiRequest('/api/driver-location', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      driverId: session.driverId,
      fleetId: session.fleetId,
      lat: coords.latitude,
      lng: coords.longitude,
      heading: typeof coords.heading === 'number' ? coords.heading : null,
      speed: speedMps,
      speedKmh,
      safetyEvents: [],
    }),
  });
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
async function pushTrackingStatus(isTracking) {
  const storedSession = await AsyncStorage.getItem(DRIVER_SESSION_KEY);

  if (!storedSession) {
    return;
  }

  const session = JSON.parse(storedSession);

  await apiRequest('/api/driver-tracking-status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      driverId: session.driverId,
      fleetId: session.fleetId,
      isTracking,
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
    await pushLocationUpdate(locations[locations.length - 1]);
    await AsyncStorage.setItem(
      TRACKING_STATUS_KEY,
      JSON.stringify({
        isTracking: true,
        lastUpdatedAt: new Date().toISOString(),
      })
    );
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

function JoinField({ label, value, onChangeText, placeholder, keyboardType, maxLength }) {
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

export default function App() {
  const { width } = useWindowDimensions();
  const isWide = width >= 768;
  const isExtraWide = width >= 1024;
  const isCompact = width < 380;
  const [booting, setBooting] = useState(true);
  const [joining, setJoining] = useState(false);
  const [requestingLocation, setRequestingLocation] = useState(false);
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [session, setSession] = useState(null);
  const [trackingState, setTrackingState] = useState({
    isTracking: false,
    lastUpdatedAt: null,
  });
  const [locationPermission, setLocationPermission] = useState('unknown');

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      try {
        const [storedSession, storedTracking, fgPermission, hasStartedTracking] = await Promise.all([
          AsyncStorage.getItem(DRIVER_SESSION_KEY),
          AsyncStorage.getItem(TRACKING_STATUS_KEY),
          Location.getForegroundPermissionsAsync(),
          Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false),
        ]);

        if (!mounted) {
          return;
        }

        if (storedSession) {
          setSession(JSON.parse(storedSession));
        }

        if (storedTracking) {
          const restoredTrackingState = JSON.parse(storedTracking);
          setTrackingState({
            ...restoredTrackingState,
            isTracking: hasStartedTracking || restoredTrackingState?.isTracking || false,
          });
        } else if (hasStartedTracking) {
          setTrackingState({
            isTracking: true,
            lastUpdatedAt: null,
          });
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

  const locationStatusText = useMemo(() => {
    if (locationPermission === 'granted') {
      return 'Granted';
    }
    if (locationPermission === 'denied') {
      return 'Denied';
    }
    return 'Pending';
  }, [locationPermission]);

  const contentStyles = useMemo(
    () => [
      styles.contentWrap,
      isWide && styles.contentWrapWide,
      isExtraWide && styles.contentWrapExtraWide,
    ],
    [isExtraWide, isWide]
  );


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

    if (!cleanedName || !cleanedPhone || !cleanedCode) {
      Alert.alert('Missing details', 'Please fill driver name, phone number, and invite code.');
      return;
    }

    setJoining(true);

    try {
      const response = await apiRequest('/api/verify-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inviteCode: cleanedCode,
          driverPhone: cleanedPhone,
          driverName: cleanedName,
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
        joinedAt: json.data.driver.joinedAt,
      };

      await AsyncStorage.setItem(DRIVER_SESSION_KEY, JSON.stringify(nextSession));
      setSession(nextSession);
      setInviteCode('');
    } catch (error) {
      Alert.alert('Join failed', error.message || 'Something went wrong.');
    } finally {
      setJoining(false);
    }
  }

  async function requestLocationPermissions() {
    setRequestingLocation(true);

    try {
      const foreground = await Location.requestForegroundPermissionsAsync();
      setLocationPermission(foreground.status);

      if (foreground.status !== 'granted') {
        Alert.alert('Permission needed', 'Foreground location permission is required to track the driver.');
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to request location permissions:', error);
      Alert.alert('Permission error', 'Could not request location permission on this device.');
      return false;
    } finally {
      setRequestingLocation(false);
    }
  }
  async function handleStartTracking() {
    const hasPermission = await requestLocationPermissions();

    if (!hasPermission) {
      return;
    }

    const hasNotificationPermission = await requestNotificationPermissionIfNeeded();

    if (!hasNotificationPermission) {
      Alert.alert('Notification permission needed', 'Allow notifications so Android can keep the tracking service alive.');
      return;
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
            notificationTitle: 'Safar live tracking is on',
            notificationBody: 'Keep the app in recent apps so location can continue syncing.',
          },
        });
      }

      const initialLocation = await getBestAvailableLocation();
      const syncedAt = new Date().toISOString();

      if (initialLocation?.coords) {
        await pushLocationUpdate(initialLocation);
        await pushTrackingStatus(true);
      }

      const nextTrackingState = {
        isTracking: true,
        lastUpdatedAt: initialLocation?.coords ? syncedAt : null,
      };

      await AsyncStorage.setItem(TRACKING_STATUS_KEY, JSON.stringify(nextTrackingState));
      setTrackingState(nextTrackingState);

      if (initialLocation?.coords) {
        Alert.alert('Tracking started', 'Location syncing will continue while the app stays in recent apps.');
      } else {
        Alert.alert('Waiting for GPS', 'Tracking is on. Please move near open sky and keep location on so the first map point can sync.');
      }
    } catch (error) {
      console.error('Failed to start tracking:', error);
      Alert.alert('Tracking error', error?.message || 'Could not start location tracking.');
    }
  }

  async function handleStopTracking() {
    try {
      const isStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);

      if (isStarted) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }

      const nextTrackingState = {
        isTracking: false,
        lastUpdatedAt: new Date().toISOString(),
      };

      await pushTrackingStatus(false);
      await AsyncStorage.setItem(TRACKING_STATUS_KEY, JSON.stringify(nextTrackingState));
      setTrackingState(nextTrackingState);
      Alert.alert('Tracking paused', 'Background location sharing has been stopped and the fleet owner will see you as offline.');
    } catch (error) {
      console.error('Failed to stop tracking:', error);
      Alert.alert('Tracking error', 'Could not stop location tracking.');
    }
  }

  async function handleResetDriver() {
    await AsyncStorage.multiRemove([DRIVER_SESSION_KEY, TRACKING_STATUS_KEY]);
    await AsyncStorage.removeItem(LAST_TELEMETRY_KEY);
    setSession(null);
    setTrackingState({ isTracking: false, lastUpdatedAt: null });
    setDriverName('');
    setDriverPhone('');
    setInviteCode('');
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
                      session ? (trackingState.isTracking ? styles.statusDotLive : styles.statusDotIdle) : styles.statusDotPending,
                    ]}
                  />
                  <Text style={styles.statusChipText}>
                    {session ? (trackingState.isTracking ? 'Live' : 'Connected') : 'Ready'}
                  </Text>
                </View>
              </View>

              {!session ? (
                <>
                  <Text style={[styles.sectionEyebrow, styles.heroEyebrow]}>Driver Login</Text>
                  <Text style={[styles.heroTitle, isCompact && styles.heroTitleCompact]}>
                    Connect your cab to the fleet in two simple steps.
                  </Text>
                  <Text style={styles.heroText}>
                    Enter your details, add the 5-digit invite code, and start sharing live location with the fleet owner.
                  </Text>
                </>
              ) : (
                <>
                  <Text style={[styles.sectionEyebrow, styles.heroEyebrow]}>Connected</Text>
                  <Text style={[styles.heroTitle, isCompact && styles.heroTitleCompact]}>
                    You are now linked to {session.fleetName}.
                  </Text>
                  <Text style={styles.heroText}>
                    Keep tracking on so the fleet owner can see your latest live position without calling the driver.
                  </Text>
                </>
              )}
            </View>

            {!session ? (
              <View style={[styles.panelGrid, isWide && styles.panelGridWide]}>
                <Card style={[styles.mainCard, styles.gridCard]}>
                  <JoinField
                    label="Driver name"
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
                    label="Fleet invite code"
                    value={inviteCode}
                    onChangeText={setInviteCode}
                    placeholder="12345"
                    keyboardType="number-pad"
                    maxLength={5}
                  />

                  <Pressable style={styles.primaryButton} onPress={handleJoinFleet} disabled={joining}>
                    {joining ? (
                      <ActivityIndicator color="#ffffff" />
                    ) : (
                      <Text style={styles.primaryButtonText}>Join Fleet</Text>
                    )}
                  </Pressable>
                </Card>

                <Card style={[styles.infoCard, styles.gridCard]}>
                  <Text style={styles.sectionEyebrow}>How it works</Text>
                  <View style={[styles.stepsWrap, isWide && styles.stepsWrapWide]}>
                    <View style={styles.stepCard}>
                      <Text style={styles.stepNumber}>1</Text>
                      <Text style={styles.stepText}>Enter your name and phone number.</Text>
                    </View>
                    <View style={styles.stepCard}>
                      <Text style={styles.stepNumber}>2</Text>
                      <Text style={styles.stepText}>Join using the owner's 5-digit fleet code.</Text>
                    </View>
                    <View style={styles.stepCard}>
                      <Text style={styles.stepNumber}>3</Text>
                      <Text style={styles.stepText}>Start tracking so the fleet owner can see your location.</Text>
                    </View>
                  </View>
                </Card>
              </View>
            ) : (
              <View style={[styles.panelGrid, isWide && styles.panelGridWide]}>
                <Card style={[styles.mainCard, styles.gridCard]}>
                  <View style={[styles.statsRow, isCompact && styles.statsRowStack]}>
                    <StatPill title="Invite code" value={session.inviteCode} accent />
                    <StatPill title="Location access" value={locationStatusText} />
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
                    <View style={styles.syncRow}>
                      <Text style={styles.syncLabel}>Last location sync</Text>
                      <Text style={styles.syncValue}>
                        {trackingState.lastUpdatedAt
                          ? new Date(trackingState.lastUpdatedAt).toLocaleString()
                          : 'Not sent yet'}
                      </Text>
                    </View>
                  </View>

                  {!trackingState.isTracking ? (
                    <Pressable
                      style={[styles.primaryButton, requestingLocation && styles.buttonDisabled]}
                      onPress={handleStartTracking}
                      disabled={requestingLocation}
                    >
                      {requestingLocation ? (
                        <ActivityIndicator color="#ffffff" />
                      ) : (
                        <Text style={styles.primaryButtonText}>Start Live Tracking</Text>
                      )}
                    </Pressable>
                  ) : (
                    <Pressable style={styles.secondaryButtonDanger} onPress={handleStopTracking}>
                      <Text style={styles.secondaryButtonDangerText}>Stop Tracking</Text>
                    </Pressable>
                  )}

                  <Pressable style={styles.textButton} onPress={handleResetDriver}>
                    <Text style={styles.textButtonLabel}>Reset driver session</Text>
                  </Pressable>
                </Card>

                <Card style={[styles.infoCard, styles.gridCard]}>
                  <Text style={styles.sectionEyebrow}>Important</Text>
                  <Text style={styles.infoLine}>Tracking can continue when the app is kept in recent apps and the phone stays on.</Text>
                  <Text style={styles.infoLine}>If the phone is completely powered off, no app can send location.</Text>
                  <Text style={styles.infoLine}>For best results, disable battery restrictions for this app and avoid swiping it away from recent apps.</Text>
                </Card>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
  secondaryButtonDangerText: {
    color: '#b91c1c',
    fontSize: 15,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.7,
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
  infoLine: {
    fontSize: 14,
    color: '#57534e',
    lineHeight: 21,
    marginTop: 6,
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
  detailRow: {
    color: '#334155',
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 4,
  },
});























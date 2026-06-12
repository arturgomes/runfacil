import { useState, useCallback, useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import { DeviceEventEmitter, EmitterSubscription } from 'react-native';
import { LOCATION_TASK_NAME, LOCATION_UPDATE_EVENT } from '@/services/locationTask';
import { Coordinate } from '@/store/RunContext';

export type TrackingStatus = 'idle' | 'starting' | 'active' | 'paused' | 'error';

type Options = {
  onCoordinate?: (coord: Coordinate) => void;
};

export function useGPSTracking({ onCoordinate }: Options = {}) {
  const [status, setStatus] = useState<TrackingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const subscriptionRef = useRef<EmitterSubscription | null>(null);
  // Foreground-only watcher — fallback when background updates are unavailable
  // (e.g. Expo Go on iOS, or background permission denied).
  const watcherRef = useRef<Location.LocationSubscription | null>(null);
  // Keep callback ref stable so the event listener always calls the latest version.
  const onCoordinateRef = useRef(onCoordinate);
  useEffect(() => { onCoordinateRef.current = onCoordinate; }, [onCoordinate]);

  const subscribe = useCallback(() => {
    if (subscriptionRef.current) return;
    subscriptionRef.current = DeviceEventEmitter.addListener(
      LOCATION_UPDATE_EVENT,
      (coord: Coordinate) => onCoordinateRef.current?.(coord)
    );
  }, []);

  const unsubscribe = useCallback(() => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
  }, []);

  const requestPermissions = useCallback(async (): Promise<{ fg: boolean; bg: boolean }> => {
    const { status: fg } = await Location.requestForegroundPermissionsAsync();
    if (fg !== 'granted') return { fg: false, bg: false };
    const bg = await Location.requestBackgroundPermissionsAsync()
      .then((r) => r.status === 'granted')
      .catch(() => false);
    return { fg: true, bg };
  }, []);

  const startForegroundWatcher = useCallback(async () => {
    if (watcherRef.current) return;
    watcherRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 5 },
      (loc) =>
        onCoordinateRef.current?.({
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          timestamp: loc.timestamp,
          accuracy: loc.coords.accuracy ?? undefined,
        })
    );
  }, []);

  const startTracking = useCallback(async () => {
    setStatus('starting');
    setError(null);
    const { fg, bg } = await requestPermissions();
    if (!fg) {
      setStatus('error');
      setError('Permissão de localização negada.');
      return;
    }
    try {
      if (!bg) throw new Error('background permission unavailable');
      subscribe();
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 5,
        deferredUpdatesDistance: 10,
        foregroundService: {
          notificationTitle: 'RunFácil',
          notificationBody: 'Rastreando sua corrida…',
          notificationColor: '#FF6B35',
        },
      });
    } catch {
      // Background task unavailable (Expo Go / permission) — track while
      // the app is in the foreground only.
      unsubscribe();
      await startForegroundWatcher();
    }
    setStatus('active');
  }, [requestPermissions, subscribe, unsubscribe, startForegroundWatcher]);

  const stopWatcher = useCallback(() => {
    watcherRef.current?.remove();
    watcherRef.current = null;
  }, []);

  const pauseTracking = useCallback(async () => {
    unsubscribe();
    stopWatcher();
    const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
    if (running) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    setStatus('paused');
  }, [unsubscribe, stopWatcher]);

  const stopTracking = useCallback(async () => {
    unsubscribe();
    stopWatcher();
    const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false);
    if (running) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    setStatus('idle');
  }, [unsubscribe, stopWatcher]);

  // Cleanup on unmount
  useEffect(() => () => { unsubscribe(); stopWatcher(); }, [unsubscribe, stopWatcher]);

  return { status, error, startTracking, pauseTracking, resumeTracking: startTracking, stopTracking };
}

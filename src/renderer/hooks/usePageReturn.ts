import { useEffect, useLayoutEffect, useRef } from 'react';
import { UI } from '@shared/constants';
import { useAppStore } from '../stores/appStore';
import { useSessionStore, whenInitialSessionStateSettled } from '../stores/sessionStore';
import { SECONDARY_PAGES_CLOSED } from '../stores/secondaryPages';
import { DEFAULT_SETTINGS_TAB, SETTINGS_TAB_IDS, type SettingsTab } from '../utils/settingsTabs';
import { createLogger } from '../utils/logger';

const STORAGE_KEY = 'neo:page-return';
const logger = createLogger('PageReturn');
type Page = { page: 'chat' } | { page: 'automation'; runs: boolean }
  | { page: 'settings'; tab: SettingsTab };
type Snapshot = { version: 1; sessionId: string | null; position: Page };
let automationRuns = false;
let settingsTab = DEFAULT_SETTINGS_TAB;

/** Request flags are consumed by the panels; retain their actual visible selection separately. */
export function usePageReturnPosition(position: Exclude<Page, { page: 'chat' }>): void {
  const tab = position.page === 'settings' ? position.tab : position.runs;
  useLayoutEffect(() => {
    if (typeof tab === 'boolean') automationRuns = tab;
    else settingsTab = tab;
  }, [tab]);
}

function consume(): Snapshot | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw !== null) window.sessionStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    logger.warn('Snapshot storage read/consume failed', { reason: String(error) });
    return null;
  }
  if (raw === null) return null;
  try {
    const snapshot = JSON.parse(raw) as Snapshot;
    if (snapshot?.version !== 1) throw new Error('unknown snapshot version');
    if (snapshot.sessionId !== null && (typeof snapshot.sessionId !== 'string' || !snapshot.sessionId)) {
      throw new Error('invalid session id');
    }
    const p = snapshot.position;
    if (!p || !(['chat', 'automation', 'settings'] as string[]).includes(p.page)) {
      throw new Error('unknown page');
    }
    if (p.page === 'automation' && typeof p.runs !== 'boolean') throw new Error('invalid runs view');
    if (p.page === 'settings' && !SETTINGS_TAB_IDS.includes(p.tab)) throw new Error('unknown settings tab');
    return snapshot;
  } catch (error) {
    logger.warn('Snapshot ignored', { reason: String(error) });
    return null;
  }
}

function write(): void {
  const app = useAppStore.getState();
  const position: Page = app.showSettings
    ? { page: 'settings', tab: app.settingsInitialTab ?? settingsTab }
    : app.showCronCenter
      ? { page: 'automation', runs: app.cronCenterRunsRequested || automationRuns }
      : { page: 'chat' };
  try {
    const secondaryKeys = Object.keys(SECONDARY_PAGES_CLOSED) as (keyof typeof SECONDARY_PAGES_CLOSED)[];
    if (!app.showSettings && !app.showCronCenter && secondaryKeys.some((key) => Boolean(app[key]))) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return; // Unsupported secondary pages retain the existing cold-boot behaviour.
    }
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, sessionId: useSessionStore.getState().currentSessionId, position,
    } satisfies Snapshot));
  } catch (error) {
    logger.warn('Snapshot storage write failed', { reason: String(error) });
  }
}

function applyPage(position: Page): void {
  const app = useAppStore.getState();
  if (position.page === 'automation') {
    if (position.runs) app.openCronCenterRuns();
    else app.setShowCronCenter(true);
  } else if (position.page === 'settings') {
    app.openSettingsTab(position.tab);
  }
}

/** Installed by the app's deep-link hook; URL intent always takes precedence. */
export function usePageReturn(): void {
  // React StrictMode repeats effects. Consume once per mount, keep the consumed value for replay.
  const pending = useRef<Snapshot | null | undefined>(undefined);
  useEffect(() => {
    if (pending.current === undefined) pending.current = consume();
    window.addEventListener('pagehide', write);
    const snapshot = pending.current;
    let active = true;
    let applying = false;
    let deadline = Infinity;
    let timer: number | undefined;
    let unsubscribeApp = () => {};
    let unsubscribeSession = () => {};
    const stop = () => {
      active = false;
      unsubscribeApp();
      unsubscribeSession();
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', stop, true);
      window.removeEventListener('keydown', stop, true);
    };
    if (snapshot && !new URLSearchParams(window.location.search).has('open')) {
      // Never override navigation the user makes while startup is still in flight.
      window.addEventListener('pointerdown', stop, true);
      window.addEventListener('keydown', stop, true);
      const restore = async () => {
        if (!active || applying || Date.now() > deadline) return;
        const session = useSessionStore.getState();
        if (session.isHydratingSession || session.isLoading) return;
        if (snapshot.sessionId && !session.sessions.some((s) => s.id === snapshot.sessionId)) {
          logger.warn('Snapshot session missing from loaded list', { reason: 'session not available' });
          stop();
          return;
        }
        applying = true;
        try {
          if (snapshot.sessionId && session.currentSessionId !== snapshot.sessionId) {
            await session.switchSession(snapshot.sessionId);
          }
          if (active) applyPage(snapshot.position);
        } catch (error) {
          logger.warn('Snapshot restore failed', { reason: String(error) });
          stop();
        } finally {
          applying = false;
        }
      };
      void whenInitialSessionStateSettled().then(async () => {
        if (!active) return;
        deadline = Date.now() + UI.STARTUP_PAGE_REAPPLY_WINDOW;
        // closeSecondaryPages also runs for a same-id switch (no session-store notification).
        unsubscribeApp = useAppStore.subscribe((state, prev) => {
          if ((prev.showCronCenter && !state.showCronCenter) || (prev.showSettings && !state.showSettings)) {
            queueMicrotask(() => { void restore(); });
          }
        });
        unsubscribeSession = useSessionStore.subscribe((state, prev) => {
          if (state.currentSessionId && (state.currentSessionId !== prev.currentSessionId
            || state.isLoading !== prev.isLoading || state.isHydratingSession !== prev.isHydratingSession)) {
            queueMicrotask(() => { void restore(); });
          }
        });
        timer = window.setTimeout(stop, UI.STARTUP_PAGE_REAPPLY_WINDOW);
        await restore();
      });
    }
    return () => {
      stop();
      window.removeEventListener('pagehide', write);
    };
  }, []);
}

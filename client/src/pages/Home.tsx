import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Check, CircleHelp, Eye, Gauge, Pause, Play, RotateCcw, ShieldCheck, Sparkles, Target, Waves } from "lucide-react";

type GazePoint = { x: number; y: number };
type WebGazerApi = {
  begin: (onFail?: (error?: unknown) => void) => Promise<unknown> | unknown;
  end?: () => unknown;
  pause?: () => unknown;
  resume?: () => Promise<unknown> | unknown;
  setGazeListener: (listener: (data: { x: number; y: number } | null, elapsedTime?: number) => void) => WebGazerApi;
  clearGazeListener?: () => WebGazerApi;
  showVideoPreview?: (value: boolean) => WebGazerApi;
  showFaceOverlay?: (value: boolean) => WebGazerApi;
  showFaceFeedbackBox?: (value: boolean) => WebGazerApi;
  applyKalmanFilter?: (value: boolean) => WebGazerApi;
  saveDataAcrossSessions?: (value: boolean) => WebGazerApi;
  setRegression?: (name: string) => WebGazerApi;
  setTracker?: (name: string) => WebGazerApi;
  recordScreenPosition?: (x: number, y: number, eventType?: string) => WebGazerApi;
};

declare global {
  interface Window {
    webgazer?: WebGazerApi;
  }
}

const CALIBRATION_POINTS = [
  { x: 12, y: 18 },
  { x: 50, y: 14 },
  { x: 88, y: 18 },
  { x: 20, y: 50 },
  { x: 50, y: 50 },
  { x: 80, y: 50 },
  { x: 12, y: 82 },
  { x: 50, y: 86 },
  { x: 88, y: 82 },
];

const HOLD_DURATION = 1600;
const CALIBRATION_STEP = 2100;
const MAX_HISTORY = 12;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function distance(a: GazePoint, b: GazePoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export default function Home() {
  const [tracking, setTracking] = useState(false);
  const [permissionState, setPermissionState] = useState<"idle" | "starting" | "ready" | "blocked" | "error">("idle");
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationStep, setCalibrationStep] = useState(0);
  const [gaze, setGaze] = useState<GazePoint | null>(null);
  const [confidence, setConfidence] = useState(0);
  const [holdProgress, setHoldProgress] = useState(0);
  const [activated, setActivated] = useState(false);
  const [orientation, setOrientation] = useState(0);
  const [adaptiveMode, setAdaptiveMode] = useState(true);
  const [lastEvent, setLastEvent] = useState("En attente de la caméra");

  const gazeRef = useRef<GazePoint | null>(null);
  const smoothRef = useRef<GazePoint | null>(null);
  const historyRef = useRef<GazePoint[]>([]);
  const holdStartRef = useRef<number | null>(null);
  const stableSinceRef = useRef<number | null>(null);
  const calibrationTimerRef = useRef<number | null>(null);
  const calibrationPulseRef = useRef<number | null>(null);
  const webgazerRef = useRef<WebGazerApi | null>(null);
  const orientationRef = useRef(0);

  const calibrationPoint = CALIBRATION_POINTS[calibrationStep] ?? CALIBRATION_POINTS[0];
  const calibrationPercent = Math.round((calibrationStep / CALIBRATION_POINTS.length) * 100);

  const loadWebGazer = useCallback(() => {
    return new Promise<WebGazerApi>((resolve, reject) => {
      if (window.webgazer) {
        resolve(window.webgazer);
        return;
      }
      const existing = document.querySelector<HTMLScriptElement>('script[data-webgazer="local"]');
      if (existing) {
        existing.addEventListener("load", () => window.webgazer ? resolve(window.webgazer) : reject(new Error("WebGazer indisponible")), { once: true });
        existing.addEventListener("error", () => reject(new Error("Impossible de charger WebGazer")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = "/webgazer.js";
      script.async = true;
      script.dataset.webgazer = "local";
      script.onload = () => window.webgazer ? resolve(window.webgazer) : reject(new Error("WebGazer indisponible"));
      script.onerror = () => reject(new Error("Impossible de charger WebGazer"));
      document.head.appendChild(script);
    });
  }, []);

  const processGaze = useCallback((raw: GazePoint) => {
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const next = { x: clamp(raw.x, 0, width), y: clamp(raw.y, 0, height) };
    const previous = smoothRef.current;
    const movement = previous ? distance(next, previous) : 0;
    const smoothing = adaptiveMode ? (movement > 48 ? 0.34 : movement > 18 ? 0.22 : 0.12) : 0.24;
    const smoothed = previous
      ? { x: previous.x + (next.x - previous.x) * smoothing, y: previous.y + (next.y - previous.y) * smoothing }
      : next;
    smoothRef.current = smoothed;
    gazeRef.current = smoothed;
    historyRef.current = [...historyRef.current.slice(-(MAX_HISTORY - 1)), smoothed];
    const avgMovement = historyRef.current.length > 2
      ? historyRef.current.slice(1).reduce((sum, point, index) => sum + distance(point, historyRef.current[index]), 0) / (historyRef.current.length - 1)
      : 20;
    const nextConfidence = clamp(100 - avgMovement * 2.3, 24, 98);
    setConfidence(Math.round(nextConfidence));
    setGaze(smoothed);
  }, [adaptiveMode]);

  const startTracking = useCallback(async () => {
    if (tracking || permissionState === "starting") return;
    setPermissionState("starting");
    setLastEvent("Demande d’accès caméra…");
    try {
      const api = await loadWebGazer();
      webgazerRef.current = api;
      api.setRegression?.("ridge").setTracker?.("TFFacemesh");
      api.applyKalmanFilter?.(true).saveDataAcrossSessions?.(true);
      api.showVideoPreview?.(true).showFaceOverlay?.(false).showFaceFeedbackBox?.(false);
      api.setGazeListener((data) => {
        if (data) processGaze(data);
      });
      await api.begin((error) => {
        console.error(error);
        setPermissionState("blocked");
        setLastEvent("Accès caméra refusé");
      });
      setTracking(true);
      setPermissionState("ready");
      setLastEvent("Suivi actif · calibration disponible");
    } catch (error) {
      console.error(error);
      setPermissionState("error");
      setLastEvent("La caméra n’a pas pu démarrer");
    }
  }, [loadWebGazer, permissionState, processGaze, tracking]);

  const stopTracking = useCallback(() => {
    if (calibrationTimerRef.current) window.clearTimeout(calibrationTimerRef.current);
    if (calibrationPulseRef.current) window.clearInterval(calibrationPulseRef.current);
    webgazerRef.current?.clearGazeListener?.();
    webgazerRef.current?.end?.();
    webgazerRef.current = null;
    setTracking(false);
    setCalibrating(false);
    setHoldProgress(0);
    holdStartRef.current = null;
    setPermissionState("idle");
    setLastEvent("Suivi arrêté");
  }, []);

  const startCalibration = useCallback(() => {
    if (!tracking) {
      void startTracking();
      return;
    }
    setCalibrationStep(0);
    setCalibrating(true);
    setLastEvent("Regardez le point lumineux sans bouger la tête");
  }, [startTracking, tracking]);

  useEffect(() => {
    if (!calibrating || !tracking) return;
    const point = CALIBRATION_POINTS[calibrationStep];
    const record = () => {
      const x = (point.x / 100) * window.innerWidth;
      const y = (point.y / 100) * window.innerHeight;
      webgazerRef.current?.recordScreenPosition?.(x, y, "click");
    };
    record();
    calibrationPulseRef.current = window.setInterval(record, 140);
    calibrationTimerRef.current = window.setTimeout(() => {
      if (calibrationStep >= CALIBRATION_POINTS.length - 1) {
        setCalibrating(false);
        setLastEvent("Calibration optimisée · maintien du regard pour activer");
      } else {
        setCalibrationStep((step) => step + 1);
      }
    }, CALIBRATION_STEP);
    return () => {
      if (calibrationPulseRef.current) window.clearInterval(calibrationPulseRef.current);
      if (calibrationTimerRef.current) window.clearTimeout(calibrationTimerRef.current);
    };
  }, [calibrationStep, calibrating, tracking]);

  useEffect(() => {
    const readOrientation = () => {
      const angle = Number(window.screen.orientation?.angle ?? (window.orientation as number) ?? 0);
      if (angle !== orientationRef.current) {
        orientationRef.current = angle;
        smoothRef.current = null;
        historyRef.current = [];
        setOrientation(angle);
        if (tracking) {
          setLastEvent("Orientation caméra détectée · réajustement en cours");
          setCalibrating(true);
          setCalibrationStep(4);
        }
      }
    };
    readOrientation();
    window.addEventListener("orientationchange", readOrientation);
    window.screen.orientation?.addEventListener?.("change", readOrientation);
    return () => {
      window.removeEventListener("orientationchange", readOrientation);
      window.screen.orientation?.removeEventListener?.("change", readOrientation);
    };
  }, [tracking]);

  useEffect(() => {
    if (!tracking) return;
    const id = window.setInterval(() => {
      const current = gazeRef.current;
      const now = performance.now();
      const target = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const isOnButton = current ? distance(current, target) < Math.min(180, window.innerWidth * 0.18) : false;
      const stable = historyRef.current.length > 4 && confidence > 62;
      if (isOnButton && stable) {
        if (!stableSinceRef.current) stableSinceRef.current = now;
        if (now - stableSinceRef.current > 700) {
          webgazerRef.current?.recordScreenPosition?.(target.x, target.y, "move");
        }
      } else {
        stableSinceRef.current = null;
      }
      if (isOnButton && !calibrating) {
        if (!holdStartRef.current) holdStartRef.current = now;
        const progress = clamp((now - holdStartRef.current) / HOLD_DURATION, 0, 1);
        setHoldProgress(progress);
        if (progress >= 1 && !activated) {
          setActivated(true);
          setLastEvent("Bouton activé par le regard");
        }
      } else {
        holdStartRef.current = null;
        setHoldProgress(0);
      }
    }, 50);
    return () => window.clearInterval(id);
  }, [activated, calibrating, confidence, tracking]);

  useEffect(() => () => {
    if (calibrationTimerRef.current) window.clearTimeout(calibrationTimerRef.current);
    if (calibrationPulseRef.current) window.clearInterval(calibrationPulseRef.current);
    webgazerRef.current?.clearGazeListener?.();
    webgazerRef.current?.end?.();
  }, []);

  const statusLabel = useMemo(() => {
    if (permissionState === "starting") return "Initialisation";
    if (permissionState === "blocked") return "Caméra bloquée";
    if (permissionState === "error") return "Erreur caméra";
    if (tracking) return calibrating ? "Calibration" : "En ligne";
    return "Hors ligne";
  }, [calibrating, permissionState, tracking]);

  const handleMainAction = () => {
    setActivated(false);
    setLastEvent("Action réinitialisée · prêt pour un nouveau regard");
  };

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Eye size={18} strokeWidth={2.4} /></div>
          <div>
            <span className="eyebrow">WebGazer / interface expérimentale</span>
            <h1>Focus Field</h1>
          </div>
        </div>
        <div className="topbar-meta">
          <span className={`status-dot ${tracking ? "live" : ""}`} />
          <span>{statusLabel}</span>
          <span className="meta-divider" />
          <span>Orientation {orientation}°</span>
        </div>
      </header>

      <section className="hero-grid">
        <aside className="side-panel left-panel">
          <div className="panel-kicker"><Sparkles size={14} /> calibration adaptative</div>
          <h2>Le regard devient une intention.</h2>
          <p className="panel-copy">Un maintien de {HOLD_DURATION / 1000} secondes sur le cœur de l’interface déclenche l’action. Le modèle se recale en continu sur les micro-mouvements du visage.</p>
          <div className="protocol-list">
            <div className="protocol-item"><span className="protocol-index">01</span><span>Regardez les repères lumineux</span></div>
            <div className="protocol-item"><span className="protocol-index">02</span><span>Gardez une posture confortable</span></div>
            <div className="protocol-item"><span className="protocol-index">03</span><span>Maintenez le regard au centre</span></div>
          </div>
          <button className="text-button" onClick={() => setLastEvent("WebGazer s’exécute localement dans votre navigateur") }><CircleHelp size={15} /> Comment ça marche ?</button>
        </aside>

        <section className="focus-stage" aria-label="Zone de contrôle par le regard">
          <div className="stage-grid" />
          <div className="reticle reticle-a" />
          <div className="reticle reticle-b" />
          <div className="center-guide"><span /><span /><span /><span /></div>
          <div className={`gaze-cursor ${gaze ? "visible" : ""}`} style={gaze ? { left: `${(gaze.x / window.innerWidth) * 100}%`, top: `${(gaze.y / window.innerHeight) * 100}%` } : undefined} aria-hidden="true"><span /></div>
          <button className={`gaze-button ${activated ? "activated" : ""} ${holdProgress > 0 ? "holding" : ""}`} onClick={handleMainAction} aria-label="Action centrale contrôlée par le regard">
            <span className="button-aura" style={{ transform: `scale(${1 + holdProgress * 0.18})` }} />
            <span className="button-core"><Target size={28} strokeWidth={1.5} /></span>
            <span className="button-label">{activated ? "ACTIVÉ" : holdProgress > 0 ? "MAINTENEZ" : "FOCUS"}</span>
            <span className="button-subtitle">{activated ? "regard détecté" : "maintenez le regard"}</span>
            <span className="hold-ring" style={{ "--hold-progress": `${holdProgress * 360}deg` } as React.CSSProperties} />
          </button>
          {calibrating && <div className="calibration-anchor" style={{ left: `${calibrationPoint.x}%`, top: `${calibrationPoint.y}%` }}><span /><small>{calibrationStep + 1} / {CALIBRATION_POINTS.length}</small></div>}
          <div className="stage-caption"><span className="live-line" />{lastEvent}</div>
        </section>

        <aside className="side-panel right-panel">
          <div className="telemetry-header"><span className="panel-kicker"><Gauge size={14} /> télémétrie</span><span className="telemetry-live">LIVE</span></div>
          <div className="metric-block"><div className="metric-label">stabilité du signal</div><div className="metric-value">{tracking ? confidence : 0}<span>%</span></div><div className="metric-bar"><span style={{ width: `${tracking ? confidence : 0}%` }} /></div></div>
          <div className="metric-block"><div className="metric-label">maintien requis</div><div className="metric-value">{HOLD_DURATION / 1000}<span>s</span></div><div className="hold-meter"><span style={{ width: `${holdProgress * 100}%` }} /></div></div>
          <div className="signal-row"><span><Waves size={14} /> filtre Kalman</span><b>ACTIF</b></div>
          <div className="signal-row"><span><ShieldCheck size={14} /> traitement local</span><b>PRIVÉ</b></div>
          <button className="adaptive-toggle" onClick={() => setAdaptiveMode((value) => !value)}><span className={`toggle-switch ${adaptiveMode ? "on" : ""}`}><i /></span><span>Compensation adaptative</span></button>
          <div className="camera-note"><Camera size={16} /><span>Webcam requise<br /><small>Chrome, Edge, Firefox, Safari</small></span></div>
        </aside>
      </section>

      <footer className="control-dock">
        <div className="dock-copy"><span className="dock-label">PROTOCOLE DE DÉMARRAGE</span><span>{tracking ? "Le signal est reçu. Vous pouvez recalibrer à tout moment." : "Autorisez la caméra pour commencer le suivi du regard."}</span></div>
        <div className="dock-actions">
          {tracking && <button className="secondary-button" onClick={stopTracking}><Pause size={15} /> Arrêter</button>}
          <button className="primary-button" onClick={tracking ? startCalibration : startTracking} disabled={permissionState === "starting"}><span className="button-icon">{tracking ? <RotateCcw size={15} /> : <Play size={15} />}</span>{permissionState === "starting" ? "Connexion…" : tracking ? "Recalibrer" : "Activer le regard"}</button>
        </div>
        {tracking && <div className="calibration-progress"><span style={{ width: `${calibrating ? Math.max(8, calibrationPercent) : 100}%` }} /></div>}
      </footer>
    </main>
  );
}

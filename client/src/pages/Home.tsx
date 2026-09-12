import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Check, CircleHelp, Clipboard, Copy, Eye, Gauge, Pause, Play, RotateCcw, ShieldCheck, Sparkles, Target, Trash2, Waves } from "lucide-react";

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
  setCameraConstraints?: (constraints: MediaStreamConstraints) => Promise<WebGazerApi> | WebGazerApi;
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
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const diagnosticsRef = useRef<string[]>([]);

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

  const appendDiagnostics = useCallback((entries: string | string[]) => {
    const values = Array.isArray(entries) ? entries : [entries];
    const stamped = values.map((entry) => `[${new Date().toISOString()}] ${entry}`);
    diagnosticsRef.current = [...diagnosticsRef.current, ...stamped].slice(-160);
    setDiagnostics(diagnosticsRef.current);
  }, []);

  const describeError = useCallback((error: unknown) => {
    const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error && error.message ? error.message : "aucun message fourni par le navigateur";
    const details = error && typeof error === "object" ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : String(error);
    return [`Erreur exacte : ${name}`, `Message : ${message}`, `Détails : ${details}`];
  }, []);

  const collectDiagnostics = useCallback(async (error?: unknown) => {
    const lines = [
      `Contexte sécurisé : ${window.isSecureContext ? "oui" : "non"}`,
      `URL : ${window.location.href}`,
      `Base Vite : ${import.meta.env.BASE_URL}`,
      `Fenêtre principale : ${window.top === window.self ? "oui" : "non (iframe/webview)"}`,
      `mediaDevices : ${navigator.mediaDevices ? "présent" : "absent"}`,
      `getUserMedia : ${navigator.mediaDevices && "getUserMedia" in navigator.mediaDevices ? "présent" : "absent"}`,
      `Navigateur : ${navigator.userAgent}`,
    ];
    try {
      const permission = await navigator.permissions?.query({ name: "camera" as PermissionName });
      if (permission) lines.push(`Permission caméra : ${permission.state}`);
    } catch {
      lines.push("Permission caméra : API non disponible");
    }
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices();
      const cameras = devices?.filter((device) => device.kind === "videoinput") ?? [];
      lines.push(`Caméras détectées : ${cameras.length}${cameras.some((camera) => camera.label) ? " · libellés autorisés" : " · libellés masqués"}`);
      cameras.forEach((camera, index) => lines.push(`Caméra ${index + 1} : ${camera.label || "libellé masqué"} · ${camera.deviceId ? "ID présent" : "ID absent"}`));
    } catch (deviceError) {
      lines.push(`Énumération périphériques : ${deviceError instanceof Error ? deviceError.message : "échec"}`);
    }
    if (error) lines.push(...describeError(error));
    appendDiagnostics(lines);
    return lines;
  }, [appendDiagnostics, describeError]);

  useEffect(() => {
    const onError = (event: ErrorEvent) => appendDiagnostics(`Erreur globale : ${event.message || "erreur inconnue"} · ${event.filename || "source inconnue"}:${event.lineno || 0}`);
    const onRejection = (event: PromiseRejectionEvent) => appendDiagnostics(["Promise rejetée", ...describeError(event.reason)]);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); };
  }, [appendDiagnostics, describeError]);

  const clearDiagnostics = () => { diagnosticsRef.current = []; setDiagnostics([]); };
  const copyDiagnostics = async () => {
    const text = diagnosticsRef.current.join("\n");
    try { await navigator.clipboard.writeText(text); appendDiagnostics("Journal copié dans le presse-papiers"); }
    catch { appendDiagnostics("Copie impossible : autorisez l’accès au presse-papiers"); }
  };

  const runNativeCameraTest = useCallback(async () => {
    setLastEvent("Test natif de la caméra en cours…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      stream.getTracks().forEach((item) => item.stop());
      setLastEvent("Test natif réussi · le blocage vient probablement de WebGazer ou de la webview");
      appendDiagnostics(`Test natif : OK${settings?.width ? ` · ${settings.width}×${settings.height}` : ""}`);
    } catch (error) {
      setLastEvent("Test natif échoué · consultez le diagnostic");
      await collectDiagnostics(error);
    }
  }, [collectDiagnostics]);

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
      script.src = `${import.meta.env.BASE_URL}webgazer.js`;
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
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setPermissionState("blocked");
      setLastEvent("Caméra indisponible : utilisez le domaine publié en HTTPS");
      await collectDiagnostics();
      return;
    }
    setPermissionState("starting");
    appendDiagnostics("Activation demandée · vérification du contexte et de la caméra");
    setLastEvent("Demande d’accès caméra…");
    try {
      const api = await loadWebGazer();
      webgazerRef.current = api;
      api.setRegression?.("ridge").setTracker?.("TFFacemesh");
      // Les contraintes par défaut de WebGazer demandent au moins 320×240.
      // Certains navigateurs mobiles/webviews refusent cette contrainte même
      // après avoir accordé la permission. On laisse le navigateur choisir
      // une caméra frontale compatible, avec une définition indicative.
      await api.setCameraConstraints?.({
        audio: false,
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });
      api.applyKalmanFilter?.(true).saveDataAcrossSessions?.(true);
      api.showVideoPreview?.(true).showFaceOverlay?.(false).showFaceFeedbackBox?.(false);
      api.setGazeListener((data) => {
        if (data) processGaze(data);
      });
      const begin = () => new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error?: unknown) => {
          const actualError = error ?? new DOMException("WebGazer n’a pas obtenu de flux vidéo", "UnknownError");
          appendDiagnostics(["WebGazer callback d’échec · flux vidéo absent", ...describeError(actualError)]);
          setPermissionState("blocked");
          setLastEvent("Accès caméra refusé ou flux vidéo indisponible");
          if (!settled) {
            settled = true;
            reject(actualError);
          }
        };
        try {
          Promise.resolve(api.begin(fail)).then(() => {
            if (!settled) {
              settled = true;
              resolve();
            }
          }, fail);
        } catch (error) {
          fail(error);
        }
      });
      appendDiagnostics("WebGazer chargé · démarrage avec contraintes caméra minimales");
      try {
        await begin();
      } catch (firstError) {
        // Certains navigateurs custom renvoient UnknownError lorsque les
        // contraintes idéales sont refusées. Une seconde demande minimale
        // permet alors au navigateur de choisir sa caméra disponible.
        appendDiagnostics(["Premier démarrage WebGazer échoué · nouvelle tentative", ...describeError(firstError)]);
        await api.setCameraConstraints?.({ audio: false, video: true });
        await begin();
      }
      const video = document.querySelector<HTMLVideoElement>("#webgazerVideoFeed");
      if (!video) {
        appendDiagnostics("WebGazer terminé sans élément vidéo #webgazerVideoFeed");
        throw new DOMException("WebGazer n’a créé aucun élément vidéo", "UnknownError");
      }
      video.setAttribute("playsinline", "true");
      video.muted = true;
      video.autoplay = true;
      try {
        await video.play();
        const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;
        appendDiagnostics(`Élément vidéo prêt · état=${video.readyState} · pistes=${stream?.getVideoTracks().length ?? 0}`);
      } catch (playError) {
        appendDiagnostics(["Échec lecture du flux vidéo", ...describeError(playError)]);
        throw playError;
      }
      appendDiagnostics("WebGazer démarré avec succès · flux vidéo disponible");
      setTracking(true);
      setPermissionState("ready");
      setLastEvent("Suivi actif · calibration disponible");
    } catch (error) {
      appendDiagnostics(["Échec activation du regard", ...describeError(error)]);
      await collectDiagnostics(error);
      const name = error instanceof DOMException ? error.name : "UnknownError";
      const isContextBlocked = name === "NotAllowedError" || name === "SecurityError";
      setPermissionState(isContextBlocked ? "blocked" : "error");
      setLastEvent(
        isContextBlocked
          ? "Permission refusée : ouvrez le domaine publié dans un onglet HTTPS"
          : `Caméra indisponible (${name})`,
      );
    }
  }, [appendDiagnostics, collectDiagnostics, describeError, loadWebGazer, permissionState, processGaze, tracking]);

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
          <button className="diagnostic-button" onClick={() => void runNativeCameraTest()}><ShieldCheck size={14} /> Tester l’accès natif</button>
          <div className="diagnostic-box" role="log" aria-live="polite">
            <div className="diagnostic-toolbar"><div className="diagnostic-title"><Clipboard size={12} /> Journal complet ({diagnostics.length})</div><div className="diagnostic-actions"><button type="button" title="Copier le journal" onClick={() => void copyDiagnostics()}><Copy size={12} /></button><button type="button" title="Effacer le journal" onClick={clearDiagnostics}><Trash2 size={12} /></button></div></div>
            {diagnostics.length === 0 ? <div className="diagnostic-empty">Les événements caméra apparaîtront ici.</div> : diagnostics.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}
          </div>
        </aside>
      </section>

      <footer className="control-dock">
        <div className="dock-copy"><span className="dock-label">PROTOCOLE DE DÉMARRAGE</span><span>{tracking ? "Le signal est reçu. Vous pouvez recalibrer à tout moment." : "Autorisez la caméra pour commencer le suivi du regard."}</span></div>
        <div className="dock-actions">
          <button className="secondary-button diagnostic-mobile" onClick={() => void runNativeCameraTest()}><ShieldCheck size={15} /> Diagnostic caméra</button>
          {tracking && <button className="secondary-button" onClick={stopTracking}><Pause size={15} /> Arrêter</button>}
          <button className="primary-button" onClick={tracking ? startCalibration : startTracking} disabled={permissionState === "starting"}><span className="button-icon">{tracking ? <RotateCcw size={15} /> : <Play size={15} />}</span>{permissionState === "starting" ? "Connexion…" : tracking ? "Recalibrer" : "Activer le regard"}</button>
        </div>
        {tracking && <div className="calibration-progress"><span style={{ width: `${calibrating ? Math.max(8, calibrationPercent) : 100}%` }} /></div>}
      </footer>
    </main>
  );
}

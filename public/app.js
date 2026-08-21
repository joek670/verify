import { MAX_FILE_BYTES, combineDecisions, extractSignals, scoreLiveness, scoreUpload } from "./analyzer.js";

const uploadInput = document.querySelector("#media-file");
const uploadResult = document.querySelector("#upload-result");
const liveResult = document.querySelector("#live-result");
const finalResult = document.querySelector("#final-result");
const startButton = document.querySelector("#start-live");
const completeButton = document.querySelector("#complete-live");
const stopButton = document.querySelector("#stop-live");
const video = document.querySelector("#camera-preview");
const challengeText = document.querySelector("#challenge-text");
const meter = document.querySelector("#audio-level");

const challenges = [
  "Say: blue river seven, then turn your head left.",
  "Say: copper moon four, then raise your right hand.",
  "Say: green harbor nine, then blink twice.",
  "Say: silver pine three, then look up.",
];

let uploadDecision;
let liveDecision;
let stream;
let audioContext;
let analyser;
let animationFrame;
let startedAt = 0;
let audioSampleCount = 0;
let activeAudioSampleCount = 0;
let motionTotal = 0;
let motionSampleCount = 0;
let previousFrame;
let sessionId = 0;
let uploadId = 0;

uploadInput.addEventListener("change", async () => {
  const file = uploadInput.files?.[0];
  if (!file) return;
  const currentUpload = ++uploadId;
  if (file.size > MAX_FILE_BYTES) {
    uploadDecision = scoreUpload(extractSignals(new Uint8Array(), file.type, file.name), file.size);
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (currentUpload !== uploadId) return;
    uploadDecision = scoreUpload(extractSignals(bytes, file.type, file.name), file.size);
  }
  liveDecision = undefined;
  liveResult.hidden = true;
  renderDecision(uploadResult, uploadDecision);
  renderCombined();
});

startButton.addEventListener("click", async () => {
  stopLive();
  const currentSession = ++sessionId;
  startButton.disabled = true;
  liveDecision = undefined;
  liveResult.hidden = true;
  renderCombined();
  let acquiredStream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("Media capture is unavailable", "NotSupportedError");
    acquiredStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: { facingMode: "user", height: { ideal: 480 }, width: { ideal: 640 } },
    });
    if (currentSession !== sessionId) {
      acquiredStream.getTracks().forEach((track) => track.stop());
      return;
    }
    video.srcObject = acquiredStream;
    await video.play();
    if (currentSession !== sessionId) {
      acquiredStream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = acquiredStream;
    challengeText.textContent = challenges[crypto.getRandomValues(new Uint32Array(1))[0] % challenges.length];
    startedAt = performance.now();
    audioSampleCount = 0;
    activeAudioSampleCount = 0;
    motionTotal = 0;
    motionSampleCount = 0;
    previousFrame = undefined;
    completeButton.disabled = false;
    stopButton.disabled = false;
    beginMeasurements();
  } catch (error) {
    acquiredStream?.getTracks().forEach((track) => track.stop());
    if (currentSession !== sessionId) return;
    const messages = {
      NotAllowedError: "Camera or microphone permission was denied",
      NotFoundError: "A camera or microphone was not found",
      NotReadableError: "The camera or microphone could not be opened",
      NotSupportedError: "Media capture is not supported in this browser",
    };
    liveDecision = scoreLiveness({ startupError: messages[error?.name] ?? "The live activity check could not start" });
    renderDecision(liveResult, liveDecision);
    renderCombined();
    stopLive();
  }
});

completeButton.addEventListener("click", () => finishLive(true));
stopButton.addEventListener("click", () => finishLive(false));
window.addEventListener("beforeunload", stopLive);
window.addEventListener("pagehide", stopLive);

function beginMeasurements() {
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const audioData = new Uint8Array(analyser.frequencyBinCount);
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const measure = () => {
    analyser.getByteTimeDomainData(audioData);
    const level = Math.sqrt(audioData.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / audioData.length);
    audioSampleCount += 1;
    if (level >= 0.08) activeAudioSampleCount += 1;
    meter.value = Math.min(1, level * 5);

    if (video.readyState >= 2 && context) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const frame = new Uint8Array(canvas.width * canvas.height);
      for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) {
        frame[target] = Math.round((pixels[source] + pixels[source + 1] + pixels[source + 2]) / 3);
      }
      if (previousFrame) {
        let difference = 0;
        for (let index = 0; index < frame.length; index += 1) difference += Math.abs(frame[index] - previousFrame[index]);
        motionTotal += difference / (frame.length * 255);
        motionSampleCount += 1;
      }
      previousFrame = frame;
    }
    animationFrame = requestAnimationFrame(measure);
  };
  measure();
}

function finishLive(completed) {
  if (!stream) return;
  const durationSeconds = (performance.now() - startedAt) / 1000;
  const speechActivityRatio = audioSampleCount ? activeAudioSampleCount / audioSampleCount : 0;
  const visualMotion = motionSampleCount ? motionTotal / motionSampleCount : 0;
  liveDecision = scoreLiveness({ userClaimedComplete: completed, durationSeconds, speechActivityRatio, visualMotion });
  renderDecision(liveResult, liveDecision);
  renderCombined();
  stopLive();
}

function stopLive() {
  sessionId += 1;
  if (animationFrame) cancelAnimationFrame(animationFrame);
  stream?.getTracks().forEach((track) => track.stop());
  audioContext?.close().catch(() => {});
  stream = undefined;
  audioContext = undefined;
  analyser = undefined;
  animationFrame = undefined;
  video.srcObject = null;
  meter.value = 0;
  startButton.disabled = false;
  completeButton.disabled = true;
  stopButton.disabled = true;
}

function renderCombined() {
  const decisions = [uploadDecision, liveDecision].filter(Boolean);
  if (!decisions.length) {
    finalResult.className = "result result--empty";
    finalResult.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = "No decision yet";
    const detail = document.createElement("p");
    detail.textContent = "Complete both tests to calculate a final decision.";
    finalResult.append(heading, detail);
    return;
  }
  renderDecision(finalResult, combineDecisions(decisions));
}

function renderDecision(element, decision) {
  element.hidden = false;
  element.className = `result result--${decision.action}`;
  element.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = decision.risk === null
    ? decision.action.toUpperCase()
    : `${decision.action.toUpperCase()} · heuristic score ${decision.risk}/100`;
  const list = document.createElement("ul");
  decision.reasons.forEach((reason) => {
    const item = document.createElement("li");
    item.textContent = reason;
    list.append(item);
  });
  element.append(heading, list);
}

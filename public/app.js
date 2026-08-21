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
let peakAudio = 0;
let visualSamples = [];

uploadInput.addEventListener("change", async () => {
  const file = uploadInput.files?.[0];
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    uploadDecision = scoreUpload(extractSignals(new Uint8Array(), file.type, file.name), file.size);
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    uploadDecision = scoreUpload(extractSignals(bytes, file.type, file.name), file.size);
  }
  renderDecision(uploadResult, uploadDecision);
  renderCombined();
});

startButton.addEventListener("click", async () => {
  stopLive();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: { facingMode: "user", height: { ideal: 480 }, width: { ideal: 640 } },
    });
    video.srcObject = stream;
    await video.play();
    challengeText.textContent = challenges[crypto.getRandomValues(new Uint32Array(1))[0] % challenges.length];
    startedAt = performance.now();
    peakAudio = 0;
    visualSamples = [];
    startButton.disabled = true;
    completeButton.disabled = false;
    stopButton.disabled = false;
    beginMeasurements();
  } catch {
    liveDecision = scoreLiveness({ completed: false, durationSeconds: 0, permissionDenied: true, speechActivity: 0, visualChange: 0 });
    renderDecision(liveResult, liveDecision);
    renderCombined();
  }
});

completeButton.addEventListener("click", () => finishLive(true));
stopButton.addEventListener("click", () => finishLive(false));
window.addEventListener("beforeunload", stopLive);

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
    peakAudio = Math.max(peakAudio, level);
    meter.value = Math.min(1, level * 5);

    if (video.readyState >= 2 && context) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let luminance = 0;
      for (let index = 0; index < pixels.length; index += 16) {
        luminance += (pixels[index] + pixels[index + 1] + pixels[index + 2]) / (3 * 255);
      }
      visualSamples.push(luminance / (pixels.length / 16));
      if (visualSamples.length > 150) visualSamples.shift();
    }
    animationFrame = requestAnimationFrame(measure);
  };
  measure();
}

function finishLive(completed) {
  if (!stream) return;
  const durationSeconds = (performance.now() - startedAt) / 1000;
  const visualChange = visualSamples.length > 1 ? Math.max(...visualSamples) - Math.min(...visualSamples) : 0;
  liveDecision = scoreLiveness({ completed, durationSeconds, speechActivity: peakAudio, visualChange });
  renderDecision(liveResult, liveDecision);
  renderCombined();
  stopLive();
}

function stopLive() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  stream?.getTracks().forEach((track) => track.stop());
  audioContext?.close();
  stream = undefined;
  audioContext = undefined;
  analyser = undefined;
  video.srcObject = null;
  meter.value = 0;
  startButton.disabled = false;
  completeButton.disabled = true;
  stopButton.disabled = true;
}

function renderCombined() {
  const decisions = [uploadDecision, liveDecision].filter(Boolean);
  if (!decisions.length) return;
  renderDecision(finalResult, combineDecisions(decisions));
}

function renderDecision(element, decision) {
  element.hidden = false;
  element.className = `result result--${decision.action}`;
  element.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = `${decision.action.toUpperCase()} · risk ${decision.risk}/100`;
  const list = document.createElement("ul");
  decision.reasons.forEach((reason) => {
    const item = document.createElement("li");
    item.textContent = reason;
    list.append(item);
  });
  element.append(heading, list);
}

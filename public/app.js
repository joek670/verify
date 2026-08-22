import {
  MAX_FILE_BYTES,
  combineDecisions,
  createChallenge,
  extractSignals,
  matchesExpectedWords,
  scoreLiveness,
  scoreUpload,
} from "./analyzer.js";

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

const RECOGNITION_LANGUAGE = "en-US";
// `available()` is a lookup and should return immediately, but it has been observed
// hanging instead of rejecting. `install()` may genuinely download a language pack, so
// it gets far longer. A turn is bounded too: a recogniser that never fires `end` would
// otherwise leave the exchange waiting on a user who has already stopped speaking.
const AVAILABILITY_TIMEOUT_MS = 3000;
const INSTALL_TIMEOUT_MS = 20000;
const TURN_TIMEOUT_MS = 15000;

// Falls back rather than rejecting: every caller here treats a timeout as "this is not
// available", never as an error worth showing the user.
function withTimeout(promise, milliseconds, fallbackValue) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallbackValue),
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), milliseconds)),
  ]);
}

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
let recognitionAvailable = false;
let activeRecognition;
let promptSpeaking = false;

uploadInput.addEventListener("change", async () => {
  const file = uploadInput.files?.[0];
  if (!file) return;
  const currentUpload = ++uploadId;
  if (file.size > MAX_FILE_BYTES) {
    // The bytes are never read, so there are no signals to report.
    uploadDecision = scoreUpload(null, file.size);
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
  recognitionAvailable = false;
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
    challengeText.textContent = "Preparing the challenge…";
    stopButton.disabled = false;
    // Measurement and the clock start inside runChallenge, after the recogniser is
    // ready. Installing an on-device language pack can take a while, and that time is
    // neither the user's response nor a period they were expected to be speaking.
    runChallenge(currentSession);
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
    // The app speaks its prompts aloud. Through speakers that voice reaches the
    // microphone, so counting it would let the liveness check pass on its own output.
    // Echo cancellation reduces it but is tuned for duplex calls, not for zeroing it.
    if (!promptSpeaking && !window.speechSynthesis?.speaking) {
      audioSampleCount += 1;
      if (level >= 0.08) activeAudioSampleCount += 1;
    }
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

function finishLive(completed, turnResults = []) {
  if (!stream) return;
  const durationSeconds = (performance.now() - startedAt) / 1000;
  const speechActivityRatio = audioSampleCount ? activeAudioSampleCount / audioSampleCount : 0;
  const visualMotion = motionSampleCount ? motionTotal / motionSampleCount : 0;
  // The lowest confidence of the two turns is the conservative one to report. It is
  // reported only; `scoreLiveness` is not allowed to move the score with it.
  const confidences = turnResults.map(({ confidence }) => confidence).filter((value) => typeof value === "number");

  liveDecision = scoreLiveness({
    userClaimedComplete: completed,
    // Cancelling midway through a recognised exchange still scores on the recognised
    // path, with the unanswered turns unmatched, rather than reporting that
    // recognition was unavailable when it was not.
    recognitionAvailable,
    firstTurnMatched: turnResults[0]?.matched ?? false,
    secondTurnMatched: turnResults[1]?.matched ?? false,
    recognitionConfidence: confidences.length ? Math.min(...confidences) : undefined,
    durationSeconds,
    speechActivityRatio,
    visualMotion,
  });
  renderDecision(liveResult, liveDecision);
  renderCombined();
  stopLive();
}

function stopLive() {
  sessionId += 1;
  if (animationFrame) cancelAnimationFrame(animationFrame);
  activeRecognition?.abort();
  window.speechSynthesis?.cancel();
  stream?.getTracks().forEach((track) => track.stop());
  audioContext?.close().catch(() => {});
  stream = undefined;
  audioContext = undefined;
  analyser = undefined;
  animationFrame = undefined;
  activeRecognition = undefined;
  promptSpeaking = false;
  video.srcObject = null;
  meter.value = 0;
  startButton.disabled = false;
  completeButton.disabled = true;
  completeButton.hidden = true;
  stopButton.disabled = true;
}

// Absence of the on-device API is treated as unavailable rather than as permission to
// fall back to the networked recogniser: the legacy interface streams microphone audio
// to a vendor server, and nothing in this demo leaves the browser.
async function detectRecognition() {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition || typeof Recognition.available !== "function") return false;
  const options = { langs: [RECOGNITION_LANGUAGE], processLocally: true };
  try {
    const status = await withTimeout(Recognition.available(options), AVAILABILITY_TIMEOUT_MS, "unavailable");
    if (status === "available") return true;
    if (status === "unavailable" || typeof Recognition.install !== "function") return false;
    return Boolean(await withTimeout(Recognition.install(options), INSTALL_TIMEOUT_MS, false));
  } catch {
    return false;
  }
}

function speakPrompt(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = RECOGNITION_LANGUAGE;
    promptSpeaking = true;
    const finish = () => {
      promptSpeaking = false;
      resolve();
    };
    utterance.addEventListener("end", finish);
    utterance.addEventListener("error", finish);
    window.speechSynthesis.speak(utterance);
  });
}

// One recogniser per turn rather than one spanning both, so each turn ends on its own
// event and the two transcripts stay separate. Scoring the turns separately from a
// single merged transcript would mean guessing where one answer ended.
function recognizeTurn() {
  return new Promise((resolve) => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const recognition = new Recognition();
    recognition.lang = RECOGNITION_LANGUAGE;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    if ("processLocally" in recognition) recognition.processLocally = true;

    let settled = false;
    let timer;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      recognition.abort();
      settle({ text: "" });
    }, TURN_TIMEOUT_MS);

    recognition.addEventListener("result", (event) => {
      const alternative = event.results[event.results.length - 1]?.[0];
      settle({ text: alternative?.transcript ?? "", confidence: alternative?.confidence });
    });
    recognition.addEventListener("error", () => settle({ text: "" }));
    recognition.addEventListener("end", () => settle({ text: "" }));

    activeRecognition = recognition;
    // Recognising the track `getUserMedia` already returned keeps the meter and the
    // transcript on the same audio. Where the argument is not supported, the recogniser
    // opens its own capture instead, which still works but observes different audio.
    const track = stream?.getAudioTracks()[0];
    try {
      if (track) recognition.start(track);
      else recognition.start();
    } catch {
      try {
        recognition.start();
      } catch {
        settle({ text: "" });
      }
    }
  });
}

async function runChallenge(currentSession) {
  const challenge = createChallenge();
  recognitionAvailable = await detectRecognition();
  if (currentSession !== sessionId) return;

  startedAt = performance.now();
  audioSampleCount = 0;
  activeAudioSampleCount = 0;
  motionTotal = 0;
  motionSampleCount = 0;
  previousFrame = undefined;
  beginMeasurements();

  if (!recognitionAvailable) {
    // Nothing can end the check on its own here, so the manual control comes back.
    challengeText.textContent = challenge.firstTurn.prompt;
    completeButton.hidden = false;
    completeButton.disabled = false;
    await speakPrompt(challenge.firstTurn.prompt);
    return;
  }

  const turnResults = [];
  for (const turn of [challenge.firstTurn, challenge.secondTurn]) {
    challengeText.textContent = turn.prompt;
    await speakPrompt(turn.prompt);
    if (currentSession !== sessionId) return;
    const heard = await recognizeTurn();
    if (currentSession !== sessionId) return;
    turnResults.push({ matched: matchesExpectedWords(heard.text, turn.expectedWords), confidence: heard.confidence });
  }
  finishLive(true, turnResults);
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

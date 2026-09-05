import {
  MAX_FILE_BYTES,
  combineDecisions,
  createChallenge,
  extractSignals,
  matchesExpectedWords,
  measureResponseSeconds,
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
const trialLabel = document.querySelector("#trial-label");
const trialReceipt = document.querySelector("#trial-receipt");
const trialJson = document.querySelector("#trial-json");
const trialLogStatus = document.querySelector("#trial-log-status");
const copyTrialButton = document.querySelector("#copy-trial");

const RECOGNITION_LANGUAGE = "en-US";
// RMS level a sample must reach to count as speech rather than room noise. It is a
// guess, like the window's upper bound was, so the peak and mean levels a run actually
// produced are recorded next to it instead of only the verdict it reached.
const SPEECH_LEVEL = 0.08;
// `available()` is a lookup and should return immediately, but it has been observed
// hanging instead of rejecting. `install()` may genuinely download a language pack, so
// it gets far longer. A turn is bounded too: a recogniser that never fires `end` would
// otherwise leave the exchange waiting on a user who has already stopped speaking.
const AVAILABILITY_TIMEOUT_MS = 3000;
const INSTALL_TIMEOUT_MS = 20000;
const TURN_TIMEOUT_MS = 15000;
// Quiet gap after a segment that ends a turn whose answer is still incomplete. Long
// enough to be a pause between words rather than the end of an answer.
const ANSWER_GAP_MS = 2000;

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
let audioLevelTotal = 0;
let peakAudioLevel = 0;
let motionTotal = 0;
let motionSampleCount = 0;
let previousFrame;
let sessionId = 0;
let uploadId = 0;
let recognitionAvailable = false;
let activeRecognition;
let promptSpeaking = false;
let spokenPromptMs = 0;
// Silence the recogniser waited through after the speaker had already stopped. A turn
// whose answer is incomplete ends `ANSWER_GAP_MS` after the last thing it heard, and
// that gap is the app waiting, not the user holding the floor. Excluded for the same
// reason the spoken prompts are.
let answerGapMs = 0;
let challengeStarted = false;

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
  trialReceipt.hidden = true;
  // Locked for the duration of the run. A label that can still be changed once the
  // decision is on screen is not ground truth, it is a reaction to the outcome.
  trialLabel.disabled = true;
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
    // An unhandled rejection here would leave the panel stuck on "Preparing the
    // challenge" with no decision and no way forward except Cancel.
    runChallenge(currentSession).catch(() => {
      if (currentSession !== sessionId) return;
      publishLiveDecision(scoreLiveness({ startupError: "The live activity check could not run the challenge" }));
    });
  } catch (error) {
    acquiredStream?.getTracks().forEach((track) => track.stop());
    if (currentSession !== sessionId) return;
    const messages = {
      NotAllowedError: "Camera or microphone permission was denied",
      NotFoundError: "A camera or microphone was not found",
      NotReadableError: "The camera or microphone could not be opened",
      NotSupportedError: "Media capture is not supported in this browser",
    };
    publishLiveDecision(scoreLiveness({ startupError: messages[error?.name] ?? "The live activity check could not start" }));
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
      audioLevelTotal += level;
      if (level > peakAudioLevel) peakAudioLevel = level;
      if (level >= SPEECH_LEVEL) activeAudioSampleCount += 1;
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

// A decision cannot measure accuracy on its own: the gate reports `review` whether the
// run was genuine, relayed, or synthetic. Accuracy is decisions compared against ground
// truth, so every trial carries the label the operator asserted before starting, and
// every attempt is recorded — including one that never got as far as a challenge, so the
// denominator of a trial series stays honest.
function recordTrial(decision, measurements) {
  const trial = {
    at: new Date().toISOString(),
    label: trialLabel.value,
    action: decision.action,
    risk: decision.risk,
    ...measurements,
    userAgent: navigator.userAgent,
  };
  trialJson.textContent = JSON.stringify(trial, null, 2);
  trialReceipt.hidden = false;
  trialLogStatus.textContent = "";
  // Trial logging is opt-in on the server, so a 404 is the ordinary case and must not
  // read as a failure. The receipt above is the record either way.
  fetch("/trials", {
    body: JSON.stringify(trial),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  })
    .then((response) => {
      trialLogStatus.textContent = response.ok
        ? "Appended to the trial log on this machine"
        : "Not logged; copy the JSON to keep it";
    })
    .catch(() => {
      trialLogStatus.textContent = "Not logged; copy the JSON to keep it";
    });
}

// Every path that produces a liveness decision ends here, so a decision can never be
// shown without also being recorded as a trial.
function publishLiveDecision(decision, measurements = null) {
  liveDecision = decision;
  renderDecision(liveResult, decision);
  renderCombined();
  recordTrial(decision, measurements);
  stopLive();
}

copyTrialButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(trialJson.textContent);
    copyTrialButton.textContent = "Copied";
  } catch {
    copyTrialButton.textContent = "Copy failed; select the text";
  }
  setTimeout(() => {
    copyTrialButton.textContent = "Copy JSON";
  }, 2000);
});

function finishLive(completed, turnResults = []) {
  if (!stream) return;
  // Cancelling while the recogniser is still being prepared ends a check that never
  // began: no clock was started and no samples were taken. Scoring it would report a
  // response time measured from a previous session and silence that nobody was asked
  // to break. A check that could not run is inconclusive, not a block.
  if (!challengeStarted) {
    publishLiveDecision(scoreLiveness({ startupError: "The live activity check was cancelled before the challenge began" }));
    return;
  }
  const responseSeconds = measureResponseSeconds({
    answerGapMs,
    elapsedMs: performance.now() - startedAt,
    spokenPromptMs,
  });
  const speechActivityRatio = audioSampleCount ? activeAudioSampleCount / audioSampleCount : 0;
  const visualMotion = motionSampleCount ? motionTotal / motionSampleCount : 0;
  // The lowest confidence of the two turns is the conservative one to report. It is
  // reported only; `scoreLiveness` is not allowed to move the score with it.
  const confidences = turnResults.map(({ confidence }) => confidence).filter((value) => typeof value === "number");

  const inputs = {
    userClaimedComplete: completed,
    // Cancelling midway through a recognised exchange still scores on the recognised
    // path, with the unanswered turns unmatched, rather than reporting that
    // recognition was unavailable when it was not.
    recognitionAvailable,
    firstTurnMatched: turnResults[0]?.matched ?? false,
    secondTurnMatched: turnResults[1]?.matched ?? false,
    recognitionConfidence: confidences.length ? Math.min(...confidences) : undefined,
    responseSeconds,
    speechActivityRatio,
    visualMotion,
  };
  // The same inputs the score was computed from, rounded for the log rather than for the
  // score. The response time is the reason this record exists: the window's upper bound
  // is an estimate, and only measured runs can correct it.
  publishLiveDecision(scoreLiveness(inputs), {
    ...inputs,
    recognitionConfidence: inputs.recognitionConfidence ?? null,
    responseSeconds: Number(responseSeconds.toFixed(2)),
    speechActivityRatio: Number(speechActivityRatio.toFixed(3)),
    visualMotion: Number(visualMotion.toFixed(4)),
    // What each signal was derived from, not just the verdict it reached. A ratio of 0
    // says nothing about whether the microphone was silent, whether the threshold is set
    // too high, or whether the samples were never taken; these three separate those.
    audioSampleCount,
    peakAudioLevel: Number(peakAudioLevel.toFixed(3)),
    meanAudioLevel: Number((audioSampleCount ? audioLevelTotal / audioSampleCount : 0).toFixed(3)),
    speechLevelThreshold: SPEECH_LEVEL,
    // The two corrections applied to the wall clock before it became `responseSeconds`.
    // The window's upper bound is judged against that number, so a series cannot correct
    // the bound without being able to see what was taken off the clock to produce it.
    spokenPromptSeconds: Number((spokenPromptMs / 1000).toFixed(2)),
    answerGapSeconds: Number((answerGapMs / 1000).toFixed(2)),
    motionSampleCount,
    // An unmatched turn can mean the words were wrong or that nothing was heard at all,
    // and the score cannot tell those apart. The transcript can.
    turns: turnResults.map(({ expected, matched, text }) => ({ expected, heard: text ?? "", matched })),
  });
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
  challengeStarted = false;
  video.srcObject = null;
  meter.value = 0;
  startButton.disabled = false;
  completeButton.disabled = true;
  completeButton.hidden = true;
  stopButton.disabled = true;
  trialLabel.disabled = false;
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
    const startedSpeakingAt = performance.now();
    const finish = () => {
      if (promptSpeaking) spokenPromptMs += performance.now() - startedSpeakingAt;
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
// A turn is an answer of several words, so the recogniser is not allowed to end the turn
// at the first pause. `continuous = false` did exactly that: it returned one segment and
// stopped, so a three word phrase could only ever arrive one word short and no answer
// could match. Segments are accumulated instead, and the turn ends when the answer is
// complete, when the speaker has been quiet long enough to have finished, or at the cap.
function recognizeTurn(expectedWords) {
  return new Promise((resolve) => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const recognition = new Recognition();
    recognition.lang = RECOGNITION_LANGUAGE;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    if ("processLocally" in recognition) recognition.processLocally = true;

    const segments = [];
    let confidence;
    let settled = false;
    let capTimer;
    let gapTimer;
    let lastSegmentAt;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(capTimer);
      clearTimeout(gapTimer);
      resolve(value);
    };
    // Everything heard so far, however many segments it arrived in, and how long the
    // turn went on after the last of it. A turn that heard nothing reports no trailing
    // silence: the user held the floor for all of it and said nothing, which is a real
    // measurement rather than the app waiting.
    const finish = () => settle({
      confidence,
      text: segments.join(" "),
      trailingSilenceMs: lastSegmentAt === undefined ? 0 : Math.max(0, performance.now() - lastSegmentAt),
    });

    capTimer = setTimeout(() => {
      recognition.abort();
      finish();
    }, TURN_TIMEOUT_MS);

    recognition.addEventListener("result", (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const alternative = event.results[index].isFinal ? event.results[index][0] : undefined;
        if (!alternative) continue;
        segments.push(alternative.transcript);
        lastSegmentAt = performance.now();
        // The lowest of the segments, for the same reason the lowest of the two turns is
        // reported: it is the conservative one, and it never moves the score either way.
        if (typeof alternative.confidence === "number") {
          confidence = confidence === undefined ? alternative.confidence : Math.min(confidence, alternative.confidence);
        }
      }
      // Every requested word is in, so the answer is complete and there is nothing to
      // wait for. Ending here also keeps the silence after an answer out of the
      // response time.
      if (matchesExpectedWords(segments.join(" "), expectedWords)) {
        recognition.stop();
        finish();
        return;
      }
      clearTimeout(gapTimer);
      gapTimer = setTimeout(() => {
        recognition.stop();
        finish();
      }, ANSWER_GAP_MS);
    });
    recognition.addEventListener("error", () => finish());
    recognition.addEventListener("end", () => finish());

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
        finish();
      }
    }
  });
}

async function runChallenge(currentSession) {
  const challenge = createChallenge();
  recognitionAvailable = await detectRecognition();
  if (currentSession !== sessionId) return;

  startedAt = performance.now();
  spokenPromptMs = 0;
  answerGapMs = 0;
  challengeStarted = true;
  audioSampleCount = 0;
  activeAudioSampleCount = 0;
  audioLevelTotal = 0;
  peakAudioLevel = 0;
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
    const heard = await recognizeTurn(turn.expectedWords);
    if (currentSession !== sessionId) return;
    answerGapMs += heard.trailingSilenceMs;
    turnResults.push({
      confidence: heard.confidence,
      matched: matchesExpectedWords(heard.text, turn.expectedWords),
      text: heard.text,
      expected: turn.expectedWords,
    });
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

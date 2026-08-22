export const MAX_FILE_BYTES = 50 * 1024 * 1024;

// A browser activity check is not authoritative even when it recognizes the spoken
// words: recognition happens on the same device that is being questioned, the requested
// movement is never checked, and a live attacker can still relay the exchange. Only a
// server verified challenge bound to a signed nonce would change that. Its risk never
// falls below this floor, so a liveness check alone can never produce `allow`.
export const LIVENESS_FLOOR_RISK = 35;

// Covers the whole exchange as wall clock time, including the spoken prompts. Measured
// on Chrome 151, speaking both prompts alone takes 8.7 to 9.7 seconds, and a typical
// answered exchange lands near 20 seconds once the two replies and the recogniser's
// end-of-speech detection are included.
//
// The minimum is therefore only meaningful on the fallback path, where one prompt is
// spoken and an instant "complete" click is what it catches. On the recognised path
// nothing can finish that quickly, so the lower bound never fires. Measuring the user's
// own response time instead of wall clock would fix that, at the cost of a change to
// what this term means.
export const CHALLENGE_WINDOW_SECONDS = { minimum: 5, maximum: 50 };

const MEDIA_FORMATS = {
  "image/jpeg": { extensions: ["jpg", "jpeg"], mimeTypes: ["image/jpeg"] },
  "image/png": { extensions: ["png"], mimeTypes: ["image/png"] },
  "audio/wav": { extensions: ["wav"], mimeTypes: ["audio/wav", "audio/x-wav", "audio/wave"] },
  "audio/mpeg": { extensions: ["mp3"], mimeTypes: ["audio/mpeg", "audio/mp3"] },
  "audio/ogg": { extensions: ["ogg", "oga"], mimeTypes: ["audio/ogg"] },
};

// These specific tool identifiers are weak, unauthenticated evidence. Generic words
// such as "prompt", "openai", and editor names intentionally do not count.
const GENERATOR_MARKERS = [
  "automatic1111",
  "comfyui",
  "dall-e 2",
  "dall-e 3",
  "generative fill",
  "invokeai",
  "midjourney bot",
  "stable diffusion",
  "suno.ai",
  "udio.com",
];

const C2PA_MARKERS = ["c2pa", "content credentials"];

const SCAN_MARKERS = [...GENERATOR_MARKERS, ...C2PA_MARKERS];
const SCAN_CHUNK_BYTES = 1 << 20;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Scans in bounded, overlapping chunks so a 50 MB upload never allocates a 50 M
// character string. The overlap is the longest marker minus one, so no marker can
// hide on a chunk boundary.
function findMarkers(bytes, markers) {
  const decoder = new TextDecoder("latin1");
  const overlap = Math.max(...markers.map((marker) => marker.length)) - 1;
  const found = new Set();
  let remaining = markers;

  for (let start = 0; start < bytes.length && remaining.length; start += SCAN_CHUNK_BYTES) {
    const chunk = decoder.decode(bytes.subarray(start, start + SCAN_CHUNK_BYTES + overlap)).toLowerCase();
    remaining = remaining.filter((marker) => {
      if (!chunk.includes(marker)) return true;
      found.add(marker);
      return false;
    });
  }
  return markers.filter((marker) => found.has(marker));
}

// MPEG audio frame header: an 11 bit sync word followed by version, layer, bitrate,
// and sample rate fields. Checking the fields rather than a list of literal sync bytes
// accepts MPEG-2.5 and Layer II frames while still rejecting AAC ADTS, which reuses
// the sync word with the reserved layer value.
function isMpegAudioFrame(bytes) {
  if (bytes.length < 3) return false;
  const [first, second, third] = bytes;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return false;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  const bitrateIndex = (third >> 4) & 0x0f;
  const sampleRateIndex = (third >> 2) & 0x03;
  return version !== 0x01 && layer !== 0x00 && bitrateIndex !== 0x0f && sampleRateIndex !== 0x03;
}

export function sniffMediaType(bytes) {
  const hex = [...bytes.slice(0, 12)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const text = new TextDecoder("latin1").decode(bytes.slice(0, 16)).toLowerCase();
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (text.startsWith("riff") && text.slice(8, 12) === "wave") return "audio/wav";
  if (text.startsWith("id3") || isMpegAudioFrame(bytes)) return "audio/mpeg";
  if (text.startsWith("oggs")) return "audio/ogg";
  return "unknown";
}

export function extractSignals(bytes, declaredType = "", fileName = "") {
  const sniffedType = sniffMediaType(bytes);
  const format = MEDIA_FORMATS[sniffedType];
  const extension = fileName.includes(".") ? fileName.toLowerCase().split(".").pop() : "";
  const matched = findMarkers(bytes, SCAN_MARKERS);

  return {
    declaredType: declaredType.toLowerCase(),
    extension,
    hasC2paText: matched.some((marker) => C2PA_MARKERS.includes(marker)),
    matchedGeneratorMarkers: matched.filter((marker) => GENERATOR_MARKERS.includes(marker)),
    sniffedType,
    // A missing extension is not a mismatch. Pasted, dragged, and downloaded files
    // routinely arrive without one, so the check is skipped rather than failed.
    extensionMismatch: Boolean(format && extension && !format.extensions.includes(extension)),
    mimeMismatch: Boolean(format && declaredType && !format.mimeTypes.includes(declaredType.toLowerCase())),
  };
}

export function scoreUpload(signals, fileSize) {
  // Checked before anything else, because an oversized file is never read. Reporting
  // signature or metadata findings here would describe a check that never ran.
  if (fileSize > MAX_FILE_BYTES) {
    return buildDecision(null, ["File exceeds the 50 MB inspection limit, so its contents were not inspected"], "upload", "inconclusive");
  }

  const validationReasons = [];
  if (signals.sniffedType === "unknown") validationReasons.push("The file signature is not a supported image or audio format");
  if (signals.mimeMismatch) validationReasons.push("The declared MIME type does not match the detected format");
  if (signals.extensionMismatch) validationReasons.push("The filename extension does not match the detected format");

  if (validationReasons.length) {
    return buildDecision(null, validationReasons, "upload", "inconclusive");
  }

  let score = 10;
  const reasons = [];
  if (signals.matchedGeneratorMarkers.length) {
    score += 35;
    reasons.push(`Unauthenticated generator marker found: ${signals.matchedGeneratorMarkers.join(", ")}`);
  } else {
    reasons.push("No specific generator marker was found; this does not prove the media is human-made");
  }
  if (signals.hasC2paText) {
    reasons.push("Content Credentials-like text was found but not validated; it does not change the score");
  }
  if (!signals.extension) {
    reasons.push("The filename has no extension, so the extension check was skipped");
  }
  return buildDecision(score, reasons, "upload");
}

// Word lists rather than a fixed list of phrases. A fixed list is a replay corpus: once
// the response is actually checked, an attacker only has to record every phrase in it.
// These lists are deliberately disjoint, so the second turn's new word can never collide
// with a word the first turn already asked for.
const CHALLENGE_ADJECTIVES = ["amber", "blue", "copper", "crimson", "golden", "green", "quiet", "silver"];
const CHALLENGE_NOUNS = ["anchor", "canyon", "harbor", "lantern", "meadow", "moon", "pine", "river"];
const CHALLENGE_NUMBERS = ["three", "four", "five", "six", "seven", "eight", "nine"];
const CHALLENGE_EXTRA_WORDS = ["garden", "marble", "orange", "paper", "planet", "signal", "thunder", "window"];
const CHALLENGE_MOVEMENTS = ["turn your head left", "raise your right hand", "blink twice", "look up"];
const ORDINALS = ["first", "second", "third"];
const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function defaultRandomIndex(limit) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % limit;
}

// The second turn asks for a word from the first, so a recording made before the first
// turn was issued cannot answer it. This is what a fixed phrase list cannot do, and it
// is the only part of this check that resists replay at all. Selective recall is used
// rather than arithmetic on purpose: a gate should not double as a numeracy test.
export function createChallenge(randomIndex = defaultRandomIndex) {
  const pick = (list) => list[randomIndex(list.length)];
  const words = [pick(CHALLENGE_ADJECTIVES), pick(CHALLENGE_NOUNS), pick(CHALLENGE_NUMBERS)];
  const recallIndex = randomIndex(words.length);
  const extraWord = pick(CHALLENGE_EXTRA_WORDS);

  return {
    firstTurn: {
      prompt: `Say: ${words.join(" ")}, then ${pick(CHALLENGE_MOVEMENTS)}.`,
      expectedWords: words,
    },
    secondTurn: {
      prompt: `Now say only the ${ORDINALS[recallIndex]} word again, then say: ${extraWord}.`,
      expectedWords: [words[recallIndex], extraWord],
    },
  };
}

// Recognisers punctuate and capitalise unpredictably and return "7" as readily as
// "seven", so the raw transcript is never compared directly.
export function normalizeSpokenText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .flatMap((token) => (/^\d+$/.test(token) ? [...token].map((digit) => DIGIT_WORDS[Number(digit)]) : [token]));
}

// Order insensitive presence, not an exact transcript match. A recogniser that inserts
// a filler word should not fail an honest speaker, but every requested word must appear.
export function matchesExpectedWords(transcript, expectedWords) {
  if (!expectedWords?.length) return false;
  const spoken = new Set(normalizeSpokenText(transcript));
  return expectedWords.every((word) => {
    const tokens = normalizeSpokenText(word);
    return tokens.length > 0 && tokens.every((token) => spoken.has(token));
  });
}

export function scoreLiveness({
  userClaimedComplete,
  recognitionAvailable = false,
  firstTurnMatched = false,
  secondTurnMatched = false,
  recognitionConfidence,
  durationSeconds,
  speechActivityRatio,
  visualMotion,
  startupError,
}) {
  if (startupError) return buildDecision(null, [startupError], "liveness", "inconclusive");

  // Penalties are additive from the floor and sum to exactly 100, so each failing
  // signal stays distinguishable instead of saturating at `block`. Recognition splits
  // the 30 point response term evenly across the two turns rather than adding a new
  // term, so the budget still totals 100 on both the recognized and fallback paths.
  let score = LIVENESS_FLOOR_RISK;
  const reasons = [
    recognitionAvailable
      ? "The spoken words were recognized on this device, but this check does not verify the requested movement and cannot rule out a relayed response"
      : "This activity check does not verify the displayed words or movement and cannot rule out replay",
    `This check is not authoritative, so it never scores below ${LIVENESS_FLOOR_RISK} and cannot produce allow on its own`,
  ];

  if (recognitionAvailable) {
    if (firstTurnMatched) {
      reasons.push("The first challenge phrase was recognized");
    } else {
      score += 15;
      reasons.push("The first challenge phrase was not recognized");
    }
    if (secondTurnMatched) {
      reasons.push("The recall turn was answered, so a recording made before this challenge was issued would not have passed");
    } else {
      score += 15;
      reasons.push("The recall turn was not answered");
    }
    // Recogniser confidence is an uncalibrated vendor number, so it is reported for the
    // same reason C2PA-like text is: visible evidence that is not allowed to move a score.
    if (typeof recognitionConfidence === "number") {
      reasons.push(`The recognizer reported ${recognitionConfidence.toFixed(2)} confidence; this number is uncalibrated and does not change the score`);
    }
  } else if (userClaimedComplete) {
    reasons.push("On-device speech recognition was unavailable, so the spoken response was not checked; the user marked the challenge complete instead");
  } else {
    score += 30;
    reasons.push("On-device speech recognition was unavailable and the user did not mark the challenge complete");
  }

  if (durationSeconds >= CHALLENGE_WINDOW_SECONDS.minimum && durationSeconds <= CHALLENGE_WINDOW_SECONDS.maximum) {
    reasons.push("The response arrived inside the expected time window");
  } else {
    score += 12;
    reasons.push(`The whole exchange was outside the ${CHALLENGE_WINDOW_SECONDS.minimum} to ${CHALLENGE_WINDOW_SECONDS.maximum} second window`);
  }
  // Measured only while the prompt is not being spoken, otherwise the app's own voice
  // carries this signal through the speakers and the check passes on its own output.
  if (speechActivityRatio >= 0.15) {
    reasons.push("Sustained microphone activity was detected while the prompt was not being spoken");
  } else {
    score += 12;
    reasons.push("Sustained microphone activity was not detected while the prompt was not being spoken");
  }
  if (visualMotion >= 0.025) {
    reasons.push("Frame-to-frame visual activity was detected");
  } else {
    score += 11;
    reasons.push("Frame-to-frame visual activity was not detected");
  }
  return buildDecision(score, reasons, "liveness");
}

export function buildDecision(score, reasons, source, forcedAction) {
  if (forcedAction === "inconclusive") return { action: "inconclusive", reasons, risk: null, source };
  const risk = clamp(Math.round(score), 0, 100);
  const action = risk >= 70 ? "block" : risk >= 35 ? "review" : "allow";
  return { action, reasons, risk, source };
}

export function combineDecisions(decisions) {
  const upload = decisions.find(({ source }) => source === "upload");
  const liveness = decisions.find(({ source }) => source === "liveness");
  if (!upload || !liveness) {
    return buildDecision(null, ["Complete both the file inspection and live activity check for a final decision"], "combined", "inconclusive");
  }

  const reasons = [...upload.reasons, ...liveness.reasons];
  const blocking = [upload, liveness].filter(({ action }) => action === "block");
  // A check that could not run must never erase a definitive block from the other
  // check, otherwise denying camera permission would soften a blocked upload.
  if (blocking.length) {
    return buildDecision(Math.max(...blocking.map(({ risk }) => risk)), reasons, "combined");
  }
  if ([upload, liveness].some(({ action }) => action === "inconclusive")) {
    return buildDecision(null, reasons, "combined", "inconclusive");
  }
  return buildDecision(Math.max(upload.risk, liveness.risk), reasons, "combined");
}

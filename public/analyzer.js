export const MAX_FILE_BYTES = 50 * 1024 * 1024;

// An unverified browser activity check is not authoritative: it does not recognize the
// spoken phrase or the requested movement, and it cannot detect replay. Its risk never
// falls below this floor, so a liveness check alone can never produce `allow`.
export const LIVENESS_FLOOR_RISK = 35;

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

export function scoreLiveness({
  userClaimedComplete,
  durationSeconds,
  speechActivityRatio,
  visualMotion,
  startupError,
}) {
  if (startupError) return buildDecision(null, [startupError], "liveness", "inconclusive");

  // Penalties are additive from the floor and sum to exactly 100, so each failing
  // signal stays distinguishable instead of saturating at `block`.
  let score = LIVENESS_FLOOR_RISK;
  const reasons = [
    "This activity check does not verify the displayed words or movement and cannot rule out replay",
    `Because the response is unverified, this check never scores below ${LIVENESS_FLOOR_RISK} and cannot produce allow on its own`,
  ];
  if (userClaimedComplete) {
    reasons.push("The user marked the challenge complete; the response itself was not recognized");
  } else {
    score += 30;
    reasons.push("The user did not mark the challenge complete");
  }
  if (durationSeconds >= 3 && durationSeconds <= 20) {
    reasons.push("The response arrived inside the expected time window");
  } else {
    score += 12;
    reasons.push("The response was outside the 3 to 20 second time window");
  }
  if (speechActivityRatio >= 0.15) {
    reasons.push("Sustained microphone activity was detected");
  } else {
    score += 12;
    reasons.push("Sustained microphone activity was not detected");
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

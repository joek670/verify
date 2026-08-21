export const MAX_FILE_BYTES = 50 * 1024 * 1024;

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

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function decodedText(bytes) {
  return new TextDecoder("latin1").decode(bytes).toLowerCase();
}

export function sniffMediaType(bytes) {
  const hex = [...bytes.slice(0, 12)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const text = decodedText(bytes.slice(0, 16));
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (text.startsWith("riff") && text.slice(8, 12) === "wave") return "audio/wav";
  if (text.startsWith("id3") || hex.startsWith("fff2") || hex.startsWith("fff3") || hex.startsWith("fffa") || hex.startsWith("fffb")) return "audio/mpeg";
  if (text.startsWith("oggs")) return "audio/ogg";
  return "unknown";
}

export function extractSignals(bytes, declaredType = "", fileName = "") {
  const text = decodedText(bytes);
  const sniffedType = sniffMediaType(bytes);
  const format = MEDIA_FORMATS[sniffedType];
  const extension = fileName.includes(".") ? fileName.toLowerCase().split(".").pop() : "";

  return {
    declaredType: declaredType.toLowerCase(),
    extension,
    hasC2paText: text.includes("c2pa") || text.includes("content credentials"),
    matchedGeneratorMarkers: GENERATOR_MARKERS.filter((marker) => text.includes(marker)),
    sniffedType,
    extensionMismatch: Boolean(format && !format.extensions.includes(extension)),
    mimeMismatch: Boolean(format && declaredType && !format.mimeTypes.includes(declaredType.toLowerCase())),
  };
}

export function scoreUpload(signals, fileSize) {
  const validationReasons = [];
  if (fileSize > MAX_FILE_BYTES) validationReasons.push("File exceeds the 50 MB inspection limit");
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
  }
  if (signals.hasC2paText) {
    reasons.push("Content Credentials-like text was found but not validated; it does not change the score");
  }
  if (!signals.matchedGeneratorMarkers.length) {
    reasons.push("No specific generator marker was found; this does not prove the media is human-made");
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

  let score = 65;
  const reasons = ["This activity check does not verify the displayed words or movement and cannot rule out replay"];
  if (!userClaimedComplete) {
    score += 40;
    reasons.push("The user did not mark the challenge complete");
  } else {
    reasons.push("The user marked the challenge complete; the response itself was not recognized");
  }
  if (durationSeconds >= 3 && durationSeconds <= 20) {
    score -= 10;
    reasons.push("The response arrived inside the expected time window");
  } else {
    score += 20;
    reasons.push("The response was outside the 3 to 20 second time window");
  }
  if (speechActivityRatio >= 0.15) {
    score -= 10;
    reasons.push("Sustained microphone activity was detected");
  } else {
    score += 25;
    reasons.push("Sustained microphone activity was not detected");
  }
  if (visualMotion >= 0.025) {
    score -= 10;
    reasons.push("Frame-to-frame visual activity was detected");
  } else {
    score += 25;
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
  if (upload.action === "inconclusive" || liveness.action === "inconclusive") {
    return buildDecision(null, [...upload.reasons, ...liveness.reasons], "combined", "inconclusive");
  }
  const highest = Math.max(upload.risk, liveness.risk);
  return buildDecision(highest, [...upload.reasons, ...liveness.reasons], "combined");
}

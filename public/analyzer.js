export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const AI_MARKERS = [
  "automatic1111",
  "comfyui",
  "dall-e",
  "firefly",
  "flux",
  "generative fill",
  "invokeai",
  "midjourney",
  "openai",
  "prompt",
  "stable diffusion",
  "suno",
  "udio",
];

const EDITOR_MARKERS = ["adobe", "canva", "gimp", "photoshop"];

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
  if (text.startsWith("id3") || hex.startsWith("fff3") || hex.startsWith("fffb")) return "audio/mpeg";
  if (text.startsWith("ogg")) return "audio/ogg";
  if (text.includes("ftyp")) return "audio/mp4";
  if (hex.startsWith("1a45dfa3")) return "audio/webm";
  return "unknown";
}

export function extractSignals(bytes, declaredType = "", fileName = "") {
  const text = decodedText(bytes);
  const matchedAiMarkers = AI_MARKERS.filter((marker) => text.includes(marker));
  const matchedEditorMarkers = EDITOR_MARKERS.filter((marker) => text.includes(marker));
  const hasC2paClaim = text.includes("c2pa") || text.includes("content credentials");
  const hasSignedClaim = hasC2paClaim && (text.includes("signature") || text.includes("manifest"));
  const sniffedType = sniffMediaType(bytes);
  const declaredFamily = declaredType.split("/")[0];
  const sniffedFamily = sniffedType.split("/")[0];
  const extension = fileName.toLowerCase().split(".").pop();
  const suspiciousExtension = !["jpg", "jpeg", "png", "wav", "mp3", "ogg", "m4a", "mp4", "webm"].includes(extension ?? "");

  return {
    declaredType,
    hasC2paClaim,
    hasSignedClaim,
    matchedAiMarkers,
    matchedEditorMarkers,
    sniffedType,
    suspiciousExtension,
    typeMismatch: Boolean(declaredFamily && sniffedFamily && sniffedFamily !== "unknown" && declaredFamily !== sniffedFamily),
  };
}

export function scoreUpload(signals, fileSize) {
  let score = 15;
  const reasons = [];

  if (fileSize > MAX_FILE_BYTES) {
    score += 80;
    reasons.push("File exceeds the 50 MB inspection limit");
  }
  if (signals.sniffedType === "unknown") {
    score += 35;
    reasons.push("The file signature is not a supported image or audio format");
  }
  if (signals.typeMismatch) {
    score += 55;
    reasons.push("The declared media type does not match the file signature");
  }
  if (signals.suspiciousExtension) {
    score += 20;
    reasons.push("The filename extension is not on the media allowlist");
  }
  if (signals.matchedAiMarkers.length) {
    score += 55;
    reasons.push(`Generation metadata found: ${signals.matchedAiMarkers.join(", ")}`);
  }
  if (signals.matchedEditorMarkers.length) {
    score += 15;
    reasons.push(`Editing software metadata found: ${signals.matchedEditorMarkers.join(", ")}`);
  }
  if (signals.hasC2paClaim && !signals.hasSignedClaim) {
    score += 20;
    reasons.push("Content Credentials marker found, but this demo cannot validate its signature");
  }
  if (signals.hasSignedClaim) {
    score -= 10;
    reasons.push("Content Credentials data found; use a trusted C2PA validator before allowing it");
  }
  if (!reasons.length) reasons.push("No obvious generation metadata was found");

  return buildDecision(score, reasons, "upload");
}

export function scoreLiveness({ completed, durationSeconds, speechActivity, visualChange, permissionDenied = false }) {
  let score = 70;
  const reasons = [];

  if (permissionDenied) {
    return buildDecision(100, ["Camera or microphone permission was denied"], "liveness");
  }
  if (completed) {
    score -= 40;
    reasons.push("The randomized challenge was marked complete");
  } else {
    reasons.push("The randomized challenge was not completed");
  }
  if (durationSeconds >= 3 && durationSeconds <= 20) {
    score -= 15;
    reasons.push("The response arrived inside the expected time window");
  } else {
    score += 15;
    reasons.push("The response was outside the 3 to 20 second time window");
  }
  if (speechActivity >= 0.08) {
    score -= 15;
    reasons.push("Microphone activity changed during the challenge");
  } else {
    score += 20;
    reasons.push("No meaningful microphone activity was detected");
  }
  if (visualChange >= 0.03) {
    score -= 15;
    reasons.push("Camera frames changed during the challenge");
  } else {
    score += 20;
    reasons.push("Camera frames did not change enough during the challenge");
  }

  return buildDecision(score, reasons, "liveness");
}

export function buildDecision(score, reasons, source) {
  const risk = clamp(Math.round(score), 0, 100);
  const action = risk >= 70 ? "block" : risk >= 35 ? "review" : "allow";
  return { action, reasons, risk, source };
}

export function combineDecisions(decisions) {
  if (!decisions.length) return buildDecision(100, ["No verification result is available"], "combined");
  const highest = Math.max(...decisions.map(({ risk }) => risk));
  const average = decisions.reduce((total, { risk }) => total + risk, 0) / decisions.length;
  return buildDecision(Math.max(highest, average), decisions.flatMap(({ reasons }) => reasons), "combined");
}

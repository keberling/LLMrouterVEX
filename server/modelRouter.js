/**
 * Multi-server model router.
 * Classifies prompts and scores (server, model) pairs for load-aware selection.
 */

const CODE_RE =
  /\b(code|coding|program|programming|function|class|method|debug|powershell|bash|shell|python|javascript|typescript|sql|script|regex|api)\b/i;
const MATH_RE =
  /\b(math|proof|theorem|integral|derivative|equation|probability|optimize)\b/i;
const REASON_RE =
  /\b(reason|analyze|compare|architecture|strategy|trade-?off|diagnose|critique)\b/i;
const SIMPLE_RE =
  /^(hi|hello|hey|thanks|ok|yes|no|what('?s|\s+is)\s+\w{1,24}\??)\b/i;
const OCR_RE =
  /\b(ocr|license|extract|read\s+the|invoice|receipt|document|id\s*number|transcribe)\b/i;
const VISION_HINT_RE =
  /\b(image|picture|photo|screenshot|diagram|describe\s+this)\b/i;

function parseParamsB(details = {}, name = "") {
  const raw = details.parameter_size || "";
  const m = String(raw).match(/([\d.]+)\s*B/i);
  if (m) return parseFloat(m[1]);
  const n = name.match(/[:\-](\d+(?:\.\d+)?)[bB]\b/);
  if (n) return parseFloat(n[1]);
  return null;
}

function profileModel(model) {
  const name = model.name || model.model || "";
  const details = model.details || {};
  const caps = new Set(model.capabilities || []);
  const tags = new Set(["general", "chat"]);
  let tier = "balanced";

  if (/qwen3-vl|qwen2\.5-?vl|qwen-vl/i.test(name)) {
    ["vision", "ocr", "thinking"].forEach((t) => tags.add(t));
    tier = "specialist";
  } else if (/qwen3\.?[56]|qwen3[56]/i.test(name)) {
    ["general", "reasoning", "code", "thinking", "vision"].forEach((t) =>
      tags.add(t)
    );
    tier = "strong";
  } else if (/gpt-oss/i.test(name)) {
    ["general", "reasoning", "code", "thinking"].forEach((t) => tags.add(t));
    tier = "strong";
  } else if (/qwen3/i.test(name)) {
    ["general", "reasoning", "code", "thinking"].forEach((t) => tags.add(t));
    tier = "strong";
  } else if (/coder|codellama|starcoder|codestral/i.test(name)) {
    tags.add("code");
    tier = "specialist";
  } else if (/llava|moondream|minicpm|pixtral|vision/i.test(name)) {
    ["vision", "ocr"].forEach((t) => tags.add(t));
    tier = "specialist";
  } else if (/gemma/i.test(name)) {
    tags.add("general");
    tier = "balanced";
  } else if (/phi|tiny|smol|1b|2b|3b|4b/i.test(name)) {
    tags.add("fast");
    tier = "fast";
  }

  if (caps.has("vision")) tags.add("vision");
  if (caps.has("thinking")) tags.add("thinking");
  if (caps.has("tools")) tags.add("tools");
  if (tags.has("vision") && /vl|vision|ocr|llava|moondream/i.test(name)) {
    tags.add("ocr");
  }

  const paramsB = parseParamsB(details, name);
  if (paramsB != null) {
    if (paramsB <= 5) tags.add("fast");
    if (paramsB >= 24) tags.add("large");
  }

  return {
    name,
    paramsB,
    parameterSize: details.parameter_size || null,
    family: details.family || null,
    quantization: details.quantization_level || null,
    capabilities: [...caps],
    tags: [...tags],
    tier,
    size: model.size || null,
  };
}

function classifyPrompt(text, { hasImages = false, think = false } = {}) {
  const t = (text || "").trim();
  const len = t.length;
  const intents = [];

  const ocr =
    hasImages &&
    (OCR_RE.test(t) ||
      (len < 160 &&
        /\b(what|read|extract|number|date|name|license|id|text)\b/i.test(t)));

  if (hasImages || VISION_HINT_RE.test(t)) intents.push("vision");
  if (ocr) intents.push("ocr");
  if (CODE_RE.test(t) || /```/.test(t)) intents.push("code");
  if (MATH_RE.test(t)) intents.push("math");
  if (REASON_RE.test(t) || think) intents.push("reasoning");
  if (SIMPLE_RE.test(t) && len < 80 && !hasImages) intents.push("simple");

  let complexity = "medium";
  if (ocr || intents.includes("simple")) complexity = "low";
  else if (
    intents.includes("math") ||
    intents.includes("reasoning") ||
    (intents.includes("code") && len > 600) ||
    len > 1500 ||
    think
  ) {
    complexity = "high";
  } else if (intents.includes("code") && len < 400) {
    complexity = "low"; // short scripts → smaller models
  }

  if (!intents.length) intents.push("chat");

  return {
    intents,
    complexity,
    length: len,
    hasImages,
    looksLikeOcr: ocr,
    wantsThinking: think || intents.includes("reasoning") || intents.includes("math"),
  };
}

function isVision(p) {
  return p.tags.includes("vision") || p.capabilities.includes("vision");
}

/**
 * Score a candidate: { server, profile, loaded, active, latencyMs, healthy }
 */
function scoreCandidate(candidate, classification) {
  const { profile, loaded, active, latencyMs, healthy, weight } = candidate;
  const { intents, complexity, looksLikeOcr } = classification;
  const tags = new Set(profile.tags);
  const params = profile.paramsB;
  let score = 10 * (weight != null ? weight : 1);
  const reasons = [];

  if (!healthy) return { score: -10000, reasons: ["unhealthy"] };

  for (const intent of intents) {
    if (intent === "code") {
      if (tags.has("code")) {
        score += 36;
        reasons.push("code");
      } else score += 10;
    } else if (intent === "reasoning" || intent === "math") {
      if (tags.has("reasoning") || tags.has("thinking")) {
        score += 30;
        reasons.push("reasoning");
      }
    } else if (intent === "vision") {
      if (isVision(profile)) {
        score += 50;
        reasons.push("vision");
      } else {
        score -= 200;
        reasons.push("no vision");
      }
    } else if (intent === "ocr") {
      if (isVision(profile)) {
        score += 20;
        if (tags.has("ocr") || /vl/i.test(profile.name)) {
          score += 30;
          reasons.push("OCR VL");
        }
        if (params != null && params <= 10) score += 22;
        if (params != null && params >= 20) score -= 45;
      }
    } else if (intent === "simple") {
      if (tags.has("fast") || (params != null && params <= 8)) score += 20;
    } else if (intent === "chat") {
      score += 12;
    }
  }

  // Prefer mid-size for normal work; avoid huge models unless complexity is high
  if (complexity === "low") {
    if (params != null) {
      if (params <= 8) score += 28;
      else if (params <= 15) score += 18;
      else if (params <= 20) score += 4;
      else {
        score -= 50;
        reasons.push("too large for simple task");
      }
    }
  } else if (complexity === "medium") {
    if (params != null) {
      if (params >= 8 && params <= 16) score += 20;
      else if (params < 8) score += 10;
      else if (params >= 24) {
        score -= 28;
        reasons.push("prefer mid-size over heavy model");
      }
    }
  } else if (complexity === "high") {
    if (params != null && params >= 14) {
      score += 18;
      reasons.push("high complexity → larger model ok");
    } else if (params != null && params < 8) score -= 8;
  }

  // Never use pure VL models for plain text
  if (isVision(profile) && !intents.includes("vision") && !intents.includes("ocr")) {
    // Allow dual-purpose models (qwen3.6 has vision+chat) but prefer non-VL when available
    if (/vl|llava|moondream|minicpm/i.test(profile.name)) {
      score -= 55;
      reasons.push("VL reserved for images");
    } else {
      score -= 12;
    }
  }

  // Prefer already-loaded model on that server (avoids VRAM thrash)
  if (loaded) {
    score += 26;
    reasons.push("already loaded");
  }

  // Load balance: fewer active generations preferred
  score -= Math.min(40, (active || 0) * 12);
  if (active > 0) reasons.push(`active:${active}`);

  // Prefer lower latency servers
  if (latencyMs != null && latencyMs > 0) {
    if (latencyMs < 80) score += 10;
    else if (latencyMs < 200) score += 4;
    else if (latencyMs > 800) score -= 15;
  }

  return { score, reasons };
}

/**
 * @param {string} promptText
 * @param {Array} candidates - list of { serverId, serverName, baseUrl, profile, loaded, active, latencyMs, healthy, weight }
 * @param {{ hasImages?: boolean, think?: boolean }} options
 */
function route(promptText, candidates, options = {}) {
  const classification = classifyPrompt(promptText, options);
  if (!candidates?.length) {
    return {
      pick: null,
      reason: "No model candidates available",
      classification,
      ranked: [],
    };
  }

  let list = candidates.map((c) => {
    const { score, reasons } = scoreCandidate(c, classification);
    return { ...c, score, reasons };
  });

  if (options.hasImages) {
    const vision = list.filter((c) => isVision(c.profile));
    if (vision.length) {
      list = [...vision, ...list.filter((c) => !isVision(c.profile))];
    }
  }

  list.sort(
    (a, b) =>
      b.score - a.score ||
      (a.profile.paramsB || 99) - (b.profile.paramsB || 99) ||
      (a.active || 0) - (b.active || 0)
  );

  const winner = list[0];
  if (options.hasImages && !isVision(winner.profile)) {
    return {
      pick: null,
      reason: "Images provided but no vision-capable model is online",
      classification,
      ranked: list.slice(0, 12),
    };
  }

  const intentLabel = classification.intents.join(", ");
  const topReasons = [...new Set(winner.reasons)].slice(0, 4).join("; ");
  const reason = `Intent: ${intentLabel} (${classification.complexity}) → ${winner.profile.name} @ ${winner.serverName} — ${topReasons}`;

  return {
    pick: {
      serverId: winner.serverId,
      serverName: winner.serverName,
      baseUrl: winner.baseUrl,
      model: winner.profile.name,
      score: winner.score,
    },
    reason,
    classification,
    ranked: list.slice(0, 12),
  };
}

function latestUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && messages[i].content) {
      const c = messages[i].content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
      }
    }
  }
  return "";
}

function messagesHaveImages(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => {
    if (Array.isArray(m.images) && m.images.length) return true;
    if (Array.isArray(m.content)) {
      return m.content.some(
        (p) => p.type === "image_url" || p.type === "image"
      );
    }
    return false;
  });
}

module.exports = {
  profileModel,
  classifyPrompt,
  route,
  latestUserText,
  messagesHaveImages,
  isVision,
};

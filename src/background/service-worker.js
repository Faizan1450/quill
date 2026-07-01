import { getSettings } from '../lib/storage.js';

console.log("Draftly service worker active");

const VALID_ICON_COLORS = ['pink', 'teal', 'crimson', 'amber', 'ocean'];

/**
 * Updates the extension action icon based on the theme color.
 * @param {string} themeColor
 */
async function updateExtensionIcon(themeColor) {
  let color = themeColor || 'pink';
  if (!VALID_ICON_COLORS.includes(color)) {
    color = 'pink';
  }
  try {
    await chrome.action.setIcon({
      path: {
        "16": `/icons/${color}/icon16.png`,
        "32": `/icons/${color}/icon32.png`,
        "48": `/icons/${color}/icon48.png`,
        "128": `/icons/${color}/icon128.png`
      }
    });
    console.log(`[Draftly] Toolbar icon set to: ${color}`);
  } catch (err) {
    console.error('[Draftly] Failed to set toolbar icon:', err);
  }
}

// Call on startup
getSettings().then(settings => {
  const themeColor = settings?.themeColor || 'pink';
  updateExtensionIcon(themeColor);
}).catch(() => {
  updateExtensionIcon('pink');
});

// Listen for themeColor change
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.themeColor) {
    updateExtensionIcon(changes.themeColor.newValue);
  }
});

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  console.log("Draftly extension installed");
});

// Open options page when clicking the extension toolbar icon
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// ============================================================
// Gemini API integration
// ============================================================

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Builds the full prompt for Gemini.
 * Instructs the model to return ONLY a JSON array of 3 comment strings.
 */
function buildPrompt({ author, body, length, guideline, tone, emoji, endWithQuestion, voiceContext, commentExamples }) {
  const lengthTargets = {
    short: '~20 words',
    medium: '~40 words',
    long: '~70 words',
  };
  const wordTarget = lengthTargets[length] || lengthTargets.medium;
  const authorName = author || 'the post author';
  const firstName = author ? author.split(' ')[0] : null;

  // Tone descriptions
  const toneDescriptions = {
    professional: "Polished and measured. Keep the voice professional but not stiff.",
    casual: "Relaxed, conversational, first-person, and friendly.",
    insightful: "Adds a sharp point, unique perspective, or thoughtful angle. A mild contrarian angle is okay if it adds value."
  };
  const toneInstruction = toneDescriptions[tone] || toneDescriptions.professional;

  // Emoji instruction
  const emojiInstruction = emoji
    ? `You MUST include 1-2 relevant emojis in each comment, chosen ONLY from this exact set. Do not omit them. Place them naturally where they fit, not forced at the start of the comment.
Allowed Emoji Set: ❤️ 💫 ❣️ 😍 😂 👀 👌 ✌🏻 ✨ 💯 ✅ 👍 👏🏻 😅 😐 🥳
EXPLICITLY BANNED EMOJIS: 🚀, 🔥, and any other generic or AI-sounding emojis not in the allowed list.`
    : "Do not use any emojis in any of the variations.";

  // Voice Customization
  const voiceInstruction = voiceContext && voiceContext.trim()
    ? `Write in the user's own voice. Here is how the user describes their writing style - match it closely:\n"${voiceContext.trim()}"`
    : "";

  let prompt = `You are drafting LinkedIn comments for a real person who genuinely read the post below and wants to add something of value. You are writing as a real professional, not a bot.

POST AUTHOR: ${authorName}
POST BODY:
""\"
${body}
""\"

TASK: Write exactly 3 distinct LinkedIn comment variations in response to this post. Each comment must be ${wordTarget} in length.

TONE & STYLE REQUIREMENT:
${toneInstruction}

EMOJI REQUIREMENT:
${emojiInstruction}
`;

  // Question instruction
  if (endWithQuestion) {
    prompt += `\nQUESTION REQUIREMENT:\nEach comment MUST end with one relevant, natural question.\n`;
  } else {
    prompt += `\nQUESTION REQUIREMENT:\nEach comment variation must end with a statement, NO question.\n`;
  }

  if (voiceInstruction) {
    prompt += `\n\nVOICE CUSTOMIZATION:\n${voiceInstruction}`;
  }

  if (Array.isArray(commentExamples) && commentExamples.length > 0) {
    prompt += `\n\nWRITING VOICE EXAMPLES:
Here are real comments the user has written. Study their tone, sentence length, rhythm, and word choice, and write the new comment in this same voice — not copying these, but matching how this person writes:`;
    commentExamples.forEach(ex => {
      prompt += `\n- "${ex.trim()}"`;
    });
  }

  prompt += `\n\nGENERAL REQUIREMENTS:
- Each variation MUST take a DIFFERENT angle. Suggested angles (pick 3 that fit the post naturally):
  • Agree and add a concrete point, example, or personal experience
  • Ask a thoughtful, specific follow-up question that shows you read the post
  • Share a brief related observation, insight, or counterpoint
  • Highlight a specific part of the post and explain why it resonated
- Reference the post's ACTUAL content — mention specific ideas, phrases, or claims from the post body. Do not write generic comments that could apply to any post.
- Address the author by first name ("${firstName || 'the author'}") where it fits naturally — not in every variation.
- Sound like a real human: conversational, direct, no corporate jargon, no buzzwords.
- NEVER use these generic fillers as standalone openers or as the entire comment: "Great post!", "Thanks for sharing", "Well said", "Couldn't agree more", "Love this", "So true". You may use similar sentiments ONLY if followed immediately by a specific, substantive point.
- NO hashtags. NO bullet points or numbered lists.
- Plain text ONLY. Absolutely NO markdown formatting of any kind, such as asterisks for bold or italics (e.g. do not write *unforeseen* or **crucial**).
- Vary sentence structure across the 3 variations. Do not start all three the same way.
- Stay within the ${wordTarget} target. Comments that are LinkedIn-appropriate in tone but not stiff.`;

  if (guideline && guideline.trim()) {
    prompt += `\n\nADDITIONAL USER GUIDELINE (OVERRIDE TONE IF CONFLICTS): ${guideline.trim()}`;
  }

  prompt += `\n\nOUTPUT FORMAT: Respond with ONLY a JSON array of exactly 3 strings. No preamble, no explanation, no markdown fences, no keys. Example format:
["comment one text here", "comment two text here", "comment three text here"]`;

  return prompt;
}

/**
 * Parses the Gemini response text into an array of 3 comment strings.
 * Handles markdown fences, whitespace, and malformed responses gracefully.
 */
function parseVariations(rawText) {
  let text = rawText.trim();

  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length >= 3 && parsed.every(s => typeof s === 'string')) {
      return { ok: true, variations: parsed.slice(0, 3) };
    }
    // If it's an array but wrong shape, try to salvage
    if (Array.isArray(parsed) && parsed.length > 0) {
      const strings = parsed.filter(s => typeof s === 'string');
      if (strings.length >= 1) {
        // Pad to 3 if needed
        while (strings.length < 3) strings.push(strings[strings.length - 1]);
        return { ok: true, variations: strings.slice(0, 3) };
      }
    }
  } catch {
    // JSON.parse failed — try fallback strategies below
  }

  // Fallback: try splitting on numbered patterns like "1." "2." "3."
  const numbered = text.split(/\n\s*\d+[\.\)]\s*/);
  const cleaned = numbered.map(s => s.trim()).filter(s => s.length > 10);
  if (cleaned.length >= 3) {
    return { ok: true, variations: cleaned.slice(0, 3) };
  }

  // Fallback: split on double newlines
  const byParagraph = text.split(/\n\n+/).map(s => s.trim()).filter(s => s.length > 10);
  if (byParagraph.length >= 3) {
    return { ok: true, variations: byParagraph.slice(0, 3) };
  }

  return { ok: false, error: "Couldn't parse the AI response. Try Regenerate." };
}

/**
 * Calls the Gemini API and returns 3 comment variations.
 * @param {object} payload - { author, body, length, guideline }
 * @returns {Promise<{ ok: boolean, variations?: string[], error?: string }>}
 */
async function callGemini(payload) {
  console.log("[Draftly] callGemini START");
  // Read API key from storage (never exposed to content script context)
  const settings = await getSettings();
  const apiKey = settings.apiKey;

  if (!apiKey) {
    return { ok: false, error: 'no-key' };
  }

  const tone = payload.tone || settings.tone || 'professional';
  const voiceContext = settings.voiceContext || '';
  const useEmoji = payload.emoji !== undefined ? payload.emoji : !!settings.emoji;
  const useQuestion = payload.endWithQuestion !== undefined ? payload.endWithQuestion : !!settings.endWithQuestion;

  const prompt = buildPrompt({
    author: payload.author,
    body: payload.body,
    length: payload.length,
    guideline: payload.guideline,
    tone,
    emoji: useEmoji,
    endWithQuestion: useQuestion,
    voiceContext,
    commentExamples: settings.commentExamples || []
  });

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 600
    },
  };

  try {
    console.log("[Draftly] callGemini: about to fetch, model: " + GEMINI_MODEL + ", key length: " + (apiKey ? apiKey.length : 0));
    const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    console.log("[Draftly] callGemini: fetch returned status " + response.status);

    if (!response.ok) {
      const status = response.status;
      console.log(`[Draftly] Gemini API error: HTTP ${status}`);
      if (status === 400 || status === 403) {
        return { ok: false, error: 'auth-error' };
      }
      if (status === 429) {
        return { ok: false, error: 'rate-limit' };
      }
      return { ok: false, error: 'api-error' };
    }

    const data = await response.json();

    // Extract generated text
    const generatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log("[Draftly] callGemini: got text, length " + (generatedText ? generatedText.length : 0));
    if (!generatedText) {
      console.log('[Draftly] Gemini returned empty/unexpected structure:', JSON.stringify(data).slice(0, 300));
      return { ok: false, error: 'empty-response' };
    }

    return parseVariations(generatedText);
  } catch (err) {
    console.log('[Draftly] Gemini network error:', err.message);
    return { ok: false, error: 'network-error' };
  }
}

// ============================================================
// Message listener
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getSettings') {
    getSettings().then((settings) => {
      // Never send the API key to the content script, but indicate if it's set
      const { apiKey, ...safeSettings } = settings;
      safeSettings.hasApiKey = !!apiKey;
      sendResponse(safeSettings);
    });
    return true;
  }

  if (message.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'generateComments') {
    console.log("[Draftly] generateComments message received");
    callGemini(message.payload).then((result) => {
      console.log("[Draftly] sending response back to content script, ok: " + result.ok);
      sendResponse(result);
    });
    return true; // Keep channel open for async response
  }
});

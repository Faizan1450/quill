export const DEFAULT_SETTINGS = {
  apiKey: "",
  tone: "professional",
  defaultLength: "medium",
  emoji: false,
  endWithQuestion: false,
  voiceContext: "",
  themeColor: "teal",
  commentExamples: [],
  themeMode: "light"
};

/**
 * Retrieves the settings from chrome.storage.local, merging with default settings.
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      resolve(items);
    });
  });
}

/**
 * Persists the settings to chrome.storage.local.
 * @param {Partial<typeof DEFAULT_SETTINGS>} settings 
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set(settings, () => {
      resolve();
    });
  });
}

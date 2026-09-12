/**
 * Tests for contrib/speakease-voices/speakease-voices.js.
 *
 * The module under test is browser code for a different product, so the four
 * browser globals it touches — `speechSynthesis`, `navigator.language`,
 * `localStorage` and `document.createElement` — are stubbed here and a
 * realistic voice roster is fed through the real implementation. Nothing in
 * this file touches the verification gate; see ./README.md for why it lives
 * in this repository.
 *
 * Node runs each test file in its own process, so the global stubs installed
 * below cannot reach the gate's own tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Rosters the real browsers ship. The third column is the gender the module
 * must report; `null` marks a non-English voice, which must be filtered out of
 * the groups rather than labelled.
 */
const ROSTER = [
  // Edge / Windows: Microsoft natural (online) voices
  ['Microsoft Aria Online (Natural) - English (United States)', 'en-US', 'female'],
  ['Microsoft Jenny Online (Natural) - English (United States)', 'en-US', 'female'],
  ['Microsoft Guy Online (Natural) - English (United States)', 'en-US', 'male'],
  ['Microsoft Davis Online (Natural) - English (United States)', 'en-US', 'male'],
  ['Microsoft Emma Online (Natural) - English (United States)', 'en-US', 'female'],
  ['Microsoft Andrew Online (Natural) - English (United States)', 'en-US', 'male'],
  ['Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB', 'female'],
  ['Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB', 'male'],
  ['Microsoft Natasha Online (Natural) - English (Australia)', 'en-AU', 'female'],
  ['Microsoft William Online (Natural) - English (Australia)', 'en-AU', 'male'],
  ['Microsoft Clara Online (Natural) - English (Canada)', 'en-CA', 'female'],
  ['Microsoft Neerja Online (Natural) - English (India)', 'en-IN', 'female'],
  ['Microsoft Prabhat Online (Natural) - English (India)', 'en-IN', 'male'],
  // Windows legacy SAPI voices
  ['Microsoft Zira Desktop - English (United States)', 'en-US', 'female'],
  ['Microsoft David Desktop - English (United States)', 'en-US', 'male'],
  ['Microsoft Mark Desktop - English (United States)', 'en-US', 'male'],
  ['Microsoft Hazel Desktop - English (Great Britain)', 'en-GB', 'female'],
  // Chrome
  ['Google US English', 'en-US', 'female'],
  ['Google UK English Female', 'en-GB', 'female'],
  ['Google UK English Male', 'en-GB', 'male'],
  // Safari / macOS / iOS
  ['Samantha', 'en-US', 'female'],
  ['Alex', 'en-US', 'male'],
  ['Daniel', 'en-GB', 'male'],
  ['Karen', 'en-AU', 'female'],
  ['Moira', 'en-IE', 'female'],
  ['Rishi', 'en-IN', 'male'],
  ['Fred', 'en-US', 'male'],
  ['Victoria', 'en-US', 'female'],
  // Android / generic — no gender is knowable from these names
  ['English United States', 'en-US', 'unknown'],
  ['eSpeak English', 'en-US', 'unknown'],
  // Non-English: must never enter the groups
  ['Microsoft Denise Online (Natural) - French (France)', 'fr-FR', null],
  ['Kyoko', 'ja-JP', null]
];

const VOICES = ROSTER.map(([name, lang]) => ({
  name,
  lang,
  voiceURI: `${name}|${lang}`,
  default: false
}));
const ENGLISH_COUNT = ROSTER.filter(([, , gender]) => gender !== null).length;

// --- browser stubs, installed before the module is loaded ------------------
const store = new Map();

function element(tag) {
  return {
    tagName: tag,
    label: '',
    value: '',
    textContent: '',
    innerHTML: '',
    children: [],
    listeners: {},
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(name, fn) { this.listeners[name] = fn; }
  };
}

globalThis.window = globalThis;
// Node >= 21 defines a read-only global `navigator`, so redefine rather than assign.
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-US' },
  configurable: true,
  writable: true
});
globalThis.speechSynthesis = { getVoices: () => VOICES };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); }
};
globalThis.document = { createElement: element };

await import(new URL('./speakease-voices.js', import.meta.url));
const V = globalThis.SpeakEaseVoices;

// --- gender detection ------------------------------------------------------
test('every voice in the roster gets the gender it should', () => {
  for (const [name, , expected] of ROSTER) {
    if (expected === null) continue; // filtered out, not labelled
    assert.equal(V.detectGender({ name }), expected, name);
  }
});

test('short name fragments do not match longer names', () => {
  // The /\bsam\b/ rule for Microsoft Sam must not reach Apple's Samantha,
  // and /\bmark\b/ must not reach a word that merely contains it.
  assert.equal(V.detectGender({ name: 'Samantha' }), 'female');
  assert.equal(V.detectGender({ name: 'Microsoft Sam' }), 'male');
  assert.equal(V.detectGender({ name: 'Remarkable Voice' }), 'unknown');
});

test('"female" is matched before "male"', () => {
  assert.equal(V.detectGender({ name: 'Google UK English Female' }), 'female');
  assert.equal(V.detectGender({ name: 'Some Female Voice' }), 'female');
  assert.equal(V.detectGender({ name: 'Some Male Voice' }), 'male');
});

test('an unmapped voice stays unknown rather than being guessed', () => {
  assert.equal(V.detectGender({ name: 'Chirp3 HD Voice 7' }), 'unknown');
  assert.equal(V.detectGender({ name: '' }), 'unknown');
  assert.equal(V.detectGender(null), 'unknown');
});

// --- grouping, filtering, ordering ----------------------------------------
test('non-English voices are excluded from the groups', async () => {
  const groups = await V.getVoiceGroups('en-US');
  const names = [...groups.female, ...groups.male, ...groups.unknown]
    .map((entry) => entry.voice.name);
  assert.ok(!names.includes('Kyoko'));
  assert.ok(names.every((n) => !n.includes('French')));
  assert.equal(names.length, ENGLISH_COUNT);
});

test('voices of unknown gender are grouped, never mislabelled', async () => {
  const groups = await V.getVoiceGroups('en-US');
  const unknown = groups.unknown.map((entry) => entry.voice.name).sort();
  assert.deepEqual(unknown, ['English United States', 'eSpeak English']);
});

test('each entry carries its own gender and score', async () => {
  const groups = await V.getVoiceGroups('en-US');
  for (const entry of groups.female) assert.equal(entry.gender, 'female');
  for (const entry of groups.male) assert.equal(entry.gender, 'male');
  assert.equal(typeof groups.female[0].score, 'number');
});

test('each group is sorted most-natural-first', async () => {
  const groups = await V.getVoiceGroups('en-US');
  for (const key of ['female', 'male', 'unknown']) {
    for (let i = 1; i < groups[key].length; i++) {
      assert.ok(
        groups[key][i - 1].score >= groups[key][i].score,
        `${key} out of order at index ${i}`
      );
    }
  }
});

test('a Natural voice outranks the legacy Desktop voice of the same gender', async () => {
  const groups = await V.getVoiceGroups('en-US');
  const aria = groups.female.findIndex((e) => /Aria/.test(e.voice.name));
  const zira = groups.female.findIndex((e) => /Zira/.test(e.voice.name));
  assert.ok(aria !== -1 && zira !== -1, 'expected both voices present');
  assert.ok(aria < zira, 'Zira (Desktop) ranked above Aria (Natural)');
});

test('the listener\'s own English locale outranks another English locale', () => {
  const us = V.naturalnessScore(
    { name: 'Microsoft Aria Online (Natural)', lang: 'en-US' }, 'en-us');
  const gb = V.naturalnessScore(
    { name: 'Microsoft Sonia Online (Natural)', lang: 'en-GB' }, 'en-us');
  assert.ok(us > gb);
});

test('a compact voice ranks below a plain one', () => {
  const compact = V.naturalnessScore({ name: 'Samantha (compact)', lang: 'en-US' }, 'en-us');
  const plain = V.naturalnessScore({ name: 'Samantha', lang: 'en-US' }, 'en-us');
  assert.ok(compact < plain);
});

test('pickDefault returns the top-ranked voice overall', async () => {
  const groups = await V.getVoiceGroups('en-US');
  assert.equal(V.pickDefault(groups).voiceURI, groups.female[0].voice.voiceURI);
});

// --- display names --------------------------------------------------------
test('vendor noise is stripped and quality badges are kept', () => {
  const cases = [
    ['Microsoft Aria Online (Natural) - English (United States)', 'en-US', 'Aria · Natural · US'],
    ['Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB', 'Sonia · Natural · UK'],
    ['Microsoft David Desktop - English (United States)', 'en-US', 'David · Classic · US'],
    ['Samantha', 'en-US', 'Samantha · US'],
    // Google's names already carry the locale, so the region is not repeated —
    // which leaves the two UK voices sharing a label. Their optgroup is what
    // tells them apart.
    ['Google UK English Female', 'en-GB', 'UK English'],
    ['Google UK English Male', 'en-GB', 'UK English'],
    ['Google US English', 'en-US', 'US English']
  ];
  for (const [name, lang, expected] of cases) {
    assert.equal(V.friendlyName({ name, lang }), expected, name);
  }
});

// --- the <select> ---------------------------------------------------------
test('the select gets one counted optgroup per non-empty group', async () => {
  const select = element('select');
  const groups = await V.populateVoiceSelect(select);
  assert.equal(select.children.length, 3);
  assert.equal(select.children[0].label, `Female voices (${groups.female.length})`);
  assert.equal(select.children[1].label, `Male voices (${groups.male.length})`);
  assert.equal(select.children[2].label, `Other voices (${groups.unknown.length})`);
});

test('every English voice is offered exactly once', async () => {
  const select = element('select');
  await V.populateVoiceSelect(select);
  const offered = select.children.flatMap((og) => og.children.map((o) => o.value));
  assert.equal(offered.length, ENGLISH_COUNT);
  assert.equal(new Set(offered).size, ENGLISH_COUNT);
});

test('with nothing saved, the default selection is the top-ranked voice', async () => {
  store.clear();
  const select = element('select');
  const groups = await V.populateVoiceSelect(select);
  assert.equal(select.value, V.pickDefault(groups).voiceURI);
});

test('a choice is persisted and restored on the next visit', async () => {
  store.clear();
  const select = element('select');
  await V.populateVoiceSelect(select);
  select.value = 'Daniel|en-GB';
  select.listeners.change();
  assert.equal(store.get('speakease-voice-uri'), 'Daniel|en-GB');

  const reopened = element('select');
  await V.populateVoiceSelect(reopened);
  assert.equal(reopened.value, 'Daniel|en-GB');
});

test('a saved voice that no longer exists falls back to the default', async () => {
  store.clear();
  store.set('speakease-voice-uri', 'Uninstalled Voice|en-US');
  const select = element('select');
  const groups = await V.populateVoiceSelect(select);
  assert.equal(select.value, V.pickDefault(groups).voiceURI);
});

test('a custom storage key is honoured', async () => {
  store.clear();
  const select = element('select');
  await V.populateVoiceSelect(select, { storageKey: 'other-key' });
  select.value = 'Alex|en-US';
  select.listeners.change();
  assert.equal(store.get('other-key'), 'Alex|en-US');
  assert.equal(store.get('speakease-voice-uri'), undefined);
});

// --- resolveVoice and prosody --------------------------------------------
test('a known voiceURI resolves to its voice and an unknown one to null', async () => {
  const voice = await V.resolveVoice('Samantha|en-US');
  assert.equal(voice.name, 'Samantha');
  assert.equal(await V.resolveVoice('no such voice'), null);
});

test('prosody defaults are rate 0.98, pitch 1.0, volume 1.0', () => {
  const u = V.applyNaturalDefaults({});
  assert.equal(u.rate, 0.98);
  assert.equal(u.pitch, 1.0);
  assert.equal(u.volume, 1.0);
});

test('explicit prosody options override the defaults', () => {
  const u = V.applyNaturalDefaults({}, { rate: 0.9, pitch: 1.2, volume: 0.5 });
  assert.equal(u.rate, 0.9);
  assert.equal(u.pitch, 1.2);
  assert.equal(u.volume, 0.5);
});

// --- no Web Speech API at all (Firefox) ----------------------------------
test('with no speechSynthesis, the groups come back empty instead of throwing', async (t) => {
  const saved = globalThis.speechSynthesis;
  delete globalThis.speechSynthesis;
  t.after(() => { globalThis.speechSynthesis = saved; });

  const groups = await V.getVoiceGroups('en-US');
  assert.deepEqual(groups, { female: [], male: [], unknown: [] });
  assert.equal(V.pickDefault(groups), null);
  assert.equal(await V.resolveVoice('anything'), null);
});

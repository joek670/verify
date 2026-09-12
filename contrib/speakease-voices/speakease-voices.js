/**
 * speakease-voices.js — drop-in voice selection for SpeakEase speech practice.
 *
 * Replaces hand-rolled voice labeling with:
 *   1. A curated gender map for the real voice rosters shipped by
 *      Chrome (Google), Edge (Microsoft natural/online) and Safari (Apple),
 *      matched with word boundaries so "Sam" never matches "Samantha".
 *   2. Explicit "Female"/"Male" keyword detection (female checked first,
 *      because "female" contains "male").
 *   3. A naturalness ranking that prefers Natural/Neural/Enhanced voices and
 *      deprioritises old robotic SAPI/Desktop/compact voices.
 *   4. Voices whose gender can't be determined go under "Other voices" —
 *      a missing label beats a wrong one.
 *
 * Usage:
 *   <script src="speakease-voices.js"></script>
 *   <script>
 *     var select = document.getElementById('voiceSelect');
 *     SpeakEaseVoices.populateVoiceSelect(select).then(function (groups) {
 *       // groups.female / groups.male / groups.unknown — each sorted
 *       // most-natural-first.
 *     });
 *
 *     function speak(text) {
 *       SpeakEaseVoices.resolveVoice(select.value).then(function (voice) {
 *         var u = new SpeechSynthesisUtterance(text);
 *         if (voice) u.voice = voice;
 *         SpeakEaseVoices.applyNaturalDefaults(u); // rate/pitch tuned for clarity
 *         speechSynthesis.cancel();
 *         speechSynthesis.speak(u);
 *       });
 *     }
 *   </script>
 *
 * No dependencies. Works wherever the Web Speech API exists; degrades to an
 * empty voice list (hide the selector) where it doesn't.
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    rate: 0.98,   // a touch under 1.0: clearer without sounding slow
    pitch: 1.0,
    volume: 1.0,
    storageKey: 'speakease-voice-uri' // localStorage — no account needed
  };

  function norm(s) {
    return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Curated name-fragment -> gender rules, checked in order.
   * Fragments use word boundaries so short names can't collide
   * ("sam" must not match "samantha", "mark" must not match "remark").
   * A rule that never matches a real voice is harmless; a wrong gender is not,
   * so when in doubt a voice is left out and falls through to "unknown".
   */
  var GENDER_RULES = [
    // --- Microsoft natural / online voices (Edge; "Microsoft Aria Online (Natural) - English (United States)") ---
    [/\baria\b/, 'female'],
    [/\bjenny\b/, 'female'],
    [/\bjane\b/, 'female'],
    [/\bmichelle\b/, 'female'],
    [/\bemma\b/, 'female'],
    [/\bsonia\b/, 'female'],
    [/\blibby\b/, 'female'],
    [/\bmaisie\b/, 'female'],
    [/\bnatasha\b/, 'female'],
    [/\bclara\b/, 'female'],
    [/\bemily\b/, 'female'],
    [/\bneerja\b/, 'female'],
    [/\bmolly\b/, 'female'],
    [/\bleah\b/, 'female'],
    [/\bluna\b/, 'female'],
    [/\byan\b/, 'female'],
    [/\brosa\b/, 'female'],
    [/\bguy\b/, 'male'],
    [/\bdavis\b/, 'male'],
    [/\bjason\b/, 'male'],
    [/\bchristopher\b/, 'male'],
    [/\bbrandon\b/, 'male'],
    [/\beric\b/, 'male'],
    [/\bandrew\b/, 'male'],
    [/\bryan\b/, 'male'],
    [/\bthomas\b/, 'male'],
    [/\bollie\b/, 'male'],
    [/\bwilliam\b/, 'male'],
    [/\bliam\b/, 'male'],
    [/\bconnor\b/, 'male'],
    [/\bprabhat\b/, 'male'],
    [/\bmitchell\b/, 'male'],
    [/\bluke\b/, 'male'],
    [/\bwayne\b/, 'male'],
    [/\bsam\b/, 'male'],
    [/\bangelo\b/, 'male'],
    // --- Legacy Microsoft desktop (SAPI) voices ---
    [/\bzira\b/, 'female'],
    [/\bhazel\b/, 'female'],
    [/\bdavid\b/, 'male'],
    [/\bmark\b/, 'male'],
    // --- Google voices (Chrome) ---
    [/\bgoogle uk english female\b/, 'female'],
    [/\bgoogle uk english male\b/, 'male'],
    [/\bgoogle us english\b/, 'female'],
    // --- Apple voices (Safari / macOS / iOS) ---
    [/\bsamantha\b/, 'female'],
    [/\bvictoria\b/, 'female'],
    [/\bkaren\b/, 'female'],
    [/\bmoira\b/, 'female'],
    [/\btessa\b/, 'female'],
    [/\bkathy\b/, 'female'],
    [/\bvicki\b/, 'female'],
    [/\bdaniel\b/, 'male'],
    [/\balex\b/, 'male'],
    [/\bgordon\b/, 'male'],
    [/\brishi\b/, 'male'],
    [/\bfred\b/, 'male']
  ];

  /**
   * Returns 'female', 'male' or 'unknown'. Never guesses from vibes —
   * unknown voices are grouped separately, not mislabeled.
   */
  function detectGender(voice) {
    var n = norm(voice && voice.name);
    if (/\bfemale\b/.test(n)) return 'female'; // checked before "male"
    if (/\bmale\b/.test(n)) return 'male';
    for (var i = 0; i < GENDER_RULES.length; i++) {
      if (GENDER_RULES[i][0].test(n)) return GENDER_RULES[i][1];
    }
    return 'unknown';
  }

  var REGION_ALIAS = { GB: 'UK' };

  /**
   * Turns "Microsoft Aria Online (Natural) - English (United States)"
   * into "Aria · Natural · US". Keeps quality badges, drops vendor noise.
   */
  function friendlyName(voice) {
    var name = (voice && voice.name) || 'Voice';
    var n = norm(name);
    var badge = /\bnatural\b|\bneural\b/.test(n) ? 'Natural'
              : /\benhanced\b|\bpremium\b/.test(n) ? 'Enhanced'
              : /\bdesktop\b/.test(n) ? 'Classic' : '';

    var person = null, m;
    m = name.match(/^\s*Microsoft\s+(.+?)\s+(Online|Desktop)\b/i);
    if (m) {
      person = m[1].replace(/\s*\(.*?\)\s*/g, '').trim();
    } else if ((m = name.match(/^\s*Google\s+(.+)$/i))) {
      person = m[1]
        .replace(/\b(Female|Male)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (!person) {
      person = name.split(' - ')[0].replace(/\s*\(.*?\)\s*/g, '').trim() || 'Voice';
    }

    var region = '';
    var lm = (voice.lang || '').match(/-([A-Za-z]{2})$/);
    if (lm) {
      region = REGION_ALIAS[lm[1].toUpperCase()] || lm[1].toUpperCase();
    }

    var parts = [person];
    if (badge) parts.push(badge);
    if (region && person.toUpperCase().indexOf(region) === -1) parts.push(region);
    return parts.join(' · ');
  }

  /**
   * Higher = sounds more human. Prefers neural/natural network voices and
   * enhanced on-device voices; penalises the old robotic compact/desktop set.
   * Practice targets are English, so English locales rank first.
   */
  function naturalnessScore(voice, preferredLang) {
    var n = norm(voice.name), s = 0;
    if (/\bnatural\b|\bneural\b|\bonline\b/.test(n)) s += 30;
    if (/\benhanced\b|\bpremium\b/.test(n)) s += 20;
    if (/\bgoogle\b|\bmicrosoft\b/.test(n)) s += 8;
    if (/\bmultilingual\b/.test(n)) s += 4;
    if (/\bdesktop\b|\bsapi\b/.test(n)) s -= 12;
    if (/\bcompact\b/.test(n)) s -= 18;
    var lang = (voice.lang || '').toLowerCase().replace('_', '-');
    if (lang === preferredLang) s += 25;
    else if (lang.indexOf('en') === 0) s += 12;
    return s;
  }

  function preferredLanguage() {
    var nav = (global.navigator && global.navigator.language) || 'en-US';
    nav = nav.replace('_', '-');
    return nav.toLowerCase().indexOf('en') === 0 ? nav : 'en-US';
  }

  /**
   * Voices are loaded asynchronously in Chrome (and sometimes arrive empty
   * on first call), so this waits for `voiceschanged` with a timeout fallback.
   */
  function loadVoices() {
    return new Promise(function (resolve) {
      var synth = global.speechSynthesis;
      if (!synth) { resolve([]); return; }
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        resolve(synth.getVoices() || []);
      }
      var initial = synth.getVoices() || [];
      if (initial.length) { resolve(initial); return; }
      synth.onvoiceschanged = finish;
      setTimeout(finish, 1500); // never leave the UI hanging
    });
  }

  function dedupe(voices) {
    var seen = {}, out = [];
    voices.forEach(function (v) {
      var key = v.voiceURI || (v.name + '|' + v.lang);
      if (!seen[key]) { seen[key] = true; out.push(v); }
    });
    return out;
  }

  /**
   * Returns { female: [...], male: [...], unknown: [...] }, each entry shaped
   * { voice, gender, score } and sorted most-natural-first. Only English
   * voices are included — practice targets are English.
   */
  function getVoiceGroups(lang) {
    var preferredLang = (lang || preferredLanguage()).toLowerCase().replace('_', '-');
    return loadVoices().then(function (voices) {
      var groups = { female: [], male: [], unknown: [] };
      dedupe(voices).forEach(function (v) {
        var vlang = (v.lang || '').toLowerCase().replace('_', '-');
        if (vlang.indexOf('en') !== 0) return;
        var gender = detectGender(v);
        groups[gender].push({
          voice: v,
          gender: gender,
          score: naturalnessScore(v, preferredLang)
        });
      });
      Object.keys(groups).forEach(function (k) {
        groups[k].sort(function (a, b) { return b.score - a.score; });
      });
      return groups;
    });
  }

  function allEntries(groups) {
    return groups.female.concat(groups.male, groups.unknown);
  }

  function pickDefault(groups) {
    var all = allEntries(groups);
    return all.length ? all[0].voice : null;
  }

  function resolveVoice(voiceURI) {
    return loadVoices().then(function (voices) {
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].voiceURI === voiceURI) return voices[i];
      }
      return null;
    });
  }

  /**
   * Builds a <select> with correctly-gendered optgroups, most-natural-first
   * ordering, and the user's last choice restored from localStorage.
   * Returns a promise of the groups.
   */
  function populateVoiceSelect(select, options) {
    options = options || {};
    var storageKey = options.storageKey || DEFAULTS.storageKey;
    return getVoiceGroups(options.lang).then(function (groups) {
      select.innerHTML = '';
      var labels = {
        female: 'Female voices',
        male: 'Male voices',
        unknown: 'Other voices'
      };
      ['female', 'male', 'unknown'].forEach(function (key) {
        var list = groups[key];
        if (!list.length) return;
        var og = document.createElement('optgroup');
        og.label = labels[key] + ' (' + list.length + ')';
        list.forEach(function (entry) {
          var opt = document.createElement('option');
          opt.value = entry.voice.voiceURI;
          opt.textContent = friendlyName(entry.voice);
          og.appendChild(opt);
        });
        select.appendChild(og);
      });

      var saved = null;
      try { saved = global.localStorage.getItem(storageKey); } catch (e) { /* private mode */ }
      var chosen = null;
      allEntries(groups).forEach(function (entry) {
        if (!chosen && entry.voice.voiceURI === saved) chosen = entry.voice;
      });
      chosen = chosen || pickDefault(groups);
      if (chosen) select.value = chosen.voiceURI;

      select.addEventListener('change', function () {
        try { global.localStorage.setItem(storageKey, select.value); } catch (e) { /* private mode */ }
      });
      return groups;
    });
  }

  /**
   * Applies prosody tuned for clarity: near-default rate and pitch.
   * Explicit opts (e.g. { rate: 0.9 }) override the defaults.
   */
  function applyNaturalDefaults(utterance, opts) {
    opts = opts || {};
    utterance.rate = typeof opts.rate === 'number' ? opts.rate : DEFAULTS.rate;
    utterance.pitch = typeof opts.pitch === 'number' ? opts.pitch : DEFAULTS.pitch;
    utterance.volume = typeof opts.volume === 'number' ? opts.volume : DEFAULTS.volume;
    return utterance;
  }

  global.SpeakEaseVoices = {
    DEFAULTS: DEFAULTS,
    loadVoices: loadVoices,
    detectGender: detectGender,
    friendlyName: friendlyName,
    naturalnessScore: naturalnessScore,
    getVoiceGroups: getVoiceGroups,
    populateVoiceSelect: populateVoiceSelect,
    pickDefault: pickDefault,
    resolveVoice: resolveVoice,
    applyNaturalDefaults: applyNaturalDefaults
  };
})(typeof window !== 'undefined' ? window : this);
